-- 1208-engineer-issue-wire-row-drives-stamp-clock.sql
--
-- WI-10002875 (plan p2p-join-catchup-speed-2026-09-23 P-006, D-004) — a write to a
-- LOCAL-ONLY work_items column must not mint a new engineer-issues wire version.
--
-- WHAT WAS WRONG
--   Two triggers disagreed about which columns of an issue-family row are "content":
--
--   * stamp_local_federated_write (BEFORE UPDATE) stamps a fresh fed_ts/fed_hlc and
--     origin='local' whenever to_jsonb(NEW) differs from to_jsonb(OLD) outside a small
--     bookkeeping mask. That compares EVERY column, including ones that never leave the
--     host: the embedding set (embedding, embedding_mode, embedding_recipe,
--     embedding_profile), last_released_at/_by, attempts, worked_by_history,
--     last_progress_at, requeue_count, claims, notes, metadata, ...
--   * capture_work_items_outbox projects an issue-family row onto a FIXED subset of
--     columns (the engineer_issues wire row), and capture_work_items_issue_upd_trg
--     fires whenever fed_ts/fed_hlc move.
--
--   So a local-only column write moved the clock, the clock move fired the capture,
--   and the capture enqueued a wire row identical to the previous one except for the
--   clock. Every peer then paid a full apply (upsert, xid, WAL flush) for nothing, and
--   every future joiner re-pays it on catch-up.
--
--   The same path also flipped a REMOTE row to origin='local' on a purely local write
--   (for example the embedding backfill vectorising a peer's issue), which made this
--   host re-publish the peer's row under its own fresh clock.
--
-- MEASURED 2026-09-24 (tower substrate_outbox, 24h retention)
--   engineer_issues: 10,774 rows over 1,986 keys (5.42 versions/key). Of the 8,788
--   repeat versions, 4,713 (54%) differ from their predecessor ONLY in fed_ts/fed_hlc.
--
-- THE FIX — one projection, used by both triggers
--   harness_shared.engineer_issue_wire_row() is the single definition of the issue
--   wire row. The capture builds its row with it (so the shipped bytes are unchanged),
--   and the stamp trigger decides "did content change?" for an issue-family row by
--   comparing that projection of OLD and NEW with the clock/provenance keys removed.
--   The clock therefore moves exactly when the wire row changes. A column added to the
--   projection later is automatically content for the stamp too, so the two cannot
--   drift apart again.
--
--   Eligibility stays intact: the capture triggers gate on `lane`, which is GENERATED
--   as payload->>'lane', and payload is on the wire, so an observation promoted to
--   work still stamps and federates.
--
--   One further rule:
--   * the capture skips an UPDATE whose full wire row (clock included) is identical to
--     OLD's. capture_work_items_issue_upd_trg fires on ANY payload difference, and a
--     change confined to a non-projected payload->'_ei' key would otherwise enqueue a
--     byte-identical op.
--
--   Unchanged: the feature family (its wire row is to_jsonb of the whole row), every
--   other table using stamp_local_federated_write, the explicit clock-move branch (a
--   projection apply / repair), the INSERT branch, and the WI-6250 signed-remote guard.
--
-- NOT destructive DDL (CREATE OR REPLACE FUNCTION + one new function): no FORWARD-COMPAT
-- line is required. The deployed release reads no new column and no changed contract;
-- this strictly removes redundant outbox rows.
--
-- The capture and stamp bodies below are the live definitions (pg_get_functiondef on
-- 2026-09-24; capture last defined by mig 1025, stamp by mig 824) with ONLY the
-- changes described above.

CREATE OR REPLACE FUNCTION harness_shared.engineer_issue_wire_row(
  r harness_shared.work_items,
  p_ws text,
  p_scope text,
  p_slug text
)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'workspace_id',      p_ws,
    'issue_id',          r.feature_id,
    'scope',             p_scope,
    'title',             r.title,
    'body',              COALESCE(r.summary, ''),
    'severity',          COALESCE(r.payload->'_ei'->>'severity', 'minor'),
    'source',            COALESCE(r.payload->'_ei'->>'source', 'engineer'),
    'state',             r.status,
    'terminal_reason',   r.terminal_reason,
    'terminal_owner',           r.terminal_owner,
    'terminal_completion_ref',  r.terminal_completion_ref,
    'authority',         r.authority,
    'closed_ts',         r.closed_ts,
    'created_ts',        r.created_ts,
    'assignee',          r.taken_by,
    'assigned_by',       r.payload->'_ei'->>'assigned_by',
    'assigned_at',       r.taken_at,
    'found_during',      r.payload->'_ei'->>'found_during',
    'linked_feature_id', r.payload->'_ei'->>'linked_feature_id',
    'created_by',        r.payload->'_ei'->>'created_by',
    'kind',              r.item_kind,
    'payload',           (r.payload - '_ei'),
    'origin',            r.origin,
    'author_pubkey',     r.author_pubkey,
    'fed_ts',            r.fed_ts,
    'fed_hlc',           r.fed_hlc,
    'signal_origin',     COALESCE(r.payload->'_ei'->>'signal_origin', 'local'),
    'admission',            r.admission,
    'admitted_at',          r.admitted_at,
    'admitted_by',          r.admitted_by,
    'state_changed_at',     r.state_changed_at,
    'tags',                 r.tags,
    'parent_id',            r.parent_id,
    'source_plan_slug',     r.source_plan_slug,
    'source_plan_item_ids', r.source_plan_item_ids,
    'expected_cost_cents',  r.expected_cost_cents,
    'harness_slug',      p_slug,
    'storage_harness_slug', r.harness_slug))
$function$;

COMMENT ON FUNCTION harness_shared.engineer_issue_wire_row(harness_shared.work_items, text, text, text) IS
  'WI-10002875: the ONE engineer-issues wire projection of an issue-family work_items row. '
  'capture_work_items_outbox ships it; stamp_local_federated_write moves the clock only when it changes.';

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
