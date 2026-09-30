-- 375-recreate-fleet-assignment-view-dropped-by-374.sql
--
-- ROOT CAUSE: migration 374 (work-item unification) ran
--   `DROP VIEW harness_shared.work_items CASCADE;`
-- to promote harness_features_consolidated to the base table. The CASCADE
-- silently dropped EVERY view that depended on the old work_items union view —
-- including harness_shared.fleet_assignment (the canonical "who's on what" view,
-- canonical body = migration 358, which reads work_items for the work_item_claim
-- leg + w.last_progress_at). 374 recreated harness_features_consolidated and
-- engineer_issues as compat views but MISSED fleet_assignment. Because migrations
-- run once, mig 358 never re-creates it, so on every DB that applied 374 the view
-- is gone PERMANENTLY.
--
-- IMPACT (fleet-wide): every reader of harness_shared.fleet_assignment errored
-- with `relation "harness_shared.fleet_assignment" does not exist` —
--   fleet:assignments, hive:get, hive:list, scheduler bee-runs (scheduler:running),
--   work-items-stale-claims reclaim sweep, adv-roster, the UI fleet view, and the
--   fleet_assignment NOTIFY change-feed readers. The Queen's completion mandate
--   (drive every placement to terminal) depends on fleet:assignments, so this
--   blinded placement workspace-wide.
--
-- FIX: recreate ONLY the fleet_assignment view, verbatim from migration 358 (its
-- canonical body: alias-aware holder CTE + EI-311 nursery aliases + EI-395
-- improvement-runner exemption + the P-002 `stalled`/last_progress_at columns).
-- work_items is now a TABLE (post-374) carrying every column the 358 body needs
-- (verified: workspace_id, taken_by, harness_slug, source_plan_slug, feature_id,
-- item_kind, title, status, taken_at, assignee_rank, rank_writer,
-- last_progress_at), so the 358 body applies unchanged. We do NOT re-apply 358's
-- work_items VIEW def (work_items is a table now — CREATE OR REPLACE VIEW over a
-- table would fail).
--
-- CLASS / RECURRENCE: the failure class is "a migration DROP ... CASCADEs a base
-- relation and does not recreate the dependent views." The durable guard is the
-- integration test added alongside this migration asserting fleet_assignment
-- exists and is selectable (so a future cascade-drop fails CI, not production).
--
-- Idempotent: CREATE OR REPLACE VIEW. Safe to re-run; converges fresh DBs (which
-- get fleet_assignment from 358 then have it re-confirmed here) and 374-affected
-- DBs (which get it restored here).

\set ON_ERROR_STOP on
BEGIN;

CREATE OR REPLACE VIEW harness_shared.fleet_assignment AS
WITH presence AS (
  SELECT
    owner_id, owner_label, workspace_id, source, intent, current_plan_slug,
    heartbeat_at,
    (now() - heartbeat_at) < interval '10 minutes' AS alive
  FROM harness_shared.coord_presence
),
-- EI-311: holder-liveness resolution across identity aliases. Presence rows
-- first (they carry intent/plan); then every alias of a RUNNING nursery row
-- that lacks its own presence row, carrying the nursery process heartbeat.
holder AS (
  SELECT
    owner_id AS alias, owner_label, intent, current_plan_slug, heartbeat_at, alive
  FROM presence
  UNION ALL
  SELECT DISTINCT ON (a.alias)
    a.alias,
    ('bee · ' || left(n.spawn_id, 10)) AS owner_label,
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
  -- EI-395: a routine principal (improvement-runner) never heartbeats; its
  -- parked claim is not abandoned work, so it is never orphaned.
  (c.expires_ts > now() AND NOT COALESCE(p.alive, false) AND c.owner NOT IN ('improvement-runner')) AS orphaned,
  (p.current_plan_slug IS NOT DISTINCT FROM c.plan_slug)  AS declared_plan_matches,
  NULL::integer                                    AS assignee_rank,
  NULL::text                                       AS rank_writer,
  NULL::timestamptz                                AS last_progress_at,
  NULL::boolean                                    AS stalled  -- plan-item claims carry no progress signal
FROM harness_shared.plan_item_claims c
LEFT JOIN holder p ON p.alias = c.owner

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
  NULL::timestamptz,                               -- last_progress_at
  NULL::boolean                                    -- stalled
FROM harness_shared.plan_item_assignments a
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
  -- EI-395: see the plan_item_claim leg above — routine principals are exempt.
  (NOT COALESCE(p.alive, false) AND w.taken_by NOT IN ('improvement-runner')),
  CASE WHEN w.source_plan_slug IS NULL THEN NULL::boolean
       ELSE (p.current_plan_slug IS NOT DISTINCT FROM w.source_plan_slug) END,
  w.assignee_rank,                                 -- the per-assignee rank (P-021)
  w.rank_writer,                                   -- propose/dispose audit (D-008)
  w.last_progress_at,                              -- P-002: item-scoped progress signal
  -- stalled (agent-activity-liveness-truth P-002, D-001): the holder is ALIVE
  -- but the work is NOT advancing — no item-scoped progress in the 10-min window
  -- (a freshly-claimed row falls back to taken_at for the grace window). Mutually
  -- exclusive with orphaned (which requires NOT holder_alive). improvement-runner
  -- (parked routine lane, EI-395) is exempt, as it is from orphaned.
  (COALESCE(p.alive, false)
    AND w.taken_by NOT IN ('improvement-runner')
    AND (now() - COALESCE(w.last_progress_at, w.taken_at)) > interval '10 minutes') AS stalled
FROM harness_shared.work_items w
LEFT JOIN holder p ON p.alias = w.taken_by
WHERE w.taken_by IS NOT NULL AND w.taken_by <> ''
  AND COALESCE(w.status, '') NOT IN ('done', 'passed', 'deprecated', 'resolved', 'closed', 'dropped')

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
  NULL::timestamptz,                               -- last_progress_at
  NULL::boolean                                    -- stalled
FROM presence p;

COMMENT ON VIEW harness_shared.fleet_assignment IS
  'Canonical "who''s on what" (state-not-chat-fleet-state D-002): claim-primary union of plan_item_claims + plan_item_assignments + work-item claims (work_items.taken_by) + coord_presence, each claim LEFT-joined to its holder''s liveness. EI-311: holder liveness resolves through coord_presence AND the nursery''s identity aliases (spawned_agents spawn_id/session_owner/run_id, status=running, process heartbeat). orphaned = live lease, DEAD holder; stalled = live lease, ALIVE holder, no item-scoped progress in the 10-min window (agent-activity-liveness-truth P-002, D-001 — a claim is not progress) — both reclaimable, mutually exclusive, both EXCEPT routine principals (improvement-runner, EI-395). last_progress_at surfaces the raw progress signal. work-item rows carry assignee_rank + rank_writer (local-hive P-021/D-008). Restored by mig 375 after mig 374 DROP VIEW work_items CASCADE removed it. Read via fleet:assignments; change-feed on channel fleet_assignment.';

GRANT SELECT ON harness_shared.fleet_assignment TO harness_app;
DO $z$ BEGIN
  GRANT SELECT ON harness_shared.fleet_assignment TO harness_zero;
EXCEPTION WHEN undefined_object THEN NULL;
END $z$;

COMMIT;
