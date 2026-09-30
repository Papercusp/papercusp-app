-- 419-pipeline-events-kind-content-release-fixer.sql — fix the multi-day green-gate FREEZE.
--
-- ROOT CAUSE: migration 177 defined pipeline_events_kind_check as
--   CHECK (kind = ANY (ARRAY['git_sync','merge_resolver','green_checkpoint','deploy']))
-- but `appendPipelineEvent`'s PipelineEventKind union (git-sync/pipeline-events.ts) ALSO emits
-- 'content_fixer' and 'release_fixer'. So every content-fixer + release-fixer event — INCLUDING the
-- release-fixer's GREEN verdict (kind 'release_fixer', status 'ok') — was rejected at write time:
--   ERROR: new row for relation "pipeline_events" violates check constraint "pipeline_events_kind_check"
-- The green verdict could therefore NEVER persist → the deploy gate sat "no GREEN verdict in ~74h"
-- (101 consecutive non-greens) → the WHOLE fleet's deploys froze (operator :3070 stuck ~133 commits behind
-- main, deployed sha unchanged for days). Tests were NOT failing (the gate runner logged failingTests:[]);
-- the verdict simply couldn't be recorded.
--
-- FIX: add the two missing kinds so the green verdict (+ content-fixer events) record and the pipeline
-- unfreezes. STRICTLY ADDITIVE — only WIDENS the allowed set, so it cannot reject any existing row.
-- Idempotent (DROP IF EXISTS + re-ADD); fresh-migrate-safe (177's table already exists by now).

ALTER TABLE harness_shared.pipeline_events DROP CONSTRAINT IF EXISTS pipeline_events_kind_check;
ALTER TABLE harness_shared.pipeline_events
  ADD CONSTRAINT pipeline_events_kind_check
  CHECK (kind = ANY (ARRAY[
    'git_sync'::text,
    'merge_resolver'::text,
    'content_fixer'::text,
    'green_checkpoint'::text,
    'deploy'::text,
    'release_fixer'::text
  ]));
