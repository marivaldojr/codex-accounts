# Codex Accounts

Alterna entre múltiplas contas do Codex (ChatGPT) no VS Code, mostrando os
limites de uso de **todas** elas num painel na barra lateral — sem precisar
trocar de conta para descobrir quanto sobrou em cada uma.

## O que faz

- **Painel na activity bar** com um card por conta: plano, e-mail, barras de uso
  por janela (5h, 7d, …) e quando cada janela renova.
- **Troca de conta** gravando o `auth.json` do perfil no `CODEX_HOME` ativo.
- **Leitura de uso isolada:** os limites de cada conta são consultados num
  `CODEX_HOME` descartável, então ver o uso de uma conta **não** troca a conta
  ativa nem invalida a sessão em andamento.
- **Aquecimento (Hi):** manda um prompt mínimo por uma conta parada, também em
  ambiente isolado, para abrir a janela de uso dela.
- **Login** pelo terminal (`codex login`) sem sair do editor.

## Como funciona por dentro

O Codex guarda a sessão em `$CODEX_HOME/auth.json` (`~/.codex/auth.json` por
padrão) — o mesmo arquivo que a CLI e a extensão oficial leem. Um perfil aqui é
uma cópia desse arquivo:

- **metadados** (nome, e-mail, plano) ficam no `globalState`;
- **os tokens** ficam no **SecretStorage** do VS Code, nunca no `globalState`.

Os limites vêm do próprio `codex app-server`, por JSON-RPC no stdin/stdout
(método `account/rateLimits/read`) — não existe endpoint HTTP público
equivalente. Para consultar uma conta que não é a ativa, a extensão cria um
`CODEX_HOME` temporário (`0700`) contendo só o `auth.json` daquele perfil, faz a
chamada, e apaga o diretório. Se o `app-server` renovar o token nesse meio
tempo, o token novo é gravado de volta no perfil.

A identidade sai das claims do `id_token`; duas contas são consideradas a mesma
quando o `chatgpt_account_id` bate — é o único campo estável, já que o
`access_token` muda a cada refresh e o e-mail se repete entre workspaces.

## Requisitos

- VS Code 1.85+
- CLI do Codex (`codex`) no PATH — ou aponte o caminho em
  `codexAccounts.codexCommand`.

## Uso

1. Entre numa conta (`codex login`, ou o botão **Login** do painel).
2. Clique em **+ Salvar conta atual**.
3. Repita para as outras contas.
4. Use **Trocar** no card e recarregue a janela quando a extensão pedir.

> O Codex só assume a conta nova depois que a janela recarrega. Ligue
> `codexAccounts.autoReloadAfterSwitch` para não ser perguntado toda vez.

## Configurações

| Chave | Padrão | O que faz |
| --- | --- | --- |
| `codexAccounts.pollIntervalSeconds` | `900` | Intervalo de atualização dos limites (piso de 120s). |
| `codexAccounts.autoReloadAfterSwitch` | `false` | Recarrega a janela sozinho depois da troca. |
| `codexAccounts.codexHome` | `""` | `CODEX_HOME` explícito. Vazio = env ou `~/.codex`. |
| `codexAccounts.codexCommand` | `codex` | Comando da CLI. |
| `codexAccounts.warnThresholdPercent` | `80` | A partir de quanto a barra fica vermelha. |
| `codexAccounts.warmupModel` | `""` | Modelo do aquecimento. Vazio = padrão do perfil. |
| `codexAccounts.warmupPrompt` | `Hi` | Prompt do aquecimento. |
| `codexAccounts.warmupTimeoutSeconds` | `120` | Tempo máximo do aquecimento. |

## Limitações conhecidas

- **Janela independente** é best-effort. Ela prepara um `CODEX_HOME` só daquele
  perfil e abre a janela a partir de um terminal com essa variável, mas a nova
  janela só usa a conta certa se herdar o ambiente. Em Remote-SSH, WSL e dev
  containers o VS Code costuma reaproveitar um servidor já em execução, e aí a
  variável não chega no host da extensão. Para isolar de verdade nesses casos,
  abra o VS Code de um shell com `CODEX_HOME` já exportado.
- Cada atualização de limites sobe um processo `codex app-server` por perfil (em
  lotes de 3). Com muitos perfis, prefira intervalos maiores.

## Desenvolvimento

```bash
npm install
npm run watch      # bundle em modo watch
npm run typecheck
npm run test:smoke # exercita identidade + limites contra a sua conta real (só leitura)
npm run build:vsix
```

O `test:smoke` faz uma chamada real ao `app-server` e verifica, entre outras
coisas, que o `~/.codex/auth.json` **não** foi modificado.

## Licença

MIT
