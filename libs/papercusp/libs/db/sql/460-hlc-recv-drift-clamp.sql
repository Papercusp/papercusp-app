-- 460-hlc-recv-drift-clamp.sql
--
-- WI-1672 follow-through: bound the hlc_recv ratchet. mig-314's recv (kept by
-- 459) ratchets the singleton clock to ANY remote frontier, unconditionally.
-- One absurd-future stamp — a peer with a broken clock, a malicious member, or
-- literally one diagnostic `SELECT hlc_recv('001999999999999:…')` (demonstrated
-- live on this box, 2026-07-02) — pins the clock years ahead, PERSISTENTLY
-- (hlc_clock survives restarts). Every subsequent local write then mints
-- future stamps that (a) win LWW against all honest peers until the wall clock
-- catches up and (b) re-propagate the pin to everyone who receives them: the
-- WI-1672 lockstep amplifier, weaponizable hive-wide from a single stamp.
--
-- The HLC paper's own answer (Kulkarni et al. §4, the ε bound): REFUSE to
-- advance l past pt + ε; the op itself is still applied — only the clock
-- ratchet is skipped. ε = 10 min, 2× the D-007 announce-admission window
-- (±5 min), so any peer legitimately admitted can still ratchet us; anything
-- beyond it is by definition outside the hive's own skew contract.
-- Twin change: HlcClock.recv() in libs/generic/locks-core/src/hlc.ts.

CREATE OR REPLACE FUNCTION harness_shared.hlc_recv(remote text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  AS $fn$
DECLARE
  now_ms  bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
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
  IF r_ms - now_ms > 600000 THEN RETURN; END IF;  -- ε clamp: >10min future → no ratchet
  UPDATE harness_shared.hlc_clock
     SET last_ms    = GREATEST(last_ms, r_ms),
         last_count = CASE WHEN r_ms > last_ms THEN r_count
                           WHEN r_ms = last_ms THEN GREATEST(last_count, r_count)
                           ELSE last_count END
   WHERE id = 1
     AND (r_ms > last_ms OR (r_ms = last_ms AND r_count > last_count));
END;
$fn$;

GRANT EXECUTE ON FUNCTION harness_shared.hlc_recv(text) TO PUBLIC;
