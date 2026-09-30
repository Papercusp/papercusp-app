/**
 * Interactive PTY capability family (orchestration runtime unification P-011).
 *
 * The model-facing handle is always the durable task-ledger id. The node-pty id
 * stays process-local, and every follow-up call re-authorizes the ledger row
 * against the caller's current workspace, harness, and owner identity before it
 * resolves the in-memory handle. This preserves carry-resume without turning a
 * leaked process id into an ambient terminal capability.
 */
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { AGENT_ROLES, defineTool } from '@papercusp/agent-mcp';
import {
  getPtyByTaskId,
  getScreenSerialization,
  killPty,
  resizePty,
  spawnGovernedPty,
  writePty,
  type PtyHandle,
} from '../../pty-bridge';
import { localPtyHostId, type PtyAccessScope } from '../../pty-ticket';
import { callOwnerProcess, registerOwnerRpcHandler } from '../../cluster-owner-rpc';
import {
  beginSyncEnrolment,
  completeSyncEnrolment,
  finishSyncEnrolment,
  syncEnrolmentScopePath,
} from '../../task-manager/enroll-sync';
import { killTask } from '../../task-manager/control';
import { getTask } from '../../task-manager/store';
import { isTerminalState, type TaskRow } from '../../task-manager/types';
import { resolveConcreteHarnessSlug } from '../_harness-scope';
import { resolveAgentIdentity, type ResolveIdentityCtx } from '../coordination/identity';
import { resolveCapabilityBaseDir } from './base-dir';
import { scrubExecEnv } from './exec-sandbox';

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MAX_STDIN_CHARS = 1_000_000;
const PTY_TASK_ID_ENV = 'PAPERCUSP_PTY_TASK_ID';

/**
 * `defineTool`'s legacy compatibility overload can supply either context shape.
 * Keep the PTY helpers structural: these are the only optional fields they read,
 * and both the principal-gated and unified contexts satisfy this contract.
 */
type PtyToolContext = ResolveIdentityCtx & { projectDir?: string };

type CallerScope = {
  ownerId: string;
  workspaceId: string;
  harnessSlug: string;
  accessScope: PtyAccessScope;
};

type Attachment = {
  task: TaskRow;
  handle: PtyHandle;
  caller: CallerScope;
};

function errorResult(reason: string, extra: Record<string, unknown> = {}) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, reason, ...extra }) }],
    isError: true,
  };
}

function callerScope(ctx: PtyToolContext): CallerScope | null {
  const identity = resolveAgentIdentity(ctx);
  const workspaceId = identity.workspaceId?.trim();
  const harnessSlug = resolveConcreteHarnessSlug(undefined, ctx);
  if (!workspaceId || workspaceId === '*' || !harnessSlug) return null;
  return {
    ownerId: identity.ownerId,
    workspaceId,
    harnessSlug,
    accessScope: {
      tenantId: workspaceId,
      workspaceId,
      harnessSlug,
      hostId: localPtyHostId(),
      principalId: identity.ownerId,
    },
  };
}

function unknownTask(taskId: string) {
  return errorResult('unknown_task_id', { task_id: taskId });
}

function taskBelongsToCaller(task: TaskRow, taskId: string, caller: CallerScope): boolean {
  const detail = task.detail ?? {};
  return (
    task.taskId === taskId &&
    task.class === 'pty' &&
    task.workspaceId === caller.workspaceId &&
    task.harnessSlug === caller.harnessSlug &&
    task.launchedBy === caller.ownerId &&
    detail.capabilityPty === true &&
    detail.principalId === caller.ownerId &&
    typeof detail.ptyHandleId === 'string' &&
    detail.ptyHandleId.length > 0
  );
}

async function attachTask(taskId: string, caller: CallerScope): Promise<
  | { ok: true; attachment: Attachment }
  | {
      ok: false;
      result: ReturnType<typeof errorResult>;
      task?: TaskRow;
      handleUnavailable?: boolean;
    }
