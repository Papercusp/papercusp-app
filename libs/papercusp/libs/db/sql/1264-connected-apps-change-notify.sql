-- 1264-connected-apps-change-notify.sql — external-app-access-to-workspaces-2026-09-29 P-010
-- (WI-10004023), decision D-025.
--
-- Settings → Remote access reads the sync query `remoteAccess.overview`, built from
-- harness_shared.connected_apps (phones, app keys, service keys) and
-- harness_shared.connected_app_access_settings (the per-workspace switch, migration 1263). Keys are
-- created, rotated, paused and revoked by several paths (the screen's routes, "Connect an app", the
-- device-code and OAuth sign-ins, phone pairing, the access tools), so an open screen must be
-- invalidated by the TABLE, not by each writer remembering to notify. Reuse the established sync
-- trigger, exactly as migration 985 did; the table-to-query-names bridge maps both tables to the
-- query. connected_apps.last_seen is written at most once a minute per key (recordAppKeyUse), and
-- the sync bus dedupes, so the added fan-out is small.
--
-- Additive only: two triggers. Nothing the deployed release reads changes.

CREATE OR REPLACE TRIGGER emit_change_notify_trg
  AFTER INSERT OR UPDATE OR DELETE ON harness_shared.connected_apps
  FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();

CREATE OR REPLACE TRIGGER emit_change_notify_trg
  AFTER INSERT OR UPDATE OR DELETE ON harness_shared.connected_app_access_settings
  FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();
