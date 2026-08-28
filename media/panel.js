(function () {
  const vscode = acquireVsCodeApi();
  const list = document.getElementById('accounts');
  const caption = document.getElementById('caption');
  const empty = document.getElementById('empty');
  const unsaved = document.getElementById('unsaved');
  const home = document.getElementById('home');

  /** Usage above this counts as spent; the panel shows what is left, so it flips. */
  let warnThreshold = 80;

  function post(type, id) {
    vscode.postMessage({ type, id });
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

  /** Compact duration from now: "3d 10h", "1h 10m", "12m". */
  function until(unixSeconds) {
    if (!unixSeconds) {
      return null;
    }
    const seconds = unixSeconds - Math.floor(Date.now() / 1000);
    if (seconds <= 0) {
      return 'any moment';
    }
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) {
      return `${days}d ${hours}h`;
    }
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
  }

  function ago(timestampMs) {
    if (!timestampMs) {
      return 'never checked';
    }
    const minutes = Math.floor((Date.now() - timestampMs) / 60000);
    if (minutes < 1) {
      return 'checked just now';
    }
    if (minutes < 60) {
      return `checked ${minutes} min ago`;
    }
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? `checked ${hours}h ago` : `checked ${Math.floor(hours / 24)}d ago`;
  }

  const freeOf = (window) => 100 - window.usedPercent;

  /** Severity from what is left, not what was spent. */
  function severity(free) {
    if (free === null) {
      return 'unknown';
    }
    if (free <= 0) {
      return 'out';
    }
    return free <= 100 - warnThreshold ? 'low' : 'ok';
  }

  /**
   * The account-wide limit ("codex") is what gates every request, so it drives
   * the headline. Model families are reported separately and shown below it.
   */
  function accountLimit(usage) {
    if (!usage || !usage.limits || usage.limits.length === 0) {
      return null;
    }
    return usage.limits.find((limit) => limit.limitId === 'codex') || usage.limits[0];
  }

  /** How much room is left on the tightest window of the account-wide limit. */
  function runway(profile) {
    const limit = accountLimit(profile.lastUsage);
    if (!limit) {
      return null;
    }
    return Math.min(...limit.windows.map(freeOf));
  }

  function windowRow(window) {
    const row = el('li');
    row.append(el('span', 'w', window.label));
    const free = freeOf(window);
    const reset = until(window.resetsAt);
    let text;
    if (window.usedPercent === 0) {
      text = 'untouched';
    } else if (free <= 0) {
      text = reset ? `spent · back in ${reset}` : 'spent';
    } else {
      text = reset ? `${window.usedPercent}% used · resets ${reset}` : `${window.usedPercent}% used`;
    }
    row.append(el('span', free <= 0 ? 'v exhausted' : 'v', text));
    return row;
  }

  function windowList(windows, className) {
    const ul = el('ul', className);
    for (const window of windows) {
      ul.append(windowRow(window));
    }
    return ul;
  }

  function button(label, action, id, title, className) {
    const node = el('button', className);
    // The label lives in a span so the busy state can spin the glyph alone —
    // rotating the button itself would drag its padding and hover box around.
    node.append(el('span', null, label));
    node.title = title || label;
    node.addEventListener('click', () => post(action, id));
    return node;
  }

  function accountNode(profile, busy) {
    const node = el('article', profile.active ? 'account active' : 'account');

    const head = el('div', 'account-head');
    head.append(el('span', 'name', profile.label));
    if (profile.active) {
      head.append(el('span', 'active-tag', 'in use'));
    }
    node.append(head);

    if (profile.email) {
      node.append(el('div', 'email', profile.email));
    }

    const free = runway(profile);
    const level = severity(free);

    const headline = el('div', 'headline');
    headline.append(el('span', `figure ${level}`, free === null ? '—' : `${100 - free}%`));
    headline.append(el('span', 'figure-label', free === null ? 'no reading' : 'used'));
    if (profile.planType) {
      headline.append(el('span', 'plan', profile.planType));
    }
    node.append(headline);

    // Figure and bar both read as consumption, so they never disagree. Colour
    // still keys off what remains, so the bar fills and reddens together.
    const track = el('div', `track ${level}`);
    const fill = el('span');
    fill.style.width = `${free === null ? 0 : 100 - free}%`;
    track.append(fill);
    node.append(track);

    const usage = profile.lastUsage;
    const main = accountLimit(usage);
    if (main) {
      node.append(windowList(main.windows, 'windows'));
      for (const limit of usage.limits) {
        if (limit === main) {
          continue;
        }
        node.append(el('div', 'family', limit.limitName || limit.limitId));
        node.append(windowList(limit.windows, 'windows sub'));
      }
    }

    const broken = !busy && usage && usage.errorKind === 'auth';
    if (busy) {
      node.append(el('div', 'note', 'checking…'));
    } else if (usage && usage.error) {
      const note = el('div', 'note error', usage.error);
      if (usage.errorDetail) {
        note.title = usage.errorDetail;
      }
      node.append(note);
    } else {
      node.append(el('div', 'note', ago(usage && usage.fetchedAt)));
    }

    const actions = el('div', 'actions');
    if (broken) {
      // Switching to revoked credentials would write a dead auth.json and sign
      // the user out of Codex, so the card offers the repair instead.
      actions.append(button('Log in', 'login', profile.id, 'Sign in to this account again', 'use'));
    } else if (!profile.active) {
      actions.append(button('Use', 'switch', profile.id, 'Make this the active account', 'use'));
    }
    actions.append(button('Window', 'window', profile.id, 'Open a window with its own CODEX_HOME'));
    actions.append(el('span', 'grow'));
    const check = button('↻', 'refreshOne', profile.id, 'Check this account now');
    if (busy) {
      check.classList.add('busy');
      check.disabled = true;
    }
    actions.append(check);
    actions.append(button('✎', 'rename', profile.id, 'Rename'));
    actions.append(button('\u{1F5D1}', 'remove', profile.id, 'Remove', 'danger'));
    node.append(actions);

    return node;
  }

  function render(state) {
    warnThreshold = state.warnThreshold || 80;

    // Most room first, so the account to switch to is the one at the top.
    // Accounts with no reading sink to the bottom rather than posing as full.
    const ordered = [...state.profiles].sort((a, b) => {
      const left = runway(a);
      const right = runway(b);
      if (left === right) {
        return a.order - b.order;
      }
      if (left === null) {
        return 1;
      }
      if (right === null) {
        return -1;
      }
      return right - left;
    });

    const busy = new Set(state.pending || []);
    list.replaceChildren(...ordered.map((profile) => accountNode(profile, busy.has(profile.id))));
    empty.hidden = ordered.length > 0;
    caption.hidden = ordered.length < 2;
    caption.textContent = 'least used first';

    if (state.unsaved) {
      unsaved.textContent = `${state.unsaved.email || 'An account'} is signed in but not saved here. Save it before switching, or it is gone.`;
      unsaved.hidden = false;
    } else {
      unsaved.hidden = true;
    }

    home.textContent = state.codexHome;

    const refreshAll = document.querySelector('.toolbar button[data-action="refreshAll"]');
    refreshAll.disabled = state.refreshing;
    refreshAll.classList.toggle('busy', state.refreshing);
  }

  for (const node of document.querySelectorAll('.toolbar button')) {
    node.addEventListener('click', () => post(node.dataset.action));
  }

  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'state') {
      render(event.data);
    }
  });

  post('ready');
})();
