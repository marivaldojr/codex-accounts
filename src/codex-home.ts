import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { CodexAuth } from './types';

/**
 * Resolve o CODEX_HOME na mesma ordem que a CLI e a extensão oficial do Codex:
 * configuração explícita → variável de ambiente → `~/.codex`.
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

/** Lê o `auth.json` ativo. Devolve `null` se não existir ou estiver corrompido. */
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
 * Grava o `auth.json` de forma atômica: escreve um temporário no mesmo diretório
 * e renomeia por cima. Um `writeFile` direto deixaria a CLI ler um arquivo pela
 * metade se ela abrisse o arquivo no meio da escrita.
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
 * Cria um CODEX_HOME descartável contendo só o `auth.json` do perfil, para
 * consultar os limites de uma conta sem mexer na conta ativa. O `codex
 * app-server` pode renovar o token lá dentro, então o chamador recebe de volta
 * o `auth.json` como ficou.
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
    // Sobrescreve antes de apagar: se o rm falhar (Windows, antivírus, disco
    // cheio), o que sobra no /tmp é um arquivo vazio, não um token válido.
    await fsp.writeFile(authPath, '{}', { mode: 0o600 }).catch(() => undefined);
    await fsp.rm(home, { recursive: true, force: true }).catch(() => undefined);
  }
}
