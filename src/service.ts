import { spawn } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { resolveCodexCommand } from './cli';
import { readAuth, resolveCodexHome, withTemporaryCodexHome, writeAuth } from './codex-home';
import { isUsableAuth, readIdentity } from './identity';
import { ProfileStore } from './store';
import { Profile, ProfileView } from './types';
import { fetchUsage } from './usage';

export interface ActionResult {
  ok: boolean;
  message: string;
}

/** Quantas contas consultar em paralelo — cada uma sobe um processo `codex`. */
const USAGE_CONCURRENCY = 3;

export class AccountsService {
  private refreshing = false;

  constructor(
    private readonly store: ProfileStore,
    private readonly clientVersion: string,
    private readonly onChange: () => void,
  ) {}

  /** Perfis já marcados com quem está ativo no `auth.json` do CODEX_HOME atual. */
  listView(): ProfileView[] {
    const active = this.store.findByIdentity(readIdentity(readAuth()));
    return this.store.list().map((profile) => ({ ...profile, active: profile.id === active?.id }));
  }

  /** A conta que está no `auth.json` ainda não salva como perfil, se houver. */
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
        message: `Nenhuma conta conectada em ${resolveCodexHome()}. Entre com "codex login" antes de salvar.`,
      };
    }
    const identity = readIdentity(auth);
    const existing = this.store.findByIdentity(identity);
    if (existing) {
      // Mesma conta já salva: atualiza os tokens em vez de duplicar o perfil.
      await this.store.refreshAuth(existing.id, auth);
      this.onChange();
      return { ok: true, message: `"${existing.label}" já estava salvo — tokens atualizados.` };
    }

    const suggested = identity.email ?? identity.name ?? 'Conta Codex';
    const chosen =
      label ??
      (await vscode.window.showInputBox({
        prompt: 'Nome do perfil',
        value: suggested,
        validateInput: (value) => (value.trim() ? undefined : 'Informe um nome.'),
      }));
    if (!chosen) {
      return { ok: false, message: 'Cancelado.' };
    }

    const profile = await this.store.add(chosen.trim(), auth);
    this.onChange();
    void this.refreshOne(profile.id);
    return { ok: true, message: `"${profile.label}" salvo.` };
  }

  async switchTo(id: string): Promise<ActionResult> {
    const profile = this.store.get(id);
    if (!profile) {
      return { ok: false, message: 'Perfil não encontrado.' };
    }
    const auth = await this.store.getAuth(id);
    if (!isUsableAuth(auth)) {
      return {
        ok: false,
        message: `"${profile.label}" não tem credenciais válidas. Entre de novo com "codex login" e salve o perfil.`,
      };
    }

    // Antes de sobrescrever, guarda a conta que está no arquivo se ela ainda não
    // for um perfil — senão a troca descarta uma sessão que o usuário teria de
    // refazer pelo login.
    const current = readAuth();
    if (isUsableAuth(current)) {
      const currentIdentity = readIdentity(current);
      const known = this.store.findByIdentity(currentIdentity);
      if (known) {
        await this.store.refreshAuth(known.id, current);
      } else {
        const answer = await vscode.window.showWarningMessage(
          `A conta ativa (${currentIdentity.email ?? 'desconhecida'}) não está salva. Trocar agora faz você perder o acesso a ela.`,
          { modal: true },
          'Salvar e trocar',
          'Trocar mesmo assim',
        );
        if (!answer) {
          return { ok: false, message: 'Troca cancelada.' };
        }
        if (answer === 'Salvar e trocar') {
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
    return { ok: true, message: `Agora usando "${profile.label}".` };
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
      `Agora usando "${profile.label}". O Codex só assume a conta nova depois de recarregar a janela.`,
      'Recarregar',
      'Depois',
    );
    if (answer === 'Recarregar') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  }

  async rename(id: string): Promise<ActionResult> {
    const profile = this.store.get(id);
    if (!profile) {
      return { ok: false, message: 'Perfil não encontrado.' };
    }
    const label = await vscode.window.showInputBox({
      prompt: 'Novo nome do perfil',
      value: profile.label,
      validateInput: (value) => (value.trim() ? undefined : 'Informe um nome.'),
    });
    if (!label) {
      return { ok: false, message: 'Cancelado.' };
    }
    await this.store.rename(id, label.trim());
    this.onChange();
    return { ok: true, message: 'Perfil renomeado.' };
  }

  async remove(id: string): Promise<ActionResult> {
    const profile = this.store.get(id);
    if (!profile) {
      return { ok: false, message: 'Perfil não encontrado.' };
    }
    const answer = await vscode.window.showWarningMessage(
      `Remover o perfil "${profile.label}"? As credenciais guardadas somem, e para voltar a usar essa conta será preciso fazer login de novo.`,
      { modal: true },
      'Remover',
    );
    if (answer !== 'Remover') {
      return { ok: false, message: 'Cancelado.' };
    }
    await this.store.remove(id);
    this.onChange();
    return { ok: true, message: `"${profile.label}" removido.` };
  }

  /** Abre um terminal com `codex login` no CODEX_HOME ativo. */
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
      message: 'Depois de concluir o login no navegador, use "Salvar conta atual".',
    };
  }

  /**
   * Manda um prompt mínimo pela conta do perfil, num CODEX_HOME descartável.
   * Serve para abrir a janela de uso de uma conta parada sem trocar a ativa.
   */
  async warmup(id: string): Promise<ActionResult> {
    const profile = this.store.get(id);
    if (!profile) {
      return { ok: false, message: 'Perfil não encontrado.' };
    }
    const auth = await this.store.getAuth(id);
    if (!isUsableAuth(auth)) {
      return { ok: false, message: `"${profile.label}" não tem credenciais válidas.` };
    }

    const config = vscode.workspace.getConfiguration('codexAccounts');
    const prompt = config.get<string>('warmupPrompt', 'Hi').trim() || 'Hi';
    const model = config.get<string>('warmupModel', '').trim();
    const timeoutMs = Math.max(15, config.get<number>('warmupTimeoutSeconds', 120)) * 1000;

    const { result, refreshedAuth } = await withTemporaryCodexHome(auth, async (codexHome) => {
      const args = ['exec', '--skip-git-repo-check', '--sandbox', 'read-only'];
      if (model) {
        args.push('--model', model);
      }
      args.push(prompt);
      return this.run(args, codexHome, timeoutMs);
    });
    if (refreshedAuth) {
      await this.store.refreshAuth(id, refreshedAuth);
    }

    if (result.timedOut) {
      return { ok: false, message: `Aquecimento de "${profile.label}" estourou o tempo.` };
    }
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim().slice(-300);
      return { ok: false, message: `Aquecimento de "${profile.label}" falhou: ${detail || 'erro desconhecido.'}` };
    }
    await this.refreshOne(id);
    return { ok: true, message: `"${profile.label}" aquecido.` };
  }

  private run(
    args: string[],
    codexHome: string,
    timeoutMs: number,
  ): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
    const { command } = resolveCodexCommand();
    return new Promise((resolve) => {
      const child = spawn(command, args, {
        env: { ...process.env, CODEX_HOME: codexHome },
        cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: error.message, timedOut });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut });
      });
    });
  }

  /**
   * Abre uma janela do VS Code apontada para um CODEX_HOME próprio do perfil,
   * para usar duas contas ao mesmo tempo. Best-effort: depende de a nova janela
   * herdar o ambiente, o que não vale quando o VS Code reaproveita um servidor
   * remoto já em execução (Remote-SSH, WSL, dev container).
   */
  async openIndependentWindow(id: string, globalStoragePath: string): Promise<ActionResult> {
    const profile = this.store.get(id);
    if (!profile) {
      return { ok: false, message: 'Perfil não encontrado.' };
    }
    const auth = await this.store.getAuth(id);
    if (!isUsableAuth(auth)) {
      return { ok: false, message: `"${profile.label}" não tem credenciais válidas.` };
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
      message: `CODEX_HOME de "${profile.label}" em ${home}. A janela nova só usa essa conta se herdar o ambiente do terminal.`,
    };
  }

  /** Atualiza os limites de um perfil só. */
  async refreshOne(id: string): Promise<void> {
    const auth = await this.store.getAuth(id);
    if (!isUsableAuth(auth)) {
      await this.store.setUsage(id, {
        fetchedAt: Date.now(),
        limits: [],
        error: 'sem credenciais válidas.',
      });
      this.onChange();
      return;
    }
    const { snapshot, refreshedAuth } = await fetchUsage(auth, this.clientVersion);
    if (refreshedAuth) {
      await this.store.refreshAuth(id, refreshedAuth);
    }
    await this.store.setUsage(id, snapshot);
    this.onChange();
  }

  /** Atualiza todos os perfis, em lotes, para não subir N processos de uma vez. */
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
}
