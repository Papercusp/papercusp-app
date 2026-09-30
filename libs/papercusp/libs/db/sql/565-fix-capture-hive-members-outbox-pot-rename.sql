-- Migration 565 — fix capture_hive_members_outbox(): still reads the RENAMED-AWAY
-- hive_home_slug column (cup-lexicon-full-rename-2026-07-09, P-011 live-verification
-- finding).
--
-- WHY -------------------------------------------------------------------------------
-- Migration 557 (Phase 3) renamed harness_shared.hive_members -> pot_members AND its
-- hive_home_slug column -> pot_home_slug. But the custom capture trigger function
-- harness_shared.capture_hive_members_outbox() (live def = mig 477, superseding 189)
-- still does:
--     v_slug := v_row ->> 'hive_home_slug';
-- Function bodies are NOT rewritten by ALTER TABLE ... RENAME COLUMN, so post-557 this
-- JSONB key lookup silently returns NULL (the key no longer exists on the row), and
-- that NULL is stamped straight into substrate_outbox.harness_slug — a NOT NULL
-- column — which makes EVERY INSERT/UPDATE/DELETE on pot_members hard-fail with
-- `null value in column "harness_slug" of relation "substrate_outbox" violates
-- not-null constraint` (observed live in the papercup-bg-host journal, 2026-07-11
-- ~00:42:45Z, "[hive-rekey] owner admit failed for key=ef7a8160"). This is the SAME
-- bug class the leader already found + fixed for capture_work_items_outbox (mig 559)
-- and capture_engineer_issues_outbox (mig 560) — capture_hive_members_outbox was the
-- one sibling those two passes missed.
--
-- THE FIX — identical to mig 477's body, with the one renamed key corrected:
--     v_slug := v_row ->> 'pot_home_slug';
--
-- Idempotent (CREATE OR REPLACE; the two trigger attachments from mig 189 bind by
-- function NAME and are unchanged). The runner provides the transaction — NO
-- BEGIN/COMMIT here (lint:migrations).

CREATE OR REPLACE FUNCTION harness_shared.capture_hive_members_outbox() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      v_op      TEXT;
      v_rec     RECORD;
      v_origin  TEXT;
      v_key     TEXT;
      v_row     JSONB;
      v_ws      TEXT;
      v_slug    TEXT;
      v_op_hlc  TEXT;
      v_ts      BIGINT;
      v_keycol  TEXT := TG_ARGV[0];
    BEGIN
      IF (TG_OP = 'DELETE') THEN
        v_op := 'del';
        v_rec := OLD;
      ELSE
        v_op := 'put';
        v_rec := NEW;
      END IF;

      v_row := to_jsonb(v_rec);
      v_origin := v_row ->> 'origin';

      -- Echo-loop guard: skip remote-origin writes (the projection's own writes).
      IF COALESCE(v_origin, 'local') <> 'local' THEN
        RETURN v_rec;
      END IF;

      v_key  := v_row ->> v_keycol;
      v_ws   := COALESCE(v_row ->> 'workspace_id', '');
      v_slug := v_row ->> 'pot_home_slug';  -- the Pot scope (generic fn reads harness_slug); renamed
                                             -- from hive_home_slug by mig 557 (fixed here — WI-3467/P-011)

      -- D-001 / mig 446 symmetry: thread the row's stamped ordering key onto the wire
      -- op so author + receivers materialise the SAME (fed_ts, fed_hlc). put → the
      -- row's fed_hlc + COALESCE(fed_ts, now()); del → a fresh hlc_now()+now() (its
      -- own causal event); unstamped row (fed_hlc NULL) → now()+NULL (drain fallback).
      IF v_op = 'del' THEN
        v_op_hlc := harness_shared.hlc_now();
        v_ts     := (extract(epoch from now()) * 1000)::bigint;
      ELSE
        v_op_hlc := v_row ->> 'fed_hlc';
        v_ts     := CASE WHEN v_op_hlc IS NOT NULL
                         THEN COALESCE((v_row ->> 'fed_ts')::bigint,
                                       (extract(epoch from now()) * 1000)::bigint)
                         ELSE (extract(epoch from now()) * 1000)::bigint
                    END;
      END IF;

      INSERT INTO harness_shared.substrate_outbox
        (workspace_id, harness_slug, table_name, op, key, row, ts, op_hlc)
      VALUES
        (v_ws, v_slug, TG_TABLE_NAME, v_op, v_key, v_row, v_ts, v_op_hlc);

      PERFORM pg_notify('substrate_outbox', v_ws || '::' || v_slug);

      RETURN v_rec;
    END;
    $$;
