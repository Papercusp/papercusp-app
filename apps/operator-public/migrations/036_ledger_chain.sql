-- Hash-chained ledger links (agent-economy-flywheel P-040; D-021).
--
-- Every append-only money / treasury ledger in this database gets a per-stream
-- hash chain: link `seq` of stream S commits to the previous link's
-- `entry_hash`, the stream id, and a digest of the source row, using the format
-- defined by @papercusp/hash-chain. Editing, deleting, inserting or reordering a
-- ledger row (or a link) breaks the chain at that point, and the verifier in
-- src/ledger-chain-store.ts names the first break.
--
-- Links live beside the ledgers rather than as extra columns on each table so
-- one witness path chains every stream identically, including rows written
-- before this migration (they are chained in fold order on the first witness
-- pass) and idempotent `ON CONFLICT DO NOTHING` replays (a replay adds no row,
-- so it adds no link). The UNIQUE source index makes witnessing idempotent; the
-- primary key makes two concurrent witnesses collide instead of forking.
CREATE TABLE IF NOT EXISTS ledger_chain_links (
  stream_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  source_id TEXT NOT NULL,
  entry_digest TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  entry_hash TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL,
  PRIMARY KEY (stream_id, seq),
  CHECK (seq >= 0),
  CHECK (length(entry_digest) = 64),
  CHECK (length(prev_hash) = 64),
  CHECK (length(entry_hash) = 64)
);

CREATE UNIQUE INDEX IF NOT EXISTS ledger_chain_links_source_idx
  ON ledger_chain_links (stream_id, source_id);

-- Links are append-only: the chain is only tamper-EVIDENT, but refusing in-place
-- edits keeps an honest bug from rewriting history it should be appending to.
CREATE TRIGGER IF NOT EXISTS ledger_chain_links_no_update
  BEFORE UPDATE ON ledger_chain_links
  BEGIN
    SELECT RAISE(ABORT, 'ledger_chain_links is append-only');
  END;

CREATE TRIGGER IF NOT EXISTS ledger_chain_links_no_delete
  BEFORE DELETE ON ledger_chain_links
  BEGIN
    SELECT RAISE(ABORT, 'ledger_chain_links is append-only');
  END;
