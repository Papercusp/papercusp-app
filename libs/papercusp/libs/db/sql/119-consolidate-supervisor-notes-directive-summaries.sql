-- Migration 119 — consolidate per-harness supervisor_notes + directive_summaries
-- → slug-keyed harness_shared.*_consolidated, replacing the per-harness physical
-- tables with auto-updatable VIEWs (032 pattern). Part of
-- harness-state-storage-unification-2026-06-01 P-004 (D-007: consolidate).
--
-- Reality (verified 2026-06-03): live data is in the OLD 002-template schemas
-- (TIMESTAMPTZ created_at, BIGSERIAL per-schema id, NO harness_slug column).
-- The bigint-shaped scaffold schemas (content/created_at-bigint) are zero-row.
--   * supervisor_notes  dominant: id BIGSERIAL, body, source, created_at tstz.
--   * directive_summaries dominant: id BIGSERIAL, directive_id, source('ceo'),
--     summary, caller_slug, created_at tstz.
-- Neither has a harness_slug column, and per-schema BIGSERIAL ids COLLIDE — so
-- the consolidated PK is (harness_slug, id) with a fresh global IDENTITY, and
-- created_at is coerced TIMESTAMPTZ→BIGINT epoch-ms (the consolidation standard).
-- Writers omit id+created_at(+harness_slug) on INSERT → view DEFAULTs fill them.
-- No app-code now()→ms fix needed (these tables have no explicit now() writer).
--
-- Idempotent: re-running finds views (not tables), skips backfill, recreates views.

\set ON_ERROR_STOP on
BEGIN;

-- ── consolidated base tables ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS harness_shared.supervisor_notes_consolidated (
  workspace_id text   NOT NULL DEFAULT 'default',
  harness_slug text   NOT NULL,
  id           bigint GENERATED ALWAYS AS IDENTITY,
  body         text   NOT NULL DEFAULT '',
  source       text   NOT NULL DEFAULT '',
  created_at   bigint NOT NULL,
  PRIMARY KEY (harness_slug, id)
);
CREATE INDEX IF NOT EXISTS supervisor_notes_consolidated_recent_idx
  ON harness_shared.supervisor_notes_consolidated (harness_slug, created_at DESC);

