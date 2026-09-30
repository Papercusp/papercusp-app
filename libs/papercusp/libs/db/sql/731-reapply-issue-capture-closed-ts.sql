-- 731: re-apply capture_work_items_outbox WITH closed_ts — repairs mig 708 PART 2,
-- which was authored but NEVER EXECUTED on any DB that applied 708 early.
-- Fixes EI-19365742982915607. Root cause fact: mig-708-closed-ts-unapplied-sha-drift.
--
-- WHAT HAPPENED (proven, not inferred)
-- Migration 708 was applied here at 2026-08-01T19:15:49.533Z. Its recorded
-- harness_shared.schema_migrations.sha256 is
--   038464dc6b159e19b2fa246af428ef8da416747235116c321cf94b74bcd6d5b6
-- which is byte-identical to git blob 2e01fb05 of 708 — a version containing
-- ZERO occurrences of `closed_ts`. The file was then edited and committed as
-- 3eaca0ec at 19:24:39Z (9 occurrences of `closed_ts`, sha d26b5ad741fe…),
-- adding the PART 2 hunk. Because 708 was ALREADY recorded in
-- schema_migrations, the runner never re-ran it — so PART 2 has never executed
-- on this database and never would have. Verified live before writing this:
--   SELECT pg_get_functiondef(oid) LIKE '%closed_ts%' FROM pg_proc
--    WHERE proname='capture_work_items_outbox';   -- false
--   ... LIKE '%terminal_owner%'                   -- true  (708 PART 1 DID land)
-- i.e. the SAME migration half-landed: PART 1 executed, PART 2 did not.
--
-- WHY THE EXISTING GUARD MISSED IT
-- `federated-column-completeness.integration.test.ts` applies the sql/ dir to a
-- FRESH testcontainer, so it validates the FILES and passes green — it can
-- never observe a live DB whose function predates an edit to those files.
-- Nothing compared schema_migrations.sha256 against the bytes on disk; that
-- column was written at INSERT and never read back. A drift detector closing
-- that hole ships alongside this migration (migration-drift.ts contentDrift).
--
-- BLAST RADIUS WHILE UNAPPLIED
-- The issue family's jsonb_build_object never emitted closed_ts, so every
-- federated issue write arrived with it unset and the receiving peer's BEFORE
-- trigger (`stamp_work_item_closed_ts`, mig 698) stamped its own local now()
-- via COALESCE(NULL, now()) — replacing the origin's real close time with
-- RECEIPT time on every peer. That is precisely the wrong-timestamp bug mig 698
-- exists to eliminate, reintroduced through the one path 698 had not wired.
--
-- TREATMENT
-- Body below is mig 708's post-edit body VERBATIM (its only functional
-- difference from the version that actually ran is the `'closed_ts',
-- v_rec.closed_ts,` line at the issue-family jsonb_build_object). Idempotent —
-- CREATE OR REPLACE only, no DDL on tables, safe to re-run and safe on a DB
-- that applied the corrected 708 (there it is a no-op rewrite of an identical
-- definition). closed_ts stays a PLAIN federated column, NOT part of the
-- EI-16756 fed_apply_wins content digest, exactly as 708 PART 2 specified:
-- its correctness is already enforced by its own BEFORE-trigger idempotency.

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
          -- WI-6327: the completion-integrity pair (WI-1403 / EI-5269). Federated so a
          -- peer sees WHO reached the terminal state and the evidence — until now the
          -- mapper read these keys and the capture never wrote them, so they landed
          -- NULL on every peer.
          'terminal_owner',           v_rec.terminal_owner,
          'terminal_completion_ref',  v_rec.terminal_completion_ref,
          -- mig 708 / EI-18785839681430807: the AUTHORITY axis (mig 677) — same
          -- treatment as the terminal_* pair above. See this migration's header +
          -- agent-protocol-authority-semantics-2026-07-26 D-035 for why it also
          -- joins the fed_apply_wins content digest in both projections.
          'authority',         v_rec.authority,
          -- mig 708 (PART 2, EI-18820653360383242) — RE-APPLIED BY MIG 731: the
          -- trigger-maintained close time. See 708's PART 2 header for why the
          -- trigger itself requires this to federate, and 731's header for why
          -- 708's own copy of this line never executed.
          'closed_ts',         v_rec.closed_ts,
          -- WI-6327: the row's REAL creation instant, in the same unit as the
          -- work_items.created_ts column the receiver's EI-13285 guard compares
          -- against. Absent here, the drain fabricated new Date().toISOString() and
          -- the guard read every op as an id collision. Its presence is also the
          -- receiver's "authoritative created-at" discriminator vs pre-688 ops.
          'created_ts',        v_rec.created_ts,
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
