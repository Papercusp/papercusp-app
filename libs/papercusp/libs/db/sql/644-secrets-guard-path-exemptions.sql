-- 644-secrets-guard-path-exemptions.sql — WI-5591: runtime-loaded path
-- exemptions for the git-sync own-head publish guard's secrets scanner
-- (pot-git/publish-guard.ts + secrets-guard.ts, G-10).
--
-- ROOT CAUSE this closes: the scanner's exemption list (FIXTURE_FILES in
-- secrets-guard.ts) is a hardcoded TS Set — clearing a false-positive wedge
-- requires a human to edit that source file AND restart papercup-bg-host
-- (tsx has no hot-reload for that process). Because checkPublishGuard's guard
-- baseline never advances past a REFUSED range, the same offending historical
-- blob is rescanned and re-refused on EVERY tick forever until that manual
-- fix lands — a false positive permanently freezes ALL git egress for the
-- hive (fail-closed-forever; hit 3x in 2 days per EI-13924).
--
-- This table gives an operator/agent tool a same-second remedy: INSERT a path
-- exemption row and the very next git-sync tick (no restart) treats that path
-- as exempt, same semantics as FIXTURE_FILES but data-driven. The static
-- FIXTURE_FILES set in secrets-guard.ts is UNCHANGED and stays authoritative
-- for the scanner's own known self-referential fixtures (defense in depth);
-- this table is the operator escape hatch for the NEXT unforeseen one.
--
-- Idempotent (CREATE … IF NOT EXISTS); additive; fresh-migrate-safe.

CREATE TABLE IF NOT EXISTS harness_shared.secrets_guard_path_exemptions (
  workspace_id TEXT NOT NULL,
  path         TEXT NOT NULL,
  reason       TEXT NOT NULL DEFAULT '',
  created_by   TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, path)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.secrets_guard_path_exemptions TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.secrets_guard_path_exemptions TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

ALTER TABLE harness_shared.secrets_guard_path_exemptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS secrets_guard_path_exemptions_workspace_isolation ON harness_shared.secrets_guard_path_exemptions;
CREATE POLICY secrets_guard_path_exemptions_workspace_isolation ON harness_shared.secrets_guard_path_exemptions
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
