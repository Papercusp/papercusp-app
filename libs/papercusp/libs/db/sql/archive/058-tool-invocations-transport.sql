-- 058-tool-invocations-transport.sql
--
-- Add `transport` column to harness_shared.tool_invocations so
-- /dev → Sessions / Telemetry can filter by which transport drove
-- the dispatch. Values:
--   'http'        — HTTP catch-all (apps/operator/app/api/agent-tools
--                   /[...path]/route.ts) + Hono shims.
--   'mcp'         — MCP transport (apps/operator/app/api/[transport]
--                   /route.ts).
--   'ipc'         — Endpoint IPC (Unix-socket / named-pipe from
--                   papercup-desktop's Tauri webview to the operator
--                   sidecar). See apps/operator/lib/endpoint-ipc/.
--   'in_process'  — Server-side caller of dispatchProjectedToolStream
--                   without going through any transport (route shims
--                   that call the tool directly fall into this bucket
--                   today since they don't set transport themselves).
--
-- Backfill: NULL for existing rows. Readers tolerate null and treat
-- it as 'unknown' — same shape as args_json's lazy backfill in
-- 053-tool-invocations-args.sql.
--
-- Indexes: not adding one on `transport` alone — telemetry queries
-- already use (workspace, harness, invoked_at) and `transport` is
-- low-cardinality (4 values). A composite would be useful later if
-- per-transport filtering becomes hot; defer until that's the actual
-- bottleneck.

ALTER TABLE harness_shared.tool_invocations
  ADD COLUMN IF NOT EXISTS transport text;
