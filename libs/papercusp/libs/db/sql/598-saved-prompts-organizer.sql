-- 598-saved-prompts-organizer.sql
--
-- quick-panel-saved-prompts-2026-07-13 P-001: extend harness_shared.saved_prompts
-- (migration 105, plan saved-prompts-cross-client-2026-06-02) with Workflowy-style
-- organizer columns for the Quick Panel prompts tab. Every row is both an outline
-- node AND (when body is non-empty) a materializable prompt; an empty body marks a
-- pure folder node, which the slash-command projector skips.
--
--   parent_id    — outline nesting; FK CASCADE = deleting a node deletes its subtree
--                  (Workflowy semantics). NULL = root.
--   position     — fractional index (fractional-indexing package) ordering siblings;
--                  NULL for legacy rows (they sort after positioned rows, by name).
--   title        — free-text display title; NULL falls back to `name` (the unique
--                  kebab slash-command key, unchanged).
--   collapsed / pinned / usage_count / last_used_at / archived_at — panel state.
--
-- Also attaches the generic change-notify trigger (emit_change_notify, migrations
-- 507/584) so writes push sync invalidations to useSyncQuery subscribers.

ALTER TABLE harness_shared.saved_prompts
  ADD COLUMN IF NOT EXISTS parent_id uuid,
  ADD COLUMN IF NOT EXISTS position text,
  ADD COLUMN IF NOT EXISTS title text,
  ADD COLUMN IF NOT EXISTS collapsed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS usage_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_used_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS archived_at timestamp with time zone;

-- Subtree delete follows the parent (Workflowy semantics).
DO $$ BEGIN
  ALTER TABLE harness_shared.saved_prompts
    ADD CONSTRAINT saved_prompts_parent_fk FOREIGN KEY (parent_id)
      REFERENCES harness_shared.saved_prompts(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS saved_prompts_scope_parent
  ON harness_shared.saved_prompts USING btree (workspace_id, COALESCE(harness_slug, ''::text), parent_id);

-- Change-notify trigger → sync_invalidate LISTEN bridge (sync-sse.ts) →
-- savedPrompts.byScope subscribers refetch. Idempotent via drop-then-create.
DROP TRIGGER IF EXISTS saved_prompts_change_notify ON harness_shared.saved_prompts;
CREATE TRIGGER saved_prompts_change_notify
  AFTER INSERT OR UPDATE OR DELETE ON harness_shared.saved_prompts
  FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();
