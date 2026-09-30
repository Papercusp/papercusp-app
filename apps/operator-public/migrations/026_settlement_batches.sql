-- Batch settlement execution on the pilot EVM rail (shared-pot DAO plan P-033).
--
-- D-055: commerce facts live behind this Worker plus the chain in v1, so a
-- settlement batch is a D1 row plus an on-chain transaction. Nothing here is
-- replicated onto the hive peer log.
--
-- ACCEPTANCE LINE 14 — "distinguish a payment claim from payment finality" — is
-- the reason `state` separates 'claimed' from 'final'. A row in 'claimed' has a
-- transaction the chain accepted; it is NOT money received, because a reorg can
-- still drop it. Only 'final' means the claim is buried under
-- `required_confirmations` and the split may be routed onward (P-034).
--
-- `payment_channels.committed_micros` (mig 023) stays the escrow authority; a
-- batch draws against it under the CHECK that already forbids committed +
-- refunded from exceeding escrow.

CREATE TABLE IF NOT EXISTS settlement_batches (
  batch_id TEXT PRIMARY KEY NOT NULL,
  channel_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  -- sha256 over the canonical calldata. Idempotency key for a resubmitted
  -- claim: the Worker can crash after the chain accepts the transaction but
  -- before this row records the receipt, and the retry must converge on the
  -- existing batch instead of double spending the escrow.
  request_hash TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  settlement_contract_address TEXT NOT NULL,
  stablecoin_address TEXT NOT NULL,
  claim_micros INTEGER NOT NULL,
  -- The channel's cumulative watermark BEFORE and AFTER this batch. The prior
  -- value is what a reorg unwind restores; without it a dropped claim would
  -- leave the watermark advanced and every voucher in the batch permanently
  -- unclaimable, which is a silent loss to the seller.
  prior_cumulative_micros INTEGER NOT NULL,
  cumulative_claim_micros INTEGER NOT NULL,
  -- Canonical JSON array of the voucher digests this batch claimed.
  voucher_digests TEXT NOT NULL,
  settlement_id TEXT NOT NULL,
  split_manifest_hash TEXT NOT NULL,
  -- Canonical JSON object of integer micro allocations per revenue share.
  -- Recorded, not routed: moving these to the Safe/Zodiac treasury is P-034.
  allocations_micros TEXT NOT NULL,
  provider_cost_micros INTEGER NOT NULL,
  distributable_micros INTEGER NOT NULL,
  dao_treasury TEXT NOT NULL,
  receipt_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  required_confirmations INTEGER NOT NULL,
  confirmations INTEGER NOT NULL DEFAULT 0,
  claim_tx_hash TEXT NOT NULL,
  claim_block_number TEXT NOT NULL,
  claim_block_hash TEXT NOT NULL,
  refund_tx_hash TEXT,
  refund_block_number TEXT,
  freeze_reason TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  finalized_at_ms INTEGER,
  CHECK (chain_id > 0),
  CHECK (claim_micros > 0),
  CHECK (prior_cumulative_micros >= 0),
  CHECK (cumulative_claim_micros > prior_cumulative_micros),
  CHECK (provider_cost_micros >= 0),
  CHECK (distributable_micros >= 0),
  CHECK (required_confirmations > 0),
  CHECK (confirmations >= 0),
  CHECK (state IN ('claimed', 'final', 'reorged', 'disputed', 'refunded')),
  -- A batch is final only once it has been observed final.
  CHECK ((state = 'final') = (finalized_at_ms IS NOT NULL)),
  CHECK ((refund_tx_hash IS NULL) = (refund_block_number IS NULL))
);

-- Claim idempotency: one LIVE batch per channel per request hash.
--
-- The index is PARTIAL on purpose. A reorged or refunded batch is void, and the
-- vouchers it held are released for a legitimate re-claim — which reproduces
-- the same deterministic request hash, because it is the same channel state and
-- the same voucher set. A total unique index would therefore make the recovery
-- path unreachable: the retry would collide with the very row that recorded the
-- claim the chain threw away.
CREATE UNIQUE INDEX IF NOT EXISTS settlement_batches_live_request_idx
  ON settlement_batches (channel_id, request_hash)
  WHERE state IN ('claimed', 'final', 'disputed');

CREATE INDEX IF NOT EXISTS settlement_batches_channel_idx
  ON settlement_batches (channel_id, created_at_ms DESC);

CREATE INDEX IF NOT EXISTS settlement_batches_principal_idx
  ON settlement_batches (principal_id, created_at_ms DESC);

-- Which usage receipts a batch claimed.
--
-- The UNIQUE constraint on (channel_id, usage_nonce) is the DURABLE
-- double-spend guard: `settleVoucherBatch`'s in-memory digest check lives in
-- one process, this one survives a restart and a concurrent request. Rows are
-- DELETED when a reorged batch is unwound, which is what releases the receipts
-- for a legitimate re-claim.
CREATE TABLE IF NOT EXISTS settlement_batch_vouchers (
  batch_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  usage_nonce TEXT NOT NULL,
  voucher_digest TEXT NOT NULL,
  cumulative_claim_micros INTEGER NOT NULL,
  PRIMARY KEY (batch_id, usage_nonce)
);

CREATE UNIQUE INDEX IF NOT EXISTS settlement_batch_vouchers_claim_idx
  ON settlement_batch_vouchers (channel_id, usage_nonce);

CREATE INDEX IF NOT EXISTS settlement_batch_vouchers_batch_idx
  ON settlement_batch_vouchers (batch_id);

-- The durable P2P commerce event log (P-016).
--
-- P-016 defined the signed event contract; nothing persisted it. P-033 needs a
-- home for its `settlement-proof` facts, so the log lands here as the general
-- append-only surface rather than as a settlement-only side table — P-035
-- bridges these rows outward, and should EXTEND this table rather than fork a
-- second log.
--
-- The two unique indexes are `reduceCommerceEvents`' conflict rules made
-- durable: one fact per (stream, sequence), one per idempotency key. A replayed
-- append collides instead of inflating the stream.
CREATE TABLE IF NOT EXISTS commerce_event_log (
  event_id TEXT PRIMARY KEY NOT NULL,
  stream_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  version INTEGER NOT NULL,
  issuer TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  -- Canonical JSON of the signed payload.
  payload TEXT NOT NULL,
  signature TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL,
  CHECK (version = 1),
  CHECK (sequence >= 0),
  CHECK (occurred_at_ms >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS commerce_event_log_sequence_idx
  ON commerce_event_log (stream_id, sequence);

CREATE UNIQUE INDEX IF NOT EXISTS commerce_event_log_idempotency_idx
  ON commerce_event_log (idempotency_key);

CREATE INDEX IF NOT EXISTS commerce_event_log_kind_idx
  ON commerce_event_log (kind, recorded_at_ms DESC);
