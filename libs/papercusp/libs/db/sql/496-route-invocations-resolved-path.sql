-- EI-7069: harness_shared.route_invocations stores only the TEMPLATED path
-- (e.g. '/admin/plans/:verb'), never the RESOLVED path the client actually hit,
-- and carries no response-size signal. Per-verb / per-size traffic attribution
-- for a templated route was impossible from this table alone — verifying
-- EI-7028 had to fall back to tool_invocations (which only works because that
-- proxy happens to dispatch into a tool; a route that doesn't has zero
-- per-verb/per-size observability). Add both columns, nullable + additive —
-- byte-identical for every existing row and every reader that doesn't select
-- them.
ALTER TABLE harness_shared.route_invocations
  ADD COLUMN IF NOT EXISTS resolved_path text,
  ADD COLUMN IF NOT EXISTS response_bytes integer;

COMMENT ON COLUMN harness_shared.route_invocations.resolved_path IS
  'The actual request path (e.g. /admin/plans/attention), distinct from route_invocations.path which is the route TEMPLATE (e.g. /admin/plans/:verb). Null for older rows written before this column existed.';
COMMENT ON COLUMN harness_shared.route_invocations.response_bytes IS
  'Response body size in bytes, read from the handler Response''s Content-Length header when present. Null for streaming/chunked responses (no Content-Length) or rows written before this column existed.';
