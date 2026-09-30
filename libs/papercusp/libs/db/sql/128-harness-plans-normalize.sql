-- Migration 128 — Stage 3 normalize: structured derived-index columns on harness_plans.
--
-- Plan: plans-pg-canonical-migration-2026-06-03 (Stage 3, D-006).
--
-- The queryable sections — items, decisions, and the `## Now` state/next — become
-- a DERIVED INDEX in columns so SQL can query them without parsing the blob (e.g.
-- "plans with a needs-human item"). The prose body stays canonical in `content`
-- (D-006): these columns are recomputed from the parsed `content` on every write
-- (with-plan-lock) and by the backfill — never an independent source of truth.
-- The renderPlanMarkdown round-trip (libs/generic/plan-parser, 213/213 over the
-- real corpus) proves the items/decisions/now representation is lossless.
--
-- Additive + nullable → safe to apply before the code that populates/reads them
-- (old code ignores the new columns; items unread until backfilled fall back to
-- parsing the blob).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.

\set ON_ERROR_STOP on
BEGIN;

ALTER TABLE harness_shared.harness_plans
  ADD COLUMN IF NOT EXISTS items jsonb,        -- [{id,status,text,importance,blockedBy,decisionRefs,phase}]
  ADD COLUMN IF NOT EXISTS decisions jsonb,    -- [{id,title,body,date,itemRefs}]
  ADD COLUMN IF NOT EXISTS now_state text,     -- ## Now **State:**
  ADD COLUMN IF NOT EXISTS now_next text;      -- ## Now **Next:**

COMMENT ON COLUMN harness_shared.harness_plans.items IS
  'Derived index of parsed plan items (recomputed from content on write; content is canonical, D-006).';

COMMIT;
