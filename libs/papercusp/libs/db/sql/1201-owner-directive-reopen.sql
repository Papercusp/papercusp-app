-- 1201-owner-directive-reopen.sql
--
-- directive-ownership-clarity-2026-09-23 P-007 / D-005: orders:reopen.
--
-- On 2026-09-23 an agent closed five OTHER sessions' owner directives by mistake
-- and the only way to undo it was a raw `sudo -u postgres psql ... UPDATE
-- harness_shared.owner_directives SET disposition_status = NULL ...`, which left
-- no record of who reopened what or why. orders:reopen clears the disposition
-- through the same ownership rail as orders:disposition and records the reopen
-- here. Only the LATEST reopen is kept; the disposition it cleared is copied into
-- reopened_from so the wrong close stays visible after the undo.
--
-- Idempotent and additive only (ADD COLUMN IF NOT EXISTS): nothing live reads or
-- writes these columns before orders:reopen ships, so :3070 is unaffected.

ALTER TABLE harness_shared.owner_directives
  ADD COLUMN IF NOT EXISTS reopened_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reopened_by TEXT,
  ADD COLUMN IF NOT EXISTS reopen_reason TEXT,
  ADD COLUMN IF NOT EXISTS reopened_from TEXT;

COMMENT ON COLUMN harness_shared.owner_directives.reopened_at IS
  'When the directive was last reopened with orders:reopen (NULL = never reopened).';
COMMENT ON COLUMN harness_shared.owner_directives.reopened_by IS
  'Session (coord ownerId) that last reopened the directive.';
COMMENT ON COLUMN harness_shared.owner_directives.reopen_reason IS
  'Why it was reopened, as given to orders:reopen (mandatory).';
COMMENT ON COLUMN harness_shared.owner_directives.reopened_from IS
  'The disposition that the reopen cleared, as "<status> by <dispositioned_by> at <iso>: <note>", so an undone wrong close stays auditable.';
