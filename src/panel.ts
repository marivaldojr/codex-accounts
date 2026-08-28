import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { resolveCodexHome } from './codex-home';
import { AccountsService } from './service';

export class AccountsPanel implements vscode.WebviewViewProvider {
  public static readonly viewType = 'codexAccounts.accountsView';

  private view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly service: AccountsService,
    private readonly globalStoragePath: string,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message) => void this.handle(message));
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.render();
      }
    });
    this.render();
  }

  /** Pushes the current state into the webview. */
  render(): void {
    if (!this.view) {
      return;
    }
    void this.view.webview.postMessage({
      type: 'state',
      profiles: this.service.listView(),
      unsaved: this.service.unsavedCurrent(),
      codexHome: resolveCodexHome(),
      warnThreshold: vscode.workspace
        .getConfiguration('codexAccounts')
        .get<number>('warnThresholdPercent', 80),
      refreshing: this.service.isRefreshing,
      pending: this.service.pendingIds,
    });
  }

  private async handle(message: { type?: string; id?: string }): Promise<void> {
    const id = message.id ?? '';
    switch (message.type) {
      case 'ready':
        this.render();
        return;
      case 'saveCurrent':
        return this.report(await this.service.saveCurrent());
      case 'login':
        return this.report(this.service.login());
      case 'refreshAll':
        this.render();
        await this.service.refreshAll();
        return;
      case 'refreshOne':
        await this.service.refreshOne(id);
        return;
      case 'switch':
        return this.report(await this.service.switchTo(id));
      case 'window':
        return this.report(await this.service.openIndependentWindow(id, this.globalStoragePath));
      case 'rename':
        return this.report(await this.service.rename(id));
      case 'remove':
        return this.report(await this.service.remove(id));
      default:
        return;
    }
  }

  private report(result: { ok: boolean; message: string }): void {
    if (result.ok) {
      vscode.window.setStatusBarMessage(`Codex Accounts: ${result.message}`, 5000);
    } else if (!AccountsService.isSilent(result.message)) {
      void vscode.window.showWarningMessage(`Codex Accounts: ${result.message}`);
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const asset = (file: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', file));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link href="${asset('panel.css')}" rel="stylesheet">
<title>Codex Accounts</title>
</head>
<body>
<div class="toolbar">
  <button class="save" data-action="saveCurrent">+ Save current account</button>
  <button data-action="login" title="Sign in to another account">Log in</button>
  <button data-action="refreshAll" title="Check every account"><span>&#8635;</span></button>
</div>
<div id="unsaved" class="hint" hidden></div>
<div id="caption" class="caption" hidden></div>
<div id="accounts"></div>
<div id="empty" class="empty" hidden>
  No accounts saved yet.<br>Sign in with <code>codex login</code>, then use <b>Save current account</b>.
</div>
<footer id="home"></footer>
<script nonce="${nonce}" src="${asset('panel.js')}"></script>
</body>
</html>`;
  }
}
