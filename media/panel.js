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

  /** Short relative future: "in 1h 10m", "in 3d 10h". */
  function relativeFuture(unixSeconds) {
    if (!unixSeconds) {
      return '';
    }
    const seconds = unixSeconds - Math.floor(Date.now() / 1000);
    if (seconds <= 0) {
      return 'any moment now';
    }
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) {
      return `in ${days}d ${hours}h`;
    }
    if (hours > 0) {
      return `in ${hours}h ${minutes}m`;
    }
    return `in ${minutes}m`;
  }

  function relativePast(timestampMs) {
    if (!timestampMs) {
      return 'never';
    }
    const minutes = Math.floor((Date.now() - timestampMs) / 60000);
    if (minutes < 1) {
      return 'just now';
    }
    if (minutes < 60) {
      return `${minutes} min ago`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return `${hours}h ago`;
    }
    return `${Math.floor(hours / 24)}d ago`;
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
      meter.append(el('div', 'reset', `resets ${reset}`));
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
      head.append(el('span', 'badge active', 'active'));
    }
    head.append(el('span', 'spacer'));
    head.append(actionButton('↻', 'refreshOne', profile.id, 'Refresh this account'));
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
      card.append(el('div', 'meta', `updated ${relativePast(usage && usage.fetchedAt)}`));
    }

    const actions = el('div', 'actions');
    actions.append(actionButton('Window', 'window', profile.id, 'Open a window with its own CODEX_HOME'));
    if (!profile.active) {
      actions.append(actionButton('Switch', 'switch', profile.id, 'Use this account'));
    }
    actions.append(actionButton('✎', 'rename', profile.id, 'Rename'));
    actions.append(actionButton('\u{1F5D1}', 'remove', profile.id, 'Remove', 'danger'));
    card.append(actions);

    return card;
  }

  function render(state) {
    warnThreshold = state.warnThreshold || 80;

    accounts.replaceChildren(...state.profiles.map(cardNode));
    empty.hidden = state.profiles.length > 0;

    if (state.unsaved) {
      unsaved.textContent = `Signed-in account not saved: ${state.unsaved.email || 'unknown'}. Save it before switching profiles.`;
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
