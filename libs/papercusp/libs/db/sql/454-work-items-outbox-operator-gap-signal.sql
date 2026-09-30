-- 454-work-items-outbox-operator-gap-signal.sql
--
-- WI-1633 (WI-900 M2 follow-up) — `capture_work_items_outbox()`'s operator-scope
-- branch silently drops (no outbox row, no signal) an operator-scoped issue write
-- when the write's workspace has 0 or >1 Hive homes:
--
--   ELSIF v_scope = 'operator' THEN
--     SELECT count(*)::int, min(home_slug) INTO v_cnt, v_slug
--       FROM harness_shared.hives WHERE workspace_id = v_ws;
--     IF v_cnt <> 1 THEN RETURN v_rec; END IF;
--
-- This "stay local when ambiguous" behavior is BY DESIGN for the 0/1-hive shape
-- (there is genuinely nowhere — or exactly one place — to route it), but a
-- workspace with >1 Hive homes has REAL federation targets that the write simply
-- never reaches, and because no `substrate_outbox` row is ever inserted, the
-- existing drain-reconcile stall detector (plan-drain-reconcile.ts) — which only
-- ever sees rows that DID make it into the outbox — has structurally no way to
-- notice the drop. WI-900's own audit named two acceptable fixes for this: a full
-- multi-Hive routing/fan-out redesign (a genuine "which hive(s) get it" design
-- decision, deliberately left as a follow), or an explicit observability signal so
-- the drop stops being silent. This migration ships the latter — the narrower,
-- immediately-safe half — mirroring the SAME `pg_notify` idiom this function
-- already uses on line ~145 for successful captures (channel 'substrate_outbox'),
-- just on a distinct channel so a future listener can page/alert on it without
-- polling substrate_outbox for an absence.
--
-- 'substrate_outbox_gap' payload: '<workspace_id>::operator::<hive_count>' — the
-- hive count lets a listener distinguish the two ways this signal can fire
-- (0 = no Hive to route to at all; >1 = genuinely ambiguous, a real drop) without
-- a second round-trip query. Fires on BOTH the 0-home and the >1-home shape (the
-- ticket names both) — a 0-home workspace legitimately has nothing to route to,
-- but that is still worth a (rarer, expected-low-volume) signal so an operator
-- workspace that was SUPPOSED to have a Hive and doesn't (e.g. mid-dissolution,
-- or a home never provisioned) is no longer invisible either.
--
-- Multi-Hive fan-out routing itself remains the deliberate follow-up (still
-- "local" for now) — this migration does not change what gets captured, only
-- whether the miss is observable.
--
-- Byte-identical to mig 452's `capture_work_items_outbox` except for the one
-- added `PERFORM pg_notify(...)` call in the operator-scope branch.
-- Idempotent (CREATE OR REPLACE; trigger attachments from mig 375/382 unchanged).
-- The runner provides the transaction — NO BEGIN/COMMIT here (lint:migrations).

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
          -- mig 452 (WI-900 M1): canonicalize the routing slug so a retired-slug
          -- write self-heals into its current hive instead of orphaning (mirrors
          -- capture_substrate_outbox, mig 359).
          v_slug := harness_shared.canonical_harness_slug(substr(v_scope, 9));
        ELSIF v_scope = 'operator' THEN
          -- Operator/Queen shared backlog rides the workspace's single Hive home.
          -- 0 or >1 Hive homes → ambiguous → stay local (multi-Hive pointer is a follow).
          SELECT count(*)::int, min(home_slug) INTO v_cnt, v_slug
            FROM harness_shared.hives WHERE workspace_id = v_ws;
          IF v_cnt <> 1 THEN
            -- mig 454 (WI-1633 / WI-900 M2): make the drop OBSERVABLE — no outbox
            -- row is inserted for this op, so plan-drain-reconcile's stall detector
            -- (which only sees rows that DID reach substrate_outbox) can never
            -- flag it. A future listener/alert can act on this without polling
            -- for an absence.
            PERFORM pg_notify('substrate_outbox_gap', v_ws || '::operator::' || v_cnt::text);
            RETURN v_rec;
          END IF;
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
        -- mig 452 (WI-900 M1): canonicalize — same rationale as the issue family above.
        v_slug := harness_shared.canonical_harness_slug(v_rec.harness_slug);
        v_row  := to_jsonb(v_rec);
      END IF;

      -- D-001 (EI-79): the op's HLC ordering key, threaded onto the wire op by the drain
      -- so the remote peer's projection materialises the SAME fed_hlc the author's local
      -- row carries (identical ordering key on BOTH peers → convergence). put → the row's
      -- fed_hlc (the mig-314 BEFORE-stamp value); del → a fresh hlc_now() (a del is a new
      -- event causally-after the row's last state; the OLD row's fed_hlc would
      -- under-stamp it).
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
