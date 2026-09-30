-- 383-drop-dead-coord-links-blocks-trigger.sql
--
-- work-item-deps-and-readiness-2026-06-22 P-009 — drop the now-DEAD bespoke mig-366
-- coord_links blocks change-notify trigger (emit_blocks_edge_change_notify).
--
-- WHY IT IS DEAD (zero consumers):
--   • mig-366 added this scoped trigger to invalidate the READINESS CACHE on a feature→feature
--     blocks-edge change. But readiness is no longer cached — it is a MAINTAINED sidecar
--     (harness_shared.work_item_blocked, migration 379) kept exact by its OWN triggers (wir_*) on
--     work_item_deps, not coord_links (work-item-deps-and-readiness D-003).
--   • The dispatch frontier + Queen survey + the scheduler claim all read blocking from
--     work_item_deps now (the P-004 seam cutover), not coord_links.
--   • The sync bridge (sync-resolver/table-to-query-names.ts) maps NO coord_links query, and the
--     cache↔change-stream ECA rule listens on the generic '<schema>.<table>.changed' key — this
--     trigger emits 'harness_shared.coord_links.blocks', which matches nothing.
--   So the trigger fires a pg_notify('sync_invalidate', …) on every blocks-edge write with no
--   listener. (We deliberately do NOT re-attach the generic emit_change_notify to coord_links:
--   it is a high-volume polymorphic edge table — tags/relates/duplicates/fixes/blocks — and the
--   generic trigger would firehose sync_invalidate on every tag write, the exact thing mig-366
--   scoped away. Nothing needs coord_links change events today.)
--
-- Idempotent (DROP … IF EXISTS). No table rewrite; a brief lock on coord_links to drop the trigger.

DROP TRIGGER IF EXISTS emit_blocks_edge_change_notify_trg ON harness_shared.coord_links;
DROP FUNCTION IF EXISTS harness_shared.emit_blocks_edge_change_notify();
