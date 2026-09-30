# SU agent file-lock coordination — phase status

## Shipped (Phase 0 + Phase 1 + Phase 2 + Phase 3, 2026-05-14)

### Foundation (Phase 0)
- ✅ Side database `papercusp_su` bootstrapped lazily on first call.
- ✅ Migration runner with `LOCK TABLE su_meta IN SHARE UPDATE EXCLUSIVE`
  to serialize concurrent runners (audit 3 #6).
- ✅ Schema: `agent_file_locks`, `agent_lock_waiters`, `waiter_status` enum.
- ✅ `pgcrypto` + `btree_gin` extensions.
- ✅ Path validation trigger (belt-and-suspenders with app-side check).
- ✅ Multicolumn GIN index `(workspace_id, paths)` on waiters (audit 4 #2).
- ✅ Aggressive per-table autovacuum (5% bloat threshold) for the
  high-churn lock tables (audit 3 #9).
- ✅ Connection pools: txPool (size 10) + listenerPool (size 20, used
  in Phase 2).
- ✅ `inWorkspaceTxn` wrapper with `pg_advisory_xact_lock(101, …)` —
  namespaced two-arg form (reviewer #2). Sets `application_name`,
  `lock_timeout=5s`, `statement_timeout=5s`.

### Core verbs (Phase 1)
- ✅ `locks:acquire` — atomic multi-path with short-circuit success
  path (audit 4 #1), plus the shipped blocking `wait` and
  `wake_on_grant` paths described below.
- ✅ `locks:release` — DELETE + `SELECT grant_cascade(...)` in the same
  transaction.
- ✅ `locks:heartbeat` — `extended:false` when lock already stolen.
- ✅ `locks:cancel_wait` — owner-check prevents cross-agent cancel of a
  queued `locks:acquire` waiter.
- ✅ `locks:queue` — read-only (no advisory lock), `ROW_NUMBER() OVER`
  for `ahead_count` with `(queued_ts, ticket_id)` tiebreaker
  (reviewer #9).
- ✅ `grant_cascade()` PL/pgSQL: pulls held-paths once + in-memory probe
  (audit 3 #1), NOTIFY inside function (reviewer #6), narrow EXCEPTION
  blocks with explicit "intentionally NOT catching WHEN OTHERS"
  comment (reviewer #7).
- ✅ File, granular, and named-resource lock tools are registered in
  `agent-tools/index.ts`.
- ✅ Capability tiers added: `locks:read` (low), `locks:write` (medium).

### Identity + install (Phase 0/3 split)
- ✅ Install script mints stable UUID at `~/.papercusp/su-agent-id`
  (reviewer #7) — generate-only-if-missing.
- ✅ UUID baked into MCP URL as `?client=<uuid>`; surfaces in
  `ctx.uiClientId`.
- ✅ `identity.readIdentity()` resolves `ownerId` + `ownerLabel` from
  ctx.

### Wait subsystem (Phase 2)
- ✅ `WorkspaceListener` refcounted shared LISTEN per workspace
  channel `ch_workspace_<wsId>`, simplified to a wake-bus (every
  subscriber gets every payload, filters by own ticket_id).
- ✅ Listener uses postgres-js's built-in `sql.listen()` which
  re-issues LISTEN automatically on reconnect (audit 4 #3 covered
  without explicit re-issue code).
- ✅ Listener-pool cap: 20 active workspaces; 21st throws
  `TooManyActiveWorkspacesError` → `reason: 'too_many_active_workspaces'`
  (reviewer #3).
- ✅ Waiter insert in store: `tryInsertWaiter` with per-owner cap of
  `MAX_WAITERS_PER_OWNER = 10` → `reason: 'waiter_cap_exceeded'`.
- ✅ `readWaiterStatus` + `expireWaiter` helpers.
- ✅ `locks:acquire` wait path: 6-step LISTEN-before-INSERT protocol
  (audit 4 #4 — step 4 cut). 30s ceiling on each await iteration as
  the silent-drop safety net.
- ✅ End-to-end wake-latency measured at **8ms** in the smoke test
  (well under the 200ms target from the audit).

### Smoke tests (verified end-to-end)
- ✅ `scripts/su-locks-smoke.ts` — 8-step happy path: acquire → queue
  → conflict → heartbeat → release → empty queue → path validation.
- ✅ `scripts/su-cancel-smoke.ts` — cancel + cancel-after-cancel race.
- ✅ `scripts/su-locks-wait-smoke.ts` — Phase 2: wait+wake (8ms
  latency), waiter cap (11th wait rejected), wait timeout (expired).
- ✅ Bootstrap re-run is idempotent.

### Enforcement (Phase 3)
- ✅ `pretooluse-locks-acquire.sh` — configured edit-hook integration.
  Filters tool calls to Edit/Write/MultiEdit, resolves repo-relative
  path under `~/papercupai-workspace/papercup/`, calls `locks:acquire`
  via HTTP MCP, caches `lock_id` keyed by `tool_use_id` under
  `~/.papercusp/locks-cache/`, exits 2 + stderr message on busy.
- ✅ `posttooluse-locks-release.sh` — reads cached `lock_id`, calls
  `locks:release`, cleans the cache file. Best-effort; TTL covers
  any missed release.
- ✅ Install script registers both hooks in `~/.claude/settings.json`
  via idempotent merge (per-command dedup; re-runs don't duplicate).
- ✅ `papercusp-su.tools.md` — new "Before editing any file, claim it"
  workflow with 7 numbered options including "show both intents" when
  yielding to user (reviewer #12).
- ✅ `agent-policies.mdx` — new §8 "Coordinate edits across SU
  agents" with reviewer #4's enforcement-gap language; sections 8-20
  renumbered to 9-21.
- ✅ Host context files refreshed (`~/.claude/CLAUDE.md`,
  `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`, `~/.omp/agent/CLAUDE.md`).
- ✅ Hook coverage is client/configuration dependent: configured edit hooks
  acquire and release per-edit file locks; sessions without a hook surface
  remain cooperative and use explicit `locks:acquire` for deliberate
  multi-file holds.

### Hook smoke (verified end-to-end against live :3055)
- ✅ PreToolUse acquires + caches lock_id.
- ✅ Concurrent PreToolUse on same path is refused with exit 2 and a
  stderr message naming the holder.
- ✅ PostToolUse releases + clears cache.
- ✅ Re-acquire after release succeeds.
- ✅ Paths outside the papercup repo no-op (allow the edit).
- ✅ Install-script re-run is idempotent (per-command dedup).

### Vitest unit suite (CI regression coverage)
- ✅ `lib/agent-tools/locks/__tests__/su-lock-store.integration.test.ts` (renamed from `.test.ts`, EI-1551 — it hard-requires PG) — **27
  tests in 365ms**, full coverage of path validation, multi-path
  atomic acquire (success / busy-no-partial-state / stale-steal),
  release + cascade (basic / all_mine / grants-waiter / skips-partial-
  conflict), heartbeat (extends / extended:false on steal), waiter
  cap, expire/cancel (status flips, cross-owner refusal, missing
  ticket), readQueue (sorted with ahead_count), head-waiter
  anti-starvation, migration idempotency.
- Runs via `npx vitest run lib/agent-tools/locks/__tests__`. Picks
  up `papercusp_su` automatically; the test cleans only rows it owns
  via a unique workspace_id prefix so it can run alongside dev
  traffic without colliding.

### Wait progress events (Phase 2 polish)
- ✅ `locks:acquire` wait path emits `ctx.progress` with a structured
  payload `{ phase: 'waiting', ticket_id, elapsed_sec, ahead_count, busy[] }`
  every 10s while queued. Independent of the LISTEN wake mechanism —
  fires regardless of why the await wakes, including the silent-drop
  ceiling. First tick emits immediately on enqueue so the agent sees
  state before the 10s heartbeat fires.
- ✅ Best-effort: ctx.progress wrapped in try/catch so progress
  emission failures never break the wait. Cleared in the `finally`
  block alongside the LISTEN unsubscribe.
- ✅ `scripts/su-locks-progress-smoke.ts` verifies the payload shape
  end-to-end (queues two waiters, asserts `ahead_count=1` for the
  second, validates the `busy[]` snapshot is well-formed).

## Not shipped yet

(Nothing load-bearing remaining. See "What's left" at the bottom for
optional follow-ups.)

### Tests beyond smoke
- ⏳ Unit tests in `su-lock-store.test.ts` (~30 cases per plan §10.1).
- ⏳ Real cross-process concurrency test
  (`concurrent-cross-process.test.ts`, plan §10.2).
- ⏳ LISTEN/NOTIFY wake-latency test (target 200ms with median <10ms
  per reviewer feedback, not 50ms flat).
- ⏳ E2E MCP transport test.
- ⏳ `EXPLAIN ANALYZE` baselines for hot queries (audit 3 #10).

## Known divergences from the v3.3 plan

Documented in `README.md`:

1. **Same `harness_admin` role**, not a new `papercusp_su` role. Embedded
   PG has no external network surface; the grant-isolation benefit
   doesn't justify password-file complexity.
2. **Migrations live with the package at `packages/locks/src/sql/`**
   (moved from `apps/operator/lib/agent-tools/locks/sql/` in the P-010
   extraction), not `libs/papercusp/libs/db/sql/su-locks/`. Self-contained;
   the main DB's migration system targets a different database anyway.
3. **`pg_stat_statements` is optional** (superuser-only on this PG
   install). README documents how to enable it.

## Per-session identity (2026-05-20)

A real-world-test question surfaced a fundamental bug: identity was
**per-machine, not per-session**. `install-standalone-mcp.sh` mints one
`~/.papercusp/su-agent-id` and bakes it into the MCP URL `?client=`, so
two SU shells on one host shared an `owner` and never conflicted — the
coordination system did nothing for its primary use case. Every test
had masked it by fabricating distinct owners.

Fix — two paths:
- **Cooperative path** (`app/api/[transport]/route.ts`): the superuser
  branch now prefers the per-connection `Mcp-Session-Id` header over
  the static `?client=` param. Each MCP client connection (each CLI
  process) gets a distinct session id → distinct owner. Falls back to
  `?client=` when no session header is present.
- **Hook path** (`scripts/hooks/*.sh`): Pre/PostToolUse hooks key the
  owner on Claude Code's per-session `session_id` from the hook
  payload, not the machine `su-agent-id`. Pre and Post in one session
  share `session_id`, so release still matches acquire.

Hook HTTP timeout bumped 5s → 10s (a brief operator hiccup shouldn't
fail-open that fast).

Verified by E2E §12 (3 checks): distinct `Mcp-Session-Id` → distinct
owners; no-session fallback → same owner; hook keys on `session_id`.

## How to verify locally

```bash
# One-time prereq (if not already granted):
sudo -u postgres psql -c "ALTER ROLE harness_admin CREATEDB;"

# Run the smoke tests:
cd apps/operator
npx tsx scripts/su-locks-smoke.ts          # 8-step happy path
npx tsx scripts/su-cancel-smoke.ts         # cancel + race
npx tsx scripts/su-locks-wait-smoke.ts     # Phase 2: wait/wake/cap/timeout
npx tsx scripts/su-locks-progress-smoke.ts # Phase 2 polish: progress payload

# CI vitest suite (43 tests):
npx vitest run lib/agent-tools/locks/__tests__

# Full end-to-end suite (26 checks; needs the operator running):
bash scripts/su-locks-e2e.sh

# Inspect:
psql -d papercusp_su -c "\dt"
psql -d papercusp_su -c "SELECT * FROM agent_file_locks;"
```
