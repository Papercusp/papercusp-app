-- 845-local-backends-last-busy-at
--
-- The idle-reaper's watermark.
-- Plan: on-demand-local-inference-lifecycle-2026-08-17 (P-007).
--
-- WHY A COLUMN AND NOT IN-PROCESS STATE: the reaper's rule is "idle for the WHOLE TTL", not
-- "idle at the instant I sampled". A single-sample reaper stops a backend in the gap between
-- two requests. Accumulating that across samples needs somewhere to put the watermark, and the
-- obvious in-process choices are both wrong here: a module-scoped Map is forbidden outright by
-- the storage policy, and it would also reset to "busy just now" on every operator restart,
-- silently making a backend un-reapable on any box that restarts more often than the TTL.
--
-- WHY DEFAULT now() AND NOT NULL: a NULL watermark would have to be read as either "never seen
-- busy" (reap it immediately — catastrophic on a backend serving traffic the moment the column
-- ships) or "unknown, skip it" (a reaper that never reaps until something else writes the
-- column). Defaulting to now() backfills every existing row as busy-as-of-migration-time, so
-- applying this migration cannot make anything reapable; the earliest any backend can be reaped
-- is one full TTL after the column exists. Same property 843 was written for.
--
-- EXPAND-ONLY, so no FORWARD-COMPAT acknowledgment is required: the column is defaulted, and
-- the currently-deployed release at :3070 neither reads nor writes it.

ALTER TABLE harness_shared.local_backends
  ADD COLUMN IF NOT EXISTS last_busy_at timestamptz NOT NULL DEFAULT now();

COMMENT ON COLUMN harness_shared.local_backends.last_busy_at IS
  'Idle-reaper watermark: the most recent moment this backend was OBSERVED to be doing work, or was started/registered. Reap when now() - last_busy_at > idle_ttl_sec. Stamped by the reaper whenever a /slots poll shows any slot processing, and by the ensure-running path when it starts a backend (so a cold-started backend is not reapable before it serves its first request). NOTE the observation is SAMPLED: a request that begins and ends entirely between two polls does not move this watermark, which is why the poll interval must stay well below the smallest idle_ttl_sec (P-007).';
