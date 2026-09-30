-- Migration 602 — WI-4119 followBlockers derived-subscription metadata.
--
-- Direct work-item subscriptions remain the public inject-only surface. These
-- nullable columns let the same subscription rows represent one-hop blocker
-- follows without changing the target_ref seen by fan-out. A direct
-- subscription always has derived_from_* NULL; a derived row points back to
-- the subscribed dependent so unlink/settle can remove only the generated edge.

ALTER TABLE harness_shared.coord_entity_subscriptions
  ADD COLUMN IF NOT EXISTS follow_blockers BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS derived_from_kind TEXT,
  ADD COLUMN IF NOT EXISTS derived_from_ref TEXT;

CREATE INDEX IF NOT EXISTS coord_entity_subscriptions_derived_idx
  ON harness_shared.coord_entity_subscriptions
    (workspace_id, derived_from_kind, derived_from_ref)
  WHERE cancelled_at IS NULL AND derived_from_kind IS NOT NULL;

COMMENT ON COLUMN harness_shared.coord_entity_subscriptions.follow_blockers IS
  'WI-4119: direct work-item subscription opts into one-hop blocker follows; derived rows keep this false.';

COMMENT ON COLUMN harness_shared.coord_entity_subscriptions.derived_from_kind IS
  'WI-4119: source object kind for a generated blocker subscription; NULL marks a direct subscription.';

COMMENT ON COLUMN harness_shared.coord_entity_subscriptions.derived_from_ref IS
  'WI-4119: source object ref for a generated blocker subscription; paired with derived_from_kind.';
