-- 567-memory-write-journal.sql — memory-write-journal-auto-recovery-2026-07-11 P-001.
--
-- Write-ahead journal for memory writes. Today memory:remember/update are
-- embed-synchronous: on an embedder outage (sidecar down, quota, 300s timeout
-- under load) the tool returns {ok:false} and the CONTENT IS LOST — it survives
-- only in the calling agent's session transcript (GAP-1, remember.ts; live
-- repro 2026-07-10: a remember timed out while the P-015 harrier re-embed
-- drain saturated the sidecar, and the fact vanished until transcript
-- forensics recovered it).
--
-- Design principle (plan D-001): the durable INSERT precedes the embed attempt
-- and has NO embedder dependency — a plain relational row, no vector column.
-- Vectors are derived artifacts; the 5-min embed-backfill tick drains pending
-- rows back through the normal backend write once the embedder returns
-- (plan D-002), tagging metadata.recovered_from for provenance (P-007).
--
-- status lifecycle: pending -> committed (memory landed; committed_memory_id
-- set) | failed_permanent (attempts cap exceeded — surfaced in the Memory
-- settings UI, never silently dropped).
--
-- Idempotent (IF NOT EXISTS throughout). The runner provides the transaction
-- -- NO BEGIN/COMMIT here (lint:migrations).

CREATE TABLE IF NOT EXISTS harness_shared.memory_write_journal (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_at        timestamptz NOT NULL DEFAULT now(),
  -- The neutral MemoryBackend write arguments, verbatim — enough to replay
  -- backend.remember(content, { scope, kind, metadata, verbatim }).
  scope               text NOT NULL,
  kind                text,
  content             text NOT NULL,
  metadata            jsonb,
  verbatim            boolean NOT NULL DEFAULT true,
  status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'committed', 'failed_permanent')),
  attempts            int NOT NULL DEFAULT 0,
  last_attempt_at     timestamptz,
  last_error          text,
  committed_memory_id uuid,
  committed_at        timestamptz,
  -- 'live-write' = journaled by the tool write path; 'transcript-miner' =
  -- backfilled by memory:recover-from-transcripts (P-008).
  source              text NOT NULL DEFAULT 'live-write'
);

-- The drain's scan: oldest pending first.
CREATE INDEX IF NOT EXISTS memory_write_journal_pending_idx
  ON harness_shared.memory_write_journal (requested_at)
  WHERE status = 'pending';

-- The Memory-page "recovered N facts from HH:MM–HH:MM" banner + history reads.
CREATE INDEX IF NOT EXISTS memory_write_journal_committed_at_idx
  ON harness_shared.memory_write_journal (committed_at)
  WHERE status = 'committed';

COMMENT ON TABLE harness_shared.memory_write_journal IS
  'Write-ahead journal for memory writes (memory-write-journal-auto-recovery-2026-07-11). A row is INSERTed before the embed+store attempt; embedder outages leave it pending and the embed-backfill tick replays it, so a memory write can no longer be lost to downtime.';
