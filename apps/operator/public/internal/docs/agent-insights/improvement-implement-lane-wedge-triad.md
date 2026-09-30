# Implement-lane wedge triad — dateless claims, 280s SIGTERM, untracked launches
URL: /internal/docs/agent-insights/improvement-implement-lane-wedge-triad

Why the armed auto-implement loop resolved only 7/58 dispatches — claimIssue never stamped assigned_at (permanent in-flight), the 280s timeout SIGTERM'd workers mid-fix (exit 143), and the launch-blueprint fallback spawn record violated parent_role NOT NULL (invisible in fleet:tree).

## Symptom

After the implement lane was armed (learning-system-audit-improvements-2026-06-09
P-012 / D-009), the routine dispatched 1 bug every 30 min, but the journal's
`skipped: N in-flight` count **grew monotonically** (26 → 50 over \~30 h) while
only 7/58 dispatches ever resolved. `fleet:tree` showed none of the implement
workers. Three separate defects compound into this picture — fixing any one
alone would NOT have healed the lane:

## The triad

1. **`claimIssue` set `assignee` but never `assigned_at`.**
   `planImplementRun`'s in-flight guard treats a claim with no `assignedAt` as
   *"age unknown → assume in flight"* — **forever**. The 2 h stale-claim
   reclaim (`DEFAULT_STALE_CLAIM_MS`) could never fire, so every dispatch whose
   worker died silently wedged permanently. This is the same failure class as
   the gym autoloop's `status='running'` dead-lock (that plan's D-007): *a
   liveness mechanism keyed on a timestamp nobody writes is a dead-lock, not a
   reclaim.* Fix: `claimIssue` stamps `assigned_at = now()`; `releaseIssue`
   clears it (issues-engineer.ts).

2. **The dispatch fired with `timeoutMs: 280_000`.** The invoke runner
   SIGTERMs the child at timeout — journal signature
   `[dbos-invoke] role=worker exited 143 with empty stderr` \~4 min 40 s after
   each dispatch. 280 s cannot fit reproduce + fix + regression test +
   `test:affected`, so \~51/58 workers were killed mid-fix and never reached the
   `improvements:resolve` back-edge. Fix: `implementTimeoutMs()` in
   improvement-actions.ts — default 45 min, env-overridable
   (`PAPERCUSP_IMPROVEMENT_IMPLEMENT_TIMEOUT_MS`), pinned by test to stay under
   the stale-claim window.

3. **The launch-blueprint fire-and-forget fallback's `recordSpawn` passed no
   `parentRole`** — `spawned_agents.parent_role` is NOT NULL, so the insert
   failed on **every** fallback launch (journal:
   `[launch-blueprint] fallback spawn record failed … parent_role …
   violates not-null constraint`). The fire itself still happened (the record
   is best-effort), so the workers ran but were invisible to `fleet:tree` —
   which is why nobody saw 51 workers dying. Fix: parentless launches record
   `parentRole: 'operator'` (matching every other root spawn), real parents
   pass through.

## How to spot it again

* `[improvement-implement] … skipped: N in-flight` with N growing across days
  → claims aren't aging out: check `assigned_at IS NULL` on
  `engineer_issues WHERE assignee='improvement-runner'`.
* `exited 143 with empty stderr` shortly after a dispatch → the worker hit its
  `timeoutMs`, not a crash.
* A fired launch that never appears in `fleet:tree` → check for the fallback
  spawn-record warn; the run may be alive but untracked.

## The general lessons

* **Every "skip while in-flight" guard needs a written timestamp AND a tested
  stale path.** If the claim writer and the staleness reader live in different
  files (here: issues-engineer.ts vs plan-implement.ts), add an integration
  test that claims through the real writer and asserts the timestamp landed.
* **Best-effort bookkeeping that fails 100% of the time is a silent
  observability hole** — the catch-and-warn kept the lane "working" while
  hiding the worker deaths it existed to surface. A warn that fires on every
  tick is a bug, not noise.
