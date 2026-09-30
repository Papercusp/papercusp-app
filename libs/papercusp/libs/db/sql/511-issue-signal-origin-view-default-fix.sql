-- 511-issue-signal-origin-view-default-fix.sql
--
-- ROOT CAUSE: `engineer_issues` is a view over `work_items`, computing
-- `signal_origin AS COALESCE(payload->'_ei'->>'signal_origin', 'local')`.
-- Migration 403 (work-items-signal-origin-restore) attached
-- `work_items_signal_origin_chk` restricting the STORED value to
-- NULL | 'organic' | 'drill' | 'replay' | 'shadow' — and correctly set the
-- view's default to 'organic' to match. Migration 432 kept that default.
--
-- Migrations 509 (issue-family-progress-and-takenat) and 510
-- (engineer-issues-view-dml-target-row) each had to CREATE OR REPLACE the
-- whole view for an unrelated column/identity fix, and both re-derived the
-- view text from an OLDER copy that still used 'local' as the signal_origin
-- default (374/382/423/446/452/454 — the CDC/outbox-capture copies, which
-- legitimately use 'local' for a DIFFERENT field's default and were the
-- template accidentally copied from). That silently reverted 403/432's fix.
--
-- IMPACT: any UPDATE through the engineer_issues view (work_items:release,
-- and any other issue-family view-DML path) on a row whose STORED
-- signal_origin is NULL computes NEW.signal_origin = 'local' (the view's own
-- default) for the unset column, and the INSTEAD OF UPDATE trigger writes
-- that 'local' value straight back into payload->'_ei'->>'signal_origin' —
-- which the CHECK constraint then rejects ("new row for relation work_items
-- violates check constraint work_items_signal_origin_chk"). Confirmed live:
-- 1784 of 10077 issue-family (bug/change/task) rows currently have a NULL
-- stored signal_origin and are exposed to this landmine (EI-7474 drain wave,
-- 2026-07-05 — work_items:release on WI-2719 hit it first).
--
-- FIX: restore the view's signal_origin default to 'organic', identical to
-- migration 510's view otherwise (base_harness_slug / v_slug identity fix
-- preserved verbatim — do not regress it). No data backfill needed: the
-- affected rows are still NULL (the earlier writes failed the constraint and
-- rolled back, so nothing bad was ever persisted) — they will read/write
-- 'organic' correctly the moment this view default is corrected.
--
-- CREATE OR REPLACE VIEW only; no top-level BEGIN/COMMIT.

CREATE OR REPLACE VIEW harness_shared.engineer_issues AS
  SELECT
    workspace_id,
    feature_id AS issue_id,
    COALESCE(payload->'_ei'->>'scope',
             CASE WHEN harness_slug = '' THEN 'operator' ELSE 'harness:' || harness_slug END) AS scope,
    title,
    COALESCE(summary, '') AS body,
    COALESCE(payload->'_ei'->>'severity', 'minor') AS severity,
    COALESCE(payload->'_ei'->>'source', 'engineer') AS source,
    status AS state,
    taken_by AS assignee,
    payload->'_ei'->>'found_during' AS found_during,
    payload->'_ei'->>'linked_feature_id' AS linked_feature_id,
    payload->'_ei'->>'created_by' AS created_by,
    to_timestamp(created_ts / 1000.0) AS created_at,
    to_timestamp(updated_ts / 1000.0) AS updated_at,
    author_pubkey, origin, _search,
    item_kind AS kind,
    (payload - '_ei') AS payload,
    payload->'_ei'->>'assigned_by' AS assigned_by,
    taken_at AS assigned_at,
    assignee_rank, rank_writer, rank_updated_at, fed_ts,
    -- FIX (was 'local', reverted here to 'organic' to match
    -- work_items_signal_origin_chk's allowed vocabulary — see header).
    COALESCE(payload->'_ei'->>'signal_origin', 'organic') AS signal_origin,
    fed_hlc,
    terminal_owner,
    terminal_completion_ref,
    last_progress_at,
    harness_slug AS base_harness_slug
  FROM harness_shared.work_items
  WHERE item_kind IN ('bug', 'change', 'task');
