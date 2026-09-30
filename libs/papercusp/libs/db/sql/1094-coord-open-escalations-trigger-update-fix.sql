-- 1094-coord-open-escalations-trigger-update-fix.sql
--
-- EI-22091069492876324: the coord_open_escalations_trg trigger (355, extended by
-- 1066) fires `AFTER INSERT ONLY` on harness_shared.coord_event_log, and its
-- 'escalation' branch upserts the projection row with `ON CONFLICT DO NOTHING`.
--
-- openEscalation()'s coalesce/refresh logic (packages/operator-core/lib/
-- agent-tools/coordination/escalations.ts) has TWO ways to refresh an existing
-- open escalation's repeatCount/lastSeenTs/severity/summary:
--   (a) bumpProjectionDuplicateWithSql — a direct `UPDATE coord_open_escalations
--       SET body = jsonb_set(...) WHERE dedupKind=... AND subjectSignature=...`.
--       This keeps the projection current by construction; it never depends on
--       the trigger.
--   (b) the findOpenDuplicate() fallback (taken whenever (a) finds no matching
--       projection row) — a full event-log replay finds the existing open
--       'escalation' event, refreshes its metadata in JS, and writes it back via
--       coordLog.putEvent(existingMsgId, refreshed): an
--       `INSERT ... ON CONFLICT (workspace_id, surface, msg_id) DO UPDATE` on
--       coord_event_log. Because the msg_id already exists, Postgres resolves
--       this via the ON CONFLICT DO UPDATE arm — and a row-level `AFTER INSERT`
--       trigger does NOT fire for a row that took the UPDATE arm of an
--       INSERT-ON-CONFLICT statement. So this write updates coord_event_log.body
--       (repeatCount/lastSeenTs advance) but the trigger never runs, and
--       coord_open_escalations is never touched.
--
-- Once (a) has failed to match ONCE for a given escalation (its projection row
-- is missing, or its stored dedupKind/subjectSignature has drifted from what
-- later calls derive), every subsequent call for that escalation takes path
-- (b) again -- (a) can never re-match, because nothing ever repairs the
-- projection row it depends on. So the drift, once introduced, is PERMANENT:
-- the projection freezes at whatever it last held while coord_event_log keeps
-- advancing forever. Live-observed: dedupKind 'goal-portfolio-idle', subject
-- 'papercusp-workspace:work-on-everything-070565:portfolio-idle' -- projection
-- frozen at repeatCount 17 / lastSeenTs 09:58Z while coord_event_log carried the
-- SAME msg_id forward to repeatCount 61 (~44 further coalesces, all silently
-- invisible to the owner inbox / coord:escalations / the escalation-aging
-- alarm, which all read the projection).
--
-- THE FIX -- close the gap at its root instead of patching path (b)'s one call
-- site (which would leave the identical trap for the next writer of an
-- 'escalations' event via putEvent/putEvents): make the trigger ALSO fire on
-- UPDATE, and make its 'escalation' branch actually REFRESH the projection row
-- (mirroring EXCLUDED.body) instead of leaving a stale one in place. This makes
-- coord_open_escalations self-healing from ANY write to an 'escalation' row in
-- coord_event_log, present or future, regardless of which code path produced
-- it -- not just the two call sites that happen to exist today.
--
-- 'escalation_resolved' / 'escalation_reopened' updates are already idempotent
-- (DELETE / upsert-by-target) and safe to re-run on UPDATE too, so widening the
-- trigger event does not change their behavior, only makes them robust to the
-- same class of drift.
--
-- Idempotent: CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS + CREATE, a
-- one-shot repair backfill guarded by an anti-join (safe to re-run).

CREATE OR REPLACE FUNCTION harness_shared.coord_open_escalations_maintain()
RETURNS trigger AS $body$
BEGIN
  IF NEW.body->>'kind' = 'escalation' THEN
    -- EI-22091069492876324: DO UPDATE, not DO NOTHING -- a re-fire on an
    -- existing row (an UPDATE from ON CONFLICT DO UPDATE upstream, or a
    -- backfill re-run) must REFRESH the projection to NEW.body, not leave a
    -- stale one in place. This is what makes the projection self-healing.
    INSERT INTO harness_shared.coord_open_escalations (workspace_id, msg_id, ts, body)
    VALUES (NEW.workspace_id, NEW.msg_id, NEW.ts, NEW.body)
    ON CONFLICT (workspace_id, msg_id) DO UPDATE
      SET ts = EXCLUDED.ts, body = EXCLUDED.body;
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

-- One-shot repair: any currently-open 'escalation' event (per the same latest-
-- lifecycle-event fold 1066 uses) whose coord_event_log body has already
-- drifted ahead of a stale/missing projection row. Anti-join on an EXACT body
-- match keeps this idempotent and a no-op once nothing has drifted.
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
  SET ts = EXCLUDED.ts, body = EXCLUDED.body
 WHERE harness_shared.coord_open_escalations.body IS DISTINCT FROM EXCLUDED.body;

-- EI-22091069492876324: AFTER INSERT OR UPDATE -- the trigger must also fire
-- when an existing 'escalations' row is refreshed via ON CONFLICT DO UPDATE
-- (coordLog.putEvent / putEvents), not only on a genuine fresh INSERT.
DROP TRIGGER IF EXISTS coord_open_escalations_trg
  ON harness_shared.coord_event_log;
CREATE TRIGGER coord_open_escalations_trg
  AFTER INSERT OR UPDATE ON harness_shared.coord_event_log
  FOR EACH ROW WHEN (NEW.surface = 'escalations')
  EXECUTE FUNCTION harness_shared.coord_open_escalations_maintain();
