\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS harness_shared.agent_runs_consolidated (
  harness_slug          TEXT NOT NULL,
  run_id                TEXT NOT NULL,
  role                  TEXT NOT NULL,
  feature_id            TEXT,
  ts                    BIGINT NOT NULL,
  size_bytes            BIGINT NOT NULL DEFAULT 0,
  duration_ms           BIGINT NOT NULL DEFAULT 0,
  cost_usd              DOUBLE PRECISION NOT NULL DEFAULT 0,
  input_tokens          BIGINT NOT NULL DEFAULT 0,
  output_tokens         BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens     BIGINT NOT NULL DEFAULT 0,
  cache_creation_tokens BIGINT NOT NULL DEFAULT 0,
  running               BOOLEAN NOT NULL DEFAULT false,
  last_event_ts         BIGINT,
  created_ts            BIGINT NOT NULL,
  updated_ts            BIGINT NOT NULL,
  PRIMARY KEY (harness_slug, run_id)
);
CREATE INDEX IF NOT EXISTS arc_ts_idx       ON harness_shared.agent_runs_consolidated (harness_slug, ts DESC);
CREATE INDEX IF NOT EXISTS arc_role_idx     ON harness_shared.agent_runs_consolidated (harness_slug, role);
CREATE INDEX IF NOT EXISTS arc_running_idx  ON harness_shared.agent_runs_consolidated (harness_slug, running) WHERE running = true;
CREATE INDEX IF NOT EXISTS arc_feature_idx  ON harness_shared.agent_runs_consolidated (harness_slug, feature_id);

CREATE TABLE IF NOT EXISTS harness_shared.harness_snapshots_consolidated (
  harness_slug   TEXT NOT NULL,
  snapshot_id    TEXT NOT NULL,
  ts             BIGINT NOT NULL,
  iter_num       INT NOT NULL DEFAULT 0,
  files          JSONB NOT NULL DEFAULT '[]'::jsonb,
  feature_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_ts     BIGINT NOT NULL,
  updated_ts     BIGINT NOT NULL,
  PRIMARY KEY (harness_slug, snapshot_id)
);
CREATE INDEX IF NOT EXISTS hsc_ts_idx   ON harness_shared.harness_snapshots_consolidated (harness_slug, ts DESC);
CREATE INDEX IF NOT EXISTS hsc_iter_idx ON harness_shared.harness_snapshots_consolidated (harness_slug, iter_num DESC);

CREATE OR REPLACE FUNCTION harness_shared.sync_agent_runs_consolidated()
RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    DELETE FROM harness_shared.agent_runs_consolidated
      WHERE harness_slug = OLD.harness_slug AND run_id = OLD.run_id;
    RETURN OLD;
  END IF;
  INSERT INTO harness_shared.agent_runs_consolidated VALUES (
    NEW.harness_slug, NEW.run_id, NEW.role, NEW.feature_id, NEW.ts, NEW.size_bytes,
    NEW.duration_ms, NEW.cost_usd, NEW.input_tokens, NEW.output_tokens,
    NEW.cache_read_tokens, NEW.cache_creation_tokens, NEW.running, NEW.last_event_ts,
    NEW.created_ts, NEW.updated_ts
  )
  ON CONFLICT (harness_slug, run_id) DO UPDATE SET
    role=EXCLUDED.role, feature_id=EXCLUDED.feature_id, ts=EXCLUDED.ts,
    size_bytes=EXCLUDED.size_bytes, duration_ms=EXCLUDED.duration_ms,
    cost_usd=EXCLUDED.cost_usd, input_tokens=EXCLUDED.input_tokens,
    output_tokens=EXCLUDED.output_tokens, cache_read_tokens=EXCLUDED.cache_read_tokens,
    cache_creation_tokens=EXCLUDED.cache_creation_tokens, running=EXCLUDED.running,
    last_event_ts=EXCLUDED.last_event_ts, created_ts=EXCLUDED.created_ts,
    updated_ts=EXCLUDED.updated_ts;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION harness_shared.sync_snapshots_consolidated()
RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    DELETE FROM harness_shared.harness_snapshots_consolidated
      WHERE harness_slug = OLD.harness_slug AND snapshot_id = OLD.snapshot_id;
    RETURN OLD;
  END IF;
  INSERT INTO harness_shared.harness_snapshots_consolidated VALUES (
    NEW.harness_slug, NEW.snapshot_id, NEW.ts, NEW.iter_num, NEW.files,
    NEW.feature_counts, NEW.created_ts, NEW.updated_ts
  )
  ON CONFLICT (harness_slug, snapshot_id) DO UPDATE SET
    ts=EXCLUDED.ts, iter_num=EXCLUDED.iter_num, files=EXCLUDED.files,
    feature_counts=EXCLUDED.feature_counts, created_ts=EXCLUDED.created_ts,
    updated_ts=EXCLUDED.updated_ts;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE s TEXT;
BEGIN
  FOR s IN SELECT schema_name FROM information_schema.schemata
            WHERE schema_name LIKE 'harness_%' AND schema_name <> 'harness_shared'
  LOOP
    BEGIN
      EXECUTE format($f$
        DROP TRIGGER IF EXISTS sync_agent_runs_consolidated_trg ON %1$I.agent_runs;
        CREATE TRIGGER sync_agent_runs_consolidated_trg
          AFTER INSERT OR UPDATE OR DELETE ON %1$I.agent_runs
          FOR EACH ROW EXECUTE FUNCTION harness_shared.sync_agent_runs_consolidated();
      $f$, s);
      EXECUTE format(
        'INSERT INTO harness_shared.agent_runs_consolidated SELECT * FROM %I.agent_runs ON CONFLICT (harness_slug, run_id) DO NOTHING', s);
    EXCEPTION WHEN OTHERS THEN END;

    BEGIN
      EXECUTE format($f$
        DROP TRIGGER IF EXISTS sync_snapshots_consolidated_trg ON %1$I.harness_snapshots;
        CREATE TRIGGER sync_snapshots_consolidated_trg
          AFTER INSERT OR UPDATE OR DELETE ON %1$I.harness_snapshots
          FOR EACH ROW EXECUTE FUNCTION harness_shared.sync_snapshots_consolidated();
      $f$, s);
      EXECUTE format(
        'INSERT INTO harness_shared.harness_snapshots_consolidated SELECT * FROM %I.harness_snapshots ON CONFLICT (harness_slug, snapshot_id) DO NOTHING', s);
    EXCEPTION WHEN OTHERS THEN END;
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.agent_runs_consolidated, harness_shared.harness_snapshots_consolidated TO harness_app;
GRANT SELECT ON harness_shared.agent_runs_consolidated, harness_shared.harness_snapshots_consolidated TO harness_zero;

COMMENT ON TABLE harness_shared.agent_runs_consolidated IS 'Canonical store for agent runs (Migration 031). Trigger-mirrored from per-harness agent_runs.';
COMMENT ON TABLE harness_shared.harness_snapshots_consolidated IS 'Canonical store for harness snapshots (Migration 031). Trigger-mirrored.';

COMMIT;
