import { spawn } from 'child_process';
import * as readline from 'readline';
import { resolveCodexCommand } from './cli';
import { withTemporaryCodexHome } from './codex-home';
import { CodexAuth, UsageLimit, UsageSnapshot, UsageWindow } from './types';

const REQUEST_TIMEOUT_MS = 15_000;
const EXIT_GRACE_MS = 2_000;

interface JsonRpcMessage {
  id?: number;
  method?: string;
  result?: unknown;
  error?: { message?: string };
}

/**
 * Line-delimited JSON-RPC client (over stdin/stdout) for `codex app-server`.
 * That is where the CLI itself exposes `account/rateLimits/read` — there is no
 * public HTTP endpoint that does the same.
 */
class AppServerClient {
  private readonly child;
  private readonly reader;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private stderr = '';
  private nextId = 1;
  private closed = false;

  constructor(codexHome: string, clientVersion: string) {
    const { command, args } = resolveCodexCommand(['app-server']);
    this.child = spawn(command, args, {
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-2000);
    });
    this.child.stdin.on('error', (error: Error) => this.failAll(error));
    this.child.on('error', (error: Error) =>
      this.failAll(new Error(`could not start codex app-server: ${error.message}`)),
    );
    this.child.on('exit', (code, signal) =>
      this.failAll(
        new Error(
          `codex app-server exited before responding (${signal ?? `code ${code ?? '?'}`}).${this.stderrSuffix()}`,
        ),
      ),
    );

    this.reader = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.reader.on('line', (line) => this.handleLine(line));
    this.clientVersion = clientVersion;
  }

  private readonly clientVersion: string;

  async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 'codex-accounts', title: null, version: this.clientVersion },
      capabilities: { experimentalApi: false, optOutNotificationMethods: [] },
    });
  }

  async readRateLimits(): Promise<unknown> {
    return this.request('account/rateLimits/read');
  }

  async dispose(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.failAll(new Error('request canceled.'));
    try {
      this.child.stdin.write(`${JSON.stringify({ method: 'exit' })}\n`);
    } catch {
      // The process may already be gone; the kill below covers that.
    }
    this.child.stdin.end();
    this.reader.close();
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.child.kill('SIGKILL');
          resolve();
        }, EXIT_GRACE_MS);
        this.child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error('app-server client already closed.'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timed out waiting for ${method}.${this.stderrSuffix()}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      const payload: Record<string, unknown> = { id, method };
      if (params !== undefined) {
        payload.params = params;
      }
      try {
        this.child.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return; // The app-server also prints free-form warnings on stdout; skip them.
    }
    if (typeof message.id !== 'number') {
      return; // Notification (configWarning, remoteControl/status/changed, …).
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error(message.error.message ?? 'app-server error.'));
    } else {
      pending.resolve(message.result);
    }
  }

  private failAll(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private stderrSuffix(): string {
    const trimmed = this.stderr.trim();
    return trimmed ? ` Error output: ${trimmed.slice(-300)}` : '';
  }
}

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
    return {
      snapshot: {
        fetchedAt: Date.now(),
        limits: [],
        error: error instanceof Error ? error.message : String(error),
      },
      refreshedAuth: null,
    };
  }
}
