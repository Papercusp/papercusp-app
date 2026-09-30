-- 672: per-tool / per-verb transcript usage rollup
-- (plan `bash-to-tool-substitution-2026-07-26`, P-002).
--
-- WHY THIS TABLE EXISTS AT ALL — the metric has no other honest source.
-- P-029 has to show that bash usage MOVED, which needs a before-number and an
-- after-number computed identically. Neither can come from Postgres today:
--   * native `Bash` never reaches harness_shared.tool_invocations (that records
--     MCP calls; its only bash-shaped row is the DIFFERENT `capability:bash`
--     tool, 108 calls/7d against ~24.6k real ones);
--   * locks:check_command does carry command text, but the PreToolUse hook
--     pre-filters locally, so widening the pre-filter would "improve" the
--     number while changing no agent's behaviour — a self-confirming metric;
--   * harness_shared.session_turns is TEXT TURNS ONLY by design and never
--     stores tool_use blocks.
-- The agent transcripts are the only complete source, and they ROLL OFF. So the
-- counts are accumulated AS the existing incremental ingester walks the files
-- and persisted here, before the bytes age out. Re-scanning later cannot
-- reconstruct a window whose files are gone.
--
-- GRAIN: (workspace, source, session, day, tool, verb).
--   * `verb IS NULL` is the per-CALL row; `verb IS NOT NULL` is a per-ATOM row.
--     The audit reports both (24,641 Bash calls carrying 156,345 atoms) and they
--     answer different questions — a share of tool_use blocks is about calls,
--     an intent bucket is a property of an atom. Splitting them at the storage
--     grain is what stops the two being silently conflated at read time.
--   * `session_id` is kept (rather than rolling straight to a daily total)
--     because the baseline is stated per session ("median 189 calls/session"),
--     and a median cannot be recovered from a pre-aggregated sum.
--   * `day` is the UTC day of the RECORD's own timestamp, never the file's
--     mtime: a file touched today holds turns from days ago, and windowing by
--     mtime yields 34,432 calls where the ts-window yields 24,641 — P-029 would
--     have compared incomparable windows.
--
-- Verbs are stored RAW (`sed`, `psql`) and mapped to intent buckets at READ
-- time against harness_shared.bash_tool_substitutions, so re-classifying history
-- is a registry edit rather than a re-ingest.

CREATE TABLE IF NOT EXISTS harness_shared.tool_usage_rollup (
  workspace_id  text        NOT NULL,
  -- Matches session_ingest_state.source_kind ('claude' | 'codex' | 'omp' | ...)
  -- so a per-client breakdown stays possible and the two tables join naturally.
  source_kind   text        NOT NULL,
  session_id    text        NOT NULL,
  day           date        NOT NULL,
  -- The tool as the CLIENT named it ('Bash', 'Read', 'mcp__papercusp-su__…').
  -- Deliberately not normalised: the client's own name is what the transcript
  -- asserts, and normalising here would bake a mapping into history.
  tool_name     text        NOT NULL,
  -- Command verb for a Bash ATOM; '' on the per-call row. Empty string rather
  -- than NULL so it can sit in the primary key (NULLs are not comparable, so a
  -- nullable column in the PK would let duplicate per-call rows accumulate
  -- instead of upserting).
  verb          text        NOT NULL DEFAULT '',
  calls         bigint      NOT NULL DEFAULT 0,
  atoms         bigint      NOT NULL DEFAULT 0,
  -- tool_result payload bytes. A FLOOR, not a true cost: the CLI substitutes a
  -- short '<persisted-output>' stub for a large result, so the biggest results
  -- contribute only their stub. The audit measured the same way, so before and
  -- after stay comparable.
  result_bytes  bigint      NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, source_kind, session_id, day, tool_name, verb)
);

-- The report's own access path: "every row in this window", then group in SQL.
CREATE INDEX IF NOT EXISTS tool_usage_rollup_window_idx
  ON harness_shared.tool_usage_rollup (workspace_id, day DESC, tool_name);

-- Serves the per-verb bucket breakdown without touching the per-call rows,
-- which outnumber nothing but are read for a different question.
CREATE INDEX IF NOT EXISTS tool_usage_rollup_verb_idx
  ON harness_shared.tool_usage_rollup (workspace_id, day DESC, verb)
  WHERE verb <> '';
