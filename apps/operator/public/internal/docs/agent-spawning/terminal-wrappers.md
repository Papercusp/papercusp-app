# psu — the engineer-collaborator launcher
URL: /internal/docs/agent-spawning/terminal-wrappers

psu is the single launcher for engineer-collaborator (su) + role sessions; it assembles the playbook + MCP + flags per-launch and execs the raw CLI.

`psu` is the **one** command for launching a CLI agent in
**engineer-collaborator mode** (the full `papercusp-su` tool catalog +
playbook) or as an interactive **pipeline role**. It picks an agent +
workspace + harness + plan, records a tracked `/adv` session, then execs
the **raw** agent CLI with everything assembled per-launch.

:::note\[The `*-su` wrappers are retired]
There used to be three install-baked shell wrappers (`omp-su` / `claude-su`
/ `codex-su`) that exec'd each CLI with the playbook + MCP + skip-perms
baked in. They're gone. A launch is always: compose the system prompt →
resolve cwd → mint the MCP config → record the session → exec the raw CLI.
`su` is not a different mechanism — it's [`buildLaunchSpec`](#how-a-launch-is-assembled)
at the **superuser tier** (prompt = playbook, scope = `?superuser=1`),
the same builder a pipeline role uses with two parameters changed (D-001).
:::

