/**
 * One append-only history for facts learned ABOUT a goal and amendments made
 * TO it. The established workspace audit_log is the store: goal history is a
 * projection, not a second ledger or a mutable metadata array.
 */

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { GoalSqlTag } from './_core';

export const GOAL_EVIDENCE_ACTION = 'goal:evidence';
export const GOAL_AMENDMENT_ACTION = 'goal:amendment';
/** Durable provenance for goal mutations performed outside a dispatched goal session. */
export const GOAL_WRITE_ACTION = 'goal:write';
export const GOAL_HISTORY_LIMIT = 100;
/** Raw ids retained beyond an inline history page so a bounded projection can
 * disclose and later recover what it omitted. Kept separate from the entry
 * limit: ids are cheap, but their bodies are not. */
export const GOAL_HISTORY_OMITTED_REF_LIMIT = 200;

export interface GoalFieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface GoalEvidenceDetail {
  kind: 'evidence' | 'finding';
  summary: string;
  detail?: string;
  refs?: string[];
}

export interface GoalWriteDetail {
  kind: 'write';
  writeKind: string;
  actorClass: string;
  detail?: string;
  refs?: string[];
}

export type GoalHistoryDetail =
  | { kind: 'amendment'; reason: string; reasonSource: 'caller' | 'generated'; changes: GoalFieldChange[] }
  | GoalEvidenceDetail
  | GoalWriteDetail;

export interface GoalHistoryEntry {
  id: string;
  kind: 'amendment' | 'evidence' | 'finding' | 'write';
  author: string;
  at: string;
  reason?: string;
  reasonSource?: 'caller' | 'generated';
  changes?: GoalFieldChange[];
  summary?: string;
  detail?: string;
  refs?: string[];
  writeKind?: string;
  actorClass?: string;
}

export interface GoalHistoryRead {
  entries: GoalHistoryEntry[];
  truncated: boolean;
  limit: number;
  /** Stable audit-log ids beyond `entries`, newest-first and independently bounded. */
  omittedEntryIds: string[];
  /** True when even the cheap omitted-id page could not name the whole tail. */
  omittedEntryIdsTruncated: boolean;
}

/** Add one field only when its persisted semantic value really moved. */
export function addGoalFieldChange(
  changes: GoalFieldChange[],
  field: string,
  before: unknown,
  after: unknown,
): void {
  const normalizedBefore = before ?? null;
  const normalizedAfter = after ?? null;
  if (!isDeepStrictEqual(normalizedBefore, normalizedAfter)) {
    changes.push({ field, before: normalizedBefore, after: normalizedAfter });
  }
}

export async function appendGoalHistory(
  sql: GoalSqlTag,
  input: {
    workspaceId: string;
    goalId: string;
    author: string;
    detail: GoalHistoryDetail;
    atMs?: number;
    id?: string;
  },
): Promise<GoalHistoryEntry> {
  const atMs = input.atMs ?? Date.now();
  const id = input.id ?? `goal-${randomUUID()}`;
  const action =
    input.detail.kind === 'amendment'
      ? GOAL_AMENDMENT_ACTION
      : input.detail.kind === 'write'
        ? GOAL_WRITE_ACTION
        : GOAL_EVIDENCE_ACTION;
  await sql`
    INSERT INTO harness_shared.audit_log
      (id, ts, actor, action, subject, details, workspace_id)
    VALUES
      (${id}, ${atMs}, ${input.author}, ${action}, ${input.goalId}, ${JSON.stringify(input.detail)}::jsonb, ${input.workspaceId})
  `;
  return historyEntry({ id, ts: atMs, actor: input.author, action, details: input.detail });
}

interface GoalHistoryRow {
  id: string;
  ts: number | string;
  actor: string;
  action: string;
  details: unknown;
}

