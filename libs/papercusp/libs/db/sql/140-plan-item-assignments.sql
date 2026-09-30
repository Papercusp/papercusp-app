-- Migration 140 — plan-item ASSIGNMENT + agent-name identity + plan work-groups.
--
-- Plan: plan-item-assignment-claim-liveness-2026-06-04 (Phase 0 + Phase 3 durable tables).
--
-- The project-centric RFC makes a plan ITEM (P-NNN, the Stage-3 normalized
-- harness_plans.items entries — plans-pg-canonical-migration D-009) the durable,
-- claimable unit. This plan models the THREE "who's doing this" states with
-- OPPOSITE mechanisms (D-001/D-002):
--
--   ASSIGNMENT (this migration) — durable intent ("item P-005 is `builder-1`'s").
--     Low-churn, shared-knowledge, survives sleep/interrupt; never auto-expires
--     (only an explicit release clears it, via released_ts). Federated as CONTENT
--     over the peer-log (a later assignment legitimately wins under LWW on this
--     small per-item record). It IS the substrate Claimable `assignee` scalar
--     (capabilities/types.ts) for ObjectRef kind 'plan-item' — consistent with how
--     a work_item carries an `assignee` (unify-work-items D-003); the live grip on
--     top is the leased CLAIM (migration 141), never federated.
--   CLAIM  → migration 141 (leased, authority-mediated, NOT in this blob).
--   LIVENESS → derived from the claim lease (migration 141 + the liveness layer).
--
-- Assignment targets a stable agent-NAME a session ADOPTS (D-006): the name
-- persists, sessions are ephemeral, so "assign builder-1 its items; tell it 'go to
-- your items'" survives interruption. The agent_names registry + agent_name_sessions
-- adoption binding model that. owner_user is best-effort today (userId ?? ownerId)
-- and gets stronger when per-user identity lands (distributed-coordination D-006).
--
-- plan_work_group_members (D-005) is the cross-user PULL opt-in: a user joins a
-- shared plan's work-group, enabling their sessions to claim unclaimed items;
-- nobody push-assigns onto another user's machine (token-burn safety).
--
-- NO RLS (matches the coord_* / engineer_issues family, migration 131): the tools
-- connect via the org/admin (BYPASSRLS) handle and filter by workspace_id in-query;
-- SU uses workspace_id='*'-style scopes a row-isolation policy would break. The
-- federation projection (org handle) writes here directly too.
--
-- Federation columns (origin/author_pubkey) are present + capture-READY (a generated
-- fed_key = '<plan_slug>:<item_id>' single-column key the capture_substrate_outbox
-- trigger can read), but the capture TRIGGER + the peer-log projection are attached
-- in a FOLLOW-ON migration once the projection module is registered (the standard
-- two-step: table capture-ready now, trigger after the projection exists).
--
-- Idempotent; composes onto 000-baseline.sql for fresh/embedded-pg boots; applies on :5432.

\set ON_ERROR_STOP on
BEGIN;

