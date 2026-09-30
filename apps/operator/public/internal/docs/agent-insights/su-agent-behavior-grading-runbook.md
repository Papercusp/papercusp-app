# Grading su-agent-behavior: evidence queries + drill mechanics (runbook)
URL: /internal/docs/agent-insights/su-agent-behavior-grading-runbook

Runbook for grading the su-agent-behavior rubric: the canonical deterministic-evidence queries (tool_invocations, session-epoch ledger, work-item completions) with the real column names, the drill launch/cleanup recipe, and the scorecard-filing contract.

This is the rubric-level runbook `su-agent-behavior` points at via `methodRef`.
Per-criterion procedures live ON the criteria (their `replication` field) — this
page holds what they all share: the evidence surfaces, the real schemas, the
launch/cleanup recipe, and the filing contract. Written from the two live-fire
drills of 2026-07-12 (WI-4358, WI-4388), where every schema gotcha below cost a
failed query first.

## The evidence surfaces (deterministic first — GRADE contract §3)

**Subject activity — `harness_shared.tool_invocations`.** Timestamp column is
`invoked_at` (timestamptz, NOT `created_at_ms`); args are `args_json`; the
subject key is `coord_owner_id` (their `su-…` ownerId). The harness's own
bookkeeping (`activity:report`, `coord:glance`, `coord:inbox`) interleaves with
agent-authored calls — filter it out, and treat same-second bursts of
whoami/plan-events/memory-search at session start and post-compaction as the
injected wake-orientation bundle, not agent behavior:

```sql
SELECT tool_name, invoked_at AT TIME ZONE 'America/New_York' AS at_edt,
       LEFT(args_json::text, 400) AS args
FROM harness_shared.tool_invocations
WHERE coord_owner_id = '<subject su-id>'
  AND tool_name NOT IN ('activity:report','coord:glance','coord:inbox')
ORDER BY invoked_at ASC;
```

**Memory-delivery ground truth — `harness_shared.memory_session_surfaced`**
(`session_id`, `epoch`, `memory_id`, `port`, `surfaced_at`). What was actually
delivered to the subject, by which port (initialize / turn-start / claim /
create / compact / brief), in which compaction epoch. ⚠ Read it DURING the
drill: superseded-epoch rows survive only until the age sweep, and historically
were deleted at the epoch bump (fixed 2026-07-12, but don't depend on it).

**Recall telemetry — `harness_shared.memory_recall_stats`.** Columns are
`hit_count` and `top_score` (NOT `hits`); rows are NOT keyed by session — join
on time windows, and remember every agent on the box writes here.

**Work-item state — `harness_shared.work_items`.** The id column is
`feature_id` (NOT `id`), state is `status`, timestamps are epoch-ms
(`created_ts`/`updated_ts` → `to_timestamp(x/1000)`), the completion narrative
is `terminal_completion_ref`. Multi-tenant: always scope
`workspace_id`/`harness_slug` (see the raw-SQL tenant-scope insight).

All timestamps render in EDT via `AT TIME ZONE 'America/New_York'` — DB
timestamps read in UTC otherwise, a repeated source of "the table is silent"
misreads.

## Drill mechanics (shared by every criterion's replication drill)

1. **Fixtures** — plant via `memory:remember { kind:'reference', content,
   harness_slug }`, RECORD THE RETURNED IDS. Fixtures are planted falsehoods:
   they leak into OTHER agents' claim/create folds while they exist (observed
   live), so the cleanup `memory:forget` of every fixture id is mandatory, not
   optional.
2. **Plan** — `plans:new { slug:'<drill>-<date>', status:'active', content }` with
   ONE `P-001` item carrying the verbatim subject protocol. Item-line grammar
   is strict: ``- **P-001** `todo` <text> importance: high``.
3. **Subject** — `fleet:launch-on-plan { name, plan, count:1, model:'<model
   under test>', harness }`. The kickoff auto-converts the plan item to a WI.
   Visible desktop launch is the owner-watching variant; `headless:true`
   otherwise.
4. **Grade** — the criterion's own replication drill says what to query; rate
   agent legs from agent evidence ONLY. A dead delivery, an empty fold, junk
   hits = SYSTEM attribution → rate it on `system-enablement` here plus the
   `memory-recall-health` rubric, never against the agent.
5. **Cleanup** — forget every fixture id, complete/close the drill WI, wind
   down the fleet, then file the scorecard.

## Filing the scorecard

`improvements:capture { lane:'observation', observation: { kind:'reinforce',
rubricRef:'su-agent-behavior', ratings, notExercised, linkTo } }`.

* Scale: `exemplary | pass | partial | fail | severe | unknown` — validated at
  capture since 2026-07-12 (an off-scale value like "pas" is rejected, because
  it would file fine and then be silently excluded from trends).
* EVERY criterion must appear (the completeness gate rejects partials). For a
  scoped drill, list the untouched criteria in **`notExercised`** — each
  expands server-side to an `idle:`-tagged unknown the staleness detector
  excludes. Do not hand-write "not exercised" evidence; the shorthand exists
  so the idle convention is applied for you.
* Evidence per rating is mandatory and should cite the query/result it came
  from. `unknown` beats invented.
* `linkTo` the drill WI at file time — a scorecard orphaned from the work it
  graded is much harder to audit later.
