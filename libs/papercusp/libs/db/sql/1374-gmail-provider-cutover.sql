-- 1374 — Gmail provider cutover: retire the legacy host Gmail poll routine.
--
-- Plan generalized-integrations-google-migration-cupboard-workflows-2026-10-05, P-008,
-- decisions D-017, D-019 and D-020 (D-020 supersedes D-017.6's cursor seed and D-019.4's
-- binding deletion).
--
-- Gmail data sources are now synced by the ONE connector driver (`system:connector-sync`)
-- through the bundled `gmail` provider plugin. The legacy `system:google-gmail-poll` action no
-- longer exists in the code, so the routine 891 created would fire every minute and do nothing.
--
-- Deliberately NOT done here:
--   * No data_sources.cursor seed. The provider declares `sync.adopt`, and the driver adopts each
--     source's legacy cursor (historyId, backfill page token) on its FIRST pass. A seed written
--     here would freeze the history position while the legacy poll on not-yet-deployed hosts kept
--     advancing, and the replay of that gap would re-deliver mail under the connector's delivery
--     keys (which never collide with the legacy `gmail:<id>:message.received` keys).
--   * No trigger_bindings deletion. The five gmail-source bindings are all disarmed, and
--     trigger_runs.binding_fk references three of them ON DELETE RESTRICT (232 runs); deleting
--     them would fail, and forcing it would destroy run history.
--
-- Ordering: this file is armed in the same git-sync sweep as the gmail plugin manifest, so no
-- committed build both registers the gmail provider and leaves the legacy routine live.
-- Idempotent: a re-run deletes nothing.

DELETE FROM harness_shared.routines
 WHERE target_role = 'system:google-gmail-poll';
