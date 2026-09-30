-- 210-usage-cache-creation-and-interactive-ingest.sql
-- token-usage-reduction-audit-2026-06-09 P-001/P-002.
--
-- (1) agent_usage_samples gains cache_creation_tokens: the prompt-cache WRITE volume
--     (priced at 1.25x input) was parsed from every run JSONL (extractRunUsage) and
--     stored on the agent_runs_consolidated mirror, but DROPPED from the samples
--     table — leaving the single most expensive token class in the 2026-06-09 audit
--     (~170 MTok/week interactive alone) unattributed in every spend rollup.
--     Backfilled from the runs mirror by run_id where available.
-- (2) interactive_usage_files: per-transcript byte watermarks for the interactive
--     Claude Code usage ingester (samples with source='interactive'), making
--     re-ingest idempotent.

ALTER TABLE harness_shared.agent_usage_samples
  ADD COLUMN IF NOT EXISTS cache_creation_tokens BIGINT;

COMMENT ON COLUMN harness_shared.agent_usage_samples.cache_creation_tokens IS
  'Prompt-cache WRITE tokens (1.25x input list price). NULL when the source did not report them.';

UPDATE harness_shared.agent_usage_samples s
   SET cache_creation_tokens = r.cache_creation_tokens
  FROM harness_shared.agent_runs_consolidated r
 WHERE s.run_id IS NOT NULL
   AND s.run_id = r.run_id
   AND s.cache_creation_tokens IS NULL
   AND r.cache_creation_tokens IS NOT NULL;

CREATE TABLE IF NOT EXISTS harness_shared.interactive_usage_files (
  workspace_id TEXT        NOT NULL,
  file_path    TEXT        NOT NULL,
  byte_offset  BIGINT      NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, file_path)
);

COMMENT ON TABLE harness_shared.interactive_usage_files IS
  'Ingest watermarks for the interactive (Claude Code) transcript usage ingester — byte offset of the end of the last fully-parsed JSONL line per transcript file.';
