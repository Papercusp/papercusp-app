-- 625-emit-change-notify-feature-id-fallback.sql
--
-- WI-4513 — extend the mig-507/584 natural-key-fallback pattern to restore a real
-- row PK for `harness_shared.work_items` (mig-374's unified base table) and its
-- id-less feature_id-keyed siblings.
--
-- PROVEN (WI-4513, 2026-07-13): mig-374 renamed `harness_features_consolidated` ->
-- `work_items` and made `feature_id` (not `id`) its identity column (PK:
-- harness_slug, feature_id) — the base table carries NO `id` column at all. The
-- generic `emit_change_notify()` trigger (mig 368) reads
-- `to_jsonb(COALESCE(NEW,OLD))->'id'`, which is JSON null for any id-less table, so
-- EVERY work_items write emits `args.id = null`. Two live consequences:
--   1. work_items:get's `work_items:<feature_id>` row-level cache tag
--      (cache-eca-rule.ts tagsForTableChange) is INERT — only the coarse
--      table-level `work_items` tag ever bumps (get.ts's WI-4491 comment tracked
--      this as a follow-up defect).
--   2. The sync-bridge (table-to-query-names.ts) cannot per-row-scope a
--      work_items invalidation — moot today (every `harness_shared.work_items`
--      registry entry is a bare-string full-bust; none opts into `{ name, scope }`
--      yet), but latent for the next per-row consumer.
--
-- FIX (CREATE OR REPLACE, idempotent, no table/trigger rewrite — every table
-- already pointed at this function via 107-dogfood-reactivity-triggers.sql picks
-- up the new body immediately): additively fall back to `args.feature_id` when
-- `args.id` is absent — `row_id := COALESCE(row_jsonb->'id', row_jsonb->'feature_id')`
-- — exactly the COALESCE this file's own predecessor (mig 507's header comment)
-- anticipated ("just add its column name to the fallback chain").
--
-- BLAST-RADIUS AUDIT (why this is safe to land as a plain COALESCE on the shared
-- `id` output, rather than a new additive field like `plan_slug`/`harness_slug`):
--   - `feature_id` is a genuine surrogate identity ONLY for the id-less tables
--     that are ALSO wired to this trigger: `work_items` (née
--     harness_features_consolidated), `feature_claims`, `feature_queue`,
--     `feature_working_set`, `harness_feature_prs`. Every OTHER `feature_id`-bearing
--     table in the schema either (a) already HAS its own `id` column — so
--     COALESCE picks `id` first and this fallback never triggers for it
--     (adaptive_telemetry, agent_chats_consolidated, claim_audit,
--     feature_audit_consolidated, harness_design_artifacts,
--     prompt_compositions, tool_invocations, …) — or (b) is not attached to
--     `emit_change_notify_trg` at all (agent_runs_consolidated,
--     harness_chunk_plans, harness_feature_debug_notes, harness_feature_notes,
--     harness_generator_items, harness_lanes, harness_pending_issues,
--     pending_reviews, snapshot_features, spawned_agents) — so this trigger body
--     never runs for them regardless.
--   - Of the 5 affected id-less+triggered tables, table-to-query-names.ts maps
--     `work_items`, `feature_claims`, and `harness_feature_prs` — every mapped
--     entry today is a bare-string full-bust; none is a `{ name, scope }` target,
--     so a newly-non-null `args.id` cannot flip any existing consumer from
--     full-bust to (mis-)scoped. `feature_queue` / `feature_working_set` are
--     unmapped (no bridged query names) — irrelevant to the sync-bridge either
--     way. The ONLY live effect is a NEW row-level cache tag
--     (`<table>:<feature_id>`) from tagsForTableChange, which is strictly
--     additive precision (an extra tag can only narrow future staleness, never
--     under-invalidate — a missed bump self-heals via TTL per the ECA docs).
--
-- BACKWARD-COMPATIBLE: `args.id` was already JSON null for every affected table;
-- it is now populated for the 5 id-less+feature_id+triggered tables above and
-- unchanged for everything else. No existing consumer reads `args.id` as
-- "definitely NOT a feature_id" for any of these 5 tables.

CREATE OR REPLACE FUNCTION harness_shared.emit_change_notify() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  payload      jsonb;
  ws_id        text;
  q_name       text;
  row_id       jsonb;
  row_jsonb    jsonb;
  plan_slug    jsonb;
  harness_slug jsonb;
BEGIN
  ws_id := current_setting('app.workspace_id', true);
  q_name := TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME || '.changed';
  row_jsonb := to_jsonb(COALESCE(NEW, OLD));

  -- WI-4513: fall back to `feature_id` for tables with no surrogate `id` column
  -- (work_items and its id-less feature_id-keyed siblings — see header audit).
  -- JSON null for every table with neither column, unchanged for every table
  -- that already has a real `id`.
  row_id := COALESCE(row_jsonb -> 'id', row_jsonb -> 'feature_id');

  plan_slug := row_jsonb -> 'plan_slug';
  harness_slug := row_jsonb -> 'harness_slug';

  payload := jsonb_build_object(
    'name', q_name,
    'args', jsonb_build_object(
      'workspace_id', ws_id,
      'op',           TG_OP,
      'id',           row_id,
      'plan_slug',    plan_slug,
      'harness_slug', harness_slug
    )
  );
  PERFORM pg_notify('sync_invalidate', payload::text);

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
