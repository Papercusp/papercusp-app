-- 452-work-items-outbox-canonical-slug.sql
--
-- WI-900 (M1) — federation Lane D audit finding: `capture_work_items_outbox()`
-- derives its routing `v_slug` straight from the row's raw `harness_slug` (feature
-- family) / `v_scope` (issue family) and never calls
-- `harness_shared.canonical_harness_slug()` — unlike its sibling
-- `capture_substrate_outbox()` (mig 359), which DOES wrap its `v_slug` in
-- `canonical_harness_slug(...)` for exactly this reason (C1/P-009: self-heal a
-- retired-slug routing key into its current hive instead of accreting undrained
-- dead-slug backlog).
--
-- ## The bug
-- A work_item/engineer_issue written under a RETIRED slug (a harness that was
-- renamed, e.g. the historical papercup → papercusp rename) enqueues a
-- substrate_outbox row keyed to the OLD slug. No booted drain owns that slug, so
-- the row sits undrained until the 48h backstop GC (substrate-outbox-backstop-gc.ts)
-- drops it — the op never federates. Impact is LOW today (the papercup→papercusp
-- rename is already complete and canonical_harness_slug's mapping table already
-- covers it), but the self-heal this function is SUPPOSED to provide (mirroring
-- capture_substrate_outbox) is silently absent for any FUTURE rename.
--
-- ## The fix
-- CREATE OR REPLACE `capture_work_items_outbox()` — byte-identical to mig 446
-- except both `v_slug` derivations are wrapped in
-- `harness_shared.canonical_harness_slug(...)`:
--   • issue family:   v_slug := canonical_harness_slug(substr(v_scope, 9))
--   • feature family: v_slug := canonical_harness_slug(v_rec.harness_slug)
-- The issue-family operator-scope branch's `v_slug` (from `hives.home_slug`, a
-- table column that is already canonical by construction) is left unwrapped —
-- canonicalizing it would be a harmless no-op, but touching it isn't part of this
-- diagnosed gap and keeps the diff minimal.
--
-- Idempotent (CREATE OR REPLACE; the trigger attachments from mig 375/382 are
-- unchanged — they bind to this function name). `canonical_harness_slug` exists
-- (mig 359). The runner provides the transaction — NO BEGIN/COMMIT here
-- (lint:migrations).

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
