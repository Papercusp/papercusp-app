-- 1066-coord-escalation-reopen-compensation.sql
--
-- P-010 / WI-1990949: an owner Undo must not delete the immutable
-- escalation_resolved event. `escalation_reopened` is the append-only inverse;
-- this migration teaches the materialized open-escalations projection the same
-- lifecycle fold as the TypeScript reader.

CREATE TABLE IF NOT EXISTS harness_shared.coord_open_escalations (
  workspace_id TEXT        NOT NULL,
  msg_id       TEXT        NOT NULL,
  ts           TIMESTAMPTZ NOT NULL,
  body         JSONB       NOT NULL,
  PRIMARY KEY (workspace_id, msg_id)
);

CREATE OR REPLACE FUNCTION harness_shared.coord_open_escalations_maintain()
RETURNS trigger AS $body$
BEGIN
  IF NEW.body->>'kind' = 'escalation' THEN
    INSERT INTO harness_shared.coord_open_escalations (workspace_id, msg_id, ts, body)
    VALUES (NEW.workspace_id, NEW.msg_id, NEW.ts, NEW.body)
    ON CONFLICT (workspace_id, msg_id) DO NOTHING;
  ELSIF NEW.body->>'kind' = 'escalation_resolved'
        AND NEW.body->>'related_msg_id' IS NOT NULL THEN
    DELETE FROM harness_shared.coord_open_escalations
     WHERE workspace_id = NEW.workspace_id
       AND msg_id = NEW.body->>'related_msg_id';
  ELSIF NEW.body->>'kind' = 'escalation_reopened'
        AND NEW.body->>'related_msg_id' IS NOT NULL THEN
    INSERT INTO harness_shared.coord_open_escalations (workspace_id, msg_id, ts, body)
    SELECT e.workspace_id, e.msg_id, e.ts, e.body
      FROM harness_shared.coord_event_log e
     WHERE e.workspace_id = NEW.workspace_id
       AND e.surface = 'escalations'
       AND e.msg_id = NEW.body->>'related_msg_id'
       AND e.body->>'kind' = 'escalation'
    ON CONFLICT (workspace_id, msg_id) DO UPDATE
      SET ts = EXCLUDED.ts, body = EXCLUDED.body;
  END IF;
  RETURN NULL;
END;
$body$ LANGUAGE plpgsql;

-- Reconcile existing rows by the latest append-order lifecycle event. A missing
-- sibling means generation zero is still open; a latest reopen means a later
-- generation is open; a latest resolve means closed.
DELETE FROM harness_shared.coord_open_escalations p
 WHERE COALESCE(
   (
     SELECT l.body->>'kind'
       FROM harness_shared.coord_event_log l
      WHERE l.workspace_id = p.workspace_id
        AND l.surface = 'escalations'
        AND l.body->>'related_msg_id' = p.msg_id
        AND l.body->>'kind' IN ('escalation_resolved', 'escalation_reopened')
      ORDER BY l.id DESC
      LIMIT 1
   ),
   'escalation_reopened'
 ) = 'escalation_resolved';

INSERT INTO harness_shared.coord_open_escalations (workspace_id, msg_id, ts, body)
SELECT e.workspace_id, e.msg_id, e.ts, e.body
  FROM harness_shared.coord_event_log e
 WHERE e.surface = 'escalations'
   AND e.body->>'kind' = 'escalation'
   AND COALESCE(
     (
       SELECT l.body->>'kind'
         FROM harness_shared.coord_event_log l
        WHERE l.workspace_id = e.workspace_id
          AND l.surface = 'escalations'
          AND l.body->>'related_msg_id' = e.msg_id
          AND l.body->>'kind' IN ('escalation_resolved', 'escalation_reopened')
        ORDER BY l.id DESC
        LIMIT 1
     ),
     'escalation_reopened'
   ) <> 'escalation_resolved'
ON CONFLICT (workspace_id, msg_id) DO UPDATE
  SET ts = EXCLUDED.ts, body = EXCLUDED.body;

DROP TRIGGER IF EXISTS coord_open_escalations_trg
  ON harness_shared.coord_event_log;
CREATE TRIGGER coord_open_escalations_trg
  AFTER INSERT ON harness_shared.coord_event_log
  FOR EACH ROW WHEN (NEW.surface = 'escalations')
  EXECUTE FUNCTION harness_shared.coord_open_escalations_maintain();