> {
  let task: TaskRow | null;
  try {
    task = await getTask(taskId);
  } catch (error) {
    return {
      ok: false,
      result: errorResult('task_ledger_unavailable', {
        task_id: taskId,
        message: error instanceof Error ? error.message : String(error),
      }),
    };
  }

  // Deliberately collapse missing, malformed, and foreign rows. A caller must
  // not be able to enumerate another principal's live terminal sessions.
  if (!task || !taskBelongsToCaller(task, taskId, caller)) {
    return { ok: false, result: unknownTask(taskId) };
  }

  const handle = getPtyByTaskId(taskId, caller.accessScope);
  if (!handle || handle.id !== task.detail.ptyHandleId) {
    if (isTerminalState(task.state)) {
      return {
        ok: false,
        result: errorResult('pty_session_ended', {
          task_id: taskId,
          state: task.state,
          exit_code: task.exitCode,
          exit_reason: task.exitReason,
          reattachment: 'not_applicable',
          replacement_started: false,
          advice: 'The PTY has ended. Inspect the terminal outcome above; open a new PTY only if more interactive work is required.',
        }),
      };
    }
    return {
      ok: false,
      result: errorResult('pty_session_unavailable', {
        task_id: taskId,
        state: task.state,
        reattachment: 'unrecoverable',
        restart_required: true,
        replacement_started: false,
        advice:
          'The authorized ledger row is still live, but its process-local PTY handle was lost (for example by an operator restart). This session cannot be reattached; open a new capability:pty_open session. No replacement was started automatically.',
      }),
      task,
      handleUnavailable: true,
    };
  }

  return { ok: true, attachment: { task, handle, caller } };
}

// ── Follow-up operations, cluster-safe (WI-10003626) ──────────────────────────
//
// The PTY master fd lives in the ONE process that opened it. Under `node:cluster`
// the kernel spreads an agent's follow-up calls across every worker, so the worker
// that receives a write/resize/read/kill is usually NOT the owner. The owner pid
// is recorded on the durable task row at open; a non-owner forwards the operation
// through the primary (cluster-owner-rpc) and the owner executes it locally.

type PtyOp =
  | { op: 'write'; task_id: string; data: string }
  | { op: 'resize'; task_id: string; cols: number; rows: number }
  | { op: 'read'; task_id: string }
  | { op: 'kill'; task_id: string };

type PtyTextResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
type PtyScreenResult = {
  content: Array<{ type: 'resource'; resource: { uri: string; mimeType: string; text: string } }>;
  _meta: { pty: { task_id: string; encoding: 'utf-8'; cols: number; rows: number } };
};
type PtyToolResult = PtyTextResult | PtyScreenResult;

export const CAPABILITY_PTY_RPC_KIND = 'capability-pty';

function okResult(body: Record<string, unknown>): PtyToolResult {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, ...body }) }] };
}

async function runLocalPtyOp(op: PtyOp, attachment: Attachment): Promise<PtyToolResult> {
  const { handle, caller } = attachment;
  switch (op.op) {
    case 'write':
      if (!writePty(handle.id, Buffer.from(op.data, 'utf8'), caller.accessScope)) {
        return errorResult('pty_session_unavailable', { task_id: op.task_id });
      }
      return okResult({ task_id: op.task_id, bytes_written: Buffer.byteLength(op.data, 'utf8') });
    case 'resize':
      if (!resizePty(handle.id, op.cols, op.rows, caller.accessScope)) {
        return errorResult('pty_session_unavailable', { task_id: op.task_id });
      }
      return okResult({ task_id: op.task_id, cols: op.cols, rows: op.rows });
    case 'read': {
      const screen = await getScreenSerialization(handle.id, caller.accessScope);
      if (screen === null) return errorResult('pty_session_unavailable', { task_id: op.task_id });
      const cols = handle.headless.cols;
      const rows = handle.headless.rows;
      return {
        // D-006: screen state remains a distinct, non-text medium without
        // inventing a protocol variant. MCP already provides embedded resources;
        // the URI + metadata carry identity/geometry while resource.text carries
        // the bounded ANSI serialization accepted by every conforming client.
        content: [
          {
            type: 'resource' as const,
            resource: {
              uri: `papercusp://pty/${encodeURIComponent(op.task_id)}/screen?cols=${cols}&rows=${rows}`,
              mimeType: 'application/x-papercusp-pty-screen+ansi',
              text: screen,
            },
          },
        ],
        _meta: { pty: { task_id: op.task_id, encoding: 'utf-8' as const, cols, rows } },
      };
    }
    case 'kill':
      if (!killPty(handle.id, caller.accessScope)) {
        return errorResult('pty_session_unavailable', { task_id: op.task_id });
      }
      return okResult({ task_id: op.task_id, killed: true });
  }
}

