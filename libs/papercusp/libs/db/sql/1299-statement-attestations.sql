-- 1299-statement-attestations.sql — agent-economy-flywheel-2026-08-30 P-047 (D-031, WI-10004816)
--
-- One row per outside-accountant attestation of a closed monthly statement
-- (P-044, D-028). The row is the public attestation record: the month, the
-- digest of the signed statement it attests (which already covers that month's
-- anchored root), the SHA-256 of the signed attestation document, who signed it
-- and what it covers. The document itself is never stored.
--
-- `record_json` is the canonical record exactly as chained: it is the chain
-- entry on stream 'transparency.statement-attestations' in
-- harness_shared.ledger_chain_links, so the hourly anchor run (D-024) puts it
-- on chain in a later root of the same log as the month root.
--
-- Append-only: a corrected attestation is a new row with a new document hash,
-- never an edit, so UPDATE and DELETE are refused by the same trigger as
-- ledger_chain_links. Additive only.

CREATE TABLE IF NOT EXISTS harness_shared.statement_attestations (
  workspace_id      text        NOT NULL,
  month             text        NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  document_sha256   text        NOT NULL CHECK (document_sha256 ~ '^[0-9a-f]{64}$'),
  attestation_seq   bigint      GENERATED ALWAYS AS IDENTITY,
  statement_digest  text        NOT NULL CHECK (statement_digest ~ '^[0-9a-f]{64}$'),
  attestor_name     text        NOT NULL CHECK (length(attestor_name) BETWEEN 1 AND 200),
  attested_on       date        NOT NULL,
  scope             text[]      NOT NULL CHECK (cardinality(scope) >= 1),
  record_json       jsonb       NOT NULL,
  recorded_by       text,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, month, document_sha256),
  UNIQUE (attestation_seq)
);

DROP TRIGGER IF EXISTS statement_attestations_append_only_trg
  ON harness_shared.statement_attestations;
CREATE TRIGGER statement_attestations_append_only_trg
  BEFORE UPDATE OR DELETE ON harness_shared.statement_attestations
  FOR EACH ROW EXECUTE FUNCTION harness_shared.reject_ledger_chain_link_mutation();

ALTER TABLE harness_shared.statement_attestations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS statement_attestations_workspace_isolation
  ON harness_shared.statement_attestations;
CREATE POLICY statement_attestations_workspace_isolation
  ON harness_shared.statement_attestations FOR ALL TO public
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

GRANT SELECT, INSERT ON harness_shared.statement_attestations TO harness_app, harness_admin;

COMMENT ON TABLE harness_shared.statement_attestations IS
  'Outside-accountant attestations of closed monthly statements (P-047, D-031). Chained as stream transparency.statement-attestations; see packages/operator-core/lib/cupboard/statement-attestation-store.ts.';
