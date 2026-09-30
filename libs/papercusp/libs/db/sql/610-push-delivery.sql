-- 610-push-delivery.sql — ambient-semantic-push-2026-07-14 P-003 (delivery rail, live leg).
--
-- push_delivery — the ambient-push delivery rail's queue + tally + utilization
-- ledger base, all in one table (one row per candidate push, per receiver).
--
-- Lifecycle of a row (`status`):
--   queued    — a MATCHER (P-004 collision, P-006 dead-end, P-008 topic-sub,
--               P-010 insight — all later phases) enqueued a candidate push for a
--               receiving session/owner. This is the delivery rail's INBOX.
--   delivered — the rail SELECTED it (ambient-push.selectPushes: floor + severity
--               gate + novelty + per-class budget) and it rode a hop-boundary
--               injection to the receiver (delivered_at stamped). This is the TALLY:
--               deliveredCount feeds the per-class budget's `alreadyDelivered`, and
--               deliveredRefs feeds the novelty dedup — both read back off THIS table
--               so the budget/novelty rails persist across hops without in-memory state.
--   dropped   — the rail did NOT ship it (drop_reason: below-floor / severity-gated /
--               not-novel / budget-exhausted). Kept, not deleted — the P-011
--               utilization ledger reads the whole disposition, drops included.
--
-- pulled_at / acted_at are RESERVED for the P-011 utilization ledger (pushed →
-- pulled the handle? → acted on it — route change / lock taken / fact read).
-- P-003 only writes the pushed/delivered/dropped side; P-011 fills these in.
--
-- Owner-keyed (target_owner_id) is the delivery axis: a presence roster carries
-- one live session per owner (mirrors 609 session_cursor's owner axis + the P-002
-- presence overlay), and the wake-executor injection path resolves a recipient by
-- subscriberId == ownerId. target_session_id is retained (nullable) for a future
-- session-precise cutover but is not required by the rail.
--
-- Provenance is data-not-directive by construction: the teaser is a receiver-facing
-- hint, never an instruction (ambient D-008 / carry P-014) — enforced upstream in
-- ambient-push.makePush, mirrored in the render, not a column here.
--
-- Conventions mirror 605/609: workspace_id defaults 'default' (transcript-driven
-- writes carry no workspace identity), no RLS, bounded partial indexes. The whole
-- feature is DEFAULT-OFF behind PAPERCUSP_AMBIENT_CURSOR at every call site.
--
-- Idempotent: IF NOT EXISTS everywhere; re-runnable. No top-level BEGIN/COMMIT —
-- the migration runner wraps each file in its own transaction.

CREATE TABLE IF NOT EXISTS harness_shared.push_delivery (
  id                BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target_owner_id   TEXT        NOT NULL,                       -- the receiving coord identity (PAPERCUSP_SID)
  target_session_id TEXT,                                       -- receiving native session id (reserved; rail keys on owner)
  workspace_id      TEXT        NOT NULL DEFAULT 'default',
  matcher_kind      TEXT        NOT NULL,                       -- 'collision' | 'dead-end' | 'topic-sub' | 'insight'
  severity          TEXT        NOT NULL,                       -- 'critical' | 'warning' | 'info'
  handle_kind       TEXT        NOT NULL,                       -- QueryHandle.kind: work-item|session|fact|doc|topic
  handle_ref        TEXT        NOT NULL,                       -- QueryHandle.ref (the novelty-dedup key)
  handle_query      JSONB       NOT NULL DEFAULT '[]'::jsonb,   -- QueryHandle.query (matched terms / re-pull query)
  teaser            TEXT        NOT NULL DEFAULT '',            -- one bounded line (never content)
  score             DOUBLE PRECISION NOT NULL DEFAULT 0,        -- match score ∈ [0,1] (floor/rank key)
  source_session_id TEXT,                                       -- for a peer collision: whose surface (never the receiver)
  status            TEXT        NOT NULL DEFAULT 'queued',      -- queued | delivered | dropped
  drop_reason       TEXT,                                       -- below-floor|severity-gated|not-novel|budget-exhausted
  enqueued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at      TIMESTAMPTZ,                                -- stamped on transition to 'delivered' (budget window axis)
  pulled_at         TIMESTAMPTZ,                                -- P-011: receiver resolved the handle
  acted_at          TIMESTAMPTZ                                 -- P-011: receiver acted (route change / lock / fact read)
);

-- The rail's pending read: queued candidates for one receiver, oldest-first.
-- Partial index — only queued rows are ever scanned by the delivery path.
CREATE INDEX IF NOT EXISTS push_delivery_pending_idx
  ON harness_shared.push_delivery (target_owner_id, enqueued_at)
  WHERE status = 'queued';

-- Budget window (deliveredCount) + novelty dedup (deliveredRefs) both scan
-- delivered rows for one owner by recency.
CREATE INDEX IF NOT EXISTS push_delivery_delivered_idx
  ON harness_shared.push_delivery (target_owner_id, delivered_at DESC)
  WHERE status = 'delivered';

-- P-011 utilization ledger correlates a pull/act back to the delivered push by ref.
CREATE INDEX IF NOT EXISTS push_delivery_ref_idx
  ON harness_shared.push_delivery (handle_ref);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.push_delivery TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.push_delivery TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;
