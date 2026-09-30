-- 380 — attach harness_shared.emit_change_notify() to harness_design_artifacts.
--
-- data-sync-push-completion-2026-06-23 P-003: the Design tab's sketch pane reads
-- `designSketches.byFeature` (sync-resolver) off harness_shared.harness_design_artifacts,
-- but the table carried NO change-notify trigger — so a saved sketch (POST
-- /api/design/sketches) never invalidated open sketch panes: the pane went stale
-- until the 180s drift-repair tick (or a manual refresh). Sketch writes also arrive
-- cross-machine via git-doc FEDERATION (the table is a GIT_DOCS bucket — table-registry.ts),
-- and a federated/raw-SQL write can't run an app-code notifySyncInvalidate — the PG
-- trigger is the only producer that covers every write path (same rationale + pattern
-- as 227 / 222 / 124 / 107).
--
-- Pairs with the bridge entry added in the same change:
--   'harness_shared.harness_design_artifacts': ['designSketches.byFeature']
-- (table-to-query-names.ts). The cache-tag-trigger-coverage integration guard requires
-- every mapped table to carry this trigger, so the bridge entry and this trigger land
-- together.
--
-- Idempotent: CREATE OR REPLACE TRIGGER.

CREATE OR REPLACE TRIGGER emit_change_notify_trg
  AFTER INSERT OR UPDATE OR DELETE ON harness_shared.harness_design_artifacts
  FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();
