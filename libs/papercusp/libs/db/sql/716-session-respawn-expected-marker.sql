-- 716-session-respawn-expected-marker.sql
--
-- WI-6756 follow-on: make the "a carry-respawn is expected for this owner"
-- signal CROSS-PROCESS.
--
-- carry-respawn-marker.ts kept this mark in a module-scoped in-memory Map,
-- justified by "session:request-compaction's injectIntoHost and the subsequent
-- SessionEnd activity:report both execute in-process on the SAME operator".
-- That assumption does not hold on a CLUSTERED operator: :3070 forks N
-- request-only workers that share the port via round-robin (hono-host.ts P3-2),
-- so request-compaction marks worker A while the dying child's SessionEnd hook
-- POSTs to whichever worker the round-robin picks. Measured live 2026-08-02 on
-- this box: pid 2250178 with 16 worker children -> the mark was found only when
-- both calls happened to land on the same worker, and su-e02f5c3d lost all three
-- of its work-item claims (WI-5135, WI-6756, WI-3965) to a self-compaction whose
-- SessionEnd landed on a sibling worker.
--
-- Same bug class, and the same remedy, as session-reset-continuation.ts already
-- applies to the cold-loop-wake trigger: put the signal somewhere every process
-- can read it. That leg could reuse the existing wake ledger; a carry-respawn
-- inject writes no such row, so it needs this (deliberately tiny) table.
--
-- Consumed by DELETE ... RETURNING, which makes "check and clear" atomic across
-- workers: exactly one reader can ever observe a given mark, so a genuine death
-- shortly after a completed respawn is never suppressed by a leftover row.
-- Rows are self-expiring by expires_at; the sweep index keeps cleanup cheap.

CREATE TABLE IF NOT EXISTS harness_shared.session_respawn_expected (
  owner_id   text PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  reason     text NOT NULL DEFAULT 'carry-respawn',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_session_respawn_expected_expires
  ON harness_shared.session_respawn_expected (expires_at);

COMMENT ON TABLE harness_shared.session_respawn_expected IS
  'Short-TTL, single-use marks: this ownerId''s imminent SessionEnd is a scheduled carry-respawn continuation, not a death, so the P-002 lease-release fast path must skip it. Written by session:request-compaction once its respawn is queued; consumed (DELETE ... RETURNING) by activity:report. Cross-process by necessity — the operator is clustered. See carry-respawn-marker.ts.';