-- ── 1. plan_item_assignments — the federated Claimable scalar, per plan item ──
CREATE TABLE IF NOT EXISTS harness_shared.plan_item_assignments (
    workspace_id text NOT NULL,
    harness_slug text NOT NULL,
    plan_slug text NOT NULL,
    item_id text NOT NULL,                          -- the P-NNN plan-item id (harness_plans.items[].id)

    assignee_name text,                             -- Claimable scalar: the stable agent-NAME (D-006). NULL = unassigned
    assigned_by_user text,                          -- who pushed the assignment (best-effort user; D-005 intra-user push)
    assigned_ts timestamp with time zone,           -- when last (re)assigned
    released_ts timestamp with time zone,           -- soft-release marker; NULL = active assignment (LWW-friendly)
    strategy text,                                  -- execution-strategy/blueprint hint (D-002; RFC companion #1 owns resolution)
    note text,                                      -- optional free-text

    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,

    -- Federation (peer-log; capture-ready, trigger attached in a follow-on once the
    -- projection is registered — mirrors engineer_issues' deferred-federation shape).
    author_pubkey text,
    origin text DEFAULT 'local'::text NOT NULL,

    -- Single-column federation key for the capture_substrate_outbox(TG_ARGV[0]) trigger
    -- (which assumes a scalar key) — the composite (plan_slug,item_id) folded to one.
    fed_key text GENERATED ALWAYS AS ((plan_slug || ':'::text) || item_id) STORED,

    CONSTRAINT plan_item_assignments_pkey PRIMARY KEY (workspace_id, harness_slug, plan_slug, item_id),
    CONSTRAINT plan_item_assignments_workspace_nonempty CHECK ((workspace_id <> ''::text)),
    CONSTRAINT plan_item_assignments_item_nonempty CHECK ((item_id <> ''::text))
);

COMMENT ON TABLE harness_shared.plan_item_assignments IS
  'Per-plan-item ASSIGNMENT (plan-item-assignment-claim-liveness D-001/D-002): durable intent binding a plan item (P-NNN) to a stable agent-NAME. Federated as CONTENT over the peer-log (LWW on this small record); it is the substrate Claimable `assignee` scalar for ObjectRef kind ''plan-item''. released_ts is the soft-release (NULL = active). The live grip is the leased CLAIM (plan_item_claims), never federated. NO RLS (coord-family).';

CREATE INDEX IF NOT EXISTS plan_item_assignments_assignee_idx
  ON harness_shared.plan_item_assignments USING btree (workspace_id, assignee_name)
  WHERE (assignee_name IS NOT NULL AND released_ts IS NULL);
CREATE INDEX IF NOT EXISTS plan_item_assignments_plan_idx
  ON harness_shared.plan_item_assignments USING btree (workspace_id, harness_slug, plan_slug);

CREATE OR REPLACE FUNCTION harness_shared.set_plan_item_assignments_updated_at() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS plan_item_assignments_updated_at_trg ON harness_shared.plan_item_assignments;
CREATE TRIGGER plan_item_assignments_updated_at_trg
  BEFORE UPDATE ON harness_shared.plan_item_assignments
  FOR EACH ROW EXECUTE FUNCTION harness_shared.set_plan_item_assignments_updated_at();

-- ── 2. agent_names — the stable agent-NAME registry (D-006) ──
CREATE TABLE IF NOT EXISTS harness_shared.agent_names (
    workspace_id text NOT NULL,
    agent_name text NOT NULL,                       -- e.g. 'builder-1'
    owner_user text NOT NULL,                        -- best-effort owning user (userId ?? ownerId); the push-assign / pull boundary (D-005)
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,

    CONSTRAINT agent_names_pkey PRIMARY KEY (workspace_id, agent_name),
    CONSTRAINT agent_names_name_nonempty CHECK ((agent_name <> ''::text)),
    CONSTRAINT agent_names_owner_nonempty CHECK ((owner_user <> ''::text))
);

COMMENT ON TABLE harness_shared.agent_names IS
  'Stable agent-NAME registry (plan-item-assignment-claim-liveness D-006). A name (e.g. ''builder-1'') is owned by a user; sessions ADOPT it (agent_name_sessions). Assignment targets a name, so it survives across sessions. owner_user is best-effort until per-user identity lands.';

CREATE INDEX IF NOT EXISTS agent_names_owner_idx
  ON harness_shared.agent_names USING btree (workspace_id, owner_user);

DROP TRIGGER IF EXISTS agent_names_updated_at_trg ON harness_shared.agent_names;
CREATE TRIGGER agent_names_updated_at_trg
  BEFORE UPDATE ON harness_shared.agent_names
  FOR EACH ROW EXECUTE FUNCTION harness_shared.set_plan_item_assignments_updated_at();

-- ── 3. agent_name_sessions — the adoption binding (session ownerId → agent-name) ──
CREATE TABLE IF NOT EXISTS harness_shared.agent_name_sessions (
    workspace_id text NOT NULL,
    session_owner_id text NOT NULL,                  -- the per-session ownerId (resolveAgentIdentity); one name per session
    agent_name text NOT NULL,
    owner_user text NOT NULL,                         -- denormalized owning user at adoption time
    adopted_at timestamp with time zone DEFAULT now() NOT NULL,

    CONSTRAINT agent_name_sessions_pkey PRIMARY KEY (workspace_id, session_owner_id),
    CONSTRAINT agent_name_sessions_name_nonempty CHECK ((agent_name <> ''::text))
);

COMMENT ON TABLE harness_shared.agent_name_sessions IS
  'Adoption binding (plan-item-assignment-claim-liveness D-006): a session (ownerId from resolveAgentIdentity) adopts a stable agent-NAME, so my-items / claim resolve the caller''s name without an explicit arg. Sessions are ephemeral; the name persists in agent_names.';

CREATE INDEX IF NOT EXISTS agent_name_sessions_name_idx
  ON harness_shared.agent_name_sessions USING btree (workspace_id, agent_name);

-- ── 4. plan_work_group_members — cross-user PULL opt-in (D-005) ──
CREATE TABLE IF NOT EXISTS harness_shared.plan_work_group_members (
    workspace_id text NOT NULL,
    harness_slug text NOT NULL,
    plan_slug text NOT NULL,
    member_user text NOT NULL,                       -- the user who joined the work-group
    member_name text,                                -- optional adopted agent-name they pull as
    joined_at timestamp with time zone DEFAULT now() NOT NULL,

    CONSTRAINT plan_work_group_members_pkey PRIMARY KEY (workspace_id, harness_slug, plan_slug, member_user),
    CONSTRAINT plan_work_group_members_user_nonempty CHECK ((member_user <> ''::text))
);

COMMENT ON TABLE harness_shared.plan_work_group_members IS
  'Cross-user PULL opt-in (plan-item-assignment-claim-liveness D-005): a user joins a shared plan''s work-group, enabling their sessions to claim UNCLAIMED items from the shared pool. Pull-only — nobody push-assigns onto another user''s machine (token-burn safety).';

-- ── Grants (coord-family: org handle read/writes; harness_zero reads) ──
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.plan_item_assignments TO harness_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.agent_names TO harness_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.agent_name_sessions TO harness_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.plan_work_group_members TO harness_app;
DO $z$ BEGIN
  GRANT SELECT ON harness_shared.plan_item_assignments TO harness_zero;
  GRANT SELECT ON harness_shared.agent_names TO harness_zero;
  GRANT SELECT ON harness_shared.agent_name_sessions TO harness_zero;
  GRANT SELECT ON harness_shared.plan_work_group_members TO harness_zero;
EXCEPTION WHEN undefined_object THEN NULL;
END $z$;

COMMIT;
