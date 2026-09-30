/**
 * Repeated recovery-only cycle detection for fleet leaders.
 *
 * A cycle is the interval between two successful `loop:checkpoint` post rows.
 * The completed-call ledger (`agent_activity`) is authoritative for outcomes but
 * can miss a client transcript call; the faithful transcript store
 * (`session_turn_parts`) sees those calls but has no outcome. A cycle is therefore
 * classifiable only when BOTH stores observed the same number of calls. Unknown
 * coverage is deliberately silent: a diagnostic intervention may be late, but it
 * must never accuse useful work on a partial read.
 *
 * This module owns no state. It reads a bounded, three-cycle window from existing
 * stores in one batched query and returns a pure classification to the existing
 * fleet transition sweep and leader brief.
 */

import { getOrgPg } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import { resolveConcreteWorkspaceId } from './workspace-registry';

export const REPEATED_RECOVERY_BOUNDARY_LIMIT = 4;
export const REPEATED_RECOVERY_CYCLE_LIMIT = REPEATED_RECOVERY_BOUNDARY_LIMIT - 1;
export const REPEATED_RECOVERY_MEMBER_LIMIT = 200;
export const REPEATED_RECOVERY_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * Intentionally narrow. Generic file/shell/search reads are NOT recovery calls:
 * they can be substantive investigation and must reset the streak. Likewise a
 * real event wait is protected work, not recovery churn.
 */
export const RECOVERY_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  'coord_whoami',
  'coord_orient',
  'coord_declare_intent',
  'work_items_get',
  'work_items_claim',
  'plan_items_claim',
  'sessions_read',
  'sessions_search',
  'loop_checkpoint',
  'work_items_checkpoint',
  'session_request_compaction',
  'set_compaction_limit',
]);

export function normalizeRecoveryToolName(toolName: string): string {
  return toolName
    .trim()
    .toLowerCase()
    .replace(/^mcp__.*__/, '')
    .replace(/[:._-]+/g, '_');
}

export function isRecoveryOnlyTool(toolName: string): boolean {
  return RECOVERY_ONLY_TOOL_NAMES.has(normalizeRecoveryToolName(toolName));
}

export interface RepeatedRecoveryCycleObservation {
  ownerId: string;
  /** 1 is the newest completed cycle, 2 the one before it. */
  cycleIndex: number;
  startedAtMs: number;
  endedAtMs: number;
  activityCallCount: number;
  transcriptCallCount: number;
  activityUnnamedCount: number;
  transcriptUnnamedCount: number;
  /** Distinct tool names are sufficient: every occurrence shares one name. */
  activityTools: readonly string[];
  transcriptTools: readonly string[];
}

export type RepeatedRecoveryUnknownReason =
  | 'insufficient-boundaries'
  | 'incomplete-coverage'
  | 'malformed-observation'
  | 'member-limit-exceeded';

export type RepeatedRecoverySuppressionReason = 'registered-leader' | 'progressing-claim';

export type RepeatedRecoveryState =
  | {
      status: 'measured';
      consecutiveRecoveryOnlyCycles: number;
      observedCycles: number;
    }
  | {
      status: 'unknown';
      consecutiveRecoveryOnlyCycles: null;
      reason: RepeatedRecoveryUnknownReason;
    }
  | {
      status: 'suppressed';
      consecutiveRecoveryOnlyCycles: null;
      reason: RepeatedRecoverySuppressionReason;
    };

export interface RepeatedRecoveryMember {
  ownerId: string;
  /** The durable fleet registry says this member is the leader. */
  isRegisteredLeader?: boolean;
  /** At least one current claim has canonical activity='progressing'. */
  hasProgressingClaim?: boolean;
}

/**
 * PURE: classify newest-to-oldest cycles until useful work resets the streak.
 * Any incomplete cycle needed to establish the streak makes the result unknown.
 */
