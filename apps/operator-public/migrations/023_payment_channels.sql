-- Buyer-side payment-channel funding on the pilot EVM rail (P-032).
--
-- The on-chain contract is the escrow authority. This table is the durable
-- Worker-side lifecycle and idempotency record that links an authenticated
-- principal, its funding source, and the confirmed open/close transactions.

CREATE TABLE IF NOT EXISTS payment_channels (
  channel_id TEXT PRIMARY KEY NOT NULL,
  principal_id TEXT NOT NULL,
  rail TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  stablecoin_address TEXT NOT NULL,
  settlement_contract_address TEXT NOT NULL,
  funding_source TEXT NOT NULL,
  funding_ref TEXT NOT NULL,
  wallet_address TEXT,
  escrow_micros INTEGER NOT NULL,
  committed_micros INTEGER NOT NULL DEFAULT 0,
  refunded_micros INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  open_tx_hash TEXT,
  open_block_number TEXT,
  close_tx_hash TEXT,
  close_block_number TEXT,
  failure_code TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  closed_at_ms INTEGER,
  CHECK (rail = 'evm-x402'),
  CHECK (chain_id > 0),
  CHECK (funding_source IN ('bound-wallet', 'prepaid-credit')),
  CHECK (
    (funding_source = 'bound-wallet' AND wallet_address IS NOT NULL) OR
    (funding_source = 'prepaid-credit' AND wallet_address IS NULL)
  ),
  CHECK (escrow_micros > 0),
  CHECK (
    committed_micros >= 0 AND
    refunded_micros >= 0 AND
    committed_micros + refunded_micros <= escrow_micros
  ),
  CHECK (state IN ('opening', 'open', 'closing', 'closed', 'failed'))
);

CREATE INDEX IF NOT EXISTS payment_channels_principal_idx
  ON payment_channels (principal_id, created_at_ms DESC);

CREATE UNIQUE INDEX IF NOT EXISTS payment_channels_prepaid_reservation_idx
  ON payment_channels (funding_ref)
  WHERE funding_source = 'prepaid-credit';
