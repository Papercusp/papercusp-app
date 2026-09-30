-- Migration 272 — add `turn_count` to agent_usage_samples.
--
-- Plan: queen-brief-cache-assembly-2026-06-13 (B-06 / P-010, decision D-014).
--
-- P-010 instruments per-wake efficiency: token usage + the cache_read/creation
-- ratio (already columns since 161) AND the per-wake TURN COUNT — the round-trip
-- metric (Win-2). Eliminating ~5 deterministic survey round-trips per Queen wake
-- (the precomputed brief, B-03) should show up as fewer turns/wake; without a
-- turn-count column that win is unmeasurable. The subprocess usage path
-- (extractRunUsage → recordUsageSamplePg) reads claude's `result.num_turns` and
-- persists it here; the in-process stateless-call path leaves it NULL (no turns).
--
-- Additive + nullable (no default rewrite), so it is a fast metadata-only ALTER —
-- safe under the deploy's lock_timeout. Boot-apply (A1) runs this before the
-- operator serves the new INSERT, so the new code never hits a missing column.
ALTER TABLE harness_shared.agent_usage_samples
  ADD COLUMN IF NOT EXISTS turn_count INTEGER;
