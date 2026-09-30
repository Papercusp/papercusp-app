-- Migration 126 — coordination fan-out: idempotent at-least-once delivery dedup.
--
-- Plan: coordination-substrate-2026-06-03 (Phase 2 — local fan-out projection).
--
-- The local fan-out runs as a consumer on the EXISTING substrate_outbox drain
-- (startOutboxDrain): for each captured change to a subscribable object
-- (feature / issue / plan / …), it resolves the object's subscribers and writes
-- one subscribe→inject notify per subscriber into the coord_event_log 'messages'
-- surface (the same rail readInbox reads). Delivery is AT-LEAST-ONCE — the drain
-- re-runs a row whose processing failed before it was marked drained — so the
-- write must be IDEMPOTENT or a retry double-delivers.
--
-- The fan-out gives each notify a DETERMINISTIC msg_id ('fan-<outbox_id>-<subscriber>')
-- and inserts ON CONFLICT DO NOTHING against this partial unique index, so a
-- re-drained row is a no-op rather than a duplicate notice.
--
-- ZERO-RISK on the live table: the index covers ONLY fan-out rows
-- (body->>'notify_kind' IS NOT NULL). Every existing coord_event_log row —
-- coord:send messages, acks, the retired path-glob notifies — has no notify_kind,
-- so none are in the index and the CREATE can never conflict with existing data.
--
-- Idempotent: CREATE INDEX IF NOT EXISTS. Runs as harness_admin.

\set ON_ERROR_STOP on
BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS coord_event_log_fanout_uq
  ON harness_shared.coord_event_log (workspace_id, msg_id)
  WHERE (surface = 'messages'::text AND (body ->> 'notify_kind') IS NOT NULL);

COMMENT ON INDEX harness_shared.coord_event_log_fanout_uq IS
  'Idempotency target for the coordination fan-out (coordination-substrate-2026-06-03, Phase 2). Deterministic notify msg_ids (fan-<outbox_id>-<subscriber>) dedupe at-least-once redelivery via ON CONFLICT DO NOTHING. Partial over fan-out rows only (notify_kind set), so it never touches existing messages.';

-- The wake-up rail (D-002 "pg_notify is the wake-up"). Every new coord_event_log
-- row fires NOTIFY on the 'coord_inbox' channel with payload
-- '<workspace_id>::<writer_key>', so a push consumer (desktop SSE, the ratatui
-- TUI) LISTENs and refreshes the recipient's inbox instantly instead of polling.
-- Listener-less NOTIFY is a cheap no-op, so this is safe for every inbox surface
-- (messages / handoffs / escalations / fan-out notifies alike).
CREATE OR REPLACE FUNCTION harness_shared.notify_coord_event_log() RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
BEGIN
  PERFORM pg_notify('coord_inbox', COALESCE(NEW.workspace_id, '') || '::' || COALESCE(NEW.writer_key, ''));
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS coord_event_log_notify_trg ON harness_shared.coord_event_log;
CREATE TRIGGER coord_event_log_notify_trg
  AFTER INSERT ON harness_shared.coord_event_log
  FOR EACH ROW EXECUTE FUNCTION harness_shared.notify_coord_event_log();

COMMIT;
