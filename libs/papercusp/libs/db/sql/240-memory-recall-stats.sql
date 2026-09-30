-- 240-memory-recall-stats.sql
--
-- self-improvement-consume-edges-2026-06-12 (P-031 / B-10, part of EI-366):
-- recall-quality telemetry for the memory store.
--
-- Before this, nothing recorded what memory recall actually RETURNED — a
-- degraded index (junk fragments, dead embedder leg, mis-tuned floor) was
-- indistinguishable from "no relevant memory for this turn". One small row
-- per recall, written fire-and-forget by the two read surfaces
-- (packages/operator-core/lib/memory/recall-stats.ts, wired into the
-- memory:search tool and the pre-turn injection helper). Read side:
-- readMemoryHealth (knowledge-read.ts) aggregates zero-hit-rate and the
-- top-score distribution for the Learning tab memory-health card.
--
--   surface:        'search' (the pull path — memory:search tool) |
--                   'injection' (the push path — pre-turn auto-inject).
--   hit_count:      results returned after score floors, before per-call caps.
--   top_score:      best fused/cosine score in the result set (NULL on zero hits).
--   scores:         the full (small — limit ≤ 20) score list, for distribution
--                   queries beyond p50/p90 without a schema change.
--   fragment_count: results whose metadata carried entityType — entity-store
--                   leakage (EI-366). Always 0 after the canonical-store
--                   segregation fix; a non-zero value is the regression canary.
--
-- Volume: one row per agent recall (~per turn). Trivial row width; the
-- health read looks back 7 days. No retention pass yet — revisit if the
-- table ever matters in dev_pg_table_sizes.

CREATE TABLE IF NOT EXISTS harness_shared.memory_recall_stats (
    id             bigint GENERATED ALWAYS AS IDENTITY,
    surface        text NOT NULL,
    hit_count      integer NOT NULL,
    top_score      double precision,
    scores         jsonb NOT NULL DEFAULT '[]'::jsonb,
    fragment_count integer NOT NULL DEFAULT 0,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT memory_recall_stats_pkey PRIMARY KEY (id),
    CONSTRAINT memory_recall_stats_surface_check
      CHECK (surface IN ('search', 'injection')),
    CONSTRAINT memory_recall_stats_hit_count_check CHECK (hit_count >= 0)
);

-- The health read is a trailing-window aggregate.
CREATE INDEX IF NOT EXISTS memory_recall_stats_created_idx
  ON harness_shared.memory_recall_stats USING btree (created_at DESC);

GRANT SELECT, INSERT ON harness_shared.memory_recall_stats TO harness_app;
DO $z$ BEGIN
  GRANT SELECT ON harness_shared.memory_recall_stats TO harness_zero;
EXCEPTION WHEN undefined_object THEN NULL;
END $z$;

-- The feedback-rerank consumer (feedback-rerank.ts) reads recent
-- delete/forget_all rows on every recall — index the lookup it does.
CREATE INDEX IF NOT EXISTS memory_feedback_action_created_idx
  ON harness_shared.memory_feedback USING btree (action, created_at DESC);
