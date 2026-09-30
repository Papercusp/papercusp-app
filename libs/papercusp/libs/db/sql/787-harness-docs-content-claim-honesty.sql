-- 787 — harness_docs: make the content/content_mode/frontmatter column comments
-- state what is actually true. Comments only; no DDL, no data change.
--
-- WHY (EI-20059518283492409). These three comments declared a contract that no
-- writer has ever honoured, and the DEFAULTS made every row assert it silently:
--
--   content       NOT NULL DEFAULT ''::text
--   content_mode  NOT NULL DEFAULT 'authored'::text
--
-- `upsertDocRecord` (packages/operator-core/lib/harness/docs/doc-record.ts) is the
-- writer for every non-composed doc, and its INSERT column list names none of
-- content / frontmatter / content_mode. So a row takes content='' and
-- content_mode='authored' by default — i.e. it declares itself "content
-- canonical" precisely BECAUSE the writer had no opinion about content at all.
-- A default value cannot assert a contract; only a writer can.
--
-- MEASURED 2026-08-10, table-wide across ALL tenants (no workspace/harness
-- predicate — the question was "does any writer anywhere populate this"):
--   content_mode='authored': 952 rows — content<>'': 0, frontmatter NOT NULL: 0, content_hash<>'': 0
--   content_mode='composed':   1 row  — content<>'': 1, frontmatter NOT NULL: 0, content_hash<>'': 1
-- The `authored` half of the vocabulary has never been populated by anything, and
-- `frontmatter` is NULL for all 953 rows including the composed one.
--
-- The prose for an authored doc lives in its .mdx file on disk; harness_docs
-- tracks that file's METADATA (subject_ref, anchor_paths, status, title, overlay),
-- which is genuinely populated (669/716 agent-insights rows carry subject_ref +
-- anchor_paths). harness_docs:list serves the FILE body — merged-read.ts reads it
-- via readDocBody/fs.readFile and never reads this column.
--
-- This corrects the DECLARATION to match reality. It deliberately does NOT decide
-- whether PG should hold doc prose at all — that is the open direction-of-truth
-- fork D-023 on plan claude-md-projection-from-pg-2026-08-10, and it is the
-- owner's to settle. If it is settled toward PG-canonical prose, the migration
-- that populates content updates these comments with it.
--
-- Guard against re-drift: packages/operator-core/lib/harness/docs/doc-record-content-claim.test.ts
-- fails if upsertDocRecord starts (or stops) writing these columns, so the claim
-- below cannot go stale silently.

COMMENT ON COLUMN harness_shared.harness_docs.content IS
  'Doc prose. WRITTEN ONLY BY THE COMPOSED PROJECTOR PATH (content_mode=''composed'': CLAUDE.md / AGENTS.md, loaded by scripts/load-claude-md-doc-parts.mjs, where harness_doc_parts is canonical and this is the projector''s cached output). For content_mode=''authored'' NO WRITER POPULATES THIS — upsertDocRecord''s INSERT omits it, so the row takes the '''' default and the prose lives in the doc''s .mdx file on disk (harness_docs:list serves that file, not this column). Measured 2026-08-10 table-wide: 0 of 952 authored rows hold content. Do not read this column as a doc body without checking content_mode first.';

COMMENT ON COLUMN harness_shared.harness_docs.content_mode IS
  'Direction of truth (D-010). composed = harness_doc_parts is canonical and `content` is this projector''s output (CLAUDE.md / AGENTS.md); this value is set explicitly by the projector loader and is the only mode whose content is written. authored = NOT COMPOSED — it is the column DEFAULT, taken by every row upsertDocRecord creates, and it does NOT assert that `content` holds the prose (it never does today: 0 of 952 authored rows, measured 2026-08-10 table-wide). Whether authored docs should become genuinely content-canonical is the open fork D-023 on plan claude-md-projection-from-pg-2026-08-10.';

COMMENT ON COLUMN harness_shared.harness_docs.frontmatter IS
  'Derived index of parsed frontmatter. NOT POPULATED BY ANY WRITER TODAY — NULL for all 953 rows including the composed one (measured 2026-08-10 table-wide). The intended contract (recompute from content on write, mirroring the harness_plans.items shape) has never been implemented; parse the .mdx file''s frontmatter instead of reading this column.';
