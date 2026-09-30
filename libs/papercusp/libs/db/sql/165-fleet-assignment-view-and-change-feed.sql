-- Migration 165 — harness_shared.fleet_assignment: the canonical "who's on what"
-- view + its NOTIFY change-feed.
--
-- Plan: state-not-chat-fleet-state-2026-06-05 (P-001 view / P-005 change-feed).
--
-- D-002: "is agent X on plan P / who's on what" was fragmented across three
-- representations with no single query — coord_presence.current_plan_slug (live,
-- self-declared), plan_item_claims/plan_item_assignments (durable per-item claim,
-- plan-item-assignment-claim-liveness), and work_items.taken_by (durable per-work-item).
-- This view unifies them at READ time (no schema consolidation — that is explicitly
-- out of scope; the underlying tables keep their owners).
--
-- CLAIM-PRIMARY, not presence-primary: a claim can outlive its holder's presence
-- (agent crashes; lease persists). That orphaned claim — a live lease whose holder
-- is absent/stale — is the single most important signal (abandoned/stuck work), so
-- every claim row carries its holder's liveness LEFT-joined in (`holder_alive`,
-- `orphaned`). A presence-primary join would silently drop it. Presence rows ride
-- along as the by-agent backbone (source='presence') so "what is X doing" includes
-- idle agents.
--
-- Liveness: alive = heartbeat within 10 minutes — mirrors PRESENCE_STALE_MS
-- (libs/generic/pubsub-substrate/src/presence/types.ts). Keep in sync.
--
-- Change-feed (D-003): state-changes ride PG NOTIFY on the TABLES (channel
-- 'fleet_assignment', payload '<workspace_id>::<source>::<agent_id>'), not the coord
-- message stream. The table write IS the record; the lifecycle coord message is a
-- human-readable projection of it. Triggers fire on MEANINGFUL changes only:
-- heartbeat-only presence bumps and lease-renewal claim updates do NOT notify
-- (they would otherwise fire on every tool call across the fleet). Listener-less
-- NOTIFY is a cheap no-op (mirrors migrations 126/143).
--
-- Composes onto 000-baseline.sql + 131 (engineer_issues) + 140/141 (plan-item
-- assignment/claims) + 159 (work_items union view). Idempotent: CREATE OR REPLACE +
-- DROP TRIGGER IF EXISTS; repeatable GRANTs. Runs as harness_admin.

\set ON_ERROR_STOP on
BEGIN;

-- ── claim-side indexes the view's work-item branch wants (cheap, partial) ──────
CREATE INDEX IF NOT EXISTS hfc_taken_by_idx
  ON harness_shared.harness_features_consolidated USING btree (workspace_id, taken_by)
  WHERE taken_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS engineer_issues_assignee_idx
  ON harness_shared.engineer_issues USING btree (workspace_id, assignee)
  WHERE assignee IS NOT NULL;

-- ── the canonical view ─────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW harness_shared.fleet_assignment AS
WITH presence AS (
  SELECT
    owner_id,
    owner_label,
    workspace_id,
    source,
    intent,
    current_plan_slug,
    heartbeat_at,
    (now() - heartbeat_at) < interval '10 minutes' AS alive
  FROM harness_shared.coord_presence
)
-- 1) plan-item CLAIMS (the lease) — claim-primary, holder liveness joined in.
--    Lapsed-but-unreleased rows are kept (claim_active=false): they are the trail
--    of abandoned work; the reader filters.
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
  (p.owner_id IS NOT NULL)                         AS holder_present,
  COALESCE(p.alive, false)                         AS holder_alive,
  p.heartbeat_at                                   AS holder_heartbeat_at,
  p.intent                                         AS holder_intent,
  p.current_plan_slug                              AS holder_plan_slug,
  -- THE signal: a live lease whose holder is gone or stale = abandoned/stuck work.
  (c.expires_ts > now() AND NOT COALESCE(p.alive, false)) AS orphaned,
  -- Self-declared plan vs the real claim — a mismatch is itself a smell (D-002).
  (p.current_plan_slug IS NOT DISTINCT FROM c.plan_slug)  AS declared_plan_matches
FROM harness_shared.plan_item_claims c
LEFT JOIN presence p ON p.owner_id = c.owner

UNION ALL
-- 2) plan-item ASSIGNMENTS (durable intent; agent-NAME-keyed, so no presence join —
--    liveness is unknowable for a name with no live claim).
SELECT
  'plan_item_assignment'::text,
  a.workspace_id,
  a.assignee_name,                                 -- name-keyed agent_id
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
  true,                                            -- active (released rows filtered below)
  NULL::text,
  a.updated_at,
  false,
  false,
  NULL::timestamptz,
  NULL::text,
  NULL::text,
  false,
  NULL::boolean