CREATE TABLE IF NOT EXISTS harness_shared.directive_summaries_consolidated (
  workspace_id text   NOT NULL DEFAULT 'default',
  harness_slug text   NOT NULL,
  id           bigint GENERATED ALWAYS AS IDENTITY,
  directive_id text   NOT NULL,
  source       text   NOT NULL DEFAULT 'ceo',
  summary      text   NOT NULL DEFAULT '',
  caller_slug  text,
  created_at   bigint NOT NULL,
  PRIMARY KEY (harness_slug, id)
);
CREATE INDEX IF NOT EXISTS directive_summaries_consolidated_recent_idx
  ON harness_shared.directive_summaries_consolidated (harness_slug, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON
  harness_shared.supervisor_notes_consolidated,
  harness_shared.directive_summaries_consolidated
  TO harness_app, harness_admin;
DO $g$ BEGIN
  GRANT SELECT ON harness_shared.supervisor_notes_consolidated,
                  harness_shared.directive_summaries_consolidated TO harness_zero;
EXCEPTION WHEN OTHERS THEN NULL; END $g$;

-- ── per-schema backfill + view-swap ─────────────────────────────────
DO $mig$
DECLARE
  s    TEXT;
  slug TEXT;
BEGIN
  FOR s IN
    SELECT schema_name FROM information_schema.schemata
     WHERE schema_name LIKE 'harness_%' AND schema_name <> 'harness_shared'
  LOOP
    slug := replace(substring(s FROM 9), '_', '-');

    -- supervisor_notes — backfill only the dominant (body/source) shape; the
    -- drifted bigint shape (content/created_at-bigint) is empty.
    IF EXISTS (SELECT 1 FROM information_schema.tables
                WHERE table_schema=s AND table_name='supervisor_notes' AND table_type='BASE TABLE') THEN
      IF EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema=s AND table_name='supervisor_notes' AND column_name='body') THEN
        EXECUTE format($q$
          INSERT INTO harness_shared.supervisor_notes_consolidated
            (workspace_id, harness_slug, body, source, created_at)
          SELECT 'default', %2$L, body, COALESCE(source,''),
                 (extract(epoch FROM created_at) * 1000)::bigint
            FROM %1$I.supervisor_notes
        $q$, s, slug);
      END IF;
      EXECUTE format('DROP TABLE IF EXISTS %I.supervisor_notes CASCADE', s);
    END IF;
    EXECUTE format('DROP VIEW IF EXISTS %I.supervisor_notes CASCADE', s);
    EXECUTE format($v$
      CREATE VIEW %1$I.supervisor_notes AS
        SELECT * FROM harness_shared.supervisor_notes_consolidated
        WHERE harness_slug = %2$L WITH CHECK OPTION
    $v$, s, slug);
    EXECUTE format('ALTER VIEW %I.supervisor_notes ALTER COLUMN workspace_id SET DEFAULT %L', s, 'default');
    EXECUTE format('ALTER VIEW %I.supervisor_notes ALTER COLUMN harness_slug SET DEFAULT %L', s, slug);
    EXECUTE format('ALTER VIEW %I.supervisor_notes ALTER COLUMN created_at SET DEFAULT (extract(epoch FROM now()) * 1000)::bigint', s);
    EXECUTE format('ALTER VIEW %I.supervisor_notes ALTER COLUMN body SET DEFAULT ''''', s);
    EXECUTE format('ALTER VIEW %I.supervisor_notes ALTER COLUMN source SET DEFAULT ''''', s);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.supervisor_notes TO harness_app, harness_admin', s);
    BEGIN EXECUTE format('GRANT SELECT ON %I.supervisor_notes TO harness_zero', s); EXCEPTION WHEN OTHERS THEN NULL; END;

    -- directive_summaries — backfill only the dominant (summary) shape.
    IF EXISTS (SELECT 1 FROM information_schema.tables
                WHERE table_schema=s AND table_name='directive_summaries' AND table_type='BASE TABLE') THEN
      IF EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema=s AND table_name='directive_summaries' AND column_name='summary') THEN
        EXECUTE format($q$
          INSERT INTO harness_shared.directive_summaries_consolidated
            (workspace_id, harness_slug, directive_id, source, summary, caller_slug, created_at)
          SELECT 'default', %2$L, directive_id, COALESCE(source,'ceo'), COALESCE(summary,''),
                 caller_slug, (extract(epoch FROM created_at) * 1000)::bigint
            FROM %1$I.directive_summaries
        $q$, s, slug);
      END IF;
      EXECUTE format('DROP TABLE IF EXISTS %I.directive_summaries CASCADE', s);
    END IF;
    EXECUTE format('DROP VIEW IF EXISTS %I.directive_summaries CASCADE', s);
    EXECUTE format($v$
      CREATE VIEW %1$I.directive_summaries AS
        SELECT * FROM harness_shared.directive_summaries_consolidated
        WHERE harness_slug = %2$L WITH CHECK OPTION
    $v$, s, slug);
    EXECUTE format('ALTER VIEW %I.directive_summaries ALTER COLUMN workspace_id SET DEFAULT %L', s, 'default');
    EXECUTE format('ALTER VIEW %I.directive_summaries ALTER COLUMN harness_slug SET DEFAULT %L', s, slug);
    EXECUTE format('ALTER VIEW %I.directive_summaries ALTER COLUMN source SET DEFAULT ''ceo''', s);
    EXECUTE format('ALTER VIEW %I.directive_summaries ALTER COLUMN summary SET DEFAULT ''''', s);
    EXECUTE format('ALTER VIEW %I.directive_summaries ALTER COLUMN created_at SET DEFAULT (extract(epoch FROM now()) * 1000)::bigint', s);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.directive_summaries TO harness_app, harness_admin', s);
    BEGIN EXECUTE format('GRANT SELECT ON %I.directive_summaries TO harness_zero', s); EXCEPTION WHEN OTHERS THEN NULL; END;
  END LOOP;
END $mig$;

COMMIT;
