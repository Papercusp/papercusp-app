-- SU agent file-lock coordination — bootstrap.
--
-- This file is executed against the DEFAULT database (papercusp), not
-- against papercusp_su. It only handles the "does the side database
-- exist?" step. Everything else runs against papercusp_su.
--
-- Idempotent: CREATE DATABASE IF NOT EXISTS isn't a thing in PG, so the
-- runner checks pg_database first and skips this entire file when
-- papercusp_su already exists.

-- NOTE: cannot run inside a transaction (CREATE DATABASE forbids it).
-- The runner detects this file by name suffix `-bootstrap.sql` and
-- executes it WITHOUT BEGIN/COMMIT.

CREATE DATABASE papercusp_su;

-- Tune autovacuum at the database level for the high-churn lock tables.
-- See agent_file_locks / agent_lock_waiters in 002-tables.sql for the
-- per-table override; these defaults set the floor.
ALTER DATABASE papercusp_su SET idle_in_transaction_session_timeout = '30s';
ALTER DATABASE papercusp_su SET application_name = 'papercusp-su';
