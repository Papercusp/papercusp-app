# Session-level behavior lives in agent_activity, NOT tool_invocations — spawn_id can't group sessions
URL: /internal/docs/agent-insights/fleet-ekg-session-substrate

harness_shared.tool_invocations.spawn_id is per-call or per-surface (palette, dev-page, one-shot UUIDs) for ~99% of rows, so grouping it never reconstructs an agent session; the per-CLI activity bridge (harness_shared.agent_activity, keyed owner_id+session_id) is the real session stream — native AND mcp__* calls, ~100–300 sessions/day since 2026-06-04.

## The trap

`harness_shared.tool_invocations` looks like the obvious substrate for
per-session behavioral analysis — every dispatched tool call lands there, and
its `spawn_id` column is documented as the session/spawn identity. It is not
usable that way. Measured over 30 days (2026-06-12):

* **1.41M of 1.41M+ distinct spawn\_ids had exactly ONE call** — one-shot UUIDs
  minted per request.
* The few "busy" spawn\_ids are **fixed surface labels, not sessions**:
  `palette` (183k calls), `''`, `event-reaction`, `dev-page`.
* `role` is `operator` for \~99% of traffic — the desktop UI's dispatch, not
  agents.

Group by `spawn_id` and you get either singletons or a single years-long
"session" named `palette`. Per-call analyses (the negative-space miner's
zero-hit search mining, `dev:telemetry` rollups) are fine; session
reconstruction is impossible.

## The substrate that works

`harness_shared.agent_activity` (migration 143 — the cross-CLI activity
bridge) is the real per-session stream: one row per tool call from every
worker CLI (Claude Code / Codex / OMP), **native tools (Bash, Edit, Read…) and
`mcp__*` dispatches alike**, keyed by `(owner_id, session_id)` with `agent`,
`tool_name`, `phase` (`pre`/`post`), `status` (`ok`/`error`/null), `detail`,
`created_at`.

* Use `kind = 'tool' AND phase = 'post'` for completed calls.
* Scope `workspace_id IN (<ws>, '*')` — unscoped SU sessions (most real
  traffic) land in the `'*'` bucket.
* Volume: \~100–300 sessions/day, \~10–25k events/day; populated **since
  2026-06-04** (the bridge's landing) — a "last 30 days" ask older than that
  has no data, by construction.
* `status` is null for \~14% of post rows — exclude nulls from error-rate
  denominators.

`lib/fleet-ekg/scan.ts#readSessionEvents` is the canonical reader
(grouping + scoping done); `lib/fleet-ekg/features.ts` turns a session's rows
into a named behavioral vector.

## Rule

Per-CALL questions (which tool, how often, error classes) → `tool_invocations`.
Per-SESSION questions (behavior, pacing, rhythm, anything grouped by agent
session) → `agent_activity`. Don't trust `spawn_id` as a session key without
checking the calls-per-spawn histogram first.
