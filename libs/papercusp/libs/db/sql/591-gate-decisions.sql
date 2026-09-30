-- 591-gate-decisions.sql — EI-10619: make a gate's DECISION an event.
--
-- harness_shared.tool_invocations records what a tool RETURNED, never what it DECIDED on the way
-- there. Every member of the cannot-discriminate class (agent-insights/prove-it-discriminates-
-- before-it-acts) is therefore invisible to it: orient's relevance floor admitted NOTHING for weeks
-- while the tool reported status=ok at a 0.6% error rate. EI-10609 tried to mine the existing
-- telemetry for these anyway and was falsified outright (0 of 5 known-broken gates detected).
--
-- `expect` is the load-bearing column, and the one a statistic CANNOT recover:
--
--   discriminates — the gate's job is to SEPARATE. A one-sided verdict distribution is a DEFECT.
--   guards        — the gate is a safety limit. Never firing is the HEALTHY case.
--
-- Without it, a broken discriminator and a healthy limit-that-never-trips are observationally
-- IDENTICAL over (gate, verdict, value, threshold) — both are 100% one-sided, both have the
-- threshold outside the observed value range. A detector without `expect` lights up every rate
-- limiter and auth check in the system, which is precisely how EI-10609 died. Intent cannot be
-- inferred from behaviour; it is DECLARED at the call site and then CHECKED against reality.
--
-- value/threshold are nullable: a categorical gate (an exact-key collision) has no scalar. They
-- EXPLAIN a degenerate distribution (which direction, what margin) — they are not the detection rule.

CREATE TABLE IF NOT EXISTS harness_shared.gate_decisions (
  id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  gate        TEXT        NOT NULL,
  expect      TEXT        NOT NULL CHECK (expect IN ('discriminates', 'guards')),
  verdict     TEXT        NOT NULL CHECK (verdict IN ('pass', 'reject')),
  value       DOUBLE PRECISION,
  threshold   DOUBLE PRECISION,
  subject     TEXT,
  decided_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The detector's only access pattern: per-gate windowed aggregate (verdict spread, value range).
CREATE INDEX IF NOT EXISTS gate_decisions_gate_decided_at_idx
  ON harness_shared.gate_decisions (gate, decided_at DESC);

-- Retention sweep support: this table is append-only on a hot path.
CREATE INDEX IF NOT EXISTS gate_decisions_decided_at_idx
  ON harness_shared.gate_decisions (decided_at);

COMMENT ON TABLE harness_shared.gate_decisions IS
  'EI-10619: one row per GATE DECISION (admit/reject/refuse/withhold). tool_invocations records what a tool returned, not what it decided — which is why the entire cannot-discriminate class was invisible to telemetry. Read by findDegenerateGates().';
COMMENT ON COLUMN harness_shared.gate_decisions.expect IS
  'What the gate is FOR — DECLARED at the call site, because it cannot be inferred from behaviour. discriminates: the gate must SEPARATE; a one-sided verdict distribution is a DEFECT. guards: a safety limit; never firing is HEALTHY. The detector applies its one-sided rule ONLY to discriminates gates — without this column a broken gate and a healthy never-tripping limit are indistinguishable.';
COMMENT ON COLUMN harness_shared.gate_decisions.value IS
  'The value the gate COMPARED (nullable — a categorical gate has no scalar). Explains a degenerate distribution; never the detection rule.';
COMMENT ON COLUMN harness_shared.gate_decisions.threshold IS
  'What `value` was compared against. With `value`, gives the MARGIN: how far off-scale the threshold sits (EI-10372: floor 0.05 vs an RRF ceiling of 0.0328 — the admit branch was unreachable by construction).';
