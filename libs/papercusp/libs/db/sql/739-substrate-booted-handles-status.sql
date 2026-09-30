-- 739-substrate-booted-handles-status.sql
--
-- Cross-SERVICE booted-handles snapshot (EI-19327550671915579, part 2 of
-- EI-18735338283879820).
--
-- EI-8816's `cluster-booted-handles-sync.ts` push model works only over
-- `node:cluster` IPC — confined to one process TREE (a primary + its own
-- forked workers). Under the dedicated-bg-host topology the true substrate
-- owner is a SEPARATE systemd service (`papercup-bg-host.service`); :3070 /
-- :3270 are each their own unforked host and can never receive that IPC
-- broadcast, so `reachedSubstrateOwner` was permanently false there (an
-- honest but permanently-unanswerable blind spot).
--
-- This table is the cross-service leg: whichever process actually OWNS the
-- substrate (`isSubstrateOwnerProcess()` true, checked per-beat — same rule
-- EI-18735338283879820 uses to gate the cluster broadcaster, so a non-owner
-- can never poison this row either) periodically writes its
-- `listBootedHandles()` snapshot here. A request-only host reads it as a
-- FALLBACK, after the in-process/cluster-IPC path, applying the same
-- staleness gate as the cluster-IPC leg.
--
-- Single-row-per-workspace JSONB row — matches the `operator_state` pattern
-- (see 029-operator-paused.sql). Payload shape:
--   { handles: BootedHandleSummary[], sentAt: number (epoch ms) }

CREATE TABLE IF NOT EXISTS harness_shared.substrate_booted_handles_status (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL,
  updated_at   BIGINT NOT NULL DEFAULT 0
);
