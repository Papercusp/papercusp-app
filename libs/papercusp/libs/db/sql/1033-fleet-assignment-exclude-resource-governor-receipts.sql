-- 1033-fleet-assignment-exclude-resource-governor-receipts.sql
--
-- EI-21830607512202892: resource-governor admission receipts are ephemeral
-- local queue state, not human/fleet work. Their work_items rows carry
-- payload.resource_governor and are temporarily assigned while an admission
-- lease runs, so the fleet_assignment work_item_claim leg must not expose them
-- as ordinary agent claims.
--
-- Migrations 1025 and 1026 already prevent these rows from entering
-- federation capture and sync-invalidation notifications. This migration closes
-- the remaining claim/holder surface: fleet:assignments and every reader of
-- harness_shared.fleet_assignment.
--
-- The view body below is migration 833 verbatim apart from the
-- payload.resource_governor exclusion in the work_item_claim WHERE clause.
-- Preserve the GREATEST(last_progress_at, taken_at) stall anchor and the exact
-- output column order/types.
--
-- The migration runner wraps each file in its own transaction.

\set ON_ERROR_STOP on

CREATE OR REPLACE VIEW harness_shared.fleet_assignment AS
WITH presence AS (
  SELECT
    owner_id, owner_label, workspace_id, source, intent, current_plan_slug,
    heartbeat_at,
    (now() - heartbeat_at) < interval '10 minutes' AS alive
  FROM harness_shared.coord_presence
),
holder AS (
  SELECT
    owner_id AS alias, owner_label, workspace_id, intent, current_plan_slug, heartbeat_at, alive
  FROM presence
  UNION ALL
  SELECT DISTINCT ON (a.alias)
    a.alias,
    ('bee · ' || left(n.spawn_id, 10)) AS owner_label,
    n.workspace_id,
    NULL::text                          AS intent,
    NULL::text                          AS current_plan_slug,
    n.heartbeat_at,
    (n.heartbeat_at IS NOT NULL
      AND (now() - n.heartbeat_at) < interval '10 minutes') AS alive
  FROM harness_shared.spawned_agents n
  CROSS JOIN LATERAL (VALUES (n.spawn_id), (n.session_owner), (n.run_id)) AS a(alias)
  WHERE n.status = 'running'
    AND a.alias IS NOT NULL AND a.alias <> ''
    AND NOT EXISTS (SELECT 1 FROM presence p WHERE p.owner_id = a.alias)
),
membership AS (
  SELECT DISTINCT ON (workspace_id, owner_id)
         workspace_id, owner_id, fleet_slug, fleet_role
    FROM harness_shared.fleet_membership_events
   ORDER BY workspace_id, owner_id, id DESC
)
SELECT
  'plan_item_claim'::text                          AS source,
  c.workspace_id,
  c.owner                                          AS agent_id,
  COALESCE(NULLIF(c.owner_label, ''), p.owner_label) AS agent_label,
  c.owner_name                                     AS agent_name,
  c.harness_slug,
  c.plan_slug,
  c.item_id,
  NULL::text                                       AS work_item_id,
  NULL::text                                       AS item_kind,
  c.intent                                         AS detail,
  NULL::text                                       AS status,
  c.acquired_ts                                    AS claim_acquired_ts,
  c.expires_ts                                     AS claim_expires_ts,
  (c.expires_ts > now())                           AS claim_active,
  c.liveness_mode,
  c.last_activity_ts,
  (p.alias IS NOT NULL)                            AS holder_present,
  COALESCE(p.alive, false)                         AS holder_alive,
  p.heartbeat_at                                   AS holder_heartbeat_at,
  p.intent                                         AS holder_intent,
  p.current_plan_slug                              AS holder_plan_slug,
  (c.expires_ts > now() AND NOT COALESCE(p.alive, false) AND c.owner NOT IN ('improvement-runner')) AS orphaned,
  (p.current_plan_slug IS NOT DISTINCT FROM c.plan_slug) AS declared_plan_matches,
  NULL::integer                                    AS assignee_rank,
  NULL::text                                       AS rank_writer,
  NULL::timestamptz                                AS last_progress_at,
  NULL::boolean                                    AS stalled,
  m.fleet_slug                                     AS fleet_slug,
  m.fleet_role                                     AS fleet_role
FROM harness_shared.plan_item_claims c
LEFT JOIN holder p ON p.alias = c.owner
LEFT JOIN membership m ON m.workspace_id = COALESCE(p.workspace_id, c.workspace_id) AND m.owner_id = c.owner

