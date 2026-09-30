-- 841-search-judge-grade-cache.sql
--
-- Durable home for PAID LLM relevance judgements produced by the P-038
-- labelled-relevance bench (packages/operator-core/lib/search/bench/).
--
-- WHY THIS EXISTS (EI-20653219342536753)
-- The bench persisted judgements only to a caller-supplied --out path, whose
-- default was /tmp/claude-1000/p038-labelled-<ts>.json. On 2026-08-16 every
-- artifact of the P-038 effort was found reaped from /tmp:
--     /tmp/rr-p24-v3.json, /tmp/rr-p100-v3.json,
--     /tmp/claude-1000/p038-floor/report.json          -- all GONE
-- That destroyed ~$21.68 of judge spend (D-080 $10.23 + D-081 partial $8.00 +
-- D-088 $3.45), and with it two documented capabilities:
--   * the "$0 re-sweep" (1,933 judged pairs re-scorable for free) and
--   * bench resume, which reads completed queries back from the rows file.
-- Grades are PAID DATA, not derived output. Per the repo storage policy they
-- belong in Postgres; the JSON report stays as the human-readable artifact.
--
-- THE KEY IS DELIBERATELY RANK- AND TOOL-INDEPENDENT.
-- The bench's own pairId is
--     `${LABELLED_PASS_VERSION}:${tool}:${docId}:${rank}`   (labelled-relevance.ts:446)
-- which gives the SAME logical (query, doc) pair a DIFFERENT identity at a
-- different rank or under a different tool. That is exactly why comparing a
-- rerank arm against a control arm previously required a fragile manual join
-- across two run files. The judge only ever sees `query` + `docText`, so rank
-- and tool cannot change the verdict and must not enter the key. Keying on the
-- judged text instead makes cross-arm and cross-run reuse automatic.
--
-- doc_text_hash is load-bearing for CORRECTNESS, not just dedup: the bench
-- judges the RESULT AS PRESENTED (a 200-char excerpt + match-centred headline,
-- capped at DOC_CHARS). If that presentation changes, the old grade no longer
-- describes what a judge would see, so it must MISS rather than silently serve
-- a stale label.

CREATE TABLE IF NOT EXISTS harness_shared.search_judge_grades (
  workspace_id     text          NOT NULL,
  -- Frozen judging contract. Bumping either invalidates every prior grade by
  -- making it unreachable, which is the intended behaviour -- never an update.
  judge_model      text          NOT NULL,
  rubric_version   text          NOT NULL,
  -- sha256 of the exact query string; the readable copy lives in query_text.
  query_hash       text          NOT NULL,
  doc_id           text          NOT NULL,
  -- sha256 of the exact text handed to the judge.
  doc_text_hash    text          NOT NULL,

  -- The judgement itself.
  relevance        real          NOT NULL,
  judged_relevant  boolean       NOT NULL,
  judge_notes      text,
  -- What this grade ORIGINALLY cost. Retained after the grade is cached so a
  -- run can report how much spend it avoided; a cache hit bills the caller 0.
  judge_cost_usd   numeric(12,6) NOT NULL DEFAULT 0,

  -- Forensics: enough to re-analyse or audit a grade without the run file.
  query_text       text          NOT NULL,
  -- The bench's own pair identity, stored VERBATIM rather than parsed. It is
  -- `${LABELLED_PASS_VERSION}:${tool}:${docId}:${rank}`, and splitting it to
  -- recover `tool` is unsound because tool names themselves contain colons
  -- ("search:fulltext"). Kept whole so it traces back to a run row losslessly.
  pair_id          text,
  run_id           text,
  created_at       timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT search_judge_grades_pkey
    PRIMARY KEY (workspace_id, judge_model, rubric_version, query_hash, doc_id, doc_text_hash)
);

-- Run-level roll-ups ("what did this run spend / reuse") and contract-scoped
-- sweeps after a rubric bump.
CREATE INDEX IF NOT EXISTS search_judge_grades_run_idx
  ON harness_shared.search_judge_grades (workspace_id, run_id);

CREATE INDEX IF NOT EXISTS search_judge_grades_contract_idx
  ON harness_shared.search_judge_grades (workspace_id, judge_model, rubric_version, created_at DESC);

COMMENT ON TABLE harness_shared.search_judge_grades IS
  'Paid LLM relevance judgements from the labelled-relevance bench. Durable so bench grades survive /tmp reaping and are reused across arms and runs. Key excludes rank and tool on purpose: the judge sees only query+docText, so the same logical pair must hit regardless of where it ranked. See EI-20653219342536753.';

COMMENT ON COLUMN harness_shared.search_judge_grades.doc_text_hash IS
  'sha256 of the exact text shown to the judge. A presentation change MUST miss rather than serve a stale label.';

COMMENT ON COLUMN harness_shared.search_judge_grades.judge_cost_usd IS
  'What this grade originally cost. A cache hit bills the caller 0; this column is what lets a run report the spend it avoided.';
