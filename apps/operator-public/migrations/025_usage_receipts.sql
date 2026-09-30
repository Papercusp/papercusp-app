-- Metering interception on every billable unit (shared-pot DAO plan P-031).
--
-- D-055: commerce facts live behind this Worker plus the chain in v1, so the
-- signed usage receipts and the cumulative claims they advance are stored HERE
-- rather than replicated onto the hive peer log. The Worker stores facts the
-- parties signed; it does not author them.
--
-- The row is the DURABLE half of `p2p/microcharge.ts`'s in-memory channel:
--   * `usage_nonce` is UNIQUE PER CHANNEL, which is what makes the
--     `duplicate-nonce` refusal survive a restart instead of living only in the
--     reservations map of one process;
--   * `cumulative_claim_micros` is the monotonic watermark the next voucher must
--     advance past, so `cumulative-regression` is likewise durable;
--   * `payment_channels.committed_micros` (mig 023) stays the escrow authority —
--     a settled receipt increments it under the same CHECK that already forbids
--     committed + refunded from exceeding escrow, which is cap exhaustion.
--
-- Money is bigint micro-units everywhere in the microcharge path; SQLite
-- INTEGER is 64-bit, so it holds them exactly.

CREATE TABLE IF NOT EXISTS usage_receipts (
  channel_id TEXT NOT NULL,
  usage_nonce TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  offer_id TEXT NOT NULL,
  payer TEXT NOT NULL,
  seller TEXT NOT NULL,
  release_ref TEXT NOT NULL,
  meter_unit TEXT NOT NULL,
  meter_quantity INTEGER NOT NULL,
  unit_price_micros INTEGER NOT NULL,
  price_version TEXT NOT NULL,
  split_manifest_hash TEXT NOT NULL,
  reserved_micros INTEGER NOT NULL,
  amount_micros INTEGER,
  cumulative_claim_micros INTEGER NOT NULL,
  -- Signed INTO the voucher, so the digest cannot be recomputed without it.
  -- Storing it is what lets a settle re-derive the exact bytes the payer signed
  -- instead of trusting a digest the client hands back.
  expires_at_ms INTEGER NOT NULL,
  voucher_digest TEXT NOT NULL,
  voucher_signature TEXT NOT NULL,
  receipt_signature TEXT,
  state TEXT NOT NULL,
  reserved_at_ms INTEGER NOT NULL,
  settled_at_ms INTEGER,
  PRIMARY KEY (channel_id, usage_nonce),
  CHECK (meter_quantity > 0),
  CHECK (unit_price_micros > 0),
  CHECK (reserved_micros > 0),
  CHECK (cumulative_claim_micros > 0),
  CHECK (state IN ('reserved', 'settled')),
  CHECK (
    (state = 'reserved' AND amount_micros IS NULL AND receipt_signature IS NULL AND settled_at_ms IS NULL) OR
    (state = 'settled' AND amount_micros IS NOT NULL AND receipt_signature IS NOT NULL AND settled_at_ms IS NOT NULL)
  ),
  CHECK (amount_micros IS NULL OR (amount_micros >= 0 AND amount_micros <= reserved_micros))
);

-- The cumulative watermark read: the highest claim this channel has admitted.
CREATE INDEX IF NOT EXISTS usage_receipts_channel_claim_idx
  ON usage_receipts (channel_id, cumulative_claim_micros DESC);

-- Seller-side reporting: what a release earned, most recent first.
CREATE INDEX IF NOT EXISTS usage_receipts_seller_idx
  ON usage_receipts (seller, release_ref, reserved_at_ms DESC);
