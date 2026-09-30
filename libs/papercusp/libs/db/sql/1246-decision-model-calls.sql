-- 1246-decision-model-calls.sql — the typed-decision-model call ledger.
-- Plan jev-decision-model-integration-2026-09-29, P-003 (D-006; D-004 for the model id).
--
-- One row per decision-model call (TypeSafe Jev today), written fire-and-forget
-- from the @papercusp/decision-model client's onCall observer. It is the audit
-- trail for every verdict: which model version ANSWERED, under which question set
-- and option order, with what probabilities and confidence, how long it took,
-- what it used, and whether it answered at all.
--
-- HASHES AND IDS, NEVER RAW TEXT (D-006). The judged state is a user turn plus
-- memory or doc text that already lives in Postgres and resolves by id
-- (subject_ids). A raw copy here would be a second, unbounded store of owner
-- prompts, so only its sha256 is kept: enough to spot repeats, nothing to leak.
-- inconclusive_detail is filled only for failures whose message the client wrote
-- itself; a provider error body (which can quote the request) is never stored.
--
-- Not harness_shared.decision_ledger: that table records governed agent ACTIONS
-- at the dispatch chokepoint (posture, category, authority). This one records
-- model CALLS with per-question probabilities — a different grain and shape.
--
-- questions_schema_sha256 is ORDER-INSENSITIVE (key-sorted canonical JSON) and
-- option_order holds the order actually sent, so calls that differ only in option
-- order share a schema hash — the grouping the P-005 order-flip check needs.

CREATE TABLE IF NOT EXISTS harness_shared.decision_model_calls (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id            text        NOT NULL DEFAULT 'default',
  consumer                text,
  provider                text        NOT NULL,
  requested_model         text        NOT NULL,
  returned_model          text,
  question_ids            text[]      NOT NULL DEFAULT '{}',
  questions_schema_sha256 text        NOT NULL,
  option_order            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  answers                 jsonb,
  outcome                 text        NOT NULL,
  inconclusive_reason     text,
  inconclusive_detail     text,
  http_status             integer,
  attempts                integer     NOT NULL DEFAULT 0,
  latency_ms              integer     NOT NULL,
  input_tokens            integer,
  output_tokens           integer,
  cost_usd                numeric(14, 8),
  subject_ids             text[]      NOT NULL DEFAULT '{}',
  state_sha256            text        NOT NULL,
  started_at              timestamptz NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT decision_model_calls_outcome_check
    CHECK (outcome IN ('answered', 'inconclusive')),
  -- An answered row names the model that answered and carries its answers; an
  -- inconclusive row carries a reason and no answers. No partial third state.
  CONSTRAINT decision_model_calls_outcome_shape
    CHECK (
      (outcome = 'answered' AND returned_model IS NOT NULL AND answers IS NOT NULL AND inconclusive_reason IS NULL)
      OR (outcome = 'inconclusive' AND inconclusive_reason IS NOT NULL AND answers IS NULL)
    ),
  CONSTRAINT decision_model_calls_sha256_shape
    CHECK (state_sha256 ~ '^[0-9a-f]{64}$' AND questions_schema_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT decision_model_calls_nonnegative
    CHECK (
      latency_ms >= 0 AND attempts >= 0
      AND (input_tokens IS NULL OR input_tokens >= 0)
      AND (output_tokens IS NULL OR output_tokens >= 0)
      AND (cost_usd IS NULL OR cost_usd >= 0)
    )
);

COMMENT ON TABLE harness_shared.decision_model_calls IS
  'One row per typed-decision-model call (TypeSafe Jev). Hashes and subject ids only, never raw state text (plan jev-decision-model-integration-2026-09-29 D-006).';
COMMENT ON COLUMN harness_shared.decision_model_calls.returned_model IS
  'The model id the provider says answered (D-004) — not the requested id.';
COMMENT ON COLUMN harness_shared.decision_model_calls.questions_schema_sha256 IS
  'sha256 of the key-sorted canonical JSON of the question set; option order is excluded here and kept in option_order.';
COMMENT ON COLUMN harness_shared.decision_model_calls.option_order IS
  'Choice question id -> option keys in the order they were sent.';
COMMENT ON COLUMN harness_shared.decision_model_calls.state_sha256 IS
  'sha256 of the canonical JSON encoding of the judged state. The state itself is never stored.';
COMMENT ON COLUMN harness_shared.decision_model_calls.inconclusive_detail IS
  'Client-written failure detail only (validation, parse, transport). Provider response bodies are never stored.';

CREATE INDEX IF NOT EXISTS decision_model_calls_ws_consumer_created_idx
  ON harness_shared.decision_model_calls (workspace_id, consumer, created_at DESC);

CREATE INDEX IF NOT EXISTS decision_model_calls_state_sha256_idx
  ON harness_shared.decision_model_calls (state_sha256);
