-- Migration 116 — consolidate per-harness agent_chats → slug-keyed
-- harness_shared.agent_chats_consolidated, replacing the per-harness physical
-- tables with auto-updatable VIEWs (the 032 pattern). Part of
-- harness-state-storage-unification-2026-06-01 P-004 (D-007: consolidate).
--
-- Reality this migration reconciles (verified live 2026-06-03):
--   * agent_chats_consolidated existed (000-baseline) but was NEVER write-cut-over —
--     no mirroring trigger, ~half the rows (76 vs 156 live). The per-harness
--     `harness_<slug>.agent_chats` tables are the SOURCE OF TRUTH.
--   * Per-harness created_at/updated_at/archived_at are TIMESTAMPTZ; consolidated
--     is BIGINT epoch-MILLISECONDS (the consolidation standard, like features/
--     issues/runs/snapshots). We coerce on backfill.
--   * Two per-harness shapes coexist: the real data shape (has `transcript`,
--     id text) and a drifted stale-scaffold shape (no transcript, id bigint,
--     thread_id/payload) left by e2e harness creation — the drifted ones are
--     empty leftovers. We backfill the real shape and refuse to drop a drifted
--     table that unexpectedly holds rows.
--   * Existing consolidated rows use workspace_id='default' (this box's workspace).
--
-- Strategy: backfill per-harness → consolidated (source of truth wins via
-- ON CONFLICT DO UPDATE), THEN drop the physical table and create the view.
-- View column DEFAULTs let the existing writers (which omit harness_slug /
-- workspace_id / timestamps on INSERT) keep working unchanged through the view.
-- Idempotent: re-running finds views (not tables), skips backfill, recreates views.

\set ON_ERROR_STOP on
BEGIN;

DO $mig$
DECLARE
  s       TEXT;    -- schema name (harness_<slug>)
  slug    TEXT;    -- registry slug (hyphenated)
  drift_n BIGINT;  -- row count of a drifted-shape table (must be 0 to drop)
BEGIN
  FOR s IN
    SELECT schema_name FROM information_schema.schemata
     WHERE schema_name LIKE 'harness_%' AND schema_name <> 'harness_shared'
  LOOP
    slug := replace(substring(s FROM 9), '_', '-');

    -- Backfill + drop only when agent_chats is still a BASE TABLE in this schema.
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = s AND table_name = 'agent_chats' AND table_type = 'BASE TABLE'
    ) THEN
      -- Two live shapes exist (verified 2026-06-03): the real data shape
      -- (has `transcript`) and a drifted stale-scaffold shape (no transcript,
      -- id bigint, thread_id/payload) left by e2e harness creation. Backfill
      -- the real shape; the drifted ones are empty leftovers — drop only after
      -- asserting they hold no rows (never silently lose data).
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = s AND table_name = 'agent_chats' AND column_name = 'transcript'
      ) THEN
        EXECUTE format($q$
          INSERT INTO harness_shared.agent_chats_consolidated
            (workspace_id, harness_slug, id, role, feature_id, title, transcript,
             total_input_tokens, total_output_tokens, total_cost_usd_cents,
             created_at, updated_at, archived_at)
          SELECT 'default', %2$L, id::text, role, feature_id, title, transcript,
                 total_input_tokens, total_output_tokens, total_cost_usd_cents,
                 (extract(epoch FROM created_at) * 1000)::bigint,
                 (extract(epoch FROM updated_at) * 1000)::bigint,
                 CASE WHEN archived_at IS NULL THEN NULL
                      ELSE (extract(epoch FROM archived_at) * 1000)::bigint END
            FROM %1$I.agent_chats
          ON CONFLICT (workspace_id, harness_slug, id) DO UPDATE SET
            role                 = EXCLUDED.role,
            feature_id           = EXCLUDED.feature_id,
            title                = EXCLUDED.title,
            transcript           = EXCLUDED.transcript,
            total_input_tokens   = EXCLUDED.total_input_tokens,
            total_output_tokens  = EXCLUDED.total_output_tokens,
            total_cost_usd_cents = EXCLUDED.total_cost_usd_cents,
            created_at           = EXCLUDED.created_at,
            updated_at           = EXCLUDED.updated_at,
            archived_at          = EXCLUDED.archived_at
        $q$, s, slug);
      ELSE
        EXECUTE format('SELECT count(*) FROM %I.agent_chats', s) INTO drift_n;
        IF drift_n > 0 THEN
          RAISE EXCEPTION 'agent_chats in % has the drifted shape AND % row(s) — refusing to drop (manual reconcile needed)', s, drift_n;
        END IF;
      END IF;

      EXECUTE format('DROP TABLE IF EXISTS %I.agent_chats CASCADE', s);
    END IF;

    -- (Re)create the auto-updatable view over consolidated.
    EXECUTE format('DROP VIEW IF EXISTS %I.agent_chats CASCADE', s);
    EXECUTE format($v$
      CREATE VIEW %1$I.agent_chats AS
        SELECT * FROM harness_shared.agent_chats_consolidated
        WHERE harness_slug = %2$L
        WITH CHECK OPTION
    $v$, s, slug);

    -- Column DEFAULTs so writers that omit these on INSERT still pass through.
    EXECUTE format('ALTER VIEW %I.agent_chats ALTER COLUMN workspace_id SET DEFAULT %L', s, 'default');
    EXECUTE format('ALTER VIEW %I.agent_chats ALTER COLUMN harness_slug SET DEFAULT %L', s, slug);
    EXECUTE format('ALTER VIEW %I.agent_chats ALTER COLUMN created_at SET DEFAULT (extract(epoch FROM now()) * 1000)::bigint', s);
    EXECUTE format('ALTER VIEW %I.agent_chats ALTER COLUMN updated_at SET DEFAULT (extract(epoch FROM now()) * 1000)::bigint', s);
    EXECUTE format('ALTER VIEW %I.agent_chats ALTER COLUMN transcript SET DEFAULT ''[]''::jsonb', s);
    EXECUTE format('ALTER VIEW %I.agent_chats ALTER COLUMN total_input_tokens SET DEFAULT 0', s);
    EXECUTE format('ALTER VIEW %I.agent_chats ALTER COLUMN total_output_tokens SET DEFAULT 0', s);
    EXECUTE format('ALTER VIEW %I.agent_chats ALTER COLUMN total_cost_usd_cents SET DEFAULT 0', s);

    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.agent_chats TO harness_app, harness_admin', s);
    BEGIN
      EXECUTE format('GRANT SELECT ON %I.agent_chats TO harness_zero', s);
    EXCEPTION WHEN OTHERS THEN
      -- harness_zero absent (test rigs) — skip.
    END;
  END LOOP;
END $mig$;

COMMIT;
