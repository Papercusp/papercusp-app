-- 211-harness-plans-updated-at-guard.sql
--
-- Make harness_plans.updated_at mean "last REAL activity", not "last row
-- write". The plans rail now sorts (and date-filters) on updated_at instead
-- of the authored frontmatter date (plan-rail sort feature, 2026-06-09), so
-- the timestamp has to be honest. Two problems with the mig-122 trigger:
--
--   1. It bumps on EVERY UPDATE with no change guard — bulk maintenance
--      sweeps (projection backfills, sync touches) stamp the whole table.
--      Live evidence on the dev box: 169/358 rows stamped 2026-06-04 (the
--      plans-pg-canonical-migration backfill) and 151 rows stamped inside
--      2026-06-09 07:00–09:00-04 (a single batch job) — 89% of plans
--      "updated" in two windows.
--   2. It overwrites an explicitly-set updated_at, so a repair backfill
--      couldn't even fix the polluted values.
--
-- Fix:
--   a. Replace the trigger fn: an EXPLICIT updated_at change is respected
--      (enables repair/backfill writes); otherwise bump ONLY when a
--      meaningful column changes — content_hash (covers all content +
--      frontmatter-index edits), the frontmatter index cols themselves
--      (belt-and-braces), op state, archived/legacy, supersede links.
--      Deliberately NOT meaningful: version (CAS bookkeeping), current_wave
--      (dispatch bookkeeping), items/decisions/now_state/now_next (content
--      projections — re-projection sweeps were polluter #2), _search
--      (generated), fed_ts/origin/author_pubkey (sync plumbing).
--   b. One-time repair of the two identified bulk windows: reset updated_at
--      to the authored frontmatter date (midnight) when parseable, else
--      created_at — i.e. revert those rows to the pre-feature status quo;
--      organic writes re-bump them honestly from here on.
--
-- Idempotent: CREATE OR REPLACE + value-guarded UPDATEs (a re-run finds the
-- windows already drained / values already equal). No ALTER TABLE, no table
-- locks — row locks on ~320 rows only; deploy-safe under lock_timeout.

CREATE OR REPLACE FUNCTION harness_shared.set_harness_plans_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
BEGIN
  -- An explicit updated_at write (repair/backfill) wins — don't clobber it.
  IF NEW.updated_at IS DISTINCT FROM OLD.updated_at THEN
    RETURN NEW;
  END IF;
  -- Auto-bump only on meaningful change; a no-op or bookkeeping-only write
  -- (version / current_wave / projections / sync metadata) keeps the stamp.
  IF ROW(NEW.content_hash, NEW.title, NEW.status, NEW.owner, NEW.created, NEW.updated,
         NEW.op_status, NEW.op_started_at, NEW.op_priority,
         NEW.archived, NEW.is_legacy, NEW.supersedes, NEW.superseded_by)
     IS DISTINCT FROM
     ROW(OLD.content_hash, OLD.title, OLD.status, OLD.owner, OLD.created, OLD.updated,
         OLD.op_status, OLD.op_started_at, OLD.op_priority,
         OLD.archived, OLD.is_legacy, OLD.supersedes, OLD.superseded_by)
  THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$fn$;

-- Repair window 1: the 2026-06-04 PG-canonical backfill day.
-- Repair window 2: the 2026-06-09 07:00–09:00-04 batch sweep.
-- Target: authored frontmatter date when it parses, else created_at. Only
-- touch rows whose value actually changes (idempotent re-run = 0 rows).
UPDATE harness_shared.harness_plans
SET updated_at = COALESCE(
      (substring(updated FROM '^\d{4}-\d{2}-\d{2}'))::timestamptz,
      created_at)
WHERE (
        (updated_at >= '2026-06-04 00:00:00-04' AND updated_at < '2026-06-05 00:00:00-04')
     OR (updated_at >= '2026-06-09 07:00:00-04' AND updated_at < '2026-06-09 09:00:00-04')
      )
  AND updated_at IS DISTINCT FROM COALESCE(
      (substring(updated FROM '^\d{4}-\d{2}-\d{2}'))::timestamptz,
      created_at);
