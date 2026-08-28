import * as vscode from 'vscode';
import { AccountsPanel } from './panel';
import { AccountsService } from './service';
import { ProfileStore } from './store';
import { Profile } from './types';

/** Floor for the poll interval: each cycle spawns one `codex app-server` per profile. */
const MIN_POLL_SECONDS = 120;

export function activate(context: vscode.ExtensionContext): void {
  const store = new ProfileStore(context);
  const version = (context.extension.packageJSON as { version?: string }).version ?? '0.0.0';

  let panel: AccountsPanel | undefined;
  const service = new AccountsService(store, version, () => panel?.render());
  panel = new AccountsPanel(context.extensionUri, service, context.globalStorageUri.fsPath);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AccountsPanel.viewType, panel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  /** Asks the user for a profile when a command is run from the palette. */
  const pickProfile = async (placeHolder: string): Promise<Profile | undefined> => {
    const profiles = store.list();
    if (profiles.length === 0) {
      void vscode.window.showInformationMessage(
        'Codex Accounts: no profiles saved. Use "Save current account".',
      );
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      profiles.map((profile) => ({
        label: profile.label,
        description: profile.email,
        detail: profile.planType,
        profile,
      })),
      { placeHolder },
    );
    return picked?.profile;
  };

  const notify = (result: { ok: boolean; message: string }): void => {
    if (result.ok) {
      void vscode.window.showInformationMessage(`Codex Accounts: ${result.message}`);
    } else if (!AccountsService.isSilent(result.message)) {
      void vscode.window.showWarningMessage(`Codex Accounts: ${result.message}`);
    }
  };

  const withPick =
    (placeHolder: string, run: (profile: Profile) => Promise<{ ok: boolean; message: string }>) =>
    async (): Promise<void> => {
      const profile = await pickProfile(placeHolder);
      if (profile) {
        notify(await run(profile));
      }
    };

  context.subscriptions.push(
    vscode.commands.registerCommand('codexAccounts.saveCurrent', async () =>
      notify(await service.saveCurrent()),
    ),
    vscode.commands.registerCommand('codexAccounts.login', () => notify(service.login())),
    vscode.commands.registerCommand('codexAccounts.refresh', async () => {
      await service.refreshAll();
    }),
    vscode.commands.registerCommand(
      'codexAccounts.switch',
      withPick('Switch to which account?', (profile) => service.switchTo(profile.id)),
    ),
    vscode.commands.registerCommand(
      'codexAccounts.openWindow',
      withPick('Open a window for which account?', (profile) =>
        service.openIndependentWindow(profile.id, context.globalStorageUri.fsPath),
      ),
    ),
    vscode.commands.registerCommand(
      'codexAccounts.rename',
      withPick('Rename which profile?', (profile) => service.rename(profile.id)),
    ),
    vscode.commands.registerCommand(
      'codexAccounts.remove',
      withPick('Remove which profile?', (profile) => service.remove(profile.id)),
    ),
    vscode.commands.registerCommand('codexAccounts.openPanel', async () => {
      await vscode.commands.executeCommand('codexAccounts.accountsView.focus');
    }),
  );

  // Usage polling. The interval is rescheduled when the setting changes.
  let timer: NodeJS.Timeout | undefined;
  const schedule = (): void => {
    if (timer) {
      clearInterval(timer);
    }
    const configured = vscode.workspace
      .getConfiguration('codexAccounts')
      .get<number>('pollIntervalSeconds', 900);
    const seconds = Math.max(MIN_POLL_SECONDS, configured);
    timer = setInterval(() => void service.refreshAll(), seconds * 1000);
  };
  schedule();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('codexAccounts.pollIntervalSeconds')) {
        schedule();
      }
      if (event.affectsConfiguration('codexAccounts')) {
        panel?.render();
      }
    }),
    { dispose: () => timer && clearInterval(timer) },
  );

  void service.refreshAll();
}

export function deactivate(): void {
  // No global state outside the context: VS Code disposes the subscriptions.
}
