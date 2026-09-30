-- 430: canonical fleet membership = an APPEND-ONLY coord audience fact
-- (presence-coord-unification-2026-07-01 P-002 / WI-1345).
--
-- THE PROBLEM. Named-fleet membership lived ONLY as a soft, mutable label on the
-- ephemeral coord_presence row: coord_presence.fleet_slug/fleet_role (mig 418),
-- written by several independent paths (setPresenceFleet's authoritative UPDATE +
-- writePresence's env-fold COALESCE). It is INDEPENDENTLY MUTATED and, worse, it
-- DISAPPEARS when the presence reaper deletes the row on agent death — so "which
-- fleet was this now-dead batch in?" becomes unanswerable (the untraceable-batch
-- class). fleet_assignment.fleet_slug inherited the same fragility (it read the
-- live presence join, so it nulled the moment the holder went stale/reaped).
--
-- THE FIX (ONE SOURCE OF TRUTH). Canonical membership becomes an APPEND-ONLY fact:
-- harness_shared.fleet_membership_events — "agent X is (member|leader of|left)
-- fleet Y at T". Everything else is a PROJECTION of it:
--   • coord_presence.fleet_slug/fleet_role — a trigger-maintained denormalized
--     cache for the fast live-member reads. A DB GUARD rejects any direct mutation
--     of these columns (they may change ONLY via the projection trigger), and they
--     RE-MATERIALIZE from the durable fact whenever a (re)spawning agent's presence
--     row is created — so membership SURVIVES death instead of vanishing with the row.
--   • fleet_assignment.fleet_slug/fleet_role — now sourced from the append-only fact
--     (the latest event per owner), NOT the live presence join, so a dead agent's
--     claim rows still carry its fleet (never nulled on death).
--
-- Membership is now written ONLY by appending a fact (the app's fleet-membership-store
-- appendFleetMembershipEvent). "Who was ever in fleet X" is a pure history read over
-- the append-only log (indexed by fleet_slug) — the substrate coord:catch-up
-- @fleet:<slug> read (P-003) builds on.
--
-- The migration runner wraps each file in its own transaction, so this file carries
-- NO top-level BEGIN;/COMMIT; (migration-runner contract; files >=215, e.g. 277/418).
-- Fully idempotent: CREATE ... IF NOT EXISTS + CREATE OR REPLACE + guarded triggers +
-- NOT-EXISTS-guarded backfill + repeatable GRANTs.

