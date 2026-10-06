-- 1289-ledger-anchor.sql — agent-economy-flywheel-2026-08-30 P-041 (WI-10004660, D-024)
--
-- Hourly anchoring of the hash-chained ledgers. Every ledger_chain_links row
-- (P-040) becomes one leaf of a per-workspace, append-only RFC 9162 Merkle log
-- (ledger_anchor_leaves). Once an hour the log's root and size are published
-- through an anchor backend (EAS on Base Sepolia for the hosted service) and
-- recorded in ledger_anchors, together with a consistency proof from the
-- previous anchor's size. The math lives in @papercusp/merkle-log and
-- packages/operator-core/lib/cupboard/ledger-anchor.ts.
--
-- Both tables are append-only by trigger (the P-040 guard function is reused).
-- Leaves must be contiguous from 0: a gap would make every later proof wrong.
-- Additive only; nothing deployed reads these tables yet.

CREATE TABLE IF NOT EXISTS harness_shared.ledger_anchor_leaves (
  workspace_id  text        NOT NULL,
  leaf_index    bigint      NOT NULL CHECK (leaf_index >= 0),
  stream_id     text        NOT NULL CHECK (length(stream_id) BETWEEN 1 AND 512),
  seq           bigint      NOT NULL CHECK (seq >= 0),
  entry_hash    text        NOT NULL CHECK (entry_hash ~ '^[0-9a-f]{64}$'),
  leaf_hash     text        NOT NULL CHECK (leaf_hash ~ '^[0-9a-f]{64}$'),
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, leaf_index),
  UNIQUE (workspace_id, stream_id, seq)
);

CREATE OR REPLACE FUNCTION harness_shared.ledger_anchor_leaves_contiguous()
RETURNS trigger
LANGUAGE plpgsql
AS $contig$
DECLARE
  next_index bigint;
BEGIN
  SELECT COALESCE(MAX(leaf_index), -1) + 1 INTO next_index
    FROM harness_shared.ledger_anchor_leaves
   WHERE workspace_id = NEW.workspace_id;
  IF NEW.leaf_index <> next_index THEN
    RAISE EXCEPTION 'ledger_anchor_leaves: leaf_index % is not the next index % for workspace %',
      NEW.leaf_index, next_index, NEW.workspace_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$contig$;

DROP TRIGGER IF EXISTS ledger_anchor_leaves_contiguous_trg
  ON harness_shared.ledger_anchor_leaves;
CREATE TRIGGER ledger_anchor_leaves_contiguous_trg
  BEFORE INSERT ON harness_shared.ledger_anchor_leaves
  FOR EACH ROW EXECUTE FUNCTION harness_shared.ledger_anchor_leaves_contiguous();

DROP TRIGGER IF EXISTS ledger_anchor_leaves_append_only_trg
  ON harness_shared.ledger_anchor_leaves;
CREATE TRIGGER ledger_anchor_leaves_append_only_trg
  BEFORE UPDATE OR DELETE ON harness_shared.ledger_anchor_leaves
  FOR EACH ROW EXECUTE FUNCTION harness_shared.reject_ledger_chain_link_mutation();

CREATE TABLE IF NOT EXISTS harness_shared.ledger_anchors (
  workspace_id      text        NOT NULL,
  anchor_seq        bigint      NOT NULL CHECK (anchor_seq >= 0),
  log_id            text        NOT NULL CHECK (length(log_id) BETWEEN 1 AND 512),
  log_root          text        NOT NULL CHECK (log_root ~ '^[0-9a-f]{64}$'),
  tree_size         bigint      NOT NULL CHECK (tree_size >= 0),
  window_start      bigint      NOT NULL,
  window_end        bigint      NOT NULL,
  consistency_from  bigint      NOT NULL CHECK (consistency_from >= 0),
  consistency_proof jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(consistency_proof) = 'array'),
  backend           text        NOT NULL CHECK (length(backend) BETWEEN 1 AND 64),
  chain_id          integer,
  anchor_ref        text        NOT NULL CHECK (length(anchor_ref) BETWEEN 1 AND 512),
  tx_hash           text,
  attester          text,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, anchor_seq),
  UNIQUE (workspace_id, window_end),
  UNIQUE (workspace_id, anchor_ref),
  CHECK (window_end > window_start),
  CHECK (consistency_from <= tree_size)
);

DROP TRIGGER IF EXISTS ledger_anchors_append_only_trg
  ON harness_shared.ledger_anchors;
CREATE TRIGGER ledger_anchors_append_only_trg
  BEFORE UPDATE OR DELETE ON harness_shared.ledger_anchors
  FOR EACH ROW EXECUTE FUNCTION harness_shared.reject_ledger_chain_link_mutation();

ALTER TABLE harness_shared.ledger_anchor_leaves ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ledger_anchor_leaves_workspace_isolation
  ON harness_shared.ledger_anchor_leaves;
CREATE POLICY ledger_anchor_leaves_workspace_isolation
  ON harness_shared.ledger_anchor_leaves FOR ALL TO public
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

ALTER TABLE harness_shared.ledger_anchors ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ledger_anchors_workspace_isolation
  ON harness_shared.ledger_anchors;
CREATE POLICY ledger_anchors_workspace_isolation
  ON harness_shared.ledger_anchors FOR ALL TO public
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

GRANT SELECT, INSERT ON harness_shared.ledger_anchor_leaves TO harness_app, harness_admin;
GRANT SELECT, INSERT ON harness_shared.ledger_anchors TO harness_app, harness_admin;

COMMENT ON TABLE harness_shared.ledger_anchor_leaves IS
  'Append-only, contiguous leaves of the per-workspace RFC 9162 anchor log over ledger_chain_links (P-041). See packages/operator-core/lib/cupboard/ledger-anchor.ts.';
COMMENT ON TABLE harness_shared.ledger_anchors IS
  'Append-only hourly anchors of the ledger anchor log: published root, size, window, backend receipt and consistency proof from the previous anchor (P-041, D-024).';
