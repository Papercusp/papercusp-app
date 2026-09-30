-- 666-fleet-assignment-exclude-parked-statuses.sql
--
-- EI-18688119768148709: fleet:assignments' stalled[] falsely flagged
-- correctly-parked work-items as reclaimable stalled claims. The
-- work_item_claim leg of harness_shared.fleet_assignment (mig 430) already
-- excludes terminal statuses (done/passed/deprecated/resolved/closed/dropped)
-- but NOT the two "correctly not advancing on purpose" statuses in the
-- work-item-status-full-unify unified enum: `needs-human` (parked on a human
-- gate) and `blocked` (legitimately blocked, with a recorded reason). Both
-- statuses are excluded from claim_next/scheduler:get_next by design
-- (set_state.ts EI-9360) precisely because they are NOT actionable — yet the
-- view still surfaced them as live claims, so a holder-alive + no-progress
-- item sitting correctly parked was flagged `stalled = true`, inviting the
-- exact wasteful re-placement cycle EI-8529 already paid for once.
--
-- Live-verified before this fix: EI-11110 (needs-human) and WI-5806 (blocked)
-- both appeared in fleet:assignments' stalled[] despite being correctly
-- parked, not stuck.
--
-- Fix: widen the work_item_claim leg's terminal-status exclusion to also
-- drop `needs-human` and `blocked`. CREATE OR REPLACE keeps the exact output
-- column set/order/types (body otherwise verbatim from mig 430).
--
-- The migration runner wraps each file in its own transaction, so this file
-- carries NO top-level BEGIN;/COMMIT; (migration-runner contract; files
-- >=215, e.g. 277/418/430).

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
  (p.current_plan_slug IS NOT DISTINCT FROM c.plan_slug)  AS declared_plan_matches,
  NULL::integer                                    AS assignee_rank,
  NULL::text                                       AS rank_writer,
  NULL::timestamptz                                AS last_progress_at,
  NULL::boolean                                    AS stalled,
  m.fleet_slug                                     AS fleet_slug,
  m.fleet_role                                     AS fleet_role
FROM harness_shared.plan_item_claims c
LEFT JOIN holder p ON p.alias = c.owner
LEFT JOIN membership m ON m.workspace_id = c.workspace_id AND m.owner_id = c.owner

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
LEFT JOIN membership m ON m.workspace_id = a.workspace_id AND m.owner_id = a.assignee_name
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
    AND (now() - COALESCE(w.last_progress_at, w.taken_at)) > interval '10 minutes') AS stalled,
  m.fleet_slug,
  m.fleet_role
FROM harness_shared.work_items w
LEFT JOIN holder p ON p.alias = w.taken_by
LEFT JOIN membership m ON m.workspace_id = w.workspace_id AND m.owner_id = w.taken_by
WHERE w.taken_by IS NOT NULL AND w.taken_by <> ''
  -- EI-18688119768148709: `needs-human` and `blocked` joined the terminal
  -- exclusions here — both are CORRECTLY-parked statuses (excluded from
  -- claim_next/scheduler:get_next by design, EI-9360), not stuck work, so a
  -- holder-alive + no-progress row in either status must never read as
  -- `stalled`/reclaimable.
  AND COALESCE(w.status, '') NOT IN ('done', 'passed', 'deprecated', 'resolved', 'closed', 'dropped', 'needs-human', 'blocked')

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
  'Canonical "who''s on what" (state-not-chat-fleet-state D-002): claim-primary union of plan_item_claims + plan_item_assignments + work-item claims (work_items.taken_by) + coord_presence, each claim LEFT-joined to its holder''s liveness. EI-311: holder liveness resolves through coord_presence AND the nursery''s identity aliases (spawned_agents spawn_id/session_owner/run_id, status=running, process heartbeat). orphaned = live lease, DEAD holder; stalled = live lease, ALIVE holder, no item-scoped progress in the 10-min window (agent-activity-liveness-truth P-002, D-001 — a claim is not progress) — both reclaimable, mutually exclusive, both EXCEPT routine principals (improvement-runner, EI-395). The work_item_claim leg excludes terminal statuses (done/passed/deprecated/resolved/closed/dropped) AND the two correctly-parked statuses needs-human/blocked (EI-18688119768148709) — none of those are live actionable claims. last_progress_at surfaces the raw progress signal. work-item rows carry assignee_rank + rank_writer (local-hive P-021/D-008). fleet_slug/fleet_role are a PROJECTION of the APPEND-ONLY membership fact harness_shared.fleet_membership_events (presence-coord-unification P-002 / WI-1345) — latest event per owner, so they survive agent death instead of nulling with the reaped presence row. Read via fleet:assignments; change-feed on channel fleet_assignment.';
