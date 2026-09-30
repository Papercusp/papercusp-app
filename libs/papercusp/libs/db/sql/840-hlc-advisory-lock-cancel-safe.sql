-- 840-hlc-advisory-lock-cancel-safe.sql
--
-- WI-38304 follow-up. Migration 813 correctly removed the `hlc_clock FOR UPDATE`
-- row lock that serialized every federated write, replacing it with a sequence
-- plus a SHORT-LIVED SESSION advisory lock (48452354813). A session lock is the
-- right choice there: a transaction-scoped one would be held until the CALLER's
-- outer transaction committed, which is the very bug 813 fixed.
--
-- But 813 guarded that lock with `EXCEPTION WHEN others`, and PostgreSQL
-- deliberately EXCLUDES query_canceled (and assert_failure) from OTHERS. So when
-- a statement_timeout / pg_cancel_backend fires inside the protected block, the
-- unlock arm never runs. A session advisory lock is NOT released by transaction
-- rollback — only by an explicit unlock or backend exit — so the pooled backend
-- keeps the HLC lock forever, and every later hlc_now() on every connection
-- blocks on it until lock_timeout and fails 55P03.
--
-- That is the ORIGINAL WI-38304 symptom, made PERMANENT instead of transient,
-- and it is reachable precisely under the fleet bursts this item is about (that
-- is when statement timeouts fire).
--
-- Measured, not recalled — a probe function with 813's exact lock/unlock shape,
-- in an isolated database:
--     divide_by_zero    -> trapped by `others`, locks held afterwards: 0
--     statement_timeout -> NOT trapped by `others`, locks held afterwards: 1
--     statement_timeout -> with the query_canceled arm below,           0
-- Guard: packages/operator-core/lib/sync/hyperbee/__tests__/hlc-contention-guard.integration.test.ts
--
-- The fix names query_canceled explicitly so the lock is released on the way out,
-- then re-RAISEs so the cancellation is still delivered to the caller (a
-- cancellation must never be swallowed). The HLC ratchet logic, lock key, packed
-- encoding and node identity are byte-for-byte unchanged from 813 — the ONLY
-- change is the failure path — so this is fully compatible with the release
-- checkout still serving :3070.

CREATE OR REPLACE FUNCTION harness_shared.hlc_now() RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  AS $fn$
DECLARE
  lock_key constant bigint := 48452354813;
  now_ms   bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  wall_packed bigint := now_ms * 65536;
  n_packed bigint;
  n_ms     bigint;
  n_count  integer;
  l_node   text;
BEGIN
  PERFORM pg_catalog.pg_advisory_lock(lock_key);
  BEGIN
    n_packed := pg_catalog.nextval('harness_shared.hlc_packed_seq'::regclass);
    IF n_packed < wall_packed THEN
      PERFORM pg_catalog.setval('harness_shared.hlc_packed_seq'::regclass, wall_packed, true);
      n_packed := wall_packed;
    END IF;

    SELECT node_id INTO l_node
      FROM harness_shared.hlc_clock WHERE id = 1;
    IF COALESCE(l_node, '') = '' THEN
      l_node := lower(encode(gen_random_bytes(8), 'hex'));
      UPDATE harness_shared.hlc_clock SET node_id = l_node WHERE id = 1;
    END IF;
  EXCEPTION
    -- query_canceled is NOT matched by OTHERS; without this arm a statement
    -- timeout here leaks lock_key for the life of the backend.
    WHEN query_canceled THEN
      PERFORM pg_catalog.pg_advisory_unlock(lock_key);
      RAISE;
    WHEN others THEN
      PERFORM pg_catalog.pg_advisory_unlock(lock_key);
      RAISE;
  END;
  PERFORM pg_catalog.pg_advisory_unlock(lock_key);

  n_ms := n_packed / 65536;
  n_count := (n_packed % 65536)::integer;
  RETURN lpad(n_ms::text, 15, '0') || ':' || lpad(n_count::text, 5, '0') || ':' || l_node;
END;
$fn$;

CREATE OR REPLACE FUNCTION harness_shared.hlc_recv(remote text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  AS $fn$
DECLARE
  lock_key constant bigint := 48452354813;
  now_ms    bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  r_ms      bigint;
  r_count   integer;
  r_packed  bigint;
  l_packed  bigint;
BEGIN
  IF remote IS NULL OR remote = '' OR position(':' in remote) = 0 THEN RETURN; END IF;
  BEGIN
    r_ms := split_part(remote, ':', 1)::bigint;
    r_count := split_part(remote, ':', 2)::integer;
  EXCEPTION WHEN others THEN
    RETURN;
  END;
  IF r_ms IS NULL OR r_count IS NULL OR r_count < 0 OR r_count > 65535 THEN RETURN; END IF;
  IF r_ms - now_ms > 600000 THEN RETURN; END IF;
  r_packed := r_ms * 65536 + r_count;

  PERFORM pg_catalog.pg_advisory_lock(lock_key);
  BEGIN
    SELECT last_value INTO l_packed FROM harness_shared.hlc_packed_seq;
    IF r_packed > l_packed THEN
      PERFORM pg_catalog.setval('harness_shared.hlc_packed_seq'::regclass, r_packed, true);
    END IF;
  EXCEPTION
    WHEN query_canceled THEN
      PERFORM pg_catalog.pg_advisory_unlock(lock_key);
      RAISE;
    WHEN others THEN
      PERFORM pg_catalog.pg_advisory_unlock(lock_key);
      RAISE;
  END;
  PERFORM pg_catalog.pg_advisory_unlock(lock_key);
END;
$fn$;

GRANT EXECUTE ON FUNCTION harness_shared.hlc_now() TO PUBLIC;
GRANT EXECUTE ON FUNCTION harness_shared.hlc_recv(text) TO PUBLIC;
