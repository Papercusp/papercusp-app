-- 748-corpus-term-df.sql
--
-- P-018 / D-064 — the corpus document-frequency signal `corpusQueryText` selects
-- query terms with.
--
-- WHY A TABLE RATHER THAN `ts_stat` AT QUERY TIME. Two reasons, and the first is
-- a correctness one:
--
--   1. `ts_stat` returns STEMMED lexemes, while term selection runs over RAW
--      tokens from `corpusTerms`. A raw lookup into a lexeme table misses on
--      every inflection ("sessions"->"session", "queries"->"queri"), and a miss
--      reads as df 0 => maximal rarity => SELECTED. That inverts the ranking and
--      puts the corpus's most common words first, while still looking like a
--      working ranker. So `term` here is what `corpusTerms` emits, computed by
--      that same function — the tokenizers cannot drift.
--   2. `ts_stat` is a full scan of the tsvector column. This leg runs on the
--      injection hot path under a 2000ms whole-leg bound.
--
-- ONLY ATTESTED TERMS ARE STORED (df >= the caller's min, currently 2). Absence
-- IS the filter's verdict — "not here" means "unattested", which is exactly what
-- banded selection does with it. That keeps the table small enough to hold in
-- process memory with no per-query round-trip, and it drops the hapax tail that
-- is the bulk of the vocabulary (measured 2026-08-03: 96,585 distinct terms over
-- a 40k-document sample, the large majority of them df 1).
--
-- DF is a RANKING signal, so the refresh samples rather than scanning the whole
-- corpus: relative frequencies of common terms stabilise long before absolute
-- counts converge, and only the ORDER matters here.

CREATE TABLE IF NOT EXISTS harness_shared.corpus_term_df (
  workspace_id  text        NOT NULL,
  -- Exactly what `corpusTerms()` emits: lowercased, split on
  -- non-alphanumeric-and-dash, stopwords removed, >=4 chars or id-shaped.
  term          text        NOT NULL,
  -- DOCUMENT frequency: how many sampled corpus documents contain the term.
  -- Not a term frequency — `corpusTerms` de-duplicates within a document.
  df            integer     NOT NULL,
  -- Corpus size this df was computed over, so a consumer can turn df into a
  -- rate (or an idf) without assuming the sample size.
  ndocs         integer     NOT NULL,
  refreshed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, term),
  CONSTRAINT corpus_term_df_df_positive CHECK (df > 0),
  CONSTRAINT corpus_term_df_ndocs_positive CHECK (ndocs > 0)
);

-- The load path is "every term for this workspace, newest refresh" — a single
-- bulk read into the in-process cache, not point lookups.
CREATE INDEX IF NOT EXISTS corpus_term_df_workspace_refreshed_idx
  ON harness_shared.corpus_term_df (workspace_id, refreshed_at DESC);

COMMENT ON TABLE harness_shared.corpus_term_df IS
  'P-018/D-064: corpus document frequency over RAW corpusTerms tokens (NOT ts_stat lexemes — stemming mismatch inverts the ranking). Only terms with df >= the configured minimum are stored; absence means unattested, which is the banded selector''s filter verdict. Refreshed by the system:corpus-term-df routine.';
