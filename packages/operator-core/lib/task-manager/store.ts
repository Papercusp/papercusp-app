/**
 * task-manager/store — durable CRUD over `harness_shared.task_ledger`
 * (task-manager-no-escape-2026-07-27, P-003).
 *
 * The write ORDER is the load-bearing part, not the SQL. `registerTask` inserts a
 * `pending` row BEFORE the fork, and `markSpawned` fills in the kernel identity
 * after it. That ordering is what makes a crash between the two visible: the row
 * exists, says `pending`, and the reconciler strands it once it ages out. The
 * opposite order (spawn, then record) loses the process entirely if the operator
 * dies in the window — which is exactly the failure the in-memory registry has
 * today, at a much larger scale (EI-8855 wipes ALL of them on any restart).
 *
 * Every mutation takes an optional injected `Sql` so the integration test can run
 * the real statements against a throwaway database, matching agent-facts/store.ts.
 */

import { getOrgPg } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import { activeWorkspaceId } from '../workspace-registry';
import { redactSensitiveText } from '../sensitive-text';
import { readSuperuserToken } from '../superuser-token';
import { emitTaskTerminalEvent, type TaskTerminalEventEmitter } from './task-terminal-events';
import { recordAttemptOnClose } from '../verification-attempts/attempt-ledger';
import { nudgeOnNewLoop } from '../verification-attempts/loop-gate';
import {
  TASK_STATES,
  isTerminalState,
  newTaskId,
  serviceUnitForTask,
  scopeUnitForTask,
  taskIdFromScopeUnit,
  taskTerminalProvenanceFromDetail,
  type TaskMetrics,
  type TaskRow,
  type TaskSpec,
  type TaskState,
  type TaskTerminalProvenance,
  type TaskUnitKind,
} from './types';

function sqlOf(inject?: Sql): Sql {
  return inject ?? getOrgPg().sql;
}

function assertState(state: TaskState): void {
  if (!TASK_STATES.includes(state)) {
    throw new Error(`task-manager: unknown state ${JSON.stringify(state)}`);
  }
}

