# Changelog

Notable changes to Codex Accounts. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] — 2026-08-28

### Changed

- **A logo of its own.** Three concentric gauge rings, each filled to a
  different level, with a dot at the centre for the account in use — the
  panel's own reading, turned into a mark.
- **The activity bar icon now speaks the same language.** The silhouette it
  replaces bore no relation to the marketplace icon or to what the panel
  shows. VS Code masks this icon and paints it with the theme colour, so the
  track rings carry their contrast in the alpha channel rather than in a fill.
- The marketplace icon is regenerated from the same source, at 256×256.

## [0.1.0] — 2026-08-28

First release.

### Added

- **Accounts panel** in the activity bar. Each account leads with the
  consumption of its tightest window — one figure, one bar, both reading the
  same direction — over compact rows for every window Codex reports.
- **Per-model limits nested under the account.** Codex reports an account-wide
  limit plus one per model family; the account-wide one drives the headline and
  the families sit beneath it.
- **Ordering by room left**, so the account worth switching to is the one at the
  top of the list. Accounts with no reading sort last rather than passing for
  unused.
- **Usage read without switching accounts.** Every account is queried in a
  throwaway `CODEX_HOME` holding only its own credentials, so seeing how much is
  left somewhere else neither changes the active account nor disturbs a session
  in progress.
- **Account switching**, writing the profile's `auth.json` into the active
  `CODEX_HOME` and offering the window reload that Codex needs to pick it up.
  `codexAccounts.autoReloadAfterSwitch` skips the prompt.
- **Accounts saved as they sign in.** The live `auth.json` is watched, so a
  `codex login` in any terminal becomes a card on its own, labelled by email.
  Deleting a profile is remembered, so a removal is not undone by the next
  reconcile.
- **Credentials kept current.** Codex rotates its OAuth tokens as you work, and
  each rotation revokes the token it replaces. The extension adopts what is on
  disk whenever the file changes, writes rotations back for the active account,
  and captures the signed-in account before a login overwrites it.
- **Failures said plainly.** Dead credentials, an unreachable host, a missing
  CLI and a timeout read as themselves rather than as a raw HTTP body, which
  stays in the tooltip. An account whose credentials are dead offers a login in
  place of the switch, since switching to them would only sign you out.
- **A check in progress is visible** — the button spins, the card says so, and
  the toolbar's check-everything pass announces each account as it reaches it.
- **Independent window** (best-effort): prepares a `CODEX_HOME` of the profile's
  own and opens a window from a terminal carrying it.
- Settings for the poll interval, `CODEX_HOME`, the Codex CLI command, the
  reload prompt, and the threshold where a bar turns red.

### Security

- Account tokens live in VS Code's SecretStorage. Only metadata — label, email,
  plan, last reading — is kept in `globalState`.
- The throwaway `CODEX_HOME` is created at mode `0700`, its `auth.json` at
  `0600`, and the file is overwritten before the directory is removed, so a
  failed cleanup leaves nothing usable behind.
- `auth.json` is written atomically, so Codex can never read it half-written.

### Known limitations

- An account signed in somewhere else as well — another machine, another
  `CODEX_HOME` — can be revoked from there, and this extension only finds out on
  its next reading. Only one copy of an account's credentials can be current.
- The independent window depends on the new window inheriting the environment.
  Under Remote-SSH, WSL and dev containers VS Code usually reuses a running
  server, and the variable never reaches the extension host.
- Every refresh spawns one `codex app-server` per profile, in batches of three.
  With many accounts, prefer a longer interval.

[0.1.1]: https://github.com/marivaldojr/codex-accounts/releases/tag/v0.1.1
[0.1.0]: https://github.com/marivaldojr/codex-accounts/releases/tag/v0.1.0
