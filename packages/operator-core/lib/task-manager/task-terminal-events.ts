/**
 * Awaitable terminal transitions for durable managed tasks.
 *
 * The task ledger's first successful terminal UPDATE is the authority. The store
 * invokes this bridge only after that UPDATE returns a row, so competing exit,
 * kill, timeout, and reconciler writers produce one event rather than one per
 * attempted close. Delivery is best-effort and never rolls a truthful ledger
 * close back when the wake plane is degraded.
 */
import type { TaskState } from './types';

export const TASK_TERMINAL_EVENT_PREFIX = 'task:terminal:';

export interface TaskTerminalEventInput {
  taskId: string;
  workspaceId: string;
  harnessSlug: string | null;
  taskClass: string;
  launchedBy: string;
  state: Extract<TaskState, 'exited' | 'killed' | 'timed_out' | 'stranded' | 'ended_unobserved'>;
  exitCode: number | null;
  exitReason: string | null;
}

export type TaskTerminalEventEmitter = (event: TaskTerminalEventInput) => void;

export interface TaskTerminalEventDeps {
  emit?: (opts: import('../events/await/engine').EmitAwaitedEventOpts) => Promise<unknown>;
  warn?: (message: string) => void;
}

export function taskTerminalEventKey(taskId: string): string {
  return `${TASK_TERMINAL_EVENT_PREFIX}${taskId}`;
}

export function emitTaskTerminalEvent(event: TaskTerminalEventInput, deps: TaskTerminalEventDeps = {}): void {
  const payload = {
    taskId: event.taskId,
    state: event.state,
    exitCode: event.exitCode,
    exitReason: event.exitReason,
    taskClass: event.taskClass,
    harness: event.harnessSlug,
    launchedBy: event.launchedBy,
  };
  void Promise.resolve()
    .then(async () => {
      const emit = deps.emit ?? (await import('../events/await/engine')).emitAwaitedEvent;
      await emit({
        key: taskTerminalEventKey(event.taskId),
        summary: `Managed ${event.taskClass} task ${event.taskId} entered terminal state ${event.state}.`,
        payload,
        source: 'task-manager',
        workspaceId: event.workspaceId,
      });
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (/relation .*event_awaits.* does not exist/.test(message)) return;
      (deps.warn ?? ((value: string) => console.warn(value)))(
        `[task-manager] terminal event failed for ${event.taskId}: ${message}`,
      );
    });
}
