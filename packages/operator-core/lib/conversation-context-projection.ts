/**
 * One server-side conversation/context projection for every agent-chat UI.
 *
 * P-029 / own-tui-full-divorce-2026-08-24 and cockpit D-004 require pui and
 * the operator GUI to render the same typed frames.  Keep normalization here:
 * consumers select/group frames, but never rebuild messages, tool cards,
 * tasks or approvals from their source tables independently.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import type { TranscriptTurn } from './agent-chats-data';
import { listPendingLoopApprovals, type LoopApprovalRequestRow } from './agent-loop/approval-store';
import { loadLoopSession, type LoopSessionRow } from './agent-loop/session-store';
import type { LoopEvent } from './agent-loop/loop';
import type { ModelMessage } from './agent-loop/model-port';
import { lockDomainForProjectDir } from './agent-tools/locks/coordination-domain';
import { loadHarnessRegistry, resolveHarnessContentPath } from './harness-registry';
import { getModes, type ModeRow } from './modes/store';
import { applySessionTaskOp, type SessionTask } from './session-tasks';
import {
  reconcileSessionTaskBlockers,
  type SessionTaskBlockerState,
} from './session-task-blockers';
import {
  loadFleetContextFrame,
  type LoadFleetContextFrameInput,
} from './conversation-context-fleet';

export const CONVERSATION_CONTEXT_PROJECTION_VERSION = 'conversation-context-v1' as const;

export type ConversationContextCapabilityTier =
  | 'owned-loop'
  | 'producer-readonly'
  | 'transcript-only';

export interface ConversationContextCapabilities {
  /** The native stream can append already-normalized frames while a turn runs. */
  liveFrames: boolean;
  /** The session accepts canonical tasks:ops mutations. */
  taskWrite: boolean;
  /** The session accepts HITL approval decisions. */
  approvalWrite: boolean;
}

export type ConversationContextFrameKind =
  | 'message'
  | 'reasoning'
  | 'tool'
  | 'task'
  | 'context'
  | 'approval';

interface FrameBase {
  id: string;
  kind: ConversationContextFrameKind;
}

export interface ConversationMessageFrame extends FrameBase {
  kind: 'message';
  role: 'user' | 'assistant';
  text: string;
  timestamp: string | null;
  streaming?: boolean;
  error?: boolean;
  provenance?: {
    engine?: string;
    model?: string;
    accountRoute?: string;
  };
}

export interface ConversationReasoningFrame extends FrameBase {
  kind: 'reasoning';
  text: string;
  stepIndex: number | null;
  /** Reasoning is currently a live frame; snapshots omit it when unavailable. */
  transient: boolean;
}

export type ConversationToolState =
  | 'requested'
  | 'approval-required'
  | 'succeeded'
  | 'failed'
  | 'denied';

export interface ConversationToolFrame extends FrameBase {
  kind: 'tool';
  callId: string;
  name: string;
  input?: unknown;
  result?: unknown;
  error?: string;
  stepIndex: number | null;
  needsApproval: boolean;
  state: ConversationToolState;
}

export interface ConversationTaskFrame extends FrameBase {
  kind: 'task';
  taskId: string;
  content: string;
  activeForm: string;
  status: SessionTask['status'];
  blockerRef: string | null;
  blockerState: SessionTaskBlockerState | null;
  explanation: string | null;
  position: number;
  updatedAt: string;
  /** D-004: render promotion/link state from the same typed projection. */
  links: SessionTask['links'];
}

export type ConversationContextSection =
  | 'identity'
  | 'mode'
  | 'model-account'
  | 'intent'
  | 'fleet'
  | 'plan'
  | 'held';

export interface ConversationContextEntryBadge {
  label: string;
  state?: string;
  title?: string;
}

export interface ConversationContextEntry {
  label: string;
  value: string;
  state?: string;
  /** Optional compact glyph/status strip. P-030 keeps this on the shared
   * context model so fleet-aware consumers extend the one projection rather
   * than growing a renderer-private row type. */
  badges?: ConversationContextEntryBadge[];
}

export interface ConversationContextSectionFrame extends FrameBase {
  kind: 'context';
  section: ConversationContextSection;
  title: string;
  entries: ConversationContextEntry[];
}

