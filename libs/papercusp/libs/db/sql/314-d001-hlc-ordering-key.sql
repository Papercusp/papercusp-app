-- 314-d001-hlc-ordering-key.sql
--
-- D-001 (shared-pot-release-testing Brief J, the hard S0): federated LWW
-- diverges under clock skew because the merge winners-fold orders by the op's
-- HLC (read-merge.ts beatsStored ≡ projection.ts lwwPick) but every mutable
-- projection's PG guard orders by `fed_ts` (wall clock, mig 181). The recv-seam
-- (observeRemoteHlc) advances a peer's HLC above a later write's `ts`, so the two
-- orders decouple: the fold hands apply the HLC-winner, the PG guard rejects it
-- (lower fed_ts) → two honest peers materialise DIFFERENT rows for the same key,
-- permanently. (Full root-cause: shared-pot-release-testing/findings-D.md +
-- findings-J.md; plan shared-hive-hardening-2026-06-13 D-013.)
--
-- THE FIX — one ordering key of record, end to end (approach (a)):
--   1. A dedicated `fed_hlc TEXT` column on every mutable LWW table. It stores
--      the op's `hlc` — ALREADY a fixed-width, lexicographically-sortable
--      encodeHlc string ("<15-digit ms>:<5-digit count>", libs/.../hlc.ts), so a
--      SQL `>=` string compare equals compareHlc. The projections (TS side, same
--      changeset) change their guard to `EXCLUDED.fed_hlc >= stored.fed_hlc` with
--      a `fed_ts` FALLBACK when either side lacks an hlc (pre-P-010 / pre-314
--      rows). `fed_ts` is left UNTOUCHED (the fallback + the plan-parts fed_ts=0
--      baseline convention + the fleet-monitors reader all stay valid).
--   2. WRITE-TIME HLC. The merge-fold ALREADY orders the wire op by HLC; the gap
--      is that a LOCAL write's PG row carries NO hlc (it never went through an
--      op), so an incoming remote op falls back to fed_ts against it and the
--      local-vs-remote divergence persists. So PG becomes the HLC CLOCK OF
--      RECORD: a singleton `hlc_clock` + hlc_now()/hlc_recv(), and the mig-214
--      `stamp_local_federated_write` trigger (already on the 11 CDC tables)
--      stamps `fed_hlc := hlc_now()` ATOMICALLY with fed_ts on a local write (no
--      NULL-fed_hlc window — the back-write-from-drain alternative was rejected
--      precisely because its window + skipOwnOps make a wrongly-applied remote op
--      unrecoverable), and PERFORMs hlc_recv(NEW.fed_hlc) on a remote apply (the
--      causal recv-advance, PG-side — no Node apply-path change). The CDC drain
--      threads the local row's fed_hlc onto the wire op (op.hlc = row.fed_hlc;
--      stampOpHlc preserves a preset hlc), so the remote peer's projection writes
--      the SAME fed_hlc → identical ordering key on both peers → convergence.
--      Log-first tables (presence/contributors/queue/working-set/feature_prs)
--      have no local-direct-write, so they keep the Node clock (stampOpHlc) and
--      need only the column + guard, no PG stamp.
--
-- Idempotent: CREATE OR REPLACE + ADD COLUMN IF NOT EXISTS + ON CONFLICT DO
-- NOTHING. No table rewrites; the column add is instant (nullable TEXT, no
-- default); BEFORE row triggers only. Migrates 000→head clean.

-- ── 1. The PG HLC clock of record ─────────────────────────────────────────────
-- A PROCESS-GLOBAL singleton (one row, id=1) — the HLC is per-machine, not
-- per-workspace, so NO workspace_id / RLS (mirrors the Node processHlc, which is
-- one shared clock per process). Monotone via a row lock inside the functions.
CREATE TABLE IF NOT EXISTS harness_shared.hlc_clock (
  id          smallint PRIMARY KEY DEFAULT 1,
  last_ms     bigint   NOT NULL DEFAULT 0,
  last_count  integer  NOT NULL DEFAULT 0,
  CONSTRAINT hlc_clock_singleton CHECK (id = 1)
);
INSERT INTO harness_shared.hlc_clock (id, last_ms, last_count)
  VALUES (1, 0, 0) ON CONFLICT (id) DO NOTHING;

