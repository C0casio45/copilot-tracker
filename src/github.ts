import * as https from "https";
import { DayUsage, UsageItem } from "./types";

export interface ApiConfig {
  token: string;
  username: string;
  /** Si renseignée, on interroge l'endpoint organisation (Copilot Business). */
  organization?: string;
}

interface ApiResponse {
  usageItems?: UsageItem[];
  // Certaines variantes de l'API renvoient "items".
  items?: UsageItem[];
}

function httpGetJson(url: string, token: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "copilot-aic-tracker",
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

function usageUrl(cfg: ApiConfig, year: number, month: number, day: number): string {
  const params = `year=${year}&month=${month}&day=${day}`;
  if (cfg.organization) {
    return (
      `https://api.github.com/organizations/${encodeURIComponent(cfg.organization)}` +
      `/settings/billing/ai_credit/usage?${params}&user=${encodeURIComponent(cfg.username)}`
    );
  }
  return (
    `https://api.github.com/users/${encodeURIComponent(cfg.username)}` +
    `/settings/billing/ai_credit/usage?${params}`
  );
}

/** Date locale YYYY-MM-DD. */
export function toDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Récupère la consommation AIC d'un jour donné (clé YYYY-MM-DD). */
export async function fetchDayUsage(cfg: ApiConfig, dateKey: string): Promise<DayUsage> {
  const [y, m, d] = dateKey.split("-").map(Number);
  const url = usageUrl(cfg, y, m, d);
  try {
    const { status, body } = await httpGetJson(url, cfg.token);
    if (status === 200) {
      const parsed = JSON.parse(body) as ApiResponse;
      const items = parsed.usageItems ?? parsed.items ?? [];
      return { date: dateKey, items, fetchedAt: Date.now() };
    }
    let message = `HTTP ${status}`;
    try {
      const err = JSON.parse(body) as { message?: string };
      if (err.message) message += ` — ${err.message}`;
    } catch {
      /* corps non JSON, on garde le code HTTP */
    }
    return { date: dateKey, items: [], fetchedAt: Date.now(), error: message };
  } catch (e) {
    return {
      date: dateKey,
      items: [],
      fetchedAt: Date.now(),
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