UNION ALL
SELECT
  'plan_item_assignment'::text,
  a.workspace_id,
  a.assignee_name,
  NULL::text,
  a.assignee_name,
  a.harness_slug,
  a.plan_slug,
  a.item_id,
  NULL::text,
  NULL::text,
  COALESCE(a.note, ''),
  NULL::text,
  a.assigned_ts,
  NULL::timestamptz,
  true,
  NULL::text,
  a.updated_at,
  false,
  false,
  NULL::timestamptz,
  NULL::text,
  NULL::text,
  false,
  NULL::boolean,
  NULL::integer,
  NULL::text,
  NULL::timestamptz,
  NULL::boolean,
  m.fleet_slug,
  m.fleet_role
FROM harness_shared.plan_item_assignments a
LEFT JOIN holder p ON p.alias = a.assignee_name
LEFT JOIN membership m ON m.workspace_id = COALESCE(p.workspace_id, a.workspace_id) AND m.owner_id = a.assignee_name
WHERE a.assignee_name IS NOT NULL AND a.released_ts IS NULL

UNION ALL
SELECT
  'work_item_claim'::text,
  w.workspace_id,
  w.taken_by,
  p.owner_label,
  NULL::text,
  w.harness_slug,
  w.source_plan_slug,
  NULL::text,
  w.feature_id,
  w.item_kind,
  COALESCE(w.title, ''),
  w.status,
  w.taken_at,
  NULL::timestamptz,
  true,
  NULL::text,
  w.taken_at,
  (p.alias IS NOT NULL),
  COALESCE(p.alive, false),
  p.heartbeat_at,
  p.intent,
  p.current_plan_slug,
  (NOT COALESCE(p.alive, false) AND w.taken_by NOT IN ('improvement-runner')),
  CASE WHEN w.source_plan_slug IS NULL THEN NULL::boolean
       ELSE (p.current_plan_slug IS NOT DISTINCT FROM w.source_plan_slug) END,
  w.assignee_rank,
  w.rank_writer,
  w.last_progress_at,
  (COALESCE(p.alive, false)
    AND w.taken_by NOT IN ('improvement-runner')
    -- PostgreSQL GREATEST ignores a NULL input, preserving the previous
    -- taken_at fallback while choosing taken_at when it is newer.
    AND (now() - GREATEST(w.last_progress_at, w.taken_at)) > interval '10 minutes') AS stalled,
  m.fleet_slug,
  m.fleet_role
FROM harness_shared.work_items w
LEFT JOIN holder p ON p.alias = w.taken_by
LEFT JOIN membership m ON m.workspace_id = COALESCE(p.workspace_id, w.workspace_id) AND m.owner_id = w.taken_by
WHERE w.taken_by IS NOT NULL AND w.taken_by <> ''
  AND COALESCE(w.status, '') NOT IN ('done', 'passed', 'deprecated', 'resolved', 'closed', 'dropped', 'needs-human', 'blocked')
  -- EI-21830607512202892: admission receipts are local queue telemetry,
  -- intentionally absent from fleet work-load and holder-goal surfaces.
  AND NOT jsonb_exists(COALESCE(w.payload, '{}'::jsonb), 'resource_governor')

UNION ALL
SELECT
  'presence'::text,
  p.workspace_id,
  p.owner_id,
  p.owner_label,
  NULL::text,
  NULL::text,
  p.current_plan_slug,
  NULL::text,
  NULL::text,
  NULL::text,
  p.intent,
  NULL::text,
  NULL::timestamptz,
  NULL::timestamptz,
  NULL::boolean,
  NULL::text,
  p.heartbeat_at,
  true,
  p.alive,
  p.heartbeat_at,
  p.intent,
  p.current_plan_slug,
  false,
  NULL::boolean,
  NULL::integer,
  NULL::text,
  NULL::timestamptz,
  NULL::boolean,
  m.fleet_slug,
  m.fleet_role
FROM presence p
LEFT JOIN membership m ON m.workspace_id = p.workspace_id AND m.owner_id = p.owner_id;

COMMENT ON VIEW harness_shared.fleet_assignment IS
  'Canonical "who''s on what" (state-not-chat-fleet-state D-002): claim-primary union of plan_item_claims + plan_item_assignments + work-item claims (work_items.taken_by) + coord_presence, each claim LEFT-joined to its holder''s liveness. orphaned = DEAD holder; stalled = ALIVE holder with neither a claim nor item-scoped progress timestamp inside the 10-minute window. The stall anchor is GREATEST(last_progress_at, taken_at), so a fresh reclaim receives its full grace window even when it retains older progress. Resource-governor admission receipts (payload.resource_governor) are local queue telemetry and excluded from the work-item claim leg. Read via fleet:assignments; change-feed on channel fleet_assignment.';
