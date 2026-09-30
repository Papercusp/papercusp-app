-- Migration 225 — EI-311: alias-aware holder liveness in fleet_assignment.
--
-- A spawned bee has THREE identity aliases: the nursery spawn_id (s-…, ==
-- session_owner, the umbilical client=), and the per-invocation run_id
-- (opspawn-…). Claims are SUPPOSED to key to the spawnId, but a degraded bee
-- (MCP unmounted → raw-HTTP fallback) self-identified by the only id its
-- prompt showed — the run_id — and a short-lived bee may never write a
-- coord_presence row at all. Migrations 165/178 joined holder liveness on
-- coord_presence.owner_id = claim owner EXACTLY, so such a bee read
-- present:false / orphaned:true while demonstrably alive (live repro WI-122,
-- 2026-06-11).
--
-- Fix (the EI-295 reader-side-reconciliation pattern, applied to identity
-- domains): holder liveness now resolves through a `holder` CTE that unions
--   1. coord_presence rows (as before — the richest source: intent/plan), and
--   2. RUNNING spawned_agents rows, addressable by EVERY alias (spawn_id,
--      session_owner, run_id) that has no presence row of its own — the
--      nursery's process heartbeat_at IS the liveness for a bee that never
--      declared intent.
-- A finished spawn emits no holder row (status <> 'running'), so a claim
-- whose bee exited still reads orphaned — that signal is the view's point.
--
-- Based on the 178 definition (work-item legs carry assignee_rank +
-- rank_writer — preserved verbatim); only the liveness join changes.
-- Idempotent: CREATE OR REPLACE VIEW.

-- (transaction control removed post-apply: the runner provides the
--  transaction — lint:migrations P-074; file already applied + ledgered,
--  so this edit only affects fresh installs, where nested BEGIN warned.)

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
-- DISTINCT ON (alias): spawn_id and session_owner are usually the same string,
-- and an alias can never belong to two spawns (ids are unique per spawn).
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
  (c.expires_ts > now() AND NOT COALESCE(p.alive, false)) AS orphaned,
  (p.current_plan_slug IS NOT DISTINCT FROM c.plan_slug)  AS declared_plan_matches,
  NULL::integer                                    AS assignee_rank,
  NULL::text                                       AS rank_writer
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
  NULL::text
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
  (NOT COALESCE(p.alive, false)),
  CASE WHEN w.source_plan_slug IS NULL THEN NULL::boolean
       ELSE (p.current_plan_slug IS NOT DISTINCT FROM w.source_plan_slug) END,
  w.assignee_rank,                                 -- the per-assignee rank (P-021)
  w.rank_writer                                    -- propose/dispose audit (D-008)
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
  NULL::text
FROM presence p;

COMMENT ON VIEW harness_shared.fleet_assignment IS
  'Canonical "who''s on what" (state-not-chat-fleet-state D-002): claim-primary union of plan_item_claims + plan_item_assignments + work-item claims (work_items.taken_by) + coord_presence, each claim LEFT-joined to its holder''s liveness. EI-311: holder liveness resolves through coord_presence AND the nursery''s identity aliases (spawned_agents spawn_id/session_owner/run_id, status=running, process heartbeat) so a spawned bee''s claims read alive under ANY of its ids. orphaned = live lease, dead holder. work-item rows carry assignee_rank + rank_writer (local-hive P-021/D-008). Read via fleet:assignments; change-feed on channel fleet_assignment.';

GRANT SELECT ON harness_shared.fleet_assignment TO harness_app;
DO $z$ BEGIN
  GRANT SELECT ON harness_shared.fleet_assignment TO harness_zero;
EXCEPTION WHEN undefined_object THEN NULL;
END $z$;

