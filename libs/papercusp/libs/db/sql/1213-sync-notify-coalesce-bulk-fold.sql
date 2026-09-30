-- 1213-sync-notify-coalesce-bulk-fold.sql
--
-- P-525 (plan p2p-join-catchup-speed-2026-09-23, D-013) — a bulk read-merge fold
-- sends one sync_invalidate per table per transaction, not one per row.
--
-- WHAT WAS WRONG
--   emit_change_notify() is a row-level trigger shared by 88 tables. Every row it
--   fires on sends pg_notify('sync_invalidate', ...) with that row's id, so no two
--   payloads in a transaction are equal and PG delivers every one of them. A fresh
--   device folding a peer's snapshot set writes ~1.4M rows in batches of about a
--   thousand, and each row's notification comes straight back to the same process
--   through its LISTEN connection.
--
-- MEASURED 2026-09-24 (P-007 run #3, Mac VM, build 0f1d0bd04e33)
--   * The set crossed at ~230-250 rows/s; at that pace a fresh join misses the
--     plan's 1-hour target by over an hour.
--   * A 30 s CPU profile of the serve process: the PG NotificationResponse ->
--     invalidation-bus path was 22.8% of the main thread, more than the fold's
--     own query-result handling (~17%).
--
-- THE FIX
--   A read-merge batch transaction opened for bulk work sets the transaction-local
--   GUC papercusp.sync_notify_coalesce = 'on'. Under it this trigger sends a
--   TABLE-SCOPED payload with no row id. PG delivers identical payloads on one
--   channel once per transaction, so a batch of N rows on one table produces one
--   notification at COMMIT.
--
--   Coarser, not lossy: an id-less '<schema>.<table>.changed' already means "this
--   table changed". The sync bridge turns it into a full bust of the mapped queries
--   (resolveBridgeTarget returns the bare query name when there is no row id), and
--   the cache ECA rule bumps the table tag (tagsForTableChange), which row-scoped
--   cached reads carry alongside their row tag (e.g. work_items:get tags both
--   'work_items' and 'work_items:<id>').
--
--   Without the GUC (every writer except a bulk fold) the per-row payload is
--   unchanged. The WI-924391 resource-governor skip (mig 1026) still runs first.
--   Forward compatible: the currently deployed release never sets the GUC.

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

  -- P-525 (D-013) — a bulk read-merge fold: one table-scoped payload per table per
  -- transaction (PG dedupes identical payloads), instead of one per row.
  IF current_setting('papercusp.sync_notify_coalesce', true) = 'on' THEN
    PERFORM pg_notify('sync_invalidate', jsonb_build_object(
      'name', q_name,
      'args', jsonb_build_object('workspace_id', ws_id, 'op', 'COALESCED')
    )::text);
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
