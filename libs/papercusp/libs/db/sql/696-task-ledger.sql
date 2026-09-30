-- 696-task-ledger.sql
--
-- task-manager-no-escape-2026-07-27, P-001: `harness_shared.task_ledger` — the
-- durable row behind every process the operator launches.
--
-- ── WHY A TABLE AT ALL ──────────────────────────────────────────────────────
--
-- Today the only registry of running work is the in-memory Map in
-- `agent-tools/capability/bash-jobs.ts`: capped at 64 rows, process-bound, and
-- wiped whenever ANY agent restarts the operator on this shared box (EI-8855).
-- That is why an inherited "job X: COMPLETED" claim has to be re-verified against
-- the OS rather than trusted, and why nothing can answer "what ran overnight and
-- what did it cost". A durable row survives the restart, so a task started by one
-- session is readable — and killable — by the next.
--
-- The storage policy's carve-out for in-memory state (a live child-process HANDLE
-- cannot be serialized) still holds and is NOT overturned here: the ChildProcess
-- object stays in memory, the OUTPUT stays spilled to a scratch file, and this
-- table holds the FACTS about the process — identity, provenance, budget, state.
-- Those three live in different places on purpose.
--
-- ── WHY PROVENANCE IS THE POINT (D-003) ─────────────────────────────────────
--
-- `ps` can already tell you `node vitest`. What no process table anywhere can tell
-- you is WHICH AGENT started it, against WHICH work-item and plan, under what
-- budget and deadline, where its log is, and what breaks if you kill it. That join
-- is the entire reason this table exists, and it is why widening `dev:processes`
-- would not have substituted for it (bash-to-tool-substitution-2026-07-26 D-009
-- froze that tool at six kinds precisely because a wider KERNEL-shaped list is
-- "ps with extra steps" — the objection lands on kernel shape, not on provenance).
--
-- ── WHY NOT KEYED ON PID (D-011) ────────────────────────────────────────────
--
-- PID wrap happens roughly daily on this box under fleet load. A durable ledger
-- makes that MORE dangerous than an in-memory one, not less: a row written an hour
-- ago can name a PID that now belongs to something else, and acting on it is how
-- you kill the owner's desktop session. So `pid` is stored as a HINT only and
-- every destructive path re-verifies before signalling. The two trustworthy keys:
--
--   process_identity  `linux:<bootId>:<startTicks>` (process-identity.ts) — stable
--                     for the process's lifetime, and dies with the boot.
--   scope_unit        `pc-<task_id>.scope` — the transient systemd scope. Killing
--                     by scope unit cannot touch a recycled PID at all, and takes
--                     the whole SUBTREE with it (the durable fix for the
--                     `pkill -f '<binary>'` class that has twice killed the
--                     owner's live desktop window and peers' Xvfb instances).
--
-- ── STATES ─────────────────────────────────────────────────────────────────
--
--   pending      registered, not yet spawned (the row exists BEFORE the fork, so a
--                crash between register and spawn is visible rather than silent).
--   running      alive and accounted for.
--   exited       terminated on its own; exit_code set.
--   killed       terminated by us (a control-plane verb).
--   timed_out    passed deadline_at and was reaped by its own RuntimeMaxSec.
--   stranded     ledger says running, kernel says gone — closed out by the
--                reconciler. Distinct from `exited` because we never saw the code.
--   unaccounted  the inverse: found in our slice with no ledger row. Someone
--                bypassed the chokepoint, or a pre-existing process was adopted.
--                REPORT-ONLY in v1 (D-010) — never auto-killed.
--   foreign      a papercusp-tree process outside our slice (e.g. the owner's own
--                terminal). Visible, never controlled. Visibility != control.
--
-- Idempotent: safe to re-run. Applied by the runner (`db:migrate`), never a raw
-- psql -f (an unrecorded DDL re-runs on every deploy and can wedge the gate).

