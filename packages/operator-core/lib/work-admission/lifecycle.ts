/**
 * Admission lifecycle rules (linear-asana-task-sync-2026-10-05 P-003, plan D-009).
 *
 * OUTBOUND — what Papercusp tells the source of an admitted work item, once per event:
 *   claim                → move the source to `in-progress` and comment who picked it up;
 *   needs-human/blocked  → comment the question the item is waiting on;
 *   completion           → comment the completion summary and move the source to the rule's
 *                          completion category (`done` by default, owner answer #1417).
 * {@link reconcileAdmissionLifecycle} plans these from the work item's current state for every
 * admission of one data source. The connector runtime calls it after each successful sync pass of
 * that source, so polling stays the source of truth (D-003) and a push wake (P-008) reaches it by
 * waking the source. Every event is ledgered under a lifecycle key (write-back-ledger.ts); a
 * re-run, a second host or a crash before the next pass never writes an event twice. A source
 * that lacks a capability (GitHub has no workflow columns, D-008) is skipped, not failed.
 *
 * INBOUND — what Papercusp does when the source changes under it ({@link applySourceLifecycle},
 * called by the admission sink for every delivered record):
 *   closed or canceled outside, item unclaimed → drop the item, naming who closed it;
 *   closed or canceled outside, item claimed   → a computed `source-closed` hold that names the
 *                                                holder as the one who clears it, plus a coord
 *                                                message to the holder (unified-bug-pipeline
 *                                                D-005/D-006); it clears itself on reopen;
 *   reopened outside, item finished            → if the admitting rule still matches, reopen it.
 * A close or a reopen is a CHANGE between two deliveries (work_admissions.source_category), never a
 * standing state. So a source that cannot move (GitHub) never "reopens" an item Papercusp finished,
 * and Papercusp's own move to `done` is not mistaken for an outside close (the item is already
 * finished when that move is observed).
 */

import { createHash } from 'node:crypto';
import {
  getWorkItem as defaultGetWorkItem,
  mergeWorkItemPayload as defaultMergeWorkItemPayload,
  setWorkItemStateWithAliasInfo as defaultSetWorkItemState,
  TERMINAL_WORK_ITEM_STATES,
} from '../work-items';
import { activeExternalBlockers, applyExternalBlockerUpdate } from '../external-blockers';
import { isTicketStatusCategory, type TicketStatusCategory } from '../data-sources/ticket-vocabulary';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import type { AdmissionDb } from './admission-sources';
import {
  ADMISSION_WRITE_BACK_MAX,
  transitionAdmission as defaultTransitionAdmission,
  writeBackAdmission as defaultWriteBackAdmission,
  type WriteBackDeps,
} from './admit';
import { matchAdmissionRule, type AdmissionMatch } from './admission-rules';
import { lifecycleKeysByAdmission } from './write-back-ledger';
import { resolveAdmissionLifecycle, type AdmissionLifecycle } from './lifecycle-config';

/** Who the lifecycle rules act as, in work-item history and coord messages. */
export const ADMISSION_LIFECYCLE_ACTOR = 'system:work-admission';

/** The external-blocker ref of the computed hold for one admitted record. */
export function sourceClosedRef(recordId: string): string {
  return `source-closed:${recordId}`;
}

/** Most admissions one reconcile pass reads for a data source. */
export const LIFECYCLE_RECONCILE_MAX = 500;

const COMPLETED_STATES: ReadonlySet<string> = new Set(['done', 'resolved', 'closed']);
const HOLD_STATES: ReadonlySet<string> = new Set(['needs-human', 'blocked']);
const CLOSED_CATEGORIES: ReadonlySet<string> = new Set(['done', 'canceled']);
/** A source that cannot do a write answers with one of these; the write is skipped, not failed. */
const UNSUPPORTED_CODES: ReadonlySet<string> = new Set([
  'provider_capability_unsupported',
  'transition_unsupported',
  'write_back_unsupported',
]);

