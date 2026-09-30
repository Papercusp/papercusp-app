# The wake-resume 5-bug chain: 'delivered:resume' recorded as success while the agent never ran (Stage-A/B, 2026-06-07)
URL: /internal/docs/agent-insights/wake-resume-five-bug-chain-2026-06-07

Bringing up the first tracked-hive (Queen) wake-resume path surfaced FIVE distinct, independently-silent bugs, each of which alone made event_wake_deliveries.status='delivered' a lie — the row said the agent resumed, the agent never produced a turn. All five are fixed and live in packages/operator-core/lib/events/await/wake-executor.ts + libs/papercusp/packages/orchestrator/src/session-launch-dirs.ts + interactive-claude-config.ts. This is the consolidated runbook for the next person debugging 'delivered:resume but the agent is silent'.

## The mistake this prevents

> "The delivery row says `delivered:resume` — why is the agent silent?"

That question has (at least) five independently-silent root causes, all found bringing up
the first tracked-hive (Queen) wake-resume path on 2026-06-07 (Stage-A/B). Each one alone is
enough to make `event_wake_deliveries.status='delivered'` a **lie**: the row records that a
resume was dispatched, but the resumed process either never started, started with no tools,
or started and then sat idle forever. Don't chase these one at a time from a fresh cold
start — check the whole ladder below in order.

All five are **fixed and live** as of this writing (verified against
`packages/operator-core/lib/events/await/wake-executor.ts`,
`libs/papercusp/packages/orchestrator/src/session-launch-dirs.ts`, and
`packages/operator-core/lib/interactive-claude-config.ts` — see the anchors under each bug).
Proof of fix: the first autonomous Queen (`s-1780806524346-675ca243`, `brood-box-alpha`) woke
via delivery 20, claimed WI-83, surveyed the fleet, placed case 1/4 onto a bee via free-slot,
reported, re-armed her watch, and IDLE'd — a complete unattended placement turn.

## The ladder — five bugs, in the order a resume hits them

### 1. Transcript not persisted — `claude --resume <sid>` finds no session file

A tracked spawn's `CLAUDE_CONFIG_DIR` (the dir holding claude's own `projects/**` transcript
`.jsonl`) was being deleted (`rmSync`) when the spawn's process closed. So by the time a wake
tried to resume that session, the transcript claude needs to resume from was already gone —
`claude --resume <sid>` had nothing to resume.

**Fix:** a **persistent** per-session config dir, keyed by the session's coord-owner id, that
survives the spawn's process exit. `sessionClaudeConfigDir(ownerId)` /
`sessionClaudeRoot()` (`libs/papercusp/packages/orchestrator/src/session-launch-dirs.ts`) is
the single source of truth for the path (`~/.papercusp/session-claude/<ownerId>`, override via
`PAPERCUSP_SESSION_CLAUDE_DIR`); `writeSpawnClaudeConfig(persistentDir)`
(`libs/papercusp/packages/orchestrator/src/spawn-mcp.ts`) provisions it for a tracked launch. A
non-tracked spawn instead gets a flight-recorder copy. The launch leg and the wake-executor
resume leg both compute the dir through this same helper — never a second string literal — so
they can't drift apart (see the module header of `session-launch-dirs.ts`: this convergence was
itself the fix for the related EI-153 cross-agent conversation-store bleed).

Related, found later repairing the SAME dir for a different symptom (the interactive
psu-resume-relogin bug, EI-12938, 2026-07-16): a persistent dir built by
`writeSpawnClaudeConfig` is deliberately **minimal** (just the `.credentials.json` symlink) —
correct for a headless `-p` worker, but not launch-ready for a human resume, which needs the
fuller `writeInteractiveClaudeConfig` mirror instead. See
`interactive-claude-config.ts`'s `isInteractiveClaudeConfigReady` / `ensureInteractiveClaudeConfig`
if you're chasing a *different* class of resume dir bug — logging in / a tool-less session —
rather than this one (a missing transcript).

### 2. MCP not remounted — the woken agent has zero tools

The original spawn loads its **signed** MCP config via `claude --mcp-config <path> --strict-mcp-config`. A bare `claude --resume <sid>` does not re-pass that flag, so the
resumed agent boots with claude's default (unsigned / absent) MCP set — in practice, zero
tools. The delivery still says `delivered`; the woken agent just can't do anything.

**Fix:** `resumeCommandFor` (`wake-executor.ts`) remounts the same signed config on resume:
when the delivery carries a `coordOwnerId`, it resolves `sessionMcpJsonPath(coordOwnerId)`
and, if that file exists, appends `--mcp-config <path> --strict-mcp-config` to the resume
args — mirroring exactly what the original spawn used.

### 3. MCP handshake timeout under load — claude marks the server offline for the whole session

Under fleet load (\~200 concurrent), the operator's event loop can stall long enough that
claude's *default* MCP connect timeout fires during the handshake. Once that happens, claude
marks the MCP server offline **for the entire resumed session** — no retry, no recovery — so
a woken Queen has a transcript and a remounted config but still no working tools (Stage-A
finding, load \~200).

**Fix:** the resume env sets `MCP_TIMEOUT: process.env.PAPERCUSP_WAKE_MCP_TIMEOUT_MS ||
'120000'` (`wake-executor.ts`, in the resume `env` block) — 120s of handshake headroom instead
of claude's default, overridable via `PAPERCUSP_WAKE_MCP_TIMEOUT_MS`.

