-- 975-remove-owned-trigger-legacy-arbiter.sql — EI-21529326623262803
--
-- CONTRACT step for migrations 959/960. The account-aware writer now targets
-- (workspace_id, kind, owner_user_id, provider_account_id), so the temporary
-- owner+kind arbiter restored by migration 960 has completed its deploy-window
-- purpose. Keeping it would reject a second provider account before the
-- account-aware unique index can arbitrate the row.
--
-- The DROP is intentionally idempotent for fresh databases and repaired
-- installations where the compatibility index may already be absent.

DROP INDEX IF EXISTS harness_shared.trigger_sources_owned_user_kind_uidx;

COMMENT ON INDEX harness_shared.trigger_sources_owned_account_kind_uidx IS
  'One source kind per workspace/local-owner/provider-account; distinct provider accounts keep independent rows and cursors.';
