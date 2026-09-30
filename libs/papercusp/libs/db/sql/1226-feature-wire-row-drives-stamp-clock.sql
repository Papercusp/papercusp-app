-- 1226-feature-wire-row-drives-stamp-clock.sql
--
-- WI-10002882 (follow-up that plan p2p-join-catchup-speed-2026-09-23 D-004(2) left out
-- of scope; the issue-family half is WI-10002875 / mig 1208). A write to a LOCAL-ONLY
-- work_items column must not mint a new FEATURE-family wire version either.
--
-- WHAT WAS WRONG
--   Mig 1208 made stamp_local_federated_write decide "content changed" for an
--   ISSUE-family row from the engineer-issues wire row. A FEATURE-family row still fell
--   through to the generic full-row diff: to_jsonb(NEW) vs to_jsonb(OLD) outside a small
--   bookkeeping mask. That compares 33 columns that the receiving projection
--   (packages/operator-core/lib/sync/hyperbee/projections/harness-features.ts writeToPg)
--   never applies: the embedding set, verifier_*, audit_*, rank_*, schedule*, run_seq,
--   requeue_count, last_released_*, worked_by_history, working_users,
--   state_changed_at, first_claimed_at, condition_key, directive_ref, ...
--
--   So a local-only write re-stamped fed_ts/fed_hlc with a fresh local HLC, flipped the
--   row to origin='local', and capture_work_items_feature_upd_trg (which fires on ANY
--   column difference) shipped it. A peer applied it — the apply moves the clock, so
--   the peer re-stamps nothing itself — but any local-only writer on the peer that
--   reacts to the applied row then re-stamps it and ships it back. Two such writers
--   make a feedback loop with no convergence point.
--
-- MEASURED
--   * tower substrate_outbox 2026-09-26 (harness_features_consolidated, 886 puts in
--     retention): of the repeat versions, 98 differed from their predecessor only in
--     clock/bookkeeping keys, 15 only in the embedding set and 15 only in condition_key
--     — every one a version the fix removes.
--   * live-federation cert of f6bf2977 (bank 051534-concurrent_lww, WI-10003230): after
--     a concurrent same-key write on F-CONTESTED both frames held the SAME value
--     (B-side-write|done) while its fed_hlc kept advancing with ALTERNATING node ids,
--     ~600 appended ops in 5 min, PHASE 2 never converged. Chronic since 2026-09-14.
--
-- THE FIX — one projection, used by both triggers (the mig 1208 shape)
--   harness_shared.feature_wire_row() is the single definition of which feature-row
--   columns a peer APPLIES: exactly writeToPg's INSERT column list, pinned by
--   issue-wire-capture-mapper-parity.test.ts. For a feature-family row:
--   * the stamp compares that projection of OLD and NEW with the clock/provenance keys
--     and the ts/updated_ts bookkeeping keys removed (the same keys the generic mask
--     already treats as non-content), so the clock moves exactly when a column a peer
--     applies moves;
--   * the capture skips an UPDATE whose projection (minus ts/updated_ts) is identical
--     to OLD's. Such an op carries an unchanged clock, and a peer's LWW apply drops it.
--
--   The shipped bytes are UNCHANGED (to_jsonb of the whole row); narrowing the payload
--   to feature_wire_row() is a separate wire-compat decision (older peers decode the
--   full row), deliberately not made here.
--
--   Consequence for the WI-6250 signed-remote guard: a local-only write (for example the
--   embedding backfill) on a publisher-signed REMOTE feature row is no longer "content",
--   so it no longer raises — the same outcome mig 1208 gave issue-family rows.
--
--   Unchanged: the issue family (still engineer_issue_wire_row), every other table using
--   stamp_local_federated_write, a row whose item_kind crosses families (generic diff),
--   the explicit clock-move branch (a projection apply / repair), the INSERT branch.
--
-- NOT destructive DDL (CREATE OR REPLACE FUNCTION + one new function): no FORWARD-COMPAT
-- line is required. The deployed release reads no new column and no changed contract;
-- this strictly removes redundant outbox rows.
--
-- The capture and stamp bodies below are the live definitions (pg_get_functiondef on
-- 2026-09-26; both last defined by mig 1208) with ONLY the changes described above.

