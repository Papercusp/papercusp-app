-- DAO treasury routing for reconciled settlements (shared-pot DAO plan P-034).
--
-- Migration 026 recorded a settlement's allocations and said so explicitly:
-- "Recorded, not routed: moving these to the Safe/Zodiac treasury is P-034."
-- This is that routing, and the two tables below are the auditable receipt
-- acceptance line 13 asks for.
--
-- D-055: commerce facts live behind this Worker plus the chain in v1. A routed
-- transfer is a D1 row plus an on-chain Safe transaction; nothing here is
-- replicated onto the hive peer log.
--
-- The routing door refuses a batch that is not `final` (mig 026 `state`). A
-- 'claimed' batch has a transaction the chain accepted but a reorg can still
-- drop, and moving treasury capital on the strength of a claim is exactly the
-- claim-versus-finality mistake acceptance line 14 exists to prevent — except
-- here the money leaves the Safe, so there is nothing to unwind.

-- A Safe + Zodiac Roles v2 deployment OBSERVED on chain.
--
-- Recording the deployment is a precondition for routing, which is the
-- difference between "an address is configured" and "a Safe exists there".
-- A typo in a configured treasury address is otherwise undetectable until funds
-- are sent to it, and that is not recoverable on chain.
CREATE TABLE IF NOT EXISTS treasury_safe_deployments (
  chain_id INTEGER NOT NULL,
  safe_address TEXT NOT NULL,
  -- The Zodiac Roles modifier enabled on the Safe. The automation signs
  -- through this module, never as an owner.
  roles_module_address TEXT NOT NULL,
  -- Only 'v2' is accepted. Roles v1 has a weaker scoping model, so accepting it
  -- would mean the role bounds the Worker asserts are not the bounds enforced
  -- on chain.
  roles_version TEXT NOT NULL,
  deployment_tx_hash TEXT NOT NULL,
  -- 'mainnet' rows additionally require owner approval at routing time; the
  -- pilot records 'testnet'.
  network TEXT NOT NULL,
  -- Canonical JSON array of Safe owner addresses, and the owner threshold, as
  -- recorded at deployment. Kept alongside the automation signer so an audit
  -- can see that owner threshold control was separate from the automated role
  -- AT THE TIME the deployment was accepted, not merely that it is separate in
  -- today's configuration.
  owners TEXT NOT NULL,
  threshold INTEGER NOT NULL,
  automation_signer TEXT NOT NULL,
  deployed_at_ms INTEGER NOT NULL,
  recorded_at_ms INTEGER NOT NULL,
  recorded_by TEXT NOT NULL,
  PRIMARY KEY (chain_id, safe_address),
  CHECK (chain_id > 0),
  CHECK (roles_version = 'v2'),
  CHECK (network IN ('testnet', 'mainnet')),
  CHECK (threshold >= 1),
  CHECK (deployed_at_ms > 0),
  -- The separation invariant, made durable. `validateTreasuryConfig` refuses a
  -- configuration whose automation signer is an owner; this refuses a RECORD of
  -- one, so the deployment history cannot contain a state the runtime would
  -- reject.
  CHECK (roles_module_address <> safe_address)
);

CREATE INDEX IF NOT EXISTS treasury_safe_deployments_network_idx
  ON treasury_safe_deployments (network, recorded_at_ms DESC);

-- One routed transfer of one revenue share of one reconciled settlement.
--
-- The UNIQUE index on (receipt_hash, share) is the idempotency guard, and it is
-- the reason routing can be retried safely: the receipt hash is derived from
-- the settlement's own contents, so a resubmitted routing of the same
-- settlement collides with the row that already recorded the transfer instead
-- of paying the treasury twice. It is TOTAL, not partial — unlike mig 026's
-- claim index, a routed transfer is never voided and re-attempted under the
-- same identity, because the Safe transaction it names either exists or the row
-- was never written.
CREATE TABLE IF NOT EXISTS treasury_transfers (
  transfer_id TEXT PRIMARY KEY NOT NULL,
  batch_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  settlement_id TEXT NOT NULL,
  -- Binds the transfer to the settlement receipt it reconciles against. Every
  -- authorization carries it (`settlementReceiptHash`), so a transfer can never
  -- be traced back to "some settlement".
  receipt_hash TEXT NOT NULL,
  split_manifest_hash TEXT NOT NULL,
  share TEXT NOT NULL,
  role TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  safe_address TEXT NOT NULL,
  roles_module_address TEXT NOT NULL,
  token TEXT NOT NULL,
  recipient TEXT NOT NULL,
  amount_micros INTEGER NOT NULL,
  -- The deterministic authorization digest from `authorizeTreasuryTransfer`.
  -- Recomputable from the row, so an auditor can confirm the transfer that was
  -- submitted is the one the policy authorized.
  safe_tx_hash TEXT NOT NULL,
  -- The on-chain transaction that actually moved the funds.
  transaction_hash TEXT NOT NULL,
  block_number TEXT NOT NULL,
  -- The signed `revenue-split` commerce event recording this transfer on the
  -- P-016 log (mig 026 `commerce_event_log`), or NULL when the transfer landed
  -- on chain but its proof could not be sequenced. NULL is reported to the
  -- caller rather than swallowed: the money has moved either way.
  proof_event_id TEXT,
  created_at_ms INTEGER NOT NULL,
  CHECK (chain_id > 0),
  CHECK (amount_micros > 0),
  CHECK (share IN ('creator', 'host', 'component', 'dao', 'reserve', 'tax', 'operating')),
  CHECK (role IN ('settlement', 'host-payout', 'reserve-transfer', 'emergency-pause'))
);

CREATE UNIQUE INDEX IF NOT EXISTS treasury_transfers_receipt_share_idx
  ON treasury_transfers (receipt_hash, share);

CREATE INDEX IF NOT EXISTS treasury_transfers_batch_idx
  ON treasury_transfers (batch_id, created_at_ms DESC);

CREATE INDEX IF NOT EXISTS treasury_transfers_principal_idx
  ON treasury_transfers (principal_id, created_at_ms DESC);
