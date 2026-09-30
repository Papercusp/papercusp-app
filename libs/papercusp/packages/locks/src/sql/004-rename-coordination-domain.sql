-- file-locking #12 (audit S4 — agent-coordination-architecture-v2):
-- rename workspace_id → coordination_domain across the SU-locks
-- schema. The column was misnamed — "workspace_id" implied per-
-- Papercusp-workspace scoping that doesn't exist (today's only value
-- is the literal 'default'; cross-workspace data isolation lives at
-- different layers). The column actually partitions coordination
-- DOMAINS (per-machine, per-papercusp-install). Pre-alpha is the
-- cheapest moment to make the column name stop lying.
--
-- Runs once via the NNN-*.sql migration runner. Idempotent guard via
-- pg_attribute (the column literally doesn't exist after the rename,
-- so re-running this is a structured no-op).

DO $rename$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_attribute
     WHERE attrelid = 'agent_file_locks'::regclass
       AND attname = 'workspace_id'
       AND NOT attisdropped
  ) THEN
    ALTER TABLE agent_file_locks
      RENAME COLUMN workspace_id TO coordination_domain;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_attribute
     WHERE attrelid = 'agent_lock_waiters'::regclass
       AND attname = 'workspace_id'
       AND NOT attisdropped
  ) THEN
    ALTER TABLE agent_lock_waiters
      RENAME COLUMN workspace_id TO coordination_domain;
  END IF;
END;
$rename$;

-- The PRIMARY KEY on (workspace_id, path) carries the rename through
-- automatically (PG indexes columns by OID, not name) — no rebuild
-- needed. Same for the partial indexes below, but DROP + recreate to
-- refresh the index definitions visible in pg_indexes / pg_dump so
-- the new column name shows up cleanly.
DROP INDEX IF EXISTS idx_waiters_active;
CREATE INDEX idx_waiters_active
  ON agent_lock_waiters (coordination_domain, queued_ts, ticket_id)
  WHERE status = 'waiting';

DROP INDEX IF EXISTS idx_waiters_paths_gin;
CREATE INDEX idx_waiters_paths_gin
  ON agent_lock_waiters USING GIN (coordination_domain, paths)
  WHERE status = 'waiting';

-- Recreate grant_cascade. PL/pgSQL function bodies reference columns
-- by name and are re-parsed at call time, so the body MUST switch to
-- coordination_domain or the next call would fail with "column
-- workspace_id does not exist". The signature also changes —
-- p_workspace_id → p_coordination_domain — so callers update too.
DROP FUNCTION IF EXISTS grant_cascade(text, timestamptz);

CREATE OR REPLACE FUNCTION grant_cascade(
  p_coordination_domain text,
  p_now                 timestamptz
)
RETURNS void
LANGUAGE plpgsql AS $func$
DECLARE
  v_waiter      record;
  v_new_lock    uuid;
  v_expires     timestamptz;
  v_held_paths  text[];
BEGIN
  SELECT COALESCE(array_agg(path), ARRAY[]::text[])
    INTO v_held_paths
    FROM agent_file_locks
   WHERE coordination_domain = p_coordination_domain
     AND expires_ts > p_now;

  FOR v_waiter IN
    SELECT w.*
      FROM agent_lock_waiters w
     WHERE w.coordination_domain = p_coordination_domain
       AND w.status = 'waiting'
       AND w.wait_until > p_now
     ORDER BY w.queued_ts ASC, w.ticket_id ASC
  LOOP
    BEGIN
      IF v_held_paths && v_waiter.paths THEN
        CONTINUE;
      END IF;

      v_new_lock := gen_random_uuid();
      v_expires  := p_now + (v_waiter.ttl_sec || ' seconds')::interval;

      INSERT INTO agent_file_locks
        (coordination_domain, path, owner, owner_label, intent,
         lock_id, acquired_ts, expires_ts)
      SELECT
        p_coordination_domain, p, v_waiter.owner, v_waiter.owner_label,
        v_waiter.intent, v_new_lock, p_now, v_expires
        FROM unnest(v_waiter.paths) AS p
        ON CONFLICT DO NOTHING;

      UPDATE agent_lock_waiters
         SET status              = 'granted',
             granted_lock_id     = v_new_lock,
             granted_expires_ts  = v_expires
       WHERE ticket_id = v_waiter.ticket_id;

      v_held_paths := v_held_paths || v_waiter.paths;

      -- NOTIFY fires at commit time, atomic with the grant. Payload
      -- is ticket_id only (36 bytes); waiters re-SELECT to read their
      -- granted_lock_id. DO NOT expand the payload — PG's 8KB NOTIFY
      -- limit will eventually bite if anyone tries to pack more.
      PERFORM pg_notify(
        'ch_coord_' || p_coordination_domain,
        v_waiter.ticket_id::text
      );
    EXCEPTION
      -- Waiter row vanished between SELECT and UPDATE (force-deleted,
      -- cancelled concurrently). Defense-in-depth — under the domain
      -- advisory lock this should not happen.
      WHEN no_data_found THEN CONTINUE;
      -- Another grant in this same cascade beat us to a path.
      -- Defense-in-depth — the in-memory v_held_paths probe should
      -- prevent it.
      WHEN unique_violation THEN CONTINUE;
      -- Intentionally NOT catching WHEN OTHERS: real errors (syntax,
      -- assertion, permission) MUST abort the cascade.
    END;
  END LOOP;
END;
$func$;
