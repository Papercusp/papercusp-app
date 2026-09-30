-- 746-embed-coverage-samples.sql — WI-7469
-- Plan semantic-search-fingerprint-coverage-2026-08-03, items P-008 / P-027 / P-006.
--
-- WHY A TABLE AT ALL (the storage-growth-alarm precedent argues against one, and it is
-- right for ITS problem): an ABSOLUTE threshold is stateless and cannot false-negative,
-- so `storage-growth-alarm` deliberately keeps no history. Two of the three signals here
-- are absolute the same way — eligible-row coverage and 24h-new-row coverage are both
-- computed from a single instantaneous scan and need nothing persisted.
--
-- P-006 is the one that does. "Drain rate > write rate, per surface" is a RATE, and the
-- plan asks for it as an EXPLICIT MEASURED INVARIANT rather than an emergent property.
-- A rate needs two observations. The cheapest honest form is the backlog delta between
-- consecutive samples, which decomposes exactly:
--
--     backlog(t) - backlog(t-1)  =  (eligible rows written)  -  (rows drained)
--
-- so one persisted row per surface per tick yields both rates and the invariant, with no
-- new instrumentation on the sweep's hot path and no dependency on the sweep having run.
--
-- It also buys the thing a stateless alarm structurally cannot do, and which this plan
-- exists because of: distinguish "coverage is low and CONVERGING" (a known backlog
-- draining — the state papercusp is in right now, expected, not a defect) from "coverage
-- is low and NOT converging" (the real fault). Without that, a total-coverage floor fires
-- from day one for the entire multi-hour drain, gets muted, and is useless by the time it
-- would have meant something — which is exactly the failure mode P-027 identifies for the
-- ineligible-row denominator, arriving by a second route.
--
-- SIZE: 10 surfaces × 1 sample / 30 min = 480 rows/day, ~15k rows/month, no TOAST columns.
-- The alarm tick prunes past a retention window, so this is bounded by construction and
-- cannot become the silent-growth class the storage alarm above watches for.

CREATE TABLE IF NOT EXISTS harness_shared.embed_coverage_samples (
  id                  BIGSERIAL PRIMARY KEY,
  workspace_id        TEXT        NOT NULL,
  observed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- '<schema>.<table>.<embedCol>' — a surface is a (table, embedding column) pair, not a
  -- table: nothing prevents a future table carrying two embedded columns, and keying on
  -- the table alone would silently merge their series into one nonsense curve.
  surface             TEXT        NOT NULL,

  -- Every row in the table, including ones the sweep can never embed. Kept ONLY so the
  -- ineligible share stays visible (P-028 revisits the eligibility cuts themselves and
  -- needs to see them); no alarm is computed against it. Alarming on total_rows is the
  -- precise defect P-027 exists to prevent.
  total_rows          BIGINT      NOT NULL,

  -- Rows the sweep would actually SELECT: `length(<the target's own bodySql>) > 0`, the
  -- byte-identical predicate `backfillTable` filters on. Derived from the target
  -- definition rather than restated here, so the metric cannot drift from what the sweep
  -- embeds (a restated predicate is how "18.4% excluded by design" became an alarm that
  -- could never be satisfied).
  eligible_rows       BIGINT      NOT NULL,
  embedded_rows       BIGINT      NOT NULL,   -- eligible AND <embedCol> IS NOT NULL

  -- The recurrence signal: the same two counts restricted to rows WRITTEN in the last
  -- `recent_window_hours`. This, not total coverage, is what catches a regression while it
  -- is still small — total coverage moves too slowly to see one, and a backlog draining
  -- underneath masks it entirely. NULL for the two surfaces that carry no write-time
  -- column at all (harness_escalations, harness_decisions): absent, not zero, so a missing
  -- signal can never be read as a breach.
  recent_eligible     BIGINT,
  recent_embedded     BIGINT,
  recent_window_hours INTEGER
);

-- The only read shape: "the last N samples for this surface, newest first" (the rate
-- delta) and "every surface's latest sample" (the report).
CREATE INDEX IF NOT EXISTS embed_coverage_samples_ws_surface_ts_idx
  ON harness_shared.embed_coverage_samples (workspace_id, surface, observed_at DESC);
