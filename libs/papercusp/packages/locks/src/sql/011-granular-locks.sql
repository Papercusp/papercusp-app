-- 011-granular-locks.sql — multi-granularity intention locks (Gray 1976).
-- Plan: locks-correctness-hardening-2026-06-04 (D-005). Runs against papercusp_su. Idempotent.
--
-- A node = a point in the harness path tree: the root (''), a directory, or a
-- file. A request locks its leaf node + places an INTENTION lock (IS/IX) on
-- every ancestor up to the root, so a harness-level lock and a file-level lock
-- finally SEE each other through the shared ancestor nodes. The compatibility
-- decision (IS/IX/S/SIX/X) lives in app code (intention-locks.ts); this table is
-- the persistence + all-or-nothing acquire surface, mirroring agent_file_locks.
--
-- Separate from agent_file_locks (exclusive-per-(domain,path), the safety-
-- critical edit-lock hot path, left UNTOUCHED): granular locks add the harness⊃
-- file relationship + directory/subtree locks + escalation WITHOUT changing the
-- existing per-edit reason-code API (which keeps working until this subsumes it).

CREATE TABLE IF NOT EXISTS agent_granular_locks (
  coordination_domain text        NOT NULL,
  node                text        NOT NULL,  -- '' = harness/tree root; else repo-relative dir/file
  mode                text        NOT NULL CHECK (mode IN ('IS','IX','S','SIX','X')),
  owner               text        NOT NULL,
  owner_label         text,
  lock_id             uuid        NOT NULL,
  intent              text        NOT NULL DEFAULT '',
  acquired_ts         timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_ts          timestamptz NOT NULL,
  -- One lock per (owner, node, mode): an owner may hold several MODES on a node
  -- (IS then IX, escalation) but not duplicate rows of one mode.
  PRIMARY KEY (coordination_domain, node, owner, mode)
);

CREATE INDEX IF NOT EXISTS idx_granlocks_node    ON agent_granular_locks (coordination_domain, node);
CREATE INDEX IF NOT EXISTS idx_granlocks_lockid  ON agent_granular_locks (lock_id);
CREATE INDEX IF NOT EXISTS idx_granlocks_owner   ON agent_granular_locks (owner);
CREATE INDEX IF NOT EXISTS idx_granlocks_expires ON agent_granular_locks (expires_ts);

ALTER TABLE agent_granular_locks SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.05
);
