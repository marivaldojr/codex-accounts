import * as path from 'path';
import * as vscode from 'vscode';
import { resolveCodexCommand } from './cli';
import { readAuth, resolveCodexHome, writeAuth } from './codex-home';
import { isUsableAuth, readIdentity } from './identity';
import { ProfileStore } from './store';
import { CodexAuth, Profile, ProfileView } from './types';
import { fetchUsage } from './usage';

export interface ActionResult {
  ok: boolean;
  message: string;
}

/** How many accounts to query at once — each one spawns a `codex` process. */
const USAGE_CONCURRENCY = 3;

/** Window in which a live-file change is assumed to be our own write. */
const SELF_WRITE_ECHO_MS = 2000;

/** Messages the panel swallows instead of surfacing as a warning. */
const SILENT_MESSAGES = new Set(['Canceled.', 'Switch canceled.']);

export class AccountsService {
  private refreshing = false;
  /** Profiles with a reading in flight, so the panel can say so. */
  private readonly pending = new Set<string>();
  /** When this extension last wrote the live file, to ignore its own echo. */
  private selfWriteAt = 0;

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
    await this.store.undismiss(identity.accountId);
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

    await this.writeLive(auth);
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

  /**
   * Opens a terminal running `codex login` against the active CODEX_HOME.
   *
   * Captures the account already signed in first. `codex login` overwrites
   * auth.json, and the tokens it overwrites are the only valid ones that
   * account has — Codex may have rotated them since we last looked, and
   * rotation revokes whatever copy we were holding. Read the file after the
   * login and that account is simply gone.
   */
  async login(): Promise<ActionResult> {
    await this.captureLiveAccount();
    this.onChange();
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
      // For the account that is live, the file on disk is the source of truth,
      // not our copy: Codex refreshes it as the user works, and OAuth rotation
      // revokes whatever token we were holding. Reading the copy would fail
      // against credentials the user never stopped using.
      const live = readAuth();
      const active = isUsableAuth(live) && this.isSameAccount(id, live);
      const auth = active ? live : await this.store.getAuth(id);
      if (!isUsableAuth(auth)) {
        await this.store.setUsage(id, {
          fetchedAt: Date.now(),
          limits: [],
          error: 'No stored credentials — log in and save this account again.',
          errorKind: 'auth',
        });
        return;
      }

      const { snapshot, refreshedAuth } = await fetchUsage(auth, this.clientVersion);
      if (refreshedAuth) {
        await this.store.refreshAuth(id, refreshedAuth);
        // Rotation invalidates the token we started from. If that token is also
        // the one the user's Codex is running on, the live file has to receive
        // the replacement — otherwise checking usage logs them out.
        if (active) {
          await this.writeLive(refreshedAuth);
        }
      }
      await this.store.setUsage(id, snapshot);
    } finally {
      this.pending.delete(id);
      this.onChange();
    }
  }

  /** Every write to the live file goes through here so the watcher can tell
   *  our own writes from someone else's. */
  private async writeLive(auth: CodexAuth): Promise<void> {
    this.selfWriteAt = Date.now();
    await writeAuth(auth);
  }

  /**
   * Copies whatever account is in the live file into its profile, creating the
   * profile if this is an account we have not seen. Returns the profile and
   * whether anything actually changed.
   *
   * The tokens on disk are always the current ones — Codex rotates them as the
   * user works — so this is what keeps a saved copy from decaying into a
   * revoked one. It deliberately does no network work, so it is cheap enough to
   * run before anything that is about to overwrite the file.
   */
  private async captureLiveAccount(): Promise<{ id: string; changed: boolean } | null> {
    const live = readAuth();
    if (!isUsableAuth(live)) {
      return null;
    }
    const identity = readIdentity(live);
    const profile = this.store.findByIdentity(identity);
    if (!profile) {
      if (this.store.isDismissed(identity.accountId)) {
        return null; // Deleted on purpose; the hint still offers to save it back.
      }
      // Signing in is the whole intent — asking the user to then press "save"
      // is a step that only exists because the extension was not watching.
      const created = await this.store.add(
        this.uniqueLabel(identity.email ?? identity.name ?? 'Codex account'),
        live,
      );
      return { id: created.id, changed: true };
    }
    const stored = await this.store.getAuth(profile.id);
    if (stored && JSON.stringify(stored) === JSON.stringify(live)) {
      return { id: profile.id, changed: false };
    }
    await this.store.refreshAuth(profile.id, live);
    return { id: profile.id, changed: true };
  }

  /**
   * The live `auth.json` changed underneath us — a `codex login` in a terminal,
   * a logout, another tool. Redraw at once so the active marker is right, adopt
   * the file's tokens, and re-read usage so a card left showing "signed out"
   * recovers without a click.
   */
  async adoptLiveAuth(): Promise<void> {
    if (Date.now() - this.selfWriteAt < SELF_WRITE_ECHO_MS) {
      return;
    }
    this.onChange();
    const captured = await this.captureLiveAccount();
    if (!captured || !captured.changed) {
      return; // Nothing new on disk — keep this cheap enough to call on a hunch.
    }
    this.onChange();
    await this.refreshOne(captured.id);
  }

  /** Keeps auto-created labels distinct when an account reports no email. */
  private uniqueLabel(base: string): string {
    const taken = new Set(this.store.list().map((profile) => profile.label));
    if (!taken.has(base)) {
      return base;
    }
    for (let suffix = 2; ; suffix++) {
      const candidate = `${base} (${suffix})`;
      if (!taken.has(candidate)) {
        return candidate;
      }
    }
  }

  /** Whether a profile is the account currently in the live `auth.json`. */
  private isSameAccount(id: string, live: CodexAuth): boolean {
    const profile = this.store.get(id);
    const accountId = readIdentity(live).accountId;
    return Boolean(profile?.accountId && accountId && profile.accountId === accountId);
  }

  /** Refreshes every profile, in batches, so N processes do not start at once. */
  async refreshAll(): Promise<void> {
    if (this.refreshing) {
      return;
    }
    this.refreshing = true;
    try {
      // Reconcile with disk first: a refresh should notice an account that
      // appeared or changed while the watcher was not looking.
      await this.adoptLiveAuth();
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
