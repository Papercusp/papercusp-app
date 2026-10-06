-- 1381 — Google Calendar provider cutover: retire the legacy host Calendar poll routine.
--
-- Plan generalized-integrations-google-migration-cupboard-workflows-2026-10-05, P-009,
-- decision D-021 (following D-020 for Gmail).
--
-- Google Calendar data sources (kind `gcal`) are now synced by the ONE connector driver
-- (`system:connector-sync`) through the bundled `google-calendar` provider plugin. The legacy
-- `system:google-calendar-poll` action no longer exists in the code, so the routine 888 created
-- would fire every minute and do nothing on a new build, and on an old build would keep announcing
-- upcoming events under its own delivery keys beside the connector's.
--
-- Deliberately NOT done here:
--   * No data_sources.cursor seed. The provider declares `sync.adopt`, and the driver adopts each
--     source's legacy cursor (syncToken, lastSyncAt) on its FIRST pass, recording the poll's last
--     run so the first upcoming windows skip what the poll already announced (D-021.5/.6).
--   * No trigger_bindings change. The gcal bindings (one armed meeting-prep binding on
--     ext:gcal:event-upcoming) keep their source, pattern and run history; the connector emits
--     the same event names.
--
-- Ordering: this file is armed in the same git-sync sweep as the google-calendar plugin manifest,
-- so no committed build both registers the gcal provider and leaves the legacy routine live.
-- Idempotent: a re-run deletes nothing.

DELETE FROM harness_shared.routines
 WHERE target_role = 'system:google-calendar-poll';
