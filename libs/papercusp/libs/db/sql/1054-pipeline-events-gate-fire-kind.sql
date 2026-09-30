-- 1054-pipeline-events-gate-fire-kind.sql
-- P-001 (gate-verdict-liveness-and-repair-reliability-2026-08-31): admit the per-fire
-- ledger ANCHOR kind 'green_checkpoint_fire' into harness_shared.pipeline_events.
--
-- WHY A SEPARATE KIND (not a new status under 'green_checkpoint'): at least four live
-- consumers treat "a green_checkpoint row exists" as "an outcome happened" —
-- green-stall-watchdog's last_verdict_ms subquery (the clock of the D-006 verdict-less
-- limb), readLastGateRunEvidence (newest-row run evidence), lost-wake-detect's
-- verdict-vs-wake reconciliation, and the /admin pipeline window summary. A fire-anchor
-- row under that kind would advance the verdict-less clock on EVERY fire and blind the
-- exact limb built to catch fires-that-record-nothing. A distinct kind is invisible to
-- every existing consumer (they all filter kind = 'green_checkpoint' exactly).
--
-- The anchor row itself is written by packages/operator-core/lib/release/gate-fire-ledger.ts
-- at the green-checkpoint tick entry and at detached checkpoint launches; writes are
-- best-effort (appendPipelineEvent swallows), so this constraint widening applying LATER
-- than the code is safe — until it applies, anchor inserts warn-and-noop hourly.
--
-- FORWARD-COMPAT: the currently-deployed release only ever INSERTs the six pre-existing
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
    'deploy'::text,
    'release_fixer'::text
  ]));
