import * as path from 'path';
import * as vscode from 'vscode';
import { resolveCodexCommand } from './cli';
import { readAuth, resolveCodexHome, writeAuth } from './codex-home';
import { isUsableAuth, readIdentity } from './identity';
import { ProfileStore } from './store';
import { Profile, ProfileView } from './types';
import { fetchUsage } from './usage';

export interface ActionResult {
  ok: boolean;
  message: string;
}

/** How many accounts to query at once — each one spawns a `codex` process. */
const USAGE_CONCURRENCY = 3;

/** Messages the panel swallows instead of surfacing as a warning. */
const SILENT_MESSAGES = new Set(['Canceled.', 'Switch canceled.']);

export class AccountsService {
  private refreshing = false;
  /** Profiles with a reading in flight, so the panel can say so. */
  private readonly pending = new Set<string>();

  constructor(
    private readonly store: ProfileStore,
    private readonly clientVersion: string,
    private readonly onChange: () => void,
  ) {}

  /** Profiles, flagged with whichever one is active in the current CODEX_HOME. */
  listView(): ProfileView[] {
    const active = this.store.findByIdentity(readIdentity(readAuth()));
    return this.store.list().map((profile) => ({ ...profile, active: profile.id === active?.id }));
  }

  /** The account sitting in `auth.json` that is not saved as a profile yet, if any. */
  unsavedCurrent(): { email?: string; planType?: string } | null {
    const auth = readAuth();
    if (!isUsableAuth(auth)) {
      return null;
    }
    const identity = readIdentity(auth);
    if (this.store.findByIdentity(identity)) {
      return null;
    }
    return { email: identity.email, planType: identity.planType };
  }

  async saveCurrent(label?: string): Promise<ActionResult> {
    const auth = readAuth();
    if (!isUsableAuth(auth)) {
      return {
        ok: false,
        message: `No account signed in at ${resolveCodexHome()}. Run "codex login" before saving.`,
      };
    }
    const identity = readIdentity(auth);
    const existing = this.store.findByIdentity(identity);
    if (existing) {
      // Same account already saved: refresh its tokens instead of duplicating it.
      await this.store.refreshAuth(existing.id, auth);
      this.onChange();
      return { ok: true, message: `"${existing.label}" was already saved — tokens updated.` };
    }

    const suggested = identity.email ?? identity.name ?? 'Codex account';
    const chosen =
      label ??
      (await vscode.window.showInputBox({
        prompt: 'Profile name',
        value: suggested,
        validateInput: (value) => (value.trim() ? undefined : 'Enter a name.'),
      }));
    if (!chosen) {
      return { ok: false, message: 'Canceled.' };
    }

    const profile = await this.store.add(chosen.trim(), auth);
    this.onChange();
    void this.refreshOne(profile.id);
    return { ok: true, message: `"${profile.label}" saved.` };
  }

  async switchTo(id: string): Promise<ActionResult> {
    const profile = this.store.get(id);
    if (!profile) {
      return { ok: false, message: 'Profile not found.' };
    }
    const auth = await this.store.getAuth(id);
    if (!isUsableAuth(auth)) {
      return {
        ok: false,
        message: `"${profile.label}" has no usable credentials. Sign in again with "codex login" and save the profile.`,
      };
    }

    // Before overwriting, save whatever account is in the file if it is not a
    // profile yet — otherwise the switch discards a session the user would have
    // to recreate through the login flow.
    const current = readAuth();
    if (isUsableAuth(current)) {
      const currentIdentity = readIdentity(current);
      const known = this.store.findByIdentity(currentIdentity);
      if (known) {
        await this.store.refreshAuth(known.id, current);
      } else {
        const answer = await vscode.window.showWarningMessage(
          `The active account (${currentIdentity.email ?? 'unknown'}) is not saved. Switching now loses access to it.`,
          { modal: true },
          'Save and switch',
          'Switch anyway',
        );
        if (!answer) {
          return { ok: false, message: 'Switch canceled.' };
        }
        if (answer === 'Save and switch') {
          const saved = await this.saveCurrent();
          if (!saved.ok) {
            return saved;
          }
        }
      }
    }

    await writeAuth(auth);
    this.onChange();
    await this.promptReload(profile);
    return { ok: true, message: `Now using "${profile.label}".` };
  }

  private async promptReload(profile: Profile): Promise<void> {
    const auto = vscode.workspace
      .getConfiguration('codexAccounts')
      .get<boolean>('autoReloadAfterSwitch', false);
    if (auto) {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
      return;
    }
    const answer = await vscode.window.showInformationMessage(
      `Now using "${profile.label}". Codex only picks up the new account after the window reloads.`,
      'Reload',
      'Later',
    );
    if (answer === 'Reload') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  }

