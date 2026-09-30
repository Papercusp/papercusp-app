/**
 * Canonical per-session task engine.
 *
 * The model sends one small operation; Papercusp owns the complete list in PG.
 * Callers execute mutations on a transaction-bound Sql handle. A
 * transaction-scoped advisory lock serializes two task calls for the same
 * session, while migration 981's partial unique index is the structural
 * guarantee that at most one task is in_progress.
 */
import type { Sql, TransactionSql } from 'postgres';
import { SessionTaskBlockerRefValidationError, validateSessionTaskBlockerRef } from './session-task-blocker-ref';
import { sanitizePersistedText } from './text-safety';

export const SESSION_TASK_STATUSES = ['pending', 'in_progress', 'blocked', 'completed', 'dropped'] as const;

export const SESSION_TASK_OPS = [
  'init',
  'start',
  'done',
  'drop',
  'block',
  'unblock',
  'reopen',
  'reorder',
  'edit',
  'append',
  'link',
  'unlink',
  'promote',
  'view',
] as const;

export const SESSION_TASK_LINK_RELATIONS = ['for', 'relates'] as const;

export type SessionTaskStatus = (typeof SESSION_TASK_STATUSES)[number];
export type SessionTaskOp = (typeof SESSION_TASK_OPS)[number];
export type SessionTaskLinkRelation = (typeof SESSION_TASK_LINK_RELATIONS)[number];

export interface SessionTaskWorkItemLink {
  workItemId: string;
  workItemHarness: string | null;
  relation: SessionTaskLinkRelation;
}

export interface SessionTask {
  id: string;
  content: string;
  activeForm: string;
  status: SessionTaskStatus;
  blockerRef: string | null;
  explanation: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
  links: SessionTaskWorkItemLink[];
}

export interface SessionTaskSeed {
  id?: string;
  content: string;
  activeForm?: string;
  status?: SessionTaskStatus;
  blockerRef?: string;
}

export interface SessionTaskOpArgs {
  op?: SessionTaskOp;
  tasks?: SessionTaskSeed[];
  taskId?: string;
  content?: string;
  activeForm?: string;
  blockerRef?: string;
  expectedUpdatedAt?: string;
  position?: number;
  explanation?: string;
  workItemId?: string;
  workItemHarness?: string;
  relation?: SessionTaskLinkRelation;
  workItemKind?: string;
  workItemTitle?: string;
  workItemSummary?: string;
}

export interface SessionTaskBridge {
  seedWorkItem?: SessionTaskWorkItemLink | null;
  promoteTask?: (
    task: SessionTask,
    request: { kind?: string; title?: string; summary?: string; harness?: string },
  ) => Promise<SessionTaskWorkItemLink>;
  syncProgress?: (link: SessionTaskWorkItemLink, task: SessionTask, op: SessionTaskOp) => Promise<void>;
}

export interface SessionTaskStoreArgs extends SessionTaskOpArgs {
  workspaceId: string;
  sessionId: string;
  idFactory: () => string;
  now?: string;
  bridge?: SessionTaskBridge;
}

export interface SessionTaskResult {
  op: SessionTaskOp;
  changedTaskId: string | null;
  tasks: SessionTask[];
  links: SessionTaskWorkItemLink[];
  bridgeWarnings?: string[];
}

type SqlLike = Sql | TransactionSql;

interface SessionTaskRow {
  task_id: string;
  content: string;
  active_form: string;
  status: SessionTaskStatus;
  blocker_ref: string | null;
  last_explanation: string | null;
  position: number;
  created_at: Date | string;
  updated_at: Date | string;
}

interface SessionTaskLinkRow {
  task_id: string;
  relation: SessionTaskLinkRelation;
  work_item_harness: string;
  work_item_id: string;
}

export class SessionTaskValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SessionTaskValidationError';
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new SessionTaskValidationError(code, message);
}

function present(value: string | undefined, field: string, max: number): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) fail(field + '_required', 'tasks:ops — `' + field + '` must be a non-empty string.');
  if (trimmed.length > max) {
    fail(field + '_too_long', 'tasks:ops — `' + field + '` exceeds the ' + max + '-character limit.');
  }
  return trimmed;
}

