/** Un poste de consommation renvoyé par l'API de facturation GitHub (AI credits). */
export interface UsageItem {
  product?: string;
  sku?: string;
  model?: string;
  unitType?: string;
  pricePerUnit?: number;
  grossQuantity?: number;
  grossAmount?: number;
  discountQuantity?: number;
  discountAmount?: number;
  netQuantity?: number;
  netAmount?: number;
}

/** Consommation AIC d'une journée (réponse API agrégée). */
export interface DayUsage {
  /** Date locale au format YYYY-MM-DD. */
  date: string;
  items: UsageItem[];
  fetchedAt: number;
  /** Erreur rencontrée lors du fetch (le jour reste affiché à 0). */
  error?: string;
}

/** Activité Copilot Chat d'une journée, reconstruite depuis les sessions locales. */
export interface LocalDayActivity {
  date: string;
  /** Discussions (sessions de chat) créées ce jour-là. */
  sessionsStarted: number;
  /** Nombre total de requêtes envoyées ce jour-là. */
  requests: number;
  /** Requêtes par agent (id d'agent -> nombre). */
  agents: Record<string, number>;
  /** Requêtes par modèle vu localement (id de modèle -> nombre). */
  models: Record<string, number>;
}

export interface ModelRankEntry {
  model: string;
  /** AIC consommés (somme des grossAmount). */
  aic: number;
  /** Quantité brute (tokens/unités selon unitType). */
  quantity: number;
}

/** Photo du quota Copilot (endpoint interne), pour l'affichage. */
export interface QuotaInfo {
  plan?: string;
  snapshotKey: string;
  entitlement: number;
  remaining: number;
  percentRemaining?: number;
  used: number;
  unlimited: boolean;
  overageCount: number;
  overagePermitted: boolean;
  resetDate?: string;
}

/** État complet envoyé au webview. */
export interface DashboardState {
  generatedAt: number;
  username: string;
  organization: string;
  tokenConfigured: boolean;
  historyDays: number;
  /**
   * billing : API de facturation GitHub (AIC exacts, détail par modèle).
   * quota   : endpoint interne Copilot (compteur global échantillonné) —
   *           le classement LLM passe alors sur les requêtes locales.
   */
  mode: "billing" | "quota";
  /** Unité des valeurs du classement LLM ("AIC" ou "requêtes"). */
  rankingUnit: string;
  quota?: QuotaInfo;
  today: {
    date: string;
    aicGross: number;
    aicNet: number;
    sessions: number;
    requests: number;
    agentsUsed: string[];
  };
  modelRankingToday: ModelRankEntry[];
  modelRankingPeriod: ModelRankEntry[];
  dailyAic: { date: string; gross: number; net: number; error?: string }[];
  dailyLocal: LocalDayActivity[];
  agentTotalsPeriod: Record<string, number>;
  errors: string[];
}