CREATE OR REPLACE FUNCTION harness_shared.feature_wire_row(r harness_shared.work_items)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
AS $function$
  -- Two halves: jsonb_build_object takes at most 100 arguments (FUNC_MAX_ARGS).
  -- Nulls are KEPT (no jsonb_strip_nulls): a column moving to NULL is a content change.
  SELECT jsonb_build_object(
    'workspace_id',            r.workspace_id,
    'harness_slug',            r.harness_slug,
    'feature_id',              r.feature_id,
    'title',                   r.title,
    'summary',                 r.summary,
    'status',                  r.status,
    'attempts',                r.attempts,
    'claims',                  r.claims,
    'notes',                   r.notes,
    'metadata',                r.metadata,
    'kind',                    r.kind,
    'project_id',              r.project_id,
    'expected_cost_cents',     r.expected_cost_cents,
    'tags',                    r.tags,
    'needs_human_review',      r.needs_human_review,
    'ts',                      r.ts,
    'created_ts',              r.created_ts,
    'updated_ts',              r.updated_ts,
    'parent_id',               r.parent_id,
    'goal_id',                 r.goal_id,
    'taken_by',                r.taken_by,
    'taken_at',                r.taken_at,
    'last_progress_at',        r.last_progress_at,
    'expires_at',              r.expires_at,
    'item_kind',               r.item_kind,
    'feature_order',           r.feature_order
  ) || jsonb_build_object(
    'swarm_affinity',          r.swarm_affinity,
    'redundancy',              r.redundancy,
    'payload',                 r.payload,
    'design_spec_id',          r.design_spec_id,
    'design_status',           r.design_status,
    'needs_design',            r.needs_design,
    'discarded_design_work',   r.discarded_design_work,
    'source_plan_slug',        r.source_plan_slug,
    'source_plan_item_ids',    r.source_plan_item_ids,
    'see_also',                r.see_also,
    'wave',                    r.wave,
    'deprecation_reason',      r.deprecation_reason,
    'completion_ref',          r.completion_ref,
    'terminal_owner',          r.terminal_owner,
    'terminal_completion_ref', r.terminal_completion_ref,
    'terminal_reason',         r.terminal_reason,
    'authority',               r.authority,
    'closed_ts',               r.closed_ts,
    'admission',               r.admission,
    'admitted_at',             r.admitted_at,
    'admitted_by',             r.admitted_by,
    'author_pubkey',           r.author_pubkey,
    'origin',                  r.origin,
    'fed_ts',                  r.fed_ts,
    'fed_hlc',                 r.fed_hlc,
    'verified_author_github_user_id', r.verified_author_github_user_id
  );
$function$;

COMMENT ON FUNCTION harness_shared.feature_wire_row(harness_shared.work_items) IS
  'WI-10002882 (mig 1226): the feature-family work_items columns a peer APPLIES (harness-features writeToPg INSERT list). stamp_local_federated_write and capture_work_items_outbox judge feature-row content with it; pinned by issue-wire-capture-mapper-parity.test.ts.';

CREATE OR REPLACE FUNCTION harness_shared.stamp_local_federated_write()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  mask text[] := ARRAY[
    'fed_ts', 'fed_hlc', 'origin', 'author_pubkey', 'updated_at',
    '_search', 'version', 'local_disposition'
  ];
  gen_cols text[];
  content_changed boolean;
  wire_clock_keys text[] := ARRAY['fed_ts', 'fed_hlc', 'origin', 'author_pubkey'];
  -- WI-10002882: a feature wire row also carries ts/updated_ts, which the generic mask
  -- has always treated as bookkeeping for work_items. They are not content.
  feature_non_content_keys text[] := ARRAY['fed_ts', 'fed_hlc', 'origin', 'author_pubkey', 'ts', 'updated_ts'];
