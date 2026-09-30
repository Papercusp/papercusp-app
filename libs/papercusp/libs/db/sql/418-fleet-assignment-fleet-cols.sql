-- 418: coord_presence fleet membership + fleet_assignment view fleet columns
-- (named-su-agent-fleets-2026-06-29 P-005).
--
-- Migration 417 added fleet_slug/fleet_role to harness_shared.shared_presence — the
-- DEVICE-keyed federation/lock-authority presence (the mig-187 hive_slug analog). But
-- the per-AGENT COORDINATION presence (what coord:presence / coord:whoami / listPresence
-- and the fleet_assignment view read) lives on harness_shared.coord_presence, where
-- hive_slug was added by mig 277. So this migration adds the SAME per-agent fleet label
-- to coord_presence — the EXACT mirror of how 277 added hive_slug there — so a fleet
-- member's membership rides its coordination presence row.
--
-- Two parts:
--  (1) coord_presence.fleet_slug / fleet_role — the SOFT, ephemeral membership label an
--      agent carries WHILE ALIVE (mirrors mig 277 hive_slug). Nullable: an agent in no
--      named fleet keeps both NULL (back-compat). + a partial index for the live-member
--      count + fleet-scoped reads (mirrors 277's coord_presence_hive_idx).
--  (2) recreate harness_shared.fleet_assignment (canonical body = mig 375) to ALSO
--      surface fleet_slug/fleet_role from the presence join — the holder's named-fleet
--      membership rides every row, exactly alongside the existing holder fields. Only
--      change vs 375: fleet_slug/fleet_role appended to the holder + presence CTEs and to
--      each UNION branch's column list (CREATE OR REPLACE VIEW permits appending columns
--      to the END of the list). Read via fleet:assignments (typed in fleet/assignments.ts).
--
-- The migration runner wraps each file in its own transaction, so this file carries NO
-- top-level BEGIN;/COMMIT; (migration-runner contract; files >=215, e.g. mig 277/417).
-- Fully idempotent: ADD COLUMN IF NOT EXISTS + CREATE OR REPLACE VIEW + repeatable GRANTs.

-- (1) per-agent fleet membership label on coord_presence (mirror mig 277 hive_slug).
ALTER TABLE harness_shared.coord_presence
  ADD COLUMN IF NOT EXISTS fleet_slug text,
  ADD COLUMN IF NOT EXISTS fleet_role text;

CREATE INDEX IF NOT EXISTS coord_presence_fleet_idx
  ON harness_shared.coord_presence (workspace_id, fleet_slug)
  WHERE fleet_slug IS NOT NULL;

-- (2) recreate the canonical "who's on what" view (mig 375 body) + fleet_slug/fleet_role.
CREATE OR REPLACE VIEW harness_shared.fleet_assignment AS
WITH presence AS (
  SELECT
    owner_id, owner_label, workspace_id, source, intent, current_plan_slug,
    heartbeat_at,
    fleet_slug, fleet_role,
    (now() - heartbeat_at) < interval '10 minutes' AS alive
  FROM harness_shared.coord_presence
),
-- EI-311: holder-liveness resolution across identity aliases. Presence rows first
-- (they carry intent/plan/fleet); then every alias of a RUNNING nursery row that lacks
-- its own presence row, carrying the nursery process heartbeat (no fleet label).
holder AS (
  SELECT
    owner_id AS alias, owner_label, intent, current_plan_slug, heartbeat_at, alive,
    fleet_slug, fleet_role
  FROM presence
  UNION ALL
  SELECT DISTINCT ON (a.alias)
    a.alias,
    ('bee · ' || left(n.spawn_id, 10)) AS owner_label,
    NULL::text                          AS intent,
    NULL::text                          AS current_plan_slug,
    n.heartbeat_at,
    (n.heartbeat_at IS NOT NULL
      AND (now() - n.heartbeat_at) < interval '10 minutes') AS alive,
    NULL::text                          AS fleet_slug,
    NULL::text                          AS fleet_role
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
  NULL::boolean                                    AS stalled,  -- plan-item claims carry no progress signal
  p.fleet_slug                                     AS fleet_slug,
  p.fleet_role                                     AS fleet_role
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
  NULL::boolean,                                   -- stalled
  NULL::text,                                      -- fleet_slug (name-keyed: no presence join)
  NULL::text                                       -- fleet_role
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
    AND (now() - COALESCE(w.last_progress_at, w.taken_at)) > interval '10 minutes') AS stalled,
  p.fleet_slug,                                    -- the holder's named-fleet membership (P-005)
  p.fleet_role
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
  NULL::boolean,                                   -- stalled
  p.fleet_slug,                                    -- the presence backbone carries the fleet label (P-005)
  p.fleet_role
FROM presence p;

COMMENT ON VIEW harness_shared.fleet_assignment IS
  'Canonical "who''s on what" (state-not-chat-fleet-state D-002): claim-primary union of plan_item_claims + plan_item_assignments + work-item claims (work_items.taken_by) + coord_presence, each claim LEFT-joined to its holder''s liveness. EI-311: holder liveness resolves through coord_presence AND the nursery''s identity aliases (spawned_agents spawn_id/session_owner/run_id, status=running, process heartbeat). orphaned = live lease, DEAD holder; stalled = live lease, ALIVE holder, no item-scoped progress in the 10-min window (agent-activity-liveness-truth P-002, D-001 — a claim is not progress) — both reclaimable, mutually exclusive, both EXCEPT routine principals (improvement-runner, EI-395). last_progress_at surfaces the raw progress signal. work-item rows carry assignee_rank + rank_writer (local-hive P-021/D-008). fleet_slug/fleet_role surface the holder''s named-fleet membership (named-su-agent-fleets P-005; the SOFT coord_presence label, mig 418). Read via fleet:assignments; change-feed on channel fleet_assignment.';

GRANT SELECT ON harness_shared.fleet_assignment TO harness_app;
DO $z$ BEGIN
  GRANT SELECT ON harness_shared.fleet_assignment TO harness_zero;
EXCEPTION WHEN undefined_object THEN NULL;
END $z$;
