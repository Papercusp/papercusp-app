-- 057-expert-assertions.sql
--
-- Add `assertions_content` column to harness_shared.harness_experts.
--
-- Until this migration, experts produced only SPEC.md (`spec_content`)
-- and the scoper(phase2) re-derived validation-contract assertions
-- from prose. That gave the scoper too much interpretive latitude —
-- the assertions ended up reflecting the scoper's reading rather than
-- the expert's intent.
--
-- With this column, experts emit an explicit assertion list during
-- finalization (same format as `.harness/validation-contract.md`).
-- The phase-2 scoper merges those assertions verbatim instead of
-- inventing its own. Workers + validators see the expert's actual
-- success criteria.
--
-- Backward compat: column defaults to '' (empty). Existing experts
-- that finalize without writing assertions cause the scoper to fall
-- back to its prior behavior (re-derive from SPEC.md).

ALTER TABLE "harness_shared"."harness_experts"
  ADD COLUMN IF NOT EXISTS "assertions_content" text NOT NULL DEFAULT '';
