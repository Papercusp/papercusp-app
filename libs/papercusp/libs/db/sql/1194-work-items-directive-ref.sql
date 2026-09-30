-- 1194-work-items-directive-ref.sql
--
-- P-005 of plan `directive-visibility-and-ownership-2026-09-22`.
--
-- WHAT THIS ADDS. One nullable provenance column on `harness_shared.work_items`
-- naming the owner directive (`harness_shared.owner_directives.id`) that the
-- work-item was created to carry out.
--
-- WHY IT LIVES ON THE WORK-ITEM AND POINTS BACK (D-005, and the reason there is
-- no column in the other direction). A directive exists BEFORE any work-item
-- does — the owner speaks first — and must be fully visible at that moment. So
-- the reference is LATE-BINDING: the row that is created second (the work-item)
-- carries it. Putting a `work_item_id` on the directive instead would require
-- WRITING to the directive row after capture, and directive rows are immutable
-- owner speech: `recorded_by` is what says whose directive it is, and a row that
-- gets written to after the fact is a row whose provenance can drift. The
-- consequence worth stating plainly is that ZERO linked work-items is the
-- DEFAULT state of a healthy directive, never a degenerate one.
--
-- WHY A PLAIN COLUMN AND NOT A JOIN TABLE. The cardinality is many-work-items-
-- to-one-directive, which a column on the many side expresses exactly. This is
-- the same shape, and deliberately the same treatment, as the existing
-- `source_plan_slug` provenance column beside it: where did this work-item come
-- from. Reuse-first — no new table, no new tool, no second write path.
--
-- WHY NO FOREIGN KEY. Two reasons, both load-bearing:
--   1. `work_items` is workspace-partitioned by `workspace_id`; the natural key
--      into `owner_directives` is (workspace_id, id), and a composite FK here
--      buys nothing that the derivation does not already handle — a dangling
--      ref derives `unclaimed`, which is the correct and safe reading.
--   2. A directive can be GC'd or a workspace torn down independently of the
--      work it spawned; an FK would make that a cascade decision rather than a
--      provenance one. Provenance that survives its subject is the point.
--
-- EXPAND ONLY. Nullable add with no default rewrite, no constraint, no index
-- change on an existing column — the currently-deployed :3070 release simply
-- does not select it. No FORWARD-COMPAT line is required because nothing here
-- is destructive.

ALTER TABLE harness_shared.work_items
  ADD COLUMN IF NOT EXISTS directive_ref bigint;

COMMENT ON COLUMN harness_shared.work_items.directive_ref IS
  'Late-binding provenance: harness_shared.owner_directives.id this work-item was created to carry out. NULL is the default and the common case — a directive is visible and actionable long before any work-item exists (plan directive-visibility-and-ownership-2026-09-22, D-005). Never written back onto the directive row, which stays immutable owner speech.';

-- The read this exists to serve is "which live work-items are carrying directive
-- N", evaluated per directive while deriving its status. Partial on NOT NULL so
-- the index stays proportional to the linked population rather than to the whole
-- work-item table, of which the overwhelming majority will never carry a ref.
CREATE INDEX IF NOT EXISTS work_items_directive_ref_idx
  ON harness_shared.work_items (workspace_id, directive_ref)
  WHERE directive_ref IS NOT NULL;
