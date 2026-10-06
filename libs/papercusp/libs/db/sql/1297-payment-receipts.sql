-- 1297-payment-receipts.sql — agent-economy-flywheel-2026-08-30 P-046 (D-029, WI-10004795)
--
-- One row per Stripe balance transaction the reconciliation pass has seen.
-- `commitment` = SHA-256 over a random 32-byte salt and the transaction's
-- (id, amount, currency, fee, created). The commitment, never the amount, is
-- chained into harness_shared.ledger_chain_links under the stream
-- 'stripe.payment-receipts' and so joins the hourly anchor log (D-024).
--
-- `salt` is confidential: it is handed only to the holder of the receipt,
-- because salt + transaction is what lets someone recompute the commitment.
--
-- Append-only: a receipt's salt and committed fields never change once issued,
-- so UPDATE and DELETE are refused by the same trigger as ledger_chain_links.
-- Additive only.

CREATE TABLE IF NOT EXISTS harness_shared.payment_receipts (
  workspace_id            text        NOT NULL,
  balance_transaction_id  text        NOT NULL CHECK (length(balance_transaction_id) BETWEEN 1 AND 255),
  receipt_seq             bigint      GENERATED ALWAYS AS IDENTITY,
  salt                    text        NOT NULL CHECK (salt ~ '^[0-9a-f]{64}$'),
  commitment              text        NOT NULL CHECK (commitment ~ '^[0-9a-f]{64}$'),
  amount                  bigint      NOT NULL,
  fee                     bigint      NOT NULL CHECK (fee >= 0),
  currency                text        NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  stripe_created          bigint      NOT NULL CHECK (stripe_created >= 0),
  source_id               text,
  source_customer         text,
  recorded_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, balance_transaction_id),
  UNIQUE (receipt_seq)
);

CREATE INDEX IF NOT EXISTS payment_receipts_customer_idx
  ON harness_shared.payment_receipts (workspace_id, source_customer)
  WHERE source_customer IS NOT NULL;

DROP TRIGGER IF EXISTS payment_receipts_append_only_trg
  ON harness_shared.payment_receipts;
CREATE TRIGGER payment_receipts_append_only_trg
  BEFORE UPDATE OR DELETE ON harness_shared.payment_receipts
  FOR EACH ROW EXECUTE FUNCTION harness_shared.reject_ledger_chain_link_mutation();

ALTER TABLE harness_shared.payment_receipts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payment_receipts_workspace_isolation
  ON harness_shared.payment_receipts;
CREATE POLICY payment_receipts_workspace_isolation
  ON harness_shared.payment_receipts FOR ALL TO public
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

GRANT SELECT, INSERT ON harness_shared.payment_receipts TO harness_app, harness_admin;

COMMENT ON TABLE harness_shared.payment_receipts IS
  'Salted per-balance-transaction commitments (P-046, D-029). Chained as stream stripe.payment-receipts; see packages/operator-core/lib/cupboard/payment-receipt-store.ts.';
