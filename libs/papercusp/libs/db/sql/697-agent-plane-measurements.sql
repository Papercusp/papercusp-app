-- 697-agent-plane-measurements.sql
--
-- unified-agent-state-plane-2026-07-27, P-015: the baseline + standing
-- measurement series for the agent state plane.
--
-- P-015 exists to stop the plane repeating the non-monotonic
-- 47.1% -> 59.1% -> 34.9% evidence-compliance curve seen on su-07374's plan --
-- "the signature of a rule carried by prose rather than structure". A curve is
-- only visible if the readings are KEPT, which is what this table is for.
--
-- ⚠ APPEND-ONLY, ONE ROW PER WINDOW. This is deliberately NOT an upsert cache.
-- D-030 §3 requires "at least two batches per condition so the variance is
-- visible", because in su-07374's experiment the WITHIN-arm variance equalled
-- the BETWEEN-arm variance (the same arm scored 2/3 then 0/3). A single-batch
-- before/after delta "will report noise with a straight face". So
-- `harness_shared.derived_read_snapshots` was considered and REJECTED: its
-- primary key is (workspace_id, harness_slug, key), i.e. replace-on-write, and
-- a store that keeps only the latest reading can never show a spread.
--
-- ⚠ WHY jsonb FOR THE METRICS AND NOT SIX COLUMNS. Each metric ships a FUNNEL
-- (population / eligible / comparable / observed) plus its pre-registered
-- question, producer and vacuous-pass answer -- and the pre-registration is
-- frozen in code (`lib/agent-plane-measurement.ts` METRIC_SPECS), not here.
-- Flattening six metrics x four counts into columns would put the metric set in
-- the schema, so adding a metric would need a migration and -- worse -- an OLD
-- row would silently acquire the NEW metric's columns as NULLs, which reads as
-- "measured zero" for a window that never measured it at all. That is the exact
-- confusion this item is about. The payload is small (~6 KB/row) and written at
-- most once per routines tick.
--
-- ⚠ A ZERO IN HERE IS USUALLY NOT A MEASUREMENT. Measured 2026-07-27, live:
-- 176,784 tool calls in 24h carrying 0 intent_event_id / 0 assumption_set_id /
-- 0 goal_ref (P-009's writer is not deployed), and 2,148 agent_facts rows
-- carrying 0 assumptions, 0 dependsOn and 0 typed claims. FOUR of the six
-- metrics are therefore structurally unmeasurable at the time this table is
-- created, and each row records that per metric via `fillRate` + `zeroReason`
-- rather than reporting a rate of 0. Read `fill_rate` before `rate`, always.
--
-- Retention: none. The series is the artefact -- a row is ~6 KB and the writer
-- is a single routines-tick step, so this grows by a few MB/year. Pruning it
-- would delete the only record of the baseline it exists to preserve.

CREATE TABLE IF NOT EXISTS harness_shared.agent_plane_measurements (
  id              bigserial PRIMARY KEY,
  workspace_id    text        NOT NULL,
  harness_slug    text        NOT NULL DEFAULT '',
  -- When the measurement was TAKEN, and the window it describes. Both, because a
  -- sweep that falls behind produces rows whose window does not end at `now()`,
  -- and a reader comparing windows must not silently compare wall-clock instead.
  measured_at     timestamptz NOT NULL DEFAULT now(),
  window_start    timestamptz NOT NULL,
  window_end      timestamptz NOT NULL,
  -- The composed PlaneMeasurement: metrics[] with the full funnel per metric.
  metrics         jsonb       NOT NULL,
  -- Denormalised headline counts, so the common "is the plane measurable yet?"
  -- read needs no jsonb traversal.
  interpretable_count integer NOT NULL DEFAULT 0,
  metric_count        integer NOT NULL DEFAULT 0,
  summary             text    NOT NULL DEFAULT '',
  -- Bumped when the metric set or a derivation changes, so a trend is never drawn
  -- across a definition change without the reader being able to see it happened.
  producer_version integer    NOT NULL DEFAULT 1
);

-- The read this table exists for: one workspace's series, newest first.
CREATE INDEX IF NOT EXISTS agent_plane_measurements_series_idx
  ON harness_shared.agent_plane_measurements (workspace_id, harness_slug, measured_at DESC);
