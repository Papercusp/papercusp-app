-- Named resource locks with drain semantics.
-- Runs against papercusp_su (the side database). Idempotent.
-- Plan: named-resource-locks-drain-2026-06-02.
--
-- D-009: this package migration runner IS the sanctioned home for the
-- locks substrate's schema (NOT harness_shared / main-db migrations).
--
-- Separate from agent_file_locks (which is exclusive-per-(domain,path)):
-- a named resource supports MANY shared holders + ONE exclusive holder,
-- gated by a writer-priority drain phase. Reuses the same papercusp_su
-- db, the ch_coord_<domain> NOTIFY channel, and the inWorkspaceTxn
-- advisory lock. The file-lock tables/functions are left UNTOUCHED
-- (D-001 / D-009) — shared mode would break agent_file_locks' PK, and
-- it is the safety-critical hot path every agent's edit-lock depends on.

-- ─────────────────────────────────────────────────────────────────────
-- Registry: which named locks exist + their rule text + enforcement
-- level + (Phase 8) the command match patterns the Bash hook reads.
-- Global — a resource name is universal; the lock STATE below is keyed
-- per coordination_domain (D-010: registered-names-only).
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_resource_registry (
  resource       text        PRIMARY KEY,
  description    text        NOT NULL DEFAULT '',
  rule_text      text        NOT NULL DEFAULT '',
  enforcement    text        NOT NULL DEFAULT 'advisory'
                 CHECK (enforcement IN ('advisory','checked','enforced')),
  match_patterns text[]      NOT NULL DEFAULT ARRAY[]::text[],
  created_ts     timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_ts     timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- ─────────────────────────────────────────────────────────────────────
-- Resource lock holders. Many shared rows per (domain, resource); at
-- most one exclusive (enforced by the partial unique index below). An
-- exclusive row is 'draining' while live shared holders remain, flipped
-- to 'held' by resource_grant_cascade once they drain to zero.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_resource_locks (
  coordination_domain text        NOT NULL,
  resource            text        NOT NULL,
  owner               text        NOT NULL,
  owner_label         text,
  mode                text        NOT NULL CHECK (mode IN ('shared','exclusive')),
  status              text        NOT NULL DEFAULT 'held'
                      CHECK (status IN ('held','draining')),
  lock_id             uuid        NOT NULL DEFAULT gen_random_uuid(),
  reason              text        NOT NULL DEFAULT '',
  acquired_ts         timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_ts          timestamptz NOT NULL,
  PRIMARY KEY (coordination_domain, resource, owner)
);
CREATE INDEX IF NOT EXISTS idx_reslocks_owner   ON agent_resource_locks (owner);
CREATE INDEX IF NOT EXISTS idx_reslocks_expires ON agent_resource_locks (expires_ts);
CREATE INDEX IF NOT EXISTS idx_reslocks_res     ON agent_resource_locks (coordination_domain, resource);

-- At most one exclusive holder per (domain, resource). The app-side
-- pre-check returns held_exclusive before we get here; this is the
-- belt-and-suspenders backstop.
CREATE UNIQUE INDEX IF NOT EXISTS uq_reslocks_one_exclusive
  ON agent_resource_locks (coordination_domain, resource)
  WHERE mode = 'exclusive';

ALTER TABLE agent_resource_locks SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.05
);

-- ─────────────────────────────────────────────────────────────────────
-- Drain cascade. For each draining exclusive whose resource now has zero
-- live shared holders, flip it to 'held' and NOTIFY the waiter on the
-- shared ch_coord_<domain> channel (payload = the exclusive lock_id; the
-- exclusive waiter matches its own id, file-lock waiters ignore it).
-- Mirrors grant_cascade; called under the workspace advisory lock from
-- the release / heartbeat / acquire-sweep paths.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION resource_grant_cascade(
  p_coordination_domain text,
  p_now                  timestamptz
)
RETURNS void
LANGUAGE plpgsql AS $func$
DECLARE
  v_excl         record;
  v_shared_count int;
BEGIN
  FOR v_excl IN
    SELECT * FROM agent_resource_locks
     WHERE coordination_domain = p_coordination_domain
       AND mode = 'exclusive'
       AND status = 'draining'
       AND expires_ts > p_now
  LOOP
    SELECT count(*) INTO v_shared_count
      FROM agent_resource_locks
     WHERE coordination_domain = p_coordination_domain
       AND resource = v_excl.resource
       AND mode = 'shared'
       AND expires_ts > p_now;

    IF v_shared_count = 0 THEN
      UPDATE agent_resource_locks
         SET status = 'held', acquired_ts = p_now
       WHERE coordination_domain = p_coordination_domain
         AND resource = v_excl.resource
         AND owner = v_excl.owner
         AND mode = 'exclusive';

      PERFORM pg_notify('ch_coord_' || p_coordination_domain, v_excl.lock_id::text);
    END IF;
  END LOOP;
END;
$func$;

-- ─────────────────────────────────────────────────────────────────────
-- Seed the first registered resources (D-003 / D-010). Idempotent — a
-- re-run never clobbers a row a human has since edited. match_patterns
-- are Phase 8 seeds (the Bash command-matcher); the registry simply
-- carries them now.
-- ─────────────────────────────────────────────────────────────────────
INSERT INTO agent_resource_registry (resource, description, rule_text, enforcement, match_patterns) VALUES
  ('dev-server',
   'The operator dev server (:3070 Hono host + :3055 Vite). Restarting it disrupts every agent using the running app.',
   'Acquire shared(dev-server) before relying on the running dev server (API probes, UI checks). To restart it, acquire exclusive(dev-server): new shared acquisitions are refused while you drain, existing users finish their current use, then you restart and release — which signals everyone it is back up.',
   'advisory',
   ARRAY['systemctl.*restart.*papercup', 'overmind.*restart', 'npm run dev']),
  ('db-schema',
   'The papercusp database schema. Applying a migration / destructive DDL can break in-flight queries.',
   'Acquire shared(db-schema) for work that depends on the current schema. To apply a migration or destructive DDL, acquire exclusive(db-schema) and let shared users drain first.',
   'checked',
   ARRAY['psql.*-f'])
ON CONFLICT (resource) DO NOTHING;