function ptyOwnerOf(task: TaskRow): { pid: number; hostId: string } | null {
  const detail = (task.detail ?? {}) as Record<string, unknown>;
  const pid = detail.ptyOwnerPid;
  const hostId = detail.ptyOwnerHostId;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof hostId !== 'string' || hostId.length === 0) return null;
  return { pid, hostId };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists under another user — alive for our purposes.
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/** Existing cgroup/verified-pid control path, rendered as a pty_kill result. */
async function killViaTaskManager(taskId: string, extra: Record<string, unknown> = {}): Promise<PtyToolResult> {
  const outcome = await killTask(taskId);
  const payload = outcome.ok
    ? { ok: true, task_id: taskId, killed: true, via: 'task-manager', ...extra, ...(outcome.detail ? { detail: outcome.detail } : {}) }
    : { ok: false, task_id: taskId, reason: outcome.error, via: 'task-manager', ...extra, ...(outcome.detail ? { detail: outcome.detail } : {}) };
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }], isError: !outcome.ok };
}

/**
 * The process that held this PTY is gone, so its master fd — and with it the
 * session — is gone too. Settle the durable row (it would otherwise read
 * `running` forever, since the exit callback died with the owner) and say so.
 */
async function settleOwnerGone(op: PtyOp, cause: string, ownerPid: number): Promise<PtyToolResult> {
  if (op.op === 'kill') return killViaTaskManager(op.task_id, { cause, owner_pid: ownerPid });
  const outcome = await killTask(op.task_id);
  return errorResult('pty_session_unavailable', {
    task_id: op.task_id,
    cause,
    owner_pid: ownerPid,
    reattachment: 'unrecoverable',
    ledger_settled: outcome.ok,
    ...(outcome.ok ? {} : { ledger_error: outcome.error }),
    replacement_started: false,
    advice:
      'The worker process that held this PTY has exited, so the terminal no longer exists. Its task row has been settled. Open a new capability:pty_open session; nothing was started automatically.',
  });
}

function isToolResult(value: unknown): value is PtyToolResult {
  return !!value && typeof value === 'object' && Array.isArray((value as PtyToolResult).content);
}

async function recoverFromOwner(
  op: PtyOp,
  caller: CallerScope,
  task: TaskRow,
  unavailable: PtyToolResult,
): Promise<PtyToolResult> {
  const owner = ptyOwnerOf(task);
  if (!owner || owner.pid === process.pid) {
    // A row opened before ownership was recorded, or one THIS process owns but no
    // longer holds a handle for: nobody else can serve it, so keep the
    // pre-existing contract (kill settles through the task manager).
    return op.op === 'kill' ? killViaTaskManager(op.task_id) : unavailable;
  }
  if (owner.hostId !== caller.accessScope.hostId) {
    // A different operator service owns it (the ledger is shared). Never reap a
    // session that may be alive elsewhere.
    return errorResult('pty_session_unavailable', {
      task_id: op.task_id,
      cause: 'owned_by_other_host',
      owner_host: owner.hostId,
      reattachment: 'route_to_owner_host',
      replacement_started: false,
      advice: `This PTY is held by operator host ${owner.hostId}; follow-up calls must reach that host.`,
    });
  }
  const outcome = await callOwnerProcess({
    targetPid: owner.pid,
    kind: CAPABILITY_PTY_RPC_KIND,
    payload: { op, caller },
  });
  if (outcome.ok) {
    return isToolResult(outcome.result)
      ? outcome.result
      : errorResult('pty_owner_protocol_error', { task_id: op.task_id, owner_pid: owner.pid });
  }
  if (outcome.code === 'owner_gone') return settleOwnerGone(op, 'owner_process_gone', owner.pid);
  if (outcome.code === 'not_clustered' && !pidAlive(owner.pid)) {
    // Single-process host that restarted since the PTY was opened.
    return settleOwnerGone(op, 'owner_process_restarted', owner.pid);
  }
  return errorResult('pty_owner_unreachable', {
    task_id: op.task_id,
    owner_pid: owner.pid,
    cause: outcome.code,
    message: outcome.message,
    reattachment: 'retry',
    replacement_started: false,
    advice:
      'The process holding this PTY is alive but did not answer. The session was not changed; retry the same call.',
  });
}

