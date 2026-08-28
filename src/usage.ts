import { AppServerClient } from './app-server';
import { withTemporaryCodexHome } from './codex-home';
import { CodexAuth, UsageLimit, UsageSnapshot, UsageWindow } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clampPercent(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** Short, language-neutral label from the window duration: "5h", "7d", "30d". */
export function windowLabel(durationMins: number | null): string {
  if (!durationMins || durationMins <= 0) {
    return 'window';
  }
  if (durationMins % (60 * 24) === 0) {
    return `${durationMins / (60 * 24)}d`;
  }
  if (durationMins % 60 === 0) {
    return `${durationMins / 60}h`;
  }
  return `${durationMins}min`;
}

function normalizeWindow(raw: unknown, nowSeconds: number): UsageWindow | null {
  if (!isRecord(raw)) {
    return null;
  }
  const usedPercent = clampPercent(raw.usedPercent ?? raw.used_percent);
  if (usedPercent === null) {
    return null;
  }
  const durationRaw = raw.windowDurationMins ?? raw.window_minutes;
  const windowDurationMins =
    typeof durationRaw === 'number' && Number.isInteger(durationRaw) && durationRaw > 0
      ? durationRaw
      : null;

  let resetsAt: number | null = null;
  const resetsAtRaw = raw.resetsAt ?? raw.resets_at;
  if (typeof resetsAtRaw === 'number' && Number.isFinite(resetsAtRaw) && resetsAtRaw > 0) {
    resetsAt = Math.floor(resetsAtRaw);
  } else {
    const resetsIn = raw.resets_in_seconds;
    if (typeof resetsIn === 'number' && Number.isFinite(resetsIn) && resetsIn >= 0) {
      resetsAt = nowSeconds + Math.floor(resetsIn);
    }
  }

  return { label: windowLabel(windowDurationMins), usedPercent, windowDurationMins, resetsAt };
}

/**
 * `primary`/`secondary` are mapped positionally, as the API itself names them.
 * OpenAI does not guarantee primary is 5h and secondary is weekly, and has
 * changed window lengths before without renaming the fields — which is why the
 * label comes from the duration.
 */
function normalizeLimit(limitId: string, raw: unknown, nowSeconds: number): UsageLimit | null {
  if (!isRecord(raw)) {
    return null;
  }
  const windows = [normalizeWindow(raw.primary, nowSeconds), normalizeWindow(raw.secondary, nowSeconds)]
    .filter((window): window is UsageWindow => window !== null);
  if (windows.length === 0) {
    return null;
  }
  return {
    limitId,
    limitName: typeof raw.limitName === 'string' ? raw.limitName : null,
    windows,
  };
}

export function normalizeRateLimits(response: unknown, now = Date.now()): UsageSnapshot {
  const nowSeconds = Math.floor(now / 1000);
  const snapshot: UsageSnapshot = { fetchedAt: now, limits: [] };
  if (!isRecord(response)) {
    return { ...snapshot, error: 'unexpected response from the app-server.' };
  }

  const byId = isRecord(response.rateLimitsByLimitId) ? response.rateLimitsByLimitId : null;
  if (byId) {
    for (const [limitId, raw] of Object.entries(byId)) {
      const limit = normalizeLimit(limitId, raw, nowSeconds);
      if (limit) {
        snapshot.limits.push(limit);
      }
    }
  } else {
    const limit = normalizeLimit('codex', response.rateLimits, nowSeconds);
    if (limit) {
      snapshot.limits.push(limit);
    }
  }

  // "codex" is the account-wide limit; the rest are per model family.
  snapshot.limits.sort((a, b) =>
    a.limitId === 'codex' ? -1 : b.limitId === 'codex' ? 1 : a.limitId.localeCompare(b.limitId),
  );

  const main = isRecord(response.rateLimits) ? response.rateLimits : null;
  if (typeof main?.planType === 'string') {
    snapshot.planType = main.planType;
  }
  if (isRecord(main?.credits)) {
    snapshot.credits = {
      balance: typeof main.credits.balance === 'string' ? main.credits.balance : '0',
      unlimited: main.credits.unlimited === true,
      hasCredits: main.credits.hasCredits === true,
    };
  }
  return snapshot;
}

/**
 * Queries one account's limits in a throwaway CODEX_HOME — the active account
 * in `~/.codex` is left alone. Also returns the `auth.json` as it ended up,
 * because the app-server refreshes the token when it is close to expiring.
 */
export async function fetchUsage(
  auth: CodexAuth,
  clientVersion: string,
): Promise<{ snapshot: UsageSnapshot; refreshedAuth: CodexAuth | null }> {
  try {
    const { result, refreshedAuth } = await withTemporaryCodexHome(auth, async (codexHome) => {
      const client = new AppServerClient(codexHome, clientVersion);
      try {
        await client.initialize();
        return await client.readRateLimits();
      } finally {
        await client.dispose();
      }
    });
    return { snapshot: normalizeRateLimits(result), refreshedAuth };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { snapshot: { fetchedAt: Date.now(), limits: [], ...describeFailure(detail) }, refreshedAuth: null };
  }
}

/**
 * Turns the app-server's raw failure into something worth showing. The only
 * distinction the panel acts on is whether the credentials themselves are dead
 * — nothing but a fresh login recovers from that, so it must not read like a
 * transient hiccup. The raw text is kept for the tooltip.
 */
export function describeFailure(detail: string): Pick<UsageSnapshot, 'error' | 'errorKind' | 'errorDetail'> {
  if (/token[_ ]revoked|invalidated oauth token|\b401\b|unauthorized/i.test(detail)) {
    return { error: 'Signed out — this account needs to log in again.', errorKind: 'auth', errorDetail: detail };
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|network|dns/i.test(detail)) {
    return { error: 'Could not reach OpenAI.', errorKind: 'other', errorDetail: detail };
  }
  if (/could not start codex app-server|ENOENT/i.test(detail)) {
    return { error: 'Codex CLI not found — check codexAccounts.codexCommand.', errorKind: 'other', errorDetail: detail };
  }
  if (/timed out/i.test(detail)) {
    return { error: 'Timed out reading limits.', errorKind: 'other', errorDetail: detail };
  }
  return { error: 'Could not read limits.', errorKind: 'other', errorDetail: detail };
}
