-- 1176 — CONTRACT phase: drop the superseded TOTAL dedup index on
-- spec_evidence_bindings.
--
-- EI-23634085867209303. Second half of the expand/contract begun in 1175, which
-- created the partial index spec_evidence_bindings_dedup_live (live proof only) and
-- deliberately left the total index spec_evidence_bindings_dedup in place.
--
-- DO NOT ARM THIS UNTIL THE PREDICATED WRITER IS THE DEPLOYED ONE.
--
-- Arming precondition, in full: the release build serving :3070 must carry the
-- `ON CONFLICT (...) WHERE retracted_at IS NULL` form of bindSpecEvidence
-- (packages/operator-core/lib/agent-tools/plans/spec-evidence-store.ts). Until this
-- does, the deployed writer's un-predicated ON CONFLICT has no inferrable arbiter
-- the moment this index is gone, and EVERY spec-evidence insert fails at plan time
-- with 42P10. The 1175 header carries the measured A/B behind this claim.
--
-- FORWARD-COMPAT: this is destructive DDL, and it is armed only after the writer
-- precondition is satisfied. No deployed release still references the total index.

DROP INDEX IF EXISTS harness_shared.spec_evidence_bindings_dedup;