/** The part of a work item the lifecycle rules read. */
export interface LifecycleWorkItem {
  id: string;
  state: string;
  assignee: string | null;
  closedAt: string | null;
  payload: unknown;
}

export type LifecycleWrite =
  | { key: string; action: 'comment'; text: string }
  | { key: string; action: 'transition'; toCategory: TicketStatusCategory };

const isTerminal = (state: string) => TERMINAL_WORK_ITEM_STATES.includes(state);

function shortHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function completionSummaryOf(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const evidence = (payload as Record<string, unknown>)._completionEvidence;
  const summary = evidence && typeof evidence === 'object' ? (evidence as Record<string, unknown>).summary : undefined;
  return typeof summary === 'string' ? summary.trim() : '';
}

/**
 * The question a held item is waiting on, from its active blockers. Null when the hold is
 * Papercusp's own source-closed hold: the source closed the ticket, so telling it is pointless.
 */
function holdQuestionOf(item: LifecycleWorkItem): string | null {
  const active = activeExternalBlockers(item.payload);
  if (active.some((b) => b.ref.startsWith('source-closed:'))) return null;
  const asks = active
    .map((b) => [b.summary, b.nextVerb].filter((s) => s && s.trim()).join(' Next: '))
    .filter(Boolean);
  if (asks.length > 0) return asks.join('\n');
  return item.state === 'needs-human' ? 'It needs a decision from a person before it can continue.' : 'It is blocked.';
}

/**
 * The writes the item's current state calls for that have not been written yet (`written` holds
 * the lifecycle keys already in the ledger). Pure; the order is the order they are sent.
 */
export function planLifecycleWrites(
  item: LifecycleWorkItem,
  lifecycle: AdmissionLifecycle,
  written: ReadonlySet<string>,
): LifecycleWrite[] {
  const writes: LifecycleWrite[] = [];
  if (COMPLETED_STATES.has(item.state)) {
    if (lifecycle.complete) {
      const stamp = item.closedAt ?? 'closed';
      const summary = completionSummaryOf(item.payload);
      const head = `Completed in Papercusp (${item.id}).`;
      const text = summary ? `${head}\n\n${clip(summary, ADMISSION_WRITE_BACK_MAX - head.length - 2)}` : head;
      writes.push({ key: `complete:${stamp}`, action: 'comment', text });
      writes.push({ key: `complete:${stamp}:move`, action: 'transition', toCategory: lifecycle.completeCategory });
    }
  } else if (!isTerminal(item.state)) {
    if (lifecycle.claim && item.assignee) {
      writes.push({ key: `claim:${item.assignee}:move`, action: 'transition', toCategory: 'in-progress' });
      writes.push({
        key: `claim:${item.assignee}`,
        action: 'comment',
        text: `Picked up in Papercusp as ${item.id}; ${item.assignee} is working on it.`,
      });
    }
    const question = lifecycle.hold && HOLD_STATES.has(item.state) ? holdQuestionOf(item) : null;
    if (question) {
      const head = `Papercusp is waiting on this (${item.id}): `;
      writes.push({
        key: `hold:${item.state}:${shortHash(question)}`,
        action: 'comment',
        text: `${head}${clip(question, ADMISSION_WRITE_BACK_MAX - head.length)}`,
      });
    }
  }
  return writes.filter((w) => !written.has(w.key));
}

export interface LifecycleDeps {
  getWorkItem?: (id: string, harness: string) => Promise<LifecycleWorkItem | null>;
  writeBack?: typeof defaultWriteBackAdmission;
  transition?: typeof defaultTransitionAdmission;
  /** The source resolver lookup handed to the write-back verbs (tests inject a registry). */
  resolverFor?: WriteBackDeps['resolverFor'];
  setState?: (id: string, state: string, opts: { harness: string; by: string; completionRef?: string }) => Promise<unknown>;
  mergePayload?: (id: string, patch: Record<string, unknown>, opts: { harness: string }) => Promise<unknown>;
  /** Tells the holder of a claimed item that its source was closed (coord message by default). */
  notifyHolder?: (input: { workspaceId: string; holder: string; workItemId: string; summary: string; body: string }) => Promise<void>;
}