-- ─────────────────────────────────────────────────────────────────────────────
-- (1) the append-only canonical membership ledger.
--     No RLS — matches the coord_* family (coord_presence/coord_event_log are all
--     RLS-free; the seam filters by workspace_id in-query). Append-only is enforced
--     at the grant level (harness_app gets SELECT + INSERT only, never UPDATE/DELETE).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS harness_shared.fleet_membership_events (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workspace_id text        NOT NULL DEFAULT 'default',
    owner_id     text        NOT NULL,
    owner_label  text,
    fleet_slug   text,                                  -- fleet joined; NULL = left / no fleet
    fleet_role   text,                                  -- 'leader' | 'member' | NULL
    event        text        NOT NULL DEFAULT 'join',   -- join | leave | lead | demote | backfill
    at           timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE harness_shared.fleet_membership_events IS
  'Canonical, APPEND-ONLY fleet membership fact (presence-coord-unification P-002 / WI-1345): "agent X is member|leader of / left fleet Y at T". The SINGLE source of truth for named-fleet membership. coord_presence.fleet_slug/fleet_role + the fleet_assignment view are PROJECTIONS of it (never independently mutated, never nulled on death). Current membership for an owner = the latest row (MAX id) per (workspace_id, owner_id); a NULL fleet_slug there = not in a fleet. "Who was ever in fleet X" = rows filtered by fleet_slug. Append-only (never UPDATE/DELETE) — history is the point.';

-- "latest event per (workspace, owner)" — the projection/current-membership read.
CREATE INDEX IF NOT EXISTS fleet_membership_events_owner_idx
  ON harness_shared.fleet_membership_events (workspace_id, owner_id, id DESC);
-- "who was ever in fleet X" — the audience/history read (P-003 catch-up @fleet:).
CREATE INDEX IF NOT EXISTS fleet_membership_events_fleet_idx
  ON harness_shared.fleet_membership_events (workspace_id, fleet_slug, id DESC)
  WHERE fleet_slug IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- (2) PROJECTION: mirror the just-appended fact onto the live coord_presence row.
--     Runs from the ledger's AFTER INSERT, so its UPDATE reaches the coord_presence
--     guard at pg_trigger_depth() >= 2 (the ONE permitted writer). No-op when the
--     agent has no live presence row (dead / not yet registered) — the fact stays
--     durable and re-materializes on the agent's next presence INSERT (part 3).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION harness_shared.project_fleet_membership()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  UPDATE harness_shared.coord_presence
     SET fleet_slug = CASE WHEN NEW.event = 'leave' THEN NULL ELSE NEW.fleet_slug END,
         fleet_role = CASE WHEN NEW.event = 'leave' THEN NULL ELSE NEW.fleet_role END
   WHERE workspace_id = NEW.workspace_id
     AND owner_id = NEW.owner_id;
  RETURN NULL;
END;
$fn$;

DROP TRIGGER IF EXISTS project_fleet_membership_trg ON harness_shared.fleet_membership_events;
CREATE TRIGGER project_fleet_membership_trg
  AFTER INSERT ON harness_shared.fleet_membership_events
  FOR EACH ROW EXECUTE FUNCTION harness_shared.project_fleet_membership();

-- ─────────────────────────────────────────────────────────────────────────────
-- (3) MATERIALIZE the projection when a presence row is (re)created. AFTER INSERT
--     fires ONLY on a genuine new row (the ON CONFLICT DO UPDATE heartbeat path fires
--     AFTER UPDATE, not AFTER INSERT) — so the hot per-heartbeat path pays nothing.
--     A (re)spawning agent re-acquires its durable fleet membership from the fact:
--     this is what makes membership SURVIVE the reaper deleting the row on death.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION harness_shared.materialize_presence_fleet()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  UPDATE harness_shared.coord_presence cp
     SET fleet_slug = e.fleet_slug,
         fleet_role = e.fleet_role
    FROM (
      SELECT CASE WHEN event = 'leave' THEN NULL ELSE fleet_slug END AS fleet_slug,
             CASE WHEN event = 'leave' THEN NULL ELSE fleet_role END AS fleet_role
        FROM harness_shared.fleet_membership_events
       WHERE workspace_id = NEW.workspace_id AND owner_id = NEW.owner_id
       ORDER BY id DESC
       LIMIT 1
    ) e
   WHERE cp.workspace_id = NEW.workspace_id AND cp.owner_id = NEW.owner_id;
  RETURN NULL;
END;
$fn$;

DROP TRIGGER IF EXISTS materialize_presence_fleet_trg ON harness_shared.coord_presence;
CREATE TRIGGER materialize_presence_fleet_trg
  AFTER INSERT ON harness_shared.coord_presence
  FOR EACH ROW EXECUTE FUNCTION harness_shared.materialize_presence_fleet();

-- ─────────────────────────────────────────────────────────────────────────────
-- (4) GUARD: coord_presence.fleet_slug/fleet_role are a PROJECTION — reject any
--     DIRECT (app-issued) mutation. The projection writers (parts 2 & 3) reach here
--     from WITHIN their own triggers, so pg_trigger_depth() >= 2 there; a direct
--     UPDATE runs at depth 1 (or 0 with triggers disabled). The trigger's WHEN clause
--     fires the function ONLY when a fleet column actually changes, so the hot
--     heartbeat path (which never touches these columns) pays nothing.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION harness_shared.coord_presence_fleet_guard()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION
      'coord_presence.fleet_slug/fleet_role is a PROJECTION of harness_shared.fleet_membership_events (append-only membership fact, WI-1345); change membership by appending an event, never by mutating coord_presence directly'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS coord_presence_fleet_guard_trg ON harness_shared.coord_presence;
CREATE TRIGGER coord_presence_fleet_guard_trg
  BEFORE UPDATE ON harness_shared.coord_presence
  FOR EACH ROW
  WHEN (NEW.fleet_slug IS DISTINCT FROM OLD.fleet_slug
        OR NEW.fleet_role IS DISTINCT FROM OLD.fleet_role)
  EXECUTE FUNCTION harness_shared.coord_presence_fleet_guard();

-- ─────────────────────────────────────────────────────────────────────────────
-- (5) BACKFILL: seed the ledger from the CURRENT live labels so existing members
--     keep their membership across this migration. Only owners that carry a label
--     AND have no ledger row yet (idempotent; safe on re-apply). Firing the
--     projection trigger here just re-sets the same value (no-op change).
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO harness_shared.fleet_membership_events
  (workspace_id, owner_id, owner_label, fleet_slug, fleet_role, event)
SELECT cp.workspace_id, cp.owner_id, NULLIF(cp.owner_label, ''), cp.fleet_slug, cp.fleet_role, 'backfill'
  FROM harness_shared.coord_presence cp
 WHERE cp.fleet_slug IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM harness_shared.fleet_membership_events e
      WHERE e.workspace_id = cp.workspace_id AND e.owner_id = cp.owner_id
   );

