-- P-005: a read-only bridge to the EXISTING Stripe journal and receipts.
-- No balance, account ownership, cash backing or paid authority is created.
-- hosted_service already reads all hosted customer bindings. It needs only
-- these three existing financial sources, never the customer directory.
-- Column grants avoid granting access to future columns or any financial DML.
GRANT SELECT (workspace_id, entry_id, occurred_at, currency, movement,
  external_ref_kind, external_ref, rollup_id, memo, posting_seq)
  ON harness_shared.money_journal_entries TO hosted_service;
GRANT SELECT (workspace_id, entry_id, line_no, account, side, cents)
  ON harness_shared.money_journal_lines TO hosted_service;
GRANT SELECT (workspace_id, balance_transaction_id, receipt_seq, salt,
  commitment, amount, fee, currency, stripe_created, source_id, source_customer)
  ON harness_shared.payment_receipts TO hosted_service;

DROP POLICY IF EXISTS money_journal_entries_hosted_funding_read
  ON harness_shared.money_journal_entries;
CREATE POLICY money_journal_entries_hosted_funding_read
  ON harness_shared.money_journal_entries FOR SELECT TO hosted_service USING (true);
DROP POLICY IF EXISTS money_journal_lines_hosted_funding_read
  ON harness_shared.money_journal_lines;
CREATE POLICY money_journal_lines_hosted_funding_read
  ON harness_shared.money_journal_lines FOR SELECT TO hosted_service USING (true);
DROP POLICY IF EXISTS payment_receipts_hosted_funding_read
  ON harness_shared.payment_receipts;
CREATE POLICY payment_receipts_hosted_funding_read
  ON harness_shared.payment_receipts FOR SELECT TO hosted_service USING (true);

-- A fixed, service-only lock bridge, because SHARE table locks normally need
-- write privileges. Do not grant financial UPDATE just to obtain read locks.
-- SHARE protects even empty populations from ALL writers, including importers
-- and direct SQL, without asking every existing writer to adopt a new key.
-- Locks live until the CALLER'S transaction ends; this opens no transaction.
-- Acquire the global Stripe allocation lock FIRST. Read all source workspaces
-- and refuse an unmapped workspace: these older sources have no account column.
CREATE OR REPLACE FUNCTION papercusp_auth.lock_hosted_stripe_funding_population()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $body$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'funding population requires read committed' USING ERRCODE = '25001';
  END IF;
  LOCK TABLE harness_shared.money_journal_entries,
    harness_shared.money_journal_lines,
    harness_shared.payment_receipts,
    papercusp_auth.hosted_billing_customers IN SHARE MODE;
END;
$body$;
REVOKE ALL ON FUNCTION papercusp_auth.lock_hosted_stripe_funding_population()
  FROM PUBLIC, harness_app, harness_zero, hosted_app;
GRANT EXECUTE ON FUNCTION papercusp_auth.lock_hosted_stripe_funding_population()
  TO hosted_service;
COMMENT ON FUNCTION papercusp_auth.lock_hosted_stripe_funding_population() IS
  'Service-only fixed read locks on existing journal/receipt/customer populations; no data return, DML, account mapping, cash/provider backing or paid-work grant.';