### 4. Interactive (no `-p`) — the resumed turn never runs headlessly

`resumeCommandFor` originally launched `claude --resume <sid>` **without** `-p` — i.e. the
interactive TUI. A wake IS meant to be one headless turn (run to completion, exit, leave the
session file updated for the next wake); without `-p` the process instead boots an interactive
UI and waits for a human.

**Fix:** the resume args always include `-p` (`wake-executor.ts` `resumeCommandFor`, the
`claude` branch) — see the inline comment there, which documents this exact finding
("every 'delivered:resume' produced silence — Stage-B, 2026-06-07").

### 5. PTY stdin makes `-p` hang — the killer, and the least obvious

Even **with** `-p`, if the resumed process is spawned attached to a managed pty, claude sees a
TTY on stdin — and `-p` with a TTY stdin **waits for interactive input** instead of consuming
the positional prompt and exiting. The process sits alive for 2+ minutes, produces no turn,
and eventually gets reaped — but nothing about that looks like a spawn failure, so it's the
hardest of the five to diagnose from the outside (delivery says `delivered`; the process is
genuinely running; it just never does anything).

**Fix:** a headless resume must spawn **detached**, non-pty: `detached: true, stdio: 'ignore'`
(`wake-executor.ts`, the default resume spawn — see the `stdio: onExit ? [...] : 'ignore'`
branch). The pty path (`promptViaPty: true`) is kept **only** for the omp/interactive injection
case (`promptViaPty` in `resumeCommandFor`'s omp branch, gated by
`PAPERCUSP_OMP_RESUME_VIA_PTY`), never for a headless claude/codex resume.

## Diagnosing a NEW "delivered:resume but silent" report

Work the ladder in order — each bug is silent in a slightly different way, so the symptom
alone under-determines which one you're looking at:

1. **No session file at all** (`claude --resume` errors "session not found") → bug #1 class
   (check `sessionClaudeConfigDir` / archive-restore — see also the 2026-07-10
   rematerialize-on-miss addendum below, a *different* fix for the same symptom).
2. **Session resumes, agent has no tools** (coord/MCP tool calls 404 or are simply absent) →
   bug #2 (config not remounted) or #3 (MCP handshake timed out under load — check for the
   `PAPERCUSP_WAKE_MCP_TIMEOUT_MS` env and whether the operator was under load at wake time).
3. **Process never produces a turn but exits quickly / immediately** → bug #4 (missing `-p`)
   — check the actual resume args recorded for the delivery, not just that a PID was assigned.
4. **Process alive for 2+ minutes then dies with nothing produced** → bug #5 (pty stdin) — the
   classic "spawned but never ran" case; confirm `stdio` on the spawn, not just `detached`.

**Do not trust `delivered` alone as evidence the agent ran.** All five bugs here made
`delivered` true while the agent produced nothing — a separate, later, related defect
(the loop rate-limit robustness gap — see
\[\[loop-wake-turn-deaths-recorded-as-delivered]]) is the general form of this: *delivered
means spawned, not survived*, and a spawn can additionally fail to produce a turn for any of
the five reasons above even when it does survive.

## Related, since this incident (not part of the original 5-bug chain)

* **EI-97** — pty `HeadlessTerminal` first-attempt flake (a distinct pty-injection issue, not
  the resume-headless path this doc covers).
* **The dual-host pump race** — two operators polling the same delivery queue; whichever has
  stale code can grab and mis-run a delivery. Orthogonal to the five bugs above (this is a
  claim/ownership race, not a resume-mechanics bug).
* **The deploy-vs-git-sync race** — an escape-hatch deploy archived a sha before git-sync
  committed the working-tree fix, so a "fixed" resume path could still ship pre-fix code to
  `:3070`. Verify the fix is actually **deployed** (`dev:pipeline_position`), not just
  committed, before closing a report that looks like a regression of one of these five bugs.
* **2026-07-10 — rematerialize-on-miss for archived session files.** A *different* fix for a
  symptom that looks like bug #1 (`session not found` on resume): once ended-session local
  files started being deleted after archiving to PG (`session-db-archive-retire-dirs-2026-07-10`),
  `executeWake` gained a check, immediately before building the resume command, for whether the
  target session's local files are still on disk — and if not, `rematerializeSession(...)` pulls
  them back byte-exactly from the PG archive first. This does not touch when a delivery is
  marked `delivered` and is orthogonal to the five bugs above, but produces a similar-looking
  "session not found" symptom from a different cause (archived-and-deleted vs. never-persisted)
  — don't assume every `session not found` is bug #1.
* **2026-06-23 — the general "delivered ≠ survived" robustness gap for LOOP wakes.** The five
  bugs on this page are all about the resume mechanics themselves silently failing to produce a
  turn. A separate, later-found gap is that even a *mechanically correct* resume can still 429
  mid-turn and die — and for loop-sourced wakes specifically, that death wasn't fed to the
  autoloop circuit or observed at all. See
  \[\[loop-wake-turn-deaths-recorded-as-delivered]] for that full analysis + remediation roadmap
  (now landed) — it assumes this page's five bugs are already fixed and analyzes what's left.
