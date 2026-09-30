-- 694-tool-invocations-agent-state-stamp.sql
--
-- unified-agent-state-plane-2026-07-27, P-009: stamp the agent's DECLARED STATE
-- on every tool call, so a call can be read back against the goal and the
-- assumptions that were live when it was made.
--
-- THE TRIPLE, NOT THE PAIR. P-009's item text names two columns; **D-011
-- supersedes it** and binds the stamp to all three declaration scopes:
--
--   | column             | declared by            | referent                          |
--   |--------------------|------------------------|-----------------------------------|
--   | intent_event_id    | coord:declare-intent   | coord_event_log.id (append-only)  |
--   | assumption_set_id  | facts:assert           | agent_facts.id (a VERSION row)    |
--   | goal_ref           | work_items:claim / …   | a resolvable ref, e.g. 'WI-6393'  |
--
-- WHY THESE TYPES. The first two name an immutable ROW, so they are real
-- nullable bigints — not jsonb, and deliberately not FKs (see RETENTION below).
-- `goal_ref` is TEXT because its referent is polymorphic (work-item, plan item,
-- gate cell) and because D-046/P-024 requires the read surface to expose a
-- RESOLVED ref — "a bigint is not a read surface". Storing the ref directly is
-- what makes the read path a projection instead of a join.
--
-- WHY NOT jsonb. Three scalars written on 238,866 rows/day: a jsonb object would
-- cost a per-row header + key strings forever, and could not be indexed by the
-- partial index below without an expression index on top. ~16 B/row as columns.
--
-- WRITE PATH (D-014). No new write and no query is added to the hot path. The
-- dispatcher ALREADY inserts one `tool_invocations` row per call and ALREADY
-- resolves `coord_owner_id`; these three values come from a per-owner in-process
-- `Map` (lib/agent-state-stamp.ts) updated a few times per task by the acts the
-- agent already performs. A cache miss writes NULL rather than blocking a call,
-- so NULL means "not declared / not yet cached", never "lookup failed".
--
-- ⚠ NO FOREIGN KEYS, AND THAT IS DELIBERATE — RETENTION ORDERING.
-- `tool_invocations` is aggressively pruned (telemetry retention; measured
-- 2026-07-27: oldest row 2026-07-13, ~14d) while `coord_event_log` reaches back
-- to 2026-05-30 (~58d) and `agent_facts` is bounded only by `sweepExpiredFacts`.
-- So the POINTED-AT records outlive the POINTERS in the steady state, which is
-- the ordering this stamp needs. An FK would still be wrong: it would make the
-- fact/event reapers block on (or cascade into) telemetry, coupling two
-- independent retention policies, and a dangling pointer here is a benign
-- "that record has aged out" — exactly what a forensic read should report.
--
-- ⚠ A NULL HERE IS NOT A MEASUREMENT. `assumption_set_id`'s producer is
-- MEASURED EMPTY at write time (2026-07-27: 0 of 2,088 `agent_facts` rows have
-- kind='assumption'), so this column is expected to be 100% NULL until
-- assumptions are actually written. `intent_event_id`'s producer is live and hot
-- by contrast (12,331 intent events / 2,363 writers / 529 in 24h). Anything
-- reporting on these columns must distinguish "nothing was declared" from
-- "declared and empty" — P-015 measures the FILL RATE, not just adoption.

-- ⚠ POLITE DDL — DO NOT REPLACE WITH A BARE `ALTER TABLE`.
--
-- `tool_invocations` is the hottest table in this database (~238,866 inserts a
-- day, written continuously by every agent on the box), and a bare ALTER here
-- FAILED five straight attempts on 2026-07-27 with "canceling statement due to
-- lock timeout". The naive fix — raise lock_timeout — makes it strictly worse:
-- a pending ACCESS EXCLUSIVE request QUEUES, and every INSERT arriving behind
-- it queues too, so a 15s wait is 15s of stalled fleet-wide telemetry followed
-- by a failure anyway. That is the shape of the 2026-06-09 incident where a
-- lock-contending migration tripped the deploy's 15s lock_timeout and wedged
-- every deploy for an hour.
--
-- So: take the lock only if it is FREE RIGHT NOW (250ms), release instantly if
-- not, and try again. Each attempt is far too short to build a queue, and the
-- DDL itself is metadata-only (ADD COLUMN with no DEFAULT never rewrites the
-- table in PG 11+), so the moment an attempt wins the lock it is done in
-- microseconds. ~60s of retries, which in practice succeeds in the first few.
DO $$
DECLARE
  attempts int := 0;
