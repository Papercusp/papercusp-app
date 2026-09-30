# SU-agent hooks — cross-CLI (Claude / Codex / OMP)

The cooperative `locks:*` + `coord:*` + `activity:*` MCP surfaces are
**universal** across the host CLIs; where the host emits tool-call hooks, those
hooks make the surfaces **enforced / automatic**. There are two hook families,
attached three ways:

| Family       | Lives in | Claude | Codex | OMP |
|--------------|----------|--------|-------|-----|
| Shell hooks  | `cc/`    | ✅ user `~/.claude/settings.json` | ✅ per-session `$CODEX_HOME/hooks.json` | — |
| In-process   | `omp/`   | — | — | ✅ `coord-hook.ts`, loaded via `-e` |

> **This README used to say "OMP-only; Claude/Codex/Gemini were dropped."
> That is wrong and was corrected** (papercusp-worker-integration-2026-06-04,
> D-009). The `cc/` shell scripts are **shared by Claude AND Codex** — both
> speak the same Pre/PostToolUse JSON-on-stdin → `hookSpecificOutput` wire
> contract, so one script pair serves both. Only the **attachment** differs
> per CLI (settings.json vs `$CODEX_HOME/hooks.json` vs OMP `-e`). Gemini is
> not a supported host CLI.

## `cc/` — the shared Claude+Codex shell hooks

JSON on stdin (`tool_name` / `tool_input` / `tool_use_id` / `session_id` /
`cwd`; the `apply_patch` / `Edit` / `Write` matcher aliases cover both CLIs'
edit tools), a `hookSpecificOutput` decision on stdout. All are **fail-open**
(a blip never blocks a tool) and **psu-scoped** (no-op unless `PAPERCUSP_SID`
+ the su-token are present).

| Script                                | Event        | Purpose |
|---------------------------------------|--------------|---------|
| `pretooluse-locks-acquire.sh`         | PreToolUse   | Acquire a file lock before an edit; block on busy (file-locking #2). |
| `posttooluse-locks-release.sh`        | PostToolUse  | Release the lock for that `tool_use_id`. |
| `posttooluse-activity-report.sh`      | PostToolUse  | **Activity bridge** — mirror every native tool call into `harness_shared.agent_activity` → the pui fleet view + curator (papercusp-worker-integration-2026-06-04). ALSO folds in NEW `coord:inbox` messages mid-turn on the same round trip, delta-aware via a `hook_bundle` cursor (EI-11405 — the separate `posttooluse-coord-inbox.sh` this used to pair with is retired). Synchronous by default (`PAPERCUSP_COORD_FOLD=1`); `PAPERCUSP_COORD_FOLD=0` (Codex ROLE sessions only, no coordSid) reverts to the original detached, zero-added-latency, no-fold report path. |
| `pretooluse-bash-resource-gate.sh`    | PreToolUse   | Refuse a destructive Bash command that collides with an EXCLUSIVE hold on a registered named resource. Also the native-scheduler lockout, the shared-tree git guard, heavy-command admission, and (Claude `Bash` only) the **long-foreground-exec soft advisory** — foreground `timeout > 120s` gets `additionalContext` nudging `run_in_background` (coord-delivery P-003; never a deny, never for codex shells). |
| `userpromptsubmit-provenance.sh`      | UserPromptSubmit | **Turn provenance** (turn-provenance-owner-vs-agent-2026-07-11): classify every submitted prompt against the injectors' `⟦turn-origin:… nonce:…⟧` envelope + short-TTL JSONL ledger (`~/.papercusp/turn-provenance/`) → `additionalContext` stamp: VERIFIED agent-origin / UNVERIFIED origin claim / affirmative OWNER (interactive). The LEDGER decides, never the text (D-002). Local-file-only hot path, fail-open, never blocks a prompt. **Claude-only** — codex has no prompt-submit event (Layer-1 envelope only there); lockstep mirror of `packages/operator-core/lib/turn-provenance/turn-provenance.ts`. |

**Codex env caveat (D-006):** Codex hands hooks a **minimal env**, so the Codex
`hooks.json` **bakes** `PAPERCUSP_LOCK_SID`/`PAPERCUSP_SID` (+
`PAPERCUSP_AGENT=codex`) into the
command; Claude reads them from the inherited session env, so its
`settings.json` entry is just the script path. Current Codex supports
PreToolUse/PostToolUse matchers for `Bash`, `apply_patch` (plus `Edit`/`Write`
aliases), and MCP tools; missing hook scripts still degrade fail-open, so
diagnostics tell agents when explicit `locks:*` calls are required.

The edit hook coordinates canonical-tree files and managed suite-app checkouts
(`~/.papercusp-workspaces/<workspace>/.papercusp/apps/<app>`) by repo-relative
path plus physical repository domain. Hidden home configuration (`~/.config`,
`~/.papercusp`, `~/.codex`, etc.) uses the reserved `@external/home/*` keyspace;
files under the current user's `XDG_RUNTIME_DIR` use
`@external/runtime/*` (for example, Playwright storage state under
`/run/user/1000`). Explicit callers acquire either namespace with
`locks:acquire { external_paths:["/absolute/path"] }`. Other repositories,
`/tmp`, and other users' runtime directories remain outside Papercusp
coordination. `/api/su-locks/hook-health` exposes the last automatic decision
(owner, tool, logical paths, lock id) as well as success/error health, so
enforcement is inspectable instead of inferred.

Installed to `~/.papercusp/hooks/cc/` by `install-standalone-mcp.sh`, which
also merges the Claude `settings.json` entries. The Codex entries are written
per-session by `role-codex-home.ts` (`writeCodexLockHooks`) into each
`$CODEX_HOME/hooks.json` (codex reads `hooks.json`, **not** `settings.json`).

## `omp/` — the OMP in-process port

`omp/coord-hook.ts` is the OMP extension owning the same surface in-process
(per agent-coordination-architecture-v2 §12.1). One module, five handlers:

| Event           | Purpose                                                          |
|-----------------|-----------------------------------------------------------------|
| `session_start` | Probe operator (attached / detached), declare presence          |
| `turn_start`    | Inject the held-locks / inbox / changed-plans reminder          |
| `turn_end`      | Persist watermark pointers                                      |
| `tool_call`     | Acquire file lock (block on busy) **+ report activity** (`activity:report`, the OMP leg of the bridge — reports at tool_call because the OMP `tool_result` event carries no input) |
| `tool_result`   | Release the acquired lock by `toolCallId`; poll the inbox delta |

`install-standalone-mcp.sh` installs it to `~/.papercusp/papercusp-coord.ts`
(it was moved out of `~/.omp/agent/extensions/` so it no longer auto-loads on
**every** `omp`); `psu` loads it via `-e` for both **su** and **role** omp
launches. The `tool_call` handler is **fail-open**: if the operator is
unreachable the edit is allowed (cooperative discipline only works when the
system is up). See `recordHookError` / file-locking #3 for the persistent
marker the operator UI reads to surface "enforcement is offline."

## Adding a new host CLI

Port `omp/coord-hook.ts` to its hook API (or, if it speaks the Claude
Pre/PostToolUse wire contract, reuse `cc/` + add an attachment path). The MCP
call shapes are identical; only the event-subscription wiring + the
attachment differ.
