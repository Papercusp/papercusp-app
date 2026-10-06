-- P005: a fixed read-lock bridge on the EXISTING provider receipt population.
-- Reuses the receipt/binding rail; no new ledger, account binding or DML grant.
-- SHARE normally needs write privileges that hosted_service must not receive.
-- It blocks all writers, including insertion into an empty table and direct
-- SQL, until the CALLER'S transaction ends. It opens no separate transaction.
-- This is local evidence only, never provider completeness or cash authority.
CREATE OR REPLACE FUNCTION papercusp_auth.lock_hosted_usage_population()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $body$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'usage population requires read committed' USING ERRCODE = '25001';
  END IF;
  LOCK TABLE papercusp_auth.hosted_usage_receipts IN SHARE MODE;
END;
$body$;
ALTER FUNCTION papercusp_auth.lock_hosted_usage_population() OWNER TO hosted_owner;
REVOKE ALL ON FUNCTION papercusp_auth.lock_hosted_usage_population()
  FROM PUBLIC, harness_app, harness_zero, hosted_app, hosted_service;
GRANT EXECUTE ON FUNCTION papercusp_auth.lock_hosted_usage_population() TO hosted_service;
COMMENT ON FUNCTION papercusp_auth.lock_hosted_usage_population() IS
  'Service-only fixed read lock on all existing usage receipts/bindings; no data return, DML, provider/account completeness, cash backing or paid-work grant. Caller retains lock until transaction completion; no usage writes in this read phase.';