export function classifyRepeatedRecoveryCycles(
  cycles: readonly RepeatedRecoveryCycleObservation[],
): RepeatedRecoveryState {
  if (cycles.length === 0) {
    return { status: 'unknown', consecutiveRecoveryOnlyCycles: null, reason: 'insufficient-boundaries' };
  }

  const ordered = [...cycles].sort((a, b) => a.cycleIndex - b.cycleIndex);
  let streak = 0;
  for (const cycle of ordered.slice(0, REPEATED_RECOVERY_CYCLE_LIMIT)) {
    if (
      !Number.isSafeInteger(cycle.cycleIndex) ||
      cycle.cycleIndex < 1 ||
      !Number.isFinite(cycle.startedAtMs) ||
      !Number.isFinite(cycle.endedAtMs) ||
      cycle.endedAtMs <= cycle.startedAtMs ||
      !Number.isSafeInteger(cycle.activityCallCount) ||
      !Number.isSafeInteger(cycle.transcriptCallCount) ||
      cycle.activityCallCount < 1 ||
      cycle.transcriptCallCount < 1 ||
      !Number.isSafeInteger(cycle.activityUnnamedCount) ||
      !Number.isSafeInteger(cycle.transcriptUnnamedCount) ||
      cycle.activityUnnamedCount < 0 ||
      cycle.transcriptUnnamedCount < 0
    ) {
      return { status: 'unknown', consecutiveRecoveryOnlyCycles: null, reason: 'malformed-observation' };
    }
    if (
      cycle.activityCallCount !== cycle.transcriptCallCount ||
      cycle.activityUnnamedCount > 0 ||
      cycle.transcriptUnnamedCount > 0 ||
      cycle.activityTools.length === 0 ||
      cycle.transcriptTools.length === 0
    ) {
      return { status: 'unknown', consecutiveRecoveryOnlyCycles: null, reason: 'incomplete-coverage' };
    }

    const recoveryOnly =
      cycle.activityTools.every(isRecoveryOnlyTool) && cycle.transcriptTools.every(isRecoveryOnlyTool);
    if (!recoveryOnly) {
      return { status: 'measured', consecutiveRecoveryOnlyCycles: streak, observedCycles: cycle.cycleIndex };
    }
    streak += 1;
  }
  return { status: 'measured', consecutiveRecoveryOnlyCycles: streak, observedCycles: ordered.length };
}

/** PURE: apply the intervention exclusions before exposing a classification. */
export function classifyRepeatedRecoveryByMember(
  members: readonly RepeatedRecoveryMember[],
  cycles: readonly RepeatedRecoveryCycleObservation[],
): Map<string, RepeatedRecoveryState> {
  const byOwner = new Map<string, RepeatedRecoveryCycleObservation[]>();
  for (const cycle of cycles) {
    const rows = byOwner.get(cycle.ownerId) ?? [];
    rows.push(cycle);
    byOwner.set(cycle.ownerId, rows);
  }

  return new Map(
    members.map((member) => {
      if (member.isRegisteredLeader) {
        return [
          member.ownerId,
          { status: 'suppressed', consecutiveRecoveryOnlyCycles: null, reason: 'registered-leader' },
        ] as const;
      }
      if (member.hasProgressingClaim) {
        return [
          member.ownerId,
          { status: 'suppressed', consecutiveRecoveryOnlyCycles: null, reason: 'progressing-claim' },
        ] as const;
      }
      return [member.ownerId, classifyRepeatedRecoveryCycles(byOwner.get(member.ownerId) ?? [])] as const;
    }),
  );
}

export interface RepeatedRecoveryAlert {
  consecutiveRecoveryOnlyCycles: number;
  action: 'diagnose';
  takeoverAuthorized: false;
  guidance: string;
}

export const REPEATED_RECOVERY_GUIDANCE =
  'Inspect the actual blocker and the member\'s last useful artifact; repair or re-scope the work, or park it on a real event with a bounded timeout. Do not kill, reclaim, duplicate, or widen authority from this diagnostic alone.';

export function repeatedRecoveryAlert(state: RepeatedRecoveryState | null | undefined): RepeatedRecoveryAlert | null {
  if (state?.status !== 'measured' || state.consecutiveRecoveryOnlyCycles < 2) return null;
  return {
    consecutiveRecoveryOnlyCycles: state.consecutiveRecoveryOnlyCycles,
    action: 'diagnose',
    takeoverAuthorized: false,
    guidance: REPEATED_RECOVERY_GUIDANCE,
  };
}

interface RepeatedRecoverySqlRow {
  owner_id: unknown;
  cycle_index: unknown;
  started_at: unknown;
  ended_at: unknown;
  activity_call_count: unknown;
  transcript_call_count: unknown;
  activity_unnamed_count: unknown;
  transcript_unnamed_count: unknown;
  activity_tools: unknown;
  transcript_tools: unknown;
}

function toMs(value: unknown): number {
  return value instanceof Date ? value.getTime() : Date.parse(String(value ?? ''));
}

function toInt(value: unknown): number {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : Number.NaN;
}

function toToolNames(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
}

export function parseRepeatedRecoverySqlRows(rows: readonly RepeatedRecoverySqlRow[]): RepeatedRecoveryCycleObservation[] {
  return rows.map((row) => ({
    ownerId: typeof row.owner_id === 'string' ? row.owner_id : '',
    cycleIndex: toInt(row.cycle_index),
    startedAtMs: toMs(row.started_at),
    endedAtMs: toMs(row.ended_at),
    activityCallCount: toInt(row.activity_call_count),
    transcriptCallCount: toInt(row.transcript_call_count),
    activityUnnamedCount: toInt(row.activity_unnamed_count),
    transcriptUnnamedCount: toInt(row.transcript_unnamed_count),
    activityTools: toToolNames(row.activity_tools),
    transcriptTools: toToolNames(row.transcript_tools),
  }));
}

export interface RepeatedRecoveryReadOptions {
  workspaceId?: string | null;
  nowMs?: number;
  lookbackMs?: number;
  sql?: Sql;
}