FROM harness_shared.plan_item_assignments a
WHERE a.assignee_name IS NOT NULL AND a.released_ts IS NULL

UNION ALL
-- 3) work-item CLAIMS — the unified work_items surface (features.taken_by ∪
--    issues.assignee, migration 159). Non-terminal items only.
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
  (p.owner_id IS NOT NULL),
  COALESCE(p.alive, false),
  p.heartbeat_at,
  p.intent,
  p.current_plan_slug,
  (NOT COALESCE(p.alive, false)),                  -- taken + holder gone = orphaned
  CASE WHEN w.source_plan_slug IS NULL THEN NULL::boolean
       ELSE (p.current_plan_slug IS NOT DISTINCT FROM w.source_plan_slug) END
FROM harness_shared.work_items w
LEFT JOIN presence p ON p.owner_id = w.taken_by
WHERE w.taken_by IS NOT NULL AND w.taken_by <> ''
  AND COALESCE(w.status, '') NOT IN ('done', 'passed', 'deprecated', 'resolved', 'closed', 'dropped')

UNION ALL
-- 4) PRESENCE backbone — every agent row (idle agents included), so the by-agent
--    projection ("what is X doing") is complete even when X holds nothing.
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
  NULL::boolean
FROM presence p;

COMMENT ON VIEW harness_shared.fleet_assignment IS
  'Canonical "who''s on what" (state-not-chat-fleet-state D-002): claim-primary union of plan_item_claims + plan_item_assignments + work-item claims (work_items.taken_by) + coord_presence, each claim LEFT-joined to its holder''s presence. orphaned = live lease, dead holder (the abandoned-work signal). Read via fleet:assignments; change-feed on channel fleet_assignment. Query the view for state — never reconstruct state from coord messages (D-001).';

GRANT SELECT ON harness_shared.fleet_assignment TO harness_app;
DO $z$ BEGIN
  GRANT SELECT ON harness_shared.fleet_assignment TO harness_zero;
EXCEPTION WHEN undefined_object THEN NULL;
END $z$;

-- ── the change-feed (D-003) ────────────────────────────────────────────────────
-- One trigger function, branched on TG_TABLE_NAME / TG_OP. Payload mirrors the
-- 126/143 convention: '<workspace_id>::<source>::<agent_id>'.
CREATE OR REPLACE FUNCTION harness_shared.notify_fleet_assignment() RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
DECLARE
  rec record;
  src text;
  agent text;
BEGIN
  IF TG_OP = 'DELETE' THEN rec := OLD; ELSE rec := NEW; END IF;
  CASE TG_TABLE_NAME
    WHEN 'coord_presence' THEN
      src := 'presence';            agent := rec.owner_id;
    WHEN 'plan_item_claims' THEN
      src := 'plan_item_claim';     agent := rec.owner;
    WHEN 'plan_item_assignments' THEN
      src := 'plan_item_assignment';
      -- on release/unassign NEW.assignee_name may be NULL — fall back to OLD's.
      agent := COALESCE(rec.assignee_name, CASE WHEN TG_OP = 'UPDATE' THEN OLD.assignee_name END);
    WHEN 'harness_features_consolidated' THEN
      src := 'work_item_claim';
      agent := COALESCE(rec.taken_by, CASE WHEN TG_OP = 'UPDATE' THEN OLD.taken_by END);
    WHEN 'engineer_issues' THEN
      src := 'work_item_claim';
      agent := COALESCE(rec.assignee, CASE WHEN TG_OP = 'UPDATE' THEN OLD.assignee END);
    ELSE
      src := TG_TABLE_NAME;         agent := NULL;
  END CASE;
  PERFORM pg_notify('fleet_assignment',
    COALESCE(rec.workspace_id, '') || '::' || src || '::' || COALESCE(agent, ''));
  RETURN rec;
END;
$fn$;

-- coord_presence: insert/delete always; UPDATE only on a MEANINGFUL change —
-- heartbeat-only bumps (every tool call, fleet-wide) must NOT notify.
DROP TRIGGER IF EXISTS fleet_assignment_presence_ins_del_trg ON harness_shared.coord_presence;
CREATE TRIGGER fleet_assignment_presence_ins_del_trg
  AFTER INSERT OR DELETE ON harness_shared.coord_presence
  FOR EACH ROW EXECUTE FUNCTION harness_shared.notify_fleet_assignment();