async function dispatchPtyOp(op: PtyOp, ctx: PtyToolContext): Promise<PtyToolResult> {
  const caller = callerScope(ctx);
  if (!caller) return errorResult('concrete_scope_required');
  const attached = await attachTask(op.task_id, caller);
  if (attached.ok) return runLocalPtyOp(op, attached.attachment);
  if (!attached.handleUnavailable || !attached.task) return attached.result;
  return recoverFromOwner(op, caller, attached.task, attached.result);
}

function parseForwardedPtyRequest(payload: unknown): { op: PtyOp; caller: CallerScope } | null {
  const p = payload as { op?: Partial<PtyOp> & Record<string, unknown>; caller?: Partial<CallerScope> } | null;
  const op = p?.op;
  const caller = p?.caller;
  if (!op || typeof op.task_id !== 'string' || !caller) return null;
  if (typeof caller.ownerId !== 'string' || typeof caller.workspaceId !== 'string') return null;
  if (typeof caller.harnessSlug !== 'string' || !caller.accessScope) return null;
  switch (op.op) {
    case 'write':
      if (typeof op.data !== 'string') return null;
      break;
    case 'resize':
      if (typeof op.cols !== 'number' || typeof op.rows !== 'number') return null;
      break;
    case 'read':
    case 'kill':
      break;
    default:
      return null;
  }
  return { op: op as PtyOp, caller: caller as CallerScope };
}

/**
 * OWNER side of the forward: re-authorize against the durable row with the
 * caller scope the receiving worker resolved, then execute locally. Never
 * forwards again, so a request cannot bounce between workers.
 */
export async function serveForwardedPtyOp(payload: unknown): Promise<PtyToolResult> {
  const request = parseForwardedPtyRequest(payload);
  if (!request) return errorResult('pty_owner_protocol_error');
  if (request.caller.accessScope.hostId !== localPtyHostId()) {
    return errorResult('pty_owner_protocol_error', { task_id: request.op.task_id, cause: 'host_mismatch' });
  }
  const attached = await attachTask(request.op.task_id, request.caller);
  if (!attached.ok) return attached.result;
  return runLocalPtyOp(request.op, attached.attachment);
}

registerOwnerRpcHandler(CAPABILITY_PTY_RPC_KIND, serveForwardedPtyOp);

const commonTool = {
  capability: 'capability:bash',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...AGENT_ROLES],
} as const;

