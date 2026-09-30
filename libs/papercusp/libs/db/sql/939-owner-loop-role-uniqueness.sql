-- 939-owner-loop-role-uniqueness.sql
--
-- WI-41225 / loop-wake-reliability-2026-08-24 P-002 (D-001).
-- Collapse split owner-loop fire-state rows and make the owner role itself the
-- database-enforced identity.  harness_shared.autoloop_state serves two distinct
-- populations:
--
--   * harness roles (director, engineer, ...), whose identity remains
--     (workspace_id, harness_slug, role); and
--   * owner loops (loop-su-<owner uuid>), whose globally unique owner id is already
--     carried in role and must have exactly one fire-state row.
--
-- The old primary key let an owner loop accumulate one row per harness re-home.
-- The gate could read one split while recordFire('ok') reset another, leaving a
-- successful loop permanently in backoff.  The live audit found 1,353 owner-loop
-- rows for 1,261 roles (92 extras).
--
-- FORWARD-COMPAT: this partial UNIQUE index must precede the role-only ON CONFLICT
-- target in P-001 because PostgreSQL cannot infer a conflict target before its
-- index exists (D-001).  The currently deployed writer still targets the old
-- primary key during the short migration-to-deploy window.  The collapse keeps
-- each role's most-recently-fired row, including its current workspace/harness
-- metadata, so ordinary fires continue to hit that primary-key row; only a
-- concurrent owner-loop re-home to a different harness during that bounded window
-- is rejected rather than recreating the split.  No old index or column is removed.

-- Prevent a concurrent old-code insert from recreating a duplicate between the
-- collapse and index build.  The table is small and the statements below are one
-- transaction, so writers pause for the migration rather than racing it.
LOCK TABLE harness_shared.autoloop_state IN SHARE ROW EXCLUSIVE MODE;

-- Materialize one merge record only for roles that are actually split.  The
-- survivor is the row with the newest real fire, which preserves the metadata the
-- still-deployed writer is most likely using.  Ties are deterministic.
CREATE TEMP TABLE owner_loop_state_939_merge ON COMMIT DROP AS
SELECT
  role,
  (array_agg(workspace_id ORDER BY last_fired_at DESC, workspace_id, harness_slug))[1]
    AS keep_workspace_id,
  (array_agg(harness_slug ORDER BY last_fired_at DESC, workspace_id, harness_slug))[1]
    AS keep_harness_slug,
  max(last_fired_at) AS merged_last_fired_at,
  (array_agg(last_status ORDER BY last_fired_at DESC, workspace_id, harness_slug))[1]
    AS merged_last_status,
  -- Load-bearing: MAX would preserve the stale half's error streak and recreate
  -- the immortal-backoff failure.  Any successful split (0) closes the circuit.
  min(consecutive_errors) AS merged_consecutive_errors,
  max(last_withheld_at) AS merged_last_withheld_at,
  (array_agg(
     last_withheld_reason
     ORDER BY last_withheld_at DESC NULLS LAST, last_fired_at DESC,
              workspace_id, harness_slug
   ) FILTER (WHERE last_withheld_at IS NOT NULL))[1]
    AS merged_last_withheld_reason,
  (array_agg(
     last_withheld_detail
     ORDER BY last_withheld_at DESC NULLS LAST, last_fired_at DESC,
              workspace_id, harness_slug
   ) FILTER (WHERE last_withheld_at IS NOT NULL))[1]
    AS merged_last_withheld_detail
FROM harness_shared.autoloop_state
WHERE role LIKE 'loop-su-%'
GROUP BY role
HAVING count(*) > 1;

-- Rewrite the chosen survivor with the conservative merged state before removing
-- its obsolete siblings.  last_status follows the newest fire; withhold detail
-- follows the newest withhold, because those are two independent event streams.
UPDATE harness_shared.autoloop_state AS state
   SET last_fired_at = merge.merged_last_fired_at,
       last_status = merge.merged_last_status,
       consecutive_errors = merge.merged_consecutive_errors,
       last_withheld_at = merge.merged_last_withheld_at,
       last_withheld_reason = merge.merged_last_withheld_reason,
       last_withheld_detail = merge.merged_last_withheld_detail
  FROM owner_loop_state_939_merge AS merge
 WHERE state.role = merge.role
   AND state.workspace_id = merge.keep_workspace_id
   AND state.harness_slug = merge.keep_harness_slug;

DELETE FROM harness_shared.autoloop_state AS state
USING owner_loop_state_939_merge AS merge
 WHERE state.role = merge.role
   AND (state.workspace_id, state.harness_slug)
       <> (merge.keep_workspace_id, merge.keep_harness_slug);

CREATE UNIQUE INDEX IF NOT EXISTS autoloop_state_owner_role_uidx
  ON harness_shared.autoloop_state (role)
  WHERE role LIKE 'loop-su-%';

COMMENT ON INDEX harness_shared.autoloop_state_owner_role_uidx IS
  'WI-41225 / D-001: an owner loop (loop-su-<owner uuid>) has one global fire-state row. '
  'Harness roles remain keyed by autoloop_state_pkey (workspace_id, harness_slug, role).';
