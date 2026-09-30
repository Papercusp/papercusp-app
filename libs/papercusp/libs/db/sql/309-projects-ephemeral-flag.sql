-- 309-projects-ephemeral-flag.sql
-- P-008 (watchdog-and-exposed-systems-improvement-2026-06-18, keystone D-001):
-- a FIRST-CLASS `ephemeral` flag on harness_shared.projects so the watchdog (and
-- other systems — e.g. P-001 teardown reaping) can treat throwaway benchmark / gym /
-- e2e harness instances as debris principled-ly, instead of relying solely on the
-- P-006 slug-regex (EPHEMERAL_BENCHMARK_SLUG_RE in watchdog.ts). The regex remains the
-- read-time fallback; this column is the queryable, override-able record.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + a backfill that only flips false→true.
ALTER TABLE harness_shared.projects
  ADD COLUMN IF NOT EXISTS ephemeral boolean NOT NULL DEFAULT false;

-- Backfill existing ephemeral/benchmark instances. The pattern MIRRORS
-- EPHEMERAL_BENCHMARK_SLUG_RE (watchdog.ts P-006) — keep the two in sync. Only ever
-- flips false→true, so re-running is a no-op.
UPDATE harness_shared.projects
   SET ephemeral = true
 WHERE ephemeral = false
   AND slug ~* '(^|[^a-z0-9])(xbench|xbq[a-z0-9]{6}|hiveloop|memcap|memrun)|-instance[_-]|_instance[_-]|deleteme|^e2e-imp|^sb-gym|gym-eval|^bench-|smoke-p[0-9]';

-- A partial index keeps the watchdog's "is this slug ephemeral?" lookup cheap
-- (the common case is the small set of flagged rows).
CREATE INDEX IF NOT EXISTS projects_ephemeral_idx
  ON harness_shared.projects (slug) WHERE ephemeral = true;
