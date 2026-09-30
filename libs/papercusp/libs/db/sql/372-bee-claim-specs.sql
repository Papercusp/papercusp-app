-- 372-bee-claim-specs.sql
--
-- hybrid-bee-scheduler-work-stealing-2026-06-22 — the per-bee claim-spec store (the spec-handoff
-- that makes get_next usable: the Queen sets a bee's versioned view.filter+rank, the bee's
-- get_next loads it).
--
-- The Queen calls set_claim_spec(beeId, spec) → validateClaimSpec + upsert here; the bee calls
-- get_next → loads its spec from here (DEFAULT_CLAIM_SPEC if none) → getNextWorkItem. Keyed by the
-- bee's session/owner id (the identity a tool ctx resolves via actor-identity, and the id the Queen
-- addresses a bee by). Versioned (revision) so re-steering a running bee is a spec bump, not
-- micro-dispatch (D-003). Idempotent.

CREATE TABLE IF NOT EXISTS harness_shared.bee_claim_specs (
    workspace_id text        NOT NULL DEFAULT 'default',
    bee_id       text        NOT NULL,
    spec         jsonb       NOT NULL,
    revision     integer     NOT NULL DEFAULT 0,
    updated_by   text,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT bee_claim_specs_bee_nonempty CHECK (bee_id <> ''),
    CONSTRAINT bee_claim_specs_ws_nonempty  CHECK (workspace_id <> ''),
    PRIMARY KEY (workspace_id, bee_id)
);

COMMENT ON TABLE harness_shared.bee_claim_specs IS
  'Per-bee claim spec (hybrid-bee-scheduler-work-stealing-2026-06-22). The Queen sets a bee''s versioned view.filter+rank via set_claim_spec; the bee''s get_next loads it (DEFAULT_CLAIM_SPEC when absent) to deterministically claim its next work-item within the global floors.';
