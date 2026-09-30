/**
 * capability:bash_kill — stop a background shell job started by `capability:bash`
 * (run_in_background). Mirrors the native KillShell tool: SIGTERM, then SIGKILL
 * after a short grace period. Part of P-010 (`agent-capability-confinement-2026-06-13`).
 */

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { defineTool, AGENT_ROLES, type UnifiedToolContext } from '@papercusp/agent-mcp';
import { killTask } from '../../task-manager/control';
import { getTask, getTaskByBashJobId } from '../../task-manager/store';
import { getJob, killJob, readJobOutput } from './bash-jobs';

const DURABLE_TAIL_BYTES = 2_000;

function workspaceIdForContext(
  ctx: Pick<UnifiedToolContext, 'workspaceId' | 'principal'>,
): string | undefined {
  if (ctx.workspaceId && ctx.workspaceId !== '*') return ctx.workspaceId;
  if (ctx.principal?.workspaceId && ctx.principal.workspaceId !== '*') return ctx.principal.workspaceId;
  return undefined;
}

function durableTail(logPath: string | null | undefined): string {
  if (!logPath) return '';
  try {
    const output = readFileSync(logPath, 'utf8');
    return output.length > DURABLE_TAIL_BYTES ? output.slice(-DURABLE_TAIL_BYTES) : output;
  } catch {
    return '';
  }
}

function errorResult(payload: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, ...payload }) }],
    isError: true,
  };
}

