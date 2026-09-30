-- 800: a session KILLED BY A SIGNAL is not a voluntary exit — give it its own
-- `ended_by`, and record WHICH signal, so a mass reap is queryable.
--
-- WI-38054. Direct sequel to 735, which introduced `ended_by` for the *other* half
-- of this problem.
--
-- WHY
-- ---
-- 735 split `ended_at`'s writers into SELF-REPORT vs OBSERVER. That axis is about
-- WHEN: is `ended_at` the real end time, or the time a sweeper NOTICED? It left a
-- second, orthogonal axis unrepresentable — WHETHER THE EXIT WAS VOLUNTARY:
--
--   'self'  meant BOTH "we observed the end" AND "the session chose to exit".
--
-- Those come apart exactly when it matters most. When the :3270 sidecar restarts, it
-- tears down the cgroup holding every agent it spawned. The managed-PTY host takes
-- SIGTERM, kills its child's process group with SIGHUP/SIGKILL, and the child's death
-- IS observed in real time by its live parent — so `ended_at` is a genuine end time,
-- and 735's axis correctly says "not an observer". But the exit was anything but
-- voluntary, and there was no way to say so.
--
-- The record therefore claimed the opposite of what happened. MEASURED 2026-08-12
-- (WI-38054), two agents the owner launched by hand:
--
--   id     first_seen   ended     exit  ended_by  lifetime
--   14851  22:27:33     22:44:42   0    self      1029s
--   14852  22:27:55     22:44:42   0    self      1007s
--
-- Two processes with DIFFERENT lifetimes dying in the SAME SECOND, both recorded as
-- clean voluntary exits. Anyone reading `ended_by='self'` + `exit_code=0` concludes
-- the agents chose to stop — which is how a mass reap went unnoticed until the death
-- TIMESTAMPS were compared instead of the status fields. A SINGLE reaped session was
-- undetectable, because nothing in its row disagreed with "it exited cleanly".
--
-- WHY exit_code=0 RATHER THAN NULL (the part that made this invisible)
-- -------------------------------------------------------------------
-- MEASURED against the real node-pty in this tree, not assumed:
--
--   $ node -e "...spawn; kill(pid,'SIGHUP')..."  ->  {"exitCode":0,"signal":1}
--
-- node-pty reports a signal death as exitCode 0 with the signal in a SEPARATE field.
-- `psu-pty-host.mjs` destructured only `{ exitCode }` and dropped `signal` on the
-- floor, so a SIGHUP kill entered the pipeline indistinguishable from `exit 0`. The
-- `?? 0` fallbacks downstream then made it look deliberate. So this is NOT a case of
-- a missing exit code that could be inferred later: the surviving evidence positively
-- asserted a clean exit. Only the discarded `signal` could have contradicted it, which
-- is why it must now be persisted rather than recomputed.
--
-- WHY 'signal' AND NOT 'reaped'
-- -----------------------------
-- Deliberate. From the reporting parent's vantage the ONLY observed fact is "my child
-- died from signal N". It does NOT know whether the sender was a sidecar restart, the
-- owner pressing Ctrl-C, a peer's `processes:kill`, or the OOM killer. Stamping
-- 'reaped' would manufacture an attribution nothing observed — the same
-- confident-wrong-answer failure 735 exists to prevent, re-committed one column over.
-- 'signal' + `ended_signal` records exactly what was seen and nothing more; the mass-reap
-- SIGNATURE (N rows, ended_by='signal', same `ended_at` second) is then queryable
-- without anyone having to assert a cause they cannot support.
--
-- READING THE TWO AXES AFTER THIS MIGRATION
-- -----------------------------------------
--   ended_by      ended_at is...     the exit was...
--   'self'        the real end time  voluntary
--   'signal'      the real end time  INVOLUNTARY (killed by ended_signal)
--   'reaper'      a NOTICE time      unknown — process was already gone
--   'reconciler'  a NOTICE time      unknown — process was already gone
--   'cleanup'     a CLOSE time       never ran
--   NULL          unknown            unknown (legacy, pre-735)

