/** Anthropic TodoWrite-shaped facade over the canonical tasks:ops store. */
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
  todos: z.array(z.object({
    content: z.string().min(1).max(4_000),
    activeForm: z.string().min(1).max(500),
    status: nativeStatusSchema,
  }).strict()).max(100),
}).strict();

function nativeStatus(status: SessionTask['status']): ModelTaskStatus {
  if (status === 'pending' || status === 'in_progress' || status === 'completed') return status;
  throw new Error(`tasks:todo_write produced non-native canonical status: ${status}`);
}

export default defineTool({
  name: 'tasks:todo_write',
  profile: 'engineer',
  description:
    'Anthropic TodoWrite-shaped whole-list facade over this chat session\'s canonical PG-backed task list.',
  capability: 'tasks:write',
  guidance: {
    when: 'You are an Anthropic-family model updating the concrete ordered task list for this chat. Send the complete current list on every call.',
    notWhen: 'Do not create fleet/work coordination items here; use work_items:* or plans:* for durable shared work.',
    chaining: 'Replace the list as work changes. Exactly one todo may be in_progress; the harness translates the snapshot into canonical task ops.',
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
    if (!runtime) return workspaceRequiredResponse('tasks:todo_write');
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
        tasks: args.todos,
        bridge,
        idFactory: runtime.idFactory,
      });
      emitSessionTaskChanges(ctx, runtime.sessionId, result.mutations);
      return taskToolText({
        ok: true,
        sessionId: runtime.sessionId,
        todos: result.tasks.map((task) => ({
          content: task.content,
          activeForm: task.activeForm,
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
