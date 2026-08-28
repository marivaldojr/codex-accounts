import { spawn } from 'child_process';
import * as readline from 'readline';
import { resolveCodexCommand } from './cli';

const REQUEST_TIMEOUT_MS = 15_000;
const EXIT_GRACE_MS = 2_000;

/** JSON-RPC's own code for a method the peer does not implement. */
const METHOD_NOT_FOUND = -32601;

/**
 * How long to wait for the browser half of a login. The app-server gives up at
 * ten minutes; there is no point in outliving it.
 */
export const LOGIN_TIMEOUT_MS = 10 * 60_000;

interface JsonRpcMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

/** A login started by the app-server, waiting on the user's browser. */
export interface LoginStart {
  loginId: string;
  authUrl: string;
}

export interface LoginOutcome {
  success: boolean;
  error?: string;
}

/**
 * An error the app-server answered with, as opposed to one from failing to talk
 * to it at all. The distinction is what decides whether a caller can fall back:
 * a refusal carries a code and means the request was understood.
 */
export class AppServerError extends Error {
  constructor(
    message: string,
    readonly code: number | undefined,
  ) {
    super(message);
    this.name = 'AppServerError';
  }

  get isUnknownMethod(): boolean {
    return this.code === METHOD_NOT_FOUND;
  }
}

/**
 * Line-delimited JSON-RPC client (over stdin/stdout) for `codex app-server`.
 * That is where the CLI itself exposes `account/rateLimits/read` and the login
 * flow — there is no public HTTP endpoint that does the same.
 */
export class AppServerClient {
  private readonly child;
  private readonly reader;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  /** Logins waiting on their completion notification, by `loginId`. */
  private readonly logins = new Map<
    string,
    { resolve: (outcome: LoginOutcome) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
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

  /**
   * Asks the app-server to run a ChatGPT login. It returns as soon as the local
   * callback server is up; the caller opens `authUrl` and waits for
   * `waitForLogin`. Only the `chatgpt` variant is used here — it is the one
   * that is not gated behind the experimental API.
   */
  async startChatGptLogin(): Promise<LoginStart> {
    const result = await this.request('account/login/start', { type: 'chatgpt' });
    if (!isRecord(result) || typeof result.loginId !== 'string' || typeof result.authUrl !== 'string') {
      throw new Error('the app-server did not return a login URL.');
    }
    return { loginId: result.loginId, authUrl: result.authUrl };
  }

  /** Best effort: a login the user abandoned should not hold port 1455. */
  async cancelLogin(loginId: string): Promise<void> {
    try {
      await this.request('account/login/cancel', { loginId });
    } catch {
      // Disposing the client takes the login down with it either way.
    }
  }

  /**
   * Settles when the app-server reports the login finished, either way. The
   * wait is long by design — the browser half of the flow belongs to the user.
   */
  waitForLogin(loginId: string, timeoutMs = LOGIN_TIMEOUT_MS): Promise<LoginOutcome> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.logins.delete(loginId);
        reject(new Error('the login timed out.'));
      }, timeoutMs);
      this.logins.set(loginId, { resolve, reject, timer });
    });
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
      this.handleNotification(message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(
        new AppServerError(message.error.message ?? 'app-server error.', message.error.code),
      );
    } else {
      pending.resolve(message.result);
    }
  }

  /**
   * Only `account/login/completed` is acted on; the rest (configWarning,
   * remoteControl/status/changed, …) are noise for what this client does.
   */
  private handleNotification(message: JsonRpcMessage): void {
    if (message.method !== 'account/login/completed' || !isRecord(message.params)) {
      return;
    }
    const { loginId, success, error } = message.params;
    // The notification may carry no id. With a single login in flight — always,
    // for this client — it can only be that one.
    const key =
      typeof loginId === 'string' && this.logins.has(loginId)
        ? loginId
        : this.logins.size === 1
          ? [...this.logins.keys()][0]
          : undefined;
    if (key === undefined) {
      return;
    }
    const waiter = this.logins.get(key);
    if (!waiter) {
      return;
    }
    this.logins.delete(key);
    clearTimeout(waiter.timer);
    waiter.resolve({
      success: success === true,
      error: typeof error === 'string' ? error : undefined,
    });
  }

  private failAll(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const [, waiter] of this.logins) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.logins.clear();
  }

  private stderrSuffix(): string {
    const trimmed = this.stderr.trim();
    return trimmed ? ` Error output: ${trimmed.slice(-300)}` : '';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