export interface LifecycleReconcileResult {
  workItems: number;
  written: Array<{ workItemId: string; key: string }>;
  skipped: Array<{ workItemId: string; key: string; code: string }>;
  failed: Array<{ workItemId: string; key?: string; error: string }>;
}

interface AdmissionLifecycleRow {
  id: string;
  work_item_id: string;
  harness_slug: string;
  lifecycle: unknown;
}

/**
 * Writes back to one data source every lifecycle event its admitted work items have reached and
 * the ledger does not yet hold. Safe to run as often as the source syncs.
 */
export async function reconcileAdmissionLifecycle(
  sql: AdmissionDb,
  input: { workspaceId: string; dataSourceId: string },
  deps: LifecycleDeps = {},
): Promise<LifecycleReconcileResult> {
  const getItem = deps.getWorkItem ?? ((id: string, harness: string) => defaultGetWorkItem(id, harness));
  const writeBack = deps.writeBack ?? defaultWriteBackAdmission;
  const transition = deps.transition ?? defaultTransitionAdmission;
  const rows = await sql<AdmissionLifecycleRow[]>`
    SELECT a.id::text AS id, a.work_item_id, a.harness_slug, r.lifecycle
      FROM harness_shared.work_admissions a
      LEFT JOIN harness_shared.admission_rules r ON r.workspace_id = a.workspace_id AND r.id = a.rule_id
     WHERE a.workspace_id = ${input.workspaceId} AND a.data_source_id = ${input.dataSourceId}::uuid
     ORDER BY a.created_at, a.id
     LIMIT ${LIFECYCLE_RECONCILE_MAX}`;
  // One work item can carry several admissions; the write-back verbs ledger under the first, so
  // the keys already written are the union over all of them.
  const byItem = new Map<string, { harness: string; lifecycle: unknown; admissionIds: string[] }>();
  for (const r of rows) {
    const entry = byItem.get(r.work_item_id) ?? { harness: r.harness_slug, lifecycle: r.lifecycle, admissionIds: [] };
    entry.admissionIds.push(r.id);
    byItem.set(r.work_item_id, entry);
  }
  const keys = await lifecycleKeysByAdmission(sql, input.workspaceId, rows.map((r) => r.id));
  const result: LifecycleReconcileResult = { workItems: byItem.size, written: [], skipped: [], failed: [] };
  for (const [workItemId, entry] of byItem) {
    const written = new Set(entry.admissionIds.flatMap((id) => [...(keys.get(id) ?? [])]));
    let item: LifecycleWorkItem | null;
    try {
      item = await getItem(workItemId, entry.harness);
    } catch (err) {
      result.failed.push({ workItemId, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (!item) continue;
    for (const write of planLifecycleWrites(item, resolveAdmissionLifecycle(entry.lifecycle), written)) {
      const verbDeps: WriteBackDeps = { lifecycleKey: write.key, ...(deps.resolverFor ? { resolverFor: deps.resolverFor } : {}) };
      try {
        const res =
          write.action === 'comment'
            ? await writeBack(input.workspaceId, workItemId, write.text, sql, verbDeps)
            : await transition(input.workspaceId, workItemId, write.toCategory, sql, verbDeps);
        if (res.ok) result.written.push({ workItemId, key: write.key });
        else if (UNSUPPORTED_CODES.has(res.code)) result.skipped.push({ workItemId, key: write.key, code: res.code });
        else result.failed.push({ workItemId, key: write.key, error: `${res.code}: ${res.message}` });
      } catch (err) {
        // One source's outage must not stop the rest of the pass; the event stays unwritten and
        // the next pass tries it again.
        result.failed.push({ workItemId, key: write.key, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return result;
}

/** The source's workflow category from a canonical ticket payload, or null when it is not a ticket. */
export function sourceCategoryOf(payload: Record<string, unknown>): TicketStatusCategory | null {
  const category = payload.statusCategory;
  if (typeof category === 'string' && isTicketStatusCategory(category)) return category;
  if (payload.state === 'closed') return 'done';
  if (payload.state === 'open') return 'todo';
  return null;
}

function actorName(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    for (const k of ['name', 'displayName', 'login', 'email']) {
      if (typeof v[k] === 'string' && (v[k] as string).trim()) return (v[k] as string).trim();
    }
  }
  return null;
}

/** "who closed it", from the canonical ticket payload when the provider reports it. */
function closerOf(payload: Record<string, unknown>): string {
  const provider = typeof payload.provider === 'string' && payload.provider ? payload.provider : 'the source';
  const who = actorName(payload.closedBy) ?? actorName(payload.statusChangedBy) ?? actorName(payload.updatedBy);
  return who ? `${who} in ${provider}` : `someone in ${provider}`;
}

function ticketLabel(payload: Record<string, unknown>): string {
  for (const k of ['identifier', 'externalId']) {
    if (typeof payload[k] === 'string' && (payload[k] as string).trim()) return (payload[k] as string).trim();
  }
  return 'the ticket';
}

interface SourceAdmissionRow {
  id: string;
  work_item_id: string;
  harness_slug: string;
  source_category: string | null;
  rule_id: string | null;
  lifecycle: unknown;
  rule_match: AdmissionMatch | null;
  rule_enabled: boolean | null;
}

export type SourceLifecycleAction =
  | 'dropped'
  | 'held'
  | 'hold-cleared'
  | 'reopened';

export interface SourceLifecycleResult {
  category: TicketStatusCategory | null;
  actions: Array<{ workItemId: string; action: SourceLifecycleAction }>;
}

const SYSTEM_IDENTITY = (workspaceId: string): AgentIdentity => ({
  ownerId: ADMISSION_LIFECYCLE_ACTOR,
  ownerLabel: 'system · work-admission',
  source: 'principal',
  workspaceId,
  userId: null,
});

async function defaultNotifyHolder(input: {
  workspaceId: string;
  holder: string;
  workItemId: string;
  summary: string;
  body: string;
}): Promise<void> {
  const { sendMessage } = await import('../agent-tools/coordination/messages');
  await sendMessage(SYSTEM_IDENTITY(input.workspaceId), {
    to: [input.holder],
    summary: input.summary,
    body: input.body,
    expectsReply: false,
  } as never);
}

/**
 * Applies an outside change of a record's workflow category to the work items admitted from it,
 * then remembers the category for the next delivery. Called by the admission sink after rule
 * evaluation, for new and updated records alike.
 */
export async function applySourceLifecycle(
  sql: AdmissionDb,
  input: { workspaceId: string; recordId: string; payload: Record<string, unknown> },
  deps: LifecycleDeps = {},
): Promise<SourceLifecycleResult> {
  const category = sourceCategoryOf(input.payload);
  const result: SourceLifecycleResult = { category, actions: [] };
  if (!category) return result;
  const getItem = deps.getWorkItem ?? ((id: string, harness: string) => defaultGetWorkItem(id, harness));
  const setState =
    deps.setState ?? ((id: string, state: string, opts: { harness: string; by: string; completionRef?: string }) => defaultSetWorkItemState(id, state, opts));
  const mergePayload = deps.mergePayload ?? ((id: string, patch: Record<string, unknown>, opts: { harness: string }) => defaultMergeWorkItemPayload(id, patch, opts));
  const notifyHolder = deps.notifyHolder ?? defaultNotifyHolder;
  const rows = await sql<SourceAdmissionRow[]>`
    SELECT a.id::text AS id, a.work_item_id, a.harness_slug, a.source_category, a.rule_id::text AS rule_id,
           r.lifecycle, r.match AS rule_match, r.enabled AS rule_enabled
      FROM harness_shared.work_admissions a
      LEFT JOIN harness_shared.admission_rules r ON r.workspace_id = a.workspace_id AND r.id = a.rule_id
     WHERE a.workspace_id = ${input.workspaceId} AND a.source_kind = 'record' AND a.source_key = ${input.recordId}
     ORDER BY a.created_at, a.id`;
  const closed = CLOSED_CATEGORIES.has(category);
  const ref = sourceClosedRef(input.recordId);
  for (const row of rows) {
    const lifecycle = resolveAdmissionLifecycle(row.lifecycle);
    const previous = row.source_category;
    const becameClosed = previous !== null && !CLOSED_CATEGORIES.has(previous) && closed;
    const becameOpen = previous !== null && CLOSED_CATEGORIES.has(previous) && !closed;
    const item = await getItem(row.work_item_id, row.harness_slug);
    if (item) {
      const terminal = isTerminal(item.state);
      const holding = activeExternalBlockers(item.payload).some((b) => b.ref === ref);
      if (!terminal && closed && lifecycle.externalClose && becameClosed && !item.assignee) {
        await setState(item.id, 'dropped', {
          harness: row.harness_slug,
          by: ADMISSION_LIFECYCLE_ACTOR,
          completionRef: `source closed: ${ticketLabel(input.payload)} was moved to ${category} by ${closerOf(input.payload)}`,
        });
        result.actions.push({ workItemId: item.id, action: 'dropped' });
      } else if (!terminal && closed && lifecycle.externalClose && item.assignee && !holding && (becameClosed || previous === null)) {
        // A claimed item is never dropped under its holder: it is held, and the holder decides.
        const summary =
          `${ticketLabel(input.payload)} was moved to ${category} by ${closerOf(input.payload)} while ${item.assignee} holds ${item.id}. ` +
          `${item.assignee} clears this: finish and complete it, or drop it. It clears itself if the ticket is reopened.`;
        const update = applyExternalBlockerUpdate(
          item.payload,
          { kind: 'event', capability: 'live-dependency', ref, summary, nextVerb: 'work_items:complete or work_items:set_state { state: "dropped" }' },
          ADMISSION_LIFECYCLE_ACTOR,
          { autoAuthority: false },
        );
        await mergePayload(item.id, { externalBlockers: update.blockers }, { harness: row.harness_slug });
        await setState(item.id, 'blocked', { harness: row.harness_slug, by: ADMISSION_LIFECYCLE_ACTOR });
        try {
          await notifyHolder({
            workspaceId: input.workspaceId,
            holder: item.assignee,
            workItemId: item.id,
            summary: `${item.id}: its source ${ticketLabel(input.payload)} was closed outside Papercusp`,
            body: summary,
          });
        } catch {
          // The hold on the item is the durable signal; the message is a courtesy wake.
        }
        result.actions.push({ workItemId: item.id, action: 'held' });
      } else if (!terminal && !closed && holding) {
        const update = applyExternalBlockerUpdate(item.payload, { kind: 'event', ref, clear: true }, ADMISSION_LIFECYCLE_ACTOR, {
          autoAuthority: false,
        });
        await mergePayload(item.id, { externalBlockers: update.blockers }, { harness: row.harness_slug });
        const othersActive = activeExternalBlockers({ externalBlockers: update.blockers }).length > 0;
        if (!othersActive && item.state === 'blocked') {
          await setState(item.id, item.assignee ? 'wip' : 'open', { harness: row.harness_slug, by: ADMISSION_LIFECYCLE_ACTOR });
        }
        result.actions.push({ workItemId: item.id, action: 'hold-cleared' });
      } else if (terminal && becameOpen && lifecycle.reopen && row.rule_id && row.rule_enabled && row.rule_match) {
        if (matchAdmissionRule(row.rule_match, input.payload)) {
          await setState(item.id, 'open', { harness: row.harness_slug, by: ADMISSION_LIFECYCLE_ACTOR });
          result.actions.push({ workItemId: item.id, action: 'reopened' });
        }
      }
    }
    if (previous !== category) {
      await sql`
        UPDATE harness_shared.work_admissions SET source_category = ${category}
         WHERE workspace_id = ${input.workspaceId} AND id = ${row.id}::uuid`;
    }
  }
  return result;
}

