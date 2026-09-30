# Measuring code:run adoption (and A/B-ing the nudge)
URL: /internal/docs/agent-insights/code-run-adoption-metric

The code:run adoption metric + the inline fan-out nudge. Why ~70% of batchable spawns went un-nudged, what the fan-out trigger fixes, and the runnable SQL to watch adoption / ablate the nudge by flag.

## Why agents weren't using `code:run`

A 2026-06-26 audit of `harness_shared.tool_invocations` found near-zero *organic*
`code:run` use. Two causes:

1. **A role gate** excluded worker-tier roles (fixed: `agentRoles: [...AGENT_ROLES]`).
2. **The structural nudge fired on the wrong pattern.** The original inline nudge
   triggered only on **same-tool ≥3×** in a session. But among multi-call SU spawns
   (≥4 calls), only \~**33% (cup) / \~28% (mug)** *have* a same-tool-≥3× pattern — the
   other \~70% are **many-distinct-tools-once fan-outs** (`get` here, `search` there,
   `list` somewhere else). The nudge was structurally **blind** to the dominant
   batchable shape. It was also **one-shot** (ignore once → never again) and gave the
   agent **no felt cost** (an LLM never experiences the token price of N round-trips).

### The 2026-07-03 finding: the fleet was STRUCTURALLY locked out

A follow-up audit (`code-run-self-state-adoption-2026-07-03`) explained why fleet
adoption stayed **zero** even after the fixes above: the fleet could not *reach* the
tool at all. Layered lockout:

1. **Seeded kits omitted it.** `code:run` (and `recipes:*`, `tools:find`,
   `tools:invoke`) was absent from `BEE_MCP_TOOL_NAMES` / `QUEEN_MCP_TOOL_NAMES` in
   `orchestrator/src/invoke.ts` — and the `*_ALLOWED_TOOLS` allowlists derive from
   those kits, so the omission was also an authorization denial. \~98% of cup spawns
   had a batchable shape; **0** could act on it.
2. **Capability envelopes denied the mug** `capability:bash` (code:run's
   requirement) and `intel:read` (recipes:search) — see
   `role-principal-caps.ts`. 59×/14d recipes denials at orient, silently.
3. **The su CORE spine omitted it too**, so trimmed seeded surfaces read the prose
   nudge's "when code:run is in your toolset" self-gate as *not in my toolset* and
   switched themselves off.
4. **The inline nudge fired at agents who couldn't comply** (role-membership check
   only — no envelope check, no surface check), escalating banners at a dead end.

All four layers were fixed on 2026-07-03: kits + CORE spine carry the batching set
(with `tools:find`/`tools:invoke` as the reachability hatch so a future kit omission
degrades to discovery, not a dead end), caps granted, and the nudge became
surface-aware (below). **Lesson: adoption is gated by REACHABILITY before prompting —
audit kit + caps + surface before tuning nudge wording.**

## What changed (the inline nudge)

`code-run-batch-nudge.ts` now runs a **sliding-window** (`NUDGE_WINDOW_MS`, 90s) tracker
per session with **two triggers**:

* **same-tool** ≥ `BATCH_NUDGE_THRESHOLD` (originally 3, **lowered to 2** by the
  2026-06-29 code-run-adoption directive — the 2nd identical round-trip already IS the
  loop) in the window → a list-then-loop skeleton.
* **fan-out** ≥ `FANOUT_DISTINCT_THRESHOLD` (originally 4, **lowered to 3** on the same
  2026-06-29 pass — three different reads in one burst is already a Promise.all-able
  fan-out) *distinct* tools in the window → a ready-to-paste **`Promise.all`** skeleton
  over the exact tools just seen.

It **re-fires on exponential backoff** (cooldown 4→8→16→32→64 calls) instead of going
permanently silent, and **leads with the running round-trip count** so the otherwise
invisible token cost is felt in-loop. Each trigger has its own flag:

* `FLAGS.CODE_RUN_BATCH_NUDGE` — the same-tool trigger.
* `FLAGS.CODE_RUN_FANOUT_NUDGE` — the new fan-out trigger (its **own** flag so it is an
  independent A/B knob).

The hot path stays a ring push; `getFlag` is consulted only when a hint actually fires.

