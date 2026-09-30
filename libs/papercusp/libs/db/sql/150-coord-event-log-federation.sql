-- Migration 150 — federate harness-scoped coord_event_log content over the peer-log.
-- (Renumbered from 147 — su-d3187 hardcoded a colliding 147-fleet-governor.sql,
--  which shadowed this one on the number-watermarked boot-apply; 150 is fresh.)
--
-- Plan: distributed-coordination-shared-harness-2026-06-04 (Track A — federate
-- coordination CONTENT, surface #1: messages, plus handoffs/escalations). This
-- is the highest-value coord surface: cross-user agent↔agent messages.
--
-- WHAT FEDERATES: a HARNESS-SCOPED, ORIGINAL coord_event_log row —
--   • harness_slug IS NOT NULL  → operator-scope / workspace-global coord stays
--     LOCAL (D-007: it has no swarm to ride).
--   • (body->>'notify_kind') IS NULL → the row is ORIGINAL CONTENT, not a LOCAL
--     fan-out delivery copy. The fan-out writes one coord_event_log row per
--     subscriber (writer_key=subscriber, notify_kind set) as per-machine DELIVERY
--     state; those must NOT federate (each machine regenerates them from its OWN
--     subscriptions — D-002 "content federates, delivery stays local"). Only the
--     authored message / handoff / escalation crosses; on the remote machine the
--     recipient's coord:inbox read finds it by the envelope `to[]`.
--   • origin='local' → never re-federate a row the projection just applied
--     (belt-and-suspenders with capture_substrate_outbox's own echo-guard).
--
-- The harness scope is carried on the ENVELOPE (CoordEnvelope.harness_slug) and
-- projected to this column by PgCoordLog.appendLine/putEvent — so a message is
-- harness-scoped iff its sender set `harness` (coord:send). Existing callers pass
-- nothing → harness_slug NULL → unchanged (local) behavior.
--
-- KEY for the peer-log: the globally-unique `msg_id` (the projection keys on it).
-- The local bigserial `id` is machine-local and is NOT the federation key. The
-- fed unique index (workspace_id, msg_id) over the federated subset is the upsert
-- conflict target; because msg_id is globally unique, an ON CONFLICT (ws,msg_id)
-- upsert updates the one existing row (same surface) and so never violates the
-- separate (ws,surface,msg_id) event_uq index.
--
-- Mechanism = the established pattern (mig 102/114/125/144): add origin (echo
-- guard) + author_pubkey (provenance) + harness_slug (scope), a fed unique index,
-- and split WHEN-filtered capture triggers reusing capture_substrate_outbox('msg_id').
-- INSERT/DELETE reference NEW/OLD respectively (separate triggers); UPDATE only on
-- a real change (handoffs/escalations re-put via ON CONFLICT DO UPDATE).
--
-- Hot-path note: coord_event_log is the busiest coord table. The WHEN clauses
-- short-circuit on `harness_slug IS NOT NULL` (false for the overwhelmingly common
-- operator-scope message), so the trigger body never runs for those — ~one
-- null-check of overhead per insert.
--
-- NO RLS (coord_* family). Idempotent; composes onto 000-baseline for fresh /
-- embedded-pg boots. Runs as harness_admin.

\set ON_ERROR_STOP on
BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Federation columns. harness_slug parallels the existing workspace_id scope
--    column; PgCoordLog.ensureCoordEventLogTable also adds it (idempotent both ways).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE harness_shared.coord_event_log
  ADD COLUMN IF NOT EXISTS harness_slug text;
ALTER TABLE harness_shared.coord_event_log
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'local';
ALTER TABLE harness_shared.coord_event_log
  ADD COLUMN IF NOT EXISTS author_pubkey text;

COMMENT ON COLUMN harness_shared.coord_event_log.harness_slug IS
  'Harness scope (federation): set from CoordEnvelope.harness_slug by PgCoordLog. NULL = operator-scope/workspace-global (stays local). Harness-scoped rows federate over that harness''s peer-log.';
COMMENT ON COLUMN harness_shared.coord_event_log.origin IS
  'Echo-loop guard (federation): ''local'' for rows written here, ''remote'' for projected rows. capture_substrate_outbox() skips non-local rows.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Federation upsert key — the federated subset, keyed by the global msg_id.
--    Partial so operator-scope + fan-out rows carry no uniqueness burden.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS coord_event_log_fed_uq
  ON harness_shared.coord_event_log (workspace_id, msg_id)
  WHERE harness_slug IS NOT NULL AND (body->>'notify_kind') IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Capture triggers — enqueue harness-scoped, original, local-origin rows.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE TRIGGER capture_coord_event_ins_trg
  AFTER INSERT ON harness_shared.coord_event_log
  FOR EACH ROW
  WHEN (NEW.harness_slug IS NOT NULL
        AND NEW.surface IN ('messages', 'handoffs', 'escalations')
        AND (NEW.body->>'notify_kind') IS NULL
        AND COALESCE(NEW.origin, 'local') = 'local')
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('msg_id');

CREATE OR REPLACE TRIGGER capture_coord_event_del_trg
  AFTER DELETE ON harness_shared.coord_event_log
  FOR EACH ROW
  WHEN (OLD.harness_slug IS NOT NULL
        AND OLD.surface IN ('messages', 'handoffs', 'escalations')
        AND (OLD.body->>'notify_kind') IS NULL
        AND COALESCE(OLD.origin, 'local') = 'local')
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('msg_id');

CREATE OR REPLACE TRIGGER capture_coord_event_upd_trg
  AFTER UPDATE ON harness_shared.coord_event_log
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*
        AND NEW.harness_slug IS NOT NULL
        AND NEW.surface IN ('messages', 'handoffs', 'escalations')
        AND (NEW.body->>'notify_kind') IS NULL
        AND COALESCE(NEW.origin, 'local') = 'local')
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('msg_id');

COMMIT;
