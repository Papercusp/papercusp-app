-- 1187: owner-directive capture provenance (turn-start-memory-two-class-2026-09-21, P-003).
--
-- 1186 gave harness_shared.owner_directives its pending|open|dismissed lifecycle, but two
-- facts named by P-003 were still missing, and BOTH are lost at exactly the moment they
-- become interesting -- promotion:
--
--   * capture_promoted_at -- a pending row flipped to 'open' left no timestamp at all, so
--     "how long did this owner turn sit unresolved" was unanswerable after the fact.
--   * captured_by_hook    -- hook-captured rows are distinguishable from agent-recorded
--     ones only while they are still 'pending' (capture_status='pending' is written solely
--     by orders:capture-pending). Once promoted to 'open' they become indistinguishable
--     from an orders:record row, so provenance survived only until it was acted on.
--
-- Additive only: ADD COLUMN with a constant default is not a rewrite on PG11+, and nothing
-- currently deployed reads either column, so no FORWARD-COMPAT acknowledgment is owed.

ALTER TABLE harness_shared.owner_directives
  ADD COLUMN IF NOT EXISTS capture_promoted_at timestamptz,
  ADD COLUMN IF NOT EXISTS capture_promoted_by text,
  ADD COLUMN IF NOT EXISTS captured_by_hook boolean NOT NULL DEFAULT false;

-- Backfill the provenance we can still recover. A row sitting at 'pending' can only have
-- been written by the hook capture path, so it is safely attributable. Rows already
-- promoted or recorded directly keep the false default rather than being guessed at.
UPDATE harness_shared.owner_directives
   SET captured_by_hook = true
 WHERE capture_status = 'pending'
   AND captured_by_hook = false;

CREATE INDEX IF NOT EXISTS owner_directives_hook_captured_idx
  ON harness_shared.owner_directives (workspace_id, captured_by_hook, created_at)
  WHERE captured_by_hook;

COMMENT ON COLUMN harness_shared.owner_directives.capture_promoted_at IS
  'When a pending hook-captured owner turn was promoted to an open directive; NULL until promotion.';
COMMENT ON COLUMN harness_shared.owner_directives.capture_promoted_by IS
  'The agent (coord ownerId) that promoted the pending capture.';
COMMENT ON COLUMN harness_shared.owner_directives.captured_by_hook IS
  'True when the row originated from the UserPromptSubmit provenance hook (orders:capture-pending) rather than an agent calling orders:record. Survives promotion, unlike capture_status.';
