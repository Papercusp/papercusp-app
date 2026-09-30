-- Migration 134 — harness_shared.snapshot_index: the PG discovery index for
-- portable export-state snapshots (the hybrid FS+PG snapshot home).
--
-- Plan: harness-blueprint-distribution-2026-06-03 (P-006 / D-010).
--
-- WHAT THIS IS: export-state snapshots are immutable `.tar.gz` blobs on the
-- filesystem (`<project>/.papercusp/snapshots/snap_*.tar.gz`; pre-rename
-- `.harness/snapshots/`). Discovery was an FS-walk that `tar -xzO`'d every
-- manifest. This table is the PG INDEX (one row per tarball) so discovery is a
-- query, not a walk — the tarball stays the blob (hybrid home, D-010). The row
-- is written when a snapshot is created; an FS-reconcile sweep backfills rows
-- for tarballs that predate the index.
--
-- WHAT THIS IS NOT: the legacy `harness_shared.harness_snapshots` /
-- `harness_snapshots_consolidated` tables are a SEPARATE, older "iteration
-- snapshot" concept (features_json / validation_md / iter_num), trigger-fed and
-- git-exported (harness-state/git-export/serialize.ts). They are unrelated to
-- export-state tarballs and are intentionally left in place — do NOT conflate.
--
-- NEVER CAPTURED: this index is operator-local discovery metadata, not portable
-- per-harness state — it is registered as an `exclude` in SHARED_TABLE_FILTERS
-- (libs/papercusp-export-state/src/shared-table-filters.ts).
--
-- Idempotent: CREATE TABLE / INDEX IF NOT EXISTS; DROP POLICY IF EXISTS before
-- CREATE; repeatable GRANTs. Composes onto 000-baseline.sql for fresh/embedded-pg
-- boots and applies cleanly on the native :5432 dev box.

\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS harness_shared.snapshot_index (
    workspace_id   text   NOT NULL,
    harness_slug   text   NOT NULL,
    -- The snapshot id (the tarball basename without .tar.gz, e.g. 'snap_...').
    snapshot_id    text   NOT NULL,
    -- Absolute (or project-relative) path to the immutable tarball blob on the
    -- filesystem. Opaque text — survives the .harness→.papercusp path rename.
    tarball_path   text   NOT NULL,
    -- Compressed tarball size in bytes + its sha256 (the sidecar digest), for
    -- integrity + cheap listing without stat-ing the file.
    bytes          bigint NOT NULL DEFAULT 0,
    content_hash   text,
    -- manifest.createdAt (unix ms) — the snapshot's logical creation time, used
    -- for the discovery sort (newest first).
    created_at_ms  bigint NOT NULL DEFAULT 0,
    name           text,
    description    text,
    license        text,
    -- The full snapshot manifest (manifest.json), so discovery renders rich
    -- detail without re-tar-ing the blob.
    manifest       jsonb  NOT NULL DEFAULT '{}'::jsonb,
    -- Publish history (mirrors the legacy `<id>.published.json` sidecar).
    published      jsonb  NOT NULL DEFAULT '[]'::jsonb,
    indexed_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, harness_slug, snapshot_id)
);

COMMENT ON TABLE harness_shared.snapshot_index IS
    'PG discovery index for portable export-state snapshots (FS tarball blob + PG index row = the hybrid home, harness-blueprint-distribution-2026-06-03 D-010). Operator-local; never captured into a snapshot. Distinct from the legacy iteration-snapshot tables harness_snapshots(_consolidated).';

-- Discovery hot-path: list a harness's snapshots newest-first.
CREATE INDEX IF NOT EXISTS snapshot_index_recent_idx
    ON harness_shared.snapshot_index USING btree (workspace_id, harness_slug, created_at_ms DESC);

-- Workspace isolation, mirroring harness_shared.blueprints (migration 133). The
-- operator connects as a SUPERUSER role (harness_admin) which bypasses RLS; the
-- policy keeps any non-superuser path workspace-scoped.
ALTER TABLE harness_shared.snapshot_index ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS snapshot_index_workspace_isolation ON harness_shared.snapshot_index;
CREATE POLICY snapshot_index_workspace_isolation ON harness_shared.snapshot_index
    USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
    WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.snapshot_index TO harness_app;
GRANT SELECT ON harness_shared.snapshot_index TO harness_zero;

COMMIT;
