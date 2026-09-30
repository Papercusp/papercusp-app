-- 1112-prevent-resolved-escalation-projection-resurrection.sql
--
-- EI-22364876614483312: migration 1094 made the open-escalation projection
-- self-heal when an original escalation event is updated, but its trigger
-- unconditionally upserts the original. Because coord_event_log is an
-- append-only lifecycle log, an UPDATE of an original that already has a later
-- escalation_resolved sibling must not make it open again. Live evidence found
-- exactly that state: two projection rows whose originals each had one later
-- resolve and no reopen.
--
-- Projection membership must follow the latest resolve/reopen sibling by event
-- id, regardless of WHICH member of the lifecycle was just inserted or updated.
-- This function therefore folds the target lifecycle first and only then
-- deletes or refreshes the projection. That also prevents an UPDATE of an old
-- resolve/reopen sibling from overriding a newer opposite transition.
--
-- Idempotent: CREATE OR REPLACE FUNCTION plus a one-shot lifecycle-governed
-- cleanup for rows resurrected before this migration.

CREATE OR REPLACE FUNCTION harness_shared.coord_open_escalations_maintain()
RETURNS trigger AS $body$
DECLARE
  target_msg_id text;
  latest_lifecycle_kind text;
BEGIN
  IF NEW.body->>'kind' = 'escalation' THEN
    target_msg_id := NEW.msg_id;
  ELSIF NEW.body->>'kind' IN ('escalation_resolved', 'escalation_reopened') THEN
    target_msg_id := NEW.body->>'related_msg_id';
  ELSE
    RETURN NULL;
  END IF;

  IF target_msg_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT lifecycle.body->>'kind'
    INTO latest_lifecycle_kind
    FROM harness_shared.coord_event_log lifecycle
   WHERE lifecycle.workspace_id = NEW.workspace_id
     AND lifecycle.surface = 'escalations'
     -- Required for coord_event_log_related_msg_id_idx (migration 691), whose
     -- predicate is partial on body ? 'related_msg_id'.
     AND lifecycle.body ? 'related_msg_id'
     AND lifecycle.body->>'related_msg_id' = target_msg_id
     AND lifecycle.body->>'kind' IN ('escalation_resolved', 'escalation_reopened')
   ORDER BY lifecycle.id DESC
   LIMIT 1;

  IF latest_lifecycle_kind = 'escalation_resolved' THEN
    DELETE FROM harness_shared.coord_open_escalations
     WHERE workspace_id = NEW.workspace_id
       AND msg_id = target_msg_id;
  ELSE
    INSERT INTO harness_shared.coord_open_escalations (workspace_id, msg_id, ts, body)
    SELECT original.workspace_id, original.msg_id, original.ts, original.body
      FROM harness_shared.coord_event_log original
     WHERE original.workspace_id = NEW.workspace_id
       AND original.surface = 'escalations'
       AND original.msg_id = target_msg_id
       AND original.body->>'kind' = 'escalation'
    ON CONFLICT (workspace_id, msg_id) DO UPDATE
      SET ts = EXCLUDED.ts, body = EXCLUDED.body;
  END IF;

  RETURN NULL;
END;
$body$ LANGUAGE plpgsql;

-- Remove projection rows resurrected by migration 1094's unconditional UPDATE
-- branch. The latest lifecycle event is authoritative, so a later reopen keeps
-- its row while a later resolve removes it. Safe to re-run.
DELETE FROM harness_shared.coord_open_escalations projection
 WHERE (
   SELECT lifecycle.body->>'kind'
     FROM harness_shared.coord_event_log lifecycle
    WHERE lifecycle.workspace_id = projection.workspace_id
      AND lifecycle.surface = 'escalations'
      AND lifecycle.body ? 'related_msg_id'
      AND lifecycle.body->>'related_msg_id' = projection.msg_id
      AND lifecycle.body->>'kind' IN ('escalation_resolved', 'escalation_reopened')
    ORDER BY lifecycle.id DESC
    LIMIT 1
 ) = 'escalation_resolved';
