import { CodexAuth, Identity } from './types';

/** Namespace onde o id_token da OpenAI guarda as claims de conta/plano. */
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
 * Lê a identidade a partir das claims do `id_token`. Só decodifica — não valida
 * assinatura: quem valida é a OpenAI, e o token já veio do disco do próprio usuário.
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

/** Um `auth.json` só serve se der para renovar a sessão a partir dele. */
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
 * Duas contas são a mesma quando o `chatgpt_account_id` bate. É o único campo
 * estável: o `access_token` muda a cada refresh e o e-mail se repete entre
 * workspaces da mesma pessoa.
 */
export function sameAccount(a: Identity, b: Identity): boolean {
  return Boolean(a.accountId && b.accountId && a.accountId === b.accountId);
}
