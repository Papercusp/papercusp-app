-- 032-cooldown-marks.sql
--
-- Generic per-key cooldown timestamp table — replaces module-scoped
-- `Map<string, number>` patterns where the value is just "the last
-- time something happened". First user is the ElevenLabs token-mint
-- cooldown (8s) in /api/agent-mcp/operator-elevenlabs-bootstrap; future
-- per-key cooldowns can reuse the table without a new schema.
--
-- The key is opaque to the table — namespace via the calling code
-- (e.g. `el-mint:<agentId>`, `voice-test:<workspace>`, …). Keep TTL
-- semantics in the application; the table just stores marked_at_ms.
--
-- Not in zero_harness publication — internal cooldown ledger.

CREATE TABLE IF NOT EXISTS harness_shared.cooldown_marks (
  key           TEXT PRIMARY KEY,
  marked_at_ms  BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS cooldown_marks_marked_at_idx
  ON harness_shared.cooldown_marks (marked_at_ms);
