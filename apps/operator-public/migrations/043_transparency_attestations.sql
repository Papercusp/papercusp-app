-- Statement attestations on the public transparency report
-- (agent-economy-flywheel-2026-08-30 P-047 follow-up WI-10004823, D-031).
--
-- An outside accountant attests a published monthly statement; the operator
-- records the public attestation RECORD (never the document, only its SHA-256),
-- chains it on `transparency.statement-attestations`, and the hourly anchor run
-- puts it on chain. The operator then pushes the record here over the
-- reconciliation HMAC, and pushes it again with its inclusion PROOF once anchored.
--
--   transparency_attestations  one row per (workspace, month, document). The
--                              record is IMMUTABLE: a later push with a different
--                              record for the same key is refused (409). The
--                              proof is write-once: the first verified proof is
--                              kept; proof_json is NULL until one arrives.
--
-- The Worker accepts a record only when the month's statement is published here
-- with the digest the record names, and checks a proof offline (record, chain
-- link, Merkle inclusion in the claimed root). Whether that root is on chain is
-- the public reader's check against the chain itself.

CREATE TABLE IF NOT EXISTS transparency_attestations (
  workspace_id     TEXT NOT NULL,
  month            TEXT NOT NULL,
  document_sha256  TEXT NOT NULL,
  statement_digest TEXT NOT NULL,
  record_json      TEXT NOT NULL,
  proof_json       TEXT,
  recorded_at_ms   INTEGER NOT NULL,
  proof_at_ms      INTEGER,
  PRIMARY KEY (workspace_id, month, document_sha256)
);
