-- 646-reexpose-terminal-reason-engineer-issues-view.sql
--
-- work-item-status-full-unify-2026-07-19 (P-009, owner hard-req D-001).
--
-- mig 638 added `terminal_reason` to the work_items BASE table; mig 640 deferred
-- re-exposing it through the two family compat VIEWS "to READERS ... to P-007".
-- P-007 did re-expose it on `engineer_issues` (+ harness_features_consolidated),
-- but ONLY via a live `CREATE OR REPLACE VIEW` that was never captured as a
-- migration — so the migration CHAIN (a fresh embedded-pg install / a new
-- federated peer / the fed-a·fed-b rig frames / the federated-column-completeness
-- test DB, all of which migrate 000→head) builds `engineer_issues` WITHOUT the
-- column. That is (a) a "schema = migrations only, no runtime DDL" rule violation,
-- (b) why the column-drift guard could not see the issue mapper drop terminal_reason
-- (federated-column-completeness.integration.test.ts introspects the chain view),
-- and (c) an incomplete-schema regression on every fresh box.
--
-- This migration makes the chain match live: the SELECT below is mig 588's
-- `engineer_issues` view VERBATIM (its chain column order) with `terminal_reason`
-- appended as the FINAL column — exactly the live view's shape (live == mig 588 +
-- terminal_reason at the end; relkind/attnum-verified 2026-07-20, NO internal
-- drift for this view, unlike harness_features_consolidated). So CREATE OR REPLACE
-- applies cleanly BOTH on the live DB (identical to the existing view → a no-op
-- redefinition) AND on a fresh chain DB (mig 588's 33 cols + terminal_reason
-- appended — the only allowed CREATE OR REPLACE shape change). CREATE OR REPLACE
-- (not DROP) preserves the view's INSTEAD OF DML triggers + dependents.
--
-- Idempotent: CREATE OR REPLACE VIEW is inherently a no-op when the definition
-- already matches. The companion feature-family view (harness_features_consolidated)
-- carries a PRE-EXISTING live↔chain column-order drift (mig 640's wave /
-- verified_done_at_remote_ts note) that a bare CREATE OR REPLACE cannot satisfy on
-- both DBs — its terminal_reason re-exposure needs a drift-normalizing DROP+CREATE
-- and is tracked separately; readers already read terminal_reason from the
-- work_items BASE table, so neither family has a functional reader regression.

CREATE OR REPLACE VIEW harness_shared.engineer_issues AS
  SELECT workspace_id,
     feature_id AS issue_id,
     CASE WHEN harness_slug LIKE 'operator:%' OR harness_slug = '' THEN 'operator'
          ELSE 'harness:' || harness_slug END AS scope,
     title,
     COALESCE(summary, '') AS body,
     COALESCE((payload -> '_ei') ->> 'severity', 'minor') AS severity,
     COALESCE((payload -> '_ei') ->> 'source', 'engineer') AS source,
     status AS state,
     taken_by AS assignee,
     (payload -> '_ei') ->> 'found_during' AS found_during,
     (payload -> '_ei') ->> 'linked_feature_id' AS linked_feature_id,
     (payload -> '_ei') ->> 'created_by' AS created_by,
     to_timestamp((created_ts::numeric / 1000.0)::double precision) AS created_at,
     to_timestamp((updated_ts::numeric / 1000.0)::double precision) AS updated_at,
     author_pubkey,
     origin,
     _search,
     item_kind AS kind,
     payload - '_ei' AS payload,
     (payload -> '_ei') ->> 'assigned_by' AS assigned_by,
     taken_at AS assigned_at,
     assignee_rank,
     rank_writer,
     rank_updated_at,
     fed_ts,
     COALESCE((payload -> '_ei') ->> 'signal_origin', 'organic') AS signal_origin,
     fed_hlc,
     terminal_owner,
     terminal_completion_ref,
     last_progress_at,
     harness_slug AS base_harness_slug,
     origin AS base_origin,
     feature_order,
     terminal_reason
    FROM harness_shared.work_items
   WHERE item_kind = ANY (ARRAY['bug', 'change', 'task']);
