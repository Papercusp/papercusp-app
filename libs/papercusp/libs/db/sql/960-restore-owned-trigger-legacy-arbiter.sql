-- 960-restore-owned-trigger-legacy-arbiter.sql — WI-41703
--
-- Migration 959 introduced the account-scoped source identity required for
-- multi-account Google Workspace connections. It also removed the legacy
-- owner+kind arbiter too early: the currently deployed release still names
-- that exact tuple in ON CONFLICT, while database migrations apply ahead of
-- the release checkout.
--
-- Keep both arbiters during the deploy window. The account-aware writer can
-- deploy against this expanded schema; a later CONTRACT migration removes the
-- legacy index only after the release no longer targets it. Until that contract
-- lands, connecting a second account of the same source kind is intentionally
-- blocked by the legacy index instead of breaking the live writer fleet-wide.
--
-- FORWARD-COMPAT: this EXPAND migration restores the same partial UNIQUE index,
-- columns, and predicate used by the currently deployed writer, so its existing
-- ON CONFLICT (workspace_id, kind, owner_user_id) WHERE owner_user_id IS NOT NULL
-- remains inferable throughout the code-deploy window.

CREATE UNIQUE INDEX IF NOT EXISTS trigger_sources_owned_user_kind_uidx
  ON harness_shared.trigger_sources (workspace_id, kind, owner_user_id)
  WHERE owner_user_id IS NOT NULL;

COMMENT ON INDEX harness_shared.trigger_sources_owned_user_kind_uidx IS
  'Temporary WI-41703 deploy-window arbiter for the legacy owner+kind writer; remove only after the account-aware writer is deployed.';
