-- 705-memory-recall-stats-score-scale.sql
--
-- context-injection-audit-2026-07-28 P-036 (F-F). The prerequisite D-001 named
-- for ANY watchdog on this table's score column.
--
-- `top_score` (and every `top` inside `pools`) holds the best score a recall
-- returned. What it has NEVER recorded is what SCALE that number is on — and
-- the store emits three, which are not merely differently-calibrated but
-- answer different questions:
--
--   cosine  — a SIMILARITY. Absolute, comparable across calls, and floored at
--             ~0.45-0.50 on admission, so observed values land in 0.50..0.90.
--   rrf     — a RANK (reciprocal-rank fusion, `Σ lexWeight/(k + rank)`).
--             Bounded above by (1+lexWeight)/(k+1) = 2/61 = 0.032787 at the
--             production defaults, and meaningful ONLY within a single call.
--   lexical — token-overlap fractions from the embed-free fallback leg
--             (WI-4214). Ordering only; small rational fractions.
--
-- WHY THIS BLOCKS THE WATCHDOG. An absolute threshold cannot exist over a
-- mixed column: 0.03 is a BROKEN retrieval on the cosine scale and a
-- rank-1-in-both-legs PERFECT hit on the rrf scale. A naive alarm would fire
-- exactly the false critical this audit already had to retract (D-001).
--
-- WHY A ROW-LEVEL DISCRIMINATOR AND NOT A READ-TIME DERIVATION. Measured on
-- the live table before writing this: the scales INTERLEAVE within a single
-- surface on the same day (2026-07-28 `search`: 17 rrf-scale rows alongside 94
-- cosine-scale; `turn-start`: 144 rrf alongside 8 cosine). So the scale is
-- neither a property of the surface nor of the push/pull path — both paths
-- resolve the SAME getMemoryBackend() singleton, and which backend that is
-- varies by process and config. Only the writer knows, and only at write time.
--
-- WHY A DISCRIMINATOR AND NOT SPLIT cosine/rrf COLUMNS. Every entry in one
-- recall shares one scale (a single backend call produced them all), so split
-- columns would leave one NULL on every row and invite a `coalesce(cosine,
-- rrf)` read that silently reinstates the exact mixing this prevents. One
-- label also covers the per-pool `top` values inside `pools`, and extends to a
-- third scale without another migration.
--
-- NO BACKFILL. The provenance was never captured, so historical rows stay
-- NULL and read as 'unknown'. Readers must never pool an unknown row with a
-- labelled one. A read-time classifier for legacy rows lives in
-- recall-stats.ts (`classifyLegacyScoreScale`) and is deliberately confined
-- there: it is an inference over a measured-bimodal distribution (45,069 rows
-- / 30d: 32,547 at <= 0.032787, 12,517 at >= 0.50, and only 5 rows — 0.011% —
-- anywhere between), valid ONLY while k=60/lexWeight=1 hold. This column is
-- the authority; the classifier is a transition aid that ages out with the
-- retention window.

ALTER TABLE harness_shared.memory_recall_stats
  ADD COLUMN IF NOT EXISTS score_scale text;

COMMENT ON COLUMN harness_shared.memory_recall_stats.score_scale IS
  'Scale of top_score and of every pools.*.top on this row: cosine | rrf | lexical | unknown. NULL = pre-migration-705 row (scale not captured). NEVER take a percentile across mixed scales. context-injection-audit-2026-07-28 P-036.';

-- The measurements this serves are all "recent rows, one scale, distribution
-- of top_score" — a created_at window plus a scale equality. Partial on the
-- labelled rows so the legacy NULL bulk (which no scale-aware reader will ask
-- for) never enters the index.
CREATE INDEX IF NOT EXISTS memory_recall_stats_scale_created_idx
  ON harness_shared.memory_recall_stats (score_scale, created_at DESC)
  WHERE score_scale IS NOT NULL;
