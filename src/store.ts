import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { readIdentity } from './identity';
import { CodexAuth, Identity, Profile, UsageSnapshot } from './types';

const PROFILES_KEY = 'codexAccounts.profiles';
const DISMISSED_KEY = 'codexAccounts.dismissed';
const SECRET_PREFIX = 'codexAccounts.auth.';

/**
 * Profile metadata goes in `globalState`; the `auth.json` (which holds the
 * tokens) only in SecretStorage. Keeping the two apart is what avoids dumping
 * credentials into `state.vscdb` in the clear.
 */
export class ProfileStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  list(): Profile[] {
    return [...this.raw()].sort((a, b) => a.order - b.order);
  }

  get(id: string): Profile | undefined {
    return this.raw().find((profile) => profile.id === id);
  }

  private raw(): Profile[] {
    return this.context.globalState.get<Profile[]>(PROFILES_KEY, []);
  }

  private async save(profiles: Profile[]): Promise<void> {
    await this.context.globalState.update(PROFILES_KEY, profiles);
  }

  private secretKey(id: string): string {
    return SECRET_PREFIX + id;
  }

  async getAuth(id: string): Promise<CodexAuth | null> {
    const raw = await this.context.secrets.get(this.secretKey(id));
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw) as CodexAuth;
    } catch {
      return null;
    }
  }

  async setAuth(id: string, auth: CodexAuth): Promise<void> {
    await this.context.secrets.store(this.secretKey(id), JSON.stringify(auth));
  }

  /** Creates a profile from an `auth.json`, deriving the identity from the token. */
  async add(label: string, auth: CodexAuth): Promise<Profile> {
    const profiles = this.raw();
    const identity = readIdentity(auth);
    const profile: Profile = {
      id: crypto.randomUUID(),
      label,
      order: profiles.reduce((max, item) => Math.max(max, item.order), -1) + 1,
      addedAt: Date.now(),
      email: identity.email,
      name: identity.name,
      accountId: identity.accountId,
      planType: identity.planType,
      authMode: auth.auth_mode,
    };
    profiles.push(profile);
    await this.save(profiles);
    await this.setAuth(profile.id, auth);
    return profile;
  }

  /** Finds the profile matching an identity (by `chatgpt_account_id`). */
  findByIdentity(identity: Identity): Profile | undefined {
    if (!identity.accountId) {
      return undefined;
    }
    return this.raw().find((profile) => profile.accountId === identity.accountId);
  }

  async rename(id: string, label: string): Promise<void> {
    await this.patch(id, (profile) => {
      profile.label = label;
    });
  }

  async remove(id: string): Promise<void> {
    const profile = this.get(id);
    await this.save(this.raw().filter((item) => item.id !== id));
    await this.context.secrets.delete(this.secretKey(id));
    // Removing the account that is live would otherwise be undone by the next
    // reconcile, which auto-saves accounts it does not recognise.
    if (profile?.accountId) {
      await this.dismiss(profile.accountId);
    }
  }

  /**
   * Accounts the user deleted on purpose. Auto-save skips these, so a removal
   * sticks; saving one explicitly is what takes it off the list.
   */
  private get dismissed(): string[] {
    return this.context.globalState.get<string[]>(DISMISSED_KEY, []);
  }

  isDismissed(accountId: string | undefined): boolean {
    return Boolean(accountId && this.dismissed.includes(accountId));
  }

  async dismiss(accountId: string): Promise<void> {
    if (this.dismissed.includes(accountId)) {
      return;
    }
    await this.context.globalState.update(DISMISSED_KEY, [...this.dismissed, accountId]);
  }

  async undismiss(accountId: string | undefined): Promise<void> {
    if (!accountId || !this.dismissed.includes(accountId)) {
      return;
    }
    await this.context.globalState.update(
      DISMISSED_KEY,
      this.dismissed.filter((item) => item !== accountId),
    );
  }

  async setUsage(id: string, usage: UsageSnapshot): Promise<void> {
    await this.patch(id, (profile) => {
      profile.lastUsage = usage;
    });
  }

  /**
   * Rewrites the secret with the `auth.json` the app-server refreshed and
   * realigns the identity. Without this the stored refresh_token ages out.
   */
  async refreshAuth(id: string, auth: CodexAuth): Promise<void> {
    await this.setAuth(id, auth);
    const identity = readIdentity(auth);
    await this.patch(id, (profile) => {
      profile.email = identity.email ?? profile.email;
      profile.name = identity.name ?? profile.name;
      profile.accountId = identity.accountId ?? profile.accountId;
      profile.planType = identity.planType ?? profile.planType;
      profile.authMode = auth.auth_mode ?? profile.authMode;
    });
  }

  async reorder(orderedIds: string[]): Promise<void> {
    const profiles = this.raw();
    orderedIds.forEach((id, index) => {
      const profile = profiles.find((item) => item.id === id);
      if (profile) {
        profile.order = index;
      }
    });
    await this.save(profiles);
  }

  private async patch(id: string, mutate: (profile: Profile) => void): Promise<void> {
    const profiles = this.raw();
    const profile = profiles.find((item) => item.id === id);
    if (!profile) {
      return;
    }
    mutate(profile);
    await this.save(profiles);
  }
}
