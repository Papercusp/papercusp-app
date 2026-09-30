-- 747-backfill-memory-taxonomy-scope-kind.sql
--
-- P-005 of plan memory-corpus-hygiene-and-release-distribution-2026-08-03:
-- backfill `payload.scope` and `payload.kind` on the real memories that carry
-- neither. The taxonomy is the input to every Phase 2 distribution-selection
-- step (what knowledge ships in a public release), so a missing scope/kind is
-- a row that selection cannot reason about.
--
-- SCOPE OF THIS MIGRATION — read before widening it
-- =================================================
-- `harness_shared.memory_canonical` holds TWO populations and only one of them
-- is a memory (plan D-013):
--
--   * real memories            — 4,096 rows (2026-08-03)
--   * mem0 entity-graph nodes  — 29,389 rows, the graph INDEX over those
--                                memories, discriminated by the presence of
--                                `payload->'entityType'` (COMPOUND/PROPER/
--                                QUOTED) + `linkedMemoryIds`
--
-- Entity nodes correctly carry NEITHER `scope` nor `kind` — they are not facts
-- and must never be given a taxonomy, so every statement here is guarded by
-- `NOT (payload ? 'entityType')`. Any count that omits that guard over-reports
-- this backfill's target set by ~8x. Entity nodes also LOOK like splitter
-- debris (very short bodies) but are not: 4,995 of 5,000 sampled carry a
-- linkedMemoryIds edge to a real memory. Never select them by row length.
--
-- HOW `scope` IS DERIVED — it is recoverable, not guessed
-- ======================================================
-- memory:remember computes a scopeKey and hands it to the backend as the
-- neutral `scope` option; mem0 stores that scopeKey as `payload.user_id` (see
-- libs/generic/memory/src/mem0-backend.ts: "the neutral `scope` string maps
-- onto mem0's `user_id` filter"). `payload.scope` is the separate TAXONOMY
-- value carried in metadata. So the taxonomy is a pure function of the pool
-- prefix already present on every row, and this backfill inverts the same
-- mapping remember.ts applies on the way in:
--
--   payload.user_id            ->  payload.scope
--   'harness:<slug>'           ->  'harness'      (45 rows)
--   'hive:<slug>'              ->  'hive'         (0 rows today)
--   'bench'                    ->  'bench'        (342 rows — see below)
--   <anything else, a user id> ->  'user'         (216 rows)
--
-- Measured 2026-08-03: 603 real memories missing `scope`, 0 undecidable (every
-- row has a user_id), 53 of those also missing `kind`.
--
-- WHY 'bench' GETS ITS OWN SCOPE INSTEAD OF BEING LAUNDERED INTO 'user'
-- ====================================================================
-- 342 of the 603 are recall-BENCHMARK fixtures: `user_id = 'bench'` is
-- BENCH_SCOPE (packages/operator-core/lib/memory/bench/run-bench.ts:53), and
-- their payloads carry the bench-only keys `corpus_key` + `textLemmatized`.
-- Their bodies are another project's content, seeded into the live canonical
-- table by bench runs and never swept. Giving them 'user' or 'harness' would
-- make fixtures indistinguishable from real facts and — worse — ELIGIBLE for
-- Phase 2 distribution, i.e. shipped in a public release. A distinct 'bench'
-- value is both honest (it is the pool the row is actually in) and FAIL-SAFE:
-- a Phase 2 selector that admits scope IN ('harness','hive','user') excludes
-- them by construction rather than by remembering to. The fixtures leaking
-- into the live table is a separate defect, filed independently; this
-- migration only makes them legible, it does not delete them.
--
-- WHY A MISSING `kind` BECOMES 'reference'
-- =======================================
-- That is the codebase's own documented default for an absent/unmapped kind
-- (normalizeMemoryKind, packages/operator-core/lib/agent-tools/memory/
-- remember-coerce.ts): "the catch-all for hard-won technical facts, which is
-- what agents mostly write". Sampling the 53 confirms it — they are pointer-
-- to-runbook facts. Recall is semantic and filters on user_id, never on kind
-- or scope, so a defaulted kind cannot change what any query returns; it only
-- gives selection something to read.
--
-- PROVENANCE — a derived value must never masquerade as an authored one
-- ====================================================================
-- Every value written here is stamped (`scope_provenance` / `kind_provenance`)
-- so a later reader, and Phase 2 selection in particular, can tell a value
-- this migration inferred from one the writing agent actually chose. Query
-- `payload ? 'kind_provenance'` to find every defaulted kind.
--
-- SAFETY PROPERTIES (all verified against live data before writing this)
-- =====================================================================
--   * IDEMPOTENT — the WHERE clause matches only rows that still lack a key,
--     and each key is added via `||` under a `? 'key'` guard, so re-applying
--     is a no-op and an existing value is never overwritten.
--   * NO FEDERATION BROADCAST — capture_memory_canonical_outbox_upd_trg fires
--     only WHEN (new.shareable OR old.shareable) IS TRUE. All 603 target rows
--     are shareable=false, so this emits ZERO substrate_outbox ops.
--   * NO harness_slug SIDE EFFECT — stamp_memory_federation_slug_upd_trg fills
--     harness_slug from payload.fed_harness_slug when NULL; 0 target rows carry
--     that key, so the stamp is a no-op here.
--   * CONTENT UNTOUCHED — `payload.data`, `payload.hash` and mem0's own
--     `payload.createdAt`/`updatedAt` are not written, so no re-embedding is
--     implied and no recall signal moves. The row-level `updated_at` IS bumped
--     because the row genuinely changed; no memory reader ranks on it.
--   * NO WORKSPACE PREDICATE, DELIBERATELY — the target rows have
--     workspace_id IS NULL by construction, so a workspace filter would
--     exclude exactly the rows that need repair. Each install repairs its own
--     corpus; on a fresh install this is a 0-row no-op.

UPDATE harness_shared.memory_canonical AS m
SET payload = m.payload
      -- scope: invert the pool prefix that remember.ts encoded into user_id.
      || CASE
           WHEN m.payload ? 'scope' OR m.payload ->> 'user_id' IS NULL
             THEN '{}'::jsonb
           ELSE jsonb_build_object(
                  'scope',
                  CASE
                    WHEN m.payload ->> 'user_id' LIKE 'harness:%' THEN 'harness'
                    WHEN m.payload ->> 'user_id' LIKE 'hive:%'    THEN 'hive'
                    WHEN m.payload ->> 'user_id' =    'bench'     THEN 'bench'
                    ELSE 'user'
                  END,
                  'scope_provenance', 'migration-747:derived-from-user_id'
                )
         END
      -- kind: the documented catch-all default, stamped as defaulted.
      || CASE
           WHEN m.payload ? 'kind' THEN '{}'::jsonb
           ELSE jsonb_build_object(
                  'kind', 'reference',
                  'kind_provenance', 'migration-747:defaulted-reference'
                )
         END,
    updated_at = now()
WHERE NOT (m.payload ? 'entityType')
  AND (
        (NOT (m.payload ? 'scope') AND m.payload ->> 'user_id' IS NOT NULL)
     OR NOT (m.payload ? 'kind')
      );

-- Postcondition: assert the gap this migration exists to close is actually
-- closed, so a silent partial apply fails loudly at apply time instead of
-- surfacing later as a Phase 2 selection hole. Entity nodes are excluded (they
-- must stay untaxonomised); a row with no user_id is excluded because its
-- scope is genuinely underivable (there are none today).
DO $$
DECLARE
  missing_scope bigint;
  missing_kind  bigint;
BEGIN
  SELECT count(*) INTO missing_scope
    FROM harness_shared.memory_canonical
   WHERE NOT (payload ? 'entityType')
     AND NOT (payload ? 'scope')
     AND payload ->> 'user_id' IS NOT NULL;

  SELECT count(*) INTO missing_kind
    FROM harness_shared.memory_canonical
   WHERE NOT (payload ? 'entityType')
     AND NOT (payload ? 'kind');

  IF missing_scope > 0 OR missing_kind > 0 THEN
    RAISE EXCEPTION
      'migration 747 postcondition failed: % real memories still missing payload.scope, % still missing payload.kind',
      missing_scope, missing_kind;
  END IF;
END $$;