export interface ConversationApprovalFrame extends FrameBase {
  kind: 'approval';
  callId: string;
  toolName: string | null;
  input?: unknown;
  stepIndex: number;
  requestedAt: string | null;
  status: 'pending' | 'approved' | 'denied';
  reason?: string;
}

export type ConversationContextFrame =
  | ConversationMessageFrame
  | ConversationReasoningFrame
  | ConversationToolFrame
  | ConversationTaskFrame
  | ConversationContextSectionFrame
  | ConversationApprovalFrame;

export interface ConversationContextProjection {
  schemaVersion: typeof CONVERSATION_CONTEXT_PROJECTION_VERSION;
  session: {
    sourceKind: string;
    sessionId: string;
    harness: string | null;
    role: string | null;
    linkedWorkItemId: string | null;
    capabilityTier: ConversationContextCapabilityTier;
  };
  capabilities: ConversationContextCapabilities;
  frames: ConversationContextFrame[];
}

export interface ProjectConversationContextInput {
  sourceKind: string;
  sessionId: string;
  harness: string | null;
  role: string | null;
  linkedWorkItemId: string | null;
  transcript: TranscriptTurn[];
  loopSession: LoopSessionRow | null;
  /** The chat is homed on the SU-session host (su_runtime_class 'su-session'):
   * its canonical task list is owner-writable without an owned-loop ledger
   * (pui-first-party-public-release-2026-09-07 D-019). */
  suSessionChat?: boolean;
  tasks?: SessionTask[];
  taskBlockerStates?: ReadonlyMap<string, SessionTaskBlockerState>;
  approvals?: LoopApprovalRequestRow[];
  context?: ConversationContextSectionFrame[];
  /** Persisted producer-tool rows for read-only foreign sessions. Owned-loop
   * tool calls already ride loopSession.messages and leave this unset. */
  toolFrames?: ConversationToolFrame[];
}

function transcriptFrames(turns: TranscriptTurn[]): ConversationMessageFrame[] {
  return turns.map((turn, index) => ({
    id: `message:transcript:${index}`,
    kind: 'message',
    role: turn.role,
    text: turn.content,
    timestamp: turn.ts || null,
    ...(turn.error ? { error: true } : {}),
    ...(turn.engine || turn.model || turn.account_route
      ? {
          provenance: {
            ...(turn.engine ? { engine: turn.engine } : {}),
            ...(turn.model ? { model: turn.model } : {}),
            ...(turn.account_route ? { accountRoute: turn.account_route } : {}),
          },
        }
      : {}),
  }));
}

/** Project the owned loop's provider-neutral message ledger without teaching
 * either renderer how tool_call/tool_result correlation works. */
export function loopMessageFrames(messages: ModelMessage[]): ConversationContextFrame[] {
  const frames: ConversationContextFrame[] = [];
  const toolIndexes = new Map<string, number>();
  messages.forEach((message, messageIndex) => {
    message.content.forEach((part, partIndex) => {
      if (part.type === 'text') {
        if (!part.text) return;
        frames.push({
          id: `message:loop:${messageIndex}:${partIndex}`,
          kind: 'message',
          role: message.role,
          text: part.text,
          timestamp: null,
        });
        return;
      }
      if (part.type === 'tool_call') {
        toolIndexes.set(part.id, frames.length);
        frames.push({
          id: `tool:${part.id}`,
          kind: 'tool',
          callId: part.id,
          name: part.name,
          input: part.input,
          stepIndex: null,
          needsApproval: false,
          state: 'requested',
        });
        return;
      }
      const existingIndex = toolIndexes.get(part.toolCallId);
      const existing = existingIndex === undefined ? null : frames[existingIndex];
      const next: ConversationToolFrame = {
        id: `tool:${part.toolCallId}`,
        kind: 'tool',
        callId: part.toolCallId,
        name: existing?.kind === 'tool' ? existing.name : 'unknown',
        ...(existing?.kind === 'tool' && existing.input !== undefined ? { input: existing.input } : {}),
        result: part.content,
        stepIndex: existing?.kind === 'tool' ? existing.stepIndex : null,
        needsApproval: existing?.kind === 'tool' ? existing.needsApproval : false,
        state: part.isError ? 'failed' : 'succeeded',
      };
      if (existingIndex === undefined) {
        toolIndexes.set(part.toolCallId, frames.length);
        frames.push(next);
      } else {
        frames[existingIndex] = next;
      }
    });
  });
  return frames;
}

