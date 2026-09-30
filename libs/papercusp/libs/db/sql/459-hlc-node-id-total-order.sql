-- 459-hlc-node-id-total-order.sql
--
-- WI-1672 (S0, found in P-015 federation testing): federated LWW split-brain on
-- an EXACT fed_hlc tie. mig-314's hlc_now() mints "<15-digit ms>:<5-digit count>"
-- with NO writer identity, and two peers' hlc_clock singletons routinely sit at
-- the SAME wall-ms frontier: hlc_recv/observeRemoteHlc ratchet every clock in the
-- hive to the max wall-ms ever witnessed (persisted in hlc_clock, surviving
-- restarts), so after ANY transient fast-clock episode all peers advance by
-- logical counter only, in near-lockstep. Concurrent writes to the same key then
-- mint IDENTICAL HLCs; every projection guard's tie-ACCEPTING compare
-- (fed_order_key(EXCLUDED…) >= fed_order_key(stored…), mig 458 — and the same
-- `>=` before it) lets the incoming REMOTE op overwrite the LOCAL row on BOTH
-- peers, and the two peers stably SWAP winners. Live-pinned on the wi1544 rig:
-- both frames independently minted 001783025829985:00417 for different content.
--
-- THE FIX — make the ordering key TOTAL BY CONSTRUCTION: append a per-clock node
-- identity segment, "<15-digit ms>:<5-digit count>:<16-hex node>". A genuine full
-- tie can then only be the SAME stamp replayed (where tie-accept is the correct,
-- idempotent behavior). Every existing comparator is already a plain TEXT
-- compare (fed_order_key passes hlc through verbatim; lwwPick compares encoded
-- strings), so NO guard changes: the ~20 projection guards, the delete guards,
-- and the in-process fold all become tie-free from this one migration + the
-- twin change in libs/generic/locks-core/src/hlc.ts (encode/decode/compare +
-- HlcClock node, for the Node-side clock that stamps log-first tables).
--
-- Ordering across formats: an old 2-segment value is a strict PREFIX of any
-- 3-segment sibling with the same (ms, count), so old loses the tie — the same
-- verdict on every peer (C locale, glibc/ICU collations, and JS string compare
-- all agree on prefix-first for these digit/hex/colon shapes), i.e. still ONE
-- order everywhere. The node segment is FIXED-WIDTH lowercase hex so every
-- node-carrying string has an identical shape.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + guarded UPDATE + CREATE OR REPLACE.
-- No table rewrites; nullable TEXT column, instant add.

-- ── 1. The clock's persistent node identity ────────────────────────────────────
ALTER TABLE harness_shared.hlc_clock ADD COLUMN IF NOT EXISTS node_id text;

-- Seed once per cluster (each device runs its own embedded PG, so per-cluster ==
-- per-writer). md5-of-entropy, 16 lowercase hex — the fixed node-segment shape.
UPDATE harness_shared.hlc_clock
   SET node_id = lower(substr(md5(random()::text || clock_timestamp()::text || pg_backend_pid()::text), 1, 16))
 WHERE id = 1 AND COALESCE(node_id, '') = '';

-- ── 2. hlc_now(): stamp local events WITH the node segment ─────────────────────
-- Same send() semantics as mig-314; now returns "<ms>:<count>:<node>" and
-- self-heals a missing node_id inside the same FOR UPDATE critical section (the
-- defensive re-seed path and pre-459 rows both land here exactly once).
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
    l_node := lower(substr(md5(random()::text || clock_timestamp()::text || pg_backend_pid()::text), 1, 16));
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

-- ── 3. hlc_recv(): parse BOTH encodings (2- and 3-segment) ─────────────────────
-- mig-314's parser cast everything after the FIRST colon to integer, so a
-- 3-segment stamp would have thrown → been swallowed → NO-OP — silently breaking
-- the recv-advance (a later local write would no longer be causally-after the
-- remote frontier). split_part isolates the count segment; the node segment is
-- deliberately ignored (it is identity, not causality). Malformed → no-op, as
-- before.
CREATE OR REPLACE FUNCTION harness_shared.hlc_recv(remote text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  AS $fn$
DECLARE
  r_ms    bigint;
  r_count integer;
BEGIN
  IF remote IS NULL OR remote = '' OR position(':' in remote) = 0 THEN RETURN; END IF;
  BEGIN
    r_ms := split_part(remote, ':', 1)::bigint;
    r_count := split_part(remote, ':', 2)::integer;
  EXCEPTION WHEN others THEN
    RETURN; -- malformed encoding → no-op
  END;
  IF r_ms IS NULL OR r_count IS NULL THEN RETURN; END IF;
  UPDATE harness_shared.hlc_clock
     SET last_ms    = GREATEST(last_ms, r_ms),
         last_count = CASE WHEN r_ms > last_ms THEN r_count
                           WHEN r_ms = last_ms THEN GREATEST(last_count, r_count)
                           ELSE last_count END
   WHERE id = 1
     AND (r_ms > last_ms OR (r_ms = last_ms AND r_count > last_count));
END;
$fn$;

GRANT EXECUTE ON FUNCTION harness_shared.hlc_now() TO PUBLIC;
GRANT EXECUTE ON FUNCTION harness_shared.hlc_recv(text) TO PUBLIC;
