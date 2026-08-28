import * as vscode from 'vscode';
import { AccountsPanel } from './panel';
import { AccountsService } from './service';
import { ProfileStore } from './store';
import { Profile } from './types';

/** Piso do intervalo: cada ciclo sobe um `codex app-server` por perfil. */
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

  /** Pede um perfil ao usuário quando o comando é chamado pela paleta. */
  const pickProfile = async (placeHolder: string): Promise<Profile | undefined> => {
    const profiles = store.list();
    if (profiles.length === 0) {
      void vscode.window.showInformationMessage(
        'Codex Accounts: nenhum perfil salvo. Use "Salvar conta atual".',
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
    } else {
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
      withPick('Trocar para qual conta?', (profile) => service.switchTo(profile.id)),
    ),
    vscode.commands.registerCommand(
      'codexAccounts.warmup',
      withPick('Aquecer qual conta?', (profile) => service.warmup(profile.id)),
    ),
    vscode.commands.registerCommand(
      'codexAccounts.openWindow',
      withPick('Abrir janela para qual conta?', (profile) =>
        service.openIndependentWindow(profile.id, context.globalStorageUri.fsPath),
      ),
    ),
    vscode.commands.registerCommand(
      'codexAccounts.rename',
      withPick('Renomear qual perfil?', (profile) => service.rename(profile.id)),
    ),
    vscode.commands.registerCommand(
      'codexAccounts.remove',
      withPick('Remover qual perfil?', (profile) => service.remove(profile.id)),
    ),
    vscode.commands.registerCommand('codexAccounts.openPanel', async () => {
      await vscode.commands.executeCommand('codexAccounts.accountsView.focus');
    }),
  );

  // Poll dos limites. O intervalo é reprogramado quando a configuração muda.
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
  // Sem estado global fora do context: o VS Code descarta as subscriptions.
}