-- FORWARD-COMPAT: the flagged `task_ledger_scope_unit_key` partial unique index lives on
-- `task_ledger`, a table this SAME migration creates (CREATE TABLE IF NOT EXISTS
-- immediately below) — there is no pre-existing non-partial index of these columns to
-- narrow, since nothing existed before this file ran. Checked against deployed sha
-- 1e0ddc5864: the deployed writer's (task-manager/store.ts) ON CONFLICT arbiter is
-- `(task_id)`, the primary key — it never targets `scope_unit`, so this partial index is
-- a pure data-integrity guard, not a conflict target deployed code relies on. (WI-6842)
CREATE TABLE IF NOT EXISTS harness_shared.task_ledger (
  -- ULID-ish; also the cgroup scope key (pc-<task_id>.scope), so the kernel
  -- object name carries the ledger key and reconciliation is a JOIN rather than
  -- a cmdline heuristic.
  task_id            text PRIMARY KEY,
  workspace_id       text NOT NULL,
  harness_slug       text,

  -- tree: parent_task_id gives "kill this agent and everything it started" as a
  -- single safe operation; root_task_id makes the whole subtree one index scan.
  parent_task_id     text,
  root_task_id       text NOT NULL,

  -- what
  class              text NOT NULL,
  title              text NOT NULL,
  argv               jsonb NOT NULL DEFAULT '[]'::jsonb,
  cwd                text,

  -- who / why — the provenance block
  launched_by        text NOT NULL,
  work_item_id       text,
  plan_slug          text,
  fleet_slug         text,
  session_id         text,

  -- confinement + identity
  scope_unit         text,
  cgroup_path        text,
  pid                integer,
  process_identity   text,
  confined           boolean NOT NULL DEFAULT false,

  -- budget (nulls = unbudgeted; enforced by systemd, not by us)
  memory_max_bytes   bigint,
  cpu_weight         integer,
  tasks_max          integer,
  deadline_at        timestamptz,

  -- lifecycle
  state              text NOT NULL DEFAULT 'pending',
  exit_code          integer,
  exit_reason        text,
  started_at         timestamptz NOT NULL DEFAULT now(),
  ended_at           timestamptz,
  last_seen_at       timestamptz NOT NULL DEFAULT now(),

  -- last metrics sample (cgroup-read; null until the reconciler samples)
  last_memory_bytes  bigint,
  peak_memory_bytes  bigint,
  cpu_usec           bigint,
  pids_current       integer,

  log_path           text,
  detail             jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'task_ledger_workspace_nonempty'
  ) THEN
    ALTER TABLE harness_shared.task_ledger
      ADD CONSTRAINT task_ledger_workspace_nonempty CHECK (workspace_id <> '');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'task_ledger_state_check'
  ) THEN
    ALTER TABLE harness_shared.task_ledger
      ADD CONSTRAINT task_ledger_state_check CHECK (state = ANY (ARRAY[
        'pending'::text, 'running'::text, 'exited'::text, 'killed'::text,
        'timed_out'::text, 'stranded'::text, 'unaccounted'::text, 'foreign'::text
      ]));
  END IF;

  -- Deliberately NOT a CHECK on `class`: the class list is expected to grow as
  -- new root seams enrol (the scheduled-registry's ManagedCategory made the same
  -- call). A migration per new spawn seam would be friction with no safety win —
  -- an unknown class renders as itself, it does not corrupt anything.
END $$;

-- The hot read: "what is running right now in this workspace".
CREATE INDEX IF NOT EXISTS task_ledger_live_idx
  ON harness_shared.task_ledger (workspace_id, state, started_at DESC)
  WHERE state IN ('pending', 'running');

-- Subtree fetch for the tree view + subtree kill.
CREATE INDEX IF NOT EXISTS task_ledger_root_idx
  ON harness_shared.task_ledger (root_task_id);

CREATE INDEX IF NOT EXISTS task_ledger_parent_idx
  ON harness_shared.task_ledger (parent_task_id)
  WHERE parent_task_id IS NOT NULL;

-- "what did WI-NNNN cost" / "what is this agent running".
CREATE INDEX IF NOT EXISTS task_ledger_work_item_idx
  ON harness_shared.task_ledger (work_item_id)
  WHERE work_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS task_ledger_launched_by_idx
  ON harness_shared.task_ledger (launched_by, started_at DESC);

-- The reconciler's join key. UNIQUE: two live rows claiming one scope unit is a
-- bug we want to fail loudly at write time, not discover as double-accounting.
CREATE UNIQUE INDEX IF NOT EXISTS task_ledger_scope_unit_key
  ON harness_shared.task_ledger (scope_unit)
  WHERE scope_unit IS NOT NULL;

-- The reconciler's other join key (unconfined + adopted rows).
CREATE INDEX IF NOT EXISTS task_ledger_process_identity_idx
  ON harness_shared.task_ledger (process_identity)
  WHERE process_identity IS NOT NULL;

-- Retention GC + "what ran overnight".
CREATE INDEX IF NOT EXISTS task_ledger_ended_idx
  ON harness_shared.task_ledger (ended_at)
  WHERE ended_at IS NOT NULL;

-- Deadline sweep.
CREATE INDEX IF NOT EXISTS task_ledger_deadline_idx
  ON harness_shared.task_ledger (deadline_at)
  WHERE deadline_at IS NOT NULL AND ended_at IS NULL;