-- hlc_now(): stamp a LOCAL event. Mirrors HlcClock.send(now_ms): the physical ms
-- if it advanced, else bumpCount (16-bit counter, rolls ms+1 at 65535). Returns
-- the encodeHlc string. SECURITY DEFINER so the trigger can advance the clock
-- regardless of the writing role; the row lock (FOR UPDATE) serialises concurrent
-- stampers exactly as single-threaded JS serialises the Node clock.
CREATE OR REPLACE FUNCTION harness_shared.hlc_now() RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  AS $fn$
DECLARE
  now_ms  bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  l_ms    bigint;
  l_count integer;
  n_ms    bigint;
  n_count integer;
BEGIN
  SELECT last_ms, last_count INTO l_ms, l_count
    FROM harness_shared.hlc_clock WHERE id = 1 FOR UPDATE;
  IF l_ms IS NULL THEN
    -- Defensive: seed if the singleton is somehow absent.
    INSERT INTO harness_shared.hlc_clock (id, last_ms, last_count) VALUES (1, 0, 0)
      ON CONFLICT (id) DO NOTHING;
    l_ms := 0; l_count := 0;
  END IF;
  IF now_ms > l_ms THEN
    n_ms := now_ms; n_count := 0;
  ELSIF l_count >= 65535 THEN
    n_ms := l_ms + 1; n_count := 0;
  ELSE
    n_ms := l_ms; n_count := l_count + 1;
  END IF;
  UPDATE harness_shared.hlc_clock SET last_ms = n_ms, last_count = n_count WHERE id = 1;
  RETURN lpad(n_ms::text, 15, '0') || ':' || lpad(n_count::text, 5, '0');
END;
$fn$;

