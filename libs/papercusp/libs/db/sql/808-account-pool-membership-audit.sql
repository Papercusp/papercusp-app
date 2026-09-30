-- 808 — WI-38164: attribute every MEMBERSHIP change to the deploy-account pool.
--
-- WHY THIS IS IN THE DATABASE AND NOT IN TYPESCRIPT.
-- `harness_shared.operator_account_pool` is one JSONB document per workspace, rewritten
-- wholesale by every writer. Until WI-38164 those writers did a non-transactional
-- read-modify-write, so a writer holding a stale snapshot flushed it over everything that
-- had changed since — silently deleting accounts the owner had registered. That is fixed
-- in `updateAccountPool` (SELECT … FOR UPDATE), but the fix only reaches a process running
-- the NEW code. Several long-lived hosts write this row (the inference gateway, the
-- bg-host, the :3070 operator running the frozen release checkout), and they keep their
-- old bundle until they are redeployed. A trigger binds to the TABLE, so it observes those
-- writers too — which is the whole point: the mechanism was provable from the gateway's
-- reload log, but the identity of the writer holding a 3.5h-old snapshot was not.
--
-- WHAT IT RECORDS: only writes that CHANGE THE SET OF ACCOUNT IDS. The pool is also the
-- rate/usage projection (a write per account per ~30s from the gateway) and logging those
-- would bury the signal and grow without bound. Membership changes are a handful a week,
-- so this table stays tiny and every row is worth reading.
--
-- READING IT:
--   SELECT at, removed, added, application_name, backend_pid, xact_age_ms, query
--     FROM harness_shared.operator_account_pool_audit
--    WHERE removed <> '{}' ORDER BY at DESC LIMIT 20;
-- `application_name` is the papercusp client tag `pcusp:<role>:p<PID>` — it carries the
-- writing process's OS pid, so a row points at a specific service. A large `xact_age_ms`
-- means the write landed late in a long transaction (a queued/slow writer), which is the
-- signature of the stale-snapshot flush this exists to catch.

CREATE TABLE IF NOT EXISTS harness_shared.operator_account_pool_audit (
  id               BIGSERIAL PRIMARY KEY,
  workspace_id     TEXT        NOT NULL,
  at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  before_ids       TEXT[]      NOT NULL DEFAULT '{}',
  after_ids        TEXT[]      NOT NULL DEFAULT '{}',
  added            TEXT[]      NOT NULL DEFAULT '{}',
  removed          TEXT[]      NOT NULL DEFAULT '{}',
  backend_pid      INTEGER,
  application_name TEXT,
  -- Milliseconds between the transaction's start and this statement: a stale-snapshot
  -- flush arrives at the end of a long-running transaction, an ordinary write at ~0.
  xact_age_ms      INTEGER,
  query            TEXT
);

CREATE INDEX IF NOT EXISTS operator_account_pool_audit_at_idx
  ON harness_shared.operator_account_pool_audit (at DESC);
-- The read that matters is "what removed an account", so index that directly.
CREATE INDEX IF NOT EXISTS operator_account_pool_audit_removals_idx
  ON harness_shared.operator_account_pool_audit (at DESC)
  WHERE removed <> '{}';

CREATE OR REPLACE FUNCTION harness_shared.audit_account_pool_membership()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  before_ids TEXT[];
  after_ids  TEXT[];
BEGIN
  -- jsonb_path_query_array over a missing/!=array `accounts` yields no rows, so COALESCE
  -- to an empty array rather than letting a malformed payload NULL the whole comparison.
  SELECT COALESCE(ARRAY(SELECT jsonb_array_elements_text(jsonb_path_query_array(OLD.payload, '$.accounts[*].id'))), '{}')
    INTO before_ids;
  SELECT COALESCE(ARRAY(SELECT jsonb_array_elements_text(jsonb_path_query_array(NEW.payload, '$.accounts[*].id'))), '{}')
    INTO after_ids;

  -- Set comparison, deliberately order-insensitive: a reorder is not a membership change.
  IF (SELECT COALESCE(ARRAY(SELECT unnest(before_ids) ORDER BY 1), '{}'))
     IS NOT DISTINCT FROM
     (SELECT COALESCE(ARRAY(SELECT unnest(after_ids) ORDER BY 1), '{}')) THEN
    RETURN NULL; -- rate/usage projection write — not membership; stay quiet.
  END IF;

  INSERT INTO harness_shared.operator_account_pool_audit
    (workspace_id, before_ids, after_ids, added, removed,
     backend_pid, application_name, xact_age_ms, query)
  VALUES (
    NEW.workspace_id,
    before_ids,
    after_ids,
    COALESCE(ARRAY(SELECT unnest(after_ids) EXCEPT SELECT unnest(before_ids)), '{}'),
    COALESCE(ARRAY(SELECT unnest(before_ids) EXCEPT SELECT unnest(after_ids)), '{}'),
    pg_backend_pid(),
    current_setting('application_name', true),
    GREATEST(0, (EXTRACT(EPOCH FROM (clock_timestamp() - transaction_timestamp())) * 1000))::INTEGER,
    LEFT(COALESCE(current_query(), ''), 2000)
  );
  RETURN NULL; -- AFTER trigger; the return value is ignored.
END;
$$;

DROP TRIGGER IF EXISTS operator_account_pool_membership_audit ON harness_shared.operator_account_pool;
CREATE TRIGGER operator_account_pool_membership_audit
  AFTER UPDATE ON harness_shared.operator_account_pool
  FOR EACH ROW
  -- Only fire when the document actually changed; an idempotent rewrite is not an event.
  WHEN (OLD.payload IS DISTINCT FROM NEW.payload)
  EXECUTE FUNCTION harness_shared.audit_account_pool_membership();
