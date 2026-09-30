-- 220: MCP tool-result replay store (full-app-audit P-046 / EI-68).
--
-- When an MCP client disconnects mid-write, the tool has often already
-- executed (DB write committed) but the response dies on the closed
-- stream — hono-host deliberately swallows that ERR_INVALID_STATE class
-- (one client's disconnect must not crash-loop the host for the fleet),
-- so the result was permanently lost: a reconnecting caller could not
-- distinguish "ran, result dropped" from "never ran".
--
-- This table is the keyed last-result store behind the transport's
-- `_meta.idempotencyKey` contract (_mcp-handler.ts): a caller that
-- passes a key gets its serialized result persisted here; re-calling
-- with the SAME key replays the stored result instead of re-executing.
--
-- Infra table: accessed ONLY by the MCP transport via the admin handle,
-- keyed per caller (owner_key = the stable session/spawn identity), so
-- it carries no RLS policy. Rows are short-lived — the transport sweeps
-- entries older than 1h opportunistically on write.

CREATE TABLE IF NOT EXISTS harness_shared.mcp_tool_results (
  owner_key       text        NOT NULL,
  idempotency_key text        NOT NULL,
  tool_name       text        NOT NULL,
  workspace_id    text        NOT NULL DEFAULT '*',
  result          jsonb       NOT NULL,
  is_error        boolean     NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_key, idempotency_key)
);

-- The sweep scans by age only.
CREATE INDEX IF NOT EXISTS mcp_tool_results_created_at_idx
  ON harness_shared.mcp_tool_results (created_at);
