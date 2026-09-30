-- 1167-gate-repair-latency-ledger-kind.sql
-- R-7 of green-gate-zero-wait-convergence-2026-09-08 / EI-23420599799124840: admit the
-- durable frozen-repair LATENCY kind 'green_checkpoint_repair_latency' into
-- harness_shared.pipeline_events.
--
-- THE DEFECT THIS CLOSES. R-7 requires that gate_health report admit->verdict,
-- red->fixer-spawn and fix->admit latencies "so idle time is measurable, not anecdotal".
-- Those figures ARE computed (frozen-candidate-repair-queue.ts, computeFrozenRepairLatency)
-- but they are computed ON READ from the LIVE queue record and published into a single
-- MUTABLE slot -- routines.metadata->'gate_health'->'freezeAndConverge'->'repairLatency',
-- shallow-merged by writeFreezeAndConvergeDisposition. Each tick overwrites the previous
-- tick's numbers, and a retire clears the queue outright, so repairLatency legitimately
-- goes null (freeze-disposition.ts: "null when the tick held no readable queue") exactly
-- when a postmortem needs the history. Measured 2026-09-16: a pipeline_events scan for
-- '%repairLatency%' OR '%admitToResumeRunStartMs%' under workspace_id='papercusp-workspace'
-- returned ZERO rows with a PASSING positive control -- the latencies of every repair cycle
-- ever run on this install are unrecoverable.
--
-- WHY A SEPARATE KIND, on exactly the reasoning migration 1054 recorded for the fire
-- anchor: at least four live consumers treat "a green_checkpoint row exists" as "an outcome
-- happened" (green-stall-watchdog's last_verdict_ms subquery, readLastGateRunEvidence,
-- lost-wake-detect's verdict-vs-wake reconciliation, the /admin pipeline window summary), so
-- a latency row under that kind would advance the verdict-less clock and blind the limb built
-- to catch fires-that-record-nothing. Nor may these ride 'green_checkpoint_fire': that kind is
-- an ENTRY ANCHOR whose rows are counted as fires by reconstructGateFireDays, and a
-- per-disposition latency row under it would inflate the fire count that reconstruction
-- exists to make trustworthy. A distinct kind is invisible to every existing consumer (they
-- all filter kind exactly).
--
-- The row itself is written by writeFreezeAndConvergeDisposition via appendPipelineEvent,
-- whose contract is best-effort/non-throwing -- observability must never be able to fail a
-- gate tick -- so this constraint widening applying LATER than the code is safe: until it
-- applies, each latency insert warn-and-noops exactly as the 1054 anchors did.
--
-- FORWARD-COMPAT: the currently-deployed release only ever INSERTs the eight pre-existing
-- kinds, and every one of them remains admitted by the widened CHECK below (it is strictly
-- more permissive than the constraint it replaces); no deployed code path depends on the
-- narrower constraint refusing the new kind, so the live release checkout cannot break while
-- this applies.
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
    'release_fixer'::text,
    'green_checkpoint_repair_latency'::text
  ]));
