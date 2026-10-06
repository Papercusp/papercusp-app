-- WI-10006206: recordEditAttribution writes the dispatcher call identity on
-- every insert, including the strict restricted-edit hold path. Keep legacy
-- NULL-call captures valid while making replay of one dispatched edit idempotent.
-- FORWARD-COMPAT: the new nullable column leaves every existing row and legacy
-- writer NULL and outside this partial index. New dispatch-aware writes already
-- use ON CONFLICT DO NOTHING; only replay of that call/repo/file is collapsed.
ALTER TABLE harness_shared.edit_attribution_ledger
  ADD COLUMN IF NOT EXISTS dispatch_call_id text;

CREATE UNIQUE INDEX IF NOT EXISTS edit_attribution_dispatch_repo_file_uidx
  ON harness_shared.edit_attribution_ledger (dispatch_call_id, repo_root, file)
  WHERE dispatch_call_id IS NOT NULL;

COMMENT ON COLUMN harness_shared.edit_attribution_ledger.dispatch_call_id IS
  'Dispatcher call identity; a repeated call captures each repo/file once. Legacy non-dispatch captures remain NULL.';
