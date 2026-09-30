-- rubrics:amend can outlive one MCP request. Status polls may reach a different
-- operator worker, so the receipt must be shared before the amend starts.
CREATE TABLE IF NOT EXISTS harness_shared.rubric_amend_receipts (
  workspace_id text NOT NULL,
  rubric_ref text NOT NULL,
  idempotency_key text NOT NULL,
  state text NOT NULL CHECK (state IN ('running', 'committed', 'previewed', 'failed')),
  result_json jsonb,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  PRIMARY KEY (workspace_id, rubric_ref, idempotency_key)
);

CREATE INDEX IF NOT EXISTS rubric_amend_receipts_finished_idx
  ON harness_shared.rubric_amend_receipts (finished_at)
  WHERE state <> 'running';

ALTER TABLE harness_shared.rubric_amend_receipts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rubric_amend_receipts_workspace_isolation
  ON harness_shared.rubric_amend_receipts;
CREATE POLICY rubric_amend_receipts_workspace_isolation
  ON harness_shared.rubric_amend_receipts
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.rubric_amend_receipts TO harness_app;
GRANT SELECT ON harness_shared.rubric_amend_receipts TO harness_zero;