/**
 * One bounded query for every eligible member. The query returns at most three
 * rows per owner; calls are aggregated inside each checkpoint interval, so a
 * pathological busy cycle cannot inflate the transport result.
 */
export async function readFleetRepeatedRecoveryStates(
  members: readonly RepeatedRecoveryMember[],
  options: RepeatedRecoveryReadOptions = {},
): Promise<Map<string, RepeatedRecoveryState>> {
  const deduped = [...new Map(members.filter((member) => member.ownerId).map((member) => [member.ownerId, member])).values()];
  if (deduped.length > REPEATED_RECOVERY_MEMBER_LIMIT) {
    return new Map(
      deduped.map((member) => [
        member.ownerId,
        { status: 'unknown', consecutiveRecoveryOnlyCycles: null, reason: 'member-limit-exceeded' },
      ]),
    );
  }

  const eligible = deduped.filter((member) => !member.isRegisteredLeader && !member.hasProgressingClaim);
  if (eligible.length === 0) return classifyRepeatedRecoveryByMember(deduped, []);

  const sql = options.sql ?? getOrgPg().sql;
  const workspaceId = resolveConcreteWorkspaceId(options.workspaceId);
  const scopes = [...new Set([workspaceId, '*'])];
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  const lookbackMs = Math.max(1, Math.min(options.lookbackMs ?? REPEATED_RECOVERY_LOOKBACK_MS, 7 * 24 * 60 * 60 * 1000));
  const sinceIso = new Date(nowMs - lookbackMs).toISOString();
  const ownerIds = eligible.map((member) => member.ownerId);

  const rows = await sql<RepeatedRecoverySqlRow[]>`
    WITH requested(owner_id) AS (
      SELECT unnest(${ownerIds}::text[])
    ), ranked_boundaries AS (
      SELECT a.owner_id,
             a.created_at,
             row_number() OVER (PARTITION BY a.owner_id ORDER BY a.created_at DESC, a.id DESC) AS rn
        FROM harness_shared.agent_activity a
        JOIN requested r ON r.owner_id = a.owner_id
       WHERE a.kind = 'tool'
         AND a.phase = 'post'
         AND a.status = 'ok'
         AND a.workspace_id = ANY(${scopes}::text[])
         AND a.created_at >= ${sinceIso}::timestamptz
         AND regexp_replace(
               regexp_replace(lower(a.tool_name), '^mcp__.*__', ''),
               '[:._-]+', '_', 'g'
             ) = 'loop_checkpoint'
    ), boundaries AS (
      SELECT owner_id, created_at, rn
        FROM ranked_boundaries
       WHERE rn <= ${REPEATED_RECOVERY_BOUNDARY_LIMIT}
    ), cycles AS (
      SELECT newer.owner_id,
             newer.rn::int AS cycle_index,
             older.created_at AS started_at,
             newer.created_at AS ended_at
        FROM boundaries newer
        JOIN boundaries older
          ON older.owner_id = newer.owner_id
         AND older.rn = newer.rn + 1
    )
    SELECT c.owner_id,
           c.cycle_index,
           c.started_at,
           c.ended_at,
           activity.call_count::int AS activity_call_count,
           transcript.call_count::int AS transcript_call_count,
           activity.unnamed_count::int AS activity_unnamed_count,
           transcript.unnamed_count::int AS transcript_unnamed_count,
           activity.tools AS activity_tools,
           transcript.tools AS transcript_tools
      FROM cycles c
      CROSS JOIN LATERAL (
        SELECT count(*) AS call_count,
               count(*) FILTER (WHERE a.tool_name IS NULL) AS unnamed_count,
               coalesce(array_agg(DISTINCT a.tool_name) FILTER (WHERE a.tool_name IS NOT NULL), ARRAY[]::text[]) AS tools
          FROM harness_shared.agent_activity a
         WHERE a.owner_id = c.owner_id
           AND a.kind = 'tool'
           AND a.phase = 'post'
           AND a.workspace_id = ANY(${scopes}::text[])
           AND a.created_at > c.started_at
           AND a.created_at <= c.ended_at
      ) activity
      CROSS JOIN LATERAL (
        SELECT count(*) AS call_count,
               count(*) FILTER (WHERE p.tool_name IS NULL) AS unnamed_count,
               coalesce(array_agg(DISTINCT p.tool_name) FILTER (WHERE p.tool_name IS NOT NULL), ARRAY[]::text[]) AS tools
          FROM harness_shared.session_turn_parts p
         WHERE p.workspace_id = 'default'
           AND p.owner = c.owner_id
           AND p.part_kind = 'tool_use'
           AND p.ts > c.started_at
           AND p.ts <= c.ended_at
      ) transcript
     ORDER BY c.owner_id, c.cycle_index`;

  return classifyRepeatedRecoveryByMember(deduped, parseRepeatedRecoverySqlRows(rows));
}
