-- P005: extend the EXISTING funding source bridge with local liabilities.
-- No new journal, account mapping, cash balance, policy or DML grant.
GRANT SELECT (workspace_id, rollup_id, currency, total_micros, settled_cents, rounding_micros)
  ON harness_shared.money_journal_rollups TO hosted_service;
GRANT SELECT (workspace_id, rollup_id, accrual_id, micros, recorded_at)
  ON harness_shared.money_journal_micro_accruals TO hosted_service;

DROP POLICY IF EXISTS money_journal_rollups_hosted_funding_read
  ON harness_shared.money_journal_rollups;
CREATE POLICY money_journal_rollups_hosted_funding_read
  ON harness_shared.money_journal_rollups FOR SELECT TO hosted_service USING (true);
DROP POLICY IF EXISTS money_journal_micro_accruals_hosted_funding_read
  ON harness_shared.money_journal_micro_accruals;
CREATE POLICY money_journal_micro_accruals_hosted_funding_read
  ON harness_shared.money_journal_micro_accruals FOR SELECT TO hosted_service USING (true);

-- Rollups FIRST, before journal entries. Settlement takes ROW EXCLUSIVE on
-- rollups before its entry INSERT; accrual's first rollup INSERT does likewise.
-- Empty tables and direct writers are covered through caller commit/rollback.
CREATE OR REPLACE FUNCTION papercusp_auth.lock_hosted_stripe_funding_population()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $body$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'funding population requires read committed' USING ERRCODE = '25001';
  END IF;
  LOCK TABLE harness_shared.money_journal_rollups,
    harness_shared.money_journal_micro_accruals,
    harness_shared.money_journal_entries,
    harness_shared.money_journal_lines,
    harness_shared.payment_receipts,
    papercusp_auth.hosted_billing_customers IN SHARE MODE;
END;
$body$;
REVOKE ALL ON FUNCTION papercusp_auth.lock_hosted_stripe_funding_population()
  FROM PUBLIC, harness_app, harness_zero, hosted_app;
GRANT EXECUTE ON FUNCTION papercusp_auth.lock_hosted_stripe_funding_population() TO hosted_service;
COMMENT ON FUNCTION papercusp_auth.lock_hosted_stripe_funding_population() IS
  'Service-only fixed read locks, rollups/accruals before journal/receipt/customer populations; no data return, DML, account mapping, cash/provider backing or paid-work grant. Caller must not write these sources during the read phase.';