function defaultContextFrames(input: ProjectConversationContextInput): ConversationContextSectionFrame[] {
  const identityEntries = [
    { label: 'Session', value: input.sessionId },
    ...(input.harness ? [{ label: 'Harness', value: input.harness }] : []),
    ...(input.role ? [{ label: 'Role', value: input.role }] : []),
  ];
  const frames: ConversationContextSectionFrame[] = [
    { id: 'context:identity', kind: 'context', section: 'identity', title: 'Identity', entries: identityEntries },
  ];
  const lastAssistant = [...input.transcript].reverse().find((turn) => turn.role === 'assistant');
  const model = input.loopSession?.model ?? lastAssistant?.model ?? null;
  const account = lastAssistant?.account_route ?? null;
  if (model || account) {
    frames.push({
      id: 'context:model-account',
      kind: 'context',
      section: 'model-account',
      title: 'Model + account',
      entries: [
        ...(model ? [{ label: 'Model', value: model }] : []),
        ...(account ? [{ label: 'Account', value: account }] : []),
      ],
    });
  }
  if (input.linkedWorkItemId) {
    frames.push({
      id: 'context:intent',
      kind: 'context',
      section: 'intent',
      title: 'Intent',
      entries: [{ label: 'Linked work item', value: input.linkedWorkItemId }],
    });
  }
  return frames;
}

export function projectConversationContext(
  input: ProjectConversationContextInput,
): ConversationContextProjection {
  const freshLoopLedger =
    input.loopSession !== null && input.loopSession.transcriptTurns === input.transcript.length;
  const capabilityTier: ConversationContextCapabilityTier = freshLoopLedger
    ? 'owned-loop'
    : input.sourceKind === 'agent_chat'
      ? 'transcript-only'
      : 'producer-readonly';
  const contentFrames = freshLoopLedger
    ? loopMessageFrames(input.loopSession!.messages)
    : transcriptFrames(input.transcript);
  const taskFrames: ConversationTaskFrame[] = (input.tasks ?? []).map((task) => ({
    id: `task:${task.id}`,
    kind: 'task',
    taskId: task.id,
    content: task.content,
    activeForm: task.activeForm,
    status: task.status,
    blockerRef: task.blockerRef,
    blockerState: input.taskBlockerStates?.get(task.id) ?? null,
    explanation: task.explanation,
    position: task.position,
    updatedAt: task.updatedAt,
    links: task.links.map((link) => ({ ...link })),
  }));
  const approvalFrames: ConversationApprovalFrame[] = (input.approvals ?? []).map((approval) => ({
    id: `approval:${approval.callId}`,
    kind: 'approval',
    callId: approval.callId,
    toolName: approval.toolName,
    input: approval.toolInput,
    stepIndex: approval.stepIndex,
    requestedAt: approval.requestedAt,
    status: 'pending',
  }));
  return {
    schemaVersion: CONVERSATION_CONTEXT_PROJECTION_VERSION,
    session: {
      sourceKind: input.sourceKind,
      sessionId: input.sessionId,
      harness: input.harness,
      role: input.role,
      linkedWorkItemId: input.linkedWorkItemId,
      capabilityTier,
    },
    capabilities: {
      liveFrames: freshLoopLedger,
      // The task list is keyed on the conversation, not on who runs it: the
      // owned loop and an attached SU agent both operate this chat's list.
      taskWrite: freshLoopLedger || (input.sourceKind === 'agent_chat' && input.suSessionChat === true),
      approvalWrite: freshLoopLedger,
    },
    frames: [
      ...contentFrames,
      ...(input.toolFrames ?? []),
      ...(input.context ?? defaultContextFrames(input)),
      ...taskFrames,
      ...approvalFrames,
    ],
  };
}

/** Normalize a live native-loop event at the server seam. Snapshot readers do
 * not invent reasoning; the stream appends this frame only when it exists. */
