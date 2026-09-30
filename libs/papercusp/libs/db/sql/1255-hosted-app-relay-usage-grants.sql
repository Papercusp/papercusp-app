-- Migration 1255 — ownership, RLS and grants for papercusp_auth.hosted_app_relay_usage
-- (plan external-app-access-to-workspaces-2026-09-29 P-007, WI-10004018).
--
-- 1254 created the monthly app-relay usage table but gave it none of the hosted
-- control plane's role wiring, so the hosted service role (the only role the
-- portal's PostgresHostedAppRelayUsageStore runs as) could neither read nor
-- write it. This applies the same pattern as the connector table beside it
-- (1009): owned by hosted_owner, FORCE RLS, readable and writable only by
-- hosted_service, and closed to every other role.
--
-- Additive only: ownership, RLS, grants and one policy. No column or index changes.

ALTER TABLE papercusp_auth.hosted_app_relay_usage OWNER TO hosted_owner;
ALTER TABLE papercusp_auth.hosted_app_relay_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE papercusp_auth.hosted_app_relay_usage FORCE ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA papercusp_auth TO hosted_owner, hosted_service;
REVOKE ALL ON papercusp_auth.hosted_app_relay_usage
  FROM PUBLIC, harness_app, harness_zero, harness_admin, hosted_app, hosted_service;
GRANT SELECT, INSERT, UPDATE ON papercusp_auth.hosted_app_relay_usage TO hosted_service;

DROP POLICY IF EXISTS hosted_app_relay_usage_service_all ON papercusp_auth.hosted_app_relay_usage;
CREATE POLICY hosted_app_relay_usage_service_all ON papercusp_auth.hosted_app_relay_usage
  FOR ALL TO hosted_service USING (true) WITH CHECK (true);
