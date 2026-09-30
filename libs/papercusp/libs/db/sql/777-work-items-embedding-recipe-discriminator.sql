-- Migration 777 — TEXT-RECIPE discriminator for the embed sweep, on
-- harness_shared.work_items (P-026 of
-- context-injection-retrieval-reach-and-visibility-2026-08-03, ruling D-087).
--
-- WHY. `embed-backfill.ts`'s staleness predicate is
--   `<embedCol> IS NULL OR <embedCol>_mode IS DISTINCT FROM <active mode>`
-- which discriminates the EMBEDDER SPACE and nothing else. It carries no notion
-- of WHICH TEXT produced the vector, so editing a target's `bodySql` marks
-- NOTHING stale: only rows embedded after the edit get the new recipe, and the
-- ~36.5k already-vectorised work-items keep the old one forever — two
-- populations in one column, indistinguishable at query time. That makes every
-- index-side expansion (D-086 §6.3 Tier 0 ref-title expansion is the immediate
-- one) unshippable, because shipping it would improve only rows written from
-- then on.
--
-- ⚠ WHY THIS IS A SIBLING COLUMN AND NOT A WIDENED `embedding_mode` — the part
-- that looks like needless ceremony until you audit the consumers. D-086 §6.3
-- lists "fold a recipe version into the existing *_mode token" FIRST, and it is
-- genuinely ~5 lines with no migration at all. It was built, and a consumer
-- audit measured it UNSAFE: `*_mode` is not private to the sweep. Four
-- query-time readers EQUALITY-MATCH it —
--   packages/operator-core/lib/agent-tools/work-items.ts:1256 and :1318
--     (the work_item semantic leg)
--   packages/operator-core/lib/agent-tools/plans/semantic-leg.ts:77
--   packages/operator-core/lib/search/doc-section-overlap.ts:179 and :213
-- — so bumping work_items to a composite token (`gemma#r2`) stores a value none
-- of them match. They do not error: they return ZERO rows, the semantic leg goes
-- quiet, and the corpus leg silently degrades to lexical-only. Invisible to
-- types, invisible to tests. Prefix-matching (`split_part(embedding_mode,'#',1)`)
-- is not a rescue either — non-sargable on hot per-query filters, trading a
-- silent outage for a silent index regression.
--
-- Two independent axes (embedder space / text recipe) therefore get two columns.
-- A recipe bump must be visible ONLY to the sweep and invisible to every
-- query-time consumer, and a separate column is what makes that true by
-- construction rather than by everyone remembering.
--
-- SEMANTICS. NULL means "embedded before this discriminator existed", which is
-- by definition recipe 1 — the recipe in force at this migration. The sweep
-- reads it as `coalesce(embedding_recipe, 1)`, so introducing the column marks
-- nothing stale and re-embeds NOTHING. Only a deliberate `recipeVersion` bump on
-- the BackfillTarget (paired with the bodySql edit that motivated it) makes the
-- existing population stale. That re-embed is ~36.5k rows ≈ 2.2h of sidecar at
-- the measured ~0.22s/text — real, but per-target and opted into.
--
-- SCOPE. work_items ONLY, deliberately. The sweep probes for this column per
-- target exactly as it already probes migration 530's `<embedCol>_mode`, so a
-- table without it degrades to today's behaviour instead of throwing. Ship the
-- surface with the highest ref density first (work_items 41.0%; session_turns is
-- 17.1% at ~8x the re-embed cost) and measure the delta before extending.
--
-- Additive and nullable: no table rewrite, no default, no backfill, and nothing
-- currently deployed reads the column — so this is safe to apply ahead of the
-- code that uses it.

ALTER TABLE harness_shared.work_items
  ADD COLUMN IF NOT EXISTS embedding_recipe smallint;

COMMENT ON COLUMN harness_shared.work_items.embedding_recipe IS
  'Text-recipe version of the text that produced `embedding` (embed-backfill BackfillTarget.recipeVersion). NULL = pre-discriminator, read as recipe 1. Bumping the declared version re-embeds the whole surface. Deliberately SEPARATE from embedding_mode (the embedder SPACE), which four query-time readers equality-match — see migration 777''s header and plan decision D-087.';