-- FORWARD-COMPAT: both changes are widenings that the currently-deployed release
-- cannot notice. The CHECK is DROPped only to re-ADD it with one extra permitted
-- value ('signal'); every value the live code writes today ('self','reaper',
-- 'reconciler','cleanup') stays permitted, and the live code has no branch that can
-- emit 'signal' — only the code shipping with this migration writes it. The partial
-- index is likewise re-created with a strictly narrower predicate; no query in the
-- deployed release references that predicate (it is an index-only artifact of 735),
-- so nothing can lose a plan it depends on.

ALTER TABLE harness_shared.adv_sessions
  ADD COLUMN IF NOT EXISTS ended_signal text;

COMMENT ON COLUMN harness_shared.adv_sessions.ended_signal IS
  'The signal name that terminated this session (e.g. ''SIGHUP'', ''SIGKILL''), when ended_by = ''signal''. NULL for every other ended_by. Recorded because node-pty reports a signal death as exitCode 0 with the signal in a separate field, so WITHOUT this column a kill is indistinguishable from a clean exit (WI-38054).';

-- Widen the 735 CHECK by one value. Drop-and-re-add is the only way to alter a CHECK;
-- see the FORWARD-COMPAT note above for why this is safe against the live release.
ALTER TABLE harness_shared.adv_sessions
  DROP CONSTRAINT IF EXISTS adv_sessions_ended_by_check;

ALTER TABLE harness_shared.adv_sessions
  ADD CONSTRAINT adv_sessions_ended_by_check
  CHECK (ended_by IS NULL OR ended_by IN ('self', 'signal', 'reaper', 'reconciler', 'cleanup'));

-- `ended_signal` is meaningful ONLY for ended_by='signal'. Enforce that rather than
-- trusting callers: a stray signal name on a 'reaper' row would reintroduce exactly the
-- ambiguity this migration removes.
ALTER TABLE harness_shared.adv_sessions
  DROP CONSTRAINT IF EXISTS adv_sessions_ended_signal_check;

ALTER TABLE harness_shared.adv_sessions
  ADD CONSTRAINT adv_sessions_ended_signal_check
  CHECK (ended_signal IS NULL OR ended_by = 'signal');

COMMENT ON COLUMN harness_shared.adv_sessions.ended_by IS
  'Who wrote ended_at, and whether the exit was voluntary: ''self'' (the session''s own exit was observed — ended_at IS the end time, exit was voluntary) | ''signal'' (the live parent observed the child killed by ended_signal — ended_at IS the end time, exit was INVOLUNTARY) | ''reaper'' (idle-session-reaper noticed an already-dead process) | ''reconciler'' (reconcileDeadTerminalLaunches noticed a dead terminal launch) | ''cleanup'' (administrative close; the session never ran). NULL = legacy row, provenance UNKNOWN. For ''reaper''/''reconciler''/''cleanup''/NULL, ended_at is the NOTICE time and the true end time is unknown — read coord_presence.last_active_at instead.';

-- 735 created this index to find rows whose `ended_at` needs a provenance caveat, and
-- encoded that as "anything but 'self'". A 'signal' row is a real observation and needs
-- no such caveat, so leaving the old predicate would quietly re-admit the wrong-answer
-- class: a future query reusing it would caveat end times that are perfectly good.
DROP INDEX IF EXISTS harness_shared.adv_sessions_observer_ended_idx;

CREATE INDEX IF NOT EXISTS adv_sessions_observer_ended_idx
  ON harness_shared.adv_sessions (ended_at)
  WHERE ended_at IS NOT NULL AND (ended_by IS NULL OR ended_by NOT IN ('self', 'signal'));

-- The mass-reap signature: several sessions with DIFFERENT lifetimes terminated by a
-- signal in the same instant. Cheap partial index so that query never scans the table.
CREATE INDEX IF NOT EXISTS adv_sessions_signal_ended_idx
  ON harness_shared.adv_sessions (ended_at)
  WHERE ended_by = 'signal';
