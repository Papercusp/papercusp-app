-- 1182-session-port-atomic-attempts.sql — one target + replay receipt per
-- session-port attempt, while terminal attempts remain linked and retryable.
--
-- Keep the original (workspace_id, idempotency_key) UNIQUE constraint: the
-- currently deployed protocol-v1 writer names that exact, un-predicated
-- ON CONFLICT arbiter.  Protocol v2 stores the immutable logical request key
-- separately and releases only a terminal attempt's legacy arbiter slot by
-- suffixing idempotency_key with its UUID.  That lets old and new writers
-- overlap safely during rollout without a destructive index-shape swap.

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'harness_shared'
       AND table_name = 'session_ports'
       AND column_name = 'retry_of_port_id'
  ) THEN
    ALTER TABLE harness_shared.session_ports
      ADD COLUMN retry_of_port_id UUID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'harness_shared'
       AND table_name = 'session_ports'
       AND column_name = 'logical_request_key'
  ) THEN
    ALTER TABLE harness_shared.session_ports
      ADD COLUMN logical_request_key TEXT;
  END IF;
END
$migration$;

UPDATE harness_shared.session_ports
   SET logical_request_key = COALESCE(logical_request_key, idempotency_key),
       idempotency_key = CASE
         WHEN status IN ('failed', 'expired')
           THEN idempotency_key || ':terminal:' || id::text
         ELSE idempotency_key
       END
 WHERE logical_request_key IS NULL;

DO $migration$
BEGIN
  IF to_regclass('harness_shared.session_ports_logical_request_idx') IS NULL THEN
    CREATE INDEX session_ports_logical_request_idx
      ON harness_shared.session_ports (workspace_id, logical_request_key, prepared_at DESC);
  END IF;

  IF to_regclass('harness_shared.session_ports_retry_idx') IS NULL THEN
    CREATE INDEX session_ports_retry_idx
      ON harness_shared.session_ports (retry_of_port_id)
      WHERE retry_of_port_id IS NOT NULL;
  END IF;
END
$migration$;
