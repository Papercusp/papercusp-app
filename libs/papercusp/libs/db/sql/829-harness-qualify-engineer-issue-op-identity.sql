-- 829-harness-qualify-engineer-issue-op-identity.sql
--
-- EI-20340649204632164 / WI-38468 P-005 follow-up.  Migration 826 removed
-- non-Papercusp physical twins, but engineer-issue tombstones were keyed only
-- by feature_id.  A home log can carry several harnesses, and the receiver's
-- equally-unqualified DELETE therefore erased 15 Papercusp survivors.  Make
-- new wire identity match the physical PK: <storage harness>/<feature id>.
-- The TypeScript receiver remains backward-compatible with old bare keys but
-- author-scopes them so replay cannot repeat this loss.

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

-- Restore only the 15 Papercusp survivors that legacy bare tombstones erased.
-- The complete pre-mutation rows remain in migration 826's durable backup; the
-- same evidence merge is replayed so terminal/completion data is not regressed.
CREATE TEMP TABLE repair_829_missing_ids (feature_id text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO repair_829_missing_ids
SELECT v.feature_id
FROM (VALUES
  ('EI-1435'), ('EI-1629'), ('EI-1700'), ('EI-2205'), ('EI-6706'),
  ('EI-6707'), ('EI-6708'), ('EI-6765'), ('EI-7019'), ('EI-7532'),
  ('EI-7690'), ('WI-1993'), ('WI-2017'), ('WI-2063'), ('WI-2124')
) AS v(feature_id)
-- A fresh installation applied through 826 has an intentionally empty backup;
-- restoration is production incident data, not seed data.
WHERE EXISTS (
  SELECT 1 FROM harness_shared.bak_20260813_work_item_physical_twins LIMIT 1
);

DO $restore829$
DECLARE
  bad text;
  cols text;
  backup_cols text;
BEGIN
  IF to_regclass('harness_shared.bak_20260813_work_item_physical_twins') IS NULL THEN
    RAISE EXCEPTION '829: migration 826 backup table is missing';
  END IF;

  SELECT string_agg(feature_id, ', ' ORDER BY feature_id) INTO bad
  FROM (
    SELECT m.feature_id
    FROM repair_829_missing_ids m
    LEFT JOIN harness_shared.bak_20260813_work_item_physical_twins b USING (feature_id)
    GROUP BY m.feature_id
    HAVING count(b.*) <> 2
       OR count(*) FILTER (WHERE b.harness_slug = 'papercusp') <> 1
       OR count(DISTINCT coalesce(b.title, '')) <> 1
       OR count(DISTINCT coalesce(b.summary, '')) <> 1
  ) drift;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '829: backup classification drifted for %', bad;
  END IF;

  -- Idempotent over an already-restored exact Papercusp survivor, but fail on
  -- every other partial shape rather than guessing through new live writes.
  SELECT string_agg(feature_id, ', ' ORDER BY feature_id) INTO bad
  FROM (
    SELECT m.feature_id
    FROM repair_829_missing_ids m
    LEFT JOIN harness_shared.work_items w
      ON w.workspace_id = 'papercusp-workspace' AND w.feature_id = m.feature_id
    GROUP BY m.feature_id
    HAVING count(w.*) > 1
       OR (count(w.*) = 1 AND count(*) FILTER (WHERE w.harness_slug = 'papercusp') <> 1)
  ) unexpected;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '829: unexpected live survivor shape for %', bad;
  END IF;

  -- Copy every non-generated column shared by the frozen migration-826 backup
  -- and the current work_items table.  Later migrations may add nullable or
  -- defaulted columns to work_items; those columns were never present in the
  -- incident snapshot and must take their current defaults on restore.
  -- _search/lane are regenerated.
  SELECT string_agg(format('%I', current_col.attname), ', ' ORDER BY current_col.attnum),
         string_agg(format('b.%I', current_col.attname), ', ' ORDER BY current_col.attnum)
    INTO cols, backup_cols
  FROM pg_attribute current_col
  JOIN pg_attribute backup_col
    ON backup_col.attrelid = 'harness_shared.bak_20260813_work_item_physical_twins'::regclass
   AND backup_col.attname = current_col.attname
   AND backup_col.attnum > 0
   AND NOT backup_col.attisdropped
   AND backup_col.attgenerated = ''
  WHERE current_col.attrelid = 'harness_shared.work_items'::regclass
    AND current_col.attnum > 0
    AND NOT current_col.attisdropped
    AND current_col.attgenerated = '';

  EXECUTE format(
    'INSERT INTO harness_shared.work_items (%s) '
    'SELECT %s FROM harness_shared.bak_20260813_work_item_physical_twins b '
    'JOIN repair_829_missing_ids m ON m.feature_id = b.feature_id '
    'WHERE b.harness_slug = ''papercusp'' '
    'AND NOT EXISTS (SELECT 1 FROM harness_shared.work_items w '
    '  WHERE w.workspace_id = ''papercusp-workspace'' '
    '    AND w.harness_slug = ''papercusp'' AND w.feature_id = b.feature_id)',
    cols, backup_cols);
END
$restore829$;

WITH pairs AS (
  SELECT p.harness_slug AS source_harness, p.feature_id, p.status AS source_status,
         p.payload AS source_payload, p.completion_ref AS source_completion_ref,
         p.terminal_completion_ref AS source_terminal_completion_ref,
         p.terminal_owner AS source_terminal_owner, p.authority AS source_authority,
         p.closed_ts AS source_closed_ts, p.updated_ts AS source_updated_ts,
         p.fed_hlc AS source_fed_hlc
  FROM harness_shared.bak_20260813_work_item_physical_twins p
  JOIN repair_829_missing_ids m USING (feature_id)
  WHERE p.harness_slug <> 'papercusp'
)
UPDATE harness_shared.work_items s
SET status = CASE
      WHEN s.status IN ('passed','deprecated','resolved','closed','done','dropped') THEN s.status
      WHEN p.source_status IN ('passed','deprecated','resolved','closed','done','dropped') THEN p.source_status
      ELSE s.status END,
    completion_ref = coalesce(s.completion_ref, p.source_completion_ref),
    terminal_completion_ref = coalesce(s.terminal_completion_ref, p.source_terminal_completion_ref),
    terminal_owner = coalesce(s.terminal_owner, p.source_terminal_owner),
    authority = coalesce(s.authority, p.source_authority),
    closed_ts = coalesce(s.closed_ts, p.source_closed_ts),
    updated_ts = greatest(s.updated_ts, p.source_updated_ts),
    payload = jsonb_strip_nulls(
      coalesce(s.payload, '{}'::jsonb)
      || CASE WHEN (coalesce(s.payload, '{}'::jsonb)->'_completionEvidence') IS NULL
                   AND (coalesce(p.source_payload, '{}'::jsonb)->'_completionEvidence') IS NOT NULL
              THEN jsonb_build_object('_completionEvidence', p.source_payload->'_completionEvidence')
              ELSE '{}'::jsonb END
      || jsonb_build_object('_physicalTwinRepair', jsonb_strip_nulls(jsonb_build_object(
           'migration', 826, 'sourceHarness', p.source_harness,
           'sourceStatus', p.source_status, 'sourcePayload', coalesce(p.source_payload, '{}'::jsonb),
           'sourceCompletionRef', p.source_completion_ref,
           'sourceTerminalCompletionRef', p.source_terminal_completion_ref,
           'sourceTerminalOwner', p.source_terminal_owner,
           'sourceAuthority', p.source_authority, 'sourceClosedTs', p.source_closed_ts,
           'sourceUpdatedTs', p.source_updated_ts, 'sourceFedHlc', p.source_fed_hlc,
           'restoreSnapshot', 'b44f5987c0ef9db944d99b3867f01708'))))
FROM pairs p
WHERE s.workspace_id = 'papercusp-workspace'
  AND s.harness_slug = 'papercusp' AND s.feature_id = p.feature_id;

DO $post829$
DECLARE bad text;
BEGIN
  SELECT string_agg(feature_id, ', ' ORDER BY feature_id) INTO bad
  FROM (
    SELECT m.feature_id
    FROM repair_829_missing_ids m
    LEFT JOIN harness_shared.work_items w
      ON w.workspace_id = 'papercusp-workspace' AND w.feature_id = m.feature_id
    GROUP BY m.feature_id
    HAVING count(w.*) <> 1
       OR count(*) FILTER (WHERE w.harness_slug = 'papercusp') <> 1
  ) failed;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '829: survivor restoration postcondition failed for %', bad;
  END IF;
END
$post829$;
