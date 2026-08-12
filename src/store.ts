import * as path from "path";
import * as vscode from "vscode";
import { ApiConfig, fetchAuthenticatedLogin, fetchDayUsage, toDateKey } from "./github";
import { scanLocalActivity } from "./localScanner";
import { DashboardState, DayUsage, LocalDayActivity, ModelRankEntry } from "./types";

const SECRET_TOKEN_KEY = "aicTracker.githubToken";
const CACHE_PREFIX = "aicTracker.day.";
const LOGIN_CACHE_KEY = "aicTracker.detectedLogin";

/**
 * Scope OAuth classique couvrant la lecture du plan/facturation du compte
 * (équivalent de la permission « Plan » des tokens fine-grained).
 */
const GITHUB_SCOPES = ["user"];

export type TokenSource = "pat" | "session" | "none";

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

    // 1. AIC via l'API GitHub (si configurée)
    let usages: DayUsage[] = dayKeys.map((date) => ({ date, items: [], fetchedAt: 0 }));
    if (!username) {
      errors.push(
        "Login GitHub indétectable (pas de token ni de session GitHub) — renseignez aicTracker.username."
      );
    } else if (!token) {
      errors.push(
        "Aucune authentification GitHub : lancez « AIC Tracker: Se connecter à GitHub » " +
          "(réutilise votre compte GitHub de VS Code, aucun PAT nécessaire)."
      );
    } else {
      usages = await this.fetchAicHistory({ token, username, organization }, dayKeys, todayKey);
      const failed = usages.filter((u) => u.error);
      if (failed.length === usages.length && usages.length > 0) {
        errors.push(`API AIC inaccessible : ${failed[0].error}`);
      } else {
        for (const f of failed) {
          errors.push(`${f.date} : ${f.error}`);
        }
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
    const todayAmounts = sumAmounts(todayUsage);

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
      today: {
        date: todayKey,
        aicGross: todayAmounts.gross,
        aicNet: todayAmounts.net,
        sessions: todayLocal.sessionsStarted,
        requests: todayLocal.requests,
        agentsUsed: Object.keys(todayLocal.agents).sort(),
      },
      modelRankingToday: rankModels([todayUsage]),
      modelRankingPeriod: rankModels(usages),
      dailyAic: usages.map((u) => ({ date: u.date, ...sumAmounts(u), error: u.error })),
      dailyLocal: dayKeys.map((key) => localDays.get(key) ?? emptyLocal(key)),
      agentTotalsPeriod,
      errors,
    };
  }
}
