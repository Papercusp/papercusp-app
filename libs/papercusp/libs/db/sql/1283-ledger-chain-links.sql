-- 1283-ledger-chain-links.sql — agent-economy-flywheel-2026-08-30 P-040 (WI-10004606)
--
-- Per-stream hash chain over Postgres-side ledgers. Each row links one source
-- ledger entry (by a stable source id) into its stream: entry_digest is the
-- canonical-JSON digest of the entry, prev_hash is the previous link's
-- entry_hash, entry_hash commits to (stream, seq, source, digest, prev). The
-- math lives in @papercusp/hash-chain; this table only stores links.
--
-- The links are witnessed AFTER the source append (the source tables keep
-- their own write paths, including federated pot_settings rows that arrive
-- from peers), so a link can be missing but never wrong: verify reports
-- unchained rows separately from a broken chain.
--
-- Append-only: an UPDATE or DELETE is refused by trigger, so rewriting history
-- needs a privileged trigger drop that the next verify still detects.
-- Additive only; nothing deployed reads this table yet.

CREATE TABLE IF NOT EXISTS harness_shared.ledger_chain_links (
  workspace_id  text        NOT NULL,
  stream_id     text        NOT NULL CHECK (length(stream_id) BETWEEN 1 AND 512),
  seq           bigint      NOT NULL CHECK (seq >= 0),
  source_id     text        NOT NULL CHECK (length(source_id) BETWEEN 1 AND 1024),
  entry_digest  text        NOT NULL CHECK (entry_digest ~ '^[0-9a-f]{64}$'),
  prev_hash     text        NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  entry_hash    text        NOT NULL CHECK (entry_hash ~ '^[0-9a-f]{64}$'),
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, stream_id, seq),
  UNIQUE (workspace_id, stream_id, source_id)
);

CREATE OR REPLACE FUNCTION harness_shared.reject_ledger_chain_link_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  RAISE EXCEPTION '% is append-only; % is forbidden', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END
$guard$;

DROP TRIGGER IF EXISTS ledger_chain_links_append_only_trg
  ON harness_shared.ledger_chain_links;
CREATE TRIGGER ledger_chain_links_append_only_trg
  BEFORE UPDATE OR DELETE ON harness_shared.ledger_chain_links
  FOR EACH ROW EXECUTE FUNCTION harness_shared.reject_ledger_chain_link_mutation();

ALTER TABLE harness_shared.ledger_chain_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ledger_chain_links_workspace_isolation
  ON harness_shared.ledger_chain_links;
CREATE POLICY ledger_chain_links_workspace_isolation
  ON harness_shared.ledger_chain_links FOR ALL TO public
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

GRANT SELECT, INSERT ON harness_shared.ledger_chain_links TO harness_app, harness_admin;

COMMENT ON TABLE harness_shared.ledger_chain_links IS
  'Append-only per-stream hash-chain links over Postgres ledgers (P-040). Verified by @papercusp/hash-chain; see packages/operator-core/lib/cupboard/ledger-chain.ts.';
