import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { readIdentity } from './identity';
import { CodexAuth, Identity, Profile, UsageSnapshot } from './types';

const PROFILES_KEY = 'codexAccounts.profiles';
const SECRET_PREFIX = 'codexAccounts.auth.';

/**
 * Metadado do perfil no `globalState`; o `auth.json` (que contém os tokens) só
 * no SecretStorage. Separar os dois é o que evita despejar credencial no
 * `state.vscdb` em claro.
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

  /** Cria um perfil a partir de um `auth.json`, derivando a identidade do token. */
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

  /** Acha o perfil que corresponde a uma identidade (pelo `chatgpt_account_id`). */
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
    await this.save(this.raw().filter((profile) => profile.id !== id));
    await this.context.secrets.delete(this.secretKey(id));
  }

  async setUsage(id: string, usage: UsageSnapshot): Promise<void> {
    await this.patch(id, (profile) => {
      profile.lastUsage = usage;
    });
  }

  /**
   * Reescreve o segredo com o `auth.json` renovado pelo app-server e realinha a
   * identidade. Sem isso o refresh_token guardado envelhece até deixar de valer.
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
