import { CodexAuth, Identity } from './types';

/** Namespace where the OpenAI id_token carries the account/plan claims. */
const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth';

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length < 2) {
    return null;
  }
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * Reads the identity from the `id_token` claims. Decode only — no signature
 * check: OpenAI is the one who validates it, and the token came off the user's
 * own disk.
 */
export function readIdentity(auth: CodexAuth | null): Identity {
  const token = auth?.tokens?.id_token;
  const claims = token ? decodeJwtPayload(token) : null;
  const scoped = claims && isRecord(claims[OPENAI_AUTH_CLAIM]) ? claims[OPENAI_AUTH_CLAIM] : {};

  return {
    email: asString(claims?.email),
    name: asString(claims?.name),
    accountId: asString(scoped.chatgpt_account_id) ?? asString(auth?.tokens?.account_id),
    planType: asString(scoped.chatgpt_plan_type),
    expiresAt: typeof claims?.exp === 'number' ? claims.exp : undefined,
  };
}

/** An `auth.json` is only useful if the session can be renewed from it. */
export function isUsableAuth(auth: CodexAuth | null): auth is CodexAuth {
  if (!auth) {
    return false;
  }
  if (asString(auth.OPENAI_API_KEY)) {
    return true;
  }
  return Boolean(asString(auth.tokens?.access_token) && asString(auth.tokens?.refresh_token));
}

/**
 * Two accounts are the same when `chatgpt_account_id` matches. It is the only
 * stable field: the `access_token` changes on every refresh, and the same email
 * repeats across workspaces.
 */
export function sameAccount(a: Identity, b: Identity): boolean {
  return Boolean(a.accountId && b.accountId && a.accountId === b.accountId);
}
