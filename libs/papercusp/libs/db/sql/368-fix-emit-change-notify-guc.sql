-- 368-fix-emit-change-notify-guc.sql
--
-- work-item-deps-and-readiness-2026-06-22 — P-006 (fix the GENERIC emit_change_notify trigger GLOBALLY).
--
-- WHY: harness_shared.emit_change_notify() (000-baseline.sql) is the producer of the `sync_invalidate`
-- LISTEN/NOTIFY stream and is attached to ~19 reactive tables (107-dogfood-reactivity-triggers.sql +
-- 124/213/215/222/227/275). It read `current_setting('papercusp.workspace_id', true)` for the payload's
-- `workspace_id`, but the runtime sets the GUC under the `app.workspace_id` key (see the per-request
-- set_config in the sync/operator layer, and the dedicated triggers in 366/367 which already read
-- `app.workspace_id`). Result: EVERY generic-trigger notify carried `workspace_id = NULL`, so any
-- workspace-scoped sync consumer could not scope the invalidation.
--
-- FIX (CREATE OR REPLACE, idempotent — no table/trigger rewrite; all ~19 triggers keep pointing at the
-- same function and pick up the new body immediately):
--   (a) read `current_setting('app.workspace_id', true)` instead of `papercusp.workspace_id`; and
--   (b) ADDITIVELY include the changed row's primary key in `args.id` — `to_jsonb(COALESCE(NEW,OLD))->'id'`
--       so it works for every triggered table generically (yields JSON null when the table has no `id`
--       column, e.g. known_schema_versions/trusted_authors — no error, just absent).
--
-- BACKWARD-COMPATIBLE: the payload shape (`{ name, args:{ workspace_id, op } }`) is unchanged except for
-- the corrected workspace_id value and the NEW additive `args.id`. Existing consumers ignore extra fields.

CREATE OR REPLACE FUNCTION harness_shared.emit_change_notify() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  payload jsonb;
  ws_id   text;
  q_name  text;
  row_id  jsonb;
BEGIN
  ws_id := current_setting('app.workspace_id', true);
  q_name := TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME || '.changed';

  -- Additive: the changed row's primary key, generically. NULL (absent) when the
  -- triggered table has no `id` column — consumers ignore the extra field either way.
  row_id := to_jsonb(COALESCE(NEW, OLD)) -> 'id';

  payload := jsonb_build_object(
    'name', q_name,
    'args', jsonb_build_object(
      'workspace_id', ws_id,
      'op',           TG_OP,
      'id',           row_id
    )
  );

  PERFORM pg_notify('sync_invalidate', payload::text);

  -- For DELETE triggers, the legal return is OLD. For INSERT/UPDATE,
  -- return NEW. The trigger is declared AFTER so the value is unused,
  -- but PostgreSQL still requires a structurally-valid return.
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
