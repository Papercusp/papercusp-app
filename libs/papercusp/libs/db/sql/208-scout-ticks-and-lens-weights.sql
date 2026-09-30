-- 208-scout-ticks-and-lens-weights.sql
--
-- learning-system-audit-improvements-2026-06-09 (P-034 + P-033): Scout tick
-- observability + the persisted lens meta-learning weights.
--
-- P-034 — scout_ticks: the `scout-cycle` routine is ACTIVE but every tick's
-- outcome vanished into a console.log (or, for the common self-gated no-op,
-- into nothing at all). With `scout_routed_ideas` empty there was no way to ask
-- "is the Scout ever firing, and if not, WHICH self-gate (idle-capacity /
-- friction / budget / autoloop circuit) is stopping it?". This table is the
-- durable per-tick record, mirroring `watchdog_ticks` (migration 202):
-- append-only, one row per tick, trivial volume at the routine cadence.
--
-- P-033 — scout_lens_weights: scout/outcome-feedback.ts computes per-lens
-- win-rates (Beta-prior smoothed weights) but never persisted them, so the
-- ideators ran with static lens selection — the feedback loop was severed.
-- This table is the persisted projection the ideator lens-selection path reads
-- back (with a sampling floor so no lens is ever zeroed). One row per
-- (workspace, lens); recomputed/upserted each time the ledger read path
-- classifies routed-idea outcomes — a cache of a derivation, safe to truncate.
--
-- Control-plane state (small, durable, operator-readable) → harness_shared in
-- the live operator DB, workspace-scoped, mirroring scout_routed_ideas (194).
--
-- Idempotent (CREATE ... IF NOT EXISTS); additive; fresh-migrate-safe.

CREATE TABLE IF NOT EXISTS harness_shared.scout_ticks (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workspace_id    text NOT NULL,
    -- The routine's install slug (e.g. 'papercup'); the harness the tick ran for.
    install_slug    text,
    -- When the tick ran.
    tick_at         timestamptz NOT NULL DEFAULT now(),
    -- 'ran'   — the self-gates passed and a budgeted cycle executed;
    -- 'gated' — a self-gate withheld the cycle (see `gate`);
    -- 'error' — the cycle fired but threw (detail carries the message).
    status          text NOT NULL DEFAULT 'ran',
    -- WHICH self-gate stopped a 'gated' tick: 'min-interval' | 'no-trigger'
    -- (cadence) | 'circuit' (autoloop fire-gate). NULL on ran/error.
    gate            text,
    -- Full-cycle counters (0 on gated ticks): ideas the ideators produced,
    -- routed-idea provenance rows persisted, and ideas the critics pruned
    -- (the novelty/feasibility dedup: scored − survivors).
    ideas_generated integer NOT NULL DEFAULT 0,
    ideas_routed    integer NOT NULL DEFAULT 0,
    ideas_deduped   integer NOT NULL DEFAULT 0,
    -- LLM spend of the cycle (USD); NULL when no cycle ran.
    budget_used_usd numeric,
    -- Free-form extras: { reason, cycleId, stop, retryAfterSec, error, ... }.
    detail          jsonb
);

-- Primary read path: the last N ticks for a workspace, newest first.
CREATE INDEX IF NOT EXISTS scout_ticks_ws_tick_at_idx
    ON harness_shared.scout_ticks (workspace_id, tick_at DESC);

-- Workspace isolation, mirroring scout_routed_ideas (194) / watchdog_ticks (202).
-- Existence-guarded so a RE-RUN on an already-applied DB takes ZERO table locks
-- (the 2026-06-09 auto-deploy died on a lock timeout re-applying this file after
-- a manual dev-box apply — ALTER/CREATE POLICY/GRANT all want ACCESS EXCLUSIVE).
DO $$ BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class
           WHERE oid = 'harness_shared.scout_ticks'::regclass) THEN
    ALTER TABLE harness_shared.scout_ticks ENABLE ROW LEVEL SECURITY;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'harness_shared'
                  AND tablename = 'scout_ticks' AND policyname = 'scout_ticks_workspace_isolation') THEN
    CREATE POLICY scout_ticks_workspace_isolation ON harness_shared.scout_ticks
        USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
        WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
  END IF;
  IF NOT has_table_privilege('harness_app', 'harness_shared.scout_ticks', 'INSERT') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.scout_ticks TO harness_app;
  END IF;
  IF NOT has_table_privilege('harness_zero', 'harness_shared.scout_ticks', 'SELECT') THEN
    GRANT SELECT ON harness_shared.scout_ticks TO harness_zero;
  END IF;
END $$;

-- ── P-033: persisted per-lens meta-learning weights ──────────────────────────

CREATE TABLE IF NOT EXISTS harness_shared.scout_lens_weights (
    workspace_id text NOT NULL,
    -- CreativeLens id: analogical | first-principles | reframing | constraint-removal.
    lens         text NOT NULL,
    -- Routed ideas from this lens that WON (terminal-success in the Change Feed).
    wins         integer NOT NULL DEFAULT 0,
    -- Routed ideas decided either way (won + lost); pending excluded.
    decided      integer NOT NULL DEFAULT 0,
    -- The Beta-prior-smoothed, floored, normalized sampling share from
    -- computeLensOutcomes — the weight the ideator fan-out reads back.
    weight       numeric NOT NULL,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, lens)
);

DO $$ BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class
           WHERE oid = 'harness_shared.scout_lens_weights'::regclass) THEN
    ALTER TABLE harness_shared.scout_lens_weights ENABLE ROW LEVEL SECURITY;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'harness_shared'
                  AND tablename = 'scout_lens_weights' AND policyname = 'scout_lens_weights_workspace_isolation') THEN
    CREATE POLICY scout_lens_weights_workspace_isolation ON harness_shared.scout_lens_weights
        USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
        WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
  END IF;
  IF NOT has_table_privilege('harness_app', 'harness_shared.scout_lens_weights', 'INSERT') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.scout_lens_weights TO harness_app;
  END IF;
  IF NOT has_table_privilege('harness_zero', 'harness_shared.scout_lens_weights', 'SELECT') THEN
    GRANT SELECT ON harness_shared.scout_lens_weights TO harness_zero;
  END IF;
END $$;
