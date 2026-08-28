/** Conteúdo do `auth.json` do Codex, como a CLI o grava. */
export interface CodexAuth {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
}

/** Quem é a conta, extraído das claims do `id_token`. */
export interface Identity {
  email?: string;
  name?: string;
  accountId?: string;
  planType?: string;
  /** `exp` do JWT, em segundos. */
  expiresAt?: number;
}

/** Uma janela de limite (5h, semanal, …) já normalizada. */
export interface UsageWindow {
  /** Rótulo derivado da duração: "5h", "7d", "30d". */
  label: string;
  usedPercent: number;
  windowDurationMins: number | null;
  /** Unix timestamp em segundos. */
  resetsAt: number | null;
}

/** Um conjunto de limites (o Codex devolve um por família de modelo). */
export interface UsageLimit {
  limitId: string;
  /** Nome do modelo quando a API o informa (ex.: "GPT-5.3-Codex-Spark"). */
  limitName: string | null;
  windows: UsageWindow[];
}

export interface UsageSnapshot {
  fetchedAt: number;
  planType?: string;
  limits: UsageLimit[];
  credits?: { balance: string; unlimited: boolean; hasCredits: boolean };
  error?: string;
}

/** Metadado do perfil. O segredo (o `auth.json`) vive no SecretStorage, nunca aqui. */
export interface Profile {
  id: string;
  label: string;
  order: number;
  addedAt: number;
  email?: string;
  name?: string;
  accountId?: string;
  planType?: string;
  authMode?: string;
  lastUsage?: UsageSnapshot;
}

/** Perfil já decorado para a webview. */
export interface ProfileView extends Profile {
  active: boolean;
}
