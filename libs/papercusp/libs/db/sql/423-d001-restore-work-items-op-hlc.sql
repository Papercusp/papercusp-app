-- 423-d001-restore-work-items-op-hlc.sql
--
-- D-001 (EI-79 / shared-pot-release-testing Brief J) REGRESSION FIX: restore the
-- `op_hlc` threading the work-items CDC capture lost in the work-items unification.
--
-- ## The bug (found by federation-concurrent-writes-sidecar.repro.test.ts)
-- mig 314 made the federated LWW ordering key end-to-end: a LOCAL write's PG row
-- carries `fed_hlc` (the `stamp_local_federated_write` BEFORE trigger), the CDC
-- capture stamps that SAME hlc onto the wire op (`substrate_outbox.op_hlc`), and the
-- drain threads it to `op.hlc` so the remote peer's projection materialises an
-- IDENTICAL `fed_hlc` → both peers order by the SAME key → convergence. mig 359's
-- generic `capture_substrate_outbox()` does exactly this (op_hlc = row.fed_hlc on a
-- put, hlc_now() on a del).
--
-- The work-items unification then REPLACED the generic capture on the features/issues
-- family with `capture_work_items_outbox()` (mig 375, refined by mig 382) — and that
-- function's `INSERT INTO substrate_outbox (...)` OMITS `op_hlc`. So for EVERY federated
-- feature / engineer-issue the wire op carries NO PG-stamped hlc; the drain falls back to
-- `stampOpHlc` (a fresh hlc seeded from the op's wall `ts`), which is NOT the author's
-- `fed_hlc`. Two peers that author the SAME key concurrently then CONVERGE ON VALUE but
-- their stored `fed_hlc` ORDERING KEYS DIVERGE (the receiver stores the op's wall-ts hlc,
-- the author keeps its PG-stamped fed_hlc) — so a SUBSEQUENT concurrent write can resolve
-- differently on each peer (the D-001 split-brain, reintroduced for the most-federated
-- table family). Observed divergence: author fed_hlc `…802:00000` vs receiver-stored
-- `…799:00000` for the same converged row.
--
-- ## The fix
-- CREATE OR REPLACE `capture_work_items_outbox()` — byte-identical to mig 382 except it
-- computes `v_op_hlc` (put → the work_items row's `fed_hlc`, set by the mig-314 BEFORE
-- stamp trigger; del → a fresh `hlc_now()`, since a del is a new event causally-after the
-- row's last state) and writes it to `substrate_outbox.op_hlc`. This restores the D-001
-- invariant `op.hlc == author.fed_hlc` for BOTH the feature and the engineer-issue family
-- (both ride the work_items row's fed_hlc), exactly as mig 359's generic capture does for
-- the other federated tables.
--
-- Idempotent (CREATE OR REPLACE; the trigger attachments from mig 375/382 are unchanged —
-- they bind to this function name, so replacing the body is sufficient). hlc_now() exists
-- (mig 314). The runner provides the transaction — NO BEGIN/COMMIT here (lint:migrations).

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
      -- Both work-item families ride the work_items row's fed_hlc. This threading was
      -- dropped when capture_work_items_outbox replaced the generic capture (mig 375/382);
      -- restoring it here mirrors mig 359's generic capture_substrate_outbox().
      IF v_op = 'del' THEN
        v_op_hlc := harness_shared.hlc_now();
      ELSE
        v_op_hlc := v_rec.fed_hlc;
      END IF;

      INSERT INTO harness_shared.substrate_outbox
        (workspace_id, harness_slug, table_name, op, key, row, ts, op_hlc)
      VALUES
        (v_ws, v_slug, v_tbl, v_op, v_key, v_row, (extract(epoch from now()) * 1000)::bigint, v_op_hlc);

      PERFORM pg_notify('substrate_outbox', v_ws || '::' || COALESCE(v_slug, ''));
      RETURN v_rec;
    END;
    $$;
