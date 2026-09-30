-- SU agent file-lock coordination — schema.
--
-- Runs against papercusp_su (the side database). Idempotent.

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS btree_gin;  -- composite (coordination_domain text, paths text[]) GIN
-- pg_stat_statements is superuser-only; if you have superuser access,
-- enable it manually for query-level perf monitoring:
--   psql -d papercusp_su -c 'CREATE EXTENSION pg_stat_statements'

-- Migration tracking table.
CREATE TABLE IF NOT EXISTS su_meta (
  key   text PRIMARY KEY,
  value text NOT NULL
);

DO $bootstrap$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'waiter_status') THEN
    CREATE TYPE waiter_status AS ENUM ('waiting','granted','expired','cancelled');
  END IF;
END;
$bootstrap$;

-- ─────────────────────────────────────────────────────────────────────
-- Active locks. One row per held path.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_file_locks (
  coordination_domain  text         NOT NULL,
  path          text         NOT NULL,
  owner         text         NOT NULL,
  owner_label   text,
  intent        text         NOT NULL,
  lock_id       uuid         NOT NULL DEFAULT gen_random_uuid(),
  acquired_ts   timestamptz  NOT NULL DEFAULT clock_timestamp(),
  expires_ts    timestamptz  NOT NULL,
  PRIMARY KEY (coordination_domain, path)
);
CREATE INDEX IF NOT EXISTS idx_locks_owner   ON agent_file_locks (owner);
CREATE INDEX IF NOT EXISTS idx_locks_expires ON agent_file_locks (expires_ts);

-- High-churn table; tune autovacuum more aggressively than defaults.
ALTER TABLE agent_file_locks SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.05
);

-- ─────────────────────────────────────────────────────────────────────
-- Waiter queue. One row per blocking acquire request.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_lock_waiters (
  ticket_id          uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  coordination_domain       text           NOT NULL,
  owner              text           NOT NULL,
  owner_label        text,
  paths              text[]         NOT NULL,
  intent             text           NOT NULL,
  ttl_sec            integer        NOT NULL,
  queued_ts          timestamptz    NOT NULL DEFAULT clock_timestamp(),
  wait_until         timestamptz    NOT NULL,
  status             waiter_status  NOT NULL DEFAULT 'waiting',
  granted_lock_id    uuid,
  granted_expires_ts timestamptz
);

-- Partial indexes — only active waiters are scanned in the FIFO cascade
-- and head-waiter check.
CREATE INDEX IF NOT EXISTS idx_waiters_active
  ON agent_lock_waiters (coordination_domain, queued_ts, ticket_id)
  WHERE status = 'waiting';

-- Multicolumn GIN: scalar coordination_domain first, then array paths.
-- Requires btree_gin (loaded above). Lets the head-waiter check
-- (coordination_domain = ? AND paths && ?) use the index for both predicates.
CREATE INDEX IF NOT EXISTS idx_waiters_paths_gin
  ON agent_lock_waiters USING GIN (coordination_domain, paths)
  WHERE status = 'waiting';

CREATE INDEX IF NOT EXISTS idx_waiters_owner
  ON agent_lock_waiters (owner) WHERE status = 'waiting';

ALTER TABLE agent_lock_waiters SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.05
);

-- ─────────────────────────────────────────────────────────────────────
-- Path validation. Belt-and-suspenders with the app-side check.
-- Catches bad data from ad-hoc psql inserts and any future ingress
-- point that skips the app validator.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION validate_path(p text) RETURNS void
LANGUAGE plpgsql IMMUTABLE AS $func$
BEGIN
  IF p IS NULL OR p = '' THEN
    RAISE EXCEPTION 'invalid path: empty' USING ERRCODE = '23514';
  END IF;
  IF p LIKE '/%' THEN
    RAISE EXCEPTION 'invalid path: absolute (%)' , p USING ERRCODE = '23514';
  END IF;
  IF p LIKE '%/../%' OR p LIKE '../%' OR p = '..' OR p LIKE '%/..' THEN
    RAISE EXCEPTION 'invalid path: traversal (%)', p USING ERRCODE = '23514';
  END IF;
  IF length(p) > 4096 THEN
    RAISE EXCEPTION 'invalid path: too long (%)' , length(p) USING ERRCODE = '23514';
  END IF;
END;
$func$;

CREATE OR REPLACE FUNCTION trg_validate_lock_path() RETURNS trigger
LANGUAGE plpgsql AS $func$
BEGIN
  PERFORM validate_path(NEW.path);
  RETURN NEW;
END;
$func$;

CREATE OR REPLACE FUNCTION trg_validate_waiter_paths() RETURNS trigger
LANGUAGE plpgsql AS $func$
DECLARE
  p text;
BEGIN
  IF array_length(NEW.paths, 1) IS NULL THEN
    RAISE EXCEPTION 'invalid paths: empty array' USING ERRCODE = '23514';
  END IF;
  FOREACH p IN ARRAY NEW.paths LOOP
    PERFORM validate_path(p);
  END LOOP;
  RETURN NEW;
END;
$func$;

DROP TRIGGER IF EXISTS trg_validate_lock_path ON agent_file_locks;
CREATE TRIGGER trg_validate_lock_path
  BEFORE INSERT OR UPDATE OF path ON agent_file_locks
  FOR EACH ROW EXECUTE FUNCTION trg_validate_lock_path();

DROP TRIGGER IF EXISTS trg_validate_waiter_paths ON agent_lock_waiters;
CREATE TRIGGER trg_validate_waiter_paths
  BEFORE INSERT OR UPDATE OF paths ON agent_lock_waiters
  FOR EACH ROW EXECUTE FUNCTION trg_validate_waiter_paths();
