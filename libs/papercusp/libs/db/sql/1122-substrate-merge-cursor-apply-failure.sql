-- WI-2144476 / P-515: the log position is a materialization watermark, not
-- proof that a repeatedly failing write applied. Keep the first unresolved
-- entry's typed disposition beside that watermark. Original Hypercore bytes
-- remain the replay source; this adds no payload store or recovery service.
ALTER TABLE harness_shared.substrate_merge_cursor
  ADD COLUMN IF NOT EXISTS apply_failure jsonb;

DO $$
BEGIN
  ALTER TABLE harness_shared.substrate_merge_cursor
    ADD CONSTRAINT substrate_merge_cursor_apply_failure_check CHECK (
      apply_failure IS NULL OR (
        jsonb_typeof(apply_failure) = 'object'
        AND apply_failure ?& ARRAY['position', 'kind', 'groupKey', 'reason', 'attempts', 'firstSeenAt', 'lastSeenAt']
        AND (apply_failure->>'position')::bigint >= position
        AND (apply_failure->>'attempts')::bigint > 0
        AND apply_failure->>'kind' IN ('rejected', 'dependency-waiting', 'retryable')
      ) IS TRUE
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN harness_shared.substrate_merge_cursor.apply_failure IS
  'First unresolved materialization at/after position. Original log bytes are retained for idempotent replay; rejected is an inspectable dead letter, never a successful winner. NULL means this fold has no known apply failure, not that its remote log is complete.';