DROP TRIGGER IF EXISTS fleet_assignment_presence_upd_trg ON harness_shared.coord_presence;
CREATE TRIGGER fleet_assignment_presence_upd_trg
  AFTER UPDATE ON harness_shared.coord_presence
  FOR EACH ROW
  WHEN (OLD.intent IS DISTINCT FROM NEW.intent
     OR OLD.current_plan_slug IS DISTINCT FROM NEW.current_plan_slug
     OR OLD.current_files IS DISTINCT FROM NEW.current_files)
  EXECUTE FUNCTION harness_shared.notify_fleet_assignment();

-- plan_item_claims: acquire/release/reclaim notify; lease RENEWALS (expires_ts /
-- last_activity_ts heartbeats) do NOT.
DROP TRIGGER IF EXISTS fleet_assignment_claims_ins_del_trg ON harness_shared.plan_item_claims;
CREATE TRIGGER fleet_assignment_claims_ins_del_trg
  AFTER INSERT OR DELETE ON harness_shared.plan_item_claims
  FOR EACH ROW EXECUTE FUNCTION harness_shared.notify_fleet_assignment();
DROP TRIGGER IF EXISTS fleet_assignment_claims_upd_trg ON harness_shared.plan_item_claims;
CREATE TRIGGER fleet_assignment_claims_upd_trg
  AFTER UPDATE ON harness_shared.plan_item_claims
  FOR EACH ROW
  WHEN (OLD.owner IS DISTINCT FROM NEW.owner
     OR OLD.owner_name IS DISTINCT FROM NEW.owner_name
     OR OLD.intent IS DISTINCT FROM NEW.intent)
  EXECUTE FUNCTION harness_shared.notify_fleet_assignment();

-- plan_item_assignments: assign / release / reassign.
DROP TRIGGER IF EXISTS fleet_assignment_assign_ins_del_trg ON harness_shared.plan_item_assignments;
CREATE TRIGGER fleet_assignment_assign_ins_del_trg
  AFTER INSERT OR DELETE ON harness_shared.plan_item_assignments
  FOR EACH ROW EXECUTE FUNCTION harness_shared.notify_fleet_assignment();
DROP TRIGGER IF EXISTS fleet_assignment_assign_upd_trg ON harness_shared.plan_item_assignments;
CREATE TRIGGER fleet_assignment_assign_upd_trg
  AFTER UPDATE ON harness_shared.plan_item_assignments
  FOR EACH ROW
  WHEN (OLD.assignee_name IS DISTINCT FROM NEW.assignee_name
     OR OLD.released_ts IS DISTINCT FROM NEW.released_ts)
  EXECUTE FUNCTION harness_shared.notify_fleet_assignment();

-- work-item claims: only the claim scalar changing notifies (these tables are hot —
-- status churn etc. must not fire the assignment feed).
DROP TRIGGER IF EXISTS fleet_assignment_features_ins_trg ON harness_shared.harness_features_consolidated;
CREATE TRIGGER fleet_assignment_features_ins_trg
  AFTER INSERT ON harness_shared.harness_features_consolidated
  FOR EACH ROW
  WHEN (NEW.taken_by IS NOT NULL)
  EXECUTE FUNCTION harness_shared.notify_fleet_assignment();
DROP TRIGGER IF EXISTS fleet_assignment_features_upd_trg ON harness_shared.harness_features_consolidated;
CREATE TRIGGER fleet_assignment_features_upd_trg
  AFTER UPDATE ON harness_shared.harness_features_consolidated
  FOR EACH ROW
  WHEN (OLD.taken_by IS DISTINCT FROM NEW.taken_by)
  EXECUTE FUNCTION harness_shared.notify_fleet_assignment();

DROP TRIGGER IF EXISTS fleet_assignment_issues_ins_trg ON harness_shared.engineer_issues;
CREATE TRIGGER fleet_assignment_issues_ins_trg
  AFTER INSERT ON harness_shared.engineer_issues
  FOR EACH ROW
  WHEN (NEW.assignee IS NOT NULL)
  EXECUTE FUNCTION harness_shared.notify_fleet_assignment();
DROP TRIGGER IF EXISTS fleet_assignment_issues_upd_trg ON harness_shared.engineer_issues;
CREATE TRIGGER fleet_assignment_issues_upd_trg
  AFTER UPDATE ON harness_shared.engineer_issues
  FOR EACH ROW
  WHEN (OLD.assignee IS DISTINCT FROM NEW.assignee)
  EXECUTE FUNCTION harness_shared.notify_fleet_assignment();

COMMIT;
