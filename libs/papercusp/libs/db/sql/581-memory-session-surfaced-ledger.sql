-- 581: session-epoch surfaced-memory ledger
-- Plan: memory-delivery-unification-2026-07-12 (P-002, decisions D-002/D-006).
--
-- Warm sessions (psu/su MCP, fleet members) dedup injected memories per
-- SESSION EPOCH (session identity + compaction generation) instead of the
-- chat path's 2-minute wall-clock watermark: an injected fact stays in a warm
-- session's context until compaction, so re-paying it mid-epoch is pure
-- waste, while a compaction (epoch bump) makes EVERYTHING eligible to
-- re-prime. The ledger is PORT-AGNOSTIC (D-006): initialize, turn-start,
-- compact re-prime, wake-briefs, and the claim/create injection ports all
-- stamp + read the SAME rows, so orient-then-claim never double-injects.
--
-- Idempotent (IF NOT EXISTS everywhere); additive only.

-- Per-session compaction-generation counter. Epoch 0 = never compacted.
CREATE TABLE IF NOT EXISTS harness_shared.memory_session_epochs (
  session_id text PRIMARY KEY,
  epoch      integer NOT NULL DEFAULT 0,
  bumped_at  timestamptz NOT NULL DEFAULT now()
);

-- One row per (session, epoch, memory) actually injected. `port` records
-- WHICH injection moment surfaced it (initialize / turn-start / compact /
-- brief / claim / create / ...) — the P-005 per-port telemetry read.
CREATE TABLE IF NOT EXISTS harness_shared.memory_session_surfaced (
  session_id  text NOT NULL,
  epoch       integer NOT NULL DEFAULT 0,
  memory_id   uuid NOT NULL,
  port        text NOT NULL DEFAULT 'injection',
  surfaced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, epoch, memory_id)
);

-- Age-based GC scans (opportunistic cleanup piggybacks on epoch bumps).
CREATE INDEX IF NOT EXISTS memory_session_surfaced_age_idx
  ON harness_shared.memory_session_surfaced (surfaced_at);
