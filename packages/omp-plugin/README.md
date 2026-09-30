# @papercusp/omp

Launch an [OMP](https://omp.sh) agent session pre-seeded with the
Papercusp engineer-collaborator playbook, scoped to a single workspace.

This is the **power-user** path: advanced Papercusp users who manage
their own terminal get the same agent experience the Papercusp
engineers have, without Papercusp shipping a terminal UI.

## Install

```sh
npm i -g @oh-my-pi/cli @papercusp/omp
```

`@oh-my-pi/cli` is the OMP runtime; `@papercusp/omp` is this plugin.
Both are required.

## Usage

You normally never run this by hand — the Papercusp desktop's **Launch
agent** button runs it for you, passing tokens via the environment.

```sh
papercusp-omp connect --url <bundle-url> [--cwd <dir>]
```

Tokens are **never** passed as flags (argv leaks to `ps`, shell
history, and kernel audit). They are read from the environment:

| Variable                         | Required | Meaning                                  |
| --------------------------------- | -------- | ---------------------------------------- |
| `PAPERCUSP_BUNDLE_ACCESS_TOKEN`   | yes      | Short-lived (1h) access token            |
| `PAPERCUSP_BUNDLE_REFRESH_TOKEN`  | yes      | Refresh token — kept in memory only      |
| `PAPERCUSP_BUNDLE_URL`            | —        | Bundle URL (alternative to `--url`)      |
| `PAPERCUSP_OMP_CWD`               | —        | Working dir (alternative to `--cwd`)     |
| `PAPERCUSP_AUTH_SESSION_ID`       | —        | Names the session-scratch directory      |

## What `connect` does

1. Fetches `/api/agent-bundle` with the access token — persona,
   tool playbook, skills, hooks, and the workspace-scoped MCP URL.
2. Writes a session-scratch profile under a per-OS runtime dir
   (`$XDG_RUNTIME_DIR` on Linux, `~/Library/Application Support` on
   macOS, `%LOCALAPPDATA%` on Windows).
3. Places `.mcp.json` where OMP discovers it, backing up any
   pre-existing one.
4. Spawns `omp` with `--append-system-prompt` and `--hook` flags, and
   stays attached for the session's lifetime.
5. Refreshes the access token in the background, ~5 min before expiry.
6. On exit: restores `.mcp.json`, removes the scratch dir.

Nothing is installed globally on your machine — no `~/.omp` or
`~/.claude` edits. The refresh token never touches disk.

## Notes

- The plan (`apps/operator/docs/plans/omp-power-user-bundle-2026-05-20.md`)
  describes the launch command as `omp papercusp connect`. OMP's CLI
  does not dispatch `omp <plugin> <subcommand>`, so this package ships
  its own `papercusp-omp` binary instead. Same behaviour, valid CLI.
- Requires the Papercusp desktop app (or operator) to be running — the
  bundle is fetched live so the playbook stays versioned with the code.

## Build

```sh
npm run build      # tsc → dist/
npm run typecheck  # tsc --noEmit
```
