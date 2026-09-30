-- 582-blender-signal-accumulator.sql
--
-- blender-self-learning-2026-07-12 P-001 (WI-4317) + P-003 (WI-4319): the two
-- durable surfaces behind VOLUME-BASED Scout firing and DELTA-FIRST digest
-- rendering.
--
-- P-001 — scout_signal_accumulator: the Scout cadence gate today fires on a
-- time heartbeat (cadence.ts maxIntervalSec 3600) regardless of whether any NEW
-- signal accumulated since the last cycle — stale-corpus cycles burn budget to
-- re-generate ideas the dedup critic then declines (a suspected large chunk of
-- the routed-vs-ledger gap). This table is the deterministic, zero-token cache
-- of "how much NEW signal exists per lane since the last SUCCESSFUL cycle":
-- one row per (workspace, install, lane), RECOUNTED from the source tables by a
-- 30s routinesTick sweep (scout/signal-accumulator.ts) against a watermark
-- DERIVED from scout_ticks (status='ran') — never incremented, so the cache is
-- self-healing and safe to truncate (mirrors scout_lens_weights' cache-of-a-
-- derivation contract, migration 208). The cadence gate (P-002) consumes these
-- counts as a weighted score; score 0 never fires.
--
-- Lanes (per-lane precision documented in scout/signal-accumulator.ts):
--   scorecard-rating-changes | observations | captures | reverts | deferrals |
--   completions
--
-- P-003 — scout_digest_snapshots: the corpus digest is rebuilt from scratch
-- every cycle and rendered whole, so ideators keep re-seeing (and re-pitching)
-- standing top patterns — the stale-repetition → dedup-decline churn. This
-- table persists the digest built at fire time, so the NEXT cycle can render
-- "NEW since your last cycle" (per-lane deltas vs the previous snapshot /
-- watermark) ahead of standing patterns. Append-only, one row per fired cycle
-- (scout_ticks cadence ⇒ trivial volume; prune-safe).
--
-- Control-plane state (small, durable, operator-readable) → harness_shared in
-- the live operator DB, workspace-scoped, mirroring scout_ticks (208).
--
-- Idempotent (CREATE ... IF NOT EXISTS); additive; fresh-migrate-safe.

-- ── P-001: per-lane new-signal accumulator ────────────────────────────────────

CREATE TABLE IF NOT EXISTS harness_shared.scout_signal_accumulator (
    workspace_id  text NOT NULL,
    -- The Scout scope's install slug (mirrors scout_ticks.install_slug; the
    -- workspace-brain sentinel key is a valid value — the sweep writes whatever
    -- scope key the Scout scheduler reads back).
    install_slug  text NOT NULL,
    -- 'scorecard-rating-changes' | 'observations' | 'captures' | 'reverts'
    -- | 'deferrals' | 'completions' (see scout/signal-accumulator.ts LANES).
    lane          text NOT NULL,
    -- Signals in this lane NEWER than watermark_at, recounted each sweep.
    new_count     integer NOT NULL DEFAULT 0,
    -- Newest signal timestamp seen in this lane (diagnostics + delta rendering).
    high_water_at timestamptz,
    -- The recount baseline: the last SUCCESSFUL Scout cycle (scout_ticks
    -- status='ran') at sweep time; NULL = Scout never ran for this scope (the
    -- sweep then counts from its bounded lookback floor, not from epoch).
    watermark_at  timestamptz,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, install_slug, lane)
);

DO $$ BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class
           WHERE oid = 'harness_shared.scout_signal_accumulator'::regclass) THEN
    ALTER TABLE harness_shared.scout_signal_accumulator ENABLE ROW LEVEL SECURITY;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'harness_shared'
                  AND tablename = 'scout_signal_accumulator'
                  AND policyname = 'scout_signal_accumulator_workspace_isolation') THEN
    CREATE POLICY scout_signal_accumulator_workspace_isolation
        ON harness_shared.scout_signal_accumulator
        USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
        WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
  END IF;
  IF NOT has_table_privilege('harness_app', 'harness_shared.scout_signal_accumulator', 'INSERT') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.scout_signal_accumulator TO harness_app;
  END IF;
  IF NOT has_table_privilege('harness_zero', 'harness_shared.scout_signal_accumulator', 'SELECT') THEN
    GRANT SELECT ON harness_shared.scout_signal_accumulator TO harness_zero;
  END IF;
END $$;

-- ── P-003: persisted per-cycle digest snapshots ──────────────────────────────

CREATE TABLE IF NOT EXISTS harness_shared.scout_digest_snapshots (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workspace_id  text NOT NULL,
    -- Same scope key as the accumulator / scout_ticks.
    install_slug  text,
    -- The fired cycle this digest was built for (scout_ticks detail.cycleId).
    cycle_id      text,
    -- The accumulator watermark at build time (what "NEW since last cycle"
    -- was measured against when this cycle rendered its prompt).
    watermark_at  timestamptz,
    -- The full CorpusDigest the cycle ran with (DigestSchema shape).
    digest        jsonb NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- Primary read path: the latest snapshot for a scope (the previous cycle's
-- digest, diffed against the fresh build for delta-first rendering).
CREATE INDEX IF NOT EXISTS scout_digest_snapshots_ws_created_idx
    ON harness_shared.scout_digest_snapshots (workspace_id, created_at DESC);

DO $$ BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class
           WHERE oid = 'harness_shared.scout_digest_snapshots'::regclass) THEN
    ALTER TABLE harness_shared.scout_digest_snapshots ENABLE ROW LEVEL SECURITY;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'harness_shared'
                  AND tablename = 'scout_digest_snapshots'
                  AND policyname = 'scout_digest_snapshots_workspace_isolation') THEN
    CREATE POLICY scout_digest_snapshots_workspace_isolation
        ON harness_shared.scout_digest_snapshots
        USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
        WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
  END IF;
  IF NOT has_table_privilege('harness_app', 'harness_shared.scout_digest_snapshots', 'INSERT') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.scout_digest_snapshots TO harness_app;
  END IF;
  IF NOT has_table_privilege('harness_zero', 'harness_shared.scout_digest_snapshots', 'SELECT') THEN
    GRANT SELECT ON harness_shared.scout_digest_snapshots TO harness_zero;
  END IF;
END $$;
