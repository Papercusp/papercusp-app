-- 640 · work-item-status-full-unify (P-006) — teach the readiness / terminal-detection
-- layer + the federation CDC about the UNIFIED terminals (done | dropped), so the P-003
-- writer-flip can store them without breaking blocker-readiness, dependent-sync, or
-- (on the wire) the passed/resolved/deprecated/closed nuance.
--
-- Runs AFTER 638 (which backfilled work_items.status → unified enum + added the
-- terminal_reason column). EVERY change here is a TRANSITIONAL SUPERSET (legacy ∪
-- unified): it recognizes BOTH the legacy per-family terminals (passed/deprecated,
-- resolved/closed) AND the unified done/dropped, so it is correct on EITHER side of the
-- writer-flip. The cleanup pass narrows these to ('done','dropped') once no writer emits
-- the legacy spellings.
--
-- terminal_reason is written by the P-003 writer via a DIRECT work_items base-table
-- UPDATE (mirroring the reopen-clear path) and read on the wire via v_rec.terminal_reason
-- in the CDC below — neither goes through the family views, so this migration does NOT
-- recreate them. Re-exposing terminal_reason through engineer_issues /
-- harness_features_consolidated for READERS (UI chips, *:list) is deferred to P-007, where
-- the view SELECT must be rebuilt from the MIGRATION-CHAIN column order — NOT the live
-- pg_get_viewdef, which has DRIFTED (live has `wave, verified_done_at_remote_ts`; the chain
-- has them swapped), so a CREATE OR REPLACE VIEW copied from live fails on the fresh chain.
--
-- This ALSO fixes a LATENT bug 638 introduced: 638 backfilled with USER triggers DISABLED,
-- so the maintained work_item_blocked sidecar never re-ran, AND the readiness predicates
-- still treated a backfilled `done`/`dropped` blocker as non-terminal (still blocking).
-- Result: dependents of the feature blockers 638 remapped passed/deprecated → done/dropped
-- were stranded blocked. Steps 1 + 5 clear that.
--
-- Idempotent: CREATE OR REPLACE (fn / views) + DROP TRIGGER IF EXISTS / CREATE TRIGGER +
-- a set-based recompute. The boot runner (db-boot-migrate.ts) wraps the whole file in one
-- `BEGIN; … COMMIT;`, so the trigger drop+recreate is ATOMIC — no window without the
-- trigger, and the whole migration rolls back as a unit on any error (EI-10 caution).

-- ── 1. Blocker-readiness fn: a blocker is SATISFIED iff TERMINAL. Widen both family
--       terminal sets to include the unified done|dropped. The maintained
--       work_item_blocked sidecar is materialized from THIS predicate (via the wir_
--       triggers), and claimFloorsWhereSql's SCHEDULER_MAINTAINED_READY leg reads it. ──
CREATE OR REPLACE FUNCTION harness_shared.work_item_is_blocked(p_harness text, p_feature text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
    SELECT EXISTS (
        SELECT 1
          FROM harness_shared.work_item_deps d
         WHERE d.workspace_id = 'default'
           AND d.dep_type = 'blocks'
           AND d.blocked_ref = p_harness || '#' || p_feature
           AND (
             EXISTS (
               SELECT 1 FROM harness_shared.work_items bf
                WHERE bf.item_kind <> ALL (ARRAY['bug','change','task'])
                  AND (bf.harness_slug || '#' || bf.feature_id) = d.blocker_ref
                  AND bf.status NOT IN ('passed','deprecated','done','dropped')
             )
             OR EXISTS (
               SELECT 1 FROM harness_shared.work_items bi
                WHERE bi.item_kind = ANY (ARRAY['bug','change','task'])
                  AND bi.workspace_id = 'default'
                  AND bi.feature_id = d.blocker_ref
                  AND bi.status NOT IN ('resolved','closed','done','dropped')
             )
           )
    );
$function$;

-- ── 2. Dependent-readiness sync trigger: fire when a status crosses the TERMINAL
--       boundary (so a dependent's blocked sidecar is re-synced). The terminal-ness test
--       lives in the trigger's WHEN clause — widen its array to include done|dropped. A
--       trigger's WHEN cannot be ALTERed, so DROP + CREATE (atomic in the wrapping txn).
--       The function body is unchanged (it carries no status literals). ──
DROP TRIGGER IF EXISTS wir_status_sync_dependents_trg ON harness_shared.work_items;
CREATE TRIGGER wir_status_sync_dependents_trg
  AFTER UPDATE OF status ON harness_shared.work_items
  FOR EACH ROW
  WHEN (
    (OLD.status = ANY (ARRAY['passed','deprecated','resolved','closed','done','dropped']))
    IS DISTINCT FROM
    (NEW.status = ANY (ARRAY['passed','deprecated','resolved','closed','done','dropped']))
  )
  EXECUTE FUNCTION harness_shared.wir_status_sync_dependents();

-- ── 3. Federation CDC: the issue-family outbox row is built column-by-column via
--       jsonb_build_object, so it must carry terminal_reason explicitly for the
--       passed/resolved/deprecated/closed nuance to survive the wire (owner hard-req
--       D-001). The FEATURE branch uses to_jsonb(v_rec) which already includes the new
--       column, so only the issue branch needs the addition. `status` is copied verbatim
--       (v_rec.status), so the unified enum already federates once the writer stores it. ──
CREATE OR REPLACE FUNCTION harness_shared.capture_work_items_outbox()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
          'terminal_reason',   v_rec.terminal_reason,
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
    $function$;

-- ── 4. One-time recompute of the maintained work_item_blocked sidecar (feature family
--       only — the wir_ sync loop targets feature dependents). 638 backfilled with USER
--       triggers disabled, so this sidecar is stale: entries whose blocker is now
--       done/dropped must be dropped (the latent-bug fix), and any genuinely-blocked
--       feature re-asserted. Uses the widened work_item_is_blocked replaced in step 1
--       (visible in this same txn). ──
DELETE FROM harness_shared.work_item_blocked wb
 WHERE NOT harness_shared.work_item_is_blocked(wb.harness_slug, wb.feature_id);

INSERT INTO harness_shared.work_item_blocked (workspace_id, harness_slug, feature_id, updated_at)
SELECT f.workspace_id, f.harness_slug, f.feature_id, now()
  FROM harness_shared.work_items f
 WHERE f.item_kind <> ALL (ARRAY['bug','change','task'])
   AND harness_shared.work_item_is_blocked(f.harness_slug, f.feature_id)
ON CONFLICT (workspace_id, harness_slug, feature_id) DO NOTHING;
