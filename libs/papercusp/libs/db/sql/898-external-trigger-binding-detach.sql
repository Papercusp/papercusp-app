-- P-017: detach an external trigger binding without erasing its run history.
--
-- trigger_runs intentionally keeps a RESTRICT foreign key to trigger_bindings,
-- so a hard DELETE is not a valid detach operation once a binding has fired.
-- `detached_at` makes installed-vs-detached explicit while preserving the
-- immutable delivery/run audit trail. Readers that model current trigger
-- presence must select detached_at IS NULL; historical joins may still read all
-- rows.

ALTER TABLE harness_shared.trigger_bindings
  ADD COLUMN IF NOT EXISTS detached_at timestamptz;

COMMENT ON COLUMN harness_shared.trigger_bindings.detached_at IS
  'NULL while the source→plan binding is installed. Set on detach so run history remains addressable; detached bindings are always disarmed and excluded from current trigger presence/execution.';

CREATE INDEX IF NOT EXISTS trigger_bindings_installed_plan_idx
  ON harness_shared.trigger_bindings (workspace_id, plan_harness_slug, plan_slug)
  WHERE detached_at IS NULL;
