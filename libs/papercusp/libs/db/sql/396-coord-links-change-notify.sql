-- 396-coord-links-change-notify.sql
--
-- caching-layer-tag-eca-2026-06-22 P-013 (the AUDIT-BLOCKER) + P-005 trigger-coverage.
--
-- coord_links is the rel='blocks' feature→feature blocking edge table (EI-1/D-027, the
-- single source of truth for feature blocking) AND the rel='implements' plan-item↔work-item
-- ledger edge table. It had NO change-notify trigger, so the single most important
-- readiness-changing mutation — a blocker edge add/remove — emitted NOTHING into the
-- `sync_invalidate` stream. The cache↔change-stream ECA rule (wildcard `*.changed` →
-- cache.bumpTags) and any coord_links-tagged readiness cache entry therefore never
-- invalidated on a blocker change. Migration 373 attached emit_change_notify to 28 synced
-- tables but EXCLUDED coord_links; this completes the coverage so readiness invalidation is
-- sourced from BOTH the edge table AND the base item tables (work_items already has it).
--
-- SAFE: coord_links is LOW-CHURN (~5k rows, ~30 writes/hour, a couple dozen blocks-edges) and
-- the generic notify is deduped by the sync bus to one `harness_shared.coord_links.changed`
-- per tick — far from the append-heavy notify-storm class (audit_log / agent_runs_consolidated
-- / user_actions / harness_hook_logs / toast_log / feature_audit_consolidated) that 373
-- deliberately excluded. emit_change_notify includes the row PK (`id`) generically (mig 368);
-- coord_links has an `id` identity PK, so `coord_links:<id>` row-tag invalidation works too.
--
-- ALSO completes P-005 coverage for adv_sessions: it was added to TABLE_TO_QUERY_NAMES
-- (mapping to advSessions.list / advRoster.list) on 2026-06-23 by an unrelated change
-- (scheduler:running) WITHOUT attaching the producer trigger — the exact silent drift the
-- cache-tag-trigger-coverage guard exists to catch. adv_sessions is a base table of
-- ADV/OMP session STATE (relkind 'r', has an `id` PK), not an append-heavy log and not a
-- compat view, so the correct fix is the trigger (so raw-SQL / FEDERATED session-state
-- writes invalidate the session-list + roster queries), not a COVERAGE_EXEMPT entry.
--
-- Idempotent (CREATE OR REPLACE TRIGGER; safe to re-run / re-deploy).

CREATE OR REPLACE TRIGGER emit_change_notify_trg
  AFTER INSERT OR UPDATE OR DELETE ON harness_shared.coord_links
  FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();

CREATE OR REPLACE TRIGGER emit_change_notify_trg
  AFTER INSERT OR UPDATE OR DELETE ON harness_shared.adv_sessions
  FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();
