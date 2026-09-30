-- 1155: forward-safe re-apply of the lock-bounded prose-profile migration.
--
-- Migration 1154 was applied to the shared database at 2026-09-13T06:23:09Z
-- with recorded sha256
--   6c34b9014272387faa172be6c8bc4946e586f809746b4cb64a2f0ff361fd5dcd
-- and was then changed executably to current sha256
--   b48510177581764476ac602958e6ec26b5ef45d8ac6614d64662dd1647bc8bc8
-- after a live boot attempt proved the original transaction shape unsafe.
-- The original held four work-item compatibility views while waiting for an
-- unrelated hot table; a normal reader completed the inverse wait graph and
-- PostgreSQL reported 55P03 lock timeouts followed by a real 40P01 deadlock.
-- Request-only startup refuses a pending migration, so systemd exhausted its
-- restart burst and :3170 disappeared (EI-23124585951651029).
--
-- Editing an applied migration does not re-run it. This immutable successor is
-- therefore the durable reconciliation: it expresses the corrected 1154 end
-- state as idempotent singleton transactions, preserving explicit identities
-- and leaving legacy NULL profiles untouched. A database that already ran the
-- first 1154 converges safely; one that first sees the corrected 1154 applies
-- this as a no-op verification pass. The corrected 1154 stays in place so a
-- deployment that has not reached it never executes the unsafe transaction.
--
-- EXPAND-ONLY / OLD-BINARY SAFE. No vector is deleted or recomputed here. New
-- writers stamp exact profile identity; the resumable backfill re-embeds only
-- rows whose identity cannot be mapped safely.

-- Each unrelated hot table is deliberately its own runner transaction. Prior
-- chunks may commit, the migration ledger is written only with the last chunk,
-- and every statement below is idempotent for safe retry.
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
      RAISE EXCEPTION '1155 could not append embedding_profile to %', view_name;
    END IF;
    EXECUTE format('CREATE OR REPLACE VIEW %s AS %s', view_name, rewritten);
  END LOOP;
END
$views$;

COMMENT ON COLUMN harness_shared.work_items.embedding_profile IS
  'Exact versioned identity of the embedding space stored in embedding. NULL is legacy and may map from embedding_mode only to that mode''s declared current profile.';