-- hlc_recv(remote): merge an observed remote HLC so a later local hlc_now() is
-- strictly-greater (the cross-machine happens-before). A single conditional
-- UPDATE — atomic, and a no-op (0 rows) when the clock is already ahead. We only
-- need last >= remote (hlc_now re-applies the physical clock + the +1 bump), so
-- this is cheaper than replaying the full HlcClock.recv and is correct for the
-- "next stamp causally-after any recv'd op" property. Malformed/empty → no-op
-- (decodeHlc → HLC_ZERO). SECURITY DEFINER (same rationale as hlc_now).
CREATE OR REPLACE FUNCTION harness_shared.hlc_recv(remote text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  AS $fn$
DECLARE
  sep     integer;
  r_ms    bigint;
  r_count integer;
BEGIN
  IF remote IS NULL OR remote = '' THEN RETURN; END IF;
  sep := position(':' in remote);
  IF sep = 0 THEN RETURN; END IF;
  BEGIN
    r_ms := substr(remote, 1, sep - 1)::bigint;
    r_count := substr(remote, sep + 1)::integer;
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
GRANT SELECT, INSERT, UPDATE ON harness_shared.hlc_clock TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.hlc_clock TO harness_zero;
EXCEPTION WHEN undefined_object THEN NULL;
END
$grant$;

-- ── 2. fed_hlc ordering column on every mutable LWW table ──────────────────────
-- Mirrors the mig-181 fed_ts set + the later federated tables (186/189/197/270).
-- Nullable TEXT, no default → instant add; existing rows backfill lazily (a NULL
-- fed_hlc falls back to the fed_ts guard, so the first federated write after this
-- migration stamps it). Append-only / DO-NOTHING projections
-- (contributor_usage_events, feature_claims, work_item_claims) need no guard and
-- are intentionally omitted (they never LWW).
ALTER TABLE harness_shared.harness_features_consolidated ADD COLUMN IF NOT EXISTS fed_hlc TEXT;
ALTER TABLE harness_shared.harness_issues_consolidated   ADD COLUMN IF NOT EXISTS fed_hlc TEXT;
ALTER TABLE harness_shared.harness_feature_prs           ADD COLUMN IF NOT EXISTS fed_hlc TEXT;
ALTER TABLE harness_shared.shared_presence               ADD COLUMN IF NOT EXISTS fed_hlc TEXT;
ALTER TABLE harness_shared.contributors                  ADD COLUMN IF NOT EXISTS fed_hlc TEXT;
ALTER TABLE harness_shared.feature_queue                 ADD COLUMN IF NOT EXISTS fed_hlc TEXT;
ALTER TABLE harness_shared.feature_working_set           ADD COLUMN IF NOT EXISTS fed_hlc TEXT;
ALTER TABLE harness_shared.harness_plans                 ADD COLUMN IF NOT EXISTS fed_hlc TEXT;
ALTER TABLE harness_shared.coord_conversations           ADD COLUMN IF NOT EXISTS fed_hlc TEXT;
ALTER TABLE harness_shared.coord_event_log               ADD COLUMN IF NOT EXISTS fed_hlc TEXT;
ALTER TABLE harness_shared.coord_threads                 ADD COLUMN IF NOT EXISTS fed_hlc TEXT;
ALTER TABLE harness_shared.coord_thread_posts            ADD COLUMN IF NOT EXISTS fed_hlc TEXT;
ALTER TABLE harness_shared.plan_item_assignments         ADD COLUMN IF NOT EXISTS fed_hlc TEXT;
ALTER TABLE harness_shared.hive_settings                 ADD COLUMN IF NOT EXISTS fed_hlc TEXT;
ALTER TABLE harness_shared.hive_members                  ADD COLUMN IF NOT EXISTS fed_hlc TEXT;
ALTER TABLE harness_shared.engineer_issues               ADD COLUMN IF NOT EXISTS fed_hlc TEXT;
-- harness_plan_parts: plan-part federation is flag-gated/DARK; add the column so
-- its projection guard can reference it, but its write-time stamp keeps the
-- existing fed_ts=0/now baseline convention (federation.ts) for now — the guard's
-- fed_ts fallback covers it until plan-part federation is GA. (findings-J.)
ALTER TABLE harness_shared.harness_plan_parts            ADD COLUMN IF NOT EXISTS fed_hlc TEXT;

-- The CDC outbox carries each captured op's HLC so the drain threads it onto the
-- wire op (op.hlc), UNIFORMLY for puts AND dels from the ONE PG clock of record:
--   • put → the row's `fed_hlc` (set by the BEFORE stamp trigger — the SAME value
--     the local row carries, so the remote peer materialises an identical key).
--   • del → a FRESH hlc_now() (a del is a new event causally-after the row's last
--     state; the OLD row's stale fed_hlc would under-stamp it).
-- This keeps dels and puts on ONE clock (what the convergence-fuzz rig models),
-- so a del-vs-put conflict under skew converges by HLC just like put-vs-put.
ALTER TABLE harness_shared.substrate_outbox              ADD COLUMN IF NOT EXISTS op_hlc TEXT;

-- ── 3. Write-time HLC + recv-advance in the mig-214 local-stamp trigger ────────
-- Supersedes the mig-214 stamp_local_federated_write function. Same fed_ts logic
-- as 214 (UNCHANGED — a write that MOVES fed_ts is a remote/projection apply or a
-- deliberate repair, respected verbatim; a write that leaves fed_ts untouched
-- while changing the row is a LOCAL write → stamp the wall clock + origin='local'),
-- now ALSO:
--   • LOCAL write → NEW.fed_hlc := hlc_now() (atomic with fed_ts; the row's
--     ordering key is set at write time, no NULL window).
--   • REMOTE apply (fed_ts moved) → PERFORM hlc_recv(NEW.fed_hlc) so the PG clock
--     advances past the remote causal frontier (a later local write is then
--     stamped strictly-greater — the recv-advance, PG-side).
-- The content-change comparison masks `fed_hlc` alongside `fed_ts` (bookkeeping —
-- must not, on its own, count as a content change; it always moves with fed_ts).
CREATE OR REPLACE FUNCTION harness_shared.stamp_local_federated_write() RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
BEGIN
  -- A write that moves fed_ts is a projection apply (remote op; fed_ts = the op's
  -- wire ts) or an explicit repair/backfill — respect it verbatim, and advance the
  -- PG HLC clock past the op's HLC so a later LOCAL write is causally-after it.
  IF TG_OP = 'UPDATE' AND NEW.fed_ts IS DISTINCT FROM OLD.fed_ts THEN
    IF NEW.fed_hlc IS NOT NULL THEN
      PERFORM harness_shared.hlc_recv(NEW.fed_hlc);
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- A projection INSERT carries the op's fed_ts AND origin='remote'; a local
    -- INSERT carries neither. Gate the stamp on origin (see mig 214).
    IF NEW.fed_ts IS NULL AND COALESCE(NEW.origin, 'local') = 'local' THEN
      NEW.fed_ts := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
      NEW.fed_hlc := harness_shared.hlc_now();
    ELSIF NEW.fed_hlc IS NOT NULL THEN
      -- Remote INSERT carrying an hlc → recv-advance.
      PERFORM harness_shared.hlc_recv(NEW.fed_hlc);
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE with fed_ts untouched = a local write. Stamp the LWW clock (fed_ts AND
  -- the HLC ordering key) and reset origin so CDC capture federates the change.
  -- Bookkeeping-only writes (version bumps, updated_at touches, generated _search)
  -- keep the prior clock. fed_hlc is masked from the content compare (it moves
  -- with fed_ts; on its own it must not count as a content change).
  IF (to_jsonb(NEW) - 'fed_ts' - 'fed_hlc' - 'origin' - 'author_pubkey' - 'updated_at' - '_search' - 'version')
     IS DISTINCT FROM
     (to_jsonb(OLD) - 'fed_ts' - 'fed_hlc' - 'origin' - 'author_pubkey' - 'updated_at' - '_search' - 'version')
  THEN
    NEW.fed_ts := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
    NEW.fed_hlc := harness_shared.hlc_now();
    NEW.origin := 'local';
  END IF;
  RETURN NEW;
END;
$fn$;

-- ── 3b. The CDC capture function stamps op_hlc onto every captured op ──────────
-- Supersedes the 000-baseline capture_substrate_outbox(): unchanged except it now
-- also computes op_hlc and writes it to the outbox. put → the (BEFORE-trigger-
-- stamped) row.fed_hlc; del → a fresh hlc_now(). The echo guard (skip non-local
-- origin) and everything else are byte-identical to the baseline.
CREATE OR REPLACE FUNCTION harness_shared.capture_substrate_outbox() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE
      v_op      TEXT;
      v_rec     RECORD;
      v_origin  TEXT;
      v_key     TEXT;
      v_row     JSONB;
      v_ws      TEXT;
      v_slug    TEXT;
      v_op_hlc  TEXT;
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
      v_slug := v_row ->> 'harness_slug';

      -- D-001: the op's HLC ordering key, threaded onto the wire op by the drain.
      -- put → the row's fed_hlc (the BEFORE stamp trigger's value, identical to
      -- what the local row carries); del → a fresh hlc_now() (the del event's own
      -- causal clock; the OLD row's fed_hlc is stale). NULL on a table with no
      -- fed_hlc (append-only usage) → the drain's stampOpHlc generates a fallback.
      IF v_op = 'del' THEN
        v_op_hlc := harness_shared.hlc_now();
      ELSE
        v_op_hlc := v_row ->> 'fed_hlc';
      END IF;

      INSERT INTO harness_shared.substrate_outbox
        (workspace_id, harness_slug, table_name, op, key, row, ts, op_hlc)
      VALUES
        (v_ws, v_slug, TG_TABLE_NAME, v_op, v_key, v_row,
         (extract(epoch from now()) * 1000)::bigint, v_op_hlc);

      PERFORM pg_notify('substrate_outbox', v_ws || '::' || v_slug);

      RETURN v_rec;
    END;
    $$;

-- ── 4. fed_hlc must NOT re-trigger CDC capture (the two broad-compare tables) ──
-- mig 181 masks fed_ts in the broad-row-compare UPDATE capture triggers on the
-- two consolidated tables; fed_hlc is the same bookkeeping class (it moves with
-- fed_ts on every re-application of an own-log op), so mask it too — otherwise a
-- merge-back that touches fed_hlc would make the row "distinct" and re-enqueue
-- forever. The coord/plan/hive triggers use explicit federated column lists, so a
-- new bookkeeping column never enters their compare — no change needed there.
CREATE OR REPLACE TRIGGER capture_substrate_outbox_upd_trg
  AFTER UPDATE ON harness_shared.harness_features_consolidated
  FOR EACH ROW WHEN ((to_jsonb(OLD.*) - 'fed_ts' - 'fed_hlc') IS DISTINCT FROM (to_jsonb(NEW.*) - 'fed_ts' - 'fed_hlc'))
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('feature_id');

CREATE OR REPLACE TRIGGER capture_substrate_outbox_upd_trg
  AFTER UPDATE ON harness_shared.harness_issues_consolidated
  FOR EACH ROW WHEN ((to_jsonb(OLD.*) - 'fed_ts' - 'fed_hlc') IS DISTINCT FROM (to_jsonb(NEW.*) - 'fed_ts' - 'fed_hlc'))
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('issue_id');
