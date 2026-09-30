-- Migration 580 — memory recall canary bookkeeping (EI-10047).
--
-- The canary replays frozen known-item queries against the LIVE memory stack
-- (read-only) on a schedule and alerts when recall@10 drops below the frozen
-- baseline. It complements harness_shared.memory_precision_bench (migration
-- 312, isolated bench schema / fixture corpus — the CODE-PATH monitor) by
-- watching the DEPLOYMENT: live-store schema drift, embedder misconfig, index
-- corruption (the 2026-07-12 PG-42703 silent-blackout class).
--
-- memory_live_recall_canary_set: one row per frozen probe set (pairs = jsonb array
-- of { memoryId, scope, query, style }); version increments per workspace.
-- memory_live_recall_canary_run: one row per scheduled tick.

CREATE TABLE IF NOT EXISTS harness_shared.memory_live_recall_canary_set (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id text NOT NULL,
  version integer NOT NULL,
  backend text NOT NULL,
  pairs jsonb NOT NULL,
  pairs_n integer NOT NULL,
  baseline_r_at_10 double precision NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_live_recall_canary_set_ws_version UNIQUE (workspace_id, version)
);

CREATE TABLE IF NOT EXISTS harness_shared.memory_live_recall_canary_run (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id text NOT NULL,
  ran_at timestamptz NOT NULL DEFAULT now(),
  set_version integer NOT NULL,
  backend text NOT NULL,
  pairs_total integer NOT NULL,
  pairs_scored integer NOT NULL,
  pairs_missing integer NOT NULL,
  hits integer NOT NULL,
  r_at_10 double precision,
  baseline_r_at_10 double precision,
  delta double precision,
  zero_hit_rate double precision,
  latency_p50_ms double precision,
  -- 'ok' | 'degraded' | 'decayed' (set reseeded) | 'seeded' (first freeze)
  status text NOT NULL,
  notes text,
  CONSTRAINT memory_live_recall_canary_run_status_check
    CHECK (status = ANY (ARRAY['ok'::text, 'degraded'::text, 'decayed'::text, 'seeded'::text]))
);

CREATE INDEX IF NOT EXISTS memory_live_recall_canary_run_ws_ran_at_idx
  ON harness_shared.memory_live_recall_canary_run (workspace_id, ran_at DESC);
