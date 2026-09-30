-- EI-20220411691737549: the flush gate's retry marker must cross clustered
-- operator workers. A process-local Map can refuse every retry when requests
-- round-robin across workers, violating the one-refusal contract.
CREATE TABLE IF NOT EXISTS harness_shared.flush_gate_refusals (
  boundary   text NOT NULL,
  owner_id   text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (boundary, owner_id)
);

CREATE INDEX IF NOT EXISTS idx_flush_gate_refusals_expires
  ON harness_shared.flush_gate_refusals (expires_at);

COMMENT ON TABLE harness_shared.flush_gate_refusals IS
  'Short-TTL P-016 flush-boundary refusal markers. Postgres-backed because consecutive requests may hit different clustered operator workers.';
