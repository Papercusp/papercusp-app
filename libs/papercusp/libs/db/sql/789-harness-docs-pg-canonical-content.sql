-- 789 — harness_docs: PG becomes CANONICAL for authored doc prose (P-008 / D-025).
-- Comments only; no DDL, no data change. See "where the data comes from" below.
--
-- WHAT CHANGED SINCE 787. Migration 787 (same day) corrected these three comments to
-- state what was then true: no writer populated content / frontmatter / content_mode for
-- content_mode='authored', so a row took content='' and content_mode='authored' by
-- DEFAULT and thereby asserted a contract the writer never evaluated. 787 deliberately
-- did not settle whether PG *should* hold doc prose, and said so:
--
--     "If it is settled toward PG-canonical prose, the migration that populates
--      content updates these comments with it."
--
-- It was settled, by the owner, on 2026-08-10 (D-025 on plan
-- claude-md-projection-from-pg-2026-08-10): a full inversion, mimicking how plans already
-- work. This is that migration. The standing rule it applies is D-004 (2026-08-09):
-- canonical is ALWAYS PG, and a filesystem projection exists IFF there is a reader we do
-- not control.
--
-- WHY A FILE STILL EXISTS, unlike plans. Plans are PG-only and have no file at all, which
-- is *why* agents never hand-edit them — there is nothing to hand-edit. Docs cannot reach
-- that end state: docs:search's lexical/BM25 leg reads the filesystem and the Starlight
-- site builds from it (D-022), so the committed .mdx must survive. It is therefore a
-- PROJECTION of this column, and D-003's overwrite-as-enforcement substitutes for the
-- impossibility plans get for free.
--
-- WHERE THE DATA COMES FROM — deliberately NOT from this file. Populating `content`
-- means reading ~672 .mdx files, which SQL cannot do; embedding them here would put a
-- copy of the corpus in a migration. The one-time ingest is
-- `node scripts/project-authored-docs.mjs --ingest`, and the reverse (PG → .mdx) is the
-- same script's default direction. That script is also the guard: the file → PG direction
-- REFUSES any row that already holds content unless --reconcile is passed, because after
-- the cutover an ingest is exactly the move that would let a hand-edit to a projected file
-- silently become canonical.
--
-- HOW THESE COMMENTS ARE KEPT HONEST. The claim below is about the WRITER's contract, not
-- about a measured row count, because a row count goes stale the moment a doc is added.
-- packages/operator-core/lib/harness/docs/doc-record-content-claim.test.ts pins it to
-- upsertDocRecord and fails in BOTH directions: if the writer stops populating these
-- columns, and if it starts writing content_mode. That guard was inverted in the same
-- commit as this migration — it previously pinned 787's opposite claim.

COMMENT ON COLUMN harness_shared.harness_docs.content IS
  'CANONICAL doc prose (P-008 / D-025, 2026-08-10). Holds the WHOLE authored document — YAML frontmatter included — exactly as authored. For content_mode=''authored'' this column is the source of truth and the doc''s .mdx file under the harness docs root is a PROJECTION of it, written by scripts/project-authored-docs.mjs; a hand-edit to that file is REFUSED by the next projection (it cannot be distinguished from corruption) and never becomes canonical. For content_mode=''composed'' (CLAUDE.md / AGENTS.md) this is instead the cached output of scripts/project-doc-parts.mjs, where harness_doc_parts is canonical — so still check content_mode before interpreting this column. Written by upsertDocRecord (packages/operator-core/lib/harness/docs/doc-record.ts), which leaves it untouched when a caller supplies no content, so a metadata-only upsert can never blank the prose.';

COMMENT ON COLUMN harness_shared.harness_docs.content_mode IS
  'Direction of truth (D-010). composed = harness_doc_parts is canonical and `content` is the projector''s cached output (CLAUDE.md / AGENTS.md), set explicitly by scripts/load-claude-md-doc-parts.mjs. authored = `content` is canonical and the .mdx file on disk is the projection (P-008 / D-025); this is the column default. BOTH modes now assert something real about `content` — which is the change from 787, where ''authored'' asserted nothing because no writer had an opinion. upsertDocRecord NEVER writes this column: it only ever reads it, to refuse writing prose into a composed row and corrupting the parts projector''s cache. That read-not-write asymmetry is pinned by doc-record-content-claim.test.ts.';

COMMENT ON COLUMN harness_shared.harness_docs.frontmatter IS
  'DERIVED index of the doc''s parsed YAML frontmatter, recomputed from `content` on every write by upsertDocRecord (the contract 787 recorded as never-implemented; P-008 implemented it). Derived, never a source: the frontmatter is authored INSIDE `content` and is projected back verbatim, so this column is safe to query and must never be edited to change a doc — a write here does not reach the file. Dates are indexed as the STRINGS the file states (js-yaml CORE_SCHEMA), not coerced to timestamps, so `discovered: 2026-08-10` round-trips as ''2026-08-10'' rather than a timezone-bearing instant the doc never claimed. NULL when the doc has no frontmatter, or when its frontmatter does not parse — a parse failure costs the index, never the prose.';

COMMENT ON COLUMN harness_shared.harness_docs.content_hash IS
  'sha256 of `content`, computed by the writer alongside it so the two cannot drift — a caller cannot update one and forget the other. For content_mode=''authored'' this is what scripts/project-authored-docs.mjs compares a file on disk against to decide whether those bytes are still the canonical text (modulo its own generated banner, which is NOT part of `content`) or somebody edited the file. For content_mode=''composed'' it is the hash of the cached composition; see projected_clients for the per-client equivalent.';
