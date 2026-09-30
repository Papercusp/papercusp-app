-- Migration 077 — route_invocations.
--
-- Telemetry sink for the `defineRoute` projection (endpoint route
-- migration, R2). Sibling to harness_shared.tool_invocations but for
-- HTTP plumbing endpoints, not agent tools.
--
-- Separate table by design (RFC Q1, endpoint-route-migration-2026-05-20.md):
--   - route traffic is higher-volume than tool traffic (every UI-data
--     fetch, every webhook) — its own table keeps tool analytics clean
--     and lets route rows carry a shorter retention policy later;
--   - the column set is genuinely different — a route has no
--     plugin/role/feature/chunk/spawn/quota dimensions, but does have
--     an HTTP method + path.
--
-- Written by recordRouteInvocation (apps/operator/lib/endpoint-route/
-- telemetry.ts), best-effort + fire-and-forget, honoring the route's
-- `sampleRate`.
--
-- Idempotent + non-destructive.

\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS harness_shared.route_invocations (
  id                    BIGSERIAL PRIMARY KEY,
  workspace_id          TEXT NOT NULL,
  method                TEXT NOT NULL,            -- GET / POST / ...
  path                  TEXT NOT NULL,            -- the defineRoute path, e.g. '/desktop/version'
  status                TEXT NOT NULL,            -- ok | unauthorized | forbidden | invalid-input | timeout | error
  duration_ms           INT NULL,
  -- Principal audit — null when auth:'public' or unresolved.
  principal_kind        TEXT NULL,
  principal_auth_method TEXT NULL,
  principal_trust       TEXT NULL,
  error_message         TEXT NULL,
  invoked_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- /dev route-traffic view filters by workspace + recency.
CREATE INDEX IF NOT EXISTS route_invocations_ws_time_idx
  ON harness_shared.route_invocations (workspace_id, invoked_at DESC);

COMMIT;
