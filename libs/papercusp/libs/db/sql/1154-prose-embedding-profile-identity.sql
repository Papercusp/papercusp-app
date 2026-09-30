-- 1154: exact, versioned embedding-space identity for every shared prose vector.
--
-- `*_mode` is retained as a compatibility/readability projection, but it is no
-- longer sufficient to establish that two vectors are comparable: a model,
-- revision, normalization, metric, or input-recipe change can preserve both
-- mode and width while minting a different space. New writers stamp
-- `*_profile`; readers select that exact identity. During rolling upgrade a
-- NULL profile may be interpreted from `*_mode` only when it names that mode's
-- declared CURRENT profile (versioned-embedding-profiles-2026-09-12 D-002).
--
-- EXPAND-ONLY / OLD-BINARY SAFE. No vector is deleted or recomputed here, and
-- existing profile identity deliberately stays NULL. Runtime compatibility
-- maps a NULL profile from `*_mode` only to that mode's declared CURRENT
-- profile, so rewriting the live corpus here would add no information while
-- holding ACCESS EXCLUSIVE for the duration of a potentially multi-million-row
-- UPDATE. New writers stamp exact identity; the resumable backfill re-embeds
-- only rows whose identity cannot be mapped safely. The prior release ignores
-- the added columns and keeps serving.

-- Each unrelated hot table is deliberately its own runner transaction. The
-- first armed version held all four work-item compatibility views while it
-- waited for session_turns, and a normal reader holding session_turns then
-- queued on engineer_issues: PostgreSQL reported a real 40P01 deadlock after
-- the earlier 55P03 lock-timeout attempts. The established Drizzle/test-config
-- `statement-breakpoint` marker now has identical production-runner semantics:
-- prior chunks may commit, the migration ledger is written only with the last
-- chunk, and every statement below is idempotent for safe retry.
--
-- Two older refill-only surfaces never had the mode discriminator. ADD it in
-- the same singleton transaction as the exact profile column; existing vectors
-- deliberately remain identity-unknown.
ALTER TABLE IF EXISTS harness_shared.session_turns
  ADD COLUMN IF NOT EXISTS text_embedding_mode text,
  ADD COLUMN IF NOT EXISTS text_embedding_profile text;
--> statement-breakpoint
ALTER TABLE IF EXISTS harness_shared.session_turn_chunks
  ADD COLUMN IF NOT EXISTS embedding_mode text,
  ADD COLUMN IF NOT EXISTS embedding_profile text;
--> statement-breakpoint
ALTER TABLE IF EXISTS harness_shared.operator_turns
  ADD COLUMN IF NOT EXISTS text_embedding_mode text,
  ADD COLUMN IF NOT EXISTS text_embedding_profile text;
--> statement-breakpoint
ALTER TABLE IF EXISTS harness_shared.doc_sections
  ADD COLUMN IF NOT EXISTS embedding_mode text,
  ADD COLUMN IF NOT EXISTS embedding_profile text;
--> statement-breakpoint
ALTER TABLE IF EXISTS harness_shared.harness_docs
  ADD COLUMN IF NOT EXISTS embedding_mode text,
  ADD COLUMN IF NOT EXISTS embedding_profile text;
--> statement-breakpoint
ALTER TABLE IF EXISTS harness_shared.harness_plans
  ADD COLUMN IF NOT EXISTS embedding_mode text,
  ADD COLUMN IF NOT EXISTS embedding_profile text;
--> statement-breakpoint
ALTER TABLE IF EXISTS harness_shared.harness_escalations
  ADD COLUMN IF NOT EXISTS body_embedding_mode text,
  ADD COLUMN IF NOT EXISTS body_embedding_profile text;
--> statement-breakpoint
ALTER TABLE IF EXISTS harness_shared.harness_brainstorm
  ADD COLUMN IF NOT EXISTS content_embedding_mode text,
  ADD COLUMN IF NOT EXISTS content_embedding_profile text;
--> statement-breakpoint
ALTER TABLE IF EXISTS harness_shared.harness_decisions
  ADD COLUMN IF NOT EXISTS body_embedding_mode text,
  ADD COLUMN IF NOT EXISTS body_embedding_profile text;
--> statement-breakpoint
ALTER TABLE IF EXISTS harness_shared.code_recipes
  ADD COLUMN IF NOT EXISTS embedding_mode text,
  ADD COLUMN IF NOT EXISTS embedding_profile text;
