-- 678-rename-authority-to-completion-authority.sql
--
-- ⚠ THE RENAME THIS FILE IS NAMED FOR WAS ABANDONED. This migration is now COMMENT-only.
--    Kept (rather than deleted) so the number stays contiguous and so the reason a future
--    reader cannot rename this column is recorded where they will look for it. See D-009.
--
-- WHAT WAS ATTEMPTED AND WHY IT CANNOT BE DONE ---------------------------------
-- 677 added `harness_shared.work_items.authority` (the completion-authority axis:
-- proposed|validated|committed|pending_human|invalid). That name collides with an
-- existing, different axis: plan items carry `authority: 'system' | 'owner'`
-- (libs/generic/plan-parser) meaning WHO MAY ACT, where 'owner' forces needsHuman.
-- Both axes carry a human-attention value, so they are conflatable exactly where a
-- mistake is most expensive. Renaming this column to `completion_authority` was the
-- obvious fix.
--
-- It is not available. Renaming a column that a VIEW exposes requires DROP + CREATE of
-- that view (CREATE OR REPLACE VIEW can APPEND a trailing column — which is how 677
-- landed safely — but cannot rename or reorder existing ones). And
-- `harness_shared.harness_features_consolidated` has **2,485 dependent views** (the
-- per-harness view family). A DROP therefore either fails outright on its dependents or,
-- with CASCADE, destroys thousands of objects this migration has no business touching.
--
-- The first draft of this file did exactly that DROP. It never applied — but an
-- unapplied, un-appliable migration sitting in sql/ is itself a live hazard, because the
-- operator auto-applies pending migrations on boot and would have crash-looped on it.
-- Caught by a peer (EI-18747886333640341) before any operator booted onto it.
--
-- RESOLUTION -------------------------------------------------------------------
-- The column keeps the name `authority`. Disambiguation moves to the layers that can
-- carry it without a 2,485-view blast radius:
--
--   · the API/TS surface exposes it as `completionAuthority` (mapped from this column,
--     exactly as terminalCompletionRef maps from terminal_completion_ref);
--   · the type is `WorkItemCompletionAuthority` in work-item-completion-authority.ts,
--     whose header spells out the distinction from the who-may-act axis;
--   · and the COLUMN COMMENT below, so anyone reading the schema directly gets it too.
--
-- The lesson generalizes and is the reason this file survives as documentation: on this
-- schema, a column exposed through the consolidated views is effectively RENAME-PROOF.
-- Get the name right in the migration that introduces it.

COMMENT ON COLUMN harness_shared.work_items.authority IS
  'COMPLETION-authority axis (plan agent-protocol-authority-semantics-2026-07-26 P-003, '
  'migration 677): how trustworthy the terminal CLAIM on this row is — '
  'proposed|validated|committed|pending_human|invalid — orthogonal to lifecycle `status`. '
  '⚠ NOT the plan-item `authority` axis (system|owner = WHO MAY ACT, where owner forces '
  'needsHuman). Different question, different value set; see D-009. Exposed on the API as '
  '`completionAuthority` precisely to keep the two apart. NULL on a non-terminal row means '
  '"owes no claim yet"; NULL on a TERMINAL row means a legacy pre-authority close, which '
  'counts toward burn-down and is never nagged or reclassified (D-005/D-008). Only '
  'committed and validated count toward burn-down.';
