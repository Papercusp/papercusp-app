-- Migration 130 — engineer-issues Phase 3a: harden harness_issues_consolidated
-- as the PG store-of-record (canonical severity/status enums).
--
-- Plan: engineer-issues-2026-06-03 (D-004). Part of making the consolidated
-- base the store-of-record (the code half — killing the .harness/issues.json
-- FS-canonical write + the best-effort syncIssuesToPg mirror — ships alongside
-- this in apps/operator/lib/harness-issues.ts).
--
-- What this does:
--   1. Normalize the live severity/status drift FIRST (PG refuses to add a CHECK
--      to a table that already holds violating rows — D-004). Live audit
--      (2026-06-04, native :5432) found exactly: severity='info' (1 row),
--      status='resolved' (2 rows) in harness_issues_consolidated. Map
--      info→nit (lowest canonical severity) and resolved→closed (resolved is a
--      done state ≡ closed). All other live values are already canonical
--      (severity minor/major/nit/critical; status open/closed/fixing/
--      acknowledged; source validator/human).
--   2. Add CHECK constraints enforcing the canonical enums from
--      apps/operator/app/harness/issues/types.ts on the store-of-record.
--   3. harness_pending_issues (the live validator intake queue) is NOT given a
--      CHECK — a CHECK there could reject a validator's raw finding and break
--      the live pipeline. Instead its non-canonical column DEFAULTs ('normal'
--      severity, '' source) are corrected to canonical, and the code write-path
--      (Phase 3b) clamps any non-canonical pending severity before it reaches
--      the CHECK'd consolidated table.
--   4. Drop the dormant sync_issues_consolidated() function — defined in the
--      archived migration 030 but attached to ZERO triggers since migration 032
--      turned the per-harness harness_<slug>.harness_issues physical tables into
--      auto-updatable VIEWs over this consolidated base (verified live: the
--      function exists, no trigger references it). CASCADE clears any lingering
--      trigger if one somehow survives.
--
-- Idempotent: drift UPDATEs are no-ops once normalized; CHECKs are added under a
-- duplicate_object guard; DROP FUNCTION IF EXISTS tolerates re-runs. Composes
-- onto 000-baseline.sql for fresh / embedded-pg boots (empty table → UPDATEs
-- touch 0 rows → CHECKs add clean) and applies cleanly on the native :5432 dev box.

\set ON_ERROR_STOP on
BEGIN;

-- (1) Normalize existing drift BEFORE the CHECK (D-004).
UPDATE harness_shared.harness_issues_consolidated SET severity = 'nit'    WHERE severity = 'info';
UPDATE harness_shared.harness_issues_consolidated SET status   = 'closed' WHERE status   = 'resolved';

-- Defensive: catch any other non-canonical value that may exist on another
-- install before we add the constraint (so the migration can't fail on data we
-- didn't audit). Unknown severities collapse to 'minor', unknown statuses to
-- 'open' (the safest non-destructive canonical fallbacks).
UPDATE harness_shared.harness_issues_consolidated
   SET severity = 'minor'
 WHERE severity NOT IN ('critical', 'major', 'minor', 'nit');
UPDATE harness_shared.harness_issues_consolidated
   SET status = 'open'
 WHERE status NOT IN ('open', 'acknowledged', 'fixing', 'closed', 'wontfix');

-- (2) Enforce the canonical enums on the store-of-record.
DO $c$ BEGIN
  ALTER TABLE harness_shared.harness_issues_consolidated
    ADD CONSTRAINT harness_issues_consolidated_severity_check
    CHECK (severity IN ('critical', 'major', 'minor', 'nit'));
EXCEPTION WHEN duplicate_object THEN NULL; END $c$;

DO $c$ BEGIN
  ALTER TABLE harness_shared.harness_issues_consolidated
    ADD CONSTRAINT harness_issues_consolidated_status_check
    CHECK (status IN ('open', 'acknowledged', 'fixing', 'closed', 'wontfix'));
EXCEPTION WHEN duplicate_object THEN NULL; END $c$;

DO $c$ BEGIN
  ALTER TABLE harness_shared.harness_issues_consolidated
    ADD CONSTRAINT harness_issues_consolidated_source_check
    CHECK (source IN ('validator', 'worker', 'human', 'system'));
EXCEPTION WHEN duplicate_object THEN NULL; END $c$;

-- (3) Correct harness_pending_issues non-canonical DEFAULTs (no CHECK — keep the
--     live validator intake permissive; the code path clamps before consolidation).
--     Guarded: on a fresh embedded-pg baseline harness_admin owns this table and
--     the fix applies; on the standing dev box it was created under different
--     ownership, so ALTER raises insufficient_privilege — skip gracefully there
--     (the 'normal' default is never written anyway; append-pending always
--     supplies a severity, and Phase 3b clamps before consolidation).
DO $p$ BEGIN
  ALTER TABLE harness_shared.harness_pending_issues ALTER COLUMN severity SET DEFAULT 'minor';
  ALTER TABLE harness_shared.harness_pending_issues ALTER COLUMN source   SET DEFAULT 'validator';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'migration 130: skipping harness_pending_issues default fix (not table owner — dev-box ownership quirk)';
END $p$;

-- (4) Drop the dormant consolidation function (unused since migration 032).
DROP FUNCTION IF EXISTS harness_shared.sync_issues_consolidated() CASCADE;

COMMENT ON CONSTRAINT harness_issues_consolidated_severity_check
  ON harness_shared.harness_issues_consolidated IS
  'Canonical IssueSeverity (apps/operator/app/harness/issues/types.ts). engineer-issues-2026-06-03 D-004.';

COMMIT;
