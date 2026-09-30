-- 355-coord-open-escalations-projection.sql
--
-- P-005 (infra-perf-reliability-audit-round4): kill the #1 DB cost.
--
-- pg_stat_statements pinned `SELECT body FROM harness_shared.coord_event_log
-- WHERE workspace_id=$1 AND surface=$2 ORDER BY id ASC` as the dominant DB
-- consumer (923k calls, 573ms mean, ~147 cumulative HOURS of exec time). It is
-- NOT an index gap — coord_event_log_surface_id covers it — it is an UNBOUNDED
-- full-surface replay: listEscalations({status:'open'}) (escalations.ts
-- loadEscalations -> readEvents) reads ALL ~35k escalation events every call and
-- folds opens-minus-resolves in JS, on every reconcile/system-health/attention
-- read. Windowing is WRONG here (an old open can still be unresolved), so the fix
-- is a MATERIALIZED open-escalations projection: a small table holding exactly the
-- currently-open escalation records, maintained incrementally by a trigger.
--
-- ADDITIVE + flag-gated: the READ switch (listEscalations -> this projection)
-- ships behind papercusp-coord-open-escalations-projection (DEFAULT OFF). This
-- migration only CREATES + maintains the projection; while the flag is OFF the
-- fold path is unchanged (byte-identical behavior). su-f9b53 flips the flag ON
-- after confirming this migration applied + backfilled in prod.
--
-- Append-only model (agent-coordination-architecture-v2 §6.4): an escalation is
-- an immutable `kind:'escalation'` event; a resolution is a sibling
-- `kind:'escalation_resolved'` event carrying `related_msg_id`. Open == an
-- 'escalation' event with no matching 'escalation_resolved'.
--
-- Named dollar-quote ($body$, NOT $$) per the repo PG-migration convention.
-- Idempotent: CREATE ... IF NOT EXISTS, DROP TRIGGER IF EXISTS + CREATE,
-- backfill is reconcile-shaped (prune-then-insert with ON CONFLICT DO NOTHING),
-- so a re-run fully reconciles. No \set / BEGIN / COMMIT — the embedded-pg
-- migration runner strips psql metacommands and wraps each file in its own txn.

-- ── 1. the projection table: exactly the currently-open escalations ───────────
CREATE TABLE IF NOT EXISTS harness_shared.coord_open_escalations (
  workspace_id TEXT        NOT NULL,
  msg_id       TEXT        NOT NULL,
  ts           TIMESTAMPTZ NOT NULL,
  body         JSONB       NOT NULL,
  PRIMARY KEY (workspace_id, msg_id)
);

-- listEscalations({status:'open'}) returns the open set sorted by (ts, msg_id),
-- scoped to one workspace — this index serves that read directly.
CREATE INDEX IF NOT EXISTS coord_open_escalations_ws_ts
  ON harness_shared.coord_open_escalations (workspace_id, ts, msg_id);

-- ── 2. the incremental maintainer FUNCTION (the trigger is created last, §4) ──
-- An open event upserts; any resolve event deletes its target. RETURN NULL:
-- AFTER-trigger return value is ignored. (The trigger's WHEN(surface=
-- 'escalations') guard keeps this off the messages/plan-events hot write path.)
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
  END IF;
  RETURN NULL;
END;
$body$ LANGUAGE plpgsql;

-- ── 3. backfill / reconcile the current open set ──────────────────────────────
-- Done BEFORE creating the trigger so the trigger's SHARE ROW EXCLUSIVE lock on
-- coord_event_log (which blocks concurrent coord INSERTs until this migration's
-- txn commits) is held for the SHORTEST possible time — the trigger is the very
-- last statement. The backfill computes the open set directly, so it does not
-- need the trigger active; the trigger only maintains it going forward.
-- (a) PRUNE projection rows that are actually resolved (no-op on first apply when
--     the table is empty; makes a re-run a full reconcile + closes the tiny
--     create-trigger→backfill window).
DELETE FROM harness_shared.coord_open_escalations p
 WHERE EXISTS (
   SELECT 1 FROM harness_shared.coord_event_log r
    WHERE r.surface = 'escalations'
      AND r.workspace_id = p.workspace_id
      AND r.body->>'kind' = 'escalation_resolved'
      AND r.body->>'related_msg_id' = p.msg_id
 );

-- (b) INSERT every open escalation (an 'escalation' event with no sibling
--     'escalation_resolved'). ON CONFLICT DO NOTHING keeps it idempotent.
INSERT INTO harness_shared.coord_open_escalations (workspace_id, msg_id, ts, body)
SELECT e.workspace_id, e.msg_id, e.ts, e.body
  FROM harness_shared.coord_event_log e
 WHERE e.surface = 'escalations'
   AND e.body->>'kind' = 'escalation'
   AND NOT EXISTS (
     SELECT 1 FROM harness_shared.coord_event_log r
      WHERE r.surface = 'escalations'
        AND r.workspace_id = e.workspace_id
        AND r.body->>'kind' = 'escalation_resolved'
        AND r.body->>'related_msg_id' = e.msg_id
   )
ON CONFLICT (workspace_id, msg_id) DO NOTHING;

-- ── 4. the incremental maintainer trigger — created LAST (lock-minimization) ──
-- Guarded by WHEN (NEW.surface = 'escalations'), so it does ZERO work for the
-- messages/plan-events/handoffs surfaces (the hot write path is untouched).
DROP TRIGGER IF EXISTS coord_open_escalations_trg
  ON harness_shared.coord_event_log;
CREATE TRIGGER coord_open_escalations_trg
  AFTER INSERT ON harness_shared.coord_event_log
  FOR EACH ROW WHEN (NEW.surface = 'escalations')
  EXECUTE FUNCTION harness_shared.coord_open_escalations_maintain();