function sessionTaskLockKey(workspaceId: string, sessionId: string): string {
  // PostgreSQL text parameters cannot contain NUL bytes. JSON string escaping
  // gives the pair an unambiguous composite representation without embedding
  // the NUL separator that this lock key previously used.
  return JSON.stringify([workspaceId, sessionId]);
}

function optionalText(value: string | undefined, field: string, max: number): string | null {
  if (value === undefined) return null;
  return present(value, field, max);
}

/** Normalize model-authored values before they become PostgreSQL text values. */
function persistedText(value: string | undefined, field: string, max: number): string {
  return present(sanitizePersistedText(value), field, max);
}

function optionalPersistedText(value: string | undefined, field: string, max: number): string | null {
  if (value === undefined) return null;
  return persistedText(value, field, max);
}

function validatedBlockerRef(value: string | undefined): string {
  const blockerRef = persistedText(value, 'blocker_ref', 2_000);
  try {
    validateSessionTaskBlockerRef(blockerRef);
  } catch (error) {
    if (error instanceof SessionTaskBlockerRefValidationError) {
      fail(error.code, `tasks:ops — ${error.message}`);
    }
    throw error;
  }
  return blockerRef;
}

const MUTATION_FIELDS = [
  'tasks',
  'taskId',
  'content',
  'activeForm',
  'blockerRef',
  'expectedUpdatedAt',
  'position',
  'explanation',
  'workItemId',
  'workItemHarness',
  'relation',
  'workItemKind',
  'workItemTitle',
  'workItemSummary',
] as const satisfies readonly (keyof SessionTaskOpArgs)[];

