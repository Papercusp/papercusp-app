-- 1026-governor-receipts-skip-sync-notify.sql
--
-- WI-924391 — stop resource-governor admission receipts firing sync_invalidate.
-- This is migration 1025's guard applied to the SECOND channel the same rows flood.
--
-- WHAT WAS WRONG
--   1025 stopped receipts entering harness_shared.substrate_outbox (federation).
--   But work_items carries a SECOND per-row notifier: emit_change_notify, which
--   PERFORM pg_notify('sync_invalidate', ...) unconditionally on INSERT, UPDATE and
--   DELETE. resource-governor/queue.ts writes one work_items row per admission and
--   mutates it queued -> leased -> running -> completed, so every one of those
--   transitions also published a sync-invalidation for
--   'harness_shared.work_items.changed'.
--
--   That invalidation is table-scoped, not row-scoped: it re-runs EVERY registered
--   sync query backed by work_items, in EVERY connected client, for state that no
--   query surfaces. Nothing reads these rows — a grep of the sync resolvers
--   (packages/operator-core/lib/sync-resolver) and apps/operator for
--   resource_governor / resourceGovernor matches ZERO files.
--
-- MEASURED / DERIVED 2026-08-29 (papercusp, live)
--   * MEASURED: 795,447 receipt rows in work_items (98.4% of the 798,353 local
--     task rows; 793,944 of them terminal), entire pile accumulated since 08-27.
--   * MEASURED (1025's header): 98,116 of 99,306 engineer_issues outbox puts in a
--     single hour were receipts.
--   * MEASURED DIRECTLY by LISTENing on sync_invalidate for a 10-second window
--     (2026-08-29 ~00:10Z): 164 notifications total, of which 125 (76%) were
--     'harness_shared.work_items.changed' — a rate of ~12.5/s, ~45,000/hour. Of the
--     DISTINCT work_items feature_ids appearing in that window, 80 were governor
--     receipts and 0 were anything else. Every work_items sync invalidation in the
--     sample was receipt-driven.
--     Caveats, stated so the number is not over-read: it is a single 10s window, and
--     the 80/0 split counts DISTINCT ids, so it does not weight repeat notifications
--     per id. The conclusion it supports is the qualitative one — real work was not
--     merely outnumbered on this channel, it was absent from the sample.
--
-- WHY THIS BLOCKS THE REAP
--   The 776k-row backlog delete is the point of WI-924391. With this trigger
--   unguarded, that reap emits ~776,000 pg_notify messages — all delivered to every
--   listener at COMMIT — which would convoy the very fleet the reap exists to
--   relieve. Guarding here is what lets the reap run under ordinary application
--   semantics instead of a superuser session_replication_role='replica' trick that
--   the recurring in-app retention GC could never use anyway (that setting is
--   superuser-only: pg_settings.context='superuser').
--
--   The other two DELETE triggers were checked and need no change:
--     * reject_work_item_delete_with_dependencies — MEASURED zero receipts
--       participate in any dep_type='blocks' edge, and work_item_deps (1,288 rows)
--       is indexed on both blocked and blocker, so the per-row probe is a cheap
--       index scan that can never raise for these rows.
--     * wir_delete_cleanup — MEASURED zero receipts have a work_item_blocked row,
--       and its lookup key is exactly that table's primary key.
--
-- WHY THE GUARD IS PINNED TO work_items
--   emit_change_notify is shared by 88 tables. The guard therefore tests
--   TG_TABLE_SCHEMA/TG_TABLE_NAME EXPLICITLY as well as the payload discriminator,
--   so its blast radius is exactly one table and cannot be widened by some other
--   table happening to store a 'resource_governor' key in a jsonb 'payload' column.
--   Relying on the payload shape alone would have been correct today and fragile
--   tomorrow.
--
-- FALSIFIABILITY (run in a rolled-back transaction; the control is the point)
--   Counting pg_notify is not possible after the fact, so the guard is proven by
--   LISTENing on sync_invalidate in the same session:
--     control (normal work_items row) -> notifications still delivered
--     subject (receipt row)           -> zero notifications
--   A subject-only measurement is worthless here: a LISTEN that was never wired up
--   reports zero for both. The control is what distinguishes a working guard from a
--   broken instrument — the same trap that produced three false readings on this
--   work-item earlier today.
--
-- NOT destructive DDL (CREATE OR REPLACE FUNCTION only): no FORWARD-COMPAT line is
-- required. The currently-deployed release keeps working — this strictly REMOVES
-- notifications for rows no query reads, and changes no table shape or contract.
--
-- Body below is the live definition of harness_shared.emit_change_notify verbatim
-- (pg_get_functiondef), with ONLY the receipt guard added.

CREATE OR REPLACE FUNCTION harness_shared.emit_change_notify()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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

  -- WI-924391 — Resource-governor admission receipts are EPHEMERAL LOCAL QUEUE
  -- STATE. No sync query reads them (zero matches for resource_governor across the
  -- sync resolvers and apps/operator), yet each admission published four
  -- table-scoped sync_invalidate notifications as it moved
  -- queued->leased->running->completed, re-running EVERY work_items-backed query in
  -- EVERY connected client for state nothing displays.
  --
  -- Pinned to work_items explicitly: this function is shared by 88 tables, and the
  -- table test keeps the blast radius at exactly one of them rather than trusting
  -- that no other table ever stores a 'resource_governor' key under 'payload'.
  --
  -- This also makes the WI-924391 backlog reap safe: without it, deleting the
  -- ~776k terminal receipts would emit ~776k notifications at COMMIT.
  --
  -- jsonb_exists() rather than the `?` operator: `?` collides with the driver
  -- placeholder in some clients that also execute this SQL.
  IF TG_TABLE_SCHEMA = 'harness_shared'
     AND TG_TABLE_NAME = 'work_items'
     AND jsonb_exists(COALESCE(row_jsonb -> 'payload', '{}'::jsonb), 'resource_governor')
  THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

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
$function$;
