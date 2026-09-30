-- 889-owned-trigger-source-uniqueness.sql — WI-40654
--
-- A local user has one v1 source row per provider kind. OAuth re-consent updates
-- that row's opaque credential reference instead of minting parallel pollers
-- with divergent cursors and duplicate Personal Vault fan-out.
--
-- FORWARD-COMPAT: this partial unique index and its only matching
-- ON CONFLICT (workspace_id, kind, owner_user_id) callsite in
-- packages/operator-core/lib/external-triggers/source-store.ts ship together in
-- this candidate. The currently deployed release has no owned-source upsert and
-- therefore cannot target or depend on this new arbiter before promotion.

CREATE UNIQUE INDEX IF NOT EXISTS trigger_sources_owned_user_kind_uidx
  ON harness_shared.trigger_sources (workspace_id, kind, owner_user_id)
  WHERE owner_user_id IS NOT NULL;

COMMENT ON INDEX harness_shared.trigger_sources_owned_user_kind_uidx IS
  'One owned source per workspace/provider-kind/local-user. Re-consent updates this row and preserves its replay cursor.';
