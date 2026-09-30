# Agent CLI spawn fails with opaque 'exited ?' — the operator's PATH lacks ~/.local/bin (EI-11519)
URL: /internal/docs/agent-insights/spawned-agent-cli-enoent-stripped-path

>-

## Symptom

An agent-backed chat surface (e.g. the Quick Panel brainstorm partner) dies
instantly with the terminal error **`claude-code exited ?`** — no exit code, no
stderr, nothing in the operator log. Only on operators spawned by the **Tauri
dev shell** (`:3270`); the release operator on `:3070` works.

## Root cause (two stacked defects)

1. **PATH divergence by spawner.** The claude native installer (2.1.207+, since
   2026-07-11) installs to `~/.local/bin`. A systemd-started operator inherits a
   login-ish PATH that includes it; the Tauri dev shell spawns its sidecar
   operator with a MINIMAL PATH **without `~/.local/bin`** → `spawn('claude')`
   ENOENT.
2. **The error was swallowed.** `child.on('error', () => { … })` discarded the
   error object, so the ENOENT never reached stderr/logs and the stream layer
   reported the generic `exited ?` (exitCode never set — the process never
   started).

## Fix (shared chokepoint, not the launcher)

In `libs/papercusp-shared/src/agent/chat-stream.ts`:

* **`withAgentBinDirs(env)`** — exported helper that APPENDS (never prepends)
  the well-known per-user bin dirs that exist on disk but are missing from
  `env.PATH`: `~/.local/bin`, `~/.bun/bin`, `~/.cargo/bin`,
  `/home/linuxbrew/.linuxbrew/bin`. Identity return when nothing is missing.
  Every agent-CLI spawn in this file now goes through it.
* **Spawn-error capture** — `child.on('error', e => …)` records
  `failed to spawn <cmd>: <message>` into the stderr buffer and the terminal
  error message, so the NEXT PATH-class failure names itself instead of
  reporting `exited ?`.

Unit tests: `chat-stream-resolve.test.ts` (`withAgentBinDirs` describe block).

## How to recognize the class

Any "worked under systemd, broken under X" where X spawns the process tree
(Tauri shell, a test runner, a container): diff the PATH first —
`tr ':' '\n' </proc/<pid>/environ`-style inspection of the ACTUAL spawner env,
not your interactive shell. An `exited ?`-style error with EMPTY stderr and no
exit code is the signature of a swallowed `spawn` error: the process never ran.
