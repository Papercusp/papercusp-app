-- 559-fix-capture-work-items-outbox-pots-rename.sql
--
-- WI-3800-class live outage: migration 557 (cup-lexicon-full-rename-2026-07-09)
-- renamed harness_shared.hives -> harness_shared.pots (+ column home_slug ->
-- pot_home_slug) but missed a consumer baked into the DB itself: the
-- capture_work_items_outbox() trigger function (latest def: mig 454) hardcodes
--
--   SELECT count(*)::int, min(home_slug) INTO v_cnt, v_slug
--     FROM harness_shared.hives WHERE workspace_id = v_ws;
--
-- in its operator-scope branch. That trigger is ATTACHED to harness_shared.work_items
-- (capture_work_items_outbox_ins_del_trg / capture_work_items_feature_upd_trg /
-- capture_work_items_issue_upd_trg) and fires on every INSERT/UPDATE/DELETE — so
-- since 557 landed, ANY write to an operator-scoped issue-family row (harness_slug
-- LIKE 'operator:%') throws `relation "harness_shared.hives" does not exist` and
-- the write fails outright. Confirmed live via scheduler:get_next (claims a
-- work_items row -> fires this trigger -> handler_error) — a fleet-wide breakage,
-- not a test-only gap (EI-9357).
--
-- Fix: byte-identical to mig 454's capture_work_items_outbox() except the one
-- renamed table + column in the operator-scope branch. capture_engineer_issues_outbox
-- (mig 197, same underlying bug) is NOT attached to any live trigger (superseded by
-- this function per mig 382 operator-issue-scope-removal) so it needs no fix.
-- Idempotent (CREATE OR REPLACE; trigger attachments from mig 375/382 unchanged).
-- The runner provides the transaction -- NO BEGIN/COMMIT here (lint:migrations).

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
        -- SU cross-workspace meta + unscoped rows have no single Pot to ride → local.
        IF v_ws = '' OR v_ws = '*' THEN RETURN v_rec; END IF;
        -- scope derived PURELY from harness_slug (D-003): operator:<ws> => operator;
        -- harness slug otherwise.
        v_scope := CASE WHEN v_rec.harness_slug LIKE 'operator:%' THEN 'operator'
                        ELSE 'harness:' || v_rec.harness_slug END;
        IF v_scope LIKE 'harness:%' THEN
          -- mig 452 (WI-900 M1): canonicalize the routing slug so a retired-slug
          -- write self-heals into its current pot instead of orphaning (mirrors
          -- capture_substrate_outbox, mig 359).
          v_slug := harness_shared.canonical_harness_slug(substr(v_scope, 9));
        ELSIF v_scope = 'operator' THEN
          -- Operator/Queen shared backlog rides the workspace's single Pot home.
          -- 0 or >1 Pot homes → ambiguous → stay local (multi-Pot pointer is a follow).
          -- mig 559: harness_shared.hives/home_slug renamed to pots/pot_home_slug (mig 557).
          SELECT count(*)::int, min(pot_home_slug) INTO v_cnt, v_slug
            FROM harness_shared.pots WHERE workspace_id = v_ws;
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