-- ─────────────────────────────────────────────────────────────────────────────
-- (6) fleet_assignment view — source fleet_slug/fleet_role from the append-only
--     FACT (latest event per owner) instead of the live presence join, so it is a
--     projection of the fact and survives agent death. Body = mig 418 verbatim EXCEPT
--     the fleet columns now come from the `membership` CTE (a LEFT JOIN per leg).
--     CREATE OR REPLACE keeps the exact output column set/order/types.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW harness_shared.fleet_assignment AS
WITH presence AS (
  SELECT
    owner_id, owner_label, workspace_id, source, intent, current_plan_slug,
    heartbeat_at,
    (now() - heartbeat_at) < interval '10 minutes' AS alive
  FROM harness_shared.coord_presence
),
-- EI-311: holder-liveness resolution across identity aliases. Presence rows first
-- (they carry intent/plan); then every alias of a RUNNING nursery row that lacks
-- its own presence row, carrying the nursery process heartbeat.
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
-- WI-1345: canonical membership = the latest append-only fact per owner. This is the
-- PROJECTION source for fleet_slug/fleet_role — survives death (no presence-join
-- dependency), so a dead agent's claim rows still carry its fleet.
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
  -- EI-395: a routine principal (improvement-runner) never heartbeats; its
  -- parked claim is not abandoned work, so it is never orphaned.
  (c.expires_ts > now() AND NOT COALESCE(p.alive, false) AND c.owner NOT IN ('improvement-runner')) AS orphaned,
  (p.current_plan_slug IS NOT DISTINCT FROM c.plan_slug)  AS declared_plan_matches,
  NULL::integer                                    AS assignee_rank,
  NULL::text                                       AS rank_writer,
  NULL::timestamptz                                AS last_progress_at,
  NULL::boolean                                    AS stalled,  -- plan-item claims carry no progress signal
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
  NULL::timestamptz,                               -- last_progress_at
  NULL::boolean,                                   -- stalled
  m.fleet_slug,                                    -- name-keyed: matches only if assignee_name IS an owner_id
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
  m.fleet_slug,                                    -- the holder's named-fleet membership, from the append-only fact (WI-1345)
  m.fleet_role
FROM harness_shared.work_items w
LEFT JOIN holder p ON p.alias = w.taken_by
LEFT JOIN membership m ON m.workspace_id = w.workspace_id AND m.owner_id = w.taken_by
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
  m.fleet_slug,                                    -- the presence backbone carries the fleet label, from the fact (WI-1345)
  m.fleet_role
FROM presence p
LEFT JOIN membership m ON m.workspace_id = p.workspace_id AND m.owner_id = p.owner_id;

COMMENT ON VIEW harness_shared.fleet_assignment IS
  'Canonical "who''s on what" (state-not-chat-fleet-state D-002): claim-primary union of plan_item_claims + plan_item_assignments + work-item claims (work_items.taken_by) + coord_presence, each claim LEFT-joined to its holder''s liveness. EI-311: holder liveness resolves through coord_presence AND the nursery''s identity aliases (spawned_agents spawn_id/session_owner/run_id, status=running, process heartbeat). orphaned = live lease, DEAD holder; stalled = live lease, ALIVE holder, no item-scoped progress in the 10-min window (agent-activity-liveness-truth P-002, D-001 — a claim is not progress) — both reclaimable, mutually exclusive, both EXCEPT routine principals (improvement-runner, EI-395). last_progress_at surfaces the raw progress signal. work-item rows carry assignee_rank + rank_writer (local-hive P-021/D-008). fleet_slug/fleet_role are a PROJECTION of the APPEND-ONLY membership fact harness_shared.fleet_membership_events (presence-coord-unification P-002 / WI-1345) — latest event per owner, so they survive agent death instead of nulling with the reaped presence row. Read via fleet:assignments; change-feed on channel fleet_assignment.';

GRANT SELECT ON harness_shared.fleet_assignment TO harness_app;
GRANT SELECT, INSERT ON harness_shared.fleet_membership_events TO harness_app;
DO $z$ BEGIN
  GRANT SELECT ON harness_shared.fleet_assignment TO harness_zero;
  GRANT SELECT ON harness_shared.fleet_membership_events TO harness_zero;
EXCEPTION WHEN undefined_object THEN NULL;
END $z$;