function assertAllowedFields(
  args: SessionTaskOpArgs,
  op: SessionTaskOp,
  allowed: readonly (keyof SessionTaskOpArgs)[],
): void {
  const allowedSet = new Set<keyof SessionTaskOpArgs>(allowed);
  const unexpected = MUTATION_FIELDS.filter((field) => args[field] !== undefined && !allowedSet.has(field));
  if (unexpected.length > 0) {
    fail(op + '_fields_unexpected', 'tasks:ops — op=' + op + ' does not accept: ' + unexpected.join(', ') + '.');
  }
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapRow(row: SessionTaskRow): SessionTask {
  return {
    id: row.task_id,
    content: row.content,
    activeForm: row.active_form,
    status: row.status,
    blockerRef: row.blocker_ref,
    explanation: row.last_explanation,
    position: Number(row.position),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    links: [],
  };
}

function flattenLinks(tasks: readonly SessionTask[]): SessionTaskWorkItemLink[] {
  return tasks.flatMap((task) => task.links.map((link) => ({ ...link })));
}

function normalizeRelation(value: SessionTaskLinkRelation | undefined): SessionTaskLinkRelation {
  const next = value ?? 'relates';
  if (!(SESSION_TASK_LINK_RELATIONS as readonly string[]).includes(next)) {
    fail('relation_invalid', 'tasks:ops — `relation` must be for|relates.');
  }
  return next;
}

function linkMatches(a: SessionTaskWorkItemLink, b: SessionTaskWorkItemLink): boolean {
  return a.workItemId === b.workItemId && a.workItemHarness === b.workItemHarness && a.relation === b.relation;
}

/** Infer only unambiguous shapes. A lone task id cannot reveal a transition. */
export function inferSessionTaskOp(args: SessionTaskOpArgs): SessionTaskOp {
  if (args.op) return args.op;
  if (args.tasks !== undefined) return 'init';
  if (args.taskId && args.blockerRef !== undefined) return 'block';
  if (args.content !== undefined) return 'append';
  if (
    args.taskId !== undefined ||
    args.activeForm !== undefined ||
    args.blockerRef !== undefined ||
    args.explanation !== undefined
  ) {
    fail(
      'op_ambiguous',
      'tasks:ops — cannot infer `op` from these fields. Pass one of start|done|drop|block|unblock explicitly.',
    );
  }
  return 'view';
}

function taskById(tasks: SessionTask[], id: string): SessionTask {
  const task = tasks.find((candidate) => candidate.id === id);
  if (!task) {
    fail(
      'task_not_found',
      'tasks:ops — task `' + id + '` does not exist in this session. Call with op=view for current ids.',
    );
  }
  return task;
}

function assertExpectedRevision(task: SessionTask, expectedUpdatedAt: string | undefined): void {
  if (expectedUpdatedAt === undefined) return;
  const expected = present(expectedUpdatedAt, 'expected_updated_at', 100);
  if (expected !== task.updatedAt) {
    fail(
      'task_revision_conflict',
      `tasks:ops — task '${task.id}' changed after this editor opened (expected ${expected}, current ${task.updatedAt}). Refresh or retry from the preserved draft.`,
    );
  }
}

function validateSeed(seed: SessionTaskSeed, position: number, now: string, idFactory: () => string): SessionTask {
  const status = seed.status ?? 'pending';
  if (!(SESSION_TASK_STATUSES as readonly string[]).includes(status)) {
    fail('status_invalid', 'tasks:ops — invalid task status `' + String(status) + '`.');
  }
  const content = persistedText(seed.content, 'content', 4_000);
  const activeForm = seed.activeForm === undefined ? content : persistedText(seed.activeForm, 'activeForm', 500);
  const blockerRef = optionalPersistedText(seed.blockerRef, 'blocker_ref', 2_000);
  if (status === 'blocked' && !blockerRef) {
    fail('blocker_ref_required', 'tasks:ops — an initialized blocked task requires `blocker_ref`.');
  }
  if (status !== 'blocked' && blockerRef) {
    fail('blocker_ref_unexpected', 'tasks:ops — `blocker_ref` is valid only when status is blocked.');
  }
  if (blockerRef) validatedBlockerRef(blockerRef);
  const id = seed.id === undefined ? idFactory() : persistedText(seed.id, 'id', 160);
  return {
    id,
    content,
    activeForm,
    status,
    blockerRef,
    explanation: null,
    position,
    createdAt: now,
    updatedAt: now,
    links: [],
  };
}

/**
 * Pure reducer used by both the PG store and focused tests.
 * It never mutates the caller's array or task objects.
 */
export function reduceSessionTasks(
  current: readonly SessionTask[],
  args: SessionTaskOpArgs,
  options: { now: string; idFactory: () => string },
): SessionTaskResult {
  const op = inferSessionTaskOp(args);
  const now = options.now;
  const tasks = current.map((task) => ({
    ...task,
    links: task.links.map((link) => ({ ...link })),
  }));
  const explanation = optionalPersistedText(args.explanation, 'explanation', 2_000);

  if (op === 'view') {
    assertAllowedFields(args, op, []);
    return { op, changedTaskId: null, tasks, links: flattenLinks(tasks) };
  }

  if (op === 'init') {
    assertAllowedFields(args, op, ['tasks', 'explanation']);
    if (args.tasks === undefined) {
      fail('tasks_required', 'tasks:ops — op=init requires `tasks` (use [] to clear the list).');
    }
    if (args.tasks.length > 100) {
      fail('too_many_tasks', 'tasks:ops — op=init accepts at most 100 tasks.');
    }
    const next = args.tasks.map((seed, index) => ({
      ...validateSeed(seed, index, now, options.idFactory),
      explanation,
    }));
    const ids = new Set<string>();
    for (const task of next) {
      if (ids.has(task.id)) fail('duplicate_task_id', 'tasks:ops — duplicate task id `' + task.id + '`.');
      ids.add(task.id);
    }
    if (next.filter((task) => task.status === 'in_progress').length > 1) {
      fail('multiple_in_progress', 'tasks:ops — op=init permits at most one in_progress task.');
    }
    return { op, changedTaskId: null, tasks: next, links: flattenLinks(next) };
  }

  if (op === 'append') {
    assertAllowedFields(args, op, ['content', 'activeForm', 'explanation']);
    const content = persistedText(args.content, 'content', 4_000);
    const activeForm = args.activeForm === undefined ? content : persistedText(args.activeForm, 'activeForm', 500);
    const id = options.idFactory();
    const task: SessionTask = {
      id,
      content,
      activeForm,
      status: 'pending',
      blockerRef: null,
      explanation,
      position: tasks.length,
      createdAt: now,
      updatedAt: now,
      links: [],
    };
    const next = [...tasks, task];
    return { op, changedTaskId: id, tasks: next, links: flattenLinks(next) };
  }

  const taskId = present(args.taskId, 'task_id', 160);
  const target = taskById(tasks, taskId);
  const targetIndex = tasks.findIndex((task) => task.id === taskId);

  if (op === 'link') {
    assertAllowedFields(args, op, ['taskId', 'workItemId', 'workItemHarness', 'relation', 'explanation']);
    const nextLink: SessionTaskWorkItemLink = {
      workItemId: persistedText(args.workItemId, 'work_item_id', 240),
      workItemHarness: optionalPersistedText(args.workItemHarness, 'work_item_harness', 240),
      relation: normalizeRelation(args.relation),
    };
    const existingFor = target.links.find((link) => link.relation === 'for');
    if (nextLink.relation === 'for' && existingFor && !linkMatches(existingFor, nextLink)) {
      fail(
        'for_link_exists',
        `tasks:ops — task '${taskId}' already has checkpoint-sync target '${existingFor.workItemId}'. Unlink it first.`,
      );
    }
    if (!target.links.some((link) => linkMatches(link, nextLink))) {
      tasks[targetIndex] = {
        ...target,
        links: [...target.links, nextLink],
        explanation,
        updatedAt: now,
      };
    }
    return { op, changedTaskId: taskId, tasks, links: flattenLinks(tasks) };
  }

  if (op === 'unlink') {
    assertAllowedFields(args, op, ['taskId', 'workItemId', 'workItemHarness', 'relation', 'explanation']);
    const workItemId = persistedText(args.workItemId, 'work_item_id', 240);
    const workItemHarness = optionalPersistedText(args.workItemHarness, 'work_item_harness', 240);
    const nextLinks = target.links.filter(
      (link) =>
        !(
          link.workItemId === workItemId &&
          link.workItemHarness === workItemHarness &&
          (args.relation === undefined || link.relation === normalizeRelation(args.relation))
        ),
    );
    if (nextLinks.length === target.links.length) {
      fail('link_not_found', `tasks:ops — task '${taskId}' has no matching work-item link.`);
    }
    tasks[targetIndex] = {
      ...target,
      links: nextLinks,
      explanation,
      updatedAt: now,
    };
    return { op, changedTaskId: taskId, tasks, links: flattenLinks(tasks) };
  }

  if (op === 'promote') {
    return fail('promote_runtime_required', 'tasks:ops — promote requires the ledger bridge runtime.');
  }

  if (op === 'edit') {
    assertAllowedFields(args, op, ['taskId', 'content', 'activeForm', 'expectedUpdatedAt', 'explanation']);
    assertExpectedRevision(target, args.expectedUpdatedAt);
    const content = persistedText(args.content, 'content', 4_000);
    const activeForm = args.activeForm === undefined ? content : persistedText(args.activeForm, 'activeForm', 500);
    tasks[targetIndex] = {
      ...target,
      content,
      activeForm,
      explanation,
      updatedAt: now,
    };
    return { op, changedTaskId: taskId, tasks, links: flattenLinks(tasks) };
  }

  if (op === 'start') {
    assertAllowedFields(args, op, ['taskId', 'activeForm', 'expectedUpdatedAt', 'explanation']);
    assertExpectedRevision(target, args.expectedUpdatedAt);
    if (target.status === 'completed' || target.status === 'dropped') {
      fail('task_terminal', 'tasks:ops — cannot start terminal task `' + taskId + '` (' + target.status + ').');
    }
    const activeForm = args.activeForm === undefined ? target.activeForm : persistedText(args.activeForm, 'activeForm', 500);
    const next = tasks.map((task) => {
      if (task.id === taskId) {
        return {
          ...task,
          activeForm,
          status: 'in_progress' as const,
          blockerRef: null,
          explanation,
          updatedAt: now,
        };
      }
      if (task.status === 'in_progress') {
        return { ...task, status: 'pending' as const, explanation, updatedAt: now };
      }
      return task;
    });
    return { op, changedTaskId: taskId, tasks: next, links: flattenLinks(next) };
  }

  if (op === 'done') {
    assertAllowedFields(args, op, ['taskId', 'expectedUpdatedAt', 'explanation']);
    assertExpectedRevision(target, args.expectedUpdatedAt);
    if (target.status === 'dropped') {
      fail('task_dropped', 'tasks:ops — dropped task `' + taskId + '` cannot be completed.');
    }
    tasks[targetIndex] = {
      ...target,
      status: 'completed',
      blockerRef: null,
      explanation,
      updatedAt: now,
    };
    return { op, changedTaskId: taskId, tasks, links: flattenLinks(tasks) };
  }

  if (op === 'drop') {
    assertAllowedFields(args, op, ['taskId', 'expectedUpdatedAt', 'explanation']);
    assertExpectedRevision(target, args.expectedUpdatedAt);
    tasks[targetIndex] = {
      ...target,
      status: 'dropped',
      blockerRef: null,
      explanation,
      updatedAt: now,
    };
    return { op, changedTaskId: taskId, tasks, links: flattenLinks(tasks) };
  }

  if (op === 'block') {
    assertAllowedFields(args, op, ['taskId', 'blockerRef', 'expectedUpdatedAt', 'explanation']);
    assertExpectedRevision(target, args.expectedUpdatedAt);
    if (target.status === 'completed' || target.status === 'dropped') {
      fail('task_terminal', 'tasks:ops — cannot block terminal task `' + taskId + '` (' + target.status + ').');
    }
    const blockerRef = validatedBlockerRef(args.blockerRef);
    tasks[targetIndex] = {
      ...target,
      status: 'blocked',
      blockerRef,
      explanation,
      updatedAt: now,
    };
    return { op, changedTaskId: taskId, tasks, links: flattenLinks(tasks) };
  }

  if (op === 'unblock') {
    assertAllowedFields(args, op, ['taskId', 'expectedUpdatedAt', 'explanation']);
    assertExpectedRevision(target, args.expectedUpdatedAt);
    if (target.status !== 'blocked') {
      fail(
        'task_not_blocked',
        'tasks:ops — task `' + taskId + '` is ' + target.status + ', not blocked; unblock would be a no-op.',
      );
    }
    tasks[targetIndex] = {
      ...target,
      status: 'pending',
      blockerRef: null,
      explanation,
      updatedAt: now,
    };
    return { op, changedTaskId: taskId, tasks, links: flattenLinks(tasks) };
  }

  if (op === 'reopen') {
    assertAllowedFields(args, op, ['taskId', 'expectedUpdatedAt', 'explanation']);
    assertExpectedRevision(target, args.expectedUpdatedAt);
    if (target.status !== 'completed' && target.status !== 'dropped') {
      fail(
        'task_not_terminal',
        `tasks:ops — task '${taskId}' is ${target.status}, not completed or dropped; reopen would be a no-op.`,
      );
    }
    tasks[targetIndex] = {
      ...target,
      status: 'pending',
      blockerRef: null,
      explanation,
      updatedAt: now,
    };
    return { op, changedTaskId: taskId, tasks, links: flattenLinks(tasks) };
  }

  if (op === 'reorder') {
    assertAllowedFields(args, op, ['taskId', 'position', 'expectedUpdatedAt', 'explanation']);
    assertExpectedRevision(target, args.expectedUpdatedAt);
    if (!Number.isSafeInteger(args.position) || args.position! < 0 || args.position! >= tasks.length) {
      fail(
        'position_invalid',
        `tasks:ops — position must be an integer from 0 through ${Math.max(0, tasks.length - 1)}.`,
      );
    }
    const destination = args.position!;
    const reordered = tasks.slice();
    reordered.splice(targetIndex, 1);
    reordered.splice(destination, 0, target);
    const next = reordered.map((task, position) =>
      task.position === position ? task : { ...task, position, explanation, updatedAt: now },
    );
    return { op, changedTaskId: taskId, tasks: next, links: flattenLinks(next) };
  }

  return fail('op_invalid', 'tasks:ops — unsupported op `' + String(op) + '`.');
}

async function readSessionTasks(
  sql: SqlLike,
  workspaceId: string,
  sessionId: string,
  forUpdate: boolean,
): Promise<SessionTask[]> {
  const rows = forUpdate
    ? await sql<SessionTaskRow[]>`
        SELECT task_id, content, active_form, status, blocker_ref,
               last_explanation, position, created_at, updated_at
          FROM harness_shared.session_tasks
         WHERE workspace_id = ${workspaceId} AND session_id = ${sessionId}
         ORDER BY position, created_at, task_id
         FOR UPDATE`
    : await sql<SessionTaskRow[]>`
        SELECT task_id, content, active_form, status, blocker_ref,
               last_explanation, position, created_at, updated_at
          FROM harness_shared.session_tasks
         WHERE workspace_id = ${workspaceId} AND session_id = ${sessionId}
         ORDER BY position, created_at, task_id`;
  const tasks = rows.map(mapRow);
  if (tasks.length === 0) return tasks;
  const linkRows = await sql<SessionTaskLinkRow[]>`
    SELECT task_id, relation, work_item_harness, work_item_id
      FROM harness_shared.session_task_work_item_links
     WHERE workspace_id = ${workspaceId} AND session_id = ${sessionId}
     ORDER BY task_id, relation, work_item_harness, work_item_id`;
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  for (const row of linkRows) {
    const task = tasksById.get(row.task_id);
    if (!task) continue;
    task.links.push({
      workItemId: row.work_item_id,
      workItemHarness: row.work_item_harness || null,
      relation: row.relation,
    });
  }
  return tasks;
}

function seedNewTasks(
  current: readonly SessionTask[],
  next: SessionTask[],
  seed: SessionTaskWorkItemLink | null | undefined,
): SessionTask[] {
  const priorById = new Map(current.map((task) => [task.id, task]));
  return next.map((task) => {
    const prior = priorById.get(task.id);
    const preserved = prior ? prior.links.map((link) => ({ ...link })) : task.links;
    const links = preserved.length === 0 && !prior && seed ? [{ ...seed, relation: 'for' as const }] : preserved;
    return { ...task, links };
  });
}

const CHECKPOINT_PROGRESS_OPS: readonly SessionTaskOp[] = [
  'start',
  'done',
  'drop',
  'block',
  'unblock',
  'reopen',
  'reorder',
  'edit',
];

/**
 * Serialize a multi-step read/diff/write sequence for one session.
 *
 * applySessionTaskOp calls this for every mutation. Snapshot facades call it
 * before their initial view so the diff cannot be computed from stale state;
 * PostgreSQL transaction advisory locks are re-entrant for the later ops.
 */
export async function acquireSessionTaskLock(
  sql: SqlLike,
  workspaceIdValue: string,
  sessionIdValue: string,
): Promise<void> {
  const workspaceId = present(workspaceIdValue, 'workspace_id', 240);
  const sessionId = present(sessionIdValue, 'session_id', 240);
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${sessionTaskLockKey(workspaceId, sessionId)}, 981))`;
}

/**
 * The task-list session an owner operates. A PUI conversation's list is keyed
 * on its chat id (pui-first-party-public-release-2026-09-07 D-019), so an SU
 * coord owner attached to one (adv_sessions.su_agent_chat_id, unique per
 * workspace) reads and writes that chat's list; any other owner keeps its own.
 */
export async function taskSessionIdForOwner(
  sql: SqlLike,
  workspaceId: string,
  ownerId: string,
): Promise<string> {
  const rows = await sql<Array<{ su_agent_chat_id: string }>>`
    SELECT su_agent_chat_id
      FROM harness_shared.adv_sessions
     WHERE workspace_id = ${workspaceId}
       AND coord_owner_id = ${ownerId}
       AND su_agent_chat_id IS NOT NULL
     ORDER BY started_at DESC
     LIMIT 1`;
  return rows[0]?.su_agent_chat_id ?? ownerId;
}

export async function applySessionTaskOp(sql: SqlLike, args: SessionTaskStoreArgs): Promise<SessionTaskResult> {
  const workspaceId = present(args.workspaceId, 'workspace_id', 240);
  const sessionId = present(args.sessionId, 'session_id', 240);
  const op = inferSessionTaskOp(args);

  if (op === 'view') {
    const tasks = await readSessionTasks(sql, workspaceId, sessionId, false);
    return {
      op,
      changedTaskId: null,
      tasks,
      links: flattenLinks(tasks),
    };
  }

  await acquireSessionTaskLock(sql, workspaceId, sessionId);
  const current = await readSessionTasks(sql, workspaceId, sessionId, true);
  const now = args.now ?? new Date().toISOString();
  let reduced: SessionTaskResult;
  if (op === 'promote') {
    assertAllowedFields(args, op, [
      'taskId',
      'workItemKind',
      'workItemTitle',
      'workItemSummary',
      'workItemHarness',
      'expectedUpdatedAt',
      'explanation',
    ]);
    const taskId = present(args.taskId, 'task_id', 160);
    const task = taskById(current, taskId);
    assertExpectedRevision(task, args.expectedUpdatedAt);
    const existing = task.links.find((link) => link.relation === 'for');
    if (existing) {
      return { op, changedTaskId: taskId, tasks: current, links: flattenLinks(current) };
    }
    if (!args.bridge?.promoteTask) {
      fail('promote_unavailable', 'tasks:ops — the work-item promotion bridge is unavailable.');
    }
    const promoted = await args.bridge.promoteTask(task, {
      kind: args.workItemKind,
      title: optionalText(args.workItemTitle, 'work_item_title', 4_000) ?? undefined,
      summary: optionalText(args.workItemSummary, 'work_item_summary', 20_000) ?? undefined,
      harness: optionalText(args.workItemHarness, 'work_item_harness', 240) ?? undefined,
    });
    const linked = reduceSessionTasks(
      current,
      {
      op: 'link',
      taskId,
      workItemId: promoted.workItemId,
      workItemHarness: promoted.workItemHarness ?? undefined,
      relation: 'for',
      explanation: args.explanation,
      },
      { now, idFactory: args.idFactory },
    );
    reduced = { ...linked, op: 'promote' };
  } else {
    reduced = reduceSessionTasks(
      current,
      { ...args, op },
      {
      now,
      idFactory: args.idFactory,
      },
    );
  }

  if (op === 'init' || op === 'append') {
    reduced.tasks = seedNewTasks(current, reduced.tasks, args.bridge?.seedWorkItem);
    reduced.links = flattenLinks(reduced.tasks);
  }

  await sql`
    DELETE FROM harness_shared.session_tasks
     WHERE workspace_id = ${workspaceId} AND session_id = ${sessionId}`;

  for (const task of reduced.tasks) {
    await sql`
      INSERT INTO harness_shared.session_tasks
        (workspace_id, session_id, task_id, position, content, active_form,
         status, blocker_ref, last_explanation, created_at, updated_at)
      VALUES
        (${workspaceId}, ${sessionId}, ${task.id}, ${task.position}, ${task.content},
         ${task.activeForm}, ${task.status}, ${task.blockerRef}, ${task.explanation},
         ${task.createdAt}, ${task.updatedAt})`;
    for (const link of task.links) {
      await sql`
        INSERT INTO harness_shared.session_task_work_item_links
          (workspace_id, session_id, task_id, relation, work_item_harness, work_item_id)
        VALUES
          (${workspaceId}, ${sessionId}, ${task.id}, ${link.relation},
           ${link.workItemHarness ?? ''}, ${link.workItemId})`;
    }
  }

  if (reduced.changedTaskId && args.bridge?.syncProgress && CHECKPOINT_PROGRESS_OPS.includes(op)) {
    const task = reduced.tasks.find((candidate) => candidate.id === reduced.changedTaskId);
    const syncTarget = task?.links.find((link) => link.relation === 'for');
    if (task && syncTarget) {
      try {
        await args.bridge.syncProgress(syncTarget, task, op);
      } catch (error) {
        reduced.bridgeWarnings = [
          `checkpoint sync failed for ${syncTarget.workItemId}: ${error instanceof Error ? error.message : String(error)}`,
        ];
      }
    }
  }

  return reduced;
}
