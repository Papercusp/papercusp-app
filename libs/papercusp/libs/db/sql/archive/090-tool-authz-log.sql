-- Tool resource-authorization audit log (RFC tooldef-auth Phase 1b host wiring).
--
-- tooldef's dispatcher emits an AuthAuditEvent for every `authorize` allow, deny,
-- AND `GateBypass.policy` bypass via the optional `deps.auditAuth` sink. The host
-- (apps/operator/lib/tool-authz-audit.ts) persists them here so the audited
-- break-glass is queryable — "all denials", "every policy bypass", per principal.
--
-- Separate from harness_shared.auth_audit_log (which is login-scoped) and from
-- harness_shared.tool_invocations (which is per-call telemetry, not per-decision):
-- this is the security-authz decision stream. Append-only, best-effort writes.

CREATE TABLE IF NOT EXISTS harness_shared.tool_authz_log (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  ts             timestamptz NOT NULL DEFAULT now(),
  workspace_id   text,
  principal_slug text,
  tool           text        NOT NULL,
  action         text        NOT NULL,
  resource_type  text,
  resource_id    text,
  decision       text        NOT NULL,  -- 'allow' | 'deny'
  gate           text        NOT NULL,  -- 'role'|'capability'|'harness'|'quota'|'authorize'
  reason         text
);

CREATE INDEX IF NOT EXISTS tool_authz_log_ts_idx
  ON harness_shared.tool_authz_log (ts DESC);
-- Fast "show me every denial / every break-glass bypass" review query.
CREATE INDEX IF NOT EXISTS tool_authz_log_decision_idx
  ON harness_shared.tool_authz_log (decision, ts DESC);
CREATE INDEX IF NOT EXISTS tool_authz_log_principal_idx
  ON harness_shared.tool_authz_log (principal_slug, ts DESC);
