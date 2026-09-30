-- Migration 477 — capture_hive_members_outbox: the put-op's wire ts/op_hlc IS the
-- row's stamped fed_ts/fed_hlc (the mig-446 D-001 symmetry, extended to the THIRD
-- capture function it overlooked).
--
-- WHY -------------------------------------------------------------------------------
-- A full write-path audit of every `substrate_outbox` enqueue site found that
-- `harness_shared.capture_hive_members_outbox()` (live def = mig 189) is the SOLE
-- capture that threads NEITHER the row's `fed_ts` NOR any `op_hlc` onto the wire op:
--   INSERT INTO substrate_outbox (…, ts) VALUES (…, extract(epoch from now())*1000)
-- It stamps the wire ts with `now()` (the TRANSACTION-START clock) and omits the
-- `op_hlc` column entirely. `hive_members` IS a stamp-regime table — `fed_ts`
-- (mig 189) and `fed_hlc` (mig 314) are stamped ATOMICALLY by
-- `stamp_local_federated_write` (mig 214/314, BEFORE row) — so the row already
-- carries the author's genuine ordering key, but the capture drops it.
--
-- Consequence (the just-fixed bug class, on a third table): the drain, seeing a NULL
-- `op_hlc`, mints a fallback HLC via `stampOpHlc` from the DRAIN process clock, which
-- can run AHEAD of the write's genuine ms; the receiver then persists that inflated
-- pair as `hive_members.fed_ts/fed_hlc`. A hive_members op (an admission-record /
-- revocation-blocklist replication) can thus land on a peer with an ordering key
-- NEWER than the author's — the same LWW-clobber shape mig-446 fixed for the generic
-- + work-items captures. mig-446's own header claimed "TWO capture functions carry
-- the bug"; this hand-rolled per-Hive capture was overlooked.
--
-- Because the trigger fires synchronously in the write's own txn (not a re-emit of an
-- already-old row), the common-case skew is only the intra-txn delta (mig-446-class
-- bookkeeping); the larger clobber exposure appears when the op drains late or the
-- process HLC is already ahead. It is a genuine gap of the same class either way.
--
-- THE FIX — one clock read of record per op, identical shape to mig-446:
--   • put on a stamp-regime row (fed_hlc IS NOT NULL ⇒ the BEFORE trigger stamped
--     fed_ts atomically with it) → op_hlc := row.fed_hlc, wire ts := the row's
--     fed_ts. Author + receivers then persist the SAME (fed_ts, fed_hlc) pair.
--   • put on an unstamped row (fed_hlc NULL) → now() + op_hlc NULL (drain fallback).
--     UNCHANGED — hive_members is always stamped, so this is a defensive fall-through.
--   • del → a fresh hlc_now() + now() (a del is its own event causally-after the
--     row's last state; the OLD row's stamp would under-stamp it — same rationale as
--     the fresh del op_hlc in the generic capture).
--
-- No repair pass (mig-446 rationale): pre-477 receiver rows hold the old wire ts, but
-- with fed_hlc present the LWW guard orders by HLC, so a divergent fed_ts is
-- bookkeeping-only and heals on the row's next federated write.
--
-- Idempotent (CREATE OR REPLACE; the two trigger attachments from mig 189 bind by
-- function NAME and are unchanged). The runner provides the transaction — NO
-- BEGIN/COMMIT here (lint:migrations).

CREATE OR REPLACE FUNCTION harness_shared.capture_hive_members_outbox() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      v_op      TEXT;
      v_rec     RECORD;
      v_origin  TEXT;
      v_key     TEXT;
      v_row     JSONB;
      v_ws      TEXT;
      v_slug    TEXT;
      v_op_hlc  TEXT;
      v_ts      BIGINT;
      v_keycol  TEXT := TG_ARGV[0];
    BEGIN
      IF (TG_OP = 'DELETE') THEN
        v_op := 'del';
        v_rec := OLD;
      ELSE
        v_op := 'put';
        v_rec := NEW;
      END IF;

      v_row := to_jsonb(v_rec);
      v_origin := v_row ->> 'origin';

      -- Echo-loop guard: skip remote-origin writes (the projection's own writes).
      IF COALESCE(v_origin, 'local') <> 'local' THEN
        RETURN v_rec;
      END IF;

      v_key  := v_row ->> v_keycol;
      v_ws   := COALESCE(v_row ->> 'workspace_id', '');
      v_slug := v_row ->> 'hive_home_slug';  -- the Hive scope (generic fn reads harness_slug)

      -- D-001 / mig 446 symmetry: thread the row's stamped ordering key onto the wire
      -- op so author + receivers materialise the SAME (fed_ts, fed_hlc). put → the
      -- row's fed_hlc + COALESCE(fed_ts, now()); del → a fresh hlc_now()+now() (its
      -- own causal event); unstamped row (fed_hlc NULL) → now()+NULL (drain fallback).
      IF v_op = 'del' THEN
        v_op_hlc := harness_shared.hlc_now();
        v_ts     := (extract(epoch from now()) * 1000)::bigint;
      ELSE
        v_op_hlc := v_row ->> 'fed_hlc';
        v_ts     := CASE WHEN v_op_hlc IS NOT NULL
                         THEN COALESCE((v_row ->> 'fed_ts')::bigint,
                                       (extract(epoch from now()) * 1000)::bigint)
                         ELSE (extract(epoch from now()) * 1000)::bigint
                    END;
      END IF;

      INSERT INTO harness_shared.substrate_outbox
        (workspace_id, harness_slug, table_name, op, key, row, ts, op_hlc)
      VALUES
        (v_ws, v_slug, TG_TABLE_NAME, v_op, v_key, v_row, v_ts, v_op_hlc);

      PERFORM pg_notify('substrate_outbox', v_ws || '::' || v_slug);

      RETURN v_rec;
    END;
    $$;
