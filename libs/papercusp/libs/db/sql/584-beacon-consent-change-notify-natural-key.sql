-- 584-beacon-consent-change-notify-natural-key.sql
--
-- WI-4137 / all-active-surfaces-data-sync-migration P-010: live databases may
-- already have migration 507 applied. Extend the generic change-notify payload
-- in a forward migration so id-less pot_settings rows carry their natural
-- harness_slug key and the Hive beacon-consent query can invalidate by Pot.
--
-- CREATE OR REPLACE is intentional: existing emit_change_notify triggers keep
-- pointing at the function and immediately pick up this additive payload field.

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
  row_id := row_jsonb -> 'id';
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