function objectOf(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

function historyEntry(row: GoalHistoryRow): GoalHistoryEntry {
  const d = objectOf(row.details);
  const atMs = Number(row.ts);
  const at = Number.isFinite(atMs) ? new Date(atMs).toISOString() : new Date(0).toISOString();
  if (row.action === GOAL_AMENDMENT_ACTION) {
    return {
      id: row.id,
      kind: 'amendment',
      author: row.actor,
      at,
      reason: typeof d.reason === 'string' ? d.reason : 'not recorded',
      reasonSource: d.reasonSource === 'caller' ? 'caller' : 'generated',
      changes: Array.isArray(d.changes) ? (d.changes as GoalFieldChange[]) : [],
    };
  }
  if (row.action === GOAL_WRITE_ACTION) {
    return {
      id: row.id,
      kind: 'write',
      author: row.actor,
      at,
      writeKind: typeof d.writeKind === 'string' ? d.writeKind : 'unknown',
      actorClass: typeof d.actorClass === 'string' ? d.actorClass : 'unknown',
      ...(typeof d.detail === 'string' ? { detail: d.detail } : {}),
      ...(Array.isArray(d.refs) ? { refs: d.refs.filter((r): r is string => typeof r === 'string') } : {}),
    };
  }
  const kind = d.kind === 'finding' ? 'finding' : 'evidence';
  return {
    id: row.id,
    kind,
    author: row.actor,
    at,
    summary: typeof d.summary === 'string' ? d.summary : '',
    ...(typeof d.detail === 'string' ? { detail: d.detail } : {}),
    ...(Array.isArray(d.refs) ? { refs: d.refs.filter((r): r is string => typeof r === 'string') } : {}),
  };
}

export async function readGoalHistory(
  sql: GoalSqlTag,
  input: { workspaceId: string; goalId: string; limit?: number },
): Promise<GoalHistoryRead> {
  const limit = Math.max(1, Math.min(input.limit ?? GOAL_HISTORY_LIMIT, GOAL_HISTORY_LIMIT));
  // One bounded read supplies both bodies for the inline page and cheap stable ids
  // for its tail. The +1 is the exhaustion sentinel: without it, an exactly-full
  // ref page is indistinguishable from a complete one.
  const fetchLimit = limit + GOAL_HISTORY_OMITTED_REF_LIMIT + 1;
  const rows = await sql<GoalHistoryRow[]>`
    SELECT id, ts, actor, action, details
      FROM harness_shared.audit_log
     WHERE workspace_id = ${input.workspaceId}
       AND subject = ${input.goalId}
       AND action = ANY(${[GOAL_AMENDMENT_ACTION, GOAL_EVIDENCE_ACTION, GOAL_WRITE_ACTION]}::text[])
     ORDER BY ts DESC, id DESC
     LIMIT ${fetchLimit}
  `;
  const omittedEntryIds = rows
    .slice(limit, limit + GOAL_HISTORY_OMITTED_REF_LIMIT)
    .map((row) => row.id);
  return {
    entries: rows.slice(0, limit).map(historyEntry),
    truncated: rows.length > limit,
    limit,
    omittedEntryIds,
    omittedEntryIdsTruncated: rows.length > limit + omittedEntryIds.length,
  };
}

/** Exact bounded drill-down for raw goal-history refs. The audit log is append-only,
 * so an id remains a stable source even after newer rows move it outside a page. */
export async function readGoalHistoryEntriesByIds(
  sql: GoalSqlTag,
  input: { workspaceId: string; goalId: string; ids: readonly string[] },
): Promise<GoalHistoryEntry[]> {
  const ids = [...new Set(input.ids.filter((id) => typeof id === 'string' && id.trim()))].slice(0, 20);
  if (!ids.length) return [];
  const rows = await sql<GoalHistoryRow[]>`
    SELECT id, ts, actor, action, details
      FROM harness_shared.audit_log
     WHERE workspace_id = ${input.workspaceId}
       AND subject = ${input.goalId}
       AND id = ANY(${ids}::text[])
       AND action = ANY(${[GOAL_AMENDMENT_ACTION, GOAL_EVIDENCE_ACTION, GOAL_WRITE_ACTION]}::text[])
     ORDER BY ts DESC, id DESC
  `;
  return rows.map(historyEntry);
}
