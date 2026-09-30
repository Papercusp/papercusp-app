-- 668-fleet-assignment-fleet-slug-workspace-mismatch.sql
--
-- EI-18690480039212432: fleet:assignments returned agents[].fleet = null for a
-- LIVE fleet member that fleet:status correctly reported as a member (fleetRole:
-- 'member', sessionState:'live', 305 tool_invocations in the prior 15 min). A
-- leader filtering assignments by the `fleet` field undercounted its own fleet
-- and nearly treated a live, actively-working member as having dropped out.
--
-- ROOT CAUSE. harness_shared.fleet_assignment's claim legs (plan_item_claim,
-- plan_item_assignment, work_item_claim) each LEFT JOIN the `membership` CTE
-- (the latest harness_shared.fleet_membership_events row per owner) keyed on
-- THAT CLAIM ROW's own `workspace_id` column. But per the already-documented
-- EI-295 workspace-scoping split (fleet/assignments.ts listFleetAssignments):
-- presence stamps the AGENT's real workspace (e.g. 'papercusp-workspace'), while
-- plan-item claims/work-items frequently stamp the PLAN-STORE scope
-- (DEFAULT_WORKSPACE_ID) — a DIFFERENT workspace domain. fleet_membership_events
-- rows are appended under the agent's REAL workspace (presence.ts
-- appendFleetMembershipEvent), so a claim-leg join keyed on the claim's own
-- (plan-store) workspace_id silently misses that membership row and returns
-- fleet_slug=NULL, even though the SAME agent's presence-leg row (correctly
-- keyed on its own real workspace_id) would resolve it fine.
--
-- fleet:status reads coord_presence.fleet_slug directly (the trigger-maintained
-- projection materialized at the agent's own real workspace) so it never hits
-- this mismatch — only fleet:assignments' separate re-derivation off the claim
-- row's workspace_id does, which is why the two tools disagreed.
--
-- FIX. Resolve the holder's REAL workspace via the already-joined `holder` CTE
-- (which resolves presence identity by owner_id/alias) and prefer THAT for the
-- membership join, falling back to the claim row's own workspace_id only when
-- no holder is resolvable (a dead/unknown agent — the pre-existing behavior,
-- preserved as the fallback so an orphaned claim with no live/known holder is
-- no worse off than before). Adds `workspace_id` to the `holder` CTE (both the
-- presence leg and the spawned_agents/nursery-alias leg) and threads
-- COALESCE(p.workspace_id, <row>.workspace_id) into the three claim-leg
-- membership joins. The presence leg's own join is already correct (a presence
-- row's workspace_id IS its own real workspace) and is left untouched. Also
-- extends the plan_item_assignment leg with a `holder` join it previously
-- lacked entirely, so a name-keyed assignment whose assignee_name happens to be
-- a real ownerId benefits from the same fix instead of being permanently
-- unfixable.
--
-- CREATE OR REPLACE keeps the exact output column set/order/types (body
-- otherwise verbatim from mig 666).
--
-- The migration runner wraps each file in its own transaction, so this file
-- carries NO top-level BEGIN;/COMMIT; (migration-runner contract; files >=215,
-- e.g. 277/418/430/666).

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
  (p.current_plan_slug IS NOT DISTINCT FROM c.plan_slug)  AS declared_plan_matches,
  NULL::integer                                    AS assignee_rank,
  NULL::text                                       AS rank_writer,
  NULL::timestamptz                                AS last_progress_at,
  NULL::boolean                                    AS stalled,
  m.fleet_slug                                     AS fleet_slug,
  m.fleet_role                                     AS fleet_role
FROM harness_shared.plan_item_claims c
LEFT JOIN holder p ON p.alias = c.owner
-- EI-18690480039212432: prefer the HOLDER's real (presence/nursery) workspace
-- for the membership lookup — that is where fleet_membership_events is
-- actually appended (presence.ts) — falling back to the claim's own (often
-- plan-store-scoped) workspace_id only when no holder resolves at all.
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
-- Name-keyed: only resolves when assignee_name IS a real ownerId (pre-existing
-- caveat, unchanged) — but when it does, benefit from the same real-workspace fix.
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
    AND (now() - COALESCE(w.last_progress_at, w.taken_at)) > interval '10 minutes') AS stalled,
  m.fleet_slug,
  m.fleet_role
FROM harness_shared.work_items w
LEFT JOIN holder p ON p.alias = w.taken_by
LEFT JOIN membership m ON m.workspace_id = COALESCE(p.workspace_id, w.workspace_id) AND m.owner_id = w.taken_by
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
-- A presence row's OWN workspace_id already IS its real workspace — no
-- mismatch possible here, so this join is unchanged.
FROM presence p
LEFT JOIN membership m ON m.workspace_id = p.workspace_id AND m.owner_id = p.owner_id;

COMMENT ON VIEW harness_shared.fleet_assignment IS
  'Canonical "who''s on what" (state-not-chat-fleet-state D-002): claim-primary union of plan_item_claims + plan_item_assignments + work-item claims (work_items.taken_by) + coord_presence, each claim LEFT-joined to its holder''s liveness. EI-311: holder liveness resolves through coord_presence AND the nursery''s identity aliases (spawned_agents spawn_id/session_owner/run_id, status=running, process heartbeat). orphaned = live lease, DEAD holder; stalled = live lease, ALIVE holder, no item-scoped progress in the 10-min window (agent-activity-liveness-truth P-002, D-001 — a claim is not progress) — both reclaimable, mutually exclusive, both EXCEPT routine principals (improvement-runner, EI-395). The work_item_claim leg excludes terminal statuses (done/passed/deprecated/resolved/closed/dropped) AND the two correctly-parked statuses needs-human/blocked (EI-18688119768148709) — none of those are live actionable claims. last_progress_at surfaces the raw progress signal. work-item rows carry assignee_rank + rank_writer (local-hive P-021/D-008). fleet_slug/fleet_role are a PROJECTION of the APPEND-ONLY membership fact harness_shared.fleet_membership_events (presence-coord-unification P-002 / WI-1345) — latest event per owner, so they survive agent death instead of nulling with the reaped presence row; the membership join is keyed on the HOLDER''s real (presence/nursery) workspace when resolvable, not the claim row''s own possibly plan-store-scoped workspace_id (EI-18690480039212432), falling back to the claim''s own workspace_id only for an unresolvable holder. Read via fleet:assignments; change-feed on channel fleet_assignment.';