BEGIN
  LOOP
    BEGIN
      SET LOCAL lock_timeout = '250ms';
      ALTER TABLE harness_shared.tool_invocations
        ADD COLUMN IF NOT EXISTS intent_event_id bigint,
        ADD COLUMN IF NOT EXISTS assumption_set_id bigint,
        ADD COLUMN IF NOT EXISTS goal_ref text;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      attempts := attempts + 1;
      IF attempts >= 240 THEN
        RAISE EXCEPTION
          'could not acquire ACCESS EXCLUSIVE on tool_invocations after % polite attempts', attempts;
      END IF;
      PERFORM pg_sleep(0.25);
    END;
  END LOOP;
END $$;

COMMENT ON COLUMN harness_shared.tool_invocations.intent_event_id IS
  'P-009/D-011: harness_shared.coord_event_log.id of the caller''s most recent intent declaration (body.lifecycle=''intent''). NULL = none declared or not yet cached. No FK — coord_event_log outlives this table''s retention.';
COMMENT ON COLUMN harness_shared.tool_invocations.assumption_set_id IS
  'P-009/D-011: WATERMARK over harness_shared.agent_facts.id — the caller''s live assumption set is every non-retracted, non-superseded kind=''assumption'' fact of theirs with id <= this value. A single monotonic id names a SET because P-008(a) made fact versions immutable and append-only. NULL = no assumptions declared.';
COMMENT ON COLUMN harness_shared.tool_invocations.goal_ref IS
  'P-009/D-011: the RESOLVED goal ref this call served (e.g. ''WI-6393'', ''plan:slug#P-009''), auto-derived from the caller''s claimed work-item / plan-item. Text, not a bigint, because D-046/P-024 reads it directly as a ref. NULL = no goal claimed.';

-- Mirrors `tool_invocations_coord_owner_idx`'s shape (owner + recency) but keyed
-- on the goal, which is the ONE filter D-046/P-024 commits to serving:
-- "what did this agent do while it held goal X". PARTIAL so it indexes only the
-- stamped minority — with an empty producer today and a partial-adoption path
-- ahead, a full index would be ~1.25M entries of NULL for no reader.
-- Same polite-lock discipline: CREATE INDEX takes a SHARE lock, which conflicts
-- with the ROW EXCLUSIVE every INSERT holds, so it can queue exactly like the
-- ALTER above. The build itself is quick (the predicate matches ~0 rows today),
-- but acquiring the lock on a continuously-written table is the hard part.
DO $$
DECLARE
  attempts int := 0;
BEGIN
  LOOP
    BEGIN
      SET LOCAL lock_timeout = '250ms';
      CREATE INDEX IF NOT EXISTS tool_invocations_goal_ref_idx
        ON harness_shared.tool_invocations (goal_ref, invoked_at DESC)
        WHERE goal_ref IS NOT NULL;
      -- The intent bucket ("all calls under this declaration") is the P-010
      -- divergence detector's read. Partial for the same reason.
      CREATE INDEX IF NOT EXISTS tool_invocations_intent_event_idx
        ON harness_shared.tool_invocations (intent_event_id, invoked_at DESC)
        WHERE intent_event_id IS NOT NULL;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      attempts := attempts + 1;
      IF attempts >= 240 THEN
        RAISE EXCEPTION
          'could not acquire SHARE on tool_invocations for the P-009 indexes after % attempts', attempts;
      END IF;
      PERFORM pg_sleep(0.25);
    END;
  END LOOP;
END $$;
