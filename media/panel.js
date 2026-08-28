(function () {
  const vscode = acquireVsCodeApi();
  const accounts = document.getElementById('accounts');
  const empty = document.getElementById('empty');
  const unsaved = document.getElementById('unsaved');
  const home = document.getElementById('home');

  let warnThreshold = 80;

  function post(type, id) {
    vscode.postMessage({ type, id });
  }

  /** Texto relativo curto: "em 1h 10m", "em 3d 10h", "agora". */
  function relativeFuture(unixSeconds) {
    if (!unixSeconds) {
      return '';
    }
    const seconds = unixSeconds - Math.floor(Date.now() / 1000);
    if (seconds <= 0) {
      return 'a qualquer momento';
    }
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) {
      return `em ${days}d ${hours}h`;
    }
    if (hours > 0) {
      return `em ${hours}h ${minutes}m`;
    }
    return `em ${minutes}m`;
  }

  function relativePast(timestampMs) {
    if (!timestampMs) {
      return 'nunca';
    }
    const minutes = Math.floor((Date.now() - timestampMs) / 60000);
    if (minutes < 1) {
      return 'agora há pouco';
    }
    if (minutes < 60) {
      return `há ${minutes} min`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return `há ${hours}h`;
    }
    return `há ${Math.floor(hours / 24)}d`;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }

  function meterNode(title, window) {
    const meter = el('div', 'meter');
    const head = el('div', 'meter-head');
    head.append(el('span', null, title), el('span', null, `${window.usedPercent}%`));
    const bar = el('div', window.usedPercent >= warnThreshold ? 'bar warn' : 'bar');
    const fill = el('span');
    fill.style.width = `${window.usedPercent}%`;
    bar.append(fill);
    meter.append(head, bar);
    const reset = relativeFuture(window.resetsAt);
    if (reset) {
      meter.append(el('div', 'reset', `renova ${reset}`));
    }
    return meter;
  }

  function actionButton(label, action, id, title, className) {
    const button = el('button', className, label);
    button.title = title || label;
    button.addEventListener('click', () => post(action, id));
    return button;
  }

  function cardNode(profile) {
    const card = el('div', profile.active ? 'card active' : 'card');

    const head = el('div', 'card-head');
    head.append(el('span', 'label', profile.label));
    if (profile.planType) {
      head.append(el('span', 'badge', profile.planType));
    }
    if (profile.active) {
      head.append(el('span', 'badge active', 'ativa'));
    }
    head.append(el('span', 'spacer'));
    head.append(actionButton('↻', 'refreshOne', profile.id, 'Atualizar esta conta'));
    card.append(head);

    if (profile.email) {
      card.append(el('div', 'email', profile.email));
    }

    const usage = profile.lastUsage;
    if (usage && usage.limits && usage.limits.length > 0) {
      for (const limit of usage.limits) {
        if (limit.limitName) {
          card.append(el('div', 'limit-name', limit.limitName));
        }
        for (const window of limit.windows) {
          card.append(meterNode(window.label, window));
        }
      }
    }

    if (usage && usage.error) {
      card.append(el('div', 'meta error', usage.error));
    } else {
      card.append(el('div', 'meta', `atualizado ${relativePast(usage && usage.fetchedAt)}`));
    }

    const actions = el('div', 'actions');
    actions.append(actionButton('Janela', 'window', profile.id, 'Abrir janela com CODEX_HOME próprio'));
    if (!profile.active) {
      actions.append(actionButton('Trocar', 'switch', profile.id, 'Usar esta conta'));
    }
    actions.append(actionButton('Hi', 'warmup', profile.id, 'Mandar um prompt mínimo por esta conta'));
    actions.append(actionButton('✎', 'rename', profile.id, 'Renomear'));
    actions.append(actionButton('\u{1F5D1}', 'remove', profile.id, 'Remover', 'danger'));
    card.append(actions);

    return card;
  }

  function render(state) {
    warnThreshold = state.warnThreshold || 80;

    accounts.replaceChildren(...state.profiles.map(cardNode));
    empty.hidden = state.profiles.length > 0;

    if (state.unsaved) {
      unsaved.textContent = `Conta conectada não salva: ${state.unsaved.email || 'desconhecida'}. Salve-a antes de trocar de perfil.`;
      unsaved.hidden = false;
    } else {
      unsaved.hidden = true;
    }

    home.textContent = `CODEX_HOME: ${state.codexHome}`;

    for (const button of document.querySelectorAll('.toolbar button')) {
      button.disabled = state.refreshing && button.dataset.action === 'refreshAll';
    }
  }

  for (const button of document.querySelectorAll('.toolbar button')) {
    button.addEventListener('click', () => post(button.dataset.action));
  }

  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'state') {
      render(event.data);
    }
  });

  post('ready');
})();