export const ptyOpenTool = defineTool({
  name: 'capability:pty_open',
  description:
    'Open a persistent interactive PTY session in the project directory. Returns only a durable task_id; use the PTY follow-up tools to write, resize, read the bounded screen state, or kill it.',
  guidance: {
    when: 'Run an interactive shell, REPL, debugger, or TUI that needs stdin and repeated screen reads.',
    notWhen: 'Use capability:bash for a non-interactive command or a background job whose append-only output is sufficient.',
    chaining:
      'capability:pty_open { command } → capability:pty_write_stdin { task_id, data } / capability:pty_resize { task_id, cols, rows } → capability:pty_read_screen { task_id } → capability:pty_kill { task_id }.',
    seeAlso: ['capability:bash (non-interactive shell execution)'],
  },
  ...commonTool,
  args: z.object({
    command: z.string().min(1).describe('Interactive command to run through `bash -lc`.'),
    cwd: z
      .string()
      .optional()
      .describe('Working directory (absolute, or relative to the project directory). Defaults to the project directory.'),
    cols: z.number().int().min(2).max(400).optional().describe(`Initial terminal columns (default ${DEFAULT_COLS}).`),
    rows: z.number().int().min(1).max(200).optional().describe(`Initial terminal rows (default ${DEFAULT_ROWS}).`),
  }),
  async handler(args, ctx: PtyToolContext) {
    const caller = callerScope(ctx);
    if (!caller) return errorResult('concrete_scope_required');

    const baseDir = resolveCapabilityBaseDir(ctx);
    const cwd = args.cwd ? (isAbsolute(args.cwd) ? args.cwd : resolve(baseDir, args.cwd)) : baseDir;
    const childEnv = scrubExecEnv(process.env);
    const enrolment = beginSyncEnrolment({ class: 'pty' });

    // The ledger + cgroup boundary is the security/replayability contract for
    // this capability. Unlike legacy best-effort spawn seams, PTY open fails
    // closed when either half is unavailable.
    if (!enrolment.enrolled) {
      return errorResult('task_manager_required', {
        advice: 'Interactive capability sessions require task-ledger enrolment.',
      });
    }
    if (!enrolment.confined) {
      return errorResult('pty_confinement_unavailable', {
        unconfined_reason: enrolment.unconfinedReason,
        advice: 'Retry after task-manager scope support is ready; no PTY was spawned.',
      });
    }

    childEnv[PTY_TASK_ID_ENV] = enrolment.taskId;
    const wrapped = enrolment.wrap('bash', ['-lc', args.command], childEnv);
    const scopeCgroupPath = syncEnrolmentScopePath(enrolment, 'pty');

    let handle: PtyHandle;
    try {
      handle = await spawnGovernedPty({
        accessScope: caller.accessScope,
        command: wrapped.binary,
        args: wrapped.argv,
        cwd,
        env: childEnv,
        inheritEnv: false,
        taskId: enrolment.taskId,
        cols: args.cols ?? DEFAULT_COLS,
        rows: args.rows ?? DEFAULT_ROWS,
      }, {
        workspaceId: caller.workspaceId,
        idempotencyKey: `capability-pty:${enrolment.taskId}`,
        owner: caller.ownerId,
        payloadRef: `task:${enrolment.taskId}`,
      });
    } catch (error) {
      return errorResult('pty_spawn_failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }

    completeSyncEnrolment(
      enrolment,
      {
        class: 'pty',
        title: args.command.slice(0, 300),
        argv: ['bash', '-lc', args.command],
        cwd,
        launchedBy: caller.ownerId,
        harnessSlug: caller.harnessSlug,
        sessionId: caller.ownerId,
        detail: {
          capabilityPty: true,
          ptyHandleId: handle.id,
          principalId: caller.ownerId,
          // WI-10003626: the PTY master lives in THIS process only. Recording the
          // owner lets a sibling cluster worker forward follow-up calls here, and
          // lets anyone tell "owner gone" (unrecoverable) from "owner elsewhere".
          ptyOwnerPid: process.pid,
          ptyOwnerHostId: caller.accessScope.hostId,
          cols: args.cols ?? DEFAULT_COLS,
          rows: args.rows ?? DEFAULT_ROWS,
        },
      },
      handle.pty.pid ?? null,
      { workspaceId: caller.workspaceId },
    );

    let finished = false;
    const finish = (exitCode: number | null, signal: number): void => {
      if (finished) return;
      finished = true;
      finishSyncEnrolment(
        enrolment,
        {
          state: signal > 0 ? 'killed' : 'exited',
          exitCode,
          exitReason: signal > 0 ? `pty exited on signal ${signal}` : null,
        },
        { scopeCgroupPath },
      );
    };
    handle.onExit.add((code, signal) => finish(code, signal));
    if (handle.killed) finish(handle.exitCode, 0);

    // The sync spawn seam writes asynchronously, but this model-facing open
    // must not return a durable id before its authorization row exists. That
    // prevents an immediate write/read call from racing registration.
    try {
      await enrolment.registrationReady;
    } catch (error) {
      killPty(handle.id, caller.accessScope);
      return errorResult('task_enrollment_failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            task_id: enrolment.taskId,
            confined: true,
            cols: args.cols ?? DEFAULT_COLS,
            rows: args.rows ?? DEFAULT_ROWS,
          }),
        },
      ],
    };
  },
});

