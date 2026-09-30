-- 1048: write-time semantic goal + actor provenance for tool invocations.
-- WI-1742833: coord_owner_id alone identifies a session, but not the goal that
-- session served or whether it was the elected holder, a drain-fleet member, or
-- an inherited descendant. Resolve both values at the existing deferred
-- telemetry INSERT so history remains correct after membership/holder rows age.

-- tool_invocations is continuously written. Match the polite, short-attempt DDL
-- discipline established by migration 694 so an ACCESS EXCLUSIVE waiter never
-- queues the fleet's telemetry writers behind it.
DO $$
DECLARE
  attempts int := 0;
BEGIN
  LOOP
    BEGIN
      SET LOCAL lock_timeout = '250ms';
      ALTER TABLE harness_shared.tool_invocations
        ADD COLUMN IF NOT EXISTS goal_id text,
        ADD COLUMN IF NOT EXISTS goal_actor_class text;
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

COMMENT ON COLUMN harness_shared.tool_invocations.goal_id IS
  'WI-1742833: semantic goal served by the caller, resolved at telemetry write time from GOAL mode then inherited session brief; nullable when unscoped.';
COMMENT ON COLUMN harness_shared.tool_invocations.goal_actor_class IS
  'WI-1742833: write-time actor class: holder-agent, drain-fleet-member, or goal-descendant-agent; nullable when goal_id is NULL.';

DO $$
DECLARE
  attempts int := 0;
BEGIN
  LOOP
    BEGIN
      SET LOCAL lock_timeout = '250ms';
      CREATE INDEX IF NOT EXISTS tool_invocations_goal_id_idx
        ON harness_shared.tool_invocations (workspace_id, goal_id, invoked_at DESC)
        INCLUDE (coord_owner_id, goal_actor_class)
        WHERE goal_id IS NOT NULL;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      attempts := attempts + 1;
      IF attempts >= 240 THEN
        RAISE EXCEPTION
          'could not acquire SHARE on tool_invocations for the goal provenance index after % attempts', attempts;
      END IF;
      PERFORM pg_sleep(0.25);
    END;
  END LOOP;
END $$;
