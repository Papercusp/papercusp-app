-- Stripe-funded prepaid BYOC credits (shared-pot DAO plan P-030).
--
-- `commerce_ledger_events` remains the authority for grants and reversals.
-- This event table stores only explicit microcharge reservation lifecycle facts;
-- balances and reservations are rebuildable projections of both streams.

CREATE TABLE IF NOT EXISTS prepaid_credit_events (
  credit_event_id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  principal_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  CHECK (kind IN ('credit.reserved', 'credit.settled', 'credit.released'))
);

CREATE INDEX IF NOT EXISTS prepaid_credit_events_fold_idx
  ON prepaid_credit_events (occurred_at_ms ASC, credit_event_id ASC);

CREATE INDEX IF NOT EXISTS prepaid_credit_events_principal_idx
  ON prepaid_credit_events (principal_id, occurred_at_ms ASC);

CREATE TABLE IF NOT EXISTS prepaid_credit_balances (
  principal_id TEXT PRIMARY KEY NOT NULL,
  available_micros INTEGER NOT NULL DEFAULT 0,
  reserved_micros INTEGER NOT NULL DEFAULT 0,
  spent_micros INTEGER NOT NULL DEFAULT 0,
  debt_micros INTEGER NOT NULL DEFAULT 0,
  granted_micros INTEGER NOT NULL DEFAULT 0,
  reversed_micros INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL,
  CHECK (
    available_micros >= 0 AND reserved_micros >= 0 AND
    spent_micros >= 0 AND debt_micros >= 0 AND
    granted_micros >= 0 AND reversed_micros >= 0
  )
);

CREATE TABLE IF NOT EXISTS prepaid_credit_reservations (
  reservation_id TEXT PRIMARY KEY NOT NULL,
  principal_id TEXT NOT NULL,
  channel_id TEXT NOT NULL UNIQUE,
  reserved_micros INTEGER NOT NULL,
  committed_micros INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK (reserved_micros > 0),
  CHECK (committed_micros >= 0 AND committed_micros <= reserved_micros),
  CHECK (state IN ('open', 'settled', 'released'))
);

CREATE INDEX IF NOT EXISTS prepaid_credit_reservations_principal_idx
  ON prepaid_credit_reservations (principal_id, state, created_at_ms DESC);
