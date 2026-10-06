-- Public transparency report (agent-economy-flywheel-2026-08-30 P-044, D-028).
--
-- The operator derives every figure from its money journal and pushes two things
-- here over the reconciliation HMAC; this Worker serves them publicly.
--
--   transparency_live        the hourly live report for the open month, one row per
--                            workspace, with where the latest closed month's statement
--                            stands (published / pending / withheld, and why). A push
--                            replaces the row only when its generated_at_ms is not
--                            older than the stored one, so a delayed push can never
--                            roll the public page back.
--   transparency_statements  one signed monthly statement per (workspace, month).
--                            IMMUTABLE: the first publication wins. A later push
--                            with the same digest is a no-op; a different digest is
--                            refused (409) and never overwrites what readers saw.
--
-- The Worker checks the statement's digest and EIP-191 signature before storing,
-- so a stored row always verifies against its own signer.

CREATE TABLE IF NOT EXISTS transparency_live (
  workspace_id    TEXT PRIMARY KEY,
  month           TEXT NOT NULL,
  report_json     TEXT NOT NULL,
  statement_status_json TEXT NOT NULL,
  generated_at_ms INTEGER NOT NULL,
  received_at_ms  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS transparency_statements (
  workspace_id    TEXT NOT NULL,
  month           TEXT NOT NULL,
  digest          TEXT NOT NULL,
  signature       TEXT NOT NULL,
  signer          TEXT NOT NULL,
  signed_json     TEXT NOT NULL,
  published_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, month)
);
