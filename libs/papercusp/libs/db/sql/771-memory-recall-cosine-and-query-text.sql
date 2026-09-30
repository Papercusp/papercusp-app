-- 771-memory-recall-cosine-and-query-text.sql
--
-- WI-37403 / owner-directed 2026-08-09. Two telemetry gaps that together made
-- the injection-RELEVANCE audit unrunnable: the table could say in detail what
-- came back and nothing about how relevant it was, nor what was actually asked.
--
-- ## 1. top_cosine_score / cosine_scores — the PRE-FUSION relevance
--
-- `top_score` MIXES TWO SCALES IN ONE COLUMN and always has:
--   * the PULL path stores a raw COSINE similarity (0..1, observed avg 0.720);
--   * the PUSH paths store a post-fusion RRF score whose MAXIMUM is 2/61 =
--     0.0328 (an entry ranked 1st in BOTH legs), because RRF is computed from
--     RANKS, not similarities.
--
-- So the actual relevance measure — the cosine similarity the 0.58 admission
-- floor is applied to — is computed inside the cosine leg, used to admit, and
-- then DISCARDED at fusion. "How relevant was what we injected?" was therefore
-- unanswerable from this table BY CONSTRUCTION, not by oversight.
--
-- ⚠ THESE ARE NEW COLUMNS ON PURPOSE — do NOT "simplify" this later by
-- normalising the cosine into `top_score`. Mixing the scales is precisely what
-- already produced a false report: on 2026-07-28 an agent compared push-path
-- `top_score` (ceiling 0.0328) against the 0.58 floor and concluded "99.9% of
-- injections are below the floor". The floor was working correctly; the two
-- numbers were never on the same scale. A column that means exactly one thing
-- is what removes that trap permanently.
--
-- Nullable, and NULL is meaningful: "no pre-fusion cosine was recorded for this
-- recall" (a lexical-only fallback, a backend with no cosine leg, or a row
-- written before this migration). It is NOT zero — 0 sits inside the real value
-- range and would read as "maximally irrelevant, admitted anyway".
--
-- ## 2. memory_recall_query_text — what was ASKED, on a bounded window
--
-- Today only `query_sha256` + `query_chars` are stored (migration 706, P-041) —
-- deliberately, so prompt content stayed out of a table with no retention. That
-- shape answers "how much traffic is boilerplate / a repeat" and cannot answer
-- "was this query even about the right thing", which is the question a
-- relevance audit needs. A live finding (mid-turn cosine queries matching on
-- shell/path chrome) had to be evidenced from an agent TRANSCRIPT because the
-- text was not measurable here.
--
-- Kept in a SEPARATE TABLE rather than a column on `memory_recall_stats`, for
-- three reasons that all point the same way:
--   a. RETENTION. The stats row is small, useful indefinitely, and never
--      pruned. The query text is the opposite. A side table lets the EXISTING
--      `system:telemetry-retention` janitor bound it with its native operation
--      — DELETE rows by age — instead of teaching that janitor a new
--      column-redaction mode it has never had.
--   b. BLAST RADIUS. Prompt/command text is the sensitive part; segregating it
--      means it can be dropped wholesale, and a reader that must not see it
--      simply does not join.
--   c. WRITE SAFETY. The text insert is a separate statement guarded on its
--      own, so a failure on this side can never cost the stats row. This table
--      has already lost hours of writes once to a stale CHECK constraint
--      (583-drop-memory-recall-stats-surface-check.sql); a second write that
--      can fail the first would re-open that class.
--
-- ⚠ WHAT GOES IN HERE is the DERIVED per-leg retrieval query (post
-- `splitLegQueries`), never the raw `tool_input`. That derived text is what
-- actually drives retrieval, is already path-stripped, and — crucially — the
-- mid-turn query is built from raw Bash command lines, which routinely carry
-- credentials. The writer additionally refuses text that trips the
-- credential-shaped-content detector. Retention is enforced by the janitor
-- (`memory-recall-query-text` storage category), NOT by anything here.

ALTER TABLE harness_shared.memory_recall_stats
  ADD COLUMN IF NOT EXISTS top_cosine_score double precision;

ALTER TABLE harness_shared.memory_recall_stats
  ADD COLUMN IF NOT EXISTS cosine_scores jsonb;

COMMENT ON COLUMN harness_shared.memory_recall_stats.top_cosine_score IS
  'Best PRE-FUSION cosine similarity (0..1) in the result set — the scale the admission floor is applied on. NULL = not recorded (never 0). Deliberately NOT folded into top_score, which mixes cosine and RRF scales.';

COMMENT ON COLUMN harness_shared.memory_recall_stats.cosine_scores IS
  'The full pre-fusion cosine list behind top_cosine_score, for distribution reads without a schema change. NULL = not recorded; [] = recorded and empty.';

CREATE TABLE IF NOT EXISTS harness_shared.memory_recall_query_text (
    stats_id   bigint NOT NULL,
    query_text text   NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT memory_recall_query_text_pkey PRIMARY KEY (stats_id),
    -- CASCADE so this can never outlive the recall it describes. The parent is
    -- not age-pruned today; this is about correctness if that ever changes,
    -- since an orphaned prompt-text row is exactly the wrong thing to keep.
    CONSTRAINT memory_recall_query_text_stats_fk FOREIGN KEY (stats_id)
      REFERENCES harness_shared.memory_recall_stats (id) ON DELETE CASCADE
);

-- The retention janitor prunes by age; this is the index it walks.
CREATE INDEX IF NOT EXISTS memory_recall_query_text_created_idx
  ON harness_shared.memory_recall_query_text USING btree (created_at DESC);

COMMENT ON TABLE harness_shared.memory_recall_query_text IS
  'BOUNDED-WINDOW retrieval query text, joined to memory_recall_stats by id. Holds the DERIVED per-leg query (post splitLegQueries), never raw tool_input. Pruned by the memory-recall-query-text storage category via system:telemetry-retention.';

GRANT SELECT, INSERT, DELETE ON harness_shared.memory_recall_query_text TO harness_app;
DO $z$ BEGIN
  GRANT SELECT ON harness_shared.memory_recall_query_text TO harness_zero;
EXCEPTION WHEN undefined_object THEN NULL;
END $z$;
