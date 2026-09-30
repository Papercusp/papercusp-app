-- Migration 284 — harness_plans.initiative (shared-hive-collaboration-2026-06-14
-- P-015, D-002/D-015).
--
-- A single free-text `initiative` label on a plan that groups related plans,
-- surfaced as a filter facet in the my/others/all saved-views (P-002). Grouping
-- is ONE metadata field — explicitly NOT a branch/worktree/PR-hierarchy model.
--
-- A derived frontmatter-index column mirroring `owner`: recomputed from the
-- plan's canonical `content` frontmatter on every write (deriveIndexFromContent),
-- so `plans:list` stays parse-free (audit P-042). Federates the same way every
-- other scalar does — it rides the `content` change that always accompanies an
-- initiative edit, and the per-part recompose / whole-blob projection re-derive
-- it from the recomposed frontmatter on the receive side.
--
-- Nullable, additive — plans without an initiative stay NULL.
--
-- The migration runner wraps each file in its own transaction, so this file
-- carries NO top-level BEGIN;/COMMIT; (migration-runner contract; lint:migrations,
-- files >=215). Idempotent: ADD COLUMN IF NOT EXISTS.

ALTER TABLE harness_shared.harness_plans
  ADD COLUMN IF NOT EXISTS initiative text;