function jsonObject(value: unknown): Record<string, unknown> {
  const parsed =
    typeof value === 'string'
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return null;
          }
        })()
      : value;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function detailNonNegativeInteger(detail: Record<string, unknown>, key: string): number | null {
  const raw = detail[key];
  const value = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Postgres row -> TaskRow. Kept explicit (not a spread-rename) so a column added
 *  to the table without a mapping here fails review rather than silently vanishing. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toRow(r: any): TaskRow {
  const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
  const num = (v: unknown): number | null => (v == null ? null : Number(v));
  // postgres-js normally decodes jsonb objects for us, but a worker/transaction
  // boundary can hand this mapper the raw JSON text instead. Losing that bag
  // drops detail.bashJobId and makes a known terminal bash task look like an
  // unrelated, non-attachable task to capability:bash_output.
  const detail = jsonObject(r.detail);
  return {
    taskId: r.task_id,
    workspaceId: r.workspace_id,
    harnessSlug: r.harness_slug ?? null,
    parentTaskId: r.parent_task_id ?? null,
    rootTaskId: r.root_task_id,
    class: r.class,
    title: r.title,
    argv: Array.isArray(r.argv) ? r.argv : JSON.parse(r.argv ?? '[]'),
    cwd: r.cwd ?? null,
    launchedBy: r.launched_by,
    workItemId: r.work_item_id ?? null,
    planSlug: r.plan_slug ?? null,
    fleetSlug: r.fleet_slug ?? null,
    sessionId: r.session_id ?? null,
    scopeUnit: r.scope_unit ?? null,
    cgroupPath: r.cgroup_path ?? null,
    pid: num(r.pid),
    processIdentity: r.process_identity ?? null,
    confined: Boolean(r.confined),
    memoryMaxBytes: num(r.memory_max_bytes),
    cpuWeight: num(r.cpu_weight),
    tasksMax: num(r.tasks_max),
    deadlineAt: iso(r.deadline_at),
    state: r.state,
    exitCode: num(r.exit_code),
    exitReason: r.exit_reason ?? null,
    terminalProvenance: taskTerminalProvenanceFromDetail(detail),
    startedAt: iso(r.started_at) ?? new Date(0).toISOString(),
    endedAt: iso(r.ended_at),
    lastSeenAt: iso(r.last_seen_at) ?? new Date(0).toISOString(),
    lastMemoryBytes: num(r.last_memory_bytes),
    peakMemoryBytes: num(r.peak_memory_bytes),
    cpuUsec: num(r.cpu_usec),
    pidsCurrent: num(r.pids_current),
    pidsEventsMax: detailNonNegativeInteger(detail, 'pidsEventsMax'),
    logPath: r.log_path ?? null,
    detail,
  };
}

export interface RegisterTaskOptions {
  workspaceId?: string;
  /** Pre-mint the id (the chokepoint needs it to build the scope name before the
   *  row exists). Must satisfy `isValidTaskId`. */
  taskId?: string;
  /** Reserve the scope unit at register time so the UNIQUE index catches a
   *  double-launch before the fork rather than after. */
  reserveScope?: boolean;
  /** Unit suffix to reserve. Existing callers default to the legacy `.scope`. */
  unitKind?: TaskUnitKind;
}

/**
 * Insert the `pending` row. Returns the full row — callers need `taskId` to build
 * the scope name and to correlate the child's exit.
 */
export async function registerTask(spec: TaskSpec, opts: RegisterTaskOptions = {}, inject?: Sql): Promise<TaskRow> {
  const sql = sqlOf(inject);
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const taskId = opts.taskId ?? newTaskId();
  const rootTaskId = spec.parentTaskId ? await resolveRoot(spec.parentTaskId, taskId, sql) : taskId;
  const scopeUnit = opts.reserveScope
    ? opts.unitKind === 'service'
      ? serviceUnitForTask(taskId)
      : scopeUnitForTask(taskId)
    : null;
  const deadlineAt =
    spec.runtimeMaxSec && spec.runtimeMaxSec > 0
      ? new Date(Date.now() + spec.runtimeMaxSec * 1000).toISOString()
      : null;

  // A reconciler tick can observe a managed scope after a fire-and-forget
  // enrollment write failed or while that write is still in flight. It adopts
  // the scope under the exact task id, creating an `unaccounted` placeholder;
  // allow that one narrow conflict to regain provenance. Ordinary duplicate ids
  // still return no row and fail below rather than overwriting a real task.
  const rows = await sql`
    INSERT INTO harness_shared.task_ledger (
      task_id, workspace_id, harness_slug, parent_task_id, root_task_id,
      class, title, argv, cwd,
      launched_by, work_item_id, plan_slug, fleet_slug, session_id,
      scope_unit, memory_max_bytes, cpu_weight, tasks_max, deadline_at,
      state, log_path, detail
    ) VALUES (
      ${taskId}, ${ws}, ${spec.harnessSlug ?? null}, ${spec.parentTaskId ?? null}, ${rootTaskId},
      ${spec.class}, ${spec.title}, ${JSON.stringify(spec.argv ?? [])}::jsonb, ${spec.cwd ?? null},
      ${spec.launchedBy}, ${spec.workItemId ?? null}, ${spec.planSlug ?? null},
      ${spec.fleetSlug ?? null}, ${spec.sessionId ?? null},
      ${scopeUnit}, ${spec.memoryMaxBytes ?? null}, ${spec.cpuWeight ?? null},
      ${spec.tasksMax ?? null}, ${deadlineAt},
      'pending', ${spec.logPath ?? null}, ${JSON.stringify(spec.detail ?? {})}::text::jsonb
    )
    ON CONFLICT (task_id) DO UPDATE
      SET workspace_id = EXCLUDED.workspace_id,
          harness_slug = EXCLUDED.harness_slug,
          parent_task_id = EXCLUDED.parent_task_id,
          root_task_id = EXCLUDED.root_task_id,
          class = EXCLUDED.class,
          title = EXCLUDED.title,
          argv = EXCLUDED.argv,
          cwd = EXCLUDED.cwd,
          launched_by = EXCLUDED.launched_by,
          work_item_id = EXCLUDED.work_item_id,
          plan_slug = EXCLUDED.plan_slug,
          fleet_slug = EXCLUDED.fleet_slug,
          session_id = EXCLUDED.session_id,
          scope_unit = COALESCE(harness_shared.task_ledger.scope_unit, EXCLUDED.scope_unit),
          memory_max_bytes = EXCLUDED.memory_max_bytes,
          cpu_weight = EXCLUDED.cpu_weight,
          tasks_max = EXCLUDED.tasks_max,
          deadline_at = EXCLUDED.deadline_at,
          state = 'pending',
          exit_code = NULL,
          exit_reason = NULL,
          ended_at = NULL,
          log_path = EXCLUDED.log_path,
          detail = COALESCE(harness_shared.task_ledger.detail, '{}'::jsonb) || EXCLUDED.detail,
          updated_at = now()
      WHERE harness_shared.task_ledger.workspace_id = EXCLUDED.workspace_id
        AND harness_shared.task_ledger.state = 'unaccounted'
        AND harness_shared.task_ledger.class = 'other'
        AND harness_shared.task_ledger.launched_by = 'unknown'
        AND EXCLUDED.scope_unit IS NOT NULL
        AND harness_shared.task_ledger.scope_unit = EXCLUDED.scope_unit
    RETURNING *
  `;
  if (rows.length === 0) {
    throw new Error(`task-manager: task_id ${JSON.stringify(taskId)} already exists and is not an adoptable residue`);
  }
  return toRow(rows[0]);
}

/** Walk to the tree root. Bounded so a corrupted parent cycle cannot hang a spawn. */
async function resolveRoot(parentTaskId: string, fallback: string, sql: Sql): Promise<string> {
  const rows = await sql`
    SELECT root_task_id FROM harness_shared.task_ledger WHERE task_id = ${parentTaskId} LIMIT 1
  `;
  return rows[0]?.root_task_id ?? fallback;
}

export interface SpawnedFacts {
  pid?: number | null;
  processIdentity?: string | null;
  scopeUnit?: string | null;
  cgroupPath?: string | null;
  confined?: boolean;
  /** D-014: WHY this task is unconfined — 'flag-off' | 'caller-veto' |
   *  'no-scope-support' | 'probe-pending'. Stamped into `detail` (jsonb, so no
   *  migration) rather than a column, because it is diagnostic reporting and not
   *  something anything joins or filters on in the hot path. Omitted/null when
   *  confined, and the merge below then leaves `detail` untouched. */
  unconfinedReason?: string | null;
}

/** Fill in the kernel identity once the child exists and flip `pending` -> `running`. */
export async function markSpawned(taskId: string, facts: SpawnedFacts, inject?: Sql): Promise<void> {
  const sql = sqlOf(inject);
  // Merge rather than replace: `detail` already carries other stampers' keys
  // (e.g. `bashJobId` from startBackground), and clobbering it here would break
  // the bashJobId lookup that reads `detail ->> 'bashJobId'`.
  //
  // The patch is built SERVER-SIDE with jsonb_build_object rather than as a bound
  // `${JSON.stringify(x)}::jsonb`, and that is deliberate. `||` on two jsonb values
  // merges them only when BOTH are objects; give it a jsonb *string* on either side
  // and it silently produces a two-element ARRAY instead of erroring, which would
  // corrupt `detail` and break the bashJobId lookup with no failure anywhere. A
  // bound string round-trips to a jsonb string under some client bindings and to an
  // object under others (measured 2026-08-03: the org pool yields objects — all 950
  // live rows are jsonb_typeof 'object' — while the test harness's client yields
  // strings, which is how this surfaced). jsonb_build_object cannot express that
  // ambiguity: it always builds an object, so the merge is an object-merge by
  // construction rather than by luck of the binding.
  const reason = facts.unconfinedReason ?? null;
  await sql`
    UPDATE harness_shared.task_ledger
       SET pid = ${facts.pid ?? null},
           process_identity = ${facts.processIdentity ?? null},
           scope_unit = COALESCE(${facts.scopeUnit ?? null}, scope_unit),
           cgroup_path = COALESCE(${facts.cgroupPath ?? null}, cgroup_path),
           confined = ${facts.confined ?? false},
           detail = CASE
                      WHEN ${reason}::text IS NULL THEN detail
                      ELSE detail || jsonb_build_object('unconfinedReason', ${reason}::text)
                    END,
           state = 'running',
           last_seen_at = now(),
           updated_at = now()
     WHERE task_id = ${taskId}
       AND state = 'pending'
  `;
}

/**
 * Re-open a confined task that was deliberately frozen before member recovery
 * marked it `stranded`. The cgroup remains the source of truth for whether the
 * process is still recoverable; callers must positively verify that separately
 * before invoking this bookkeeping transition.
 *
 * Keep the transition state- and ended_at-guarded. A stale recovery request must
 * not resurrect a later terminal verdict, and a row that was never closed as a
 * strand is not part of this compatibility path. The former strand reason is
 * retained in the detail bag so reopening does not erase why reconciliation
 * closed the row; the live lifecycle tuple is cleared because the task is live
 * again.
 */
export async function reopenStrandedTask(taskId: string, inject?: Sql): Promise<boolean> {
  const sql = sqlOf(inject);
  const rows = await sql`
    UPDATE harness_shared.task_ledger
       SET state = 'running',
           exit_code = NULL,
           exit_reason = NULL,
           ended_at = NULL,
           detail =
             CASE
               WHEN jsonb_typeof(COALESCE(detail, '{}'::jsonb)) = 'object'
                 THEN COALESCE(detail, '{}'::jsonb)
               ELSE '{}'::jsonb
             END || jsonb_build_object(
               'reopenedFromStranded', jsonb_build_object(
                 'at', now(),
                 'reason', exit_reason
               )
             ),
           last_seen_at = now(),
           updated_at = now()
     WHERE task_id = ${taskId}
       AND state = 'stranded'
       AND ended_at IS NOT NULL
    RETURNING task_id
  `;
  return rows.length > 0;
}

export interface CloseTaskInput {
  state: Extract<TaskState, 'exited' | 'killed' | 'timed_out' | 'stranded' | 'ended_unobserved'>;
  exitCode?: number | null;
  exitReason?: string | null;
  terminalProvenance?: TaskTerminalProvenance | null;
}

export interface CloseTaskEffects {
  /** Test seam; production uses the awaited-event bridge. */
  emitTerminal?: TaskTerminalEventEmitter;
  /** Test seam; production stamps the slow-attempt record (verification-attempts). */
  recordAttempt?: typeof recordAttemptOnClose;
  /** Test seam; production nudges the launcher when an attempt trips the loop rule. */
  nudgeLoop?: typeof nudgeOnNewLoop;
}

function terminalExitCode(terminal: TaskTerminalProvenance, fallback: number | null): number | null {
  if (terminal.execMainStatus == null) return fallback;
  // systemd exposes wait(2) si_code: CLD_EXITED=1; CLD_KILLED=2;
  // CLD_DUMPED=3. Preserve the ledger's shell-compatible exit-code convention.
  if (terminal.execMainCode === 1) return terminal.execMainStatus;
  if (terminal.execMainCode === 2 || terminal.execMainCode === 3) return 128 + terminal.execMainStatus;
  return fallback;
}

function classifyTerminalClose(
  input: CloseTaskInput,
  row: TaskRow | null,
): Required<Pick<CloseTaskInput, 'state'>> &
  Pick<CloseTaskInput, 'exitCode' | 'exitReason'> & { terminalProvenance: TaskTerminalProvenance | null } {
  const captured = input.terminalProvenance;
  if (!captured) {
    return {
      state: input.state,
      exitCode: input.exitCode ?? null,
      exitReason: input.exitReason ?? null,
      terminalProvenance: null,
    };
  }

  const peakMemoryBytes = captured.peakMemoryBytes ?? row?.peakMemoryBytes ?? null;
  const memoryMaxBytes = captured.memoryMaxBytes ?? row?.memoryMaxBytes ?? null;
  const terminal: TaskTerminalProvenance = {
    ...captured,
    scopeUnit: row?.scopeUnit ?? captured.scopeUnit,
    cgroupPath: captured.cgroupPath ?? row?.cgroupPath ?? null,
    memoryMaxBytes,
    peakMemoryBytes,
    peakMemorySource:
      captured.peakMemoryBytes != null ? 'systemd' : row?.peakMemoryBytes != null ? 'cgroup-sample' : 'unknown',
  };

  let state = input.state;
  let exitReason = input.exitReason ?? null;
  const result = terminal.serviceResult;
  if (result === 'oom-kill') {
    state = 'killed';
    // A finite cgroup cap plus a peak at that cap proves the LOCAL MemoryMax
    // path. Without that pair, keep the OOM observable but do not manufacture
    // cgroup attribution: an uncapped task is a host/ancestor OOM, while a
    // capped task with no surviving peak is genuinely unattributed.
    exitReason =
      memoryMaxBytes != null && peakMemoryBytes != null && peakMemoryBytes >= memoryMaxBytes
        ? 'oom-kill'
        : memoryMaxBytes == null
          ? 'host-oom'
          : 'oom-kill-unattributed';
  } else if (result === 'timeout') {
    state = 'timed_out';
    exitReason = 'timeout';
  } else if (result === 'signal' || result === 'core-dump') {
    state = 'killed';
    exitReason ??= result;
  } else if (result === 'exit-code') {
    state = 'exited';
    exitReason ??= 'exit-code';
  }

  return {
    state,
    exitCode: terminalExitCode(terminal, input.exitCode ?? null),
    exitReason,
    terminalProvenance: terminal,
  };
}

/**
 * Terminal close. Idempotent by construction — the WHERE excludes rows that
 * already ended, so a race between the child's `exit` event and the reconciler's
 * strand verdict resolves to whichever landed first instead of overwriting a real
 * exit code with a guess.
 */
export async function closeTask(
  taskId: string,
  input: CloseTaskInput,
  inject?: Sql,
  effects: CloseTaskEffects = {},
): Promise<boolean> {
  const sql = sqlOf(inject);
  const existing = input.terminalProvenance ? await getTask(taskId, inject) : null;
  if (input.terminalProvenance && !existing) return false;
  if (input.terminalProvenance && existing?.scopeUnit && existing.scopeUnit !== input.terminalProvenance.scopeUnit) {
    // A systemd snapshot is identity-bearing evidence. Refuse to attach it to a
    // different ledger scope even when a caller accidentally pairs the task ids.
    return false;
  }
  const classified = classifyTerminalClose(input, existing);
  assertState(classified.state);
  if (!isTerminalState(classified.state)) throw new Error(`task-manager: ${classified.state} is not terminal`);
  const terminalJson = classified.terminalProvenance ? JSON.stringify(classified.terminalProvenance) : null;
  const rows = await sql<Array<{
    task_id: string;
    workspace_id: string;
    harness_slug: string | null;
    class: string;
    launched_by: string;
    work_item_id: string | null;
    log_path: string | null;
    argv: unknown;
    started_at: Date;
    ended_at: Date;
  }>>`
    UPDATE harness_shared.task_ledger
       SET state = ${classified.state},
           exit_code = ${classified.exitCode ?? null},
           exit_reason = ${classified.exitReason ?? null},
           memory_max_bytes = COALESCE(
             ${classified.terminalProvenance?.memoryMaxBytes ?? null}, memory_max_bytes
           ),
           peak_memory_bytes = CASE
             WHEN ${classified.terminalProvenance?.peakMemoryBytes ?? null}::bigint IS NULL
               THEN peak_memory_bytes
             WHEN peak_memory_bytes IS NULL
               THEN ${classified.terminalProvenance?.peakMemoryBytes ?? null}::bigint
             ELSE GREATEST(peak_memory_bytes, ${classified.terminalProvenance?.peakMemoryBytes ?? null}::bigint)
           END,
           detail = CASE
             WHEN ${terminalJson}::text IS NULL THEN detail
             ELSE detail || jsonb_build_object(
               'terminalProvenance', ${terminalJson}::text::jsonb
             )
           END,
           ended_at = now(),
           last_seen_at = now(),
           updated_at = now()
     WHERE task_id = ${taskId}
       AND ended_at IS NULL
    RETURNING task_id, workspace_id, harness_slug, class, launched_by,
              work_item_id, log_path, argv, started_at, ended_at
  `;
  const closed = rows[0];
  if (!closed) return false;
  // expensive-verification-loops P-001: a slow work-item attempt gets its outcome and
  // failure fingerprint stamped on the row. Fail-soft and fire-and-forget; it returns
  // before any I/O for a row with no work item or under the slow threshold.
  if (closed.work_item_id) {
    const workItemId = closed.work_item_id;
    void (effects.recordAttempt ?? recordAttemptOnClose)(
      {
        taskId: closed.task_id,
        workItemId,
        state: classified.state,
        exitCode: classified.exitCode ?? null,
        exitReason: classified.exitReason ?? null,
        logPath: closed.log_path,
        argv: Array.isArray(closed.argv) ? closed.argv.map(String) : [],
        startedAt: closed.started_at,
        endedAt: closed.ended_at,
      },
      inject ? { sql: inject } : {},
    ).then((stamp) =>
      // P-002: a non-passing attempt that trips the loop rule tells its launcher once.
      stamp && stamp.outcome !== 'pass' && closed.workspace_id
        ? (effects.nudgeLoop ?? nudgeOnNewLoop)(
            { workspaceId: closed.workspace_id, workItemId, taskId: closed.task_id, ownerId: closed.launched_by },
            inject ? { sql: inject } : {},
          )
        : false,
    );
  }
  (effects.emitTerminal ?? emitTaskTerminalEvent)({
    taskId: closed.task_id,
    workspaceId: closed.workspace_id,
    harnessSlug: closed.harness_slug,
    taskClass: closed.class,
    launchedBy: closed.launched_by,
    state: classified.state,
    exitCode: classified.exitCode ?? null,
    exitReason: classified.exitReason ?? null,
  });
  return true;
}

export type PersistFailedTaskUnitTerminalOutcome =
  | 'created-and-closed'
  | 'closed-existing'
  | 'augmented-terminal'
  | 'already-recorded'
  | 'refused';

export interface PersistFailedTaskUnitTerminalResult {
  /** True means the systemd snapshot is durable and reset-failed may now erase it. */
  durable: boolean;
  outcome: PersistFailedTaskUnitTerminalOutcome;
  taskId: string | null;
}

function sameFailedUnitInvocation(
  recorded: TaskTerminalProvenance | null | undefined,
  current: TaskTerminalProvenance,
): boolean {
  return recorded?.scopeUnit === current.scopeUnit && recorded.invocationId === current.invocationId;
}

/**
 * Make one orphaned failed transient service's disappearing evidence durable.
 *
 * The ordinary close/reconcile paths already persist terminal provenance before
 * reset-failed. This is their age-bounded fallback for the cases those paths can
 * no longer revisit: registration never produced a row, a foreign-workspace row
 * is outside the current reconcile input, or the row already became terminal
 * without consuming its retained service.
 *
 * The unit name carries the task id, so a missing row can be reconstructed without
 * a cmdline guess. Existing identity always wins: a row whose scope_unit differs is
 * refused and the failed unit remains loaded. Already-terminal rows are augmented
 * but never reclassified; a prior observed exit remains more authoritative than a
 * later fallback sweep. Callers may reset the unit only when `durable` is true.
 */
export async function persistFailedTaskUnitTerminal(
  terminal: TaskTerminalProvenance,
  opts: { workspaceId?: string; harnessSlug?: string | null } = {},
  inject?: Sql,
  effects: CloseTaskEffects = {},
): Promise<PersistFailedTaskUnitTerminalResult> {
  const taskId = taskIdFromScopeUnit(terminal.scopeUnit);
  if (
    !taskId ||
    !terminal.scopeUnit.endsWith('.service') ||
    terminal.loadState !== 'loaded' ||
    terminal.activeState !== 'failed'
  ) {
    return { durable: false, outcome: 'refused', taskId };
  }

  const sql = sqlOf(inject);
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const inserted = await sql<Array<{ task_id: string }>>`
    INSERT INTO harness_shared.task_ledger (
      task_id, workspace_id, harness_slug, root_task_id, class, title, argv,
      launched_by, scope_unit, cgroup_path, confined, state,
      memory_max_bytes, peak_memory_bytes, detail
    ) VALUES (
      ${taskId}, ${ws}, ${opts.harnessSlug ?? null}, ${taskId}, 'bash-job',
      ${`Recovered failed transient service ${terminal.scopeUnit}`},
      '[]'::jsonb, 'system:task-reconcile', ${terminal.scopeUnit}, ${terminal.cgroupPath}, true,
      'unaccounted', ${terminal.memoryMaxBytes}, ${terminal.peakMemoryBytes},
      jsonb_build_object(
        'recoveredFailedUnit',
        jsonb_build_object('at', now(), 'source', 'task-reconcile-fallback')
      )
    )
    ON CONFLICT DO NOTHING
    RETURNING task_id
  `;

  let existing = await getTask(taskId, inject);
  if (!existing || existing.scopeUnit !== terminal.scopeUnit) {
    return { durable: false, outcome: 'refused', taskId };
  }
  if (existing.terminalProvenance) {
    return sameFailedUnitInvocation(existing.terminalProvenance, terminal)
      ? { durable: true, outcome: 'already-recorded', taskId }
      : { durable: false, outcome: 'refused', taskId };
  }

  if (!existing.endedAt) {
    const closed = await closeTask(
      taskId,
      {
        state: 'ended_unobserved',
        terminalProvenance: terminal,
      },
      inject,
      effects,
    );
    if (closed) {
      return {
        durable: true,
        outcome: inserted.length > 0 ? 'created-and-closed' : 'closed-existing',
        taskId,
      };
    }
    // A competing close can win between the read and closeTask. Re-read before
    // deciding whether its write made the evidence durable.
    existing = await getTask(taskId, inject);
    if (!existing || existing.scopeUnit !== terminal.scopeUnit) {
      return { durable: false, outcome: 'refused', taskId };
    }
    if (existing.terminalProvenance) {
      return sameFailedUnitInvocation(existing.terminalProvenance, terminal)
        ? { durable: true, outcome: 'already-recorded', taskId }
        : { durable: false, outcome: 'refused', taskId };
    }
  }

  if (!existing.endedAt || !isTerminalState(existing.state)) {
    return { durable: false, outcome: 'refused', taskId };
  }

  // Preserve the existing terminal STATE/reason. The fallback snapshot fills only
  // evidence/metrics that were missing; it must not rewrite an exit observed by
  // the owning spawn path into a later inferred classification.
  const normalized = classifyTerminalClose(
    {
      state: existing.state as CloseTaskInput['state'],
      exitCode: existing.exitCode,
      exitReason: existing.exitReason,
      terminalProvenance: terminal,
    },
    existing,
  );
  const terminalJson = JSON.stringify(normalized.terminalProvenance);
  const rows = await sql<Array<{ task_id: string }>>`
    UPDATE harness_shared.task_ledger
       SET exit_code = COALESCE(exit_code, ${normalized.exitCode ?? null}),
           exit_reason = COALESCE(exit_reason, ${normalized.exitReason ?? null}),
           memory_max_bytes = COALESCE(${normalized.terminalProvenance?.memoryMaxBytes ?? null}, memory_max_bytes),
           peak_memory_bytes = CASE
             WHEN ${normalized.terminalProvenance?.peakMemoryBytes ?? null}::bigint IS NULL THEN peak_memory_bytes
             WHEN peak_memory_bytes IS NULL THEN ${normalized.terminalProvenance?.peakMemoryBytes ?? null}::bigint
             ELSE GREATEST(peak_memory_bytes, ${normalized.terminalProvenance?.peakMemoryBytes ?? null}::bigint)
           END,
           detail = detail || jsonb_build_object('terminalProvenance', ${terminalJson}::text::jsonb),
           updated_at = now()
     WHERE task_id = ${taskId}
       AND ended_at IS NOT NULL
       AND scope_unit = ${terminal.scopeUnit}
       AND (
         NOT (detail ? 'terminalProvenance')
         OR (
           detail #>> '{terminalProvenance,scopeUnit}' = ${terminal.scopeUnit}
           AND detail #>> '{terminalProvenance,invocationId}' IS NOT DISTINCT FROM ${terminal.invocationId}
         )
       )
    RETURNING task_id
  `;
  if (rows.length > 0) return { durable: true, outcome: 'augmented-terminal', taskId };

  existing = await getTask(taskId, inject);
  return sameFailedUnitInvocation(existing?.terminalProvenance, terminal)
    ? { durable: true, outcome: 'already-recorded', taskId }
    : { durable: false, outcome: 'refused', taskId };
}

/** Bulk liveness + metrics refresh, one statement for the whole scan. */
export async function touchAlive(
  updates: readonly {
    taskId: string;
    pid?: number | null;
    processIdentity?: string | null;
    metrics?: TaskMetrics;
  }[],
  inject?: Sql,
): Promise<number> {
  if (updates.length === 0) return 0;
  const sql = sqlOf(inject);
  const payload = updates.map((u) => ({
    task_id: u.taskId,
    pid: u.pid ?? null,
    process_identity: u.processIdentity ?? null,
    last_memory_bytes: u.metrics?.lastMemoryBytes ?? null,
    cpu_usec: u.metrics?.cpuUsec ?? null,
    pids_current: u.metrics?.pidsCurrent ?? null,
    pids_events_max: u.metrics?.pidsEventsMax ?? null,
  }));
  const rows = await sql`
    UPDATE harness_shared.task_ledger t
       SET last_seen_at = now(),
           updated_at = now(),
           pid = COALESCE(u.pid, t.pid),
           process_identity = COALESCE(u.process_identity, t.process_identity),
           last_memory_bytes = COALESCE(u.last_memory_bytes, t.last_memory_bytes),
           -- peak is a high-water mark: it must never fall when a sample dips.
           peak_memory_bytes = GREATEST(
             COALESCE(t.peak_memory_bytes, 0), COALESCE(u.last_memory_bytes, 0)
           ),
           cpu_usec = COALESCE(u.cpu_usec, t.cpu_usec),
           pids_current = COALESCE(u.pids_current, t.pids_current),
           -- pids.events is cumulative, so preserve the largest observed value
           -- in the existing detail bag rather than adding a schema column.
           detail = CASE
             WHEN u.pids_events_max IS NULL THEN detail
             ELSE jsonb_set(
               detail,
               '{pidsEventsMax}',
               to_jsonb(GREATEST(
                 CASE
                   WHEN jsonb_typeof(detail->'pidsEventsMax') = 'number'
                        AND (detail->>'pidsEventsMax') ~ '^[0-9]+$'
                     THEN (detail->>'pidsEventsMax')::bigint
                   ELSE 0::bigint
                 END,
                 u.pids_events_max
               )),
               true
             )
           END
      FROM (
        SELECT (x->>'task_id')::text AS task_id,
               (x->>'pid')::int AS pid,
               (x->>'process_identity')::text AS process_identity,
               (x->>'last_memory_bytes')::bigint AS last_memory_bytes,
               (x->>'cpu_usec')::bigint AS cpu_usec,
               (x->>'pids_current')::int AS pids_current,
               (x->>'pids_events_max')::bigint AS pids_events_max
          FROM jsonb_array_elements(${JSON.stringify(payload)}::text::jsonb) AS x
      ) u
     WHERE t.task_id = u.task_id
       AND t.ended_at IS NULL
    RETURNING t.task_id
  `;
  return rows.length;
}

/** Close a batch of rows the reconciler judged absent — the ESCAPE/anomaly class. */
export async function markStranded(
  verdicts: readonly { taskId: string; reason: string }[],
  inject?: Sql,
): Promise<number> {
  let n = 0;
  for (const v of verdicts) {
    if (await closeTask(v.taskId, { state: 'stranded', exitReason: v.reason }, inject)) n++;
  }
  return n;
}

/**
 * Close a batch of rows the reconciler confirmed ended in good order (D-018):
 * absent from the scan, AND systemd independently confirms the task's scope was
 * released (every process in it is actually gone) — not the escape/anomaly class
 * `markStranded` is for, just an exit nobody happened to observe.
 */
export async function markEndedUnobserved(
  verdicts: readonly {
    taskId: string;
    reason: string;
    terminalProvenance?: TaskTerminalProvenance | null;
  }[],
  inject?: Sql,
): Promise<number> {
  let n = 0;
  for (const v of verdicts) {
    if (
      await closeTask(
        v.taskId,
        {
          state: 'ended_unobserved',
          exitReason: v.reason,
          terminalProvenance: v.terminalProvenance,
        },
        inject,
      )
    ) {
      n++;
    }
  }
  return n;
}

/**
 * Close rows whose watcher was lost but whose runner-written JOB END marker
 * survived in the log (WI-10004208). The marker is the payload's own exit,
 * written by the transient-service runner after it drained output. It is
 * therefore an OBSERVED terminal verdict, not a guess, and it closes the row
 * as `exited` / `killed` / `timed_out` with the real exit code instead of
 * `ended_unobserved`. The verification attempt then records pass/fail instead
 * of `unknown`.
 */
export async function markRecoveredFromJobLog(
  verdicts: readonly {
    taskId: string;
    state: Extract<TaskState, 'exited' | 'killed' | 'timed_out'>;
    exitCode: number | null;
    reason: string;
    terminalProvenance?: TaskTerminalProvenance | null;
  }[],
  inject?: Sql,
): Promise<number> {
  let n = 0;
  for (const v of verdicts) {
    if (
      await closeTask(
        v.taskId,
        {
          state: v.state,
          exitCode: v.exitCode,
          exitReason: v.reason,
          terminalProvenance: v.terminalProvenance,
        },
        inject,
      )
    ) {
      n++;
    }
  }
  return n;
}

export interface ListTasksFilter {
  workspaceId?: string;
  states?: readonly TaskState[];
  classes?: readonly string[];
  launchedBy?: string;
  /**
   * The coord ownerId the task BELONGS to — not `launchedBy`, which is whoever
   * SPAWNED it. For an agent-session those differ (a fleet member's row is
   * launched_by its launcher), so `launchedBy` cannot answer "which task is
   * me?". That gap is why diagnosing an agent's own confinement fell back to
   * `pgrep -f <ownerId>`, an idiom that self-matches the caller's own command
   * line — the documented `pkill -f` trap, returning the caller's pid as if it
   * were the target's (P-023/WI-2141828).
  */
  coordOwnerId?: string;
  /** Match one exact task-ledger row by its durable task id. */
  taskId?: string;
  /** Match one exact systemd scope/service unit before the result limit is applied. */
  scopeUnit?: string;
  /** Match one exact systemd InvocationID stored in terminal provenance. */
  invocationId?: string;
  workItemId?: string;
  rootTaskId?: string;
  /** Native Claude/Codex session id recorded after bootstrap. */
  sessionId?: string;
  /** Include rows that ended before now — off by default, so the common read is
   *  "what is running" and history is opt-in. */
  includeEnded?: boolean;
  /**
   * Match only rows whose label starts with this string.
   *
   * The label is `detail.label` — a jsonb field, NOT a column; `task_ledger` has no
   * `label` column at all. Pushing the prefix down here is what makes a label lookup
   * correct rather than merely likely: filtering AFTER a capped `limit` silently
   * misses any matching row that fell outside the window, and on this box the ledger
   * carries five figures of rows against a default window of 200.
   *
   * `starts_with()`, never `LIKE prefix || '%'`: a label prefix legitimately contains
   * `_`, which LIKE reads as a single-character wildcard, so LIKE would match labels
   * that merely resemble the prefix. `starts_with` takes the operand literally.
   */
  labelPrefix?: string;
  limit?: number;
}

/**
 * P-009: the most recent STRANDED close per coord owner, for a set of owners in ONE query.
 *
 * `listTasks` can already answer this for a SINGLE owner, and calling it per member is the
 * obvious composition — but a leader-brief renders a whole fleet, so that shape is N queries
 * inside one bounded read leg, where the Nth is the one that blows the budget. Pushing the
 * owner set down keeps it at one round-trip regardless of headcount.
 *
 * DISTINCT ON takes the newest close per owner: a member recovered more than once should
 * report its CURRENT disposition, not its first. Rows carry `ended_at IS NOT NULL` by
 * construction (`markStranded` closes the row), so `includeEnded` has no analogue here.
 */
export async function listLatestStrandedByCoordOwners(
  coordOwnerIds: readonly string[],
  opts: { workspaceId?: string } = {},
  inject?: Sql,
): Promise<Array<{ coordOwnerId: string; taskId: string; reason: string | null; endedAt: string | null }>> {
  if (coordOwnerIds.length === 0) return [];
  const sql = sqlOf(inject);
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const rows = await sql<Array<{ coord_owner_id: string; task_id: string; exit_reason: string | null; ended_at: string | null }>>`
    SELECT DISTINCT ON (detail ->> 'coordOwnerId')
           detail ->> 'coordOwnerId' AS coord_owner_id,
           task_id,
           exit_reason,
           ended_at
      FROM harness_shared.task_ledger
     WHERE workspace_id = ${ws}
       AND state = 'stranded'
       AND detail ->> 'coordOwnerId' = ANY(${sql.array(coordOwnerIds as string[])})
     ORDER BY detail ->> 'coordOwnerId', ended_at DESC NULLS LAST
  `;
  return rows.map((r) => ({
    coordOwnerId: r.coord_owner_id,
    taskId: r.task_id,
    reason: r.exit_reason ?? null,
    endedAt: r.ended_at ?? null,
  }));
}

export async function listTasks(filter: ListTasksFilter = {}, inject?: Sql): Promise<TaskRow[]> {
  const sql = sqlOf(inject);
  const ws = filter.workspaceId ?? activeWorkspaceId();
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 2000);
  const rows = await sql`
    SELECT * FROM harness_shared.task_ledger
     WHERE workspace_id = ${ws}
       ${filter.includeEnded ? sql`` : sql`AND ended_at IS NULL`}
       ${filter.states?.length ? sql`AND state = ANY(${sql.array(filter.states as string[])})` : sql``}
       ${filter.classes?.length ? sql`AND class = ANY(${sql.array(filter.classes as string[])})` : sql``}
       ${filter.launchedBy ? sql`AND launched_by = ${filter.launchedBy}` : sql``}
       ${filter.coordOwnerId ? sql`AND detail ->> 'coordOwnerId' = ${filter.coordOwnerId}` : sql``}
       ${filter.taskId ? sql`AND task_id = ${filter.taskId}` : sql``}
       ${
         filter.scopeUnit
           ? sql`AND (scope_unit = ${filter.scopeUnit} OR detail #>> '{terminalProvenance,scopeUnit}' = ${filter.scopeUnit})`
           : sql``
       }
       ${filter.invocationId ? sql`AND detail #>> '{terminalProvenance,invocationId}' = ${filter.invocationId}` : sql``}
       ${filter.workItemId ? sql`AND work_item_id = ${filter.workItemId}` : sql``}
       ${filter.rootTaskId ? sql`AND root_task_id = ${filter.rootTaskId}` : sql``}
       ${filter.sessionId ? sql`AND session_id = ${filter.sessionId}` : sql``}
       ${filter.labelPrefix ? sql`AND starts_with(detail ->> 'label', ${filter.labelPrefix})` : sql``}
     ORDER BY started_at DESC
     LIMIT ${limit}
  `;
  return rows.map(toRow);
}

/**
 * Bind every still-live headless agent task for one stable coord owner to the
 * native session incarnation bootstrap just recorded.
 *
 * `spawnHeadless` has to enrol before fork, while bootstrap learns the native
 * session id inside the child. The stable owner id in `detail` is the hand-off
 * key between those orderings. Updating all matching live rows is deliberate:
 * a duplicate launch under one owner is already an anomaly, and session end
 * must reap every subtree that identity owns rather than leave the duplicate.
 */
export async function bindLiveAgentSessionTasksToNativeSession(
  input: { workspaceId?: string; coordOwnerId: string; sessionId: string },
  inject?: Sql,
): Promise<string[]> {
  const coordOwnerId = input.coordOwnerId.trim();
  const sessionId = input.sessionId.trim();
  if (!coordOwnerId || !sessionId) return [];
  const sql = sqlOf(inject);
  const ws = input.workspaceId ?? activeWorkspaceId();
  const rows = await sql<Array<{ task_id: string }>>`
    UPDATE harness_shared.task_ledger
       SET session_id = ${sessionId}, updated_at = now()
     WHERE workspace_id = ${ws}
       AND class = 'agent-session'
       AND state IN ('pending', 'running')
       AND ended_at IS NULL
       AND detail ->> 'coordOwnerId' = ${coordOwnerId}
       AND session_id IS DISTINCT FROM ${sessionId}
    RETURNING task_id
  `;
  return rows.map((row) => row.task_id);
}

/**
 * The other half of the bootstrap/enrolment race: after the async task insert
 * lands, bind that one row to the newest open tracked session for its stamped
 * coord owner. Bootstrap calls the owner-keyed bulk binder above, so whichever
 * database write lands second performs the link and no timing window remains.
 */
export async function bindAgentSessionTaskToLatestNativeSession(taskId: string, inject?: Sql): Promise<string | null> {
  if (!taskId.trim()) return null;
  const sql = sqlOf(inject);
  const rows = await sql<Array<{ session_id: string }>>`
    WITH candidate AS (
      SELECT t.task_id,
             (
               SELECT s.session_id
                 FROM harness_shared.adv_sessions s
                WHERE s.workspace_id = t.workspace_id
                  AND s.coord_owner_id = t.detail ->> 'coordOwnerId'
                  AND s.session_id IS NOT NULL
                  AND s.ended_at IS NULL
                ORDER BY s.started_at DESC, s.id DESC
                LIMIT 1
             ) AS session_id
        FROM harness_shared.task_ledger t
       WHERE t.task_id = ${taskId}
         AND t.class = 'agent-session'
         AND t.state IN ('pending', 'running')
         AND t.ended_at IS NULL
         AND COALESCE(t.detail ->> 'coordOwnerId', '') <> ''
    )
    UPDATE harness_shared.task_ledger t
       SET session_id = candidate.session_id, updated_at = now()
      FROM candidate
     WHERE t.task_id = candidate.task_id
       AND candidate.session_id IS NOT NULL
       AND t.session_id IS DISTINCT FROM candidate.session_id
    RETURNING t.session_id
  `;
  return rows[0]?.session_id ?? null;
}

/** Every row in a state that asserts a live OS process — the reconciler's input. */
export async function listLiveTasks(workspaceId?: string, inject?: Sql): Promise<TaskRow[]> {
  return listTasks({ workspaceId, states: ['pending', 'running'], limit: 2000 }, inject);
}

/**
 * The complete ledger population inspected by the process-lifecycle judge.
 *
 * This is deliberately NOT composed from `listLiveTasks`: that general-purpose
 * read is capped at 2,000 rows, while the lifecycle contract is "every launch".
 * Live/persisted-residue rows are therefore read without a result cap. Terminal
 * rows are admitted only when the current kernel reconcile positively named
 * their task id as residue, so old history never becomes a candidate merely by
 * being retained in the ledger.
 */
export async function listLifecycleJudgementTasks(
  input: { workspaceId?: string; residueTaskIds?: readonly string[] } = {},
  inject?: Sql,
): Promise<TaskRow[]> {
  const sql = sqlOf(inject);
  const ws = input.workspaceId ?? activeWorkspaceId();
  const residueTaskIds = [...new Set((input.residueTaskIds ?? []).filter(Boolean))];
  const rows = await sql`
    SELECT * FROM harness_shared.task_ledger
     WHERE workspace_id = ${ws}
       AND (
         (ended_at IS NULL AND state IN ('pending', 'running', 'unaccounted'))
         ${residueTaskIds.length ? sql`OR task_id = ANY(${sql.array(residueTaskIds)})` : sql``}
       )
     ORDER BY started_at ASC
  `;
  return rows.map(toRow);
}

export interface TaskLifecycleProbeUpdate {
  taskId: string;
  probe: object;
}

/**
 * Persist restart-safe activity/launcher clocks without replacing any other
 * task detail. The lifecycle sweep emits only changed probes, so the common
 * no-delta pass performs no write at all.
 */
export async function mergeTaskLifecycleProbes(
  updates: readonly TaskLifecycleProbeUpdate[],
  inject?: Sql,
): Promise<number> {
  if (updates.length === 0) return 0;
  const sql = sqlOf(inject);
  const payload = updates.map((update) => ({ taskId: update.taskId, probe: update.probe }));
  const rows = await sql`
    UPDATE harness_shared.task_ledger t
       SET detail = jsonb_set(
             CASE WHEN jsonb_typeof(t.detail) = 'object' THEN t.detail ELSE '{}'::jsonb END,
             '{processLifecycleProbe}',
             u.probe,
             true
           ),
           updated_at = now()
      FROM (
        SELECT x->>'taskId' AS task_id, x->'probe' AS probe
          FROM jsonb_array_elements(${JSON.stringify(payload)}::text::jsonb) AS x
      ) u
     WHERE t.task_id = u.task_id
       AND t.ended_at IS NULL
       AND jsonb_typeof(u.probe) = 'object'
    RETURNING t.task_id
  `;
  return rows.length;
}

export async function getTask(taskId: string, inject?: Sql): Promise<TaskRow | null> {
  const sql = sqlOf(inject);
  const rows = await sql`SELECT * FROM harness_shared.task_ledger WHERE task_id = ${taskId} LIMIT 1`;
  return rows[0] ? toRow(rows[0]) : null;
}

// ── Restart-safe release receipts ──────────────────────────────────────────

export const TASK_RELEASE_JOURNAL_SCHEMA_VERSION = 1 as const;

export type TaskReleaseReceiptState = 'intent' | 'unknown' | 'committed' | 'refused';

export interface TaskReleaseReuseSource {
  taskId: string;
  operationId: string;
  sequence: number;
}

export interface TaskReleaseReceiptInput {
  /** Identity of the whole immutable release run. */
  operationId: string;
  /** One-use identity of this exact outward request/reconciliation. */
  requestIdentity: string;
  stage: string;
  state: TaskReleaseReceiptState;
  /** Digest of every input that makes this stage result reusable. */
  inputHash: string;
  /** Canonical JSON preimage behind inputHash, retained for review and invalidation diagnosis. */
  inputIdentity?: unknown;
  evidenceRefs?: readonly string[];
  credentialGeneration?: string | null;
  credentialExpiresAt?: string | null;
  /** Prior committed receipt that seeded this operation's reconcile intent. */
  reuseSource?: TaskReleaseReuseSource | null;
  /** Handler time spent looking for a prior committed receipt (queue wait excluded). */
  lookupElapsedMs?: number | null;
  /** Managed-task admission-to-child-start latency, kept separate from preparation. */
  queueWaitMs?: number | null;
  /** In-process release preparation time through this receipt (queue wait excluded). */
  preparationElapsedMs?: number | null;
  /** Audit/freshness boundary after which this receipt cannot seed another operation. */
  reuseExpiresAt?: string | null;
  recordedAt?: string;
}

export interface TaskReleaseReceipt extends Omit<
  TaskReleaseReceiptInput,
  | 'evidenceRefs'
  | 'recordedAt'
  | 'inputIdentity'
  | 'reuseSource'
  | 'lookupElapsedMs'
  | 'queueWaitMs'
  | 'preparationElapsedMs'
  | 'reuseExpiresAt'
> {
  sequence: number;
  evidenceRefs: string[];
  inputIdentity?: unknown | null;
  recordedAt: string;
  reuseSource?: TaskReleaseReuseSource | null;
  lookupElapsedMs?: number | null;
  queueWaitMs?: number | null;
  preparationElapsedMs?: number | null;
  reuseExpiresAt?: string | null;
}

export interface TaskReleaseJournal {
  schemaVersion: typeof TASK_RELEASE_JOURNAL_SCHEMA_VERSION;
  operationId: string;
  cursor: number;
  currentStage: string | null;
  currentState: TaskReleaseReceiptState | null;
  spentOperationIds: string[];
  receipts: TaskReleaseReceipt[];
  [key: string]: unknown;
}

export type AppendTaskReleaseReceiptResult =
  | { ok: true; journal: TaskReleaseJournal; receipt: TaskReleaseReceipt }
  | {
      ok: false;
      reason:
        | 'task_not_found'
        | 'journal_missing'
        | 'operation_identity_mismatch'
        | 'cursor_mismatch'
        | 'request_identity_conflict'
        | 'invalid_transition'
        | 'cas_conflict';
      journal: TaskReleaseJournal | null;
    };

function boundedReceiptString(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new Error(`task-manager: release receipt ${field} must be a non-empty string <= ${max} characters`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`task-manager: release receipt ${field} contains control characters`);
  }
  return value;
}

function serializeReceiptInputIdentity(value: unknown): string | null {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' ? serialized : null;
  } catch {
    return null;
  }
}

function releaseReceiptFromUnknown(value: unknown): TaskReleaseReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const reuseSource = raw.reuseSource;
  const inputIdentityJson = serializeReceiptInputIdentity(raw.inputIdentity);
  if (
    !Number.isSafeInteger(raw.sequence) ||
    (raw.sequence as number) < 0 ||
    typeof raw.operationId !== 'string' ||
    typeof raw.requestIdentity !== 'string' ||
    typeof raw.stage !== 'string' ||
    !['intent', 'unknown', 'committed', 'refused'].includes(String(raw.state)) ||
    typeof raw.inputHash !== 'string' ||
    (raw.inputIdentity !== undefined &&
      (inputIdentityJson === null || Buffer.byteLength(inputIdentityJson, 'utf8') > 16_000)) ||
    typeof raw.recordedAt !== 'string' ||
    !Array.isArray(raw.evidenceRefs) ||
    !raw.evidenceRefs.every((entry) => typeof entry === 'string') ||
    !(
      reuseSource == null ||
      (
        typeof reuseSource === 'object' &&
        !Array.isArray(reuseSource) &&
        typeof (reuseSource as Record<string, unknown>).taskId === 'string' &&
        typeof (reuseSource as Record<string, unknown>).operationId === 'string' &&
        Number.isSafeInteger((reuseSource as Record<string, unknown>).sequence) &&
        ((reuseSource as Record<string, unknown>).sequence as number) >= 0
      )
    ) ||
    ![raw.lookupElapsedMs, raw.queueWaitMs, raw.preparationElapsedMs].every(
      (entry) => entry == null || (typeof entry === 'number' && Number.isFinite(entry) && entry >= 0),
    ) ||
    !(raw.reuseExpiresAt == null || (typeof raw.reuseExpiresAt === 'string' && Number.isFinite(Date.parse(raw.reuseExpiresAt))))
  ) return null;
  return raw as unknown as TaskReleaseReceipt;
}

/** Parse only a complete journal. A malformed/missing chain is unknown, never empty-success. */
export function taskReleaseJournalFromDetail(
  detail: Record<string, unknown> | null | undefined,
): TaskReleaseJournal | null {
  const raw = detail?.release;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (
    value.schemaVersion !== TASK_RELEASE_JOURNAL_SCHEMA_VERSION ||
    typeof value.operationId !== 'string' ||
    !Number.isSafeInteger(value.cursor) ||
    (value.cursor as number) < 0 ||
    !(value.currentStage === null || typeof value.currentStage === 'string') ||
    !(
      value.currentState === null ||
      ['intent', 'unknown', 'committed', 'refused'].includes(String(value.currentState))
    ) ||
    !Array.isArray(value.spentOperationIds) ||
    !value.spentOperationIds.every((entry) => typeof entry === 'string') ||
    !Array.isArray(value.receipts)
  ) return null;
  const receipts = value.receipts.map(releaseReceiptFromUnknown);
  if (receipts.some((receipt) => receipt === null) || receipts.length !== value.cursor) return null;
  for (let index = 0; index < receipts.length; index += 1) {
    if (receipts[index]!.sequence !== index) return null;
  }
  return { ...value, receipts: receipts as TaskReleaseReceipt[] } as TaskReleaseJournal;
}

function normalizeReleaseReceipt(
  expectedCursor: number,
  input: TaskReleaseReceiptInput,
): TaskReleaseReceipt {
  if (!Number.isSafeInteger(expectedCursor) || expectedCursor < 0) {
    throw new Error('task-manager: expected release receipt cursor must be a non-negative safe integer');
  }
  const evidenceRefs = [...(input.evidenceRefs ?? [])];
  if (evidenceRefs.length > 64) {
    throw new Error('task-manager: a release receipt accepts at most 64 evidence references');
  }
  for (const ref of evidenceRefs) boundedReceiptString(ref, 'evidenceRefs[]', 1000);
  const recordedAt = input.recordedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(recordedAt))) {
    throw new Error('task-manager: release receipt recordedAt must be an ISO timestamp');
  }
  const elapsedMs = (value: number | null | undefined, field: string): number | null => {
    if (value == null) return null;
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`task-manager: release receipt ${field} must be a finite non-negative number`);
    }
    return Math.round(value * 1000) / 1000;
  };
  const reuseExpiresAt = input.reuseExpiresAt == null ? null : new Date(input.reuseExpiresAt);
  if (reuseExpiresAt && !Number.isFinite(reuseExpiresAt.getTime())) {
    throw new Error('task-manager: release receipt reuseExpiresAt must be an ISO timestamp');
  }
  const reuseSource = input.reuseSource == null
    ? null
    : {
        taskId: boundedReceiptString(input.reuseSource.taskId, 'reuseSource.taskId', 256),
        operationId: boundedReceiptString(input.reuseSource.operationId, 'reuseSource.operationId', 256),
        sequence: input.reuseSource.sequence,
      };
  if (reuseSource && (!Number.isSafeInteger(reuseSource.sequence) || reuseSource.sequence < 0)) {
    throw new Error('task-manager: release receipt reuseSource.sequence must be a non-negative safe integer');
  }
  let inputIdentity: unknown | null = input.inputIdentity ?? null;
  const inputIdentityJson = serializeReceiptInputIdentity(inputIdentity);
  if (inputIdentityJson === null) {
    throw new Error('task-manager: release receipt inputIdentity must be JSON-serializable');
  }
  if (Buffer.byteLength(inputIdentityJson, 'utf8') > 16_000) {
    throw new Error('task-manager: release receipt inputIdentity must be <= 16000 JSON bytes');
  }
  inputIdentity = JSON.parse(inputIdentityJson) as unknown;
  return {
    sequence: expectedCursor,
    operationId: boundedReceiptString(input.operationId, 'operationId', 256),
    requestIdentity: boundedReceiptString(input.requestIdentity, 'requestIdentity', 256),
    stage: boundedReceiptString(input.stage, 'stage', 160),
    state: input.state,
    inputHash: boundedReceiptString(input.inputHash, 'inputHash', 256),
    inputIdentity,
    evidenceRefs,
    credentialGeneration:
      input.credentialGeneration == null
        ? null
        : boundedReceiptString(input.credentialGeneration, 'credentialGeneration', 256),
    credentialExpiresAt:
      input.credentialExpiresAt == null
        ? null
        : boundedReceiptString(input.credentialExpiresAt, 'credentialExpiresAt', 128),
    reuseSource,
    lookupElapsedMs: elapsedMs(input.lookupElapsedMs, 'lookupElapsedMs'),
    queueWaitMs: elapsedMs(input.queueWaitMs, 'queueWaitMs'),
    preparationElapsedMs: elapsedMs(input.preparationElapsedMs, 'preparationElapsedMs'),
    reuseExpiresAt: reuseExpiresAt?.toISOString() ?? null,
    recordedAt: new Date(recordedAt).toISOString(),
  };
}

export interface PriorCommittedTaskReleaseReceipt {
  taskId: string;
  operationId: string;
  receipt: TaskReleaseReceipt;
}

export interface FindPriorCommittedTaskReleaseReceiptInput {
  currentTaskId: string;
  currentOperationId: string;
  stage: string;
  inputHash: string;
  credentialGeneration?: string | null;
  requiredEvidenceRefs?: readonly string[];
  now?: Date;
  maxCandidates?: number;
}

/**
 * Find one still-fresh committed stage receipt from an earlier terminal deploy.
 *
 * This deliberately extends `task_ledger.detail.release` instead of creating a
 * second cache ledger. The current task row supplies the workspace + harness
 * boundary, and the SQL returns only a bounded newest-first candidate window.
 * Every candidate is then parsed through the same complete-journal validator as
 * ordinary resume; malformed, future-dated, or expired evidence is a miss.
 */
export async function findPriorCommittedTaskReleaseReceipt(
  input: FindPriorCommittedTaskReleaseReceiptInput,
  inject?: Sql,
): Promise<PriorCommittedTaskReleaseReceipt | null> {
  const sql = sqlOf(inject);
  const currentTaskId = boundedReceiptString(input.currentTaskId, 'currentTaskId', 256);
  const currentOperationId = boundedReceiptString(input.currentOperationId, 'currentOperationId', 256);
  const stage = boundedReceiptString(input.stage, 'stage', 160);
  const inputHash = boundedReceiptString(input.inputHash, 'inputHash', 256);
  const requiredEvidenceRefs = [...(input.requiredEvidenceRefs ?? [])];
  if (requiredEvidenceRefs.length > 16) {
    throw new Error('task-manager: prior receipt lookup accepts at most 16 required evidence references');
  }
  for (const ref of requiredEvidenceRefs) boundedReceiptString(ref, 'requiredEvidenceRefs[]', 1000);
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error('task-manager: prior receipt lookup now must be valid');
  const maxCandidates = Math.min(Math.max(input.maxCandidates ?? 32, 1), 64);
  const rows = await sql<Array<{ task_id: string; release: unknown; sequence: number }>>`
    SELECT candidate.task_id,
           candidate.detail -> 'release' AS release,
           (prior.ordinality - 1)::integer AS sequence
      FROM harness_shared.task_ledger current_task
      JOIN harness_shared.task_ledger candidate
        ON candidate.workspace_id = current_task.workspace_id
       AND candidate.harness_slug IS NOT DISTINCT FROM current_task.harness_slug
       AND candidate.task_id <> current_task.task_id
       AND candidate.class = 'deploy'
       AND candidate.launched_by = current_task.launched_by
       AND NULLIF(current_task.detail #>> '{release,artifactIdentity,kind}', '') IS NOT NULL
       AND candidate.detail #>> '{release,artifactIdentity,kind}'
             = current_task.detail #>> '{release,artifactIdentity,kind}'
       AND candidate.ended_at IS NOT NULL
       AND candidate.started_at <= current_task.started_at
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(candidate.detail #> '{release,receipts}') = 'array'
            THEN candidate.detail #> '{release,receipts}'
          ELSE '[]'::jsonb
        END
      )
        WITH ORDINALITY AS prior(receipt, ordinality)
     WHERE current_task.task_id = ${currentTaskId}
       AND current_task.class = 'deploy'
       AND jsonb_typeof(candidate.detail -> 'release') = 'object'
       AND jsonb_typeof(candidate.detail #> '{release,receipts}') = 'array'
       AND candidate.detail #>> '{release,operationId}' <> ${currentOperationId}
       AND prior.receipt ->> 'stage' = ${stage}
       AND prior.receipt ->> 'state' = 'committed'
       AND prior.receipt ->> 'inputHash' = ${inputHash}
     ORDER BY candidate.started_at DESC, prior.ordinality DESC
     LIMIT ${maxCandidates}
  `;
  for (const row of rows) {
    const journal = taskReleaseJournalFromDetail({ release: row.release });
    const receipt = journal?.receipts[row.sequence];
    if (
      !journal ||
      !receipt ||
      journal.operationId === currentOperationId ||
      receipt.operationId !== journal.operationId ||
      receipt.stage !== stage ||
      receipt.state !== 'committed' ||
      receipt.inputHash !== inputHash
    ) continue;
    const recordedAt = Date.parse(receipt.recordedAt);
    const reuseExpiresAt = Date.parse(receipt.reuseExpiresAt ?? '');
    const credentialExpiresAt = Date.parse(receipt.credentialExpiresAt ?? '');
    if (
      !Number.isFinite(recordedAt) ||
      recordedAt > now.getTime() ||
      !Number.isFinite(reuseExpiresAt) ||
      reuseExpiresAt <= now.getTime() ||
      receipt.credentialGeneration !== (input.credentialGeneration ?? null) ||
      (receipt.credentialExpiresAt != null &&
        (!Number.isFinite(credentialExpiresAt) || credentialExpiresAt <= now.getTime())) ||
      requiredEvidenceRefs.some((ref) => !receipt.evidenceRefs.includes(ref))
    ) continue;
    return { taskId: row.task_id, operationId: journal.operationId, receipt };
  }
  return null;
}

/**
 * Atomically append one transition to `task_ledger.detail.release`.
 *
 * The cursor is the compare-and-swap boundary. The SQL additionally enforces
 * the request transition graph so two resumed children cannot both spend one
 * request identity or advance an `unknown` outcome without reconciliation.
 */
export async function appendTaskReleaseReceipt(
  taskId: string,
  expectedCursor: number,
  input: TaskReleaseReceiptInput,
  inject?: Sql,
): Promise<AppendTaskReleaseReceiptResult> {
  const sql = sqlOf(inject);
  const receipt = normalizeReleaseReceipt(expectedCursor, input);
  const receiptJson = JSON.stringify(receipt);
  const rows = await sql<Array<{ release: unknown }>>`
    UPDATE harness_shared.task_ledger
       SET detail = jsonb_set(
                      detail,
                      '{release}',
                      (detail -> 'release') || jsonb_build_object(
                        'receipts', (detail #> '{release,receipts}') || ${receiptJson}::text::jsonb,
                        'cursor', ${expectedCursor + 1}::integer,
                        'currentStage', ${receipt.stage}::text,
                        'currentState', ${receipt.state}::text,
                        'spentOperationIds', CASE
                          WHEN ${receipt.state} = 'intent'
                            THEN (detail #> '{release,spentOperationIds}') || jsonb_build_array(${receipt.requestIdentity}::text)
                          ELSE detail #> '{release,spentOperationIds}'
                        END
                      ),
                      false
                    ),
           updated_at = now()
     WHERE task_id = ${taskId}
       AND jsonb_typeof(detail -> 'release') = 'object'
       AND detail #>> '{release,schemaVersion}' = ${String(TASK_RELEASE_JOURNAL_SCHEMA_VERSION)}
       AND detail #>> '{release,operationId}' = ${receipt.operationId}
       AND jsonb_typeof(detail #> '{release,receipts}') = 'array'
       AND jsonb_typeof(detail #> '{release,spentOperationIds}') = 'array'
       AND (detail #>> '{release,cursor}') ~ '^[0-9]+$'
       AND (detail #>> '{release,cursor}')::integer = ${expectedCursor}
       AND NOT EXISTS (
             SELECT 1
               FROM jsonb_array_elements(detail #> '{release,receipts}') prior
              WHERE prior ->> 'requestIdentity' = ${receipt.requestIdentity}
                AND (
                  prior ->> 'stage' <> ${receipt.stage}
                  OR prior ->> 'inputHash' <> ${receipt.inputHash}
                  OR prior ->> 'operationId' <> ${receipt.operationId}
                )
           )
       AND CASE
             WHEN ${receipt.state} = 'intent' THEN NOT EXISTS (
               SELECT 1 FROM jsonb_array_elements(detail #> '{release,receipts}') prior
                WHERE prior ->> 'requestIdentity' = ${receipt.requestIdentity}
             )
             WHEN ${receipt.state} = 'unknown' THEN (
               SELECT prior ->> 'state'
                 FROM jsonb_array_elements(detail #> '{release,receipts}') WITH ORDINALITY AS p(prior, ordinal)
                WHERE prior ->> 'requestIdentity' = ${receipt.requestIdentity}
                ORDER BY ordinal DESC LIMIT 1
             ) = 'intent'
             ELSE (
               SELECT prior ->> 'state'
                 FROM jsonb_array_elements(detail #> '{release,receipts}') WITH ORDINALITY AS p(prior, ordinal)
                WHERE prior ->> 'requestIdentity' = ${receipt.requestIdentity}
                ORDER BY ordinal DESC LIMIT 1
             ) IN ('intent', 'unknown')
           END
     RETURNING detail -> 'release' AS release
  `;
  const appended = taskReleaseJournalFromDetail({ release: rows[0]?.release });
  if (appended) return { ok: true, journal: appended, receipt };

  const current = await getTask(taskId, sql);
  if (!current) return { ok: false, reason: 'task_not_found', journal: null };
  const journal = taskReleaseJournalFromDetail(current.detail);
  if (!journal) return { ok: false, reason: 'journal_missing', journal: null };
  if (journal.operationId !== receipt.operationId) {
    return { ok: false, reason: 'operation_identity_mismatch', journal };
  }
  if (journal.cursor !== expectedCursor) return { ok: false, reason: 'cursor_mismatch', journal };
  const matching = journal.receipts.filter((prior) => prior.requestIdentity === receipt.requestIdentity);
  if (matching.some((prior) =>
    prior.stage !== receipt.stage || prior.inputHash !== receipt.inputHash || prior.operationId !== receipt.operationId
  )) return { ok: false, reason: 'request_identity_conflict', journal };
  if (matching.length > 0 || receipt.state !== 'intent') {
    return { ok: false, reason: 'invalid_transition', journal };
  }
  return { ok: false, reason: 'cas_conflict', journal };
}

/** Persist a budget accepted by systemd for a live task. Omitted fields retain
 * their current ledger values so a CPU-only retune cannot erase MemoryMax. */
export interface TaskLimitUpdate {
  memoryMaxBytes?: number;
  cpuWeight?: number;
  tasksMax?: number;
}

export async function updateTaskLimits(taskId: string, limits: TaskLimitUpdate, inject?: Sql): Promise<boolean> {
  const sql = sqlOf(inject);
  const rows = await sql`
    UPDATE harness_shared.task_ledger
       SET memory_max_bytes = CASE
                                 WHEN ${limits.memoryMaxBytes === undefined}
                                   THEN memory_max_bytes
                                 ELSE ${limits.memoryMaxBytes ?? null}
                               END,
           cpu_weight = CASE
                          WHEN ${limits.cpuWeight === undefined}
                            THEN cpu_weight
                          ELSE ${limits.cpuWeight ?? null}
                        END,
           tasks_max = CASE
                         WHEN ${limits.tasksMax === undefined}
                           THEN tasks_max
                         ELSE ${limits.tasksMax ?? null}
                       END,
           updated_at = now()
     WHERE task_id = ${taskId}
       AND state IN ('pending', 'running')
       AND ended_at IS NULL
     RETURNING task_id
  `;
  return rows.length > 0;
}

/**
 * EI-18759519171684432: look up a `capability:bash` background job's ledger row by
 * its `bash_id` (the id `bash-jobs.ts`'s in-memory JOBS map keys on — a DIFFERENT
 * id from `task_id`). `startBackground` stamps `detail.bashJobId` at registration
 * time specifically so this join is possible: the in-memory registry is
 * process-bound and capped (EI-8855 wipes it on any restart, and old entries get
 * pruned under load), but this ledger row is the DURABLE half of the same job's
 * identity — it survives both. `bash_output`'s stranded-job path uses this to
 * distinguish "tracking lost, process still alive" from "genuinely gone" instead of
 * guessing from operator uptime alone. Newest match wins (a bash_id is a random
 * UUID slice, so more than one row is not expected in practice, but ORDER BY makes
 * the tie-break deterministic rather than DB-order-dependent).
 */
export async function getTaskByBashJobId(
  bashJobId: string,
  opts: { workspaceId?: string } = {},
  inject?: Sql,
): Promise<TaskRow | null> {
  const sql = sqlOf(inject);
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const rows = await sql`
    SELECT * FROM harness_shared.task_ledger
     WHERE workspace_id = ${ws}
       AND class = 'bash-job'
       -- WI-8806: REQUIRED for the planner to use task_ledger_bash_job_id_idx, which is
       -- PARTIAL on (class = 'bash-job' AND detail ? 'bashJobId'). Stating only the class
       -- half is not enough. Logically redundant beside the equality below, and load-bearing
       -- for the PLAN: measured 197 -> 1 buffer, 4.93ms -> 0.042ms. Before this clause the
       -- index had an idx_scan of exactly 0 -- it had never been used once since creation.
       AND detail ? 'bashJobId'
       AND detail ->> 'bashJobId' = ${bashJobId}
     ORDER BY started_at DESC
     LIMIT 1
  `;
  return rows[0] ? toRow(rows[0]) : null;
}

/** The whole tree a task belongs to — what "kill this and everything it started"
 *  and the pane's tree view both read. */
export async function getSubtree(rootTaskId: string, inject?: Sql): Promise<TaskRow[]> {
  const sql = sqlOf(inject);
  const rows = await sql`
    SELECT * FROM harness_shared.task_ledger
     WHERE root_task_id = ${rootTaskId}
     ORDER BY started_at ASC
  `;
  return rows.map(toRow);
}

/**
 * Persist an unaccounted residue group so a bypass accrues HISTORY ("this has been
 * here for three hours") instead of being re-reported as news every 30s.
 *
 * The id is derived from the cgroup path when the group has no scope of ours, so
 * repeated sightings upsert onto one row. When the group DOES sit in a `pc-` scope,
 * the scope's own task id is used: that case means a scope outlived the row that
 * described it, and re-using the id keeps the history attached to the real task
 * rather than forking a phantom one.
 */
export async function upsertUnaccounted(
  groups: readonly {
    taskId: string;
    cgroupPath: string;
    scopeUnit: string | null;
    pids: number[];
    sampleCmdline: string;
  }[],
  opts: { workspaceId?: string } = {},
  inject?: Sql,
): Promise<string[]> {
  if (groups.length === 0) return [];
  const sql = sqlOf(inject);
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const seen: string[] = [];
  const localBearer = readSuperuserToken();
  const diagnosticSecrets = localBearer ? [localBearer] : [];
  for (const g of groups) {
    // Residue samples originate in `/proc/<pid>/cmdline` and are persisted so the
    // reconciler can retain history. Redact before the durable boundary, and before
    // capping, so a credential-shaped assignment cannot survive in the ledger.
    const title = redactSensitiveText(g.sampleCmdline, diagnosticSecrets).slice(0, 200) || '(unknown)';
    await sql`
      INSERT INTO harness_shared.task_ledger (
        task_id, workspace_id, root_task_id, class, title, argv,
        launched_by, scope_unit, cgroup_path, pid, confined, state, detail
      ) VALUES (
        ${g.taskId}, ${ws}, ${g.taskId}, 'other',
        ${title},
        '[]'::jsonb, 'unknown', ${g.scopeUnit}, ${g.cgroupPath}, ${g.pids[0] ?? null}, false, 'unaccounted',
        ${JSON.stringify({ pids: g.pids, scopeUnit: g.scopeUnit })}::text::jsonb
      )
      ON CONFLICT (task_id) DO UPDATE
        SET title = EXCLUDED.title,
            scope_unit = COALESCE(EXCLUDED.scope_unit, harness_shared.task_ledger.scope_unit),
            last_seen_at = now(),
            updated_at = now(),
            state = CASE WHEN harness_shared.task_ledger.ended_at IS NULL
                         THEN 'unaccounted' ELSE harness_shared.task_ledger.state END,
            detail = ${JSON.stringify({ pids: g.pids, scopeUnit: g.scopeUnit })}::text::jsonb
    `;
    seen.push(g.taskId);
  }
  return seen;
}

/** Close previously-persisted residue rows that are no longer present. */
export async function clearVanishedUnaccounted(
  stillPresent: readonly string[],
  opts: { workspaceId?: string } = {},
  inject?: Sql,
): Promise<number> {
  const sql = sqlOf(inject);
  const ws = opts.workspaceId ?? activeWorkspaceId();
  // EI-18824358724907941: `stillPresent` is empty on every tick with zero current
  // unaccounted residue — the common/healthy case, not an edge case. This used to plug an
  // actual NUL byte ('\x00none') in as a sentinel to keep `<> ALL(...)` from being handed an
  // empty array; postgres rejects any string parameter containing 0x00 outright ("invalid
  // byte sequence for encoding \"UTF8\": 0x00"), so it failed EVERY such tick. `x <> ALL(arr)`
  // is vacuously TRUE for an empty `arr` (there is no element x fails to differ from) — i.e.
  // exactly the semantics we want ("nothing is present, so close everything previously
  // unaccounted") — so the clause is simply omitted when there's nothing to keep, matching
  // the same conditional-clause pattern already used a few lines up in this file (filter.states
  // / filter.classes) rather than routing an empty array through `sql.array`.
  const rows = await sql`
    UPDATE harness_shared.task_ledger
       SET state = 'stranded',
           exit_reason = 'unaccounted residue no longer present',
           ended_at = now(),
           updated_at = now()
     WHERE workspace_id = ${ws}
       AND state = 'unaccounted'
       AND ended_at IS NULL
       ${stillPresent.length ? sql`AND task_id <> ALL(${sql.array(stillPresent as string[])})` : sql``}
    RETURNING task_id
  `;
  return rows.length;
}

/**
 * Retention. Terminal rows are the "what ran overnight and what did it cost"
 * record, so they are kept for a while — but not forever, and never at the cost of
 * the hot live-read index.
 *
 * A row carrying `detail.release` is exempt. Its release journal is not process
 * telemetry: it is the ONLY store of that release's receipts, and a release keeps
 * receiving them long after its process exited — a workspace-host release is
 * published, then soaked for 24h, torn down, and its billing closure lands whenever
 * the provider's billing export settles. Deleting the row a week after the PUBLISH
 * process ended erased every one of those receipts, with nothing to rebuild them from.
 */
export async function gcTerminalTasks(
  olderThanHours = 168,
  opts: { workspaceId?: string } = {},
  inject?: Sql,
): Promise<number> {
  const sql = sqlOf(inject);
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const rows = await sql`
    DELETE FROM harness_shared.task_ledger
     WHERE workspace_id = ${ws}
       AND ended_at IS NOT NULL
       AND ended_at < now() - make_interval(hours => ${olderThanHours}::int)
       AND NOT (detail ? 'release')
    RETURNING task_id
  `;
  return rows.length;
}

/** Stable id for a residue group with no scope of ours. `[0-9a-z]` by construction. */
export function residueTaskId(cgroupPath: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < cgroupPath.length; i++) {
    const c = cgroupPath.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return `u${h1.toString(36)}${h2.toString(36)}`.slice(0, 24);
}