export function projectLiveLoopEvent(event: LoopEvent): ConversationContextFrame | null {
  switch (event.type) {
    case 'text_delta':
      return {
        id: `message:live:${event.stepIndex}`,
        kind: 'message',
        role: 'assistant',
        text: event.text,
        timestamp: null,
        streaming: true,
      };
    case 'reasoning_delta':
      return {
        id: `reasoning:live:${event.stepIndex}`,
        kind: 'reasoning',
        text: event.text,
        stepIndex: event.stepIndex,
        transient: true,
      };
    case 'tool_call':
      return {
        id: `tool:${event.call.id}`,
        kind: 'tool',
        callId: event.call.id,
        name: event.call.name,
        input: event.call.input,
        stepIndex: event.stepIndex,
        needsApproval: event.needsApproval,
        state: event.needsApproval ? 'approval-required' : 'requested',
      };
    case 'tool_result':
      return {
        id: `tool:${event.callId}`,
        kind: 'tool',
        callId: event.callId,
        name: event.name,
        ...(event.result !== undefined ? { result: event.result } : {}),
        ...(event.error ? { error: event.error } : {}),
        stepIndex: event.stepIndex,
        needsApproval: false,
        state: event.denied ? 'denied' : event.error ? 'failed' : 'succeeded',
      };
    case 'approval_resolved':
      return {
        id: `approval:${event.callId}`,
        kind: 'approval',
        callId: event.callId,
        toolName: null,
        stepIndex: event.stepIndex,
        requestedAt: null,
        status: event.approved ? 'approved' : 'denied',
        ...(event.reason ? { reason: event.reason } : {}),
      };
    default:
      return null;
  }
}

/** Foreign CLI sessions are indexed rather than owned by the native loop. Keep
 * both reads bounded: the projection is a context window, never a transcript or
 * telemetry dump endpoint. */
export const FOREIGN_PROJECTION_TRANSCRIPT_LIMIT = 200;
export const FOREIGN_PROJECTION_TOOL_LIMIT = 200;

const FOREIGN_PROJECTION_SOURCE_KINDS = new Set(['claude', 'codex', 'omp']);
const FOREIGN_TASK_TOOL_NAMES = new Set(['todowrite', 'todo_write', 'update_plan']);
const FAILED_TOOL_STATES = new Set(['error', 'errored', 'failed', 'failure', 'timeout', 'timed_out']);

export interface ForeignProjectionTurnRow {
  turn_idx: number;
  speaker: string;
  ts: string | Date | null;
  text: string;
  owner: string | null;
  harness_slug: string | null;
}

export interface ForeignProjectionToolRow {
  id: string | number;
  tool_name: string;
  args_json: unknown;
  status: string | null;
  error_message: string | null;
  invoked_at: string | Date;
  coord_owner_id: string | null;
  goal_ref: string | null;
}

interface ForeignProjectionPresenceRow {
  owner_id: string;
  owner_label: string;
  intent: string;
  current_plan_slug: string | null;
  agent_role: string | null;
  fleet_slug: string | null;
  fleet_role: string | null;
}

interface ForeignProjectionPlanClaimRow {
  plan_slug: string;
  item_id: string;
}

interface ForeignProjectionWorkItemRow {
  feature_id: string;
  title: string;
  status: string | null;
}

