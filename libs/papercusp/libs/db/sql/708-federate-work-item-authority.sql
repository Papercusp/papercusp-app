-- 708: federate work_items.authority (mig 677) + closed_ts (mig 698) —
-- fixes EI-18785839681430807 and a second, adjacent federation gap this same
-- pass surfaced (`federated-column-completeness.integration.test.ts` was ALSO
-- red on closed_ts for both families once the authority failures cleared).
--
-- PART 1 — authority (mig 677, agent-protocol-authority-semantics-2026-07-26
-- P-003) added `work_items.authority`
-- (proposed|validated|committed|pending_human|invalid, NULL = no judgement)
-- and exposed it on both family views (harness_features_consolidated,
-- engineer_issues), but never wired it into federation:
--
--   - the ISSUE family's outbox capture hand-builds its wire row with
--     jsonb_build_object(...) (capture_work_items_outbox below) and never
--     listed `authority` — so an issue-family op never carried it on the wire
--     at all;
--   - `toFeatureValue`/`toEngineerIssueValue` (feature-issue-op-keys.ts) never
--     read the key into the typed row, so even the FEATURE family (whose
--     capture uses `to_jsonb(v_rec)` and therefore puts `authority` on the
--     wire "for free") dropped it at the mapper;
--   - neither projection's INSERT/DO UPDATE SET carried it.
--
-- Net effect: every peer sees authority = NULL on every federated work item,
-- i.e. every remote close reads as a pre-authority legacy close regardless of
-- its real authority judgement — `federated-column-completeness.integration.
-- test.ts` has been RED for both families since 677 landed (~10h at filing).
--
-- DESIGN DECISION (recorded as agent-protocol-authority-semantics-2026-07-26
-- D-035 — see that plan for the full rationale): `authority` is federated
-- with EXACTLY the same treatment as `terminal_owner`/`terminal_completion_ref`
-- /`terminal_reason` (the EI-16756 precedent in both projections' writeToPg):
--   1. It is a plain federated column — INSERT + ON CONFLICT DO UPDATE SET
--      EXCLUDED.authority, same as its terminal_* siblings.
--   2. It JOINS the fed_apply_wins content digest, for the identical reason
--      terminal_reason did: two racing completions of the same item can
--      converge to an equal status/taken_by/terminal_owner while carrying a
--      DIFFERENT authority (e.g. one closer's evidence-backed `committed` vs
--      a racing `proposed`) — omitting it from the digest would let the
--      "equal digest ⇒ no-op" tie branch silently let a worse-evidenced
--      racing peer's authority win.
--   3. No special remote-vs-local override rule: the existing LWW
--      (fed_apply_wins / fed_order_key) tie-break already decides the winning
--      ROW, and authority just rides along as a column of that row — same as
--      every other content column. `proposed` (meaning "still owned by its
--      closer") federates as-is, exactly like terminal_owner already does for
--      a non-committed item; there is no reason to collapse it to NULL.
--
-- PART 2 — closed_ts (mig 698, EI-18820653360383242) is a BEFORE-trigger-
-- maintained column (`stamp_work_item_closed_ts`) recording epoch-ms of when
-- an item entered its CURRENT terminal status. Its own trigger body is
-- EXPLICIT that federation must supply it: "COALESCE so a federated write
-- carrying the origin's real close time wins over local now()". Without this
-- fix the mapper never carried it, so EVERY federated write arrived with
-- closed_ts unset, the BEFORE trigger's `COALESCE(NULL, now())` stamped the
-- RECEIVING peer's local now() as the close time on first-close, and — worse —
-- once a row federated once (touching status via the FEATURE family's
-- to_jsonb whole-row carry is fine, but the ISSUE family's jsonb_build_object
-- never listed it at all) a genuine close time was overwritten by receipt
-- time on every peer. Exactly the wrong-timestamp bug 698 exists to eliminate,
-- reintroduced via the one path 698's own author didn't have wired yet.
--
-- Treatment: a PLAIN federated column, same as `created_ts` (immutable
-- set-once-per-transition metadata) — carried in the mapper + INSERT + DO
-- UPDATE SET, but NOT added to the EI-16756 fed_apply_wins content digest.
-- Unlike authority/terminal_owner/terminal_reason (which are independently
-- contentious values a tie-break must not silently clobber), closed_ts's
-- correctness is already enforced by its OWN BEFORE-trigger idempotency
-- (frozen across terminal->terminal writes, COALESCE on first close) — the
-- digest's job is only to stop a WORSE write from winning a tie, and
-- closed_ts has no "better/worse" axis of its own to protect that way.
--
-- Idempotent: CREATE OR REPLACE of the trigger FUNCTION only. No DDL, no data
-- change. Body is mig 688's verbatim, with `authority` + `closed_ts` added to
-- the issue-family jsonb_build_object.

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
          -- mig 708 (PART 2, EI-18820653360383242): the trigger-maintained close
          -- time. See this migration's PART 2 header for why the trigger itself
          -- requires this to federate.
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