**Surface-aware since 2026-07-03** (P-004): the old gate was role-membership only, so
envelope-denied roles and sessions whose seeded surface lacked `code:run` were nudged —
escalating banners included — toward a tool they could not call. Now:

* `canRoleActOnCodeRun(role)` = role ∈ `CODE_RUN_CAPABLE_ROLES` **AND** the role's
  `ROLE_ENVELOPES` entry does not deny `capability:bash` — the envelope deny is folded
  in, so overwatch/papercup-style denied roles are never nudged.
* `codeRunInSurface` (computed at the `_mcp-handler` call site from
  `getSessionSurface`): when the live seeded surface lacks `code:run`, the hint text
  switches to the **activate-first** variant (`ACTIVATE_PATH_NOTE` — `tools:find` /
  `tools:invoke { name:"code:run" }`) instead of advising an uncallable tool.

**Every fire is recorded** (P-005, `code-run-nudge-telemetry.ts`, migration `482`
`harness_shared.code_run_nudge_fires`): one narrow row per hint (session key, role,
kind, tool) — fire-and-forget, warn-once, never blocks the hot path. That makes the
**nudge→conversion funnel** a first-class read: `dev:code_run_adoption` returns
`nudge: { nudgedSessions, convertedSessions }` (canonical SQL:
`NUDGE_CONVERSION_SQL`, an EXISTS join against `tool_invocations` by
spawn\_id/run\_id after the session's first fire). Before this, the A/B flags existed
but fires were invisible — you could ablate the nudge yet never measure whether a
nudged session actually converted.

> `code-run-batch-nudge.ts` also exports a third, unrelated nudge —
> `maybeOrientDedupNudge` (flag `FLAGS.ORIENT_DEDUP_NUDGE`) — which catches a session
> re-fetching data `coord:orient` already returned within `ORIENT_DEDUP_WINDOW_MS`. It
> lives in the same module for the shared per-session tracking state, but it is a
> different metric with its own doc and production-telemetry queries:
> [`measuring-code-run-adoption.mdx`](/agent-insights/measuring-code-run-adoption/)'s
> "Production telemetry" section (metric #3, `dev:orient_dedup_rate`). This doc stays
> scoped to `code:run` itself.

## The adoption metric

`code-run-adoption.ts` makes "are agents batching?" a first-class read. A spawn is a
**batchable opportunity** when it fired one tool from ≥2 *separate inference turns*, or
touched ≥3 distinct tools spanning ≥3 separate turns (batch tools excluded) — the **same
thresholds the nudge uses, imported**, so metric and nudge can never drift.
**adoptionRate** (per role/day) = opportunity-spawns-that-also-used-`code:run`
÷ opportunity-spawns: *of the spawns that could have batched, how many did.*

**Turns, not raw calls (2026-07-13, P-012, agent-operability-clarity-full-audit-2026-07-13).**
Before P-012 the opportunity test used raw call counts (`maxSameTool`/`distinctTools`
straight off `tool_invocations`), the same flaw the live nudge had: several tool calls
dispatched from ONE inference turn (parallel `tool_use` — the harness's own "make
independent calls in the same response block" guidance) cost a single round-trip, but
were counted as N separate "opportunities to batch". That inflated the denominator with
spawns that were *already optimal* and, symmetrically, could make the nudge's own live
telemetry look like it was firing on already-correct behavior. `spawnRowsFromCalls` now
clusters each spawn's non-batch calls into inferred turns via the SAME timing-gap
heuristic the nudge uses (`clusterTurns`/`TURN_GAP_MS` in `code-run-batch-nudge.ts` —
there is no client-supplied turn id on this path, so turns are inferred from how close
together two calls were invoked: within `TURN_GAP_MS` ⇒ same turn, a real LLM inference
round-trip is far larger). `maxSameToolTurns`/`distinctTurns` are the fields that now
drive `isBatchableSpawn`; `workCalls`/`distinctTools` (raw, non-turn-aware) are kept only
for informational/debugging display.

**Metric hygiene (2026-07-03, P-006)** — three denominator poisons fixed in
`CODE_RUN_ADOPTION_SQL` + `spawnRowsFromCalls`:

* `transport = 'mcp'` — UI HTTP polling is not agent traffic (see the denominator
  warning in [measuring-code-run-adoption](/agent-insights/measuring-code-run-adoption/)).

* `spawn_id IS NOT NULL` — NULL spawn\_ids otherwise collapse into one mega-"spawn"
  that always counts as an opportunity.

* **Poller tools excluded** (`POLLER_TOOL_NORMS`, currently `activityrecent`): a UI
  poller calling `activity:recent` twice manufactured a fake same-tool "opportunity"
  \~87k times/7d. Fleet adoption read **0.26%** before the fix and **\~22%** after —
  same fleet, honest denominator.

* `computeCodeRunAdoption(rows)` / `summarizeSpawnAdoption(...)` — pure, unit-tested.

* `readCodeRunAdoption(runQuery, { sinceDays })` — runs `CODE_RUN_ADOPTION_SQL`.

### Run it live (dev:pg\_query)

`CODE_RUN_ADOPTION_SQL` pre-aggregates per spawn (with the turn-clustering CTEs) and is
runnable as-is (param `$1` = days). To eyeball adoption per role over the last 7 days,
using the TURN-based columns (`max_same_tool_turns`/`distinct_turns`), not the raw
`max_same_tool`/`distinct_tools` columns kept alongside for display only:

```sql
WITH s AS ( /* CODE_RUN_ADOPTION_SQL body, $1 = 7 */ )
SELECT role,
       count(*)                                                                  AS spawns,
       count(*) FILTER (WHERE max_same_tool_turns >= 2 OR distinct_turns >= 3)               AS opportunities,
       count(*) FILTER (WHERE (max_same_tool_turns >= 2 OR distinct_turns >= 3) AND used_code_run) AS adopted,
       round(100.0 * count(*) FILTER (WHERE (max_same_tool_turns >= 2 OR distinct_turns >= 3) AND used_code_run)
             / NULLIF(count(*) FILTER (WHERE max_same_tool_turns >= 2 OR distinct_turns >= 3), 0), 1) AS adoption_pct
FROM s GROUP BY role ORDER BY opportunities DESC;
```

(These literals track `BATCH_NUDGE_THRESHOLD` / `FANOUT_DISTINCT_THRESHOLD` in
`code-run-batch-nudge.ts` as of this writing — see the Gotcha below before trusting them
blindly. The fan-out leg here omits the `distinct_tools >= 3` AND-condition `isBatchableSpawn`
applies for brevity; a strict reproduction should AND it in too.)

(Prefer `readCodeRunAdoption` in code — it owns the canonical query and the reducer.)

## A/B-ing the nudge (the sanctioned rail)

The `PROMPT_ABLATION` rail ablates SU-playbook **prose** rules — it does **not** cover
this structural nudge. Ablate the nudge the project way: flip `CODE_RUN_FANOUT_NUDGE`
OFF in `/admin/features`, let it run, and compare **adoptionRate** (above) for the
fan-out-eligible population across the ON vs OFF windows. The dedicated flag exists so
that A/B is clean — toggling it does not touch the same-tool trigger.

## Gotcha — keep the metric and the nudge in lockstep

The opportunity definition lives **once**: `isBatchableSpawn` imports
`BATCH_NUDGE_THRESHOLD` / `FANOUT_DISTINCT_THRESHOLD` from the nudge module, and
`CODE_RUN_ADOPTION_SQL` mirrors the same `normalize()` + excluded-batch-tool set inline.
If you change a threshold, the excluded-batch-tool set, or the poller-exclusion set
(`POLLER_TOOL_NORMS`) in the TS, update the SQL's literal `IN (...)` lists to match
(the unit test pins the at-threshold boundary, but the SQL's literal lists are not
type-checked against the TS sets). The SQL also inlines `TURN_GAP_MS` (P-012) as a
literal in the `turned` CTE's `CASE` — the same duplication risk: if you retune
`TURN_GAP_MS` in `code-run-batch-nudge.ts`, update `adoptionQueryBody`'s inlined
literal too (there is no way to import a TS constant into raw SQL). The SQL also
carries the `transport='mcp' AND
spawn_id IS NOT NULL` filters — keep them if you fork the query, or the denominator
re-poisons.
