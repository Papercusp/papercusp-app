-- 495-substrate-outbox-drained-log-key
--
-- WI-2136 (orphan-tail recurrence guard, shared-hive-p2p-release-readiness):
-- drainer own-log-key ATTRIBUTION on each drained outbox row.
--
-- The class (WI-2105 finding): the tower bg-host own-log keypair does NOT persist
-- across restarts (e06b8704 era -> 4072cfad era). Every restart mints a fresh
-- keypair -> a fresh own-log; the prior era's unreplicated tail is orphaned (rows
-- sit drained_at-stamped but their blocks never replicate, because no live process
-- holds the dead log's keypair). The GO/NO-GO (d)-clause accepts RUNBOOK-ONLY
-- recovery (drained_at=NULL re-emit) ONLY because a detector makes the class loud.
--
-- The observability gap (noted 00:30Z): the outbox recorded WHEN a row drained
-- (drained_at) but not INTO WHICH own-log key. Without that, a post-restart
-- process cannot tell a row it drained onto the live log from one a prior era
-- drained onto a now-dead log. This column closes the gap: the drainer stamps its
-- live own-log key (handle.ownLog.keyHex) alongside drained_at, so the recurrence
-- guard (outbox-drain.ts detectOrphanDrainTail) can compare distinct
-- drained_log_key values of recently-drained fed-scope rows against the live key
-- and page a dead-era tail.
--
-- NULL for undrained rows (drained_at IS NULL) and for rows drained BEFORE this
-- migration deployed (legacy) -- the detector filters `drained_log_key IS NOT NULL`
-- so neither can false-fire. Idempotent.

ALTER TABLE harness_shared.substrate_outbox
  ADD COLUMN IF NOT EXISTS drained_log_key text;

COMMENT ON COLUMN harness_shared.substrate_outbox.drained_log_key IS
  'WI-2136: hex of the own-log key this fed-scope row was appended into at drain time (handle.ownLog.keyHex). NULL = undrained or drained pre-migration. The orphan-tail recurrence guard flags rows whose drained_log_key no longer matches the live own-log key (own-log keypair changed across a restart -> stranded tail; WI-2105 class).';
