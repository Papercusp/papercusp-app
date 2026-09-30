-- Migration 312 — memory_precision_bench: a precision-over-time trend for the memory store
--
-- relight-self-learning-edges-2026-06-14 (P-033). The memory injection floor is solved
-- (D-007: 0.45 cosine / 0.40 lexical is sweep-optimal, FP@5 ~17% at R@10 ~82%), but it was
-- benchmarked ONCE, not monitored. This table records one row per memory-precision-bench run
-- (the `memory-precision` learning singleton, weekly): the frozen gold-set replayed against the
-- production HYBRID backend AT THE PRODUCTION PUSH FLOOR, so precision drift is visible on the
-- Learning tab (the MemoryHealthCard precision chips + the learning-efficacy panel's memory FP@5)
-- instead of silently rotting. Pure measurement — the bench DECIDES nothing (D-006 @
-- memory-backend-benchmark-2026-06-05); the revive/retune call stays the owner's.
--
-- One row per run, workspace-scoped. fp_at_5 is the hard-negative false-positive rate (the
-- discipline number); r_at_10 / p_at_5 / mrr are the positives-only retrieval quality; by_class
-- carries the full per-class RankMetrics blob for drill-down. floor_cosine / floor_lex record the
-- floor the run measured at (so a future floor change is legible in the history).
--
-- Idempotent: CREATE TABLE IF NOT EXISTS; additive; fresh-migrate-safe.

\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS harness_shared.memory_precision_bench (
  id               bigserial PRIMARY KEY,
  workspace_id     text NOT NULL,
  ran_at           timestamptz NOT NULL DEFAULT now(),
  -- The backend benched (production push path = 'hybrid'); recorded for legibility.
  backend          text NOT NULL DEFAULT 'hybrid',
  -- Frozen dataset identities (corpus.vN / gold-set.vN) — a dataset bump is legible in history.
  corpus_version   text NOT NULL,
  gold_version     text NOT NULL,
  corpus_n         integer NOT NULL DEFAULT 0,
  gold_n           integer NOT NULL DEFAULT 0,
  -- The PUSH floor this run measured at (the injection.ts production floor at run time).
  floor_cosine     double precision NOT NULL,
  floor_lex        double precision NOT NULL,
  -- Hard-negative false-positive rate (fraction of must-return-nothing queries with ≥1 top-5 hit).
  fp_at_5          double precision,
  -- Positives-only retrieval quality.
  r_at_10          double precision,
  p_at_5           double precision,
  mrr              double precision,
  median_top_score double precision,
  latency_p50_ms   double precision,
  -- Per-class RankMetrics blob (lexical-gap / exact-identifier / hard-negative / session-start).
  by_class         jsonb,
  -- Embedding cost estimate for the run (USD), best-effort.
  cost_usd         double precision,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- The trend read: newest-first per workspace.
CREATE INDEX IF NOT EXISTS memory_precision_bench_ws_ran_idx
  ON harness_shared.memory_precision_bench (workspace_id, ran_at DESC);

-- Workspace isolation + grants, mirroring 243-gym-champion-outcomes.sql.
ALTER TABLE harness_shared.memory_precision_bench ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS memory_precision_bench_workspace_isolation ON harness_shared.memory_precision_bench;
CREATE POLICY memory_precision_bench_workspace_isolation ON harness_shared.memory_precision_bench
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.memory_precision_bench TO harness_app;
GRANT SELECT ON harness_shared.memory_precision_bench TO harness_zero;
GRANT USAGE, SELECT ON SEQUENCE harness_shared.memory_precision_bench_id_seq TO harness_app;

COMMIT;