interface ForeignProjectionAdvRow {
  coord_owner_id: string | null;
  role: string | null;
  feature: string | null;
  plan_slug: string | null;
  harness_slug: string | null;
  started_at: string | Date;
  ended_at: string | Date | null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isoString(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function nativeToolCall(row: ForeignProjectionToolRow): {
  name: string;
  callId: string;
  input?: unknown;
  status: string | null;
} {
  const args = recordValue(row.args_json) ?? {};
  const wrappedName = nonEmptyString(args.tool_name ?? args.toolName);
  const name = wrappedName ?? row.tool_name;
  const callId = nonEmptyString(
    args.tool_use_id ?? args.toolUseId ?? args.tool_call_id ?? args.toolCallId,
  ) ?? String(row.id);
  const toolInput = recordValue(args.tool_input ?? args.toolInput);
  const todos = Array.isArray(args.todos) ? args.todos : null;
  return {
    name,
    callId,
    ...(toolInput
      ? { input: toolInput }
      : todos
        ? { input: { todos } }
        : {}),
    status: nonEmptyString(args.status) ?? row.status,
  };
}

/** Normalize the already-bounded activity:report telemetry rows into tool
 * cards. The wrapper is deliberately hidden: the producer's native tool name,
 * input and call id are the user-facing ledger. Result bodies are unavailable
 * in this store, so the adapter never invents one. */
export function foreignToolFrames(
  rowsNewestFirst: readonly ForeignProjectionToolRow[],
): ConversationToolFrame[] {
  return [...rowsNewestFirst].reverse().map((row) => {
    const call = nativeToolCall(row);
    const stateText = (call.status ?? '').toLowerCase();
    const failed = Boolean(row.error_message) || FAILED_TOOL_STATES.has(stateText);
    const denied = stateText === 'denied';
    return {
      id: `tool:foreign:${row.id}`,
      kind: 'tool',
      callId: call.callId,
      name: call.name,
      ...(call.input !== undefined ? { input: call.input } : {}),
      ...(row.error_message ? { error: row.error_message } : {}),
      stepIndex: null,
      needsApproval: false,
      state: denied ? 'denied' : failed ? 'failed' : 'succeeded',
    };
  });
}

function snapshotEntries(row: ForeignProjectionToolRow): {
  entries: Array<{ content: string; activeForm: string; status: SessionTask['status'] }>;
  explanation: string | null;
} | null {
  const args = recordValue(row.args_json);
  if (!args) return null;
  const nativeName = nonEmptyString(args.tool_name ?? args.toolName) ?? row.tool_name;
  if (!FOREIGN_TASK_TOOL_NAMES.has(nativeName.toLowerCase())) return null;
  const toolInput = recordValue(args.tool_input ?? args.toolInput);
  const raw = Array.isArray(args.todos)
    ? args.todos
    : Array.isArray(toolInput?.todos)
      ? toolInput.todos
      : Array.isArray(args.plan)
        ? args.plan
        : Array.isArray(toolInput?.plan)
          ? toolInput.plan
          : null;
  if (!raw) return null;

  const entries: Array<{ content: string; activeForm: string; status: SessionTask['status'] }> = [];
  for (const value of raw.slice(0, 100)) {
    const entry = recordValue(value);
    if (!entry) continue;
    const content = nonEmptyString(entry.content ?? entry.step);
    const status = nonEmptyString(entry.status);
    if (!content || (status !== 'pending' && status !== 'in_progress' && status !== 'completed')) continue;
    entries.push({
      content,
      activeForm: nonEmptyString(entry.activeForm) ?? content,
      status,
    });
  }
  const explanation = nonEmptyString(args.explanation ?? toolInput?.explanation);
  return { entries, explanation };
}

/** Read the latest complete TodoWrite/update_plan snapshot from the bounded
 * ledger and project it into canonical, explicitly read-only task frames. */
export function foreignTaskSnapshot(
  rowsNewestFirst: readonly ForeignProjectionToolRow[],
): SessionTask[] {
  for (const row of rowsNewestFirst) {
    const snapshot = snapshotEntries(row);
    if (!snapshot) continue;
    const updatedAt = isoString(row.invoked_at) ?? String(row.invoked_at);
    return snapshot.entries.map((entry, position) => ({
      id: `foreign:${row.id}:${position}`,
      content: entry.content,
      activeForm: entry.activeForm,
      status: entry.status,
      blockerRef: null,
      explanation: snapshot.explanation,
      position,
      createdAt: updatedAt,
      updatedAt,
      links: [],
    }));
  }
  return [];
}

export function foreignTranscript(
  rowsChronological: readonly ForeignProjectionTurnRow[],
): TranscriptTurn[] {
  return rowsChronological.flatMap<TranscriptTurn>((row) => {
    if (row.speaker !== 'user' && row.speaker !== 'assistant') return [];
    return [{
      role: row.speaker,
      content: row.text,
      ts: isoString(row.ts) ?? '',
    }];
  });
}

export function foreignContextFrames(input: {
  sourceKind: string;
  sessionId: string;
  harness: string | null;
  role: string | null;
  ownerId: string | null;
  linkedWorkItemId: string | null;
  presence: ForeignProjectionPresenceRow | null;
  modes: readonly ModeRow[];
  planClaims: readonly ForeignProjectionPlanClaimRow[];
  workItems: readonly ForeignProjectionWorkItemRow[];
}): ConversationContextSectionFrame[] {
  const identityEntries = [
    { label: 'Session', value: input.sessionId },
    { label: 'Source', value: input.sourceKind },
    ...(input.ownerId ? [{ label: 'Agent', value: input.ownerId }] : []),
    ...(input.harness ? [{ label: 'Harness', value: input.harness }] : []),
    ...(input.role ?? input.presence?.agent_role
      ? [{ label: 'Role', value: (input.role ?? input.presence!.agent_role)! }]
      : []),
  ];
  const frames: ConversationContextSectionFrame[] = [{
    id: 'context:identity',
    kind: 'context',
    section: 'identity',
    title: 'Identity',
    entries: identityEntries,
  }];

  if (input.modes.length) {
    frames.push({
      id: 'context:mode',
      kind: 'context',
      section: 'mode',
      title: 'Modes',
      entries: input.modes.map((mode) => ({
        label: 'Mode',
        value: mode.mode,
        state: mode.ownerDirected ? 'owner-directed' : 'active',
      })),
    });
  }

  const intentEntries = [
    ...(input.presence?.intent ? [{ label: 'Intent', value: input.presence.intent }] : []),
    ...(input.linkedWorkItemId
      ? [{ label: 'Linked work item', value: input.linkedWorkItemId }]
      : []),
  ];
  if (intentEntries.length) {
    frames.push({
      id: 'context:intent',
      kind: 'context',
      section: 'intent',
      title: 'Intent',
      entries: intentEntries,
    });
  }

  const planEntries = [
    ...(input.presence?.current_plan_slug
      ? [{ label: 'Current plan', value: input.presence.current_plan_slug }]
      : []),
    ...input.planClaims.map((claim) => ({
      label: 'Claim',
      value: `${claim.plan_slug}#${claim.item_id}`,
      state: 'held',
    })),
  ];
  if (planEntries.length) {
    frames.push({
      id: 'context:plan',
      kind: 'context',
      section: 'plan',
      title: 'Plan',
      entries: planEntries,
    });
  }

  if (input.workItems.length) {
    frames.push({
      id: 'context:held',
      kind: 'context',
      section: 'held',
      title: 'Held work',
      entries: input.workItems.map((item) => ({
        label: item.feature_id,
        value: item.title,
        ...(item.status ? { state: item.status } : {}),
      })),
    });
  }
  return frames;
}

async function readForeignConversationContextProjection(
  args: {
    workspaceId: string;
    sourceKind: string;
    sessionId: string;
    harness?: string;
  },
  sql: Sql,
  loadFleetContext: (
    input: LoadFleetContextFrameInput,
  ) => Promise<ConversationContextSectionFrame | null>,
): Promise<ConversationContextProjection | null> {
  const [advRows, turnRows, toolRows] = await Promise.all([
    sql<ForeignProjectionAdvRow[]>`
      SELECT coord_owner_id, role, feature, plan_slug, harness_slug, started_at, ended_at
        FROM harness_shared.adv_sessions
       WHERE workspace_id = ${args.workspaceId}
         AND (session_id = ${args.sessionId} OR omp_thread_id = ${args.sessionId})
         AND (agent IS NULL OR agent = ${args.sourceKind})
       ORDER BY (session_id = ${args.sessionId}) DESC, started_at DESC
       LIMIT 1`,
    sql<ForeignProjectionTurnRow[]>`
      SELECT turn_idx, speaker, ts, text, owner, harness_slug
        FROM (
          SELECT turn_idx, speaker, ts, left(text, 8000) AS text, owner, harness_slug
            FROM harness_shared.session_turns
           WHERE (workspace_id = ${args.workspaceId} OR workspace_id = 'default')
             AND source_kind = ${args.sourceKind}
             AND session_id = ${args.sessionId}
           ORDER BY turn_idx DESC
           LIMIT ${FOREIGN_PROJECTION_TRANSCRIPT_LIMIT}
        ) recent
       ORDER BY turn_idx ASC`,
    sql<ForeignProjectionToolRow[]>`
      SELECT id, tool_name, args_json, status, error_message, invoked_at,
             coord_owner_id, goal_ref
        FROM harness_shared.tool_invocations
       WHERE (workspace_id = ${args.workspaceId} OR workspace_id = 'default')
         AND tool_name IN ('activity:report', 'activity_report')
         -- These predicates mirror migration 1114's partial index.  They are
         -- logically redundant with the COALESCE equality, but PostgreSQL needs
         -- them stated to prove the partial index covers both producer spellings.
         AND (args_json ? 'session_id' OR args_json ? 'sessionId')
         AND COALESCE(args_json->>'session_id', args_json->>'sessionId') = ${args.sessionId}
       ORDER BY invoked_at DESC, id DESC
       LIMIT ${FOREIGN_PROJECTION_TOOL_LIMIT}`,
  ]);
  const adv = advRows[0] ?? null;
  if (!adv && turnRows.length === 0 && toolRows.length === 0) return null;

  const newestTurn = turnRows.at(-1) ?? null;
  const newestTool = toolRows[0] ?? null;
  const newestToolArgs = newestTool ? recordValue(newestTool.args_json) : null;
  const ownerId = adv?.coord_owner_id
    ?? newestTurn?.owner
    ?? newestTool?.coord_owner_id
    ?? nonEmptyString(newestToolArgs?.owner)
    ?? null;
  const observedHarness = adv?.harness_slug
    ?? newestTurn?.harness_slug
    ?? nonEmptyString(newestToolArgs?.harness_slug ?? newestToolArgs?.harnessSlug)
    ?? null;
  if (args.harness && observedHarness && args.harness !== observedHarness) return null;
  const harness = args.harness ?? observedHarness;
  const linkedWorkItemId = toolRows.find((row) => row.goal_ref)?.goal_ref
    ?? adv?.feature
    ?? null;

  let presence: ForeignProjectionPresenceRow | null = null;
  let modes: ModeRow[] = [];
  let planClaims: ForeignProjectionPlanClaimRow[] = [];
  let workItems: ForeignProjectionWorkItemRow[] = [];
  if (ownerId) {
    const [presenceRows, modeRows, claimRows, heldRows] = await Promise.all([
      sql<ForeignProjectionPresenceRow[]>`
        SELECT owner_id, owner_label, intent, current_plan_slug, agent_role,
               fleet_slug, fleet_role
          FROM harness_shared.coord_presence
         WHERE workspace_id = ${args.workspaceId} AND owner_id = ${ownerId}
         LIMIT 1`.catch(() => [] as ForeignProjectionPresenceRow[]),
      getModes(args.workspaceId, ownerId, sql).catch(() => [] as ModeRow[]),
      sql<ForeignProjectionPlanClaimRow[]>`
        SELECT plan_slug, item_id
          FROM harness_shared.plan_item_claims
         WHERE owner = ${ownerId} AND expires_ts > now()
         ORDER BY plan_slug, item_id`.catch(() => [] as ForeignProjectionPlanClaimRow[]),
      sql<ForeignProjectionWorkItemRow[]>`
        SELECT feature_id, title, status
          FROM harness_shared.work_items
         WHERE workspace_id = ${args.workspaceId} AND taken_by = ${ownerId}
         ORDER BY taken_at DESC NULLS LAST, feature_id`.catch(() => [] as ForeignProjectionWorkItemRow[]),
    ]);
    presence = presenceRows[0] ?? null;
    modes = modeRows;
    planClaims = claimRows;
    workItems = heldRows;
  }

  const context = foreignContextFrames({
    sourceKind: args.sourceKind,
    sessionId: args.sessionId,
    harness,
    role: adv?.role ?? null,
    ownerId,
    linkedWorkItemId,
    presence,
    modes,
    planClaims,
    workItems,
  });
  const fleetContext = ownerId && presence?.fleet_slug
    ? await loadFleetContext({
        workspaceId: args.workspaceId,
        harness,
        ownerId,
        fleetSlug: presence.fleet_slug,
        planSlug: presence.current_plan_slug ?? adv?.plan_slug ?? null,
      }).catch(() => null)
    : null;
  if (fleetContext) {
    const planIndex = context.findIndex((frame) => frame.section === 'plan');
    context.splice(planIndex < 0 ? context.length : planIndex, 0, fleetContext);
  }

  return projectConversationContext({
    sourceKind: args.sourceKind,
    sessionId: args.sessionId,
    harness,
    role: adv?.role ?? presence?.agent_role ?? null,
    linkedWorkItemId,
    transcript: foreignTranscript(turnRows),
    loopSession: null,
    toolFrames: foreignToolFrames(toolRows),
    tasks: foreignTaskSnapshot(toolRows),
    approvals: [],
    context,
  });
}

interface AgentChatProjectionRow {
  id: string;
  harness_slug: string;
  role: string;
  feature_id: string | null;
  linked_plan_slug: string | null;
  su_runtime_class: string | null;
  transcript: TranscriptTurn[] | string | null;
}

/** Canonical query implementation used by both the GUI sync hook and pui's
 * generic named-query client. P-030 extends the source adapters; it must keep
 * this return contract unchanged. */
export async function readConversationContextProjection(args: {
  workspaceId: string;
  sourceKind: string;
  sessionId: string;
  harness?: string;
}, deps: {
  sql?: Sql;
  loadFleetContext?: (
    input: LoadFleetContextFrameInput,
  ) => Promise<ConversationContextSectionFrame | null>;
} = {}): Promise<ConversationContextProjection | null> {
  const sql = deps.sql ?? getOrgPg().sql;
  if (FOREIGN_PROJECTION_SOURCE_KINDS.has(args.sourceKind)) {
    return readForeignConversationContextProjection(
      args,
      sql,
      deps.loadFleetContext ?? loadFleetContextFrame,
    );
  }
  if (args.sourceKind !== 'agent_chat') return null;
  const rows = await sql<AgentChatProjectionRow[]>`
    SELECT chat.id, chat.harness_slug, chat.role, chat.feature_id, chat.transcript,
           chat.su_runtime_class, linked.source_plan_slug AS linked_plan_slug
      FROM harness_shared.agent_chats_consolidated chat
      LEFT JOIN LATERAL (
        SELECT wi.source_plan_slug
          FROM harness_shared.work_items wi
         WHERE wi.workspace_id = chat.workspace_id
           AND wi.feature_id = chat.feature_id
         ORDER BY wi.updated_ts DESC NULLS LAST
         LIMIT 1
      ) linked ON true
     WHERE chat.workspace_id = ${args.workspaceId}
       AND chat.id = ${args.sessionId}
       AND (${args.harness ?? null}::text IS NULL OR chat.harness_slug = ${args.harness ?? null})
     LIMIT 1`;
  const row = rows[0];
  if (!row) return null;
  const transcript = Array.isArray(row.transcript)
    ? row.transcript
    : typeof row.transcript === 'string'
      ? (JSON.parse(row.transcript) as TranscriptTurn[])
      : [];
  const [loopSession, approvals, taskResult, registry] = await Promise.all([
    loadLoopSession({ chatId: row.id, workspaceId: args.workspaceId }, { sql }),
    listPendingLoopApprovals({ chatId: row.id, workspaceId: args.workspaceId }, { sql }),
    applySessionTaskOp(sql, {
      workspaceId: args.workspaceId,
      sessionId: row.id,
      op: 'view',
      idFactory: () => 'unused-on-view',
    }),
    loadHarnessRegistry(args.workspaceId),
  ]);
  const harnessPath = resolveHarnessContentPath(registry, row.harness_slug);
  const reconciledTasks = await reconcileSessionTaskBlockers(sql, {
    workspaceId: args.workspaceId,
    harness: row.harness_slug,
    planSlug: row.linked_plan_slug,
    coordinationDomain: harnessPath ? lockDomainForProjectDir(harnessPath) : null,
    sessionId: row.id,
    tasks: taskResult.tasks,
    idFactory: () => 'unused-on-reconcile',
  });
  return projectConversationContext({
    sourceKind: args.sourceKind,
    sessionId: row.id,
    harness: row.harness_slug,
    role: row.role,
    linkedWorkItemId: row.feature_id,
    transcript,
    loopSession,
    suSessionChat: row.su_runtime_class === 'su-session',
    tasks: reconciledTasks.tasks,
    taskBlockerStates: reconciledTasks.states,
    approvals,
  });
}
