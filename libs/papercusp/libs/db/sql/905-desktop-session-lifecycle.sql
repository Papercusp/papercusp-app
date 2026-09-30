-- Migration 905 — desktop_sessions lifecycle governance
-- (agent-virtual-desktops-2026-08-23 P-005 / WI-40867; extends migration 900).
--
-- Migration 900 gave a desktop session an IDENTITY. This gives it a LIFECYCLE:
-- the three columns a governor needs to decide what to do with a session that
-- nobody is driving, and to actuate that decision on the real process tree.
--
-- WHY FREEZE AND NOT KILL — the column that earns its keep is `task_id`.
-- WI-5978 measured three QEMU guests holding 12.8 cores (11% of this 128-core
-- box) continuously for 5-9 days while idle, against a 4th guest up LONGER at
-- 0.1 cores. The control proves they were not working, they were SPINNING: a
-- guest whose idle loop never reaches HLT burns a core doing nothing, and no
-- amount of asking it politely stops that — the guest does not know it is idle.
-- The host does. `task_id` binds a session to its task-ledger row, whose cgroup
-- can be FROZEN (cgroup.freeze), which halts the spin at the scheduler without
-- destroying the guest's state. Killing would also stop the spin, and would also
-- throw away a desktop the agent may come back to; freezing is the reversible
-- form of the same fix, which is why the governor reaches for it first and only
-- reaps after a session has been frozen and untouched for a further TTL.
--
-- FORWARD-COMPAT: additive columns plus one CHECK on a relation created by
-- migration 900, which shipped hours ago in this same plan. The release checkout
-- currently serving :3070 predates 900 entirely and contains no code path that
-- reads or writes harness_shared.desktop_sessions — the first such code is P-003's
-- registry, which has not deployed — so no live writer can violate the new CHECK
-- and no live reader can be surprised by the new columns. Nothing is dropped,
-- renamed, or made NOT NULL.
--
-- Idempotent: IF NOT EXISTS everywhere; re-runnable. No top-level BEGIN/COMMIT —
-- the migration runner wraps each file in its own transaction.

ALTER TABLE harness_shared.desktop_sessions
  -- The task-ledger id of the process subtree backing this desktop. This is the
  -- freeze/thaw HANDLE: `freezeTask(task_id)` freezes the whole cgroup subtree,
  -- so a guest that double-forks or reparents to init is still caught (the
  -- no-escape property the task manager exists for). NULL = not enrolled, which
  -- is legal and is what every pre-P-005 row is: such a session can still be
  -- reaped, it just cannot be frozen, and the governor says so rather than
  -- silently doing nothing.
  ADD COLUMN IF NOT EXISTS task_id text,

  -- Per-session idle threshold, in seconds. NULL takes the governor's policy
  -- default for the kind. Present because the right answer differs by an order
  -- of magnitude between kinds: an xvfb sandbox costs a few MB while idle and can
  -- wait, a spinning vm-guest costs a core per hour and cannot.
  ADD COLUMN IF NOT EXISTS idle_after_sec integer,

  -- When the session entered 'frozen'. Cleared on thaw. The reaper reads it to
  -- escalate: frozen AND untouched for a further TTL is what finally gets
  -- reclaimed, so a freeze is never a permanent limbo that quietly leaks a
  -- display forever.
  ADD COLUMN IF NOT EXISTS frozen_at timestamptz;

COMMENT ON COLUMN harness_shared.desktop_sessions.task_id IS
  'Task-ledger id of the process subtree backing this desktop; the freeze/thaw '
  'handle. NULL = unenrolled (reapable, not freezable) — the governor reports '
  'that rather than silently no-opping.';

COMMENT ON COLUMN harness_shared.desktop_sessions.idle_after_sec IS
  'Per-session idle threshold in seconds; NULL takes the governor default for '
  'the kind. A spinning vm-guest costs a core per hour idle, an xvfb sandbox a '
  'few MB — one threshold cannot serve both.';

COMMENT ON COLUMN harness_shared.desktop_sessions.frozen_at IS
  'When the session entered ''frozen''; cleared on thaw. Frozen AND untouched '
  'for a further TTL is what the reaper reclaims, so a freeze cannot become a '
  'permanent limbo holding a display.';

-- A frozen row must say WHEN. Without this, a frozen session with a NULL stamp
-- reads to the reaper as "just frozen, give it the full TTL" on every single
-- pass — the freeze would never escalate and the display would leak forever.
-- One-way on purpose: thaw clears the stamp, and no other state is required to
-- have one.
DO $mig905_ck$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'desktop_sessions_frozen_at_ck'
       AND conrelid = 'harness_shared.desktop_sessions'::regclass
  ) THEN
    ALTER TABLE harness_shared.desktop_sessions
      ADD CONSTRAINT desktop_sessions_frozen_at_ck
      CHECK (state <> 'frozen' OR frozen_at IS NOT NULL);
  END IF;
END
$mig905_ck$;

-- The governor's read: live rows on THIS host, ordered by how long they have
-- been untouched. host_ref is in the key because a governor only ever actuates
-- its own host's sessions — freezing a cgroup that lives on another machine is
-- not something this process can do, and pretending otherwise is how a sweep
-- reports success having done nothing.
CREATE INDEX IF NOT EXISTS desktop_sessions_idle_idx
  ON harness_shared.desktop_sessions (COALESCE(host_ref, ''), last_active_at)
  WHERE state NOT IN ('released', 'dead');

DO $mig905$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(c, ', ')
    INTO missing
    FROM unnest(ARRAY['task_id', 'idle_after_sec', 'frozen_at']) AS c
   WHERE NOT EXISTS (
     SELECT 1
       FROM information_schema.columns
      WHERE table_schema = 'harness_shared'
        AND table_name = 'desktop_sessions'
        AND column_name = c
   );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '905: post-condition failed — desktop_sessions is missing column(s): %', missing;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'desktop_sessions_frozen_at_ck'
       AND conrelid = 'harness_shared.desktop_sessions'::regclass
  ) THEN
    RAISE EXCEPTION '905: post-condition failed — desktop_sessions_frozen_at_ck was not installed';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'harness_shared' AND indexname = 'desktop_sessions_idle_idx'
  ) THEN
    RAISE EXCEPTION '905: post-condition failed — desktop_sessions_idle_idx is missing';
  END IF;

  RAISE NOTICE '905: desktop_sessions lifecycle columns installed';
END
$mig905$;
