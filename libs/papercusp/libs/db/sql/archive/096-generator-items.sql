-- 096: typed per-feature generator-items store for completion-time `for_each`.
--
-- Per dbos-system-completion-2026-06-01 P-043 / D-019. A generative wave whose
-- item-set is only known after a feature does its discovery work (scan→fix,
-- enumerate→migrate) reads that set from here — a feature's worker PUBLISHES its
-- discovered items as first-class typed data (the `generators:publish` tool),
-- and the `for_each: { from_feature: <id> }` resolver reads them. This replaces
-- the original `jq`-over-an-opaque-artifact sketch: no DSL, no external binary,
-- no scraping — just a typed string[] keyed by the producing feature.
--
--   items  JSONB  — a JSON array of strings (the discovered item-set). One
--                   generated child feature is minted per item, `blocked_by` the
--                   producing feature so it dispatches only once that completes.
--
-- Idempotent (PK upsert); re-publishing replaces the set.

CREATE TABLE IF NOT EXISTS harness_shared.harness_generator_items (
  workspace_id TEXT NOT NULL,
  harness_slug TEXT NOT NULL,
  feature_id   TEXT NOT NULL,
  items        JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_ts   BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, harness_slug, feature_id)
);
