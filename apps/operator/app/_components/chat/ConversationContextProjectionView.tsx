'use client';

/**
 * GUI consumer for the shared conversation/context projection (P-009 / D-004).
 *
 * The operator GUI and pui deliberately receive the same server-normalized
 * frame union. This module may select/group those frames for React, but it must
 * never reconstruct tasks, context, approvals, or tool calls from their source
 * tables. The named query below is the one shared seam.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useSyncQuery } from '@papercusp/sync';
import type {
  ConversationApprovalFrame,
  ConversationContextProjection,
  ConversationContextSectionFrame,
  ConversationTaskFrame,
} from '@papercusp/operator-core/lib/conversation-context-projection';
import type { AgentChatTaskAction } from '@papercusp/operator-core/lib/endpoint-route/routes/agent-chats/task-ops';
import type { ChatMessage } from './chat-types';
import './conversation-context-projection.css';

export interface ConversationContextProjectionTarget {
  sourceKind: string;
  sessionId: string;
  harness?: string | null;
}

export interface ConversationTaskActionInput {
  action: AgentChatTaskAction;
  taskId?: string;
  content?: string;
  activeForm?: string;
  explanation?: string;
}

function isProjectionFor(
  value: ConversationContextProjection | undefined,
  target: ConversationContextProjectionTarget | null,
): value is ConversationContextProjection {
  return !!(
    value &&
    target &&
    value.schemaVersion === 'conversation-context-v1' &&
    value.session.sourceKind === target.sourceKind &&
    value.session.sessionId === target.sessionId
  );
}

/** Read the one canonical projection row. A missing row is an honest capability
 * degradation (not an error and never a cue to synthesize unavailable frames). */
export function useConversationContextProjection(
  target: ConversationContextProjectionTarget | null,
) {
  const query = useSyncQuery<ConversationContextProjection>({
    queryName: 'conversations.contextProjection',
    args: {
      sourceKind: target?.sourceKind ?? '',
      sessionId: target?.sessionId ?? '',
      ...(target?.harness ? { harness: target.harness } : {}),
    },
    enabled: !!target?.sourceKind && !!target?.sessionId,
    staleTime: 5_000,
  });
  const candidate = query.data?.[0];
  const targetKey = target
    ? `${target.sourceKind}\u0000${target.sessionId}\u0000${target.harness ?? ''}`
    : '';
  const serverProjection = isProjectionFor(candidate, target) ? candidate : null;
  const [accepted, setAccepted] = useState<{
    targetKey: string;
    projection: ConversationContextProjection;
    priorServerProjection: ConversationContextProjection | null;
  } | null>(null);
  const acceptProjection = useCallback((projection: ConversationContextProjection) => {
    if (!isProjectionFor(projection, target)) return;
    setAccepted({ targetKey, projection, priorServerProjection: serverProjection });
  }, [serverProjection, target, targetKey]);

  // A mutation response paints immediately. Once the subscription advances to
  // a new canonical row, hand authority straight back to the shared query.
  useEffect(() => {
    if (
      accepted &&
      accepted.targetKey === targetKey &&
      serverProjection !== accepted.priorServerProjection
    ) {
      setAccepted(null);
    }
  }, [accepted, serverProjection, targetKey]);

  return {
    ...query,
    projection: accepted?.targetKey === targetKey ? accepted.projection : serverProjection,
    acceptProjection,
  };
}

/** Convert only already-normalized conversational frames to the GUI's shared
 * chat renderer shape. Context/task/approval frames remain in the Context pane.
 * Tool frames become ChatToolCalls so OperatorChat's existing semantic-card
 * registry handles them; this module does not introduce another card registry. */
export function conversationProjectionMessages(
  projection: ConversationContextProjection | null,
): ChatMessage[] {
  if (!projection) return [];
  return projection.frames.flatMap<ChatMessage>((frame) => {
    switch (frame.kind) {
      case 'message':
        return [{
          id: frame.id,
          role: frame.role,
          content: frame.text,
          ts: frame.timestamp,
        }];
      case 'reasoning':
        return [{ id: frame.id, role: 'assistant', content: frame.text }];
      case 'tool':
        return [{
          id: frame.id,
          role: 'assistant',
          content: frame.error ?? '',
          tools: [{ name: frame.name, input: frame.input }],
        }];
      default:
        return [];
    }
  });
}

function messageSignature(message: ChatMessage): string {
  return `${message.role}\u0000${message.content}\u0000${(message.tools ?? []).map((tool) => tool.name).join('\u0001')}`;
}

/**
 * Projection frames are authoritative. A GUI stream may nevertheless be ahead
 * of the persisted snapshot by one optimistic user turn or a live delta. Keep
 * only that unmatched tail; never replace the projection with a second source.
 */
