/** Contents of the Codex `auth.json`, as the CLI writes it. */
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

/** Who the account is, taken from the `id_token` claims. */
export interface Identity {
  email?: string;
  name?: string;
  accountId?: string;
  planType?: string;
  /** The JWT `exp`, in seconds. */
  expiresAt?: number;
}

/** A normalized limit window (5h, weekly, …). */
export interface UsageWindow {
  /** Label derived from the duration: "5h", "7d", "30d". */
  label: string;
  usedPercent: number;
  windowDurationMins: number | null;
  /** Unix timestamp in seconds. */
  resetsAt: number | null;
}

/** One set of limits — Codex reports one per model family. */
export interface UsageLimit {
  limitId: string;
  /** Model name when the API reports one (e.g. "GPT-5.3-Codex-Spark"). */
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

/** Profile metadata. The secret (the `auth.json`) lives in SecretStorage, never here. */
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

/** A profile decorated for the webview. */
export interface ProfileView extends Profile {
  active: boolean;
}