Plain `claude` / `codex` stay vanilla — engineer mode is opt-in, and you
opt in by launching through `psu`. Plain `omp` is the **one** exception:
the installer runs `omp config set memory.backend off` *globally*, so
*every* omp invocation (plain omp included) uses the hybrid `memory:*` MCP
tools instead of OMP's native store. That's deliberate — the hybrid memory
is the one path — but it does mean plain `omp`'s native-memory behavior is
changed by install regardless of psu. See [Install](#install).

## Quick start

```bash
psu          # interactive: pick agent → workspace → harness → plan (or "NO PLAN")
```

Harnesses are **workspace-scoped**, so the picker asks for the workspace
before the harness. With a single workspace it's chosen automatically.

### Preselecting with flags

Preselect any of agent / workspace / harness / plan; the picker prompts
only for what you omit:

```bash
psu --agent=claude                                # pick workspace/harness/plan
psu --agent=omp --workspace=my-ws                 # pick harness/plan
psu --agent=codex --harness=papercup --no-plan    # everything preset → no prompts
```

### Scripting escape

```bash
psu --no-picker --agent=claude --harness=papercup --plan=my-plan-slug
psu --no-picker --agent=omp --workspace=my-ws --harness=papercup --no-plan
psu --no-picker --agent=codex --no-plan           # active workspace root, no harness
```

`--agent` is required (`claude` | `omp` | `codex`); `--workspace` defaults
to the active workspace; `--harness` defaults to the workspace root if
omitted; pass `--no-plan` for an ad-hoc session or `--plan=<slug>` to bind one.

### More flags

The launcher implements several other first-class flags on top of
agent/workspace/harness/plan:

| Flag                                 | Effect                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--profile=engineer\|power\|generic` | Which su playbook + dispatch tier (default `engineer`). Changes **both** the rendered playbook **and** the MCP dispatch gating, via `PAPERCUSP_PROFILE` — see [Profiles](#profiles).                                                                                                                                                          |
| `--account=<id>`                     | Pin the session to a specific inference-gateway pool account; fail-soft to the default credential if the gateway is off or the id is unknown.                                                                                                                                                                                                 |
| `--brain`                            | Retired: fails closed with a tombstone message. Use the live operator/papercup converse surface or a normal `psu` session.                                                                                                                                                                                                                    |
| `--fork` / `--fork-session`          | claude + codex, resume-only: branch the resumed conversation into a **new** native session id (seeded with the original's history) with a fresh coord identity, so the fork runs concurrently with the still-live original. Claude tracked forks can pre-mint the fork id; Codex uses `codex fork` and discovers the resulting rollout later. |
| `--add-dir=<dir>`                    | Repeatable; maps to claude's + codex's native `--add-dir` (omp has none → warned + skipped). Both space and `=` forms.                                                                                                                                                                                                                        |
| `--model=<m>`                        | Backend model fuzzy-match passthrough.                                                                                                                                                                                                                                                                                                        |
| `--yes` / `-y`                       | Skip the "proceed anyway?" confirm when resuming an untracked (non-psu) session in scripts.                                                                                                                                                                                                                                                   |

## How a launch is assembled

`psu` calls `POST /api/agent-mcp/console/bootstrap-su`, which builds the
launch spec via `buildLaunchSpec({ kind: 'su' })` — the playbook (rendered
fresh from `prompts/papercusp-su-<profile>.tools.md` + the per-agent
overlay, so it can't drift from the installed copy) plus a per-launch
scope/plan addendum — records the `adv_sessions` row, mints a per-session
`PAPERCUSP_SID`, and returns the prompt file + raw backend. `psu` then execs
the raw CLI. What each agent needs differs:

| Agent    | Prompt                                                                                                              | MCP (`papercusp-su`)                                                                               | Lock enforcement                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `claude` | `--append-system-prompt-file <playbook+ctx>` `--dangerously-skip-permissions` `--permission-mode bypassPermissions` | **user-level** in `~/.claude.json` (survives a raw launch; its url env-expands `${PAPERCUSP_SID}`) | **user-level** `Pre/PostToolUse` hooks in `~/.claude/settings.json` — automatic                          |
| `omp`    | `--approval-mode yolo --append-system-prompt <playbook+ctx>` `-e ~/.papercusp/papercusp-coord.ts`                   | **user-level** in `~/.omp/agent/mcp.json`                                                          | `coord-hook.ts` loaded per-launch via `-e`                                                               |
| `codex`  | per-session `CODEX_HOME` (`AGENTS.md` = playbook, `config.toml` = superuser MCP)                                    | in that `CODEX_HOME`'s `config.toml` (`http_headers` bearer)                                       | per-session `hooks.json` `Pre/PostToolUse` gates for `apply_patch`/`Edit`/`Write` + Bash resource checks |

`PAPERCUSP_SID` is minted per launch and exported, so each session is a
distinct coord/lock owner (two concurrent `psu` sessions don't collide).

### Profiles

The su playbook comes in three profiles — `engineer` (default), `power`,
and `generic` — selected per launch with `--profile`. Profile is **not**
just prompt text: the chosen `prompts/papercusp-su-<profile>.tools.md`
renders the playbook **and** the launcher exports `PAPERCUSP_PROFILE`, which
the MCP dispatcher reads to gate the tool tier (claude expands it into the
user-level MCP url; omp carries it via the `x-papercusp-profile` header).
Without that export, `--profile` would change only the playbook text while
dispatch kept gating as `engineer`.

### codex: a per-session CODEX\_HOME, hooks, and diagnostics

Codex has no `--append-system-prompt`/`--mcp-config` flags, so each `psu`
codex launch mints a fresh `CODEX_HOME` under
`~/.papercusp/su-codex-homes/session-<id>/`:

* `AGENTS.md` — the engineer playbook (codex's instruction file)
* `config.toml` — the superuser MCP, with the bearer baked as
  `http_headers = { Authorization = "Bearer …" }`. (Codex 0.135's
  `bearer_token_env_var` does **not** deliver a valid bearer for a
  streamable-http server — verified — so the token is baked into the 0600
  ephemeral home, like claude's `~/.claude.json` header.)
* `hooks.json` — the SU-locks `PreToolUse`/`PostToolUse` hooks for
  `apply_patch` (plus the documented `Edit`/`Write` matcher aliases), Bash
  resource gates, MCP calls, activity, and mid-turn coord delivery. Current
  Codex exposes `hooks` as a stable feature and discovers this file next to the
  active `CODEX_HOME/config.toml`; `psu` passes
  `--dangerously-bypass-hook-trust` because the per-session home contains only
  Papercusp-managed hooks.
* `auth.json` — a **symlink** to `~/.codex/auth.json` (shared ChatGPT login).

When local hook scripts are missing, the generated
`papercusp-diagnostics.json` says `hooks-missing` and Codex falls back to the
same explicit `locks:acquire` discipline a human shell would use. Plain
`codex` (`CODEX_HOME=~/.codex`) is fully vanilla.

:::note\[claude su sessions get an isolated `CLAUDE_CONFIG_DIR` (EI-155)]
An interactive claude su session doesn't run under the shared `~/.claude`:
it gets a per-session, transcript-isolated `CLAUDE_CONFIG_DIR` (keyed by the
session's `PAPERCUSP_SID`) — a symlink mirror of `~/.claude` with **two** things
isolated, the transcript store `projects/` (EI-153) and the user's
personal-memory files (`CLAUDE.md` / `CLAUDE.local.md` / `AGENTS.md`,
psu-isolation P-002/D-001), so transcripts don't collide on the shared tree and
the user's personal memory never leaks into the psu prompt, while
the user-level `papercusp-su` MCP, the lock/coord hooks, plugins, and
onboarding/trust still carry through. Resume re-points `CLAUDE_CONFIG_DIR`
to that same dir. (Materialize is best-effort — a failure falls back to the
shared `~/.claude`, exactly as before.) This is why the "survives a raw
launch" framing is more nuanced for *transcripts*: the MCP + hooks survive
because they're user-level, but the transcript lives in the isolated dir.
:::

## Resuming

```bash
psu --resume            # picker: list recent tracked sessions, resume one
psu --resume=<id>       # or: psu --resume <id>  (direct, skip the picker)
```

`psu --resume` reads your recent tracked sessions. A same-backend selection
`cd`s to the recorded cwd and execs the **raw** CLI's native resume command:

* `claude --resume <native-uuid>` — every modern psu claude launch forces +
  records a native session id (`adv_sessions.session_id`), so resume
  re-attaches that **exact** conversation. `claude --continue` (most-recent
  in the cwd) is only the **fallback** for pre-native-id rows with no
  recorded id. Resume also re-points `CLAUDE_CONFIG_DIR` to the session's
  isolated config dir (see the [claude config-dir note](#codex-a-per-session-codex_home-hooks-and-diagnostics)).
* `omp -r <thread>` / `-c`, re-adding `-e <coord>` (loaded per-invocation)
* `codex … resume --last` with `CODEX_HOME` set to that session's home
  (derived from its id — the home still holds the session history)

A fresh `PAPERCUSP_SID` is minted for the resumed process. MCP + claude lock
hooks are user-level, so they survive the raw resume. You can also resume
directly (`claude --resume <uuid>` from the launch dir) or from the `/adv`
Sessions tab, which knows the cwd.

### Switching backends: a session port

A tracked Claude session can instead continue as a fresh Codex or OMP session:

```bash
psu --resume=<tracked-adv-id> --agent=codex --no-picker --yes
psu --resume=<tracked-adv-id> --agent=omp   --no-picker --yes
```

In the interactive picker, selecting a model from another backend triggers the
same flow. This is a **port**, not a native resume: Claude, Codex, and OMP have
mutually incompatible transcript stores. `psu` snapshots the Claude source,
normalizes it into the versioned session-port contract, previews the exact
fidelity and egress target, and asks for confirmation before it creates anything.
It then creates a new target session and delivers a managed seed after the native
CLI reaches its prompt.

* A source that fits is carried in full. An oversized source becomes a
  deterministic **summary + recent verbatim tail**; the target model's real
  context budget includes the engineer prompt, managed seed framing, kickoff,
  and `--launch-context` file.
* Tool-result pairs and text attachments are normalized; unsupported binary
  attachments are represented by content-free omission markers. Prompt/terminal
  control sequences and secret-shaped values are neutralized before rendering.
* The carried history is inert conversation context. It does **not** import the
  source session's AUTO/DRAIN state, fleet role, claims, locks, or authority.
* The port becomes `delivered` only after the target CLI has durably written the
  seed to its own native transcript. Only then is the one-use seed deleted. A
  failed or interrupted delivery is retryable by the same idempotency key.
* The source session is never mutated. Ported targets appear in the resume picker
  as `ported from #<source-id>` and subsequently resume through their backend's
  normal native path.

Protocol V1 intentionally supports **tracked plain Claude sources only** and
targets Codex or OMP. Raw/untracked sessions remain same-backend. `--fork` is a
native same-backend operation and is rejected with a port. Scripted OMP ports
must pass `--agent=omp`; a bare non-UUID resume id still means an OMP thread.
Launcher and operator protocol/transform versions must match, and migration 611
must be applied; skew fails loudly with upgrade instructions rather than falling
back to a context-less target.

### Resuming a session psu didn't start

`psu --resume=<id>` also resumes a **raw** session (one you started with plain
`claude`/`codex`/`omp`, not tracked in `/adv`). It doesn't crawl the disk — when
the id isn't a tracked session it searches each agent's **own** session store
(`~/.claude/projects/*/<id>.jsonl`, `~/.codex/sessions/**/rollout-*-<id>.jsonl`)
for that exact id, reads the **cwd recorded in the session file**, `cd`s there,
and resumes by id (`claude --resume <id>` / `codex resume <uuid>`). A non-UUID
id is treated as an omp thread name (resumed in the current dir). So you never
have to remember where you launched it — the store is the index and the file
records its own cwd.

:::caution\[Untracked sessions resume *vanilla*]
A session psu didn't start has **no engineer playbook loaded** (and for codex,
no `papercusp-su` tools — it ran under `~/.codex`). So `psu --resume` of an
untracked session prints a warning and asks **"Do you want to proceed anyway?"**
before continuing it as-is. Pass `--yes` to skip the prompt in scripts;
non-interactive (`--no-picker`) without `--yes` refuses rather than guess.
:::

