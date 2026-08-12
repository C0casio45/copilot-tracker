import * as path from "path";
import * as vscode from "vscode";
import { fetchQuota, QuotaReading } from "./copilotQuota";
import { ApiConfig, fetchAuthenticatedLogin, fetchDayUsage, toDateKey } from "./github";
import { scanLocalActivity } from "./localScanner";
import { DashboardState, DayUsage, LocalDayActivity, ModelRankEntry, QuotaInfo } from "./types";

const SECRET_TOKEN_KEY = "aicTracker.githubToken";
const CACHE_PREFIX = "aicTracker.day.";
const LOGIN_CACHE_KEY = "aicTracker.detectedLogin";

/**
 * Scope OAuth classique couvrant la lecture du plan/facturation du compte
 * (équivalent de la permission « Plan » des tokens fine-grained).
 */
const GITHUB_SCOPES = ["user"];

export type TokenSource = "pat" | "session" | "none";

const SAMPLES_KEY = "aicTracker.quotaSamples";
const BILLING_BLOCKED_KEY = "aicTracker.billingBlocked";

/** Un relevé du compteur de quota Copilot. */
interface QuotaSample {
  t: number;
  /** Consommation cumulée depuis le début de la période de facturation. */
  used: number;
  entitlement: number;
  resetDate?: string;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function lastNDays(n: number): string[] {
  const keys: string[] = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    keys.push(toDateKey(d));
  }
  return keys;
}

function rankModels(usages: DayUsage[]): ModelRankEntry[] {
  const byModel = new Map<string, ModelRankEntry>();
  for (const day of usages) {
    for (const item of day.items) {
      const model = item.model || item.sku || item.product || "inconnu";
      let entry = byModel.get(model);
      if (!entry) {
        entry = { model, aic: 0, quantity: 0 };
        byModel.set(model, entry);
      }
      entry.aic += item.grossAmount ?? 0;
      entry.quantity += item.grossQuantity ?? 0;
    }
  }
  return [...byModel.values()]
    .map((e) => ({ ...e, aic: round2(e.aic) }))
    .sort((a, b) => b.aic - a.aic);
}

/** Classement des modèles vus localement (nombre de requêtes). */
function rankLocalModels(days: LocalDayActivity[]): ModelRankEntry[] {
  const byModel = new Map<string, ModelRankEntry>();
  for (const day of days) {
    for (const [model, count] of Object.entries(day.models)) {
      let entry = byModel.get(model);
      if (!entry) {
        entry = { model, aic: 0, quantity: 0 };
        byModel.set(model, entry);
      }
      entry.aic += count;
      entry.quantity += count;
    }
  }
  return [...byModel.values()].sort((a, b) => b.aic - a.aic);
}

function sumAmounts(day: DayUsage): { gross: number; net: number } {
  let gross = 0;
  let net = 0;
  for (const item of day.items) {
    gross += item.grossAmount ?? 0;
    net += item.netAmount ?? 0;
  }
  return { gross: round2(gross), net: round2(net) };
}

