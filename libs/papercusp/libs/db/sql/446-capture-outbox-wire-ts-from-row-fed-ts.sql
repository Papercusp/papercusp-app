-- Migration 446 — the put-op's wire ts IS the row's stamped fed_ts (D-001 symmetry).
--
-- Plan: federation-release-hardening-relaunch-2026-07-01 P-013 (WI-1544 live
-- matrix, scenario concurrent_lww).
--
-- WHY -------------------------------------------------------------------------------
-- The mig-314 stamp trigger (BEFORE row) stamps a local write's LWW clock with
-- `clock_timestamp()`: fed_ts + fed_hlc, atomically. The capture trigger (AFTER row,
-- same transaction) enqueues the op with ts = `now()` — the TRANSACTION-START time,
-- an earlier read of a different clock. The drain threads outbox.ts → op.ts, and the
-- remote projection persists op.ts as its fed_ts (the projection.ts contract: "the
-- op's WIRE ts … writers persist it as the table's fed_ts"). So the author's row and
-- every receiver's row hold PERMANENTLY different fed_ts for the same op — skewed by
-- the intra-transaction delta between txn-start and the row write.
--
-- Live signature (WI-1544 rig, matrix m1783010318, scenario concurrent_lww): both
-- frames converge on the same winner {title,status,fed_hlc} but
--   author row  fed_ts=1783010341361  (clock_timestamp at the BEFORE stamp)
--   its wire op    ts=1783010341353  (now() at capture — 8ms earlier, txn start)
--   receiver row fed_ts=1783010341353
-- → the byte-identical-tuple convergence check fails on fed_ts alone, forever.
--
-- THE FIX — one clock read of record per op, same shape as op_hlc. The capture
-- already threads the ROW's fed_hlc onto the wire (v_op_hlc := row.fed_hlc) so both
-- peers materialise an identical ordering key; fed_ts now gets the SAME treatment:
--   • put on a stamp-regime row (fed_hlc IS NOT NULL — mig-214/314 stamp fed_ts and
--     fed_hlc atomically, so a row-carried fed_hlc marks a row-carried fed_ts) →
--     wire ts := the row's fed_ts. Author and receivers then persist the SAME value.
--   • put on a non-stamp table (e.g. harness_plan_parts — fed_ts=0/now baseline
--     convention, no stamp trigger, fed_hlc NULL) → now() as before. UNCHANGED.
--   • del → now() as before (a del is its own event causally-after the row's last
--     state; the OLD row's fed_ts would under-stamp it — same rationale as the
--     fresh hlc_now() for del op_hlc).
--
-- TWO capture functions carry the bug — both get the identical fix:
--   • harness_shared.capture_substrate_outbox()   (generic; live def = mig 359) —
--     plans, plan-parts, coord_*, hive_*, plan_item_assignments, bee_claim_specs.
--   • harness_shared.capture_work_items_outbox()  (work-items CDC; live def = mig
--     423) — the features + engineer-issues family, i.e. the EXACT path the
--     concurrent_lww scenario exercises (harness_features_consolidated's triggers
--     bind THIS function, not the generic one — mig 375).
--
-- No repair pass: pre-446 receiver rows hold the old wire ts; with fed_hlc present
-- the LWW guard orders by HLC, so a divergent fed_ts is bookkeeping-only and heals
-- on the row's next write.
--
-- Idempotent (CREATE OR REPLACE; trigger attachments unchanged — they bind by
-- function name). The runner provides the transaction — NO BEGIN/COMMIT here
-- (lint:migrations).

CREATE OR REPLACE FUNCTION harness_shared.capture_substrate_outbox()
  RETURNS trigger
  LANGUAGE plpgsql
AS $function$
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
      -- C1/P-009 (mig 359): canonicalize the federation routing key so a retired
      -- slug (papercup) self-heals into its current hive instead of accreting
      -- undrained dead-slug backlog. Pass-through for every non-retired slug.
      v_slug := harness_shared.canonical_harness_slug(v_row ->> 'harness_slug');

      -- D-001: the op's HLC ordering key, threaded onto the wire op by the drain.
      -- put → the row's fed_hlc (the BEFORE stamp trigger's value, identical to
      -- what the local row carries); del → a fresh hlc_now() (the del event's own
      -- causal clock; the OLD row's stale fed_hlc would under-stamp it). NULL on a
      -- table with no fed_hlc (append-only usage) → the drain's stampOpHlc
      -- generates a fallback.
      --
      -- mig 446: the wire ts gets the SAME one-clock treatment. A stamp-regime put
      -- (row carries fed_hlc ⇒ the BEFORE trigger stamped fed_ts with it,
      -- atomically) threads the ROW's fed_ts so author + receivers persist the
      -- SAME fed_ts — now() here is the txn-START clock and permanently diverges
      -- from the row's clock_timestamp() stamp. Non-stamp tables and dels keep
      -- now() (unchanged; a del is its own event).
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
    $function$;

-- ── capture_work_items_outbox — byte-identical to mig 423 except the wire ts gets
-- the same one-clock treatment as op_hlc (see header). This is the capture the
-- features/issues family actually rides (mig 375 bound harness_features_consolidated's
-- triggers to it), so it is the function behind the live concurrent_lww signature.
CREATE OR REPLACE FUNCTION harness_shared.capture_work_items_outbox() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      v_op     TEXT;
      v_rec    RECORD;
      v_ws     TEXT;
      v_slug   TEXT;
      v_scope  TEXT;
      v_tbl    TEXT;
      v_key    TEXT;
      v_row    JSONB;
      v_cnt    INT;
      v_op_hlc TEXT;
      v_ts     BIGINT;
    BEGIN
      IF TG_OP = 'DELETE' THEN v_op := 'del'; v_rec := OLD; ELSE v_op := 'put'; v_rec := NEW; END IF;

      -- Echo-loop guard: skip remote-origin writes (the projections' own applies).
      IF COALESCE(v_rec.origin, 'local') <> 'local' THEN RETURN v_rec; END IF;

      v_ws  := COALESCE(v_rec.workspace_id, '');
      v_key := v_rec.feature_id;

      IF v_rec.item_kind IN ('bug', 'change', 'task') THEN
        -- ── ISSUE family (mig 382). ─────────────────────────────────────────────────
        -- SU cross-workspace meta + unscoped rows have no single Hive to ride → local.
        IF v_ws = '' OR v_ws = '*' THEN RETURN v_rec; END IF;
        -- scope derived PURELY from harness_slug (D-003): operator:<ws> => operator;
        -- harness slug otherwise.
        v_scope := CASE WHEN v_rec.harness_slug LIKE 'operator:%' THEN 'operator'
                        ELSE 'harness:' || v_rec.harness_slug END;
        IF v_scope LIKE 'harness:%' THEN
          v_slug := substr(v_scope, 9);
        ELSIF v_scope = 'operator' THEN
          -- Operator/Queen shared backlog rides the workspace's single Hive home.
          -- 0 or >1 Hive homes → ambiguous → stay local (multi-Hive pointer is a follow).
          SELECT count(*)::int, min(home_slug) INTO v_cnt, v_slug
            FROM harness_shared.hives WHERE workspace_id = v_ws;
          IF v_cnt <> 1 THEN RETURN v_rec; END IF;
        ELSE
          RETURN v_rec;  -- unknown scope shape → local
        END IF;
        IF v_slug IS NULL OR v_slug = '' THEN RETURN v_rec; END IF;

        v_tbl := 'engineer_issues';
        v_row := jsonb_strip_nulls(jsonb_build_object(
          'workspace_id',      v_ws,
          'issue_id',          v_rec.feature_id,
          'scope',             v_scope,
          'title',             v_rec.title,
          'body',              COALESCE(v_rec.summary, ''),
          'severity',          COALESCE(v_rec.payload->'_ei'->>'severity', 'minor'),
          'source',            COALESCE(v_rec.payload->'_ei'->>'source', 'engineer'),
          'state',             v_rec.status,
          'assignee',          v_rec.taken_by,
          'assigned_by',       v_rec.payload->'_ei'->>'assigned_by',
          'assigned_at',       v_rec.taken_at,
          'found_during',      v_rec.payload->'_ei'->>'found_during',
          'linked_feature_id', v_rec.payload->'_ei'->>'linked_feature_id',
          'created_by',        v_rec.payload->'_ei'->>'created_by',
          'kind',              v_rec.item_kind,
          'payload',           (v_rec.payload - '_ei'),
          'origin',            v_rec.origin,
          'author_pubkey',     v_rec.author_pubkey,
          'fed_ts',            v_rec.fed_ts,
          'fed_hlc',           v_rec.fed_hlc,
          'signal_origin',     COALESCE(v_rec.payload->'_ei'->>'signal_origin', 'local'),
          'harness_slug',      v_slug));
      ELSE
        -- ── FEATURE family: original table_name + the (unchanged) hfc row shape. ──────
        v_tbl  := 'harness_features_consolidated';
        v_slug := v_rec.harness_slug;
        v_row  := to_jsonb(v_rec);
      END IF;

      -- D-001 (EI-79): the op's HLC ordering key, threaded onto the wire op by the drain
      -- so the remote peer materialises the SAME fed_hlc the author's local row carries
      -- (identical ordering key on BOTH peers → convergence). put → the row's fed_hlc
      -- (the mig-314 BEFORE-stamp value); del → a fresh hlc_now() (a del is a new event
      -- causally-after the row's last state; the OLD row's fed_hlc would under-stamp it).
      --
      -- mig 446: the wire ts gets the SAME one-clock treatment — a stamp-regime put
      -- (row carries fed_hlc ⇒ the BEFORE trigger stamped fed_ts atomically with it)
      -- threads the ROW's fed_ts so author + receivers persist the SAME fed_ts; now()
      -- here is the txn-START clock and permanently diverges from the row's
      -- clock_timestamp() stamp. Dels and unstamped rows keep now() (unchanged).
      IF v_op = 'del' THEN
        v_op_hlc := harness_shared.hlc_now();
        v_ts     := (extract(epoch from now()) * 1000)::bigint;
      ELSE
        v_op_hlc := v_rec.fed_hlc;
        v_ts     := CASE WHEN v_rec.fed_hlc IS NOT NULL
                         THEN COALESCE(v_rec.fed_ts, (extract(epoch from now()) * 1000)::bigint)
                         ELSE (extract(epoch from now()) * 1000)::bigint
                    END;
      END IF;

      INSERT INTO harness_shared.substrate_outbox
        (workspace_id, harness_slug, table_name, op, key, row, ts, op_hlc)
      VALUES
        (v_ws, v_slug, v_tbl, v_op, v_key, v_row, v_ts, v_op_hlc);

      PERFORM pg_notify('substrate_outbox', v_ws || '::' || COALESCE(v_slug, ''));
      RETURN v_rec;
    END;
    $$;