--> statement-breakpoint
ALTER TABLE IF EXISTS harness_shared.datatype_registry
  ADD COLUMN IF NOT EXISTS embedding_mode text,
  ADD COLUMN IF NOT EXISTS embedding_profile text;
--> statement-breakpoint
ALTER TABLE IF EXISTS harness_shared.personal_documents
  ADD COLUMN IF NOT EXISTS embedding_mode text,
  ADD COLUMN IF NOT EXISTS embedding_profile text;
--> statement-breakpoint
ALTER TABLE IF EXISTS harness_shared.consult_state
  ADD COLUMN IF NOT EXISTS query_embedding_mode text,
  ADD COLUMN IF NOT EXISTS query_embedding_profile text;
--> statement-breakpoint
ALTER TABLE IF EXISTS harness_shared.interest_watches
  ADD COLUMN IF NOT EXISTS embedding_mode text,
  ADD COLUMN IF NOT EXISTS embedding_profile text;
--> statement-breakpoint
ALTER TABLE IF EXISTS harness_shared.carry_notes
  ADD COLUMN IF NOT EXISTS note_embedding_mode text,
  ADD COLUMN IF NOT EXISTS note_embedding_profile text;
--> statement-breakpoint
ALTER TABLE IF EXISTS harness_shared.coord_thread_posts
  ADD COLUMN IF NOT EXISTS body_embedding_mode text,
  ADD COLUMN IF NOT EXISTS body_embedding_profile text;
--> statement-breakpoint

-- This final chunk is the one genuinely coupled relation family. Readers
-- acquire nested compatibility views from the outside in, then work_items, so
-- take that same order before ALTER TABLE and keep the view rewrites atomic
-- with the base-column addition (the migration-721 invariant).
LOCK TABLE harness_shared.harness_features IN ACCESS EXCLUSIVE MODE;
LOCK TABLE harness_shared.harness_features_consolidated IN ACCESS EXCLUSIVE MODE;
LOCK TABLE harness_shared.work_items_claimable IN ACCESS EXCLUSIVE MODE;
LOCK TABLE harness_shared.engineer_issues IN ACCESS EXCLUSIVE MODE;
LOCK TABLE harness_shared.work_items IN ACCESS EXCLUSIVE MODE;

-- lint-migrations: dynamic-view-lock-order all four compatibility views are locked outside-in before work_items and before the dynamic view rewrite

ALTER TABLE IF EXISTS harness_shared.work_items
  ADD COLUMN IF NOT EXISTS embedding_mode text,
  ADD COLUMN IF NOT EXISTS embedding_profile text;

-- Append work_items.embedding_profile to the canonical compatibility views
-- without restating their large, independently evolving column lists. The
-- current definition comes from PostgreSQL itself; CREATE OR REPLACE preserves
-- every existing column and appends exactly one new one, which is allowed while
-- dependent views remain live. A failed rewrite aborts the migration loudly.
DO $views$
DECLARE
  view_name text;
  definition text;
  rewritten text;
BEGIN
  FOREACH view_name IN ARRAY ARRAY[
    'harness_shared.harness_features_consolidated',
    'harness_shared.harness_features',
    'harness_shared.work_items_claimable',
    'harness_shared.engineer_issues'
  ]
  LOOP
    IF to_regclass(view_name) IS NULL THEN
      CONTINUE;
    END IF;
    SELECT pg_get_viewdef(view_name::regclass, true) INTO definition;
    IF definition ~ '\membedding_profile\M' THEN
      CONTINUE;
    END IF;

    -- Every canonical definition has a single outer ` FROM `; append the base
    -- column immediately before it. For harness_features (which reads the
    -- consolidated view), that source already gained the appended column in
    -- the preceding iteration.
    rewritten := regexp_replace(
      definition,
      E'\\s+FROM\\s+',
      E', embedding_profile\n  FROM ',
      'i'
    );
    IF rewritten = definition THEN
      RAISE EXCEPTION '1154 could not append embedding_profile to %', view_name;
    END IF;
    EXECUTE format('CREATE OR REPLACE VIEW %s AS %s', view_name, rewritten);
  END LOOP;
END
$views$;

COMMENT ON COLUMN harness_shared.work_items.embedding_profile IS
  'Exact versioned identity of the embedding space stored in embedding. NULL is legacy and may map from embedding_mode only to that mode''s declared current profile.';
