-- 606-saved-prompts-completed.sql
--
-- quick-panel-workflowy-clone-2026-07-14 P-001 (WI-4840): Workflowy-style
-- complete/strikethrough for the Quick Panel prompts outline. NULL = active;
-- a timestamp = when the node was checked off. Completion is visual and
-- organizational only — a completed prompt still materializes as a
-- /slash-command (D-003); archive (archived_at, migration 598) is what
-- removes a node from both the outline and the projection.

ALTER TABLE harness_shared.saved_prompts
  ADD COLUMN IF NOT EXISTS completed_at timestamp with time zone;
