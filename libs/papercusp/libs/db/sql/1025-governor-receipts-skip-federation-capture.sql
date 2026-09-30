-- 1025-governor-receipts-skip-federation-capture.sql
--
-- WI-924391 — stop federating resource-governor admission receipts.
--
-- WHAT WAS WRONG
--   packages/operator-core/lib/resource-governor/queue.ts writes one
--   harness_shared.work_items row per admission ("Queued {embedding|process|
--   inference|agent} admission", item_kind='task', origin='local') and then
--   mutates it through queued -> leased -> running -> completed. item_kind='task'
--   falls in capture_work_items_outbox's ISSUE-family branch, so the INSERT and
--   every state transition were captured into harness_shared.substrate_outbox and
--   replicated to peers.
--
-- MEASURED 2026-08-29 (papercusp, live)
--   * substrate_outbox, last 1h, table_name='engineer_issues':
--       99,306 rows total / 98,116 carrying payload->'resource_governor' = 98.8%.
--     Whole table 1,498,864 rows / 3,395 MB on a 24h retention — i.e. ~1.49M
--     rows/day of federation work for state no peer can act on.
--   * harness_shared.work_items: 782,871 receipt rows = 85.6% of the 913k table
--     (4,911 MB), +23,383/hour, entire pile accumulated since 2026-08-27.
--     776,382 of them terminal (governor state 'completed'); the live set
--     (queued+eligible+leased+running) is only ~1,100 rows.
--   * Consequence: the scheduler claim-spec census (count(*) FILTER over 17
--     predicates) walked a table that is ~86% dead receipts. Under fleet load the
--     copies convoyed on LWLock:LockManager — 19 concurrent, oldest 20m42s — which
--     hangs work_items:claim, scheduler:get_next and coord:orient fleet-wide.
--
-- WHY THE GUARD GOES HERE
--   A receipt is ephemeral LOCAL queue state, not federated work; no peer can act
--   on another host's admission lease. Skipping it at the capture chokepoint also
--   UNBLOCKS retention: work_items is deliberately declared "not age-prunable by
--   design" (packages/operator-core/lib/storage/storage-growth-alarm.ts), so these
--   rows accumulated unbounded AND were invisible to the storage-growth alarm. A
--   retention GC still could not safely delete them while this trigger federated
--   every DELETE (776k deletes => 776k outbox rows), and session_replication_role
--   is superuser-only (pg_settings.context='superuser'), so the app role cannot
--   bypass the trigger. Skipping receipts here is what makes the later reap safe.
--
--   The guard sits beside the existing echo-loop guard because that is the
--   established place for "this write is not federated work" decisions, and it
--   covers every call path (INSERT, UPDATE and DELETE) through the one function.
--   A trigger-level WHEN clause was rejected: capture_work_items_outbox_ins_del_trg
--   is AFTER INSERT OR DELETE, and a WHEN clause on a combined insert/delete
--   trigger cannot reference NEW or OLD.
--
-- FALSIFIABILITY (run in a rolled-back transaction against live, 2026-08-29)
--   baseline normal  row -> 1 outbox row   (instrument is not blind)
--   baseline receipt row -> 1 outbox row   (reproduces the bug)
--   guarded  normal  row -> 1 outbox row   (no over-reach: real work still federates)
--   guarded  receipt row -> 0 outbox rows  (fixed, including its DELETE)
--   The calibration control matters: an earlier version of this test counted
--   substrate_outbox globally and read 0 for BOTH cases, because the live fleet
--   writes ~27 outbox rows/sec and the counts measured that traffic instead. Scope
--   any re-test to its own keys.
--
-- NOT destructive DDL (CREATE OR REPLACE FUNCTION only): no FORWARD-COMPAT line is
-- required. The currently-deployed release keeps working — this strictly REMOVES
-- outbox writes and changes no table shape, column or contract that it reads.
--
-- Body below is the live definition of harness_shared.capture_work_items_outbox
-- verbatim (pg_get_functiondef), with ONLY the receipt guard added.

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

      -- WI-924391 — Resource-governor admission receipts are EPHEMERAL LOCAL QUEUE
      -- STATE, not federated work, and must never enter the substrate outbox.
      --
      -- resource-governor/queue.ts writes one work_items row per admission and
      -- mutates it through queued->leased->running->completed. Every one of those
      -- transitions fired this trigger, so ~24k receipts/hour became ~98k outbox
      -- rows/hour: measured 2026-08-29, 98,116 of 99,306 engineer_issues puts in a
      -- single hour (98.8%) were receipts, driving substrate_outbox to 1.49M rows/day
      -- and 3.4GB. Replicating a local queue receipt to peers is pure waste: no peer
      -- can act on another host's admission lease.
      --
      -- This also UNBLOCKS retention. work_items is declared 'not age-prunable by
      -- design' (storage-growth-alarm.ts), so the receipts accumulated unbounded
      -- (782,871 rows = 85.6% of the table) and collapsed the scheduler claim-spec
      -- census. A retention GC could not safely delete them while this trigger
      -- federated every DELETE, and session_replication_role is superuser-only so
      -- the app role cannot bypass it. Skipping receipts here makes the reap safe.
      --
      -- jsonb_exists() rather than the `?` operator: `?` collides with the driver
      -- placeholder in some clients that also execute this SQL.
      IF jsonb_exists(v_rec.payload, 'resource_governor') THEN RETURN v_rec; END IF;

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
