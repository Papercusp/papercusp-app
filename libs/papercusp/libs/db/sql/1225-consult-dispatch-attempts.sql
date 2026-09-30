-- 1225-consult-dispatch-attempts.sql
--
-- WI-10003197 (plan review-routing-through-relevance-router-2026-09-26, P-001):
-- persist every consult answering-session dispatch walk on the consult it served.
--
--   dispatch_attempts — append-only, bounded (newest 24 kept) array of dispatch
--   records. One record per dispatchConsultResponder call:
--     { at, sourceOwnerId, dispatched, answeringOwnerId, operation, agent, model,
--       verified, detail, attempts: [{ rank, agent, model, operation, outcome,
--       reason, detail, launchError? }] }
--
-- Why: the dispatcher already computed a per-rank verdict (rank, backend, model,
-- outcome, reason) for every walk, but no caller persisted it. The cascade kept
-- only a delivery count and the answering identity, so a failed fork or convert
-- was visible only by grepping fleet-logs. Measured 2026-09-26 over 7 days:
-- 545 of 1,168 answering-session launches were refused by psu within seconds,
-- and none of those reasons reached the database.
--
-- A separate column (not a field inside routing/cascade_digest) because those
-- two are rewritten wholesale under the cascade's compare-and-swap, and a
-- concurrent append there would either clobber or be clobbered. This column has
-- exactly one writer, which only ever appends.

ALTER TABLE harness_shared.consult_state
  ADD COLUMN IF NOT EXISTS dispatch_attempts jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN harness_shared.consult_state.dispatch_attempts IS
  'Append-only bounded log (newest 24) of answering-session dispatch walks for this consult: one record per dispatch with its per-rank attempts (rank, agent, model, operation, outcome, reason, detail, launchError). Written best-effort by consult-dispatch.ts recordDispatchAttempts; never read by the cascade CAS. WI-10003197.';
