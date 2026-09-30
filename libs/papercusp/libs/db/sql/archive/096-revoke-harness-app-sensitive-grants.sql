-- 096-revoke-harness-app-sensitive-grants.sql
-- P-062 / agent-tools-workspace-isolation Phase 1b (security lockdown).
--
-- D-002 finding: harness_app was pre-existingly over-granted on sensitive tables.
-- Revoke its access to the admin-only credential/oauth/auth tables so the app
-- role (and post-Phase-4 the tools that run as it) cannot touch secrets.
--
-- ⚠ MUST be applied as the table OWNER / a SUPERUSER (postgres_app) — these
-- tables are postgres_app-owned, so harness_admin's REVOKE is a silent no-op
-- (D-003/D-004). On the native dev box: applied as postgres_app by hand.
--
-- Read-handle audit (verified safe): these 8 are accessed ONLY via getOrgPg
-- (admin) — operator-state-pg.ts, oauth/state.ts, auth-audit.ts, auth-rate-limit.ts
-- — never via the app handle (withWorkspace). KEPT app-readable (genuinely
-- read via withWorkspace, would break if revoked): token_index (cross-harness),
-- system_principals (role-principal-caps), mobile_pair_tokens + mobile_push_tokens
-- (device-store) — those need a migrate-to-admin step first (separate).
REVOKE SELECT, INSERT, UPDATE, DELETE ON
  harness_shared.operator_credentials,
  harness_shared.operator_voice_credentials,
  harness_shared.operator_publish_credentials,
  harness_shared.operator_marketplace_token,
  harness_shared.operator_search_provider_credentials,
  harness_shared.oauth_nonces,
  harness_shared.auth_audit_log,
  harness_shared.auth_rate_limit
FROM harness_app;
