-- 774-task-ledger-ended-unobserved-state.sql
--
-- WI-37440 / task-manager-no-escape-2026-07-27#D-018: widen task_ledger's state
-- CHECK constraint to allow 'ended_unobserved' — a terminal state distinct from
-- both 'exited' (we saw the real exit code) and 'stranded' (the reconciler
-- treats this as the ESCAPE/anomaly class). It fires when a task's owning
-- process died before `wireExit()` could record the child's exit, but the
-- reconciler independently confirmed via systemd that the task's transient
-- scope was released in good order (all its processes are actually gone) —
-- i.e. a routine, healthy shutdown that nobody happened to observe, not an
-- escape. See D-018 for the full measurement + ruling.
--
-- FORWARD-COMPAT: this DROPs and re-ADDs task_ledger_state_check, which reads as
-- destructive DDL, but it is a pure WIDEN — the new constraint accepts every
-- value the old one did, plus one more. No currently-deployed code path (staging
-- OR the :3070 release checkout) ever WRITES 'ended_unobserved' until this same
-- change's application code (reconcile.ts / store.ts) ships, and no code reads
-- 'ended_unobserved' as a possible value yet either, so there is no window where
-- an older release checkout can be broken by rows this migration allows.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'task_ledger_state_check'
  ) THEN
    ALTER TABLE harness_shared.task_ledger
      DROP CONSTRAINT task_ledger_state_check;
  END IF;

  ALTER TABLE harness_shared.task_ledger
    ADD CONSTRAINT task_ledger_state_check CHECK (state = ANY (ARRAY[
      'pending'::text, 'running'::text, 'exited'::text, 'killed'::text,
      'timed_out'::text, 'stranded'::text, 'unaccounted'::text, 'foreign'::text,
      'ended_unobserved'::text
    ]));
END $$;
