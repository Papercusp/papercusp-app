-- 1186: hybrid owner-directive capture (owner-directive-capture-hybrid-2026-09-21).
-- Pending rows are created by the owner-turn hook and must be promoted or
-- dismissed by the next agent turn. They remain visible until resolved.

ALTER TABLE harness_shared.owner_directives
  ADD COLUMN IF NOT EXISTS capture_status text NOT NULL DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS capture_dismissal_reason text,
  ADD COLUMN IF NOT EXISTS capture_dismissed_at timestamptz,
  ADD COLUMN IF NOT EXISTS capture_dismissed_by text;

ALTER TABLE harness_shared.owner_directives
  ADD CONSTRAINT owner_directives_capture_status_check
  CHECK (capture_status IN ('pending', 'open', 'dismissed'));

CREATE INDEX IF NOT EXISTS owner_directives_pending_idx
  ON harness_shared.owner_directives (workspace_id, created_at)
  WHERE capture_status = 'pending' AND dispositioned_at IS NULL;

COMMENT ON COLUMN harness_shared.owner_directives.capture_status IS
  'Hybrid capture lifecycle: pending hook capture, open agent-promoted directive, or dismissed with a reason.';
COMMENT ON COLUMN harness_shared.owner_directives.capture_dismissal_reason IS
  'Mandatory reason when an auto-captured pending owner turn is dismissed instead of promoted.';
