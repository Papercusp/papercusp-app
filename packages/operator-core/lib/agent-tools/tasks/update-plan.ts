/** Codex update_plan-shaped facade over the canonical tasks:ops store. */
import { z } from 'zod';
import { AGENT_ROLES, defineTool } from '@papercusp/agent-mcp';
import {
  applySessionTaskSnapshot,
  MODEL_TASK_STATUSES,
  type ModelTaskStatus,
} from '../../session-task-aliases';
import type { SessionTask } from '../../session-tasks';
import type { PapercuspUnifiedToolContext } from '../_tool-context';
import {
  createSessionTaskLedgerBridge,
  emitSessionTaskChanges,
  resolveSessionTaskRuntime,
  sessionTaskOpSchema,
  taskToolText,
  validationErrorResponse,
  workspaceRequiredResponse,
} from './runtime';

const nativeStatusSchema = z.enum(MODEL_TASK_STATUSES);
const argsSchema = z.object({
  explanation: z.string().min(1).max(2_000).optional(),
  plan: z.array(z.object({
    step: z.string().min(1).max(4_000),
    status: nativeStatusSchema,
  }).strict()).max(100),
}).strict();

function nativeStatus(status: SessionTask['status']): ModelTaskStatus {
  if (status === 'pending' || status === 'in_progress' || status === 'completed') return status;
  throw new Error(`tasks:update_plan produced non-native canonical status: ${status}`);
}

export default defineTool({
  name: 'tasks:update_plan',
  profile: 'engineer',
  description:
    'Codex update_plan-shaped whole-list facade over this chat session\'s canonical PG-backed task list.',
  capability: 'tasks:write',
  guidance: {
    when: 'You are a Codex-family model updating the concrete ordered execution plan for this chat. Send the complete current plan on every call.',
    notWhen: 'Do not use this as the durable shared project plan; use plans:* and work_items:* for fleet-visible coordination.',
    chaining: 'Replace the list as steps change and optionally explain the update. At most one step may be in_progress.',
  },
  requirePrincipal: false,
  needsWorkspaceTx: true,
  agentRoles: [...AGENT_ROLES],
  events: {
    tasks_changed: z.object({
      sessionId: z.string(),
      op: sessionTaskOpSchema,
      changedTaskId: z.string().nullable(),
    }),
  },
  args: argsSchema,
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    const runtime = await resolveSessionTaskRuntime(ctx);
    if (!runtime) return workspaceRequiredResponse('tasks:update_plan');
    try {
      const bridge = await createSessionTaskLedgerBridge({
        workspaceId: runtime.workspaceId,
        sessionId: runtime.sessionId,
        actorId: runtime.actorId,
        claimOwnerId: runtime.claimOwnerId,
        defaultHarness: runtime.defaultHarness,
        sql: runtime.tx,
      });
      const result = await applySessionTaskSnapshot(runtime.tx, {
        workspaceId: runtime.workspaceId,
        sessionId: runtime.sessionId,
        explanation: args.explanation,
        tasks: args.plan.map((step) => ({
          content: step.step,
          activeForm: step.step,
          status: step.status,
        })),
        bridge,
        idFactory: runtime.idFactory,
      });
      emitSessionTaskChanges(ctx, runtime.sessionId, result.mutations);
      return taskToolText({
        ok: true,
        sessionId: runtime.sessionId,
        ...(args.explanation ? { explanation: args.explanation } : {}),
        plan: result.tasks.map((task) => ({
          step: task.content,
          status: nativeStatus(task.status),
        })),
      });
    } catch (error) {
      const failure = validationErrorResponse(error);
      if (failure) return failure;
      throw error;
    }
  },
});
