-- 1083-pipeline-events-gate-fire-drill-kind.sql
-- P-016 (gate-verdict-liveness-and-repair-reliability-2026-08-31): admit the gate fire
-- drill's outcome kind 'gate_fire_drill' into harness_shared.pipeline_events.
--
-- DISTINCT from 1054 (similarity is textual, not semantic): 1054 admitted the per-fire
-- ledger ANCHOR kind 'green_checkpoint_fire'; this admits the weekly fire DRILL's outcome
-- rows (pass / fail / skipped, written by lib/release/gate-fire-drill-deps.ts). A separate
-- kind for the same reason 1054 argued one: every existing consumer filters kind exactly,
-- so drill outcomes must never ride the 'green_checkpoint' outcome stream (a drill row
-- would advance the verdict-less clock and read as a run outcome) nor the anchor stream
-- (it would inflate the P-003 fires denominator on non-drill windows).
--
-- Writes are best-effort (appendPipelineEvent swallows + warns), so this constraint
-- widening applying LATER than the code is safe — until it applies, drill outcome inserts
-- warn-and-noop (at most weekly).
--
-- FORWARD-COMPAT: the currently-deployed release only ever INSERTs the seven pre-existing
-- kinds, and every one of them remains admitted by the widened CHECK below (it is strictly
-- more permissive than the constraint it replaces); no deployed code path depends on the
-- narrower constraint refusing the new kind, so the live release checkout cannot break
-- while this applies.
ALTER TABLE harness_shared.pipeline_events
  DROP CONSTRAINT pipeline_events_kind_check;
ALTER TABLE harness_shared.pipeline_events
  ADD CONSTRAINT pipeline_events_kind_check
  CHECK (kind = ANY (ARRAY[
    'git_sync'::text,
    'merge_resolver'::text,
    'content_fixer'::text,
    'green_checkpoint'::text,
    'green_checkpoint_fire'::text,
    'gate_fire_drill'::text,
    'deploy'::text,
    'release_fixer'::text
  ]));
