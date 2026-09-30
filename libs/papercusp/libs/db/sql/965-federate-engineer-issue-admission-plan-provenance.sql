-- 965-federate-engineer-issue-admission-plan-provenance.sql
--
-- EI-21467654382027859 — the federated-column-completeness guard is red for
-- `engineer_issues`: 11 columns land NULL on every peer. Nine of them federate;
-- this migration is the PRODUCER half (the capture trigger), paired with the
-- mapper + projection halves in packages/operator-core/lib/sync/hyperbee/.
--
-- WHY THE CAPTURE MUST CHANGE TOO (the false-green this closes): the drift guard
-- asserts "table column → mapper key" and cannot see SQL. Adding the keys to
-- `toEngineerIssueValue` ALONE would turn that guard green while the mapper read
-- `undefined` for every one of them and nothing federated. The paired detector is
-- `issue-wire-capture-mapper-parity.test.ts` (WI-6327's bug class: the mapper reads
-- a key the capture never writes) — it is what fails if this file is forgotten.
--
-- The nine, and why each is peer content rather than machine-local:
--
--   admission / admitted_at / admitted_by (mig 944) — THE LOAD-BEARING ONE. The
--     claim gate is `admittedWhereSql` = `(admission IS DISTINCT FROM 'pending')`.
--     A born-pending item that federates WITHOUT the column arrives as NULL, and
--     `NULL IS DISTINCT FROM 'pending'` is TRUE — so an item deliberately held
--     invisible to claim/place became claimable on every peer, silently. Dropping
--     the column does not keep the gate local; it BYPASSES it. Unlike the
--     feature-family path there is no origin/quarantine leg on issue claims
--     (`autoPickableWhereSql` is not composed there), so this column is the only
--     admission gate issue-family work has. admitted_at/admitted_by are the
--     promoter's verdict provenance and travel with it, exactly as assigned_by /
--     assigned_at already do.
--
--   state_changed_at (mig 896) — the receiving half ALREADY EXISTS and has never
--     had a sender. `stamp_work_item_state_changed_at()` COALESCEs a supplied
--     value on INSERT ("a caller carrying an origin timestamp (for example, a
--     federated insert) wins") and on a status change preserves a distinct
--     supplied value as "an explicit origin timestamp". Without a sender each peer
--     stamps its own arrival instant, so a chronically-parked item reads as freshly
--     transitioned on every peer — precisely the newest-write bias mig 896 was
--     written to remove, reintroduced at the federation boundary.
--
--   tags (mig 815) — `work_items:tag` is its only writer and mirrors the topic into
--     what a `scheduler:set_claim_spec` filter on `tags` reads. Topics are NOT in
--     the 25-table federated set, so there is nothing on a peer to re-derive this
--     from: unfederated, tag-scoped claim specs simply never match federated work.
--
--   parent_id (mig 803) — the duplicate/child edge. It points into work_items,
--     which DOES federate, so the pointer resolves on every peer.
--
--   source_plan_slug / source_plan_item_ids (mig 815) — plan provenance, pointing
--     into harness_plans, which federates.
--
--   expected_cost_cents — caller-supplied at creation (work_items:create /
--     tasks:create), part of the item's definition rather than a local estimate.
--
-- DELIBERATELY NOT FEDERATED (recorded in NOT_FEDERATED in the drift guard):
--   goal_id — a pointer into harness_shared.goals, which does NOT federate. Same
--     ruling as harness_plans.goal_id earlier in this item: shipping it would land
--     an item on every peer claiming membership in a goal that peer never heard of.
--   redundancy — the per-item work-distribution fan-out factor, inert behind
--     PAPERCUSP_WORKITEM_REDUNDANCY. Same family as feature_order, whose
--     cross-machine posture is an open work-distribution question (REVIEW:
--     p2p-public-release-remaining-lanes-2026-07-16 P-201).
--
-- EXPAND-only: replaces one function body, adds keys to a jsonb payload that is
-- read defensively on the far side. No DDL, no destructive change. A peer running
-- older code simply ignores keys it does not know; `jsonb_strip_nulls` keeps a NULL
-- column off the wire exactly as it does today.

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

      v_ws := COALESCE(v_rec.workspace_id, '');

      IF v_rec.item_kind IN ('bug', 'change', 'task') THEN
        -- ISSUE family.  The routing slug may be the canonical/home harness,
        -- while the storage slug remains the actual work_items owner.  The
        -- latter is the only identity that can target a delete safely.
        IF v_ws = '' OR v_ws = '*' THEN RETURN v_rec; END IF;
        v_scope := CASE WHEN v_rec.harness_slug LIKE 'operator:%' THEN 'operator'
                        ELSE 'harness:' || v_rec.harness_slug END;
        IF v_scope LIKE 'harness:%' THEN
          v_slug := harness_shared.canonical_harness_slug(substr(v_scope, 9));
        ELSIF v_scope = 'operator' THEN
          SELECT count(*)::int, min(pot_home_slug) INTO v_cnt, v_slug
            FROM harness_shared.pots WHERE workspace_id = v_ws;
          IF v_cnt <> 1 THEN
            PERFORM pg_notify('substrate_outbox_gap', v_ws || '::operator::' || v_cnt::text);
            RETURN v_rec;
          END IF;
        ELSE
          RETURN v_rec;
        END IF;
        IF v_slug IS NULL OR v_slug = '' THEN RETURN v_rec; END IF;

        v_tbl := 'engineer_issues';
        v_key := v_rec.harness_slug || '/' || v_rec.feature_id;
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
          'terminal_owner',           v_rec.terminal_owner,
          'terminal_completion_ref',  v_rec.terminal_completion_ref,
          'authority',         v_rec.authority,
          'closed_ts',         v_rec.closed_ts,
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
          -- EI-21467654382027859 — the nine columns above were reaching every peer
          -- NULL. See this file's header for the per-column reasoning; the two
          -- deliberate omissions (goal_id, redundancy) are recorded in the drift
          -- guard's NOT_FEDERATED, not here.
          'admission',            v_rec.admission,
          'admitted_at',          v_rec.admitted_at,
          'admitted_by',          v_rec.admitted_by,
          'state_changed_at',     v_rec.state_changed_at,
          'tags',                 v_rec.tags,
          'parent_id',            v_rec.parent_id,
          'source_plan_slug',     v_rec.source_plan_slug,
          'source_plan_item_ids', v_rec.source_plan_item_ids,
          'expected_cost_cents',  v_rec.expected_cost_cents,
          'harness_slug',      v_slug,
          'storage_harness_slug', v_rec.harness_slug));
      ELSE
        -- FEATURE family keeps its established per-log feature_id key.
        v_tbl  := 'harness_features_consolidated';
        v_slug := harness_shared.canonical_harness_slug(v_rec.harness_slug);
        v_key  := v_rec.feature_id;
        v_row  := to_jsonb(v_rec);
      END IF;

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
