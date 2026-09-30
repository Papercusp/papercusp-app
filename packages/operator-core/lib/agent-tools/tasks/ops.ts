/**
 * tasks:ops — canonical per-chat task list owned by the Papercusp loop.
 *
 * Models submit one compact operation; the harness owns the complete list in
 * PG. Model-family facades (TodoWrite/update_plan) translate into this tool
 * rather than storing parallel task state.
 */
import { z } from 'zod';
import { AGENT_ROLES, defineTool } from '@papercusp/agent-mcp';
import { applySessionTaskOp } from '../../session-tasks';
import type { PapercuspUnifiedToolContext } from '../_tool-context';
import {
  createSessionTaskLedgerBridge,
  emitSessionTaskChanges,
  resolveSessionTaskRuntime,
  sessionTaskLinkRelationSchema,
  sessionTaskOpSchema,
  sessionTaskStatusSchema,
  taskToolText,
  validationErrorResponse,
  workspaceRequiredResponse,
} from './runtime';

const seedSchema = z
  .object({
  id: z.string().min(1).max(160).optional(),
  content: z.string().min(1).max(4_000),
  activeForm: z.string().min(1).max(500).optional(),
  status: sessionTaskStatusSchema.optional(),
  blocker_ref: z.string().min(1).max(2_000).optional(),
  })
  .strict();

const argsSchema = z
  .object({
  op: sessionTaskOpSchema.optional(),
  tasks: z.array(seedSchema).max(100).optional(),
  task_id: z.string().min(1).max(160).optional(),
  content: z.string().min(1).max(4_000).optional(),
  activeForm: z.string().min(1).max(500).optional(),
  blocker_ref: z.string().min(1).max(2_000).optional(),
    expected_updated_at: z.string().min(1).max(100).optional(),
    position: z.number().int().min(0).optional(),
  explanation: z.string().min(1).max(2_000).optional(),
  work_item_id: z.string().min(1).max(240).optional(),
  work_item_harness: z.string().min(1).max(240).optional(),
  relation: sessionTaskLinkRelationSchema.optional(),
  work_item_kind: z.string().min(1).max(80).optional(),
  work_item_title: z.string().min(1).max(4_000).optional(),
  work_item_summary: z.string().min(1).max(20_000).optional(),
  })
  .strict();

export default defineTool({
  name: 'tasks:ops',
  profile: 'engineer',
  description:
    'Operate the canonical task list for this chat session. One compact op updates PG-backed state; the response always returns the complete ordered list.',
  capability: 'tasks:write',
  guidance: {
    when: 'Track or update the concrete steps you are executing in this chat. Use init/append/start/done/drop/block/unblock/reopen/edit/reorder, link/unlink for typed work-item edges, promote to mint a work-item plus its `for` edge, and view to read the full list.',
    notWhen:
      'Do not use this to create fleet/work coordination items; use work_items:* or plans:* for durable shared work. This list is per chat session.',
    chaining:
      'init or append → start → done; block requires blocker_ref; reorder requires position. Pass expected_updated_at for optimistic owner-style edits. A task has at most one checkpoint-sync `for` edge and any number of informational `relates` edges. Completion never propagates across an edge. Omit op only for unambiguous init/append/block/view shapes.',
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
    if (!runtime) return workspaceRequiredResponse('tasks:ops');
    try {
      const bridge = await createSessionTaskLedgerBridge({
        workspaceId: runtime.workspaceId,
        sessionId: runtime.sessionId,
        actorId: runtime.actorId,
        claimOwnerId: runtime.claimOwnerId,
        defaultHarness: runtime.defaultHarness,
        sql: runtime.tx,
      });
      const result = await applySessionTaskOp(runtime.tx, {
        workspaceId: runtime.workspaceId,
        sessionId: runtime.sessionId,
        op: args.op,
        tasks: args.tasks?.map((task) => ({
          id: task.id,
          content: task.content,
          activeForm: task.activeForm,
          status: task.status,
          blockerRef: task.blocker_ref,
        })),
        taskId: args.task_id,
        content: args.content,
        activeForm: args.activeForm,
        blockerRef: args.blocker_ref,
        expectedUpdatedAt: args.expected_updated_at,
        position: args.position,
        explanation: args.explanation,
        workItemId: args.work_item_id,
        workItemHarness: args.work_item_harness,
        relation: args.relation,
        workItemKind: args.work_item_kind,
        workItemTitle: args.work_item_title,
        workItemSummary: args.work_item_summary,
        bridge,
        idFactory: runtime.idFactory,
      });

      if (result.op !== 'view') emitSessionTaskChanges(ctx, runtime.sessionId, [result]);

      return taskToolText({
        ok: true,
        sessionId: runtime.sessionId,
        op: result.op,
        ...(result.changedTaskId ? { changedTaskId: result.changedTaskId } : {}),
        tasks: result.tasks,
        links: result.links,
        ...(result.bridgeWarnings ? { warnings: result.bridgeWarnings } : {}),
      });
    } catch (error) {
      const failure = validationErrorResponse(error);
      if (failure) return failure;
      throw error;
    }
  },
});
