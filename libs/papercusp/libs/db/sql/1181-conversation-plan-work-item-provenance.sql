-- 1181-conversation-plan-work-item-provenance.sql
-- EI-23245293187768303: a recovered plan owner needs durable proof that an
-- owner-question gate belongs to the same plan/work-item lane. Nullable values
-- are intentional: legacy and operator-scoped rows cannot be backfilled safely
-- and must continue to fail closed for cross-owner supersession.

ALTER TABLE harness_shared.coord_conversations
  ADD COLUMN IF NOT EXISTS plan_slug text,
  ADD COLUMN IF NOT EXISTS work_item_id text;

COMMENT ON COLUMN harness_shared.coord_conversations.plan_slug IS
  'Validated current plan lane of the opener; NULL means legacy/unscoped and cannot authorize recovered-owner supersession.';

COMMENT ON COLUMN harness_shared.coord_conversations.work_item_id IS
  'Validated live work-item claim paired with plan_slug for recovered-owner supersession authorization.';

CREATE INDEX IF NOT EXISTS coord_conversations_lane_provenance_idx
  ON harness_shared.coord_conversations (workspace_id, plan_slug, work_item_id)
  WHERE plan_slug IS NOT NULL AND work_item_id IS NOT NULL;