export function mergeConversationProjectionMessages(
  projection: ConversationContextProjection | null,
  liveTail: ChatMessage[],
): ChatMessage[] {
  if (!projection) return liveTail;
  const projected = conversationProjectionMessages(projection);
  const remaining = new Map<string, number>();
  for (const message of projected) {
    const key = messageSignature(message);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  const unmatched = liveTail.filter((message) => {
    const key = messageSignature(message);
    const count = remaining.get(key) ?? 0;
    if (count <= 0) return true;
    remaining.set(key, count - 1);
    return false;
  });
  return [...projected, ...unmatched];
}

const TASK_LABEL: Record<ConversationTaskFrame['status'], string> = {
  pending: 'Pending',
  in_progress: 'In progress',
  blocked: 'Blocked',
  completed: 'Completed',
  dropped: 'Dropped',
};

function ContextSection({ frame }: { frame: ConversationContextSectionFrame }) {
  return (
    <section className="pc-context-projection__section" data-section={frame.section}>
      <h4>{frame.title}</h4>
      <dl>
        {frame.entries.map((entry, index) => (
          <div key={`${entry.label}:${index}`}>
            <dt>{entry.label}</dt>
            <dd data-state={entry.state}>
              <span>{entry.value}</span>
              {entry.badges?.length ? (
                <span className="pc-context-projection__badges" aria-label={`${entry.label} status`}>
                  {entry.badges.map((badge, badgeIndex) => (
                    <span
                      key={`${badge.label}:${badgeIndex}`}
                      className="pc-context-projection__badge"
                      data-state={badge.state}
                      title={badge.title}
                    >
                      {badge.label}
                    </span>
                  ))}
                </span>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

interface TaskListProps {
  frames: ConversationTaskFrame[];
  onTaskAction?: (input: ConversationTaskActionInput) => void | Promise<void>;
  busy: boolean;
  error: string | null;
}

function TaskList({ frames, onTaskAction, busy, error }: TaskListProps) {
  const [newTask, setNewTask] = useState('');
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editActiveForm, setEditActiveForm] = useState('');

  if (frames.length === 0 && !onTaskAction) return null;

  const dispatch = async (
    input: ConversationTaskActionInput,
    afterSuccess?: () => void,
  ) => {
    if (!onTaskAction || busy) return;
    try {
      await onTaskAction(input);
      afterSuccess?.();
    } catch {
      // The hosting renderer owns the error string so all task controls share
      // one stable, capability-scoped error surface.
    }
  };

  const beginEdit = (task: ConversationTaskFrame) => {
    setEditingTaskId(task.taskId);
    setEditContent(task.content);
    setEditActiveForm(task.activeForm);
  };

  return (
    <section className="pc-context-projection__section" data-section="tasks">
      <div className="pc-context-projection__section-heading">
        <h4>Tasks</h4>
        {busy ? <span aria-live="polite">Saving…</span> : null}
      </div>
      {error ? (
        <div className="pc-context-projection__task-error" role="alert">{error}</div>
      ) : null}
      <ol className="pc-context-projection__tasks">
        {[...frames].sort((a, b) => a.position - b.position).map((task) => (
          <li key={task.id} data-status={task.status}>
            <span className="pc-context-projection__task-state">{TASK_LABEL[task.status]}</span>
            {editingTaskId === task.taskId && onTaskAction ? (
              <form
                className="pc-context-projection__task-edit"
                onSubmit={(event) => {
                  event.preventDefault();
                  const content = editContent.trim();
                  if (!content) return;
                  void dispatch({
                    action: 'edit',
                    taskId: task.taskId,
                    content,
                    ...(editActiveForm.trim() ? { activeForm: editActiveForm.trim() } : {}),
                    explanation: 'Edited from the operator Context pane.',
                  }, () => setEditingTaskId(null));
                }}
              >
                <input
                  aria-label={`Task content: ${task.content}`}
                  value={editContent}
                  onChange={(event) => setEditContent(event.target.value)}
                  disabled={busy}
                  maxLength={4_000}
                  required
                />
                <input
                  aria-label={`Task active form: ${task.content}`}
                  value={editActiveForm}
                  onChange={(event) => setEditActiveForm(event.target.value)}
                  disabled={busy}
                  maxLength={500}
                  placeholder="Active wording (optional)"
                />
                <div className="pc-context-projection__task-actions">
                  <button type="submit" disabled={busy || !editContent.trim()}>Save</button>
                  <button type="button" disabled={busy} onClick={() => setEditingTaskId(null)}>Cancel</button>
                </div>
              </form>
            ) : (
              <strong>{task.status === 'in_progress' ? task.activeForm : task.content}</strong>
            )}
            {task.blockerRef ? <small>Blocked on {task.blockerRef}</small> : null}
            {task.explanation ? <small>{task.explanation}</small> : null}
            {onTaskAction && editingTaskId !== task.taskId ? (
              <div className="pc-context-projection__task-actions">
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`Edit task: ${task.content}`}
                  onClick={() => beginEdit(task)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`Promote task: ${task.content}`}
                  onClick={() => void dispatch({
                    action: 'promote',
                    taskId: task.taskId,
                    explanation: 'Promoted from the operator Context pane.',
                  })}
                >
                  Promote
                </button>
                {task.status !== 'completed' && task.status !== 'dropped' ? (
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Check task: ${task.content}`}
                    onClick={() => void dispatch({
                      action: 'check',
                      taskId: task.taskId,
                      explanation: 'Checked from the operator Context pane.',
                    })}
                  >
                    Check
                  </button>
                ) : null}
                {task.status !== 'completed' && task.status !== 'dropped' ? (
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Drop task: ${task.content}`}
                    onClick={() => void dispatch({
                      action: 'drop',
                      taskId: task.taskId,
                      explanation: 'Dropped from the operator Context pane.',
                    })}
                  >
                    Drop
                  </button>
                ) : null}
                {task.status === 'blocked' && task.blockerState?.typed === false ? (
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Clear blocker for task: ${task.content}`}
                    onClick={() => void dispatch({
                      action: 'clear_blocker',
                      taskId: task.taskId,
                      explanation: 'Manual blocker cleared from the operator Context pane.',
                    })}
                  >
                    Clear blocker
                  </button>
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      {onTaskAction ? (
        <form
          className="pc-context-projection__task-add"
          onSubmit={(event) => {
            event.preventDefault();
            const content = newTask.trim();
            if (!content) return;
            void dispatch({
              action: 'add',
              content,
              explanation: 'Added from the operator Context pane.',
            }, () => setNewTask(''));
          }}
        >
          <input
            aria-label="New task"
            value={newTask}
            onChange={(event) => setNewTask(event.target.value)}
            disabled={busy}
            maxLength={4_000}
            placeholder="Add a task"
          />
          <button type="submit" disabled={busy || !newTask.trim()}>Add</button>
        </form>
      ) : null}
    </section>
  );
}

function ApprovalList({ frames }: { frames: ConversationApprovalFrame[] }) {
  if (frames.length === 0) return null;
  return (
    <section className="pc-context-projection__section" data-section="approvals">
      <h4>Needs you</h4>
      <ul className="pc-context-projection__approvals">
        {frames.map((approval) => (
          <li key={approval.id} data-status={approval.status}>
            <strong>{approval.toolName}</strong>
            <span>{approval.status}</span>
            {approval.reason ? <small>{approval.reason}</small> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ConversationContextProjectionView({
  projection,
  defaultOpen = true,
  className,
  onTaskAction,
  taskActionBusy = false,
  taskActionError = null,
}: {
  projection: ConversationContextProjection | null;
  defaultOpen?: boolean;
  className?: string;
  onTaskAction?: (input: ConversationTaskActionInput) => void | Promise<void>;
  taskActionBusy?: boolean;
  taskActionError?: string | null;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const contextFrames = useMemo(
    () => projection?.frames.filter((frame): frame is ConversationContextSectionFrame => frame.kind === 'context') ?? [],
    [projection],
  );
  const taskFrames = useMemo(
    () => projection?.frames.filter((frame): frame is ConversationTaskFrame => frame.kind === 'task') ?? [],
    [projection],
  );
  const approvalFrames = useMemo(
    () => projection?.frames.filter((frame): frame is ConversationApprovalFrame => frame.kind === 'approval') ?? [],
    [projection],
  );

  // Absence is the explicit degradation contract. Never render invented empty
  // sections or imply a capability tier the server did not return.
  if (!projection) return null;

  return (
    <aside
      className={`pc-context-projection${open ? ' is-open' : ' is-collapsed'}${className ? ` ${className}` : ''}`}
      data-testid="conversation-context-projection"
      data-capability-tier={projection.session.capabilityTier}
    >
      <button
        type="button"
        className="pc-context-projection__toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
        <span>Context</span>
        <small>{projection.session.capabilityTier.replace('-', ' ')}</small>
      </button>
      {open ? (
        <div className="pc-context-projection__body">
          <div className="pc-context-projection__capabilities" aria-label="Available conversation capabilities">
            {projection.capabilities.liveFrames ? <span>Live frames</span> : null}
            {projection.capabilities.taskWrite ? <span>Task write</span> : <span>Tasks read-only</span>}
            {projection.capabilities.approvalWrite ? <span>Approval write</span> : null}
          </div>
          {contextFrames.map((frame) => <ContextSection key={frame.id} frame={frame} />)}
          <TaskList
            frames={taskFrames}
            onTaskAction={projection.capabilities.taskWrite ? onTaskAction : undefined}
            busy={taskActionBusy}
            error={taskActionError}
          />
          <ApprovalList frames={approvalFrames} />
        </div>
      ) : null}
    </aside>
  );
}
