-- 467-p2p-foreign-workspaces.sql — p2p-work-distribution-2026-07-02 P-109 (Lane D).
-- Registry of FOREIGN WORKSPACES on this host: one row per claimed offer whose
-- work executes here (P-104 local-authority spawn writes it; the worktree-guard
-- leg (i), the foreign-git-sync commit lane leg (ii), the quarantine mirror
-- lane leg (iii), and P-106's revocation reaper all read it).
--
-- DELIBERATELY HOST-LOCAL, NOT federated (M19 physics: root paths, session
-- ids, and clone state are machine-local facts — the grant/revocation plane
-- that DOES federate is p2p_peer_grants, mig 463). No substrate_outbox
-- capture, no projection. workspace_id partitions rows exactly like the other
-- host-local operational tables.
--
-- Q1 (leader-ratified 2026-07-03): the BINDING invariant is root_path OUTSIDE
-- the workspace root and not inside any host tree — this column is the source
-- of truth the guard enforces against; the literal path family is provisional
-- until P-105 lands the OS-user/quota tier.
--
-- STATE MACHINE (design doc §0/§5): provisioning → active → winding-down →
-- parked | reaped. Fail-closed consumers: a foreign session with NO live row
-- (or a row not in 'active') edits nothing (guard), commits nothing (lane ii).
--
-- Idempotent; apply via the runner (db:migrate) or psql + schema_migrations
-- row in one txn.

\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS harness_shared.p2p_foreign_workspaces (
  workspace_id text NOT NULL,
  offer_id text NOT NULL,                        -- M21: threads every receipt/audit/trace line
  fleet_slug text NOT NULL,                      -- the offering fleet (scope key under P-006)
  origin_github_user_id bigint NOT NULL,         -- X9: numeric id, never login
  executor_device text NOT NULL,                 -- THIS host's executor device pubkey (base64)
  root_path text NOT NULL,                       -- quota subtree root (Q1 invariant enforced by guard)
  clone_path text NOT NULL,                      -- the git clone under root_path (Q5: clone --no-local)
  session_id text,                               -- bound foreign session (null until spawn binds it)
  execution_epoch bigint NOT NULL DEFAULT 0,     -- H9 fencing; stamped on commits + results
  state text NOT NULL DEFAULT 'provisioning'
    CHECK (state IN ('provisioning', 'active', 'winding-down', 'parked', 'reaped')),
  park_reason text,                              -- loud-refusal breadcrumb (e.g. attestation-unresolvable)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, offer_id)
);

-- One workspace per filesystem root — two offers must never share a quota
-- subtree (blending would defeat per-offer wind-down + attribution).
CREATE UNIQUE INDEX IF NOT EXISTS p2p_foreign_workspaces_root_path_key
  ON harness_shared.p2p_foreign_workspaces (root_path);

-- The commit lane + reaper enumerate by state per workspace.
CREATE INDEX IF NOT EXISTS p2p_foreign_workspaces_state_idx
  ON harness_shared.p2p_foreign_workspaces (workspace_id, state);

-- The guard resolves a session's workspace fast (fail-closed lookup).
CREATE INDEX IF NOT EXISTS p2p_foreign_workspaces_session_idx
  ON harness_shared.p2p_foreign_workspaces (session_id)
  WHERE session_id IS NOT NULL;

COMMIT;
