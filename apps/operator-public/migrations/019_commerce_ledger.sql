-- Provider-neutral commerce ledger + signed webhook inbox (shared-pot DAO plan
-- P-010; D-025, D-028).
--
-- `commerce_ledger_events` is the SOURCE OF TRUTH: an append-only stream of the
-- typed facts defined by @papercusp/operator-core/lib/cupboard/commerce-ledger.
-- The six entity tables below are a PROJECTION of that stream, rebuilt by
-- folding it through `reduceLedger` (see src/commerce-store.ts). They are a read
-- optimization, never an independent authority — which is what lets a reducer
-- fix be picked up by replaying the log rather than migrating rows.
--
-- Money is stored the way the ledger defines it: an INTEGER minor-unit amount
-- plus an ISO-4217 currency. Never a float, and never a single "price" string.

CREATE TABLE IF NOT EXISTS commerce_ledger_events (
  ledger_event_id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  provider TEXT NOT NULL,
  provider_event_id TEXT,
  payload_json TEXT NOT NULL
);

-- The fold order the reducer itself uses: (occurred_at_ms, ledger_event_id).
CREATE INDEX IF NOT EXISTS commerce_ledger_events_fold_idx
  ON commerce_ledger_events (occurred_at_ms ASC, ledger_event_id ASC);

-- Idempotent webhook delivery. The UNIQUE constraint is the durable half of the
-- inbox's promise: a provider that re-sends an event id can never mint a second
-- entitlement, and a replay whose BYTES differ is caught by comparing
-- `body_digest` (see ingestWebhook's `replay-mismatch`).
CREATE TABLE IF NOT EXISTS commerce_webhook_inbox (
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  provider_event_type TEXT,
  body_digest TEXT NOT NULL,
  received_at_ms INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  rejection_code TEXT,
  ledger_event_ids_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE (provider, provider_event_id),
  CHECK (outcome IN ('accepted', 'ignored', 'rejected'))
);

CREATE INDEX IF NOT EXISTS commerce_webhook_inbox_received_idx
  ON commerce_webhook_inbox (received_at_ms DESC);

CREATE TABLE IF NOT EXISTS commerce_products (
  product_id TEXT PRIMARY KEY NOT NULL,
  sku_ref TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  title TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS commerce_products_creator_idx
  ON commerce_products (creator_id);

CREATE TABLE IF NOT EXISTS commerce_offers (
  offer_id TEXT PRIMARY KEY NOT NULL,
  product_id TEXT NOT NULL,
  pricing_model TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  CHECK (pricing_model IN ('free', 'one-time', 'subscription', 'per-use'))
);

CREATE INDEX IF NOT EXISTS commerce_offers_product_idx
  ON commerce_offers (product_id);

CREATE TABLE IF NOT EXISTS commerce_orders (
  order_id TEXT PRIMARY KEY NOT NULL,
  offer_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  buyer_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  state TEXT NOT NULL,
  provider TEXT,
  provider_ref TEXT,
  refunded_minor INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK (state IN ('pending', 'paid', 'failed', 'canceled', 'partially-refunded', 'refunded'))
);

CREATE INDEX IF NOT EXISTS commerce_orders_buyer_idx
  ON commerce_orders (buyer_id, created_at_ms DESC);

-- The delivery gate (P-009) reads this table: "does this buyer hold an ACTIVE
-- entitlement for this product?" The entitlement id is derived from the order
-- (`ent:<orderId>`), so a replayed `order.paid` cannot grant a second one.
CREATE TABLE IF NOT EXISTS commerce_entitlements (
  entitlement_id TEXT PRIMARY KEY NOT NULL,
  order_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  buyer_id TEXT NOT NULL,
  state TEXT NOT NULL,
  granted_at_ms INTEGER NOT NULL,
  revoked_at_ms INTEGER,
  revoke_reason TEXT,
  CHECK (state IN ('active', 'revoked'))
);

CREATE INDEX IF NOT EXISTS commerce_entitlements_buyer_idx
  ON commerce_entitlements (buyer_id, state, product_id);

CREATE TABLE IF NOT EXISTS commerce_refunds (
  refund_id TEXT PRIMARY KEY NOT NULL,
  order_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  state TEXT NOT NULL,
  provider TEXT,
  provider_ref TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK (state IN ('pending', 'succeeded', 'failed'))
);

CREATE INDEX IF NOT EXISTS commerce_refunds_order_idx
  ON commerce_refunds (order_id, state);

CREATE TABLE IF NOT EXISTS commerce_payouts (
  payout_id TEXT PRIMARY KEY NOT NULL,
  creator_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  state TEXT NOT NULL,
  provider TEXT,
  provider_ref TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK (state IN ('pending', 'paid', 'failed'))
);

CREATE INDEX IF NOT EXISTS commerce_payouts_creator_idx
  ON commerce_payouts (creator_id, state);
