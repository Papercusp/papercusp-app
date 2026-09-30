-- 245-negative-space-demand.sql
--
-- self-learning-frontier-2026-06-12 (P-010 / FB-04): the negative-space
-- miner's demand map — what agents searched for and did NOT find.
--
-- One row per (workspace, surface, normalized query) aggregated from zero-hit
-- docs:search / plans:search / memory:search rows in
-- harness_shared.tool_invocations (the queries live in args_json, the hit
-- counts in metadata_json). The map is RECOMPUTED each miner tick over a
-- trailing window (idempotent, no watermark state); only
-- candidate_improvement_id survives the rewrite — it records that a capped
-- kind=change candidate ("N agents searched for X, nothing exists") was filed
-- through the anti-flood capture core, so a re-mine never double-files.
--
--   surface:                  'docs' | 'memory' | 'plans' — which search tool missed.
--   query_norm:               normalized query (lowercased, whitespace-collapsed) — the dedup key.
--   example_query:            a representative raw query (most recent).
--   miss_count:               zero-hit invocations in the window.
--   distinct_agents:          distinct callers (spawn identity) that missed.
--   first_missed_at/last_missed_at: window evidence bounds (last_missed_at is
--                             the capture's evidenceAt — stale-evidence dedup).
--   candidate_improvement_id: engineer_issues id once a candidate was filed.
--
-- Read side: readDemandSnapshot (lib/negative-space/demand-read.ts) feeds the
-- Learning tab Knowledge view's demand panel via the `learning.demand` sync
-- resolver. Volume: bounded by distinct zero-hit queries in the window —
-- hundreds, not millions. No RLS (mirrors 240-memory-recall-stats): the miner
-- and the resolver scope by workspace_id explicitly.

CREATE TABLE IF NOT EXISTS harness_shared.negative_space_demand (
    workspace_id             text NOT NULL,
    surface                  text NOT NULL,
    query_norm               text NOT NULL,
    example_query            text NOT NULL,
    miss_count               integer NOT NULL,
    distinct_agents          integer NOT NULL DEFAULT 1,
    first_missed_at          timestamptz NOT NULL,
    last_missed_at           timestamptz NOT NULL,
    candidate_improvement_id text,
    updated_at               timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT negative_space_demand_pkey
      PRIMARY KEY (workspace_id, surface, query_norm),
    CONSTRAINT negative_space_demand_surface_check
      CHECK (surface IN ('docs', 'memory', 'plans')),
    CONSTRAINT negative_space_demand_miss_count_check CHECK (miss_count > 0)
);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON harness_shared.negative_space_demand TO harness_app;
DO $z$ BEGIN
  GRANT SELECT ON harness_shared.negative_space_demand TO harness_zero;
EXCEPTION WHEN undefined_object THEN NULL;
END $z$;
