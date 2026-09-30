-- 700-task-ledger-bash-job-id-idx.sql
--
-- EI-18759519171684432: capability:bash_output's stranded-job path (in-memory
-- JOBS map entry gone, log file survived) now joins task_ledger by the
-- `detail->>'bashJobId'` capability:bash stamped at registration, to distinguish
-- "tracking lost, process still alive" from "genuinely gone" instead of guessing
-- from operator uptime alone (see store.ts's getTaskByBashJobId). Index the join
-- key, scoped to bash-job rows only (the only class that ever sets it), so the
-- lookup stays fast even as the ledger accumulates rows from every other task
-- class (agent-session, build, deploy, ...).
--
-- Idempotent: safe to re-run. Applied by the runner (`db:migrate`), never a raw
-- psql -f.

CREATE INDEX IF NOT EXISTS task_ledger_bash_job_id_idx
  ON harness_shared.task_ledger ((detail ->> 'bashJobId'))
  WHERE class = 'bash-job' AND detail ? 'bashJobId';
