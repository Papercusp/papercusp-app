-- 390: sentinel_says — cross-process voice-OUT relay for the Sentinel-as-Claude-TUI.
--
-- WHY: voice-OUT (the Sentinel's spoken reply, pushed via the `voice:say` MCP tool)
-- was a PROCESS-LOCAL in-memory FIFO (sentinel-output-buffer.ts). But `voice:say`
-- executes inside the agent-mcp process the psu Sentinel's role-scoped MCP connects to
-- (observed: 127.0.0.1:9071), while the webview drains GET /api/operator/sentinel-output
-- on a DIFFERENT operator process. The push and the poll hit two different in-memory
-- arrays and never bridge — so the user spoke, got a correct answer in the TUI, and
-- HEARD NOTHING. A single shared FIFO in PG (every operator/agent-mcp process on the
-- box shares one database — native :5432 in dev, embedded in the shipped app) is the
-- cross-process store the buffer always needed. The known-limitation note in
-- sentinel-output-buffer.ts named exactly this fix; the prior deferral cited a
-- schema-drift CI gate that is now `continue-on-error` (informational, non-gating).
--
-- Single GLOBAL queue (no workspace_id): this is the LOCAL APP USER ONLY desktop TTS
-- channel (owner constraint) — one Sentinel, one webview, one machine — NOT the P2P
-- voice-channel system (voice_relay / operator_voice_channels). It is drained on every
-- webview poll (~1.5s) and bounded to the most-recent N rows, so it stays tiny.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS harness_shared.sentinel_says (
  id         BIGSERIAL PRIMARY KEY,
  line       TEXT   NOT NULL,
  created_at BIGINT NOT NULL
);