* Timeout knobs copied between contexts (a 280 s chat-ish timeout onto a
  fix-a-bug worker) deserve a sanity check against what the child actually
  does, and an invariant test against the reclaim window above them.

Repaired live on 2026-06-12: the 48 wedged rows were backfilled
`assigned_at = now()` so they re-enter the dispatchable pool \~2 h later, after
the deploy train carries the fixed code to :3070. Full context:
learning-system-audit-improvements-2026-06-09 D-010.

## Live proof + two residual failure modes (2026-06-12 supervised re-enable)

The lane was re-enabled under a supervised proof (consume-edges P-013) and the
first real armed dispatch (15:00:03, EI-75) confirmed **all three triad fixes
green in production**: the ledger row (`harness_shared.improvement_dispatches`)
named the item with `assigned_at` stamped at fire time (dateless-claim pool
held at 0), the spawn record landed via the fallback path with
`parent_role='operator'` (no NOT NULL violation, visible in the fleet), and the
worker's death was a real exit-1 at \~2 s — **not** the old exit-143 SIGTERM at
280 s. The triad is closed.

The proof itself was env-killed (the worker's entire stdout was *"You've hit
your weekly limit · resets Jun 18, 7am"* — the fleet-wide claude-token
exhaustion), so the last leg (≥1 genuine auto-resolve *landing*) is still
unproven. But the supervised run surfaced **two new failure modes downstream of
the triad fix** — both filed and owner-gated (do not patch without owner
ratification; they touch the protected routines path / attempt-accounting
policy):

1. **Durable-spawn enqueue always fails from routine context → silent
   fire-and-forget (EI-403).** The implement routine runs as one DBOS *step*
   (system-actions contract), and inside it the dispatch calls
   `fireLaunchBlueprint` → durable-spawn enqueue, which DBOS forbids from within
   a step/transaction (`Invalid call to a 'workflow' function from within a
   'step'`). **Every** dispatch therefore rides the fire-and-forget fallback —
   a host restart mid-dispatch loses the fire (the ledger row + claim survive,
   so it resurfaces as an orphan \~2 h later instead of being re-fired durably).
   The enqueue must move outside the step context (enqueue from the workflow
   layer, or make the dispatch its own workflow invocation). Repro: the
   `[durable-spawn] could not enqueue durable fire … falling back to
   fire-and-forget` warn on every :00/:30 tick.

2. **Dead-on-arrival env failures charge full attempts → a credential outage
   self-drains the auto pool (EI-406).** The attempts cap
   (`DEFAULT_MAX_ATTEMPTS=3`, resolve-core.ts) exists to retire hopeless items,
   but an env failure (rate-limit / credential / spawn-infra) says nothing about
   the item — yet it still increments the counter. The env-killed EI-75 dispatch
   above pushed it to attempt 2/3 without any worker ever reading the issue;
   left enabled through a credential outage, every tick burns one attempt off
   the top-ranked eligible item until the whole auto-eligible pool graduates to
   human-only on dead spawns. **This is the one safety precondition before any
   unattended re-enable.** Proposed shape: classify worker deaths before
   charging — a sub-floor exit (e.g. under 30 s) with an env-failure signature
   (rate-limit text / auth error / empty output) should not increment attempts,
   and N consecutive env-failures should trip a lane-level protective pause
   rather than per-item exhaustion.

**Re-enable checklist (run on the next armed tick, e.g. after the Jun 18 token
reset or a credential swap):** verify the triad invariants above still hold
(ledger names the item + `assigned_at` stamped · dateless-claim pool 0 · spawn
visible · no exit-143 at 280 s), confirm a worker actually *reads and resolves*
an issue (the leg the env outage blocked), and watch EI-406's attempt-charging:
if the credential is still exhausted at re-enable, abort before the lane drains
the pool.

## Round 2 (2026-06-13): resolve leg PROVEN — plus a worker-spawn tracking gap

Re-enabled via a **gateway-credential swap** (not the Jun 18 reset) on green
:3070 (deploy ad56905b, lane fixes EI-403-B/404/406/408 + EI-437 live). The
independent co-monitor checklist verdict: **PASS, including the leg round 1
couldn't reach.** Two dispatches fired and **both genuinely auto-resolved**,
each with an evidence-backed resolution + a fails-before/passes-after regression
guard:

