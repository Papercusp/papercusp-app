-- 179-iq-battery-corpus.sql
-- IQ battery corpus for v1 agent evaluation
-- Stores held-out test cases with ground truth, rubric, and rotation policy

CREATE TABLE IF NOT EXISTS iq_battery_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant text NOT NULL CHECK (variant IN ('fix-injected-bug', 'build-spec', 'find-the-flaw', 'answer-from-colony-memory')),
  title text NOT NULL,
  prompt text NOT NULL,
  ground_truth jsonb NOT NULL,
  rubric jsonb NOT NULL,
  rotation_index int DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS iq_battery_cases_variant ON iq_battery_cases(variant);
CREATE INDEX IF NOT EXISTS iq_battery_cases_rotation ON iq_battery_cases(variant, rotation_index);

-- Metrics table for tracking evaluation signals
CREATE TABLE IF NOT EXISTS iq_battery_metrics (
  run_id uuid NOT NULL,
  case_id uuid NOT NULL REFERENCES iq_battery_cases(id) ON DELETE CASCADE,
  variant text NOT NULL,
  success boolean,
  tokens_per_solved_task numeric,
  time_to_green_secs numeric,
  first_attempt_pass boolean,
  recurrence int,
  escalation boolean,
  recall_hit numeric,
  collected_at timestamp with time zone DEFAULT now(),
  PRIMARY KEY (run_id, case_id)
);

CREATE INDEX IF NOT EXISTS iq_battery_metrics_variant ON iq_battery_metrics(variant);
CREATE INDEX IF NOT EXISTS iq_battery_metrics_case ON iq_battery_metrics(case_id);
CREATE INDEX IF NOT EXISTS iq_battery_metrics_collected ON iq_battery_metrics(collected_at);

-- Aggregated metrics view for analysis
CREATE OR REPLACE VIEW iq_battery_metrics_summary AS
SELECT
  variant,
  COUNT(*) FILTER (WHERE success) as success_count,
  COUNT(*) as total_count,
  ROUND(100.0 * COUNT(*) FILTER (WHERE success) / NULLIF(COUNT(*), 0), 2) as success_rate,
  ROUND(AVG(tokens_per_solved_task) FILTER (WHERE success), 1) as avg_tokens,
  ROUND(AVG(time_to_green_secs) FILTER (WHERE success), 2) as avg_time_secs,
  ROUND(100.0 * COUNT(*) FILTER (WHERE first_attempt_pass) / NULLIF(COUNT(*), 0), 2) as first_attempt_rate,
  ROUND(AVG(recurrence), 1) as avg_recurrence,
  ROUND(100.0 * COUNT(*) FILTER (WHERE escalation) / NULLIF(COUNT(*), 0), 2) as escalation_rate,
  ROUND(AVG(recall_hit), 3) as avg_recall_hit,
  MAX(collected_at) as last_collected
FROM iq_battery_metrics
GROUP BY variant;

-- Percentile view for distribution analysis
CREATE OR REPLACE VIEW iq_battery_metrics_percentiles AS
SELECT
  variant,
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY tokens_per_solved_task) FILTER (WHERE success) as p50_tokens,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY tokens_per_solved_task) FILTER (WHERE success) as p95_tokens,
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY time_to_green_secs) FILTER (WHERE success) as p50_time_secs,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY time_to_green_secs) FILTER (WHERE success) as p95_time_secs,
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY recall_hit) as p50_recall,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY recall_hit) as p95_recall
FROM iq_battery_metrics
GROUP BY variant;
