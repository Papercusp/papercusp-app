-- 814-harness-docs-retired-at.sql
--
-- P-009 of plan claude-md-projection-from-pg-2026-08-10.
--
-- WHY THIS COLUMN EXISTS, stated plainly so nobody has to rediscover it:
--
-- Until now, WHETHER AN AUTHORED DOC IS STILL LIVE WAS NOT RECORDED ANYWHERE IN
-- POSTGRES. It was inferred from the FILESYSTEM: `scripts/project-authored-docs.ts`
-- walks the docs root, and any `harness_docs` row with no corresponding file is
-- reported as "orphan rows — deleted docs; left alone". Measured 2026-08-12:
-- 928 authored rows against 874 files, so 54 rows were being classified as deleted
-- purely by their absence from disk.
--
-- `status` CANNOT substitute for this and must not be pressed into the role. It is a
-- FRESHNESS/verification axis (fresh|stale|review|untracked|unknown) and it does not
-- correlate with lifecycle in either direction. Measured on the live table, same day:
--
--     agent-insights/live-pg-regression-sentinel.mdx   DELETED   status=review
--     testing/agent-e2e.mdx                            LIVE      status=review
--     reference/tool-catalog.md                        DELETED   status=fresh
--     system/learning-packs.mdx                        DELETED   status=unknown
--
-- Two docs with the same status and opposite lifecycles; a deleted doc sitting at
-- 'fresh'. Any code that reads `status` as "is this doc still real" is wrong today.
--
-- WHAT CHANGES, AND WHY IT IS URGENT RATHER THAN TIDY. P-009 makes the docs corpus an
-- EPHEMERAL build-time projection (D-004: canonical is PG; a filesystem projection
-- exists only for a reader we do not control). Once the corpus is no longer committed,
-- FILE ABSENCE STOPS MEANING ANYTHING — every doc is absent until the build writes it.
-- The single oracle that currently distinguishes the 874 live docs from the 54 dead
-- ones is the working tree, and untracking the corpus DESTROYS it. So liveness has to
-- be captured into PG while the files still exist; doing it in the other order leaves
-- git archaeology as the only way to recover which docs were deliberately deleted.
--
-- SEMANTICS. NULL = live (the default, and correct for every existing row until the
-- backfill runs). Non-NULL = retired: the doc was deliberately removed, and a
-- materializer MUST NOT write it back to disk. This is a soft delete on purpose —
-- the prose is kept so a retired doc stays searchable and recoverable, exactly as the
-- rows for those 54 docs are today.
--
-- BACKFILL IS DELIBERATELY NOT IN THIS FILE. Deciding which rows are retired requires
-- reading the filesystem, and a migration cannot. It runs as a one-time projector mode
-- (`project-authored-docs.ts --retire-orphans`) while the tree is still authoritative.
-- Leaving every row live here is the safe default: a doc wrongly left live is visible
-- and fixable, whereas a doc wrongly retired silently vanishes from the site.
--
-- Additive only: a nullable ADD COLUMN plus a partial index. No destructive DDL, so no
-- FORWARD-COMPAT acknowledgment is required — the currently-deployed release simply
-- does not select this column, and every existing query keeps its meaning.

ALTER TABLE harness_shared.harness_docs
  ADD COLUMN IF NOT EXISTS retired_at timestamptz NULL;

ALTER TABLE harness_shared.harness_docs
  ADD COLUMN IF NOT EXISTS retired_reason text NULL;

COMMENT ON COLUMN harness_shared.harness_docs.retired_at IS
  'Lifecycle marker (P-009, migration 814). NULL = the doc is LIVE. Non-NULL = it was '
  'deliberately removed and a materializer must NOT project it back to disk. Before this '
  'column, liveness was inferred from FILE PRESENCE by scripts/project-authored-docs.ts '
  '("orphan rows ... deleted docs; left alone" — 928 rows vs 874 files on 2026-08-12), an '
  'oracle that stops existing once the corpus becomes an ephemeral build-time projection. '
  'Do NOT use `status` for this: it is a freshness axis (fresh|stale|review|untracked|'
  'unknown) that does not correlate with lifecycle — measured the same day, a deleted doc '
  'sat at status=fresh while a live doc and a deleted doc both sat at status=review. This '
  'is a SOFT delete: `content` is retained so a retired doc stays searchable and '
  'recoverable.';

COMMENT ON COLUMN harness_shared.harness_docs.retired_reason IS
  'Free text explaining why the doc was retired (P-009, migration 814). Set alongside '
  'retired_at. The one-time backfill records that the row was retired because it had no '
  'file on disk while the working tree was still the authoritative oracle, so a later '
  'reader can tell a backfilled retirement from a deliberate one made afterwards.';

-- Live authored docs are the hot read (the materializer selects exactly this set on
-- every build), and after the backfill the retired rows are a small, permanently-growing
-- minority. A partial index keeps that scan proportional to the LIVE corpus rather than
-- to every doc ever written.
CREATE INDEX IF NOT EXISTS harness_docs_live_authored_idx
  ON harness_shared.harness_docs (workspace_id, harness_slug)
  WHERE retired_at IS NULL AND content_mode = 'authored';
