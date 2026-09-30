-- 947-scout-routed-idea-model-provenance.sql
--
-- P-010 of plan learning-loop-backlog-triage-2026-08-22.
--
-- WHY. The audit that commissioned this plan was opened by the owner asking whether
-- the learning loop's backlog was written by weak models ("dumb sonnet and haikus").
-- That question turned out to be UNANSWERABLE from the data: `scout_routed_ideas` has
-- no model column at all, `created_by` is NULL for every scout-origin row (1,623 of
-- them), and `scout_ticks.detail.ideators` records only lens and yield
-- (`{ok, raw, lens, produced}`) — never a model id. The audit therefore had to judge
-- CONTENT instead of producer, and the original question remains permanently
-- unanswerable for the historical corpus.
--
-- This migration closes that gap FORWARD-ONLY. It deliberately does not attempt to
-- backfill: there is no surviving record anywhere that maps a historical routed idea
-- to the model that produced it, and inventing an attribution from the model that
-- happens to be configured today would be a fabricated provenance — strictly worse
-- than an honest NULL, because it would look authoritative.
--
-- EXPAND-ONLY: two nullable columns and one index. No destructive DDL, so no
-- FORWARD-COMPAT acknowledgment is required — the currently-deployed release simply
-- does not reference these columns, and every existing INSERT keeps working unchanged.

ALTER TABLE harness_shared.scout_routed_ideas
  ADD COLUMN IF NOT EXISTS model_spec text,
  ADD COLUMN IF NOT EXISTS model_config jsonb;

COMMENT ON COLUMN harness_shared.scout_routed_ideas.model_spec IS
  'The model spec that PRODUCED this idea, as the "<model-id>:<effort>" form actually passed to the LLM seam (e.g. ''gpt-5.6-sol:xhigh''). Written by recordRoutedIdea from the value the producing path RESOLVED — never re-derived from a default at read time, which would silently re-attribute old rows whenever the configured default changes. NULL is a first-class, permanent value: every row routed before migration 947 has no recoverable producer, and NULL says so honestly rather than guessing. A non-scout origin (su-ideate / agent-review / dream / drill) writes the model of whatever actually generated the idea, or NULL when its producer is a human or a deterministic sweep.';

COMMENT ON COLUMN harness_shared.scout_routed_ideas.model_config IS
  'Sampling/config provenance for the producing call as a small jsonb object — the knobs that change output quality independently of the model id (e.g. {"thinkingBudgetTokens":8000,"maxTokens":16000,"lensRoster":"4x4","effort":"xhigh"}). Kept OPEN-SHAPED on purpose: this records what a given producer path knew at the time, and pinning a schema here would force a migration every time a knob is added. NULL means the producing path recorded none, never that defaults were used.';

-- Slicing the corpus by producer is the whole point of the columns, and the natural
-- query is "this workspace's ideas, grouped by model" — so scope the index the same
-- way every other read of this table is scoped (workspace_id first). Partial on
-- model_spec IS NOT NULL: the pre-947 rows are permanently NULL and will always be the
-- majority of the table, so indexing them buys nothing and costs write amplification.
CREATE INDEX IF NOT EXISTS scout_routed_ideas_ws_model_idx
  ON harness_shared.scout_routed_ideas (workspace_id, model_spec)
  WHERE model_spec IS NOT NULL;