BEGIN
  -- A write that moves either component of the wire order key is a projection
  -- apply or an explicit repair/backfill. Respect it verbatim and advance the PG
  -- HLC clock so a later legitimate local write is causally after it.
  IF TG_OP = 'UPDATE'
     AND (NEW.fed_ts IS DISTINCT FROM OLD.fed_ts
          OR NEW.fed_hlc IS DISTINCT FROM OLD.fed_hlc) THEN
    IF NEW.fed_hlc IS NOT NULL THEN
      PERFORM harness_shared.hlc_recv(NEW.fed_hlc);
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- A projection INSERT carries the op's fed_ts AND origin='remote'; a local
    -- INSERT carries neither. Gate the stamp on origin so a remote ts-less op
    -- cannot receive a fresh local clock and pass the projection's LWW guard.
    IF NEW.fed_ts IS NULL AND COALESCE(NEW.origin, 'local') = 'local' THEN
      NEW.fed_ts := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
      NEW.fed_hlc := harness_shared.hlc_now();
    ELSIF NEW.fed_hlc IS NOT NULL THEN
      PERFORM harness_shared.hlc_recv(NEW.fed_hlc);
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE with the wire clock untouched is a local write or a same-op re-fold.
  -- Stamp only when a real content column changed. Bookkeeping and generated
  -- columns retain their prior clock and origin.
  -- This function serves ~22 tables. PL/pgSQL resolves a record field reference
  -- (OLD.item_kind) when the statement runs, NOT lazily inside a short-circuited AND,
  -- so the work_items-only fields must sit behind a NESTED IF on the table name.
  content_changed := NULL;
  IF TG_TABLE_NAME = 'work_items' THEN
    IF OLD.item_kind IN ('bug', 'change', 'task')
       AND NEW.item_kind IN ('bug', 'change', 'task') THEN
      -- WI-10002875: for an issue-family row, "content" is exactly what ships — the
      -- engineer-issues wire row (shared with capture_work_items_outbox) minus its
      -- clock/provenance keys. A write to a local-only column (embeddings, release
      -- and attempt bookkeeping, ...) keeps the clock, so it emits no wire op.
      -- `lane` (which the capture triggers gate on) is GENERATED as payload->>'lane'
      -- and payload is on the wire, so a promoted observation still stamps. Do not
      -- read NEW.lane here: generated columns are computed AFTER BEFORE triggers.
      content_changed :=
        (harness_shared.engineer_issue_wire_row(NEW, NEW.workspace_id, NULL, NULL) - wire_clock_keys)
          IS DISTINCT FROM
        (harness_shared.engineer_issue_wire_row(OLD, OLD.workspace_id, NULL, NULL) - wire_clock_keys);
    ELSIF COALESCE(OLD.item_kind, '') NOT IN ('bug', 'change', 'task')
          AND COALESCE(NEW.item_kind, '') NOT IN ('bug', 'change', 'task') THEN
      -- WI-10002882: for a feature-family row, "content" is exactly what a peer
      -- APPLIES — feature_wire_row (shared with capture_work_items_outbox) minus its
      -- clock/provenance and ts/updated_ts bookkeeping keys. A write to a local-only
      -- column (embeddings, verifier/audit/rank/schedule bookkeeping, release history,
      -- ...) keeps the clock and origin, so it can no longer mint a wire version — the
      -- write that let two peers re-stamp one row back and forth forever (WI-10003230).
      content_changed :=
        (harness_shared.feature_wire_row(NEW) - feature_non_content_keys)
          IS DISTINCT FROM
        (harness_shared.feature_wire_row(OLD) - feature_non_content_keys);
    END IF;
  END IF;

  IF content_changed IS NULL THEN
    IF TG_TABLE_NAME = 'work_items' THEN
      mask := mask || ARRAY['updated_ts', 'ts'];
    END IF;

    SELECT coalesce(array_agg(a.attname::text), ARRAY[]::text[])
      INTO gen_cols
      FROM pg_attribute a
     WHERE a.attrelid = TG_RELID
       AND a.attgenerated <> ''
       AND a.attnum > 0
       AND NOT a.attisdropped;
    mask := mask || gen_cols;

    content_changed := (to_jsonb(NEW) - mask) IS DISTINCT FROM (to_jsonb(OLD) - mask);
  END IF;

  -- WI-6250: this host is a receiver, not the publisher, when a signed row's
  -- current provenance is remote. A clock-stationary content mutation therefore
  -- cannot be authorized or re-signed here. Fail loudly before an unsigned local
  -- replacement can mint a newer LWW clock and permanently shadow the publisher.
  IF content_changed
     AND COALESCE(OLD.origin, 'local') = 'remote'
     AND NULLIF(to_jsonb(OLD)->>'signer_device_pubkey', '') IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format(
        'publisher-signed remote row on %I.%I cannot be changed by a local write',
        TG_TABLE_SCHEMA,
        TG_TABLE_NAME
      ),
      DETAIL = 'Move fed_ts or fed_hlc only when applying an authenticated projection op or an explicit repair.';
  END IF;

  IF content_changed THEN
    NEW.fed_ts := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
    NEW.fed_hlc := harness_shared.hlc_now();
    NEW.origin := 'local';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION harness_shared.capture_work_items_outbox()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
    DECLARE
      v_op     TEXT;
      v_rec    harness_shared.work_items;
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

      -- WI-924391 — Resource-governor admission receipts are EPHEMERAL LOCAL QUEUE
      -- STATE, not federated work (mig 1025).
      IF jsonb_exists(v_rec.payload, 'resource_governor') THEN RETURN v_rec; END IF;

      v_ws := COALESCE(v_rec.workspace_id, '');

      IF v_rec.item_kind IN ('bug', 'change', 'task') THEN
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
        v_row := harness_shared.engineer_issue_wire_row(v_rec, v_ws, v_scope, v_slug);
        -- WI-10002875: an UPDATE whose whole wire row (clock included) is unchanged is
        -- not a federated change. The issue UPDATE trigger fires on any payload
        -- difference, including one confined to a non-projected payload->'_ei' key.
        IF TG_OP = 'UPDATE'
           AND v_row = harness_shared.engineer_issue_wire_row(OLD, v_ws, v_scope, v_slug) THEN
          RETURN v_rec;
        END IF;
      ELSE
        v_tbl  := 'harness_features_consolidated';
        v_slug := harness_shared.canonical_harness_slug(v_rec.harness_slug);
        v_key  := v_rec.feature_id;
        v_row  := to_jsonb(v_rec);
        -- WI-10002882: capture_work_items_feature_upd_trg fires on ANY column
        -- difference. An UPDATE that leaves every column a peer applies unchanged
        -- (clock included; ts/updated_ts are bookkeeping) carries the clock of the
        -- version already shipped, so a peer's LWW apply would drop it: ship nothing.
        IF TG_OP = 'UPDATE'
           AND (harness_shared.feature_wire_row(NEW) - ARRAY['ts', 'updated_ts'])
             = (harness_shared.feature_wire_row(OLD) - ARRAY['ts', 'updated_ts']) THEN
          RETURN v_rec;
        END IF;
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
