import * as vscode from 'vscode';

export interface CodexCommand {
  command: string;
  args: string[];
}

/** Base Codex CLI command, honoring the user's configuration. */
export function resolveCodexCommand(extra: string[] = []): CodexCommand {
  const configured = vscode.workspace
    .getConfiguration('codexAccounts')
    .get<string>('codexCommand', 'codex')
    .trim();
  return { command: configured || 'codex', args: extra };
}
