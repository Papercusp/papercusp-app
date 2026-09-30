-- 068 — tool_invocations.metadata_json
--
-- Add a free-form JSONB column for per-tool structured signal that
-- doesn't fit the fixed columns (status, duration_ms, output_size,
-- error_message, event_count, etc.).
--
-- Use cases:
--   - docs:get → { requested, found, truncated, sliced, jsx_literals_present }
--   - search:* → { result_count, ranker, latency_ms_pg }
--   - any tool with per-call shape worth flattening into Postgres for
--     telemetry-driven design decisions (e.g. "≥10% of docs:get
--     responses contain JSX literals → ship the remark cleanup plugin")
--
-- Population is best-effort: tools call ctx.metadata({...}) inside
-- the handler; the dispatcher persists whatever the handler set most
-- recently. NULL when not set or for callers that don't pass a
-- metadata column-aware recordInvocation impl.

ALTER TABLE harness_shared.tool_invocations
  ADD COLUMN IF NOT EXISTS metadata_json JSONB NULL;

COMMENT ON COLUMN harness_shared.tool_invocations.metadata_json IS
  'Per-call structured metadata emitted by the tool handler via ctx.metadata. JSONB so Phase 2 trigger predicates can query specific shapes (e.g. metadata_json->>''truncated'' for docs:get). NULL when handler did not call ctx.metadata.';