## Role sessions — `psu --role`

By default `psu` launches an **engineer-collaborator (`su`)** session.
With `--role` you launch **as a pipeline role** (worker, validator,
reviewer, debugger, documenter, architect, scoper, …) — the same persona,
tools, and feature context the orchestrator gives that role, but **you**
drive it interactively.

```bash
psu --role=worker                                                     # picker
psu --role=worker --feature=F-042 --harness=papercup --agent=claude   # scripted
```

What's different from a plain `su` session:

* **Role prompt** — `<role>.persona.md` + `<role>.tools.md`, assembled by
  the same `assembleRolePrompt` the orchestrator + in-app brains use
  (`buildLaunchSpec({ kind: 'role' })`).
* **Role-scoped tools** — a *signed, role-scoped* MCP URL (`role=<role>`,
  **not** `?superuser=1`), so dispatch enforces exactly that role's
  allowlist — true parity with an orchestrator-spawned agent.
* **Feature context** — feature-consuming roles prompt for a feature; the
  picker knows which roles need one from `roleConsumes`.

All three backends work for role sessions (codex via a per-session
role-scoped `CODEX_HOME`). This is distinct from the orchestrator firing a
role **autonomously** (headless, scheduled) — that always routes through
`orchestrator.spawn`, never a terminal `psu`.

