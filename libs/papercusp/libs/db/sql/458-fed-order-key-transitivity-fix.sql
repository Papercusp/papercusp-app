-- 458-fed-order-key-transitivity-fix.sql
--
-- EI-1698: the federation LWW comparator (lwwPick / projection.ts) and the PG-level
-- fed_hlc "don't clobber a newer row" guard used to share the rule "if BOTH sides
-- carry an HLC -> compare HLC, ELSE -> compare the bare wall-clock ts". That rule is
-- NON-TRANSITIVE when HLC presence is mixed (a rolling-upgrade / pre-P-010-history
-- scenario): three ops X (hlc+ts), Y (ts only, ts BETWEEN X and Z), Z (hlc+ts) can
-- form a cycle X>Z, Z>Y, Y>X, so two peers applying the SAME ops in a different
-- delivery order pick a DIFFERENT final winner -- a genuine convergence bug.
--
-- lwwPick was already fixed (in-process) by giving every op ONE comparable key: its
-- real hlc when present, else a DERIVED hlc `encodeHlc({ms: ts ?? 0, count: 0})` --
-- comparing that single derived key for every pair makes the order transitive.
--
-- This migration gives the PG-level guard the SAME fix via a small immutable SQL
-- function so every writer's ON CONFLICT / DELETE guard compares in the SAME single
-- order space as lwwPick (word-for-word the same derivation, so the two never
-- disagree on which op "wins" -- restoring D-001's original intent that the PG guard
-- never rejects what the in-process fold would have picked).
--
-- `fed_order_key(hlc, ts)` returns:
--   - `hlc` verbatim when present (already a fixed-width "<15-digit ms>:<5-digit
--     count>" sortable string -- see encodeHlc() in libs/generic/locks-core/src/hlc.ts);
--   - else the SAME encodeHlc({ms: ts ?? 0, count: 0}) shape built from `ts`
--     (`lpad(COALESCE(ts,0)::text, 15, '0') || ':00000'`).
-- A missing hlc AND missing ts both collapse to the all-zero minimum key
-- ('000000000000000:00000' == encodeHlc({ms:0,count:0}) == HLC_ZERO), so a stored row
-- with NO federation-ordering info at all is always beaten (or tied, which a `>=`
-- guard also accepts) by ANY incoming op that carries real info -- reproducing the
-- pre-existing "stored fed_ts IS NULL -> unconditional accept" fallback exactly, with
-- no separate NULL-branch needed in the calling guard.
--
-- IMMUTABLE + STRICT-safe (NULL args are valid -- both may be NULL): pure function of
-- its inputs, safe to inline in a WHERE clause / index expression.
CREATE OR REPLACE FUNCTION harness_shared.fed_order_key(hlc text, ts bigint)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(hlc, lpad(COALESCE(ts, 0)::text, 15, '0') || ':00000');
$$;
