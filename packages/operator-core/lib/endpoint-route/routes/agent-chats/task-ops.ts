import { randomUUID } from 'node:crypto';
import { defineTool } from '@papercusp/agent-mcp';
import { withWorkspace } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../../workspace-registry';
import { getSessionUserOrLocalDefault } from '../../session-or-local';
import {
  readConversationContextProjection,
  type ConversationContextProjection,
} from '../../../conversation-context-projection';
import {
  acquireSessionTaskLock,
  applySessionTaskOp,
  SessionTaskValidationError,
  type SessionTask,
  type SessionTaskBridge,
  type SessionTaskOp,
  type SessionTaskResult,
} from '../../../session-tasks';
import { createSessionTaskLedgerBridge } from '../../../agent-tools/tasks/runtime';

export const AGENT_CHAT_TASK_ACTIONS = [
  'add',
  'edit',
  'start',
  'check',
  'drop',
  'block',
  'clear_blocker',
  'reopen',
  'move_up',
  'move_down',
  'promote',
] as const;

export type AgentChatTaskAction = (typeof AGENT_CHAT_TASK_ACTIONS)[number];

export interface AgentChatTaskMutationInput {
  workspaceId: string;
  harness: string;
  sessionId: string;
  actorId: string;
  action: AgentChatTaskAction;
  taskId?: string;
  content?: string;
  activeForm?: string;
  blockerRef?: string;
  expectedUpdatedAt?: string;
  explanation?: string;
}

interface AgentChatTaskMutationDeps {
  readProjection: (args: {
    workspaceId: string;
    sourceKind: string;
    sessionId: string;
    harness?: string;
  }) => Promise<ConversationContextProjection | null>;
  withWorkspace: <T>(workspaceId: string, run: (sql: any) => Promise<T>) => Promise<T>;
  applyOp: typeof applySessionTaskOp;
  acquireLock: typeof acquireSessionTaskLock;
  createLedgerBridge: (args: {
    workspaceId: string;
    sessionId: string;
    actorId: string;
    defaultHarness?: string;
    sql?: any;
  }) => SessionTaskBridge | Promise<SessionTaskBridge>;
  idFactory: () => string;
}

const DEFAULT_DEPS: AgentChatTaskMutationDeps = {
  readProjection: readConversationContextProjection,
  withWorkspace,
  applyOp: applySessionTaskOp,
  acquireLock: acquireSessionTaskLock,
  createLedgerBridge: createSessionTaskLedgerBridge,
  idFactory: () => `task-${randomUUID()}`,
};

export class AgentChatTaskMutationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AgentChatTaskMutationError';
  }
}

function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AgentChatTaskMutationError(`${field}_required`, `\`${field}\` is required.`, 400);
  }
  const text = value.trim();
  if (text.length > max) {
    throw new AgentChatTaskMutationError(`${field}_too_long`, `\`${field}\` exceeds ${max} characters.`, 400);
  }
  return text;
}

function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  return requiredText(value, field, max);
}

function parseMutationBody(
  body: unknown,
): Omit<AgentChatTaskMutationInput, 'workspaceId' | 'harness' | 'sessionId' | 'actorId'> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AgentChatTaskMutationError('body_invalid', 'A JSON object body is required.', 400);
  }
  const raw = body as Record<string, unknown>;
  const action = raw.action;
  if (typeof action !== 'string' || !(AGENT_CHAT_TASK_ACTIONS as readonly string[]).includes(action)) {
    throw new AgentChatTaskMutationError(
      'action_invalid',
      `\`action\` must be one of ${AGENT_CHAT_TASK_ACTIONS.join('|')}.`,
      400,
    );
  }
  const parsed: Omit<AgentChatTaskMutationInput, 'workspaceId' | 'harness' | 'sessionId' | 'actorId'> = {
    action: action as AgentChatTaskAction,
    explanation: optionalText(raw.explanation, 'explanation', 2_000),
    expectedUpdatedAt: optionalText(raw.expectedUpdatedAt, 'expectedUpdatedAt', 100),
  };
  if (action === 'add' || action === 'edit') {
    parsed.content = requiredText(raw.content, 'content', 4_000);
    parsed.activeForm = optionalText(raw.activeForm, 'activeForm', 500);
  }
  if (action !== 'add') parsed.taskId = requiredText(raw.taskId, 'taskId', 160);
  if (action === 'block') parsed.blockerRef = requiredText(raw.blockerRef, 'blockerRef', 2_000);
  return parsed;
}

function taskById(tasks: SessionTask[], taskId: string): SessionTask {
  const task = tasks.find((candidate) => candidate.id === taskId);
  if (!task) {
    throw new AgentChatTaskMutationError('task_not_found', `Task \`${taskId}\` does not exist in this session.`, 404);
  }
  return task;
}

function isTypedBlocker(ref: string): boolean {
  return /^(lock|event|wi|plan):/.test(ref);
}

function canonicalOpFor(action: AgentChatTaskAction): SessionTaskOp {
  switch (action) {
    case 'add':
      return 'append';
    case 'edit':
      return 'edit';
    case 'start':
      return 'start';
    case 'check':
      return 'done';
    case 'drop':
      return 'drop';
    case 'block':
      return 'block';
    case 'clear_blocker':
      return 'unblock';
    case 'reopen':
      return 'reopen';
    case 'move_up':
    case 'move_down':
      return 'reorder';
    case 'promote':
      return 'promote';
  }
}

