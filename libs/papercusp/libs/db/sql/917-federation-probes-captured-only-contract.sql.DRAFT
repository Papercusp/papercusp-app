-- 917-federation-probes-captured-only-contract.sql
-- WI-3962 — CONTRACT phase for the captured-only federation-probe receipt.
--
-- ROLLOUT ORDER IS LOAD-BEARING. Keep this file suffixed `.sql.DRAFT` until a
-- prior green release containing the captured-only probe reader/writer has
-- deployed to :3070. Arm it only in a later commit, so both the then-live
-- release and its rollback target no longer select the dead columns or write
-- pending/timed_out statuses.
--
-- FORWARD-COMPAT: this CONTRACT migration is armed only after a prior green
-- release has deployed the captured-only reader/writer; at arm time both the
-- live release and its rollback target ignore these columns and write only
-- acked/refused. The arming work-item records the verified release SHA.
--
-- `federation_probes` is emitter-local. No real drain/replicate/merge/
-- member-guard/project stage ever wrote the five corresponding timestamp
-- columns, and several of those stages execute on a receiver whose local table
-- has no row for the emitter's probe key. The old default read therefore
-- reported every healthy and unhealthy pipeline alike as stalled after
-- `captured`: an unconditional false-NO-GO, not observability.
--
-- The honest contract has two terminal states:
--   acked   — a correctly stamped declaration was captured locally;
--   refused — emit rejected the declaration before capture, with a reason.
-- Post-capture health is measured from substrate_outbox drain state,
-- substrate_merge_cursor advancement, and fresh origin='remote' rows.

ALTER TABLE harness_shared.federation_probes
  DROP CONSTRAINT IF EXISTS federation_probes_status_check;

-- Every accepted historical row was created with captured_at in the same
-- INSERT. Its pending/timed_out status described only the never-wired synthetic
-- hops, so preserve the fact the row really contains: local capture succeeded.
UPDATE harness_shared.federation_probes
   SET status = 'acked',
       refusal_reason = NULL
 WHERE captured_at IS NOT NULL;

-- The only supported uncaptured write was insertRefusedProbe. Normalize any
-- legacy malformed uncaptured row loudly instead of leaving a third state that
-- the repaired contract cannot represent.
UPDATE harness_shared.federation_probes
   SET status = 'refused',
       refusal_reason = COALESCE(refusal_reason, 'legacy_probe_not_captured')
 WHERE captured_at IS NULL;

ALTER TABLE harness_shared.federation_probes
  ALTER COLUMN status DROP DEFAULT,
  DROP COLUMN IF EXISTS drained_at,
  DROP COLUMN IF EXISTS replicated_at,
  DROP COLUMN IF EXISTS merged_at,
  DROP COLUMN IF EXISTS member_guard_at,
  DROP COLUMN IF EXISTS projected_at,
  DROP COLUMN IF EXISTS detail;

ALTER TABLE harness_shared.federation_probes
  ADD CONSTRAINT federation_probes_capture_state_check CHECK (
    (status = 'acked' AND captured_at IS NOT NULL AND refusal_reason IS NULL)
    OR
    (status = 'refused' AND captured_at IS NULL AND refusal_reason IS NOT NULL)
  );

COMMENT ON TABLE harness_shared.federation_probes IS
  'Captured-only receipts for probe:emit (WI-3962). acked proves local capture of a correctly stamped declaration; refused records a pre-capture rejection. This table is not a post-capture federation-health signal.';

COMMENT ON COLUMN harness_shared.federation_probes.captured_at IS
  'Local capture time for an acked probe. NULL exactly when status=refused. Does not prove drain, replication, merge, member-guard, or projection.';
