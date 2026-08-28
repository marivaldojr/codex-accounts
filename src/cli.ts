import * as vscode from 'vscode';

export interface CodexCommand {
  command: string;
  args: string[];
}

/** Comando base da CLI do Codex, respeitando a configuração do usuário. */
export function resolveCodexCommand(extra: string[] = []): CodexCommand {
  const configured = vscode.workspace
    .getConfiguration('codexAccounts')
    .get<string>('codexCommand', 'codex')
    .trim();
  return { command: configured || 'codex', args: extra };
}
