-- Migration 120 — consolidate per-harness messages + executed_actions →
-- slug-keyed harness_shared.*_consolidated, replacing the per-harness physical
-- tables with auto-updatable VIEWs (032 pattern). Part of
-- harness-state-storage-unification-2026-06-01 P-004 (D-007: consolidate).
--
-- Decision (autonomous, 2026-06-03): these two keep TIMESTAMPTZ (created_at/
-- acknowledged_at/executed_at), unlike the bigint-ms consolidated tables. Reason:
-- ALL live data + every live writer/reader (execute-action.ts, all-kpis.ts,
-- prune-executed-actions.ts, cross-harness-data.ts) is tstz-shaped and uses SQL
-- now()/interval filters. Keeping tstz means those pass through the views
-- UNCHANGED — zero edits to the hot agent-coordination paths. (A cosmetic
-- divergence from the bigint convention, deliberately accepted to avoid risky
-- unsupervised edits to live coordination code.)
--
-- Neither per-harness table has a harness_slug column → consolidated adds one
-- (= the schema's slug, via view DEFAULT). uuid PKs collide across schemas
-- (verified: 1 dup action_id, 2 dup message ids) so PK is (harness_slug, <uuid>).
-- The ONE writer change this forces: execute-action.ts's executed_actions insert
-- `ON CONFLICT (action_id)` → `ON CONFLICT (harness_slug, action_id)` (the view's
-- base unique is composite). messages writers need NO change (plain INSERT +
-- now() on tstz + readers' now()-interval filters all pass through unchanged).
--
-- Idempotent: re-running finds views (not tables), skips backfill, recreates views.

\set ON_ERROR_STOP on
BEGIN;

-- ── consolidated base tables (TIMESTAMPTZ) ──────────────────────────
CREATE TABLE IF NOT EXISTS harness_shared.messages_consolidated (
  workspace_id      text NOT NULL DEFAULT 'default',
  harness_slug      text NOT NULL,
  id                uuid NOT NULL DEFAULT gen_random_uuid(),
  from_slug         text,
  to_slug           text,
  kind              text,
  subject           text,
  body              text,
  parent_message_id uuid,
  status            text NOT NULL DEFAULT 'pending',
  created_at        timestamptz NOT NULL DEFAULT now(),
  acknowledged_at   timestamptz,
  to_role           text,
  from_feature_id   text,
  to_feature_id     text,
  PRIMARY KEY (harness_slug, id)
);
CREATE INDEX IF NOT EXISTS messages_consolidated_recent_idx
  ON harness_shared.messages_consolidated (harness_slug, created_at DESC);

CREATE TABLE IF NOT EXISTS harness_shared.executed_actions_consolidated (
  workspace_id text NOT NULL DEFAULT 'default',
  harness_slug text NOT NULL,
  action_id    uuid NOT NULL,
  op           text,
  caller_slug  text,
  target_slug  text,
  reason       text,
  request      jsonb,
  response     jsonb,
  executed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (harness_slug, action_id)
);
CREATE INDEX IF NOT EXISTS executed_actions_consolidated_recent_idx
  ON harness_shared.executed_actions_consolidated (harness_slug, executed_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON
  harness_shared.messages_consolidated,
  harness_shared.executed_actions_consolidated
  TO harness_app, harness_admin;
DO $g$ BEGIN
  GRANT SELECT ON harness_shared.messages_consolidated,
                  harness_shared.executed_actions_consolidated TO harness_zero;
EXCEPTION WHEN OTHERS THEN NULL; END $g$;

-- ── per-schema backfill + view-swap ─────────────────────────────────
DO $mig$
DECLARE
  s    TEXT;
  slug TEXT;
  n    BIGINT;
BEGIN
  FOR s IN
    SELECT schema_name FROM information_schema.schemata
     WHERE schema_name LIKE 'harness_%' AND schema_name <> 'harness_shared'
  LOOP
    slug := replace(substring(s FROM 9), '_', '-');

    -- ---- messages ----
    IF EXISTS (SELECT 1 FROM information_schema.tables
                WHERE table_schema=s AND table_name='messages' AND table_type='BASE TABLE') THEN
      IF EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema=s AND table_name='messages' AND column_name='from_feature_id') THEN
        -- 13-col real shape
        EXECUTE format($q$
          INSERT INTO harness_shared.messages_consolidated
            (workspace_id, harness_slug, id, from_slug, to_slug, kind, subject, body,
             parent_message_id, status, created_at, acknowledged_at, to_role,
             from_feature_id, to_feature_id)
          SELECT 'default', %2$L, id, from_slug, to_slug, kind, subject, body,
                 parent_message_id, status, created_at, acknowledged_at, to_role,
                 from_feature_id, to_feature_id
            FROM %1$I.messages
          ON CONFLICT (harness_slug, id) DO NOTHING
        $q$, s, slug);
      ELSIF EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema=s AND table_name='messages' AND column_name='id'
                       AND data_type='uuid') THEN
        -- 11-col real shape (no feature_id columns)
        EXECUTE format($q$
          INSERT INTO harness_shared.messages_consolidated
            (workspace_id, harness_slug, id, from_slug, to_slug, kind, subject, body,
             parent_message_id, status, created_at, acknowledged_at, to_role)
          SELECT 'default', %2$L, id, from_slug, to_slug, kind, subject, body,
                 parent_message_id, status, created_at, acknowledged_at, to_role
            FROM %1$I.messages
          ON CONFLICT (harness_slug, id) DO NOTHING
        $q$, s, slug);
      ELSE
        -- drifted bigint-template shape (message_id PK) — must be empty
        EXECUTE format('SELECT count(*) FROM %I.messages', s) INTO n;
        IF n > 0 THEN RAISE EXCEPTION 'messages in % has drifted shape AND % rows', s, n; END IF;
      END IF;
      EXECUTE format('DROP TABLE IF EXISTS %I.messages CASCADE', s);
    END IF;
    EXECUTE format('DROP VIEW IF EXISTS %I.messages CASCADE', s);
    EXECUTE format($v$
      CREATE VIEW %1$I.messages AS
        SELECT * FROM harness_shared.messages_consolidated
        WHERE harness_slug = %2$L WITH CHECK OPTION
    $v$, s, slug);
    EXECUTE format('ALTER VIEW %I.messages ALTER COLUMN workspace_id SET DEFAULT %L', s, 'default');
    EXECUTE format('ALTER VIEW %I.messages ALTER COLUMN harness_slug SET DEFAULT %L', s, slug);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.messages TO harness_app, harness_admin', s);
    BEGIN EXECUTE format('GRANT SELECT ON %I.messages TO harness_zero', s); EXCEPTION WHEN OTHERS THEN NULL; END;

    -- ---- executed_actions ----
    IF EXISTS (SELECT 1 FROM information_schema.tables
                WHERE table_schema=s AND table_name='executed_actions' AND table_type='BASE TABLE') THEN
      IF EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema=s AND table_name='executed_actions' AND column_name='action_id') THEN
        EXECUTE format($q$
          INSERT INTO harness_shared.executed_actions_consolidated
            (workspace_id, harness_slug, action_id, op, caller_slug, target_slug,
             reason, request, response, executed_at)
          SELECT 'default', %2$L, action_id, op, caller_slug, target_slug,
                 reason, request, response, executed_at
            FROM %1$I.executed_actions
          ON CONFLICT (harness_slug, action_id) DO NOTHING
        $q$, s, slug);
      ELSE
        EXECUTE format('SELECT count(*) FROM %I.executed_actions', s) INTO n;
        IF n > 0 THEN RAISE EXCEPTION 'executed_actions in % has drifted shape AND % rows', s, n; END IF;
      END IF;
      EXECUTE format('DROP TABLE IF EXISTS %I.executed_actions CASCADE', s);
    END IF;
    EXECUTE format('DROP VIEW IF EXISTS %I.executed_actions CASCADE', s);
    EXECUTE format($v$
      CREATE VIEW %1$I.executed_actions AS
        SELECT * FROM harness_shared.executed_actions_consolidated
        WHERE harness_slug = %2$L WITH CHECK OPTION
    $v$, s, slug);
    EXECUTE format('ALTER VIEW %I.executed_actions ALTER COLUMN workspace_id SET DEFAULT %L', s, 'default');
    EXECUTE format('ALTER VIEW %I.executed_actions ALTER COLUMN harness_slug SET DEFAULT %L', s, slug);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.executed_actions TO harness_app, harness_admin', s);
    BEGIN EXECUTE format('GRANT SELECT ON %I.executed_actions TO harness_zero', s); EXCEPTION WHEN OTHERS THEN NULL; END;
  END LOOP;
END $mig$;

COMMIT;
