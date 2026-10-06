-- DAO-transfer gate pushed by the operator's reconciliation run
-- (agent-economy-flywheel-2026-08-30 P-043, D-025 §4).
--
-- The operator reconciles the money journal against Stripe, the chain and this
-- Worker's own credits and treasury transfers. Any broken invariant must pause
-- DAO transfers. The transfers execute HERE, so the run pushes its verdict to
-- this table over an HMAC-signed route (PUT /commerce/treasury/transfer-gate),
-- and the treasury routing door reads it before any money leaves the Safe.
--
-- The door fails CLOSED. It refuses a transfer when:
--   * RECONCILIATION_GATE_WORKSPACE is unset (no workspace governs this Worker),
--   * no row exists for that workspace (reconciliation never reported),
--   * open = 0 (a break is open),
--   * treasury_reconciled = 0 (the run never read the treasury, so it cannot
--     vouch for it), or
--   * at_ms is older than TRANSFER_GATE_MAX_AGE_MS (reconciliation stopped
--     reporting; a silent operator must not leave transfers running).
--
-- One row per workspace. A push only replaces the row when its at_ms is not
-- older than the stored one, so a delayed push from an earlier run can never
-- reopen a gate a later run closed.
CREATE TABLE IF NOT EXISTS treasury_transfer_gate (
  workspace_id TEXT PRIMARY KEY NOT NULL,
  open INTEGER NOT NULL,
  treasury_reconciled INTEGER NOT NULL,
  -- JSON array of the broken invariants' reasons; '[]' when open.
  reasons_json TEXT NOT NULL,
  -- The operator reconciliation run that produced this verdict.
  run_id TEXT NOT NULL,
  -- When that run started (unix ms, the operator's clock).
  at_ms INTEGER NOT NULL,
  -- When this Worker accepted the push (unix ms, the Worker's clock).
  received_at_ms INTEGER NOT NULL,
  CHECK (open IN (0, 1)),
  CHECK (treasury_reconciled IN (0, 1)),
  CHECK (at_ms > 0),
  -- An open gate carries no reasons; parseTransferGatePush refuses the
  -- contradiction, and this keeps the table from ever holding one.
  CHECK (open = 0 OR reasons_json = '[]')
);
