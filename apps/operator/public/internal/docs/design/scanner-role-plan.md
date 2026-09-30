# Scanner role + persistent session + scan history (RETIRED)
URL: /internal/docs/design/scanner-role-plan

Historical design — the bespoke scanner + operator-card stream were dissolved into the scheduled `scan` launch blueprint (unify-agent-launches D-005, 2026-06-05).

:::caution\[Retired 2026-06-05]
The system this page designs — the persistent `operator_scanner_session`,
scan history (`operator_scans`), the operator-card recommendation stream,
and the panel Deck — was **dissolved** by
`unify-agent-launches-as-blueprints-2026-06-04` D-005 (the scanner reframe;
D-009 records the botched-then-reverted first teardown attempt, after which it
was completed under owner sign-off — the table drop landed in migration 167).
Proactive scanning now runs as the scheduled **`scan`
launch blueprint** (`blueprints/scan/`); the scanner persona survives as that
blueprint's role, and findings land as tracked **work\_items in the
self-improvement backlog** (`improvements:capture` with `kind` `bug` / `change`
/ `feature`) — one triage surface, no separate card feed.

The replacement implementation: `seed-scan-routine.ts` seeds an **INACTIVE**
4-hourly cron routine (`0 0 */4 * * *`) that fires the generic
`system:blueprint-run` action with `{ blueprintId: 'scan', mode: 'run',
timeoutMs: 900_000 }`; enable it with `--active`.

Migration 167 drops all **six** scanner-owned tables —
`operator_scans`, `operator_dismissed_cards`, `operator_scan_locks`,
`operator_last_scan`, `operator_idle_snapshot`, and
`operator_scanner_session` — while `harness_shared.operator_paused`
intentionally survives (the pause/resume papercup lives on in
`device-operator-actions.ts`). This page is kept as design history only.
:::

## Goals

1. Make the operator scanner a real **role** under the harness role
   taxonomy — discoverable, with a dedicated role prompt alongside the
   other harness role files (e.g. `architect.md` / `scoper.md`).
   *(Design-history note: the proposed flat `harness/prompts/` directory
   was never created. As-shipped, harness role prompts live under
   `harness/identity/` and `harness/blueprints/base/prompts/`, and the
   `scan` blueprint's scanner persona at
   `harness/blueprints/scan/prompts/scanner.md` — see the caution box.)*
2. Each scan **resumes** the workspace's persistent Claude session
   (resume via `claude --resume <uuid>` or `omp -r <prefix>` per backend) so the model has continuity between scans.
3. Each scan turn includes a **current-state bootstrap** message
   (panel snapshot, recent decisions, recent dismissals) so the
   model can't drift on stale context.
4. Persist every scan result (summary + emitted cards + cost) to a
   new PG table, surface it in a **Scan History** tab in the operator
   panel main section alongside Timeline / Delegates.

## Non-goals

* Per-harness scanner sessions (keep per-workspace).
* Streaming the bootstrap content to the user — the bootstrap is
  invisible context for the model only.
* Migrating decisions/audit logs (those stay where they are).

## Order of work (low-risk → higher-risk)

### Phase 1 — Scanner prompt as a role file

*Cosmetic refactor, zero behavior change.*

* Extract the system-prompt portion of `buildOperatorPrompt()` from
  `lib/operator-prompt.ts` into a dedicated scanner role prompt file.
  *(As shipped, the scanner persona lives at
  `libs/papercusp/packages/harness/blueprints/scan/prompts/scanner.md`,
  not the proposed flat `harness/prompts/` path.)*
* `buildOperatorPrompt()` now reads that file and stitches in the
  per-call dynamic context (preferences, last decisions). The static
  portion lives in the role prompt.
* Keep an inline fallback if the file is missing (the operator should
  still scan even on a botched checkout).

### Phase 2 — Persistent scan history (no scan-flow change yet)

*New table + write-on-complete + read-only history tab.*

* New PG table `harness_shared.operator_scans`:
  * `id bigserial primary key`
  * `workspace_id text`
  * `started_at timestamptz`
  * `ended_at timestamptz`
  * `claude_session_id text` *(populated in Phase 3)*
  * `summary text` — one-paragraph synopsis of what the scan found
  * `suggestions jsonb` — the cards emitted on this scan
  * `cost_usd numeric(10,4)`
  * `error text` *(when scan errored, store the message here)*
* Scan SSE handler: on `done`, write a row. On `error`, write a row
  with `error` set.
* New API: `GET /api/agent-mcp/operator-scans?limit=20` returning
  recent rows for the active workspace.
* New UI: **Scan History** tab in OperatorPanel main section, sibling
  of Timeline + Delegates.
  * List shows: timestamp + summary preview + suggestion count.
  * Click expands to show full summary + each emitted card + cost.

### Phase 3 — Persistent Claude session + state bootstrap

*Scan flow change. Riskier.*

* Add `claude_session_id text` column to scanner-session tracking
  (either reuse `harness_shared.delegates` semantics or a new
  `harness_shared.operator_scanner_sessions` table — leaning toward
  the latter for clarity since scanner sessions are per-workspace not
  per-conversation).
* Scan handler resolves/creates the workspace's scanner session id;
  passes to `runClaudeChat` with `claudeSessionMode: 'force'` so the
  CLI does `--session-id <uuid>` (create-or-resume).
* Before each scan turn, build a **state bootstrap**:
  * Current visible panel cards (id, title, tier, status)
  * Recent decisions (last 20: dispatched/dismissed/superseded)
  * Last scan's summary (so the model knows what it said before)
* Bootstrap goes in as the first user message of the turn; the
  model's persistent system prompt remains the scanner.md content.

### Phase 4 — Wire the persisted Claude session id back to history

* The row written in Phase 2 picks up the `claude_session_id` from
  Phase 3 so a user in the History tab can click "resume" on any past
  scan to ask follow-ups about that specific scan turn (same
  `delegate_to_claude` resume pattern).

## Risk register

| Risk                                               | Mitigation                                                                                                                                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scanner session drifts / hallucinates past state   | State bootstrap on every turn (Phase 3).                                                                                                                                              |
| Long session = high latency + cost on each scan    | Phase 3 only — start with persistence (Phase 2). User can decide if continuity is worth the cost.                                                                                     |
| Existing operator-scan flow breaks during refactor | Phases 1+2 don't change scan behavior. Phase 3 is opt-in via a feature flag (`OPERATOR_SCANNER_RESUME=1`) until it stabilizes.                                                        |
| Migration vs. plugin role registry overlap         | Scanner is a *built-in* role (lives in the harness package), not a plugin-contributed role. The two systems coexist; the role-registry's `RoleManifest` shape doesn't need extending. |

## What changes for the user

* **Today**: every "Operator scan" is a fresh Claude call with no
  memory of prior scans. The panel shows only the latest result.
* **After Phase 2**: panel gains a Scan History tab; user can browse
  past scans and re-read their summaries + cards. No change to scan
  speed or quality.
* **After Phase 3**: each scan can refer to prior ones ("since the
  last scan, two more features failed schema check"). Slower per scan
  (\~2-4× cost depending on session age).
