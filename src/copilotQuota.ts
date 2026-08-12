import * as https from "https";

/**
 * Lecture du quota Copilot via l'endpoint interne utilisé par l'extension
 * Copilot elle-même (GET api.github.com/copilot_internal/user). Accessible
 * avec le token de session GitHub de VS Code — aucune permission de
 * facturation requise. C'est la solution de repli quand l'API de facturation
 * renvoie 403/404 (licence Business gérée par l'organisation).
 */

export interface QuotaReading {
  plan?: string;
  /** Clé du snapshot retenu (ai_credits, premium_interactions, …). */
  snapshotKey: string;
  entitlement: number;
  remaining: number;
  percentRemaining?: number;
  unlimited: boolean;
  overageCount: number;
  overagePermitted: boolean;
  resetDate?: string;
  /** Consommation depuis le début de la période de facturation. */
  used: number;
  fetchedAt: number;
}

interface RawSnapshot {
  entitlement?: number;
  remaining?: number;
  quota_remaining?: number;
  percent_remaining?: number;
  unlimited?: boolean;
  overage_count?: number;
  overage_permitted?: boolean;
}

interface RawUser {
  copilot_plan?: string;
  quota_reset_date?: string;
  quota_snapshots?: Record<string, RawSnapshot>;
}

function httpGetJson(url: string, token: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/json",
          // L'endpoint interne attend des en-têtes d'éditeur.
          "Editor-Version": "vscode/1.96.0",
          "Editor-Plugin-Version": "copilot-chat/0.26.0",
          "User-Agent": "GitHubCopilotChat/0.26.0",
        },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on("error", reject);
    req.setTimeout(20000, () => req.destroy(new Error("timeout")));
  });
}

/** Ordre de préférence des snapshots : crédits IA, puis requêtes premium. */
const PREFERRED_KEYS = ["ai_credits", "premium_interactions", "premium_requests"];

export async function fetchQuota(token: string): Promise<QuotaReading | { error: string }> {
  let status: number;
  let body: string;
  try {
    ({ status, body } = await httpGetJson("https://api.github.com/copilot_internal/user", token));
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  if (status !== 200) {
    return { error: `copilot_internal/user : HTTP ${status}` };
  }

  let raw: RawUser;
  try {
    raw = JSON.parse(body) as RawUser;
  } catch {
    return { error: "copilot_internal/user : réponse illisible" };
  }
  const snapshots = raw.quota_snapshots ?? {};
  let key = PREFERRED_KEYS.find((k) => snapshots[k]);
  if (!key) {
    // À défaut, premier snapshot limité (chat/completions sont souvent illimités).
    key = Object.keys(snapshots).find((k) => snapshots[k]?.unlimited === false);
  }
  if (!key) {
    return { error: "copilot_internal/user : aucun snapshot de quota exploitable" };
  }

  const s = snapshots[key];
  const entitlement = s.entitlement ?? 0;
  const remaining = s.remaining ?? s.quota_remaining ?? 0;
  const overageCount = s.overage_count ?? 0;
  const used = Math.max(0, entitlement - Math.max(0, remaining)) + overageCount;

  return {
    plan: raw.copilot_plan,
    snapshotKey: key,
    entitlement,
    remaining,
    percentRemaining: s.percent_remaining,
    unlimited: s.unlimited ?? false,
    overageCount,
    overagePermitted: s.overage_permitted ?? false,
    resetDate: raw.quota_reset_date,
    used,
    fetchedAt: Date.now(),
  };
}