## Install

```bash
bash apps/operator/scripts/install-standalone-mcp.sh
```

This mints the superuser token, registers `papercusp-su` in each client's
**user-level** MCP config (`~/.omp/agent/mcp.json` + `~/.claude.json`),
installs the **claude user-level lock hooks**, writes the source playbooks

* the coordination extension, and installs `psu` (a shim that execs the
  in-repo launcher so it resolves `@inquirer/prompts` from the operator's
  `node_modules`). It does **not** install any `*-su` wrappers. Re-run to
  refresh; to revoke, delete the files the installer prints.

It also installs two more things to `~/.local/bin`:

* **`ptool`** — a `defineTool` CLI: pick a service → an endpoint → it
  prompts for each argument (from the tool's `inputSchema`) and calls it
  over the **same** superuser MCP surface psu uses. For scripting, prefer
  `ptool <group:verb> --json - <<'JSON'` with stdin or
  `ptool <group:verb> --json-file payload.json`; use `--json '<args>'` only
  for quote-free inline payloads. `loop:checkpoint` checks/walls often contain
  shell quotes, so stdin/file JSON avoids caller-shell corruption.
* **OMP-native memory disabled** — the installer runs
  `omp config set memory.backend off`. OMP's config is **global**, so this
  affects **every** omp invocation (plain `omp` too, not only psu sessions):
  omp injects no native-memory instructions and never auto-recalls/retains,
  so the hybrid `memory:*` MCP tools are the one memory path. (Earlier
  versions of the script *enabled* the Hindsight backend; that's been
  removed — `memory.backend off` is the current behavior.)

## How tracking flows

```
psu ──pick──▶ bootstrap-su ──buildLaunchSpec(su)──▶ prompt file + (codex) CODEX_HOME
  │                │                                      + adv_sessions row (agent, plan|null)
  │                └──records──▶ /adv Sessions (live, ~3s refresh) under plan / "No plan"
  └──exec──▶ RAW claude | omp | codex   (playbook + user-level/per-session MCP + flags + SID)
```

Every engineer session now goes through `psu`, so every one is tracked in
`/adv` — there's no longer an untracked direct-wrapper path.

### psu supervises the live session

Interactive launches run the agent through a **managed pty** host
(default-on; escape hatches `PAPERCUSP_PSU_PTY=0` or
`PAPERCUSP_PSU_NO_PTY=1` fall back to plain inherited stdio). In both paths
`psu` stays alive as the agent's parent, which lets it supervise the
session two ways:

* **Heartbeat** — a \~60s supervisor beat to `bootstrap-su/heartbeat` keeps
  the session's `coord_presence` row warm even through long, tool-call-free
  turns. The beat is unref'd (never holds psu open on its own) and
  fail-soft (a down operator means missed beats, never terminal spam).
* **End-of-session stamp** — on child exit `psu` stamps the tracked adv
  row's `ended_at`/`exit_code` (`bootstrap-su/session-ended`), so the resume
  picker + roster stop showing the dead session as active. Best-effort: a
  failure is swallowed rather than holding your terminal open.