export const ptyWriteStdinTool = defineTool({
  name: 'capability:pty_write_stdin',
  description: 'Write UTF-8 input to an interactive PTY session using its durable task_id.',
  guidance: {
    when: 'Send keystrokes, a command, or a control sequence to a session opened by capability:pty_open.',
    notWhen: 'Never pass a process id, PTY id, name, or pattern; this tool accepts only the durable task_id handle.',
    chaining: 'Follow with capability:pty_read_screen { task_id } to observe the resulting terminal state.',
    seeAlso: ['capability:pty_open', 'capability:pty_read_screen'],
  },
  ...commonTool,
  args: z.object({
    task_id: z.string().min(1).describe('Durable task id returned by capability:pty_open.'),
    data: z.string().max(MAX_STDIN_CHARS).describe('UTF-8 data/keystrokes to write. Include `\n` to submit a line.'),
  }),
  async handler(args, ctx: PtyToolContext) {
    return dispatchPtyOp({ op: 'write', task_id: args.task_id, data: args.data }, ctx);
  },
});

export const ptyResizeTool = defineTool({
  name: 'capability:pty_resize',
  description:
    'Resize a running interactive PTY by its durable task_id. Updates both the child terminal and the bounded headless screen geometry without ending or replacing the session.',
  guidance: {
    when: 'A shell, debugger, or TUI opened by capability:pty_open needs a different terminal width or height.',
    notWhen: 'Do not pass a process id or raw PTY id. A terminal session that ended or lost its server-side handle cannot be revived by resizing it.',
    chaining: 'capability:pty_resize { task_id, cols, rows } → capability:pty_read_screen { task_id }.',
    seeAlso: ['capability:pty_open', 'capability:pty_read_screen'],
  },
  ...commonTool,
  args: z.object({
    task_id: z.string().min(1).describe('Durable task id returned by capability:pty_open.'),
    cols: z.number().int().min(2).max(400).describe('New terminal width in columns.'),
    rows: z.number().int().min(1).max(200).describe('New terminal height in rows.'),
  }),
  async handler(args, ctx: PtyToolContext) {
    return dispatchPtyOp({ op: 'resize', task_id: args.task_id, cols: args.cols, rows: args.rows }, ctx);
  },
});

export const ptyReadScreenTool = defineTool({
  name: 'capability:pty_read_screen',
  description:
    'Read the bounded ANSI screen state of an interactive PTY session using its durable task_id. Returns a standard MCP embedded resource so the shared result-door accounts and envelopes it as non-text content.',
  guidance: {
    when: 'Inspect the current screen of a session opened by capability:pty_open, including TUIs that redraw in place.',
    notWhen: 'Use capability:bash_output for append-only output from a capability:bash background job.',
    chaining:
      'Write more input with capability:pty_write_stdin, change geometry with capability:pty_resize, or stop the session with capability:pty_kill.',
    seeAlso: ['capability:pty_write_stdin', 'capability:pty_resize', 'capability:pty_kill'],
  },
  ...commonTool,
  args: z.object({
    task_id: z.string().min(1).describe('Durable task id returned by capability:pty_open.'),
  }),
  async handler(args, ctx: PtyToolContext) {
    return dispatchPtyOp({ op: 'read', task_id: args.task_id }, ctx);
  },
});

export const ptyKillTool = defineTool({
  name: 'capability:pty_kill',
  description: 'Kill an interactive PTY session by its durable task_id. Names, patterns, PIDs, and raw PTY ids are not accepted.',
  guidance: {
    when: 'Stop a session opened by capability:pty_open once it is no longer needed.',
    notWhen: 'Do not kill by process name/pattern. The task_id is the only accepted authority-bearing handle.',
    chaining: 'A successful call ends the task-ledger entry through the PTY exit hook.',
    seeAlso: ['capability:pty_open', 'processes:kill (managed task control)'],
  },
  ...commonTool,
  args: z.object({
    task_id: z.string().min(1).describe('Durable task id returned by capability:pty_open.'),
  }),
  async handler(args, ctx: PtyToolContext) {
    // The PTY handle is process-local, but the task ledger is durable. When this
    // process does not hold the handle, dispatchPtyOp forwards the kill to the
    // owning worker, and falls back to `killTask` (the cgroup/verified-pid control
    // path) only after attachTask has authenticated and classified this exact
    // caller-owned live row AND its owner is gone or unrecorded. Never for
    // foreign, malformed, or already-terminal rows.
    return dispatchPtyOp({ op: 'kill', task_id: args.task_id }, ctx);
  },
});
