import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { CodexAuth } from './types';

/**
 * Resolves CODEX_HOME the same way the CLI and the official Codex extension do:
 * explicit setting → environment variable → `~/.codex`.
 */
export function resolveCodexHome(): string {
  const configured = vscode.workspace
    .getConfiguration('codexAccounts')
    .get<string>('codexHome', '')
    .trim();
  if (configured) {
    return path.resolve(untilde(configured));
  }
  const fromEnv = process.env.CODEX_HOME?.trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  return path.join(os.homedir(), '.codex');
}

function untilde(value: string): string {
  return value.startsWith('~') ? path.join(os.homedir(), value.slice(1)) : value;
}

export function authFilePath(codexHome = resolveCodexHome()): string {
  return path.join(codexHome, 'auth.json');
}

/** Reads the active `auth.json`. Returns `null` if it is missing or corrupt. */
export function readAuth(codexHome = resolveCodexHome()): CodexAuth | null {
  try {
    const raw = fs.readFileSync(authFilePath(codexHome), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as CodexAuth) : null;
  } catch {
    return null;
  }
}

/**
 * Writes `auth.json` atomically: a temp file in the same directory, then a
 * rename over the target. A plain `writeFile` would let the CLI read a
 * half-written file if it opened the file mid-write.
 */
export async function writeAuth(auth: CodexAuth, codexHome = resolveCodexHome()): Promise<void> {
  const target = authFilePath(codexHome);
  await fsp.mkdir(codexHome, { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temp, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(temp, target);
  await fsp.chmod(target, 0o600).catch(() => undefined);
}

/**
 * Deletes the active `auth.json`. A missing file is not an error — the caller
 * wants the credential gone, and it already is.
 */
export async function removeAuth(codexHome = resolveCodexHome()): Promise<void> {
  await fsp.rm(authFilePath(codexHome), { force: true });
}

/**
 * Creates a throwaway CODEX_HOME holding only the profile's `auth.json`, so one
 * account's limits can be queried without touching the active account. The
 * `codex app-server` may refresh the token in there, so the caller gets the
 * `auth.json` back as it ended up.
 */
export async function withTemporaryCodexHome<T>(
  auth: CodexAuth,
  run: (codexHome: string) => Promise<T>,
): Promise<{ result: T; refreshedAuth: CodexAuth | null }> {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-accounts-'));
  await fsp.chmod(home, 0o700).catch(() => undefined);
  const authPath = path.join(home, 'auth.json');
  try {
    await fsp.writeFile(authPath, JSON.stringify(auth), { mode: 0o600 });
    const result = await run(home);
    let refreshedAuth: CodexAuth | null = null;
    try {
      const raw = await fsp.readFile(authPath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        refreshedAuth = parsed as CodexAuth;
      }
    } catch {
      refreshedAuth = null;
    }
    return { result, refreshedAuth };
  } finally {
    // Overwrite before deleting: if the rm fails (Windows, antivirus, full
    // disk), what is left behind in /tmp is an empty file, not a live token.
    await fsp.writeFile(authPath, '{}', { mode: 0o600 }).catch(() => undefined);
    await fsp.rm(home, { recursive: true, force: true }).catch(() => undefined);
  }
}