export async function mutateAgentChatTask(
  input: AgentChatTaskMutationInput,
  deps: AgentChatTaskMutationDeps = DEFAULT_DEPS,
): Promise<{
  action: AgentChatTaskAction;
  op: SessionTaskOp;
  changedTaskId: string | null;
  tasks: SessionTask[];
  projection: ConversationContextProjection;
}> {
  const before = await deps.readProjection({
    workspaceId: input.workspaceId,
    sourceKind: 'agent_chat',
    sessionId: input.sessionId,
    harness: input.harness,
  });
  if (!before) {
    throw new AgentChatTaskMutationError('session_not_found', 'Agent chat session not found.', 404);
  }
  if (!before.capabilities.taskWrite) {
    throw new AgentChatTaskMutationError(
      'task_write_unavailable',
      `Task writes are unavailable for capability tier ${before.session.capabilityTier}.`,
      409,
    );
  }

  const result = await deps.withWorkspace(input.workspaceId, async (sql) => {
    const bridge = await deps.createLedgerBridge({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      actorId: input.actorId,
      defaultHarness: input.harness,
      sql,
    });
    let position: number | undefined;
    if (input.action === 'clear_blocker' || input.action === 'move_up' || input.action === 'move_down') {
      await deps.acquireLock(sql, input.workspaceId, input.sessionId);
      const current = await deps.applyOp(sql, {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        op: 'view',
        idFactory: deps.idFactory,
      });
      const task = taskById(current.tasks, input.taskId!);
      if (input.action === 'clear_blocker') {
      if (!task.blockerRef) {
        throw new AgentChatTaskMutationError('task_not_blocked', 'The task has no blocker to clear.', 409);
      }
      if (isTypedBlocker(task.blockerRef)) {
        throw new AgentChatTaskMutationError(
          'typed_blocker_live',
          'Typed blockers clear from their source primitive; only free-text blockers can be cleared manually.',
          409,
        );
      }
      } else {
        position = task.position + (input.action === 'move_up' ? -1 : 1);
        if (position < 0 || position >= current.tasks.length) {
          throw new AgentChatTaskMutationError(
            'task_reorder_boundary',
            `Task is already at the ${input.action === 'move_up' ? 'top' : 'bottom'} of the list.`,
            409,
          );
        }
      }
    }

    return deps.applyOp(sql, {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      op: canonicalOpFor(input.action),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.content ? { content: input.content } : {}),
      ...(input.activeForm ? { activeForm: input.activeForm } : {}),
      ...(input.blockerRef ? { blockerRef: input.blockerRef } : {}),
      ...(input.expectedUpdatedAt ? { expectedUpdatedAt: input.expectedUpdatedAt } : {}),
      ...(position !== undefined ? { position } : {}),
      ...(input.explanation ? { explanation: input.explanation } : {}),
      bridge,
      idFactory: deps.idFactory,
    });
  });

  // session_tasks is a declared backing table for conversations.contextProjection;
  // its PG change trigger invalidates both GUI and pui subscribers. Re-read the
  // same projection so the initiating renderer can update immediately as well.
  const projection = await deps.readProjection({
    workspaceId: input.workspaceId,
    sourceKind: 'agent_chat',
    sessionId: input.sessionId,
    harness: input.harness,
  });
  if (!projection) {
    throw new AgentChatTaskMutationError(
      'projection_unavailable',
      'Task mutation succeeded but its conversation projection is unavailable.',
      500,
    );
  }
  return {
    action: input.action,
    op: result.op,
    changedTaskId: result.changedTaskId,
    tasks: result.tasks,
    projection,
  };
}

/**
 * Who performs an owner task mutation. A `loopback` route never carries an
 * endpoint principal for a local caller, and PUI and the desktop webview send
 * no session cookie. So, as for card responses (WI-5044), fall back to the
 * session user, then (loopback only) the seeded local default user.
 */
export async function taskMutationActor(
  req: Request,
  principalSlug: string | undefined,
  resolveUser: (req: Request) => Promise<{ username: string } | null> = getSessionUserOrLocalDefault,
): Promise<string | null> {
  if (principalSlug) return principalSlug;
  const user = await resolveUser(req);
  return user ? `user:${user.username}` : null;
}

export const taskOpsRoute = defineTool({
  method: 'POST',
  path: '/harness/:slug/agent-chats/:chatId/tasks',
  auth: 'loopback',
  async handler(req, ctx) {
    try {
      let raw: unknown;
      try {
        raw = await req.json();
      } catch {
        throw new AgentChatTaskMutationError('body_invalid', 'A valid JSON object body is required.', 400);
      }
      const body = parseMutationBody(raw);
      const actorId = await taskMutationActor(req, ctx.principal?.slug);
      if (!actorId) {
        throw new AgentChatTaskMutationError(
          'principal_required',
          'An authenticated endpoint principal is required for task mutations.',
          401,
        );
      }
      const result = await mutateAgentChatTask({
        workspaceId: activeWorkspaceId(),
        harness: ctx.params.slug,
        sessionId: ctx.params.chatId,
        actorId,
        ...body,
      });
      return Response.json({ ok: true, ...result });
    } catch (error) {
      if (error instanceof AgentChatTaskMutationError || error instanceof SessionTaskValidationError) {
        return Response.json(
          { error: { code: error.code, message: error.message } },
          {
            status:
              error instanceof AgentChatTaskMutationError
                ? error.status
                : error.code === 'task_revision_conflict'
                  ? 409
                  : 400,
          },
        );
      }
      throw error;
    }
  },
});
