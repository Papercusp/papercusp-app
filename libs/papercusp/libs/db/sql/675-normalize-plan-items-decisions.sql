-- 675: normalize harness_plans.items / .decisions jsonb arrays into real tables
-- (plan `normalize-plan-items-decisions-to-rows-2026-07-26`, P-001).
--
-- WHY THESE TWO COLUMNS AND NOT THE OTHER 330. The 2026-07-26 DB-wide audit
-- classified every jsonb column in the database -- 332 of them across 234 of
-- 475 tables, ~5GB. Exactly THREE hold a "table in a cell" (a jsonb ARRAY of
-- UNIFORM objects) rather than a heterogeneous document. Two of the three are
-- here. The rest are correctly jsonb and are deliberately left alone:
-- tool_invocations.metadata_json (558MB), args_json (271MB), decision_ledger
-- (237MB) and friends are per-call payloads with genuinely different keys per
-- row, and normalizing them would produce either a sparse table of mostly-null
-- columns or an EAV table -- both worse than jsonb. (The third table-in-a-cell,
-- operator_turns.tools, averages 1.3 elements per row and is not worth a join.)
--
-- THESE COLUMNS ARE DERIVED, NOT CANONICAL. `harness_plans.content` (markdown)
-- is the source of truth; `items`/`decisions` are recomputed from it by
-- deriveIndexFromContent() on every content write (with-plan-lock.ts:254).
-- So this migration changes THE SHAPE OF AN INDEX, not a source of truth: the
-- tables below are rebuildable from `content` at any time, and any divergence
-- is a derivation bug rather than data loss. That is what makes normalizing a
-- load-bearing structure low-risk here.
--
-- THE JSONB IS PERFECTLY RECTANGULAR -- verified against live data BEFORE this
-- schema was designed, rather than assumed:
--     items      7/7 keys present in 4000/4000 sampled elements
--     decisions  5/5 keys present in 3624/3624 sampled elements
--     duplicate item ids 0, duplicate decision ids 0, null ids 0
-- That last line is why the natural key is safe as a PRIMARY KEY below.
--
-- THE MEASURED WIN IS QUERY SHAPE, NOT BYTES (items ~4MB, decisions ~5MB):
--   * harness_plans is 70MB total but only 5.4MB heap -- ~64MB is TOAST, i.e.
--     the fat `content` markdown plus these arrays. The item read path
--     (plans/source.ts:605,627) SELECTs `content` ALONGSIDE `items`, so today
--     you cannot read plan items without dragging the whole markdown body
--     through TOAST de-compression. 1.21M seq scans reading 1.5B tuples.
--   * plan_item_assignments takes 4.67M seq scans on a 24KB-heap table, and
--     plan_item_claims 3.99M. Plan-item lookups are hot, and today they cannot
--     JOIN to item content because that content sits inside a jsonb blob on a
--     different table. These tables make that join expressible.
--
-- ON DELETE CASCADE via a composite FK to harness_plans' PK
-- (workspace_id, harness_slug, plan_slug) is what keeps the derived index from
-- orphaning when a plan row dies -- no application-side cleanup to forget.
--
-- DELIBERATELY NO substrate-outbox trigger here, in contrast to harness_plans
-- which carries capture_substrate_outbox_trg. These rows are derived from a row
-- that is ALREADY federated; emitting a second tombstone stream for them would
-- duplicate federation traffic and re-open the WI-5720 class of bug (a DELETE
-- routed through canonical_harness_slug() destroyed 78 live plan rows).

CREATE TABLE IF NOT EXISTS harness_shared.plan_items (
  workspace_id   text        NOT NULL,
  harness_slug   text        NOT NULL,
  plan_slug      text        NOT NULL,
  item_id        text        NOT NULL,
  -- Position within the plan. The jsonb array was implicitly ordered; a table
  -- is not, so order becomes explicit or it is silently lost.
  seq            integer     NOT NULL,
  item_text      text        NOT NULL DEFAULT '',
  status         text        NOT NULL DEFAULT 'todo',
  importance     text,
  phase          text,
  blocked_by     text[]      NOT NULL DEFAULT '{}',
  decision_refs  text[]      NOT NULL DEFAULT '{}',
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plan_items_pkey PRIMARY KEY (workspace_id, harness_slug, plan_slug, item_id),
  CONSTRAINT plan_items_plan_fk FOREIGN KEY (workspace_id, harness_slug, plan_slug)
    REFERENCES harness_shared.harness_plans (workspace_id, harness_slug, plan_slug)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS harness_shared.plan_decisions (
  workspace_id   text        NOT NULL,
  harness_slug   text        NOT NULL,
  plan_slug      text        NOT NULL,
  decision_id    text        NOT NULL,
  seq            integer     NOT NULL,
  title          text        NOT NULL DEFAULT '',
  body           text        NOT NULL DEFAULT '',
  -- Free-text as authored in the plan ("2026-07-26"); NOT a date type, because
  -- the markdown is hand-written and a malformed date must not fail the write.
  decision_date  text,
  item_refs      text[]      NOT NULL DEFAULT '{}',
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plan_decisions_pkey PRIMARY KEY (workspace_id, harness_slug, plan_slug, decision_id),
  CONSTRAINT plan_decisions_plan_fk FOREIGN KEY (workspace_id, harness_slug, plan_slug)
    REFERENCES harness_shared.harness_plans (workspace_id, harness_slug, plan_slug)
    ON DELETE CASCADE
);

-- Cross-plan "what is actionable in this harness" -- the query that today loads
-- every plan's jsonb (and its `content`) and filters in JS.
CREATE INDEX IF NOT EXISTS plan_items_status_idx
  ON harness_shared.plan_items (workspace_id, harness_slug, status);

-- Ordered read of one plan's items without touching harness_plans at all.
CREATE INDEX IF NOT EXISTS plan_items_plan_seq_idx
  ON harness_shared.plan_items (workspace_id, harness_slug, plan_slug, seq);

-- Reverse dependency lookup: "what is blocked by P-003?" -- not expressible
-- against the jsonb without unnesting every plan.
CREATE INDEX IF NOT EXISTS plan_items_blocked_by_gin
  ON harness_shared.plan_items USING gin (blocked_by);

CREATE INDEX IF NOT EXISTS plan_decisions_plan_seq_idx
  ON harness_shared.plan_decisions (workspace_id, harness_slug, plan_slug, seq);

-- "Which decisions bear on item P-007?"
CREATE INDEX IF NOT EXISTS plan_decisions_item_refs_gin
  ON harness_shared.plan_decisions USING gin (item_refs);

COMMENT ON TABLE harness_shared.plan_items IS
  'Derived index of harness_plans.content plan items (migration 675). content is canonical; these rows are recomputed by deriveIndexFromContent on every plan write and are rebuildable from content at any time. Replaces the harness_plans.items jsonb array.';

COMMENT ON TABLE harness_shared.plan_decisions IS
  'Derived index of harness_plans.content decisions (migration 675). content is canonical; rebuildable at any time. Replaces the harness_plans.decisions jsonb array.';