export class UsageStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async getToken(): Promise<string | undefined> {
    return this.context.secrets.get(SECRET_TOKEN_KEY);
  }

  /**
   * Jeton effectif pour l'API : PAT enregistré si présent, sinon la session
   * GitHub de VS Code (le compte déjà connecté pour Copilot). En mode
   * interactif, VS Code affiche sa demande d'autorisation standard — aucun
   * PAT à créer.
   */
  async resolveToken(opts?: {
    interactive?: boolean;
  }): Promise<{ token?: string; source: TokenSource }> {
    const pat = await this.getToken();
    if (pat) return { token: pat, source: "pat" };
    try {
      const session = await vscode.authentication.getSession(
        "github",
        GITHUB_SCOPES,
        opts?.interactive ? { createIfNone: true } : { silent: true }
      );
      if (session) return { token: session.accessToken, source: "session" };
    } catch {
      /* connexion refusée ou provider indisponible */
    }
    return { source: "none" };
  }

  async setToken(token: string): Promise<void> {
    await this.context.secrets.store(SECRET_TOKEN_KEY, token);
  }

  async clearToken(): Promise<void> {
    await this.context.secrets.delete(SECRET_TOKEN_KEY);
  }

  private config() {
    const cfg = vscode.workspace.getConfiguration("aicTracker");
    return {
      username: (cfg.get<string>("username") ?? "").trim(),
      organization: (cfg.get<string>("organization") ?? "").trim(),
      historyDays: cfg.get<number>("historyDays") ?? 14,
      refreshIntervalMinutes: cfg.get<number>("refreshIntervalMinutes") ?? 15,
    };
  }

  get refreshIntervalMs(): number {
    return Math.max(5, this.config().refreshIntervalMinutes) * 60_000;
  }

  /**
   * Login GitHub à suivre. Priorité : réglage explicite, puis propriétaire du
   * PAT (GET /user), puis session GitHub de VS Code (celle utilisée par
   * Copilot), puis dernière détection réussie (cache).
   */
  private async resolveUsername(token: string | undefined): Promise<string> {
    const configured = this.config().username;
    if (configured) return configured;

    if (token) {
      const login = await fetchAuthenticatedLogin(token);
      if (login) {
        await this.context.globalState.update(LOGIN_CACHE_KEY, login);
        return login;
      }
    }

    try {
      const session = await vscode.authentication.getSession("github", [], { silent: true });
      const login = session?.account.label;
      if (login) {
        await this.context.globalState.update(LOGIN_CACHE_KEY, login);
        return login;
      }
    } catch {
      /* pas de session GitHub active */
    }

    return this.context.globalState.get<string>(LOGIN_CACHE_KEY) ?? "";
  }

  /**
   * Consommation AIC des N derniers jours. Les jours passés sont immuables :
   * une fois récupérés sans erreur, ils sont servis depuis le cache
   * (globalState). Le jour courant est toujours re-demandé.
   */
  private async fetchAicHistory(
    api: ApiConfig,
    dayKeys: string[],
    todayKey: string
  ): Promise<DayUsage[]> {
    const results: DayUsage[] = [];
    for (const key of dayKeys) {
      const cacheKey = CACHE_PREFIX + key;
      if (key !== todayKey) {
        const cached = this.context.globalState.get<DayUsage>(cacheKey);
        if (cached && !cached.error) {
          results.push(cached);
          continue;
        }
      }
      const usage = await fetchDayUsage(api, key);
      if (key !== todayKey && !usage.error) {
        await this.context.globalState.update(cacheKey, usage);
      }
      results.push(usage);
    }
    return results;
  }

  async clearBillingBlocked(): Promise<void> {
    await this.context.globalState.update(BILLING_BLOCKED_KEY, undefined);
  }

  private quotaSamples(): QuotaSample[] {
    return this.context.globalState.get<QuotaSample[]>(SAMPLES_KEY) ?? [];
  }

  /** Enregistre un relevé du compteur (dédoublonné si rien n'a bougé dans la journée). */
  private async recordQuotaSample(r: QuotaReading): Promise<void> {
    const samples = this.quotaSamples();
    const last = samples[samples.length - 1];
    const sample: QuotaSample = {
      t: r.fetchedAt,
      used: r.used,
      entitlement: r.entitlement,
      resetDate: r.resetDate,
    };
    if (
      last &&
      last.used === sample.used &&
      toDateKey(new Date(last.t)) === toDateKey(new Date(sample.t))
    ) {
      last.t = sample.t;
    } else {
      samples.push(sample);
    }
    while (samples.length > 2000) samples.shift();
    await this.context.globalState.update(SAMPLES_KEY, samples);
  }

  /**
   * Consommation par jour reconstruite par différence entre relevés
   * successifs du compteur cumulatif. Un delta négatif signifie un reset de
   * période de facturation : on repart du compteur courant.
   */
  private dailyFromSamples(): Map<string, number> {
    const result = new Map<string, number>();
    let prev: QuotaSample | undefined;
    for (const s of this.quotaSamples()) {
      const day = toDateKey(new Date(s.t));
      let delta = 0;
      if (prev) {
        delta = s.used >= prev.used ? s.used - prev.used : s.used;
      }
      result.set(day, round2((result.get(day) ?? 0) + delta));
      prev = s;
    }
    return result;
  }

  /** Dossier "User" de l'instance VS Code courante (parent de globalStorage). */
  private userDir(): string {
    // globalStorageUri = <userData>/User/globalStorage/<publisher.name>
    return path.dirname(path.dirname(this.context.globalStorageUri.fsPath));
  }

  async buildState(): Promise<DashboardState> {
    const { organization, historyDays } = this.config();
    const { token } = await this.resolveToken();
    const username = await this.resolveUsername(token);
    const errors: string[] = [];

    const dayKeys = lastNDays(historyDays);
    const todayKey = toDateKey(new Date());

    // 1. Source AIC : API de facturation si accessible, sinon quota interne
    // Copilot (compteur cumulatif échantillonné à chaque rafraîchissement).
    let mode: DashboardState["mode"] = "quota";
    let usages: DayUsage[] = dayKeys.map((date) => ({ date, items: [], fetchedAt: 0 }));
    let quota: QuotaInfo | undefined;

    if (!token) {
      errors.push(
        "Aucune authentification GitHub : lancez « AIC Tracker: Se connecter à GitHub » " +
          "(réutilise votre compte GitHub de VS Code, aucun PAT nécessaire)."
      );
    } else {
      const billingBlocked = this.context.globalState.get<boolean>(BILLING_BLOCKED_KEY) ?? false;
      if (username && !billingBlocked) {
        // Sonde : un seul appel sur le jour courant avant de charger l'historique.
        const probe = await fetchDayUsage({ token, username, organization }, todayKey);
        if (!probe.error) {
          mode = "billing";
          usages = await this.fetchAicHistory({ token, username, organization }, dayKeys, todayKey);
          for (const f of usages.filter((u) => u.error)) {
            errors.push(`${f.date} : ${f.error}`);
          }
        } else if (/HTTP (403|404)/.test(probe.error)) {
          // Droits insuffisants (licence gérée par l'org) : inutile de réessayer
          // à chaque rafraîchissement, on mémorise le repli en mode quota.
          await this.context.globalState.update(BILLING_BLOCKED_KEY, true);
          errors.push(
            `API de facturation inaccessible (${probe.error}) — bascule définitive en mode quota Copilot.`
          );
        } else {
          errors.push(`API AIC : ${probe.error} — mode quota utilisé pour ce cycle.`);
        }
      }

      const reading = await fetchQuota(token);
      if ("error" in reading) {
        if (mode === "quota") errors.push(reading.error);
      } else {
        quota = {
          plan: reading.plan,
          snapshotKey: reading.snapshotKey,
          entitlement: reading.entitlement,
          remaining: reading.remaining,
          percentRemaining: reading.percentRemaining,
          used: reading.used,
          unlimited: reading.unlimited,
          overageCount: reading.overageCount,
          overagePermitted: reading.overagePermitted,
          resetDate: reading.resetDate,
        };
        await this.recordQuotaSample(reading);
      }
    }

    // 2. Activité locale (discussions, agents)
    const sinceMs = new Date(dayKeys[0] + "T00:00:00").getTime();
    let localDays = new Map<string, LocalDayActivity>();
    try {
      localDays = await scanLocalActivity(this.userDir(), sinceMs);
    } catch (e) {
      errors.push(`Scan local impossible : ${e instanceof Error ? e.message : String(e)}`);
    }

    const emptyLocal = (date: string): LocalDayActivity => ({
      date,
      sessionsStarted: 0,
      requests: 0,
      agents: {},
      models: {},
    });

    const todayUsage = usages.find((u) => u.date === todayKey) ?? {
      date: todayKey,
      items: [],
      fetchedAt: 0,
    };
    const todayLocal = localDays.get(todayKey) ?? emptyLocal(todayKey);
    const localHistory = dayKeys.map((key) => localDays.get(key) ?? emptyLocal(key));

    // Séries AIC et classement LLM selon la source disponible.
    let dailyAic: DashboardState["dailyAic"];
    let todayAmounts: { gross: number; net: number };
    let modelRankingToday: ModelRankEntry[];
    let modelRankingPeriod: ModelRankEntry[];
    if (mode === "billing") {
      dailyAic = usages.map((u) => ({ date: u.date, ...sumAmounts(u), error: u.error }));
      todayAmounts = sumAmounts(todayUsage);
      modelRankingToday = rankModels([todayUsage]);
      modelRankingPeriod = rankModels(usages);
    } else {
      const byDay = this.dailyFromSamples();
      dailyAic = dayKeys.map((date) => ({ date, gross: byDay.get(date) ?? 0, net: 0 }));
      todayAmounts = { gross: byDay.get(todayKey) ?? 0, net: 0 };
      modelRankingToday = rankLocalModels([todayLocal]);
      modelRankingPeriod = rankLocalModels(localHistory);
    }

    const agentTotalsPeriod: Record<string, number> = {};
    for (const key of dayKeys) {
      const day = localDays.get(key);
      if (!day) continue;
      for (const [agent, count] of Object.entries(day.agents)) {
        agentTotalsPeriod[agent] = (agentTotalsPeriod[agent] ?? 0) + count;
      }
    }

    return {
      generatedAt: Date.now(),
      username,
      organization,
      tokenConfigured: !!token,
      historyDays,
      mode,
      rankingUnit: mode === "billing" ? "AIC" : "requêtes",
      quota,
      today: {
        date: todayKey,
        aicGross: todayAmounts.gross,
        aicNet: todayAmounts.net,
        sessions: todayLocal.sessionsStarted,
        requests: todayLocal.requests,
        agentsUsed: Object.keys(todayLocal.agents).sort(),
      },
      modelRankingToday,
      modelRankingPeriod,
      dailyAic,
      dailyLocal: localHistory,
      agentTotalsPeriod,
      errors,
    };
  }
}
