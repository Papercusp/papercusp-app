-- P005: extend the EXISTING restricted population lock bridge with one phase.
-- No new ledger, account mapping, policy, cash authority or financial DML grant.
-- The zero-argument source phase keeps its existing account-first contract.
-- Budget writers preclaim this fence before organization/account/source locks.
CREATE OR REPLACE FUNCTION papercusp_auth.lock_hosted_stripe_funding_population(phase text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $body$
BEGIN
  IF phase IS DISTINCT FROM 'budget-writer' THEN
    RAISE EXCEPTION 'invalid hosted funding population phase' USING ERRCODE = '22023';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'budget population requires read committed' USING ERRCODE = '25001';
  END IF;
  -- An existing fence makes nested store calls in this transaction safe.
  IF EXISTS (SELECT 1 FROM pg_locks WHERE pid = pg_backend_pid() AND granted
      AND relation = 'papercusp_auth.hosted_budget_receipts'::regclass
      AND mode = 'ShareRowExclusiveLock') THEN
    RETURN;
  END IF;
  -- Refuse a late acquisition rather than form an account/table or org/table
  -- cycle. Raw INSERT takes its table lock before the organization trigger.
  IF EXISTS (SELECT 1 FROM pg_locks WHERE pid = pg_backend_pid() AND granted
      AND (locktype = 'advisory' OR (mode = 'ShareLock' AND relation IN (
        'harness_shared.money_journal_rollups'::regclass,
        'harness_shared.money_journal_micro_accruals'::regclass,
        'harness_shared.money_journal_entries'::regclass,
        'harness_shared.money_journal_lines'::regclass,
        'harness_shared.payment_receipts'::regclass,
        'papercusp_auth.hosted_billing_customers'::regclass)))) THEN
    RAISE EXCEPTION 'budget writer fence must precede organization account and source locks'
      USING ERRCODE = '25001';
  END IF;
  LOCK TABLE papercusp_auth.hosted_budget_receipts IN SHARE ROW EXCLUSIVE MODE;
END;
$body$;
ALTER FUNCTION papercusp_auth.lock_hosted_stripe_funding_population(text) OWNER TO hosted_owner;
REVOKE ALL ON FUNCTION papercusp_auth.lock_hosted_stripe_funding_population(text)
  FROM PUBLIC, harness_app, harness_zero, hosted_app;
GRANT EXECUTE ON FUNCTION papercusp_auth.lock_hosted_stripe_funding_population(text) TO hosted_service;
COMMENT ON FUNCTION papercusp_auth.lock_hosted_stripe_funding_population(text) IS
  'Fixed budget-writer phase of the existing bridge. Preclaims only the receipt table before organization/account/source locks; no data return, DML, account binding, cash backing or paid grant. Retained through caller commit/rollback.';
