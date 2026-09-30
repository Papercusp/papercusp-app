-- 862-dream-runs-ledger.sql — rem-dream-recombination-2026-08-17 P-005 / D-001
--
-- Durable, inspectable record of every dream attempt.  The row is inserted
-- before source selection or an LLM call and finalized in place for every
-- terminal outcome, so abstentions, malformed responses, review rejections,
-- accepted/routed insights, and failures all remain measurable.  One routine
-- fire is a cycle; run_id is the stable fire id plus the bounded dream index.
--
-- This is deliberately a ledger beside the existing Blender routed-idea rail,
-- not a second idea pipeline.  Accepted rows point at the ordinary routed ref;
-- downstream grading/outcomes continue to live on the existing Blender tables.
--
-- FORWARD-COMPAT: this is an additive table.  The currently deployed release
-- does not reference it, so it is safe to apply before the reader/writer code.

CREATE TABLE IF NOT EXISTS harness_shared.dream_runs (
    workspace_id       text NOT NULL,
    run_id             text NOT NULL,
    cycle_id           text NOT NULL,
    pot_slug           text NOT NULL,
    mode               text NOT NULL,
    status             text NOT NULL DEFAULT 'running',
    fragment_refs      jsonb NOT NULL DEFAULT '[]'::jsonb,
    fragment_kinds     jsonb NOT NULL DEFAULT '[]'::jsonb,
    pairing            text,
    similarity         double precision,
    dreamer_model      text,
    reviewer_model     text,
    dream_usage        jsonb,
    review_usage       jsonb,
    outcome            jsonb,
    review              jsonb,
    routed_ref         text,
    input_tokens       bigint NOT NULL DEFAULT 0,
    output_tokens      bigint NOT NULL DEFAULT 0,
    cost_usd           double precision NOT NULL DEFAULT 0,
    error              text,
    started_at         timestamptz NOT NULL DEFAULT now(),
    completed_at       timestamptz,
    spend_recorded_at  timestamptz,
    updated_at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, run_id),
    CONSTRAINT dream_runs_mode_check
      CHECK (mode IN ('manual', 'auto')),
    CONSTRAINT dream_runs_status_check
      CHECK (status IN (
        'running', 'no-pair', 'abstained', 'malformed', 'duplicate',
        'rejected', 'accepted', 'error'
      )),
    CONSTRAINT dream_runs_pairing_check
      CHECK (pairing IS NULL OR pairing IN ('banded', 'random')),
    CONSTRAINT dream_runs_fragment_refs_array_check
      CHECK (jsonb_typeof(fragment_refs) = 'array'),
    CONSTRAINT dream_runs_fragment_kinds_array_check
      CHECK (jsonb_typeof(fragment_kinds) = 'array'),
    CONSTRAINT dream_runs_usage_nonnegative_check
      CHECK (input_tokens >= 0 AND output_tokens >= 0 AND cost_usd >= 0)
);

COMMENT ON TABLE harness_shared.dream_runs IS
  'One durable row per REM dream attempt. Inserted before model work and finalized for every outcome; accepted rows point into the existing Blender routed-idea rail.';
COMMENT ON COLUMN harness_shared.dream_runs.spend_recorded_at IS
  'Set atomically with the learning_spend_events write; the replay/idempotency fence for governor accounting.';

CREATE INDEX IF NOT EXISTS dream_runs_ws_pot_started_idx
  ON harness_shared.dream_runs (workspace_id, pot_slug, started_at DESC);
CREATE INDEX IF NOT EXISTS dream_runs_ws_cycle_idx
  ON harness_shared.dream_runs (workspace_id, cycle_id, started_at ASC);
CREATE INDEX IF NOT EXISTS dream_runs_ws_status_started_idx
  ON harness_shared.dream_runs (workspace_id, status, started_at DESC);

DO $$ BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class
           WHERE oid = 'harness_shared.dream_runs'::regclass) THEN
    ALTER TABLE harness_shared.dream_runs ENABLE ROW LEVEL SECURITY;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'harness_shared'
       AND tablename = 'dream_runs'
       AND policyname = 'dream_runs_workspace_isolation'
  ) THEN
    CREATE POLICY dream_runs_workspace_isolation ON harness_shared.dream_runs
      USING (workspace_id = current_setting('app.workspace_id'::text, true))
      WITH CHECK (workspace_id = current_setting('app.workspace_id'::text, true));
  END IF;
  IF NOT has_table_privilege('harness_app', 'harness_shared.dream_runs', 'INSERT') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.dream_runs TO harness_app;
  END IF;
  IF NOT has_table_privilege('harness_zero', 'harness_shared.dream_runs', 'SELECT') THEN
    GRANT SELECT ON harness_shared.dream_runs TO harness_zero;
  END IF;
END $$;
