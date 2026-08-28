import * as fs from 'fs';
import * as path from 'path';
import { authFilePath, resolveCodexHome } from './codex-home';

/** A login rewrites `auth.json` more than once; settle before reading it. */
const DEBOUNCE_MS = 600;

/** Stat interval for the backstop watcher. Cheap enough to leave running. */
const POLL_MS = 4000;

/**
 * Watches the live `auth.json` for changes made outside this extension — a
 * `codex login` in a terminal, a logout, another tool.
 *
 * Uses Node's watchers rather than `vscode.workspace.createFileSystemWatcher`:
 * the VS Code one did not deliver for a path outside the workspace under a
 * remote extension host, which is the setup this has to work in.
 *
 * The watch is on the *directory*, not the file. Codex writes `auth.json`
 * atomically — a temp file and a rename — which swaps the inode and would leave
 * a watch bound to the file listening to something nobody writes to again.
 * `watchFile` polls by path, so it survives that too and stands in when inotify
 * is unavailable (some network and virtualised filesystems).
 */
export function watchLiveAuth(onChange: () => void): { dispose: () => void } {
  const home = resolveCodexHome();
  const file = authFilePath(home);
  const name = path.basename(file);

  let settle: NodeJS.Timeout | undefined;
  const trigger = (): void => {
    if (settle) {
      clearTimeout(settle);
    }
    settle = setTimeout(onChange, DEBOUNCE_MS);
  };

  let directory: fs.FSWatcher | undefined;
  try {
    directory = fs.watch(home, (_event, changed) => {
      // `changed` is null on some platforms; treat that as "something moved".
      if (!changed || changed === name) {
        trigger();
      }
    });
    // An unreadable directory raises on the watcher, not on the call.
    directory.on('error', () => undefined);
  } catch {
    directory = undefined; // No CODEX_HOME yet — the poller covers it.
  }

  fs.watchFile(file, { interval: POLL_MS }, (current, previous) => {
    if (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size) {
      trigger();
    }
  });

  return {
    dispose: () => {
      if (settle) {
        clearTimeout(settle);
      }
      directory?.close();
      fs.unwatchFile(file);
    },
  };
}
