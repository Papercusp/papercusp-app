-- 466-hlc-node-id-strong-entropy.sql
--
-- WI-1672 follow-up (found while writing the mig-459 forced-tie regression test,
-- federation-concurrent-writes-sidecar.repro.integration.test.ts). mig-459 seeds
-- hlc_clock.node_id from plain SQL `random()`:
--
--   md5(random()::text || clock_timestamp()::text || pg_backend_pid()::text)
--
-- OBSERVED: two throwaway test databases, each independently migrated from empty
-- on the SAME Postgres server via two connections opened back-to-back (exactly the
-- shape of two devices provisioned/booted in a correlated way — the same
-- "AMPLIFIER" scenario WI-1672 itself describes), self-seeded the IDENTICAL
-- node_id from this formula, reproducibly, across separate test runs. Plain SQL
-- `random()` reads from Postgres's process-local `pg_global_prng_state` (a fast,
-- non-cryptographic PRNG whose seed derivation is a function of backend start time
-- + pid) -- NOT a source engineered to decorrelate two backends that fork/start in
-- close succession. Two peers whose node_id happens to collide silently regress to
-- the PRE-WI-1672 behavior: compareHlc/fed_order_key falls back to comparing empty
-- vs empty node segments (both equal), the tie reappears, and the `>=` guard
-- accepts the incoming remote op on BOTH sides again -- the exact stable
-- split-brain WI-1672 exists to close, now hiding behind a node segment that LOOKS
-- present but isn't actually unique.
--
-- THE FIX: reseed from pgcrypto's gen_random_bytes() -- a cryptographically strong
-- source (OpenSSL RAND_bytes under the hood), engineered to decorrelate exactly
-- this "many callers, narrow time window" shape. pgcrypto is already a required
-- extension (baseline DDL). 8 bytes -> 16 hex chars, matching HLC_NODE_LEN
-- (libs/generic/locks-core/src/hlc.ts) exactly, so no format/width change ripples
-- anywhere else (fed_order_key, compareHlc, encodeHlc, every projection guard stay
-- untouched -- this migration only changes HOW node_id's bytes are drawn, not their
-- shape).
--
-- Re-seeds EXISTING rows unconditionally (not just empty ones): changing a device's
-- node_id has no correctness cost (it is a stamping-clock IDENTITY token, not a
-- causal timestamp -- every already-persisted fed_hlc value keeps its OLD node
-- segment forever, which remains perfectly valid for ordering; only this device's
-- FUTURE stamps carry the new one, and a total order only requires the two
-- currently-active node ids to differ, not that a device's id is stable for life).
-- So this migration closes the gap for every device that already ran mig-459,
-- including ones that may have collided, without any migration-order dependency.
--
-- Idempotent: CREATE OR REPLACE + a plain UPDATE (safe to re-run; re-seeding again
-- on a second apply would just be a no-op in practice since schema_migrations
-- tracks this file as applied-once, but the UPDATE itself is naturally repeatable).

-- ── 1. Reseed every existing hlc_clock row's node_id with strong entropy ────────
UPDATE harness_shared.hlc_clock
   SET node_id = lower(encode(gen_random_bytes(8), 'hex'))
 WHERE id = 1;

-- ── 2. hlc_now(): self-heal path now draws from the same strong source ─────────
-- Byte-identical to mig-459's hlc_now() except the two `l_node := ...` seed
-- expressions. Everything else (the physical/logical advance, the return shape)
-- is UNCHANGED.
CREATE OR REPLACE FUNCTION harness_shared.hlc_now() RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  AS $fn$
DECLARE
  now_ms  bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  l_ms    bigint;
  l_count integer;
  l_node  text;
  n_ms    bigint;
  n_count integer;
BEGIN
  SELECT last_ms, last_count, node_id INTO l_ms, l_count, l_node
    FROM harness_shared.hlc_clock WHERE id = 1 FOR UPDATE;
  IF l_ms IS NULL THEN
    -- Defensive: seed if the singleton is somehow absent.
    INSERT INTO harness_shared.hlc_clock (id, last_ms, last_count) VALUES (1, 0, 0)
      ON CONFLICT (id) DO NOTHING;
    l_ms := 0; l_count := 0; l_node := NULL;
  END IF;
  IF COALESCE(l_node, '') = '' THEN
    l_node := lower(encode(gen_random_bytes(8), 'hex'));
    UPDATE harness_shared.hlc_clock SET node_id = l_node WHERE id = 1;
  END IF;
  IF now_ms > l_ms THEN
    n_ms := now_ms; n_count := 0;
  ELSIF l_count >= 65535 THEN
    n_ms := l_ms + 1; n_count := 0;
  ELSE
    n_ms := l_ms; n_count := l_count + 1;
  END IF;
  UPDATE harness_shared.hlc_clock SET last_ms = n_ms, last_count = n_count WHERE id = 1;
  RETURN lpad(n_ms::text, 15, '0') || ':' || lpad(n_count::text, 5, '0') || ':' || l_node;
END;
$fn$;

GRANT EXECUTE ON FUNCTION harness_shared.hlc_now() TO PUBLIC;
