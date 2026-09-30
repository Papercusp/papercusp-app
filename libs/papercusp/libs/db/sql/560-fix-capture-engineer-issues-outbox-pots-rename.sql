-- 560-fix-capture-engineer-issues-outbox-pots-rename.sql
--
-- capture_engineer_issues_outbox() still hardcoded harness_shared.hives/home_slug in its
-- operator-scope branch, unfixed by migration 557 (hives->pots ALTER TABLE doesn't touch
-- plpgsql function bodies) or migration 559 (which only fixed the SIBLING trigger function
-- capture_work_items_outbox() — this one was missed). Breaks any scope='operator'
-- engineer_issues write with "relation harness_shared.hives does not exist" — same bug
-- class as the scheduler:get_next fleet-wide outage fixed by 559, just the other trigger.
--
-- Mirrors 559's fix exactly: hives -> pots, home_slug -> pot_home_slug.

\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION harness_shared.capture_engineer_issues_outbox()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
    DECLARE
      v_op      TEXT;
      v_rec     RECORD;
      v_origin  TEXT;
      v_key     TEXT;
      v_row     JSONB;
      v_ws      TEXT;
      v_scope   TEXT;
      v_slug    TEXT;
      v_cnt     INT;
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

      v_ws := COALESCE(v_row ->> 'workspace_id', '');
      -- SU cross-workspace meta (workspace_id '*') + unscoped rows have no single Hive
      -- to ride → stay local.
      IF v_ws = '' OR v_ws = '*' THEN
        RETURN v_rec;
      END IF;

      -- Derive the federation slug from `scope` (the canonical Hive-home keying).
      v_scope := v_row ->> 'scope';
      IF v_scope LIKE 'harness:%' THEN
        v_slug := substr(v_scope, 9);
      ELSIF v_scope = 'operator' THEN
        -- Operator/Queen shared backlog rides the workspace's single Pot home.
        -- 0 or >1 Pot homes → ambiguous → stay local (do NOT guess; the multi-Pot
        -- operator-owner pointer is a documented follow-on).
        -- mig 560: harness_shared.hives/home_slug renamed to pots/pot_home_slug (mig 557).
        SELECT count(*)::int, min(pot_home_slug) INTO v_cnt, v_slug
          FROM harness_shared.pots WHERE workspace_id = v_ws;
        IF v_cnt <> 1 THEN
          RETURN v_rec;
        END IF;
      ELSE
        -- Unknown scope shape → stay local.
        RETURN v_rec;
      END IF;

      IF v_slug IS NULL OR v_slug = '' THEN
        RETURN v_rec;
      END IF;

      v_key := v_row ->> v_keycol;
      -- Stamp the resolved federation slug into the wire row so the read-side
      -- projection can demux per-harness (engineer_issues has no harness_slug column).
      v_row := v_row || jsonb_build_object('harness_slug', v_slug);

      INSERT INTO harness_shared.substrate_outbox
        (workspace_id, harness_slug, table_name, op, key, row, ts)
      VALUES
        (v_ws, v_slug, TG_TABLE_NAME, v_op, v_key, v_row,
         (extract(epoch from now()) * 1000)::bigint);

      PERFORM pg_notify('substrate_outbox', v_ws || '::' || v_slug);

      RETURN v_rec;
    END;
    $function$;
