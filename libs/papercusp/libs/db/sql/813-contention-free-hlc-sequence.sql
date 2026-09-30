-- 813-contention-free-hlc-sequence.sql
--
-- WI-38304: hlc_now() took FOR UPDATE on the singleton hlc_clock row. Because
-- it normally runs inside a caller's larger transaction (often from a BEFORE
-- trigger), PostgreSQL retained that row lock until the OUTER transaction
-- committed. One slow federated write therefore serialized every unrelated
-- federated write in the database and made the 5s workspace lock_timeout fail
-- with 55P03 under fleet bursts.
--
-- Keep the same HLC order and persistent node identity, but store the causal
-- (ms,count) frontier in a PostgreSQL sequence packed as ms*65536+count. Sequence
-- changes are durable and non-transactional, so no lock inherits the caller's
-- transaction lifetime. A session advisory lock protects only the few statements
-- that ratchet the sequence to max(wall, local, remote), and is explicitly
-- released before either function returns.

CREATE SEQUENCE IF NOT EXISTS harness_shared.hlc_packed_seq
  AS bigint
  INCREMENT BY 1
  MINVALUE 0
  MAXVALUE 9223372036854775807
  START WITH 0
  CACHE 1
  NO CYCLE;

-- Seed from the row-backed clock without ever moving an existing sequence
-- backwards. The legacy row remains for compatibility/diagnostics, but the
-- sequence is the clock source of truth after this migration.
SELECT pg_catalog.setval(
  'harness_shared.hlc_packed_seq'::regclass,
  GREATEST(
    (SELECT last_value FROM harness_shared.hlc_packed_seq),
    COALESCE((SELECT last_ms * 65536 + last_count FROM harness_shared.hlc_clock WHERE id = 1), 0)
  ),
  true
);

COMMENT ON SEQUENCE harness_shared.hlc_packed_seq IS
  'Packed HLC causal frontier: (epoch_ms * 65536) + logical_count. Source of truth since migration 813; sequence state avoids transaction-lifetime row locks.';

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
  EXCEPTION WHEN others THEN
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
  EXCEPTION WHEN others THEN
    PERFORM pg_catalog.pg_advisory_unlock(lock_key);
    RAISE;
  END;
  PERFORM pg_catalog.pg_advisory_unlock(lock_key);
END;
$fn$;

GRANT EXECUTE ON FUNCTION harness_shared.hlc_now() TO PUBLIC;
GRANT EXECUTE ON FUNCTION harness_shared.hlc_recv(text) TO PUBLIC;