export default defineTool({
  name: 'capability:bash_kill',
  description:
    'Stop a background shell job (started by capability:bash run_in_background:true). Accepts its process-local bash_id or durable task_id, so a successor can kill it after carry. Sends SIGTERM then SIGKILL. Returns the final tail of output.',
  guidance: {
    when: 'Stop a background job you no longer need (a dev server, a runaway build).',
    notWhen: 'A job that already finished — capability:bash_output already shows its terminal status.',
    chaining:
      'capability:bash { run_in_background:true } → capability:bash_output { task_id } after carry → capability:bash_kill { task_id }.',
    seeAlso: [
      'capability:bash (start the command)',
      'capability:bash_output (read its output first)',
    ],
  },
  capability: 'capability:bash',
  requirePrincipal: false,
  // Durable attachment reads the task ledger outside the ambient request
  // transaction, matching capability:bash_output's carry-safe lookup path.
  skipWorkspaceTx: true,
  agentRoles: [...AGENT_ROLES],
  args: z
    .object({
      bash_id: z
        .string()
        .min(1)
        .optional()
        .describe('The process-local id returned by capability:bash (run_in_background). Use only in the launching context.'),
      task_id: z
        .string()
        .min(1)
        .optional()
        .describe('The durable task id returned by capability:bash. Preferred after compaction/carry.'),
    })
    .superRefine((args, refinementCtx) => {
      // EI-21240465530065342 (same defect as bash_output): capability:bash
      // returns BOTH ids, so sending both back is the natural call — and the
      // worker-local JOBS map makes the durable handle the one that actually
      // resolves. Only a call with NO handle is a real caller error; two
      // handles that disagree are adjudicated in the handler against the
      // ledger, which matters more here than for a read: resolving the wrong
      // handle would kill the wrong job.
      if (!args.bash_id && !args.task_id) {
        refinementCtx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Pass at least one of bash_id or task_id.',
          path: ['bash_id'],
        });
      }
    }),
  async handler(args, ctx) {
    const workspaceId = workspaceIdForContext(ctx);
    let bashId = args.bash_id;
    let attachedLedgerRow: Awaited<ReturnType<typeof getTask>> = null;

    if (args.task_id) {
      if (!workspaceId) {
        return errorResult({
          reason: 'workspace_scope_required',
          task_id: args.task_id,
          advice: 'A concrete workspace scope is required to attach by durable task_id.',
        });
      }
      try {
        attachedLedgerRow = await getTask(args.task_id);
      } catch (err) {
        return errorResult({
          reason: 'task_ledger_unavailable',
          task_id: args.task_id,
          advice: `Could not read the durable task ledger; the job was NOT killed. Retry attachment (${err instanceof Error ? err.message : String(err)}).`,
        });
      }
      if (!attachedLedgerRow || attachedLedgerRow.workspaceId !== workspaceId) {
        return errorResult({
          reason: 'unknown_task_id',
          task_id: args.task_id,
          advice: 'No managed background shell job with this task_id exists in the current workspace. The job was NOT killed.',
        });
      }
      const durableBashId = attachedLedgerRow.detail?.bashJobId;
      if (attachedLedgerRow.class !== 'bash-job' || typeof durableBashId !== 'string' || durableBashId.length === 0) {
        return errorResult({
          reason: 'task_not_attachable',
          task_id: args.task_id,
          advice: 'This task is not a capability:bash background job with a durable bash handle. It was NOT killed.',
        });
      }
      // Both handles supplied: task_id is authoritative. A bash_id naming a
      // DIFFERENT job means the caller is confused about which job it is
      // stopping, so refuse instead of resolving — killing the task_id job
      // under a bash_id the caller trusts is an unrecoverable wrong action.
      if (args.bash_id && args.bash_id !== durableBashId) {
        return errorResult({
          reason: 'handle_mismatch',
          task_id: args.task_id,
          bash_id: args.bash_id,
          durable_bash_id: durableBashId,
          advice:
            'bash_id and task_id identify DIFFERENT jobs. NOTHING was killed. Send task_id alone (the durable handle, correct after a carry or across operator workers), or bash_id alone to stop the process-local job in its launching context.',
        });
      }
      bashId = durableBashId;
    }

    if (!bashId) return errorResult({ reason: 'missing_job_handle' });

    const job = getJob(bashId);
    if (!job) {
      // The JOBS map is worker-local and is intentionally allowed to disappear
      // across a cold carry or operator restart. Resolve the durable ledger row
      // and use the task-manager cgroup/pid safety rails instead of reporting a
      // live job as an unknown id (or starting a replacement).
      let ledgerRow = attachedLedgerRow;
      if (!ledgerRow) {
        try {
          ledgerRow = await getTaskByBashJobId(bashId, workspaceId ? { workspaceId } : {});
        } catch (err) {
          return errorResult({
            bash_id: bashId,
            reason: 'task_ledger_unavailable',
            advice: `Could not read the durable task ledger; the job was NOT killed. Retry attachment (${err instanceof Error ? err.message : String(err)}).`,
          });
        }
      }
      if (!ledgerRow || (workspaceId && ledgerRow.workspaceId !== workspaceId)) {
        return errorResult({
          bash_id: bashId,
          reason: 'unknown_bash_id',
          advice: 'No durable task-ledger record is available for this background job. The job was NOT killed; verify the id and retry.',
        });
      }
      if (ledgerRow.class !== 'bash-job' || ledgerRow.detail?.bashJobId !== bashId) {
        return errorResult({
          bash_id: bashId,
          task_id: ledgerRow.taskId,
          reason: 'task_not_attachable',
          advice: 'The durable ledger row is not an attachable capability:bash background job. The job was NOT killed.',
        });
      }

      const outcome = await killTask(ledgerRow.taskId);
      const payload = {
        ...outcome,
        bash_id: bashId,
        task_id: ledgerRow.taskId,
        ...(outcome.ok ? { already_done: false, status: 'killed' } : { reason: outcome.error }),
        ...(ledgerRow.logPath ? { log_path: ledgerRow.logPath } : {}),
        tail: durableTail(ledgerRow.logPath),
      };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
        isError: !outcome.ok,
      };
    }
    void ctx;
    const r = killJob(job);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            bash_id: job.id,
            ...(job.taskId ? { task_id: job.taskId } : {}),
            already_done: r.alreadyDone,
            status: job.status,
            exit_code: job.exitCode,
            tail: readJobOutput(job, true).slice(-2000),
          }),
        },
      ],
    };
  },
});