* **EI-75** (worker `49130510`) — root-caused to EI-317, live-DB repro (cup
  coord writes 0 → 191 across 33 cups), regression test in
  `prompt-build.test.ts`; ideaLifecycle → `applied`.
* **EI-201** (worker `3f4c8aa2`) — source-invariant Cargo `mod patch_regression`
  guarding the vendored-wry toplevel-walk, `cargo test … patch_regression → ok`;
  ideaLifecycle → `applied`.

Triad invariants all held (items named + `assigned_at` stamped at fire, no
exit-143 env-kill — the gateway creds let workers actually run). **Scope the
dateless-claim invariant to OPEN issues:** `assignee='improvement-runner' AND
assigned_at IS NULL AND state NOT IN ('resolved','closed')` was 0. A raw
`assigned_at IS NULL` count is *not* the wedge signal — `releaseIssue` clears
`assigned_at` on resolve but leaves `assignee` set, so every resolved-by-runner
issue is legitimately dateless (7 such here), and unrelated interactive-agent
assignees inflate it further (96 unscoped). Only OPEN runner claims wedge.

**Residual gap (observability, EI-403 cluster): implement workers run invisibly
to `fleet:tree`.** ⚠ Watch-out for the next monitor: the `durableSpawnFire`
workflow `updated_at` does NOT advance while its `/invoke` step runs (the step
blocks for the worker's first \~6-8 min — `loopbackFetch` holds the connection),
so a mid-run check looks like a "frozen PENDING / stuck" workflow. It is not —
both implement workflows completed **SUCCESS** (recovery\_attempts=2, step output
checkpointed in `dbos.operation_outputs`); EI-403's core durability fix works and
does not double-dispatch. Don't call "stuck" from a single PENDING snapshot —
re-check after the step's block window.

The genuine residual is narrower: **the durable-spawn path writes no
`spawned_agents` row.** In `launch-blueprint.ts` the durable branch of
`defaultFire` returns `{spawnId: null, runId: idempotencyKey, durable: true}`
and `buildLaunchSpawnRequest` (the EI-403-A implement seam) just returns the
`DurableSpawnFireInput` — neither calls `recordSpawn`; only the fire-and-forget
fallback does (the WI-108 fix). So round 1's worker WAS in `spawned_agents`
(`s-…-983e57d1`, child\_role=worker, via the fallback) but round 2's two workers
appear in neither `spawned_agents` nor `agent_runs_consolidated` — invisible in
`fleet:tree`. EI-403-A/EI-437 fixed durability but regressed visibility vs round
**Fixed (staging, rides the release gate — EI-403 comment #45125):**
`DurableSpawnFireInput` gained an opt-in `spawnRecord`; `durableSpawnFireImpl` now
`recordSpawn`s (stable `spawn_id = durable-spawn:<key>`, idempotent on conflict →
recovery/retry-safe) before the fire and `finishSpawn`s it after (`done`, or
`failed`+error if the fire exhausts retries), and `buildLaunchSpawnRequest` (the
implement seam) opts in — deliberately NOT the `defaultFire` durable branch, since
pot launches record their own mug/cup rows and would otherwise double-count in
fleet:tree. Close criterion (re-verify post-deploy): the next durably-fired
implement worker shows a `spawned_agents` row (child\_role=worker,
parent\_role=operator, item\_id=EI-NNN) and appears in `fleet:tree`.

## Close criterion met (current code, verified 2026-07-03)

`durableSpawnFireImpl` (`packages/operator-core/lib/dbos/durable-spawn.ts`) now
takes the opt-in `input.spawnRecord` and, when present, records the durable
launch via `recordDurableSpawnAdmission`/`recordSpawn` before firing and
`finishSpawn`s it after — the same `parentRole: input.parent?.role ??
'operator'` fallback the fire-and-forget path used (never a bare
`parentRole: undefined` that would violate the `spawned_agents.parent_role`
NOT NULL constraint from item 3 of the original triad). `buildLaunchSpawnRequest`
(`packages/operator-core/lib/blueprint/launch-blueprint.ts`) — the implement
seam — passes `spawnRecord`. **(Correction, current code:** the general-purpose
`defaultFire` durable branch now passes `spawnRecord` too — so *every* durably-fired
launch records a `spawned_agents` row via `durableSpawnFireImpl`, with the same
`parent?.role ?? 'operator'` fallback, and `recordSpawn`'s stable `durable-spawn:<key>`
id keeps re-fires idempotent. The earlier staging note's "deliberately NOT the
`defaultFire` durable branch" no longer holds — both record. The mug→mug rename
also landed here: `defaultFire`'s singleton-admission branch is now keyed on
`role === 'mug'` alone.**)** So: durably-fired implement
workers are now visible in `spawned_agents` / `fleet:tree`, and the
`assigned_at`-wedge fix (item 1) has since hardened further —
`releaseIssue` (`issues-engineer.ts`) now clears **both** `assignee` and
`assigned_at` (EI-6480), so the round-2 caveat above ("`releaseIssue` clears
`assigned_at` but leaves `assignee` set, so a resolved-by-runner issue is
legitimately dateless") no longer applies verbatim — a resolved issue is
fully unassigned, not just date-less. The dateless-claim invariant can be
checked simply as `assignee='improvement-runner' AND assigned_at IS NULL`
(no need to additionally exclude resolved/closed state).

## A fourth wedge, found after "close criterion met" (2026-07-03, EI-6953/6954/6938)

The triad above was fixed and the lane ran — but a fourth, same-shaped defect
was still silently stranding a large fraction of dispatches: **the idempotent-resolve
guard in `resolveImprovement`** (`resolve-core.ts`) tested `issue.state !== 'open'`
to decide "this issue is already resolved, no-op success." That's wrong for this
schema. `engineer_issues` is a **view over `work_items`** (`status AS state`), and
issue-family items are **minted with the work-item state `todo`** — a normal,
non-terminal, *active* state, not `open`. Every reader elsewhere in the codebase
normalizes `todo`/`wip`/`in_progress`/etc. to the canonical `open` bucket before
comparing, but this one guard compared the raw state directly. The result: a
freshly-claimed, still-in-flight, `todo`-state issue satisfied `!== 'open'` on its
very first resolve call, so `resolveImprovement` returned `{ ok: true, outcome:
'fixed' }` **without ever calling `setIssueState`** — the item never actually
transitioned to `resolved`, stayed `todo` forever, and got redispatched on the next
sweep only to "resolve" as a no-op again. Live impact: an estimated \~450–650 items
stuck in this todo-resolve-loop, indistinguishable from healthy throughput because
every call returned `ok: true`.

The fix swaps the raw string comparison for a proper terminal-state-set membership
test:

```diff
+import { ISSUE_TERMINAL_STATUSES } from '../../work-item-blocking';
...
-  if (issue.state !== 'open' && input.outcome === 'fixed') {
+  if (ISSUE_TERMINAL_STATUSES.has(issue.state) && input.outcome === 'fixed') {
     // Idempotent: resolving an already-TERMINAL item (resolved|closed) is a no-op
     // success (a re-fired runner must not error out on the second resolve).
     await closeLedger();
     return { ok: true, id: input.id, outcome: 'fixed', state: issue.state };
   }
```

`ISSUE_TERMINAL_STATUSES` (`work-item-blocking.ts`) is the canonical `{resolved,
closed}` set — the same vocabulary the rest of the lane already normalizes to. The
general lesson from the original triad applies again, unchanged: **a state-machine
guard must test membership in the correct set, not inequality against one assumed
value** — `!== 'open'` silently treats *every other state including active ones* as
terminal, which is exactly the "no-op success masking a real skip" shape items 1
and 3 of the original triad also took. If you're auditing this lane again, check
first whether a similarly-shaped `state !== <single value>` guard has crept back in
anywhere in the resolve/claim path — that's the recurring signature, not the
specific field.