  async rename(id: string): Promise<ActionResult> {
    const profile = this.store.get(id);
    if (!profile) {
      return { ok: false, message: 'Profile not found.' };
    }
    const label = await vscode.window.showInputBox({
      prompt: 'New profile name',
      value: profile.label,
      validateInput: (value) => (value.trim() ? undefined : 'Enter a name.'),
    });
    if (!label) {
      return { ok: false, message: 'Canceled.' };
    }
    await this.store.rename(id, label.trim());
    this.onChange();
    return { ok: true, message: 'Profile renamed.' };
  }

  async remove(id: string): Promise<ActionResult> {
    const profile = this.store.get(id);
    if (!profile) {
      return { ok: false, message: 'Profile not found.' };
    }
    const answer = await vscode.window.showWarningMessage(
      `Remove the profile "${profile.label}"? The stored credentials go with it, and using that account again will require a fresh login.`,
      { modal: true },
      'Remove',
    );
    if (answer !== 'Remove') {
      return { ok: false, message: 'Canceled.' };
    }
    await this.store.remove(id);
    this.onChange();
    return { ok: true, message: `"${profile.label}" removed.` };
  }

  /** Opens a terminal running `codex login` against the active CODEX_HOME. */
  login(): ActionResult {
    const { command } = resolveCodexCommand();
    const terminal = vscode.window.createTerminal({
      name: 'Codex Login',
      env: { CODEX_HOME: resolveCodexHome() },
    });
    terminal.show();
    terminal.sendText(`${command} login`);
    return {
      ok: true,
      message: 'Once the browser login finishes, use "Save current account".',
    };
  }

  /**
   * Opens a VS Code window pointed at a CODEX_HOME of the profile's own, so two
   * accounts can be used side by side. Best-effort: it depends on the new window
   * inheriting the environment, which does not hold when VS Code reuses an
   * already-running remote server (Remote-SSH, WSL, dev containers).
   */
  async openIndependentWindow(id: string, globalStoragePath: string): Promise<ActionResult> {
    const profile = this.store.get(id);
    if (!profile) {
      return { ok: false, message: 'Profile not found.' };
    }
    const auth = await this.store.getAuth(id);
    if (!isUsableAuth(auth)) {
      return { ok: false, message: `"${profile.label}" has no usable credentials.` };
    }

    const home = path.join(globalStoragePath, 'homes', profile.id);
    await writeAuth(auth, home);

    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const { command } = resolveCodexCommand();
    const terminal = vscode.window.createTerminal({
      name: `Codex: ${profile.label}`,
      env: { CODEX_HOME: home },
    });
    terminal.show();
    terminal.sendText(`code -n ${JSON.stringify(folder)} || ${command} --help`);
    return {
      ok: true,
      message: `CODEX_HOME for "${profile.label}" is at ${home}. The new window only uses that account if it inherits the terminal's environment.`,
    };
  }

  /**
   * Refreshes the limits for a single profile. Marks the profile as pending
   * before the call and clears it in `finally`, so a reading that fails or
   * throws still stops announcing itself as running.
   */
  async refreshOne(id: string): Promise<void> {
    this.pending.add(id);
    this.onChange();
    try {
      const auth = await this.store.getAuth(id);
      if (!isUsableAuth(auth)) {
        await this.store.setUsage(id, {
          fetchedAt: Date.now(),
          limits: [],
          error: 'no usable credentials.',
        });
        return;
      }
      const { snapshot, refreshedAuth } = await fetchUsage(auth, this.clientVersion);
      if (refreshedAuth) {
        await this.store.refreshAuth(id, refreshedAuth);
      }
      await this.store.setUsage(id, snapshot);
    } finally {
      this.pending.delete(id);
      this.onChange();
    }
  }

  /** Refreshes every profile, in batches, so N processes do not start at once. */
  async refreshAll(): Promise<void> {
    if (this.refreshing) {
      return;
    }
    this.refreshing = true;
    try {
      const ids = this.store.list().map((profile) => profile.id);
      for (let index = 0; index < ids.length; index += USAGE_CONCURRENCY) {
        const batch = ids.slice(index, index + USAGE_CONCURRENCY);
        await Promise.all(batch.map((id) => this.refreshOne(id)));
      }
    } finally {
      this.refreshing = false;
    }
  }

  get isRefreshing(): boolean {
    return this.refreshing;
  }

  get pendingIds(): string[] {
    return [...this.pending];
  }

  static isSilent(message: string): boolean {
    return SILENT_MESSAGES.has(message);
  }
}
