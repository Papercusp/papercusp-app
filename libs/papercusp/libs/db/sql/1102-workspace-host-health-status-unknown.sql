-- Widen workspace_hosts.health_status to accept 'unknown' (WI-2143924).
--
-- 887 pinned the column to ('healthy','degraded','unreachable'). That list has no way to
-- say "a required health check was never measured", so every provider was forced to coerce
-- an unmeasured signal into one of the two verdicts it is not entitled to make:
-- GcpWorkspaceHostProvider.attestHealth read the never-written `agentOnline` as `=== true`
-- and reported `degraded` for every healthy host, while `observe` read the SAME unset field
-- as `=== false` and reported `running`. `unknown` is now the fourth attestation status --
-- reachable, nothing measured failing, but at least one check unmeasured -- so a caller
-- gating on health can tell "we know it is broken" from "nobody looked".
--
-- FORWARD-COMPAT: this only WIDENS the accepted set -- every value the currently-deployed
-- release writes ('healthy', 'degraded', 'unreachable', NULL) stays valid, and that release
-- cannot emit 'unknown' because the status is computed in code it does not carry. The old
-- constraint must be dropped rather than altered because Postgres has no ALTER ... CHECK;
-- no row can violate the replacement, so the ADD is validated without a rewrite risk.

ALTER TABLE harness_shared.workspace_hosts
  DROP CONSTRAINT IF EXISTS workspace_hosts_health_status_check;

ALTER TABLE harness_shared.workspace_hosts
  ADD CONSTRAINT workspace_hosts_health_status_check
  CHECK (health_status IS NULL OR health_status IN ('healthy', 'degraded', 'unreachable', 'unknown'));

COMMENT ON COLUMN harness_shared.workspace_hosts.health_status IS
  'Latest provider health attestation: healthy | degraded | unreachable | unknown. "unknown" means the host is reachable and nothing MEASURED is failing, but at least one health check was never measured -- so "healthy" is not a claim the attestation can make. Kept in lockstep with WorkspaceHostHealthStatus in libs/generic/deployment-driver/src/workspace-host-types.ts; the parity guard is packages/operator-core/lib/workspace-host/health-status-schema-parity.test.ts.';
