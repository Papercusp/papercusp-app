/**
 * fleet:audit — bounded, snapshot-keyset evidence export for one named fleet.
 *
 * This is deliberately a COMPOSITION over canonical writers. It adds no audit
 * table and never promotes current presence into historical membership truth.
 */
import { z } from 'zod';
import type { Sql } from 'postgres';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { getFleet, type AgentFleetRecord } from '../../agent-fleets-store';
import { fleetEverMembers } from '../../fleet-membership-store';
import { groupByAgent, listFleetAssignments, type AgentAssignment } from '../../fleet/assignments';
import { MECHANICAL_CHECKPOINT_MARKER } from '../../turn-end-tracking';
import {
  CompletionVerificationEvidenceSchema,
  type CompletionVerificationEvidence,
} from '../../coord-lifecycle/records';
import {
  countsTowardBurnDown,
  isWorkItemCompletionAuthority,
  type CompletionAuthorityFrom,
} from '../../work-item-completion-authority';
import { TERMINAL_WORK_ITEM_STATES } from '../work_items/mirror-guard';
import { resolveAgentIdentity } from '../coordination/identity';
import {
  fetchUnansweredDirected,
  type UnansweredDirectedSummary,
} from '../coordination/unanswered-directed';
import { COORD_ROLES } from '../coordination/roles';
import { compactLaunchWorkerAttestation, type LeaderBriefLaunchWorkerAttestation } from './leader-brief';
import {
  reconcileWakeability,
  RECONCILE_WAKEABILITY_PRODUCTION_OPTIONS,
} from './assignments';

export const FLEET_AUDIT_DEFAULT_LIMIT = 20;
export const FLEET_AUDIT_MAX_LIMIT = 50;
export const FLEET_AUDIT_MEMBER_EVIDENCE_CAP = 8;

type Coverage = 'complete' | 'bounded' | 'current' | 'unknown';

export interface FleetAuditLeg<T> {
  writer: string;
  available: boolean;
  coverage: Coverage;
  data: T | null;
  reason?: string;
}

export interface FleetAuditCursor {
  version: 1;
  fleet: string;
  workspace: string;
  harness: string | null;
  sinceAt: string;
  snapshotAt: string;
  afterOwnerId: string;
}

export interface FleetAuditMembershipRow {
  ownerId: string;
  ownerLabel: string | null;
  fleetRole: string | null;
  event: string;
  at: string;
  id: number;
}

export interface FleetAuditSessionRow {
  ownerId: string;
  id: number;
  agent: string | null;
  role: string | null;
  sessionId: string | null;
  planSlug: string | null;
  harnessSlug: string | null;
  startedAt: string;
  endedAt: string | null;
  endedBy: string | null;
  endedSignal: string | null;
  exitCode: number | null;
}

export type FleetAuditCheckpointKind = 'authored' | 'mechanical' | 'none' | 'unknown';

export interface FleetAuditCheckpoint {
  kind: FleetAuditCheckpointKind;
  updatedAt: string | null;
  ageMs: number | null;
  excerpt: string | null;
}

export interface FleetAuditClaimRow {
  ownerId: string;
  workItemId: string;
  kind: string | null;
  title: string | null;
  status: string | null;
  harness: string | null;
  takenAt: string | null;
  lastProgressAt: string | null;
  checkpoint: FleetAuditCheckpoint;
}

export interface FleetAuditClaimTransitionRow {
  ownerId: string;
  workItemId: string;
  at: string;
}

type CompletionDbRow = {
  owner_id: unknown;
  feature_id: unknown;
  item_kind: unknown;
  title: unknown;
  status: unknown;
  terminal_owner: unknown;
  terminal_completion_ref: unknown;
  completion_evidence: unknown;
  authority: unknown;
  closed_ts: unknown;
};

export interface FleetAuditCompletion {
  ownerId: string;
  workItemId: string;
  kind: string | null;
  title: string | null;
  finalStatus: string | null;
  terminalOwner: string;
  terminalCompletionRef: string | null;
  filesChanged: string[] | null;
  testsRun: string | null;
  testResult: string | null;
  verifiedHow: CompletionVerificationEvidence['verifiedHow'] | null;
  addedTests: boolean | null;
  completionAuthority: CompletionAuthorityFrom;
  countsTowardBurnDown: boolean;
  terminalizedAt: string | null;
}

export interface FleetAuditEvidenceReaders {
  membership(input: FleetAuditReadScope, sql: Sql): Promise<FleetAuditMembershipRow[]>;
  sessions(input: FleetAuditReadScope, sql: Sql): Promise<FleetAuditSessionRow[]>;
  currentClaims(input: FleetAuditReadScope, sql: Sql): Promise<FleetAuditClaimRow[]>;
  claimTransitions(input: FleetAuditReadScope, sql: Sql): Promise<FleetAuditClaimTransitionRow[]>;
  completions(input: FleetAuditReadScope, sql: Sql): Promise<FleetAuditCompletion[]>;
}

export interface FleetAuditDeps {
  now?: () => Date;
  everMembers?: typeof fleetEverMembers;
  fleetRecord?: (workspaceId: string, fleetSlug: string, sql?: Sql) => Promise<AgentFleetRecord | null>;
  assignments?: typeof listFleetAssignments;
  reconcile?: typeof reconcileWakeability;
  unanswered?: (ownerIds: string[]) => Promise<Map<string, UnansweredDirectedSummary>>;
  readers?: FleetAuditEvidenceReaders;
}

interface FleetAuditReadScope {
  workspaceId: string;
  fleetSlug: string;
  harnessSlug: string | null;
  sinceAt: string;
  snapshotAt: string;
  ownerIds: string[];
  nowMs: number;
}

const iso = (value: unknown): string | null => {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value : null;

const number = (value: unknown): number | null => {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

function normalizeIso(value: string, field: string): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`invalid ${field}: expected an ISO timestamp`);
  return new Date(ms).toISOString();
}

export function encodeFleetAuditCursor(cursor: FleetAuditCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeFleetAuditCursor(raw: string): FleetAuditCursor {
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<FleetAuditCursor>;
    if (
      value.version !== 1 ||
      typeof value.fleet !== 'string' ||
      typeof value.workspace !== 'string' ||
      (value.harness !== null && typeof value.harness !== 'string') ||
      typeof value.sinceAt !== 'string' ||
      typeof value.snapshotAt !== 'string' ||
      typeof value.afterOwnerId !== 'string'
    ) {
      throw new Error('shape');
    }
    return {
      version: 1,
      fleet: value.fleet,
      workspace: value.workspace,
      harness: value.harness,
      sinceAt: normalizeIso(value.sinceAt, 'cursor sinceAt'),
      snapshotAt: normalizeIso(value.snapshotAt, 'cursor snapshotAt'),
      afterOwnerId: value.afterOwnerId,
    };
  } catch {
    throw new Error('invalid fleet:audit cursor');
  }
}

export function validateFleetAuditCursor(
  cursor: FleetAuditCursor,
  scope: { fleet: string; workspace: string; harness: string | null; sinceAt?: string },
): void {
  const sinceMismatch = scope.sinceAt != null && normalizeIso(scope.sinceAt, 'since') !== cursor.sinceAt;
  if (
    cursor.fleet !== scope.fleet ||
    cursor.workspace !== scope.workspace ||
    cursor.harness !== scope.harness ||
    sinceMismatch
  ) {
    throw new Error('fleet:audit cursor scope mismatch');
  }
}

export function pageFleetAuditMembers(
  members: Iterable<string>,
  afterOwnerId: string | null,
  limit: number,
): { rows: string[]; hasMore: boolean } {
  const sorted = [...new Set(members)].filter((id) => !afterOwnerId || id > afterOwnerId).sort();
  return { rows: sorted.slice(0, limit), hasMore: sorted.length > limit };
}

export function classifyFleetAuditCheckpoint(
  note: string | null | undefined,
  updatedAtMs: number | null | undefined,
  nowMs = Date.now(),
): FleetAuditCheckpoint {
  const value = (note ?? '').trim();
  if (!value) return { kind: 'none', updatedAt: null, ageMs: null, excerpt: null };
  const markerAt = value.indexOf(MECHANICAL_CHECKPOINT_MARKER);
  const authored = (markerAt >= 0 ? value.slice(0, markerAt) : value)
    .replace(/(?:\n\s*---\s*)+$/, '')
    .trim();
  const ts = updatedAtMs == null ? null : Number(updatedAtMs);
  return {
    kind: authored ? 'authored' : 'mechanical',
    updatedAt: ts != null && Number.isFinite(ts) ? new Date(ts).toISOString() : null,
    ageMs: ts != null && Number.isFinite(ts) ? Math.max(0, nowMs - ts) : null,
    excerpt: (authored || value).replace(/\s+/g, ' ').slice(0, 240),
  };
}

export function projectFleetAuditCompletion(row: CompletionDbRow): FleetAuditCompletion {
  const parsed = CompletionVerificationEvidenceSchema.safeParse(row.completion_evidence);
  const evidence = parsed.success ? parsed.data : null;
  const status = text(row.status);
  const authority = isWorkItemCompletionAuthority(row.authority) ? row.authority : null;
  const closedMs = number(row.closed_ts);
  return {
    ownerId: String(row.owner_id ?? row.terminal_owner ?? ''),
    workItemId: String(row.feature_id),
    kind: text(row.item_kind),
    title: text(row.title),
    finalStatus: status,
    terminalOwner: String(row.terminal_owner),
    terminalCompletionRef: text(row.terminal_completion_ref),
    filesChanged: evidence?.filesChanged ?? null,
    testsRun: evidence?.testsRun ?? null,
    testResult: evidence?.testResult ?? null,
    verifiedHow: evidence?.verifiedHow ?? null,
    addedTests: evidence?.addedTests ?? null,
    completionAuthority: authority,
    countsTowardBurnDown: countsTowardBurnDown(
      authority,
      status != null && TERMINAL_WORK_ITEM_STATES.has(status.toLowerCase()),
    ),
    terminalizedAt: closedMs == null ? null : new Date(closedMs).toISOString(),
  };
}

// Exported for fleet-audit-reader-columns.test.ts (WI-135860), which runs these against a
// recording `sql` to assert every column they name exists in the checked-in schema snapshot.
// Nothing else should reach for them — callers take readers through FleetAuditDeps.
export const defaultFleetAuditReaders: FleetAuditEvidenceReaders = {
  async membership(input, sql) {
    const rows = await sql<Array<Record<string, unknown>>>`
      WITH ranked AS (
        SELECT owner_id, owner_label, fleet_role, event, at, id,
               row_number() OVER (PARTITION BY owner_id ORDER BY at DESC, id DESC) AS rn
          FROM harness_shared.fleet_membership_events
         WHERE fleet_slug = ${input.fleetSlug}
           AND (workspace_id = ${input.workspaceId} OR workspace_id = 'default')
           AND owner_id = ANY(${sql.array(input.ownerIds)}::text[])
           AND at >= ${input.sinceAt}::timestamptz
           AND at <= ${input.snapshotAt}::timestamptz)
      SELECT owner_id, owner_label, fleet_role, event, at, id FROM ranked
       WHERE rn <= ${FLEET_AUDIT_MEMBER_EVIDENCE_CAP}
       ORDER BY owner_id, at DESC, id DESC`;
    return rows.map((row) => ({
      ownerId: String(row.owner_id), ownerLabel: text(row.owner_label), fleetRole: text(row.fleet_role),
      event: String(row.event), at: iso(row.at)!, id: Number(row.id),
    }));
  },
  async sessions(input, sql) {
    const rows = await sql<Array<Record<string, unknown>>>`
      WITH ranked AS (
        SELECT coord_owner_id, id, agent, role, session_id, plan_slug,
               started_at, ended_at, ended_by, ended_signal, exit_code,
               row_number() OVER (PARTITION BY coord_owner_id ORDER BY started_at DESC, id DESC) AS rn
          FROM harness_shared.adv_sessions
         WHERE workspace_id = ${input.workspaceId}
           AND coord_owner_id = ANY(${sql.array(input.ownerIds)}::text[])
           AND started_at >= ${input.sinceAt}::timestamptz
           AND started_at <= ${input.snapshotAt}::timestamptz)
      SELECT * FROM ranked WHERE rn <= ${FLEET_AUDIT_MEMBER_EVIDENCE_CAP}
       ORDER BY coord_owner_id, started_at DESC, id DESC`;
    return rows.map((row) => ({
      ownerId: String(row.coord_owner_id), id: Number(row.id), agent: text(row.agent), role: text(row.role),
      // harness_slug is NOT a column on harness_shared.adv_sessions (33 columns, none of them
      // this one). Selecting and filtering on it made every real sessions read throw 42703, so
      // this leg reported `unavailable` on every call the tool has ever served — invisible because
      // the unit suite substitutes a fake reader and never executes this SQL. The remaining
      // predicates (workspace + coord_owner_id + the sinceAt/snapshotAt window) already scope the
      // read; a session simply carries no harness of its own to report here.
      sessionId: text(row.session_id), planSlug: text(row.plan_slug), harnessSlug: null,
      startedAt: iso(row.started_at)!, endedAt: iso(row.ended_at), endedBy: text(row.ended_by),
      endedSignal: text(row.ended_signal), exitCode: number(row.exit_code),
    }));
  },
  async currentClaims(input, sql) {
    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT wi.taken_by AS owner_id, wi.feature_id, wi.item_kind, wi.title, wi.status,
             wi.harness_slug, wi.taken_at, wi.last_progress_at,
             cn.note AS checkpoint_note, cn.updated_ts AS checkpoint_updated_ts
        FROM harness_shared.work_items wi
        LEFT JOIN harness_shared.carry_notes cn
          ON cn.workspace_id = wi.workspace_id
         AND cn.scope = ('workitem:' || COALESCE(NULLIF(wi.harness_slug, ''), '*') || ':' || wi.feature_id)
       WHERE wi.workspace_id = ${input.workspaceId}
         AND wi.taken_by = ANY(${sql.array(input.ownerIds)}::text[])
         AND NOT harness_shared.work_item_status_is_terminal(wi.status)
         ${input.harnessSlug ? sql`AND wi.harness_slug = ${input.harnessSlug}` : sql``}
       ORDER BY wi.taken_by, wi.taken_at DESC NULLS LAST, wi.feature_id`;
    return rows.map((row) => ({
      ownerId: String(row.owner_id), workItemId: String(row.feature_id), kind: text(row.item_kind),
      title: text(row.title), status: text(row.status), harness: text(row.harness_slug),
      takenAt: iso(row.taken_at), lastProgressAt: iso(row.last_progress_at),
      checkpoint: classifyFleetAuditCheckpoint(
        text(row.checkpoint_note), number(row.checkpoint_updated_ts), input.nowMs,
      ),
    }));
  },
  async claimTransitions(input, sql) {
    const rows = await sql<Array<Record<string, unknown>>>`
      WITH ranked AS (
        SELECT h.value->>'owner' AS owner_id, wi.feature_id, h.value->>'at' AS at,
               row_number() OVER (
                 PARTITION BY h.value->>'owner'
                 ORDER BY (h.value->>'at')::timestamptz DESC, wi.feature_id) AS rn
          FROM harness_shared.work_items wi
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(wi.worked_by_history) = 'array' THEN wi.worked_by_history ELSE '[]'::jsonb END
          ) h(value)
         WHERE wi.workspace_id = ${input.workspaceId}
           AND h.value->>'owner' = ANY(${sql.array(input.ownerIds)}::text[])
           AND (h.value->>'at')::timestamptz >= ${input.sinceAt}::timestamptz
           AND (h.value->>'at')::timestamptz <= ${input.snapshotAt}::timestamptz
           ${input.harnessSlug ? sql`AND wi.harness_slug = ${input.harnessSlug}` : sql``})
      SELECT owner_id, feature_id, at FROM ranked
       WHERE rn <= ${FLEET_AUDIT_MEMBER_EVIDENCE_CAP}
       ORDER BY owner_id, at DESC, feature_id`;
    return rows.map((row) => ({
      ownerId: String(row.owner_id), workItemId: String(row.feature_id), at: iso(row.at)!,
    }));
  },
  async completions(input, sql) {
    const sinceMs = Date.parse(input.sinceAt);
    const snapshotMs = Date.parse(input.snapshotAt);
    const rows = await sql<CompletionDbRow[]>`
      WITH ranked AS (
        SELECT terminal_owner AS owner_id, feature_id, item_kind, title, status, terminal_owner,
               terminal_completion_ref, payload -> '_completionEvidence' AS completion_evidence,
               authority, closed_ts,
               row_number() OVER (PARTITION BY terminal_owner ORDER BY closed_ts DESC, feature_id) AS rn
          FROM harness_shared.work_items
         WHERE workspace_id = ${input.workspaceId}
           AND terminal_owner = ANY(${sql.array(input.ownerIds)}::text[])
           AND closed_ts >= ${sinceMs} AND closed_ts <= ${snapshotMs}
           ${input.harnessSlug ? sql`AND harness_slug = ${input.harnessSlug}` : sql``})
      SELECT * FROM ranked WHERE rn <= ${FLEET_AUDIT_MEMBER_EVIDENCE_CAP}
       ORDER BY owner_id, closed_ts DESC, feature_id`;
    return rows.map(projectFleetAuditCompletion);
  },
};

function available<T>(writer: string, coverage: Coverage, data: T): FleetAuditLeg<T> {
  return { writer, available: true, coverage, data };
}

function unavailable<T>(writer: string, reason: string): FleetAuditLeg<T> {
  return { writer, available: false, coverage: 'unknown', data: null, reason };
}

function rowsFor<T extends { ownerId: string }>(rows: T[], ownerId: string): T[] {
  return rows.filter((row) => row.ownerId === ownerId);
}

function compactAssignment(group: AgentAssignment | undefined) {
  if (!group) return null;
  return {
    agentId: group.agentId,
    label: group.label,
    name: group.name,
    present: group.present,
    alive: group.alive,
    heartbeatAt: group.heartbeatAt,
    intent: group.intent,
    declaredPlanSlug: group.declaredPlanSlug,
    fleetRole: group.fleetRole ?? null,
    claims: group.claims,
    doing: group.doing,
    queued: group.queued,
    load: group.load,
    orphaned: group.orphaned,
    stalled: group.stalled,
  };
}

export async function readFleetAudit(
  input: {
    fleet: string;
    workspace: string;
    harness?: string | null;
    since?: string;
    limit?: number;
    cursor?: string;
  },
  deps: FleetAuditDeps = {},
  sqlOverride?: Sql,
) {
  const sql = sqlOverride ?? getOrgPg().sql;
  const now = deps.now?.() ?? new Date();
  const harness = input.harness ?? null;
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? FLEET_AUDIT_DEFAULT_LIMIT), 1), FLEET_AUDIT_MAX_LIMIT);
  let record: AgentFleetRecord | null = null;
  let fleetRecordReason: string | undefined;
  try {
    record = await (deps.fleetRecord ?? getFleet)(input.workspace, input.fleet, sql);
  } catch {
    fleetRecordReason = 'fleet-record-read-failed';
  }
  const cursor = input.cursor ? decodeFleetAuditCursor(input.cursor) : null;
  const defaultSince = new Date(record?.createdAt ?? 0).toISOString();
  const sinceAt = cursor?.sinceAt ?? normalizeIso(input.since ?? defaultSince, 'since');
  if (cursor) validateFleetAuditCursor(cursor, {
    fleet: input.fleet, workspace: input.workspace, harness, sinceAt: input.since,
  });
  const snapshotAt = cursor?.snapshotAt ?? now.toISOString();
  const everMemberReader = deps.everMembers ?? fleetEverMembers;
  let everMembers: Set<string> | null = null;
  let everMembersReason: string | undefined;
  try {
    everMembers = await everMemberReader(
      input.fleet,
      { workspaceId: input.workspace, beforeOrAt: snapshotAt },
      sql,
    );
  } catch {
    everMembersReason = 'ever-member-read-failed';
  }
  const page = pageFleetAuditMembers(everMembers ?? [], cursor?.afterOwnerId ?? null, limit);
  const ownerIds = page.rows;
  const scope: FleetAuditReadScope = {
    workspaceId: input.workspace,
    fleetSlug: input.fleet,
    harnessSlug: harness,
    sinceAt,
    snapshotAt,
    ownerIds,
    nowMs: now.getTime(),
  };
  const readers = deps.readers ?? defaultFleetAuditReaders;
  const readNames = ['membership', 'sessions', 'currentClaims', 'claimTransitions', 'completions'] as const;
  const evidence: [
    PromiseSettledResult<FleetAuditMembershipRow[]>,
    PromiseSettledResult<FleetAuditSessionRow[]>,
    PromiseSettledResult<FleetAuditClaimRow[]>,
    PromiseSettledResult<FleetAuditClaimTransitionRow[]>,
    PromiseSettledResult<FleetAuditCompletion[]>,
  ] = ownerIds.length === 0
    ? [
        { status: 'fulfilled', value: [] },
        { status: 'fulfilled', value: [] },
        { status: 'fulfilled', value: [] },
        { status: 'fulfilled', value: [] },
        { status: 'fulfilled', value: [] },
      ]
    : await Promise.allSettled([
        readers.membership(scope, sql),
        readers.sessions(scope, sql),
        readers.currentClaims(scope, sql),
        readers.claimTransitions(scope, sql),
        readers.completions(scope, sql),
      ]);
  const [membershipRead, sessionsRead, currentClaimsRead, claimTransitionsRead, completionsRead] = evidence;

  let assignmentGroups: AgentAssignment[] | null = null;
  let wakeGroups: Array<AgentAssignment & Record<string, unknown>> | null = null;
  let assignmentReason: string | undefined;
  let wakeReason: string | undefined;
  try {
    const rows = await (deps.assignments ?? listFleetAssignments)({
      workspaceId: input.workspace,
      fleet: input.fleet,
      harness: harness ?? undefined,
      activeOnly: false,
    });
    assignmentGroups = groupByAgent(rows).filter((group) => ownerIds.includes(group.agentId));
    wakeGroups = assignmentGroups.map((group) => ({ ...group, claims: [...group.claims], queued: [...group.queued] }));
    try {
      await (deps.reconcile ?? reconcileWakeability)(
        wakeGroups,
        undefined,
        undefined,
        undefined,
        undefined,
        RECONCILE_WAKEABILITY_PRODUCTION_OPTIONS,
      );
    } catch {
      wakeGroups = null;
      wakeReason = 'wakeability-read-failed';
    }
  } catch {
    assignmentReason = 'assignment-read-failed';
    wakeReason = 'assignment-read-failed';
  }

  let unanswered: Map<string, UnansweredDirectedSummary> | null = null;
  let unansweredReason: string | undefined;
  try {
    unanswered = await (deps.unanswered ?? fetchUnansweredDirected)(ownerIds);
  } catch {
    unansweredReason = 'directed-backlog-read-failed';
  }
  const attestation: LeaderBriefLaunchWorkerAttestation | undefined = compactLaunchWorkerAttestation(
    record?.lastLaunchTransaction,
  );

  // The reason must carry the ACTUAL rejection, not a label derived from the writer name.
  // This previously returned `${writer}-read-failed`, which discarded settled.reason entirely:
  // the export correctly announced that a leg was degraded but destroyed the one detail needed
  // to fix it. That is how a plain Postgres 42703 ("column harness_slug does not exist") sat
  // undiagnosed in the sessions reader — every caller saw only "adv_sessions-read-failed".
  // An audit whose contract is "unavailable legs are unknown/degraded, never zero" has to say
  // WHY, or the honesty is unactionable.
  const failureReason = (settled: PromiseRejectedResult, writer: string): string => {
    const raw = settled.reason;
    const detail = raw instanceof Error
      ? (raw.message || raw.name)
      : typeof raw === 'string' ? raw : (() => { try { return JSON.stringify(raw); } catch { return String(raw); } })();
    const trimmed = (detail ?? '').trim();
    return trimmed ? `${writer}-read-failed: ${trimmed.slice(0, 500)}` : `${writer}-read-failed`;
  };

  const resultFor = <T>(settled: PromiseSettledResult<T[]>, writer: string, ownerId: string) =>
    settled.status === 'fulfilled'
      ? available(writer, 'bounded', rowsFor(settled.value as Array<T & { ownerId: string }>, ownerId))
      : unavailable<T[]>(writer, failureReason(settled, writer));

  const members = ownerIds.map((ownerId) => {
    const assignment = assignmentGroups?.find((group) => group.agentId === ownerId);
    const wake = wakeGroups?.find((group) => group.agentId === ownerId);
    const boot = attestation?.members.find((member) => member.ownerId === ownerId) ?? null;
    return {
      ownerId,
      assignment: assignmentGroups
        ? available('harness_shared.fleet_assignment via listFleetAssignments/groupByAgent', 'current', compactAssignment(assignment))
        : unavailable('harness_shared.fleet_assignment via listFleetAssignments/groupByAgent', assignmentReason!),
      liveness: wakeGroups
        ? available('coord wakeability + adv_sessions lifecycle oracle via reconcileWakeability', 'current', wake
          ? { alive: wake.alive, sessionState: wake.sessionState ?? null } : null)
        : unavailable('coord wakeability + adv_sessions lifecycle oracle via reconcileWakeability', wakeReason!),
      wakeability: wakeGroups
        ? available('coord inbox-wake + loop/self-wake via reconcileWakeability', 'current', wake
          ? { wakeable: wake.wakeable ?? null, loopArmed: wake.loopArmed ?? null, selfWake: wake.selfWake ?? null } : null)
        : unavailable('coord inbox-wake + loop/self-wake via reconcileWakeability', wakeReason!),
      membership: resultFor(membershipRead, 'harness_shared.fleet_membership_events', ownerId),
      sessions: resultFor(sessionsRead, 'harness_shared.adv_sessions', ownerId),
      bootStages: fleetRecordReason
        ? unavailable('harness_shared.agent_fleets.last_launch_transaction.workerAttestations', fleetRecordReason)
        : available('harness_shared.agent_fleets.last_launch_transaction.workerAttestations', 'current', boot),
      claims: {
        current: resultFor(currentClaimsRead, 'harness_shared.work_items.taken_by + carry_notes', ownerId),
        transitions: resultFor(claimTransitionsRead, 'harness_shared.work_items.worked_by_history', ownerId),
      },
      completions: resultFor(
        completionsRead,
        'harness_shared.work_items terminal_owner + authority + payload._completionEvidence',
        ownerId,
      ),
      directedBacklog: unanswered
        ? available('harness_shared.coord_event_log via fetchUnansweredDirected', 'current', unanswered.get(ownerId) ?? null)
        : unavailable('harness_shared.coord_event_log via fetchUnansweredDirected', unansweredReason!),
    };
  });

  const degradedLegs = [
    ...(everMembers ? [] : ['everMembers']),
    ...(assignmentGroups ? [] : ['assignments']),
    ...(wakeGroups ? [] : ['wakeability']),
    ...(unanswered ? [] : ['directedBacklog']),
    ...(fleetRecordReason ? ['bootStages'] : []),
    ...readNames.filter((_, index) => evidence[index].status === 'rejected'),
  ];
  const unknowns = [
    ...(everMembers && everMembers.size === 0 ? ['ever-member population is empty; no-work is not inferred'] : []),
    ...degradedLegs.map((leg) => `${leg} unavailable`),
  ];
  const nextCursor = page.hasMore && ownerIds.length > 0
    ? encodeFleetAuditCursor({
        version: 1,
        fleet: input.fleet,
        workspace: input.workspace,
        harness,
        sinceAt,
        snapshotAt,
        afterOwnerId: ownerIds[ownerIds.length - 1],
      })
    : null;
  return {
    fleet: input.fleet,
    workspace: input.workspace,
    harness,
    sinceAt,
    snapshotAt,
    generatedAt: now.toISOString(),
    page: {
      limit,
      shown: members.length,
      totalEverMembers: everMembers?.size ?? null,
      hasMore: page.hasMore,
      nextCursor,
    },
    everMembers: everMembers
      ? available('harness_shared.fleet_membership_events', 'complete', { count: everMembers.size })
      : unavailable('harness_shared.fleet_membership_events', everMembersReason!),
    degradedLegs,
    unknowns,
    members,
  };
}

export default defineTool({
  name: 'fleet:audit',
  profile: 'engineer',
  description:
    'Bounded, cursor-paged fleet evidence export over canonical membership, session, boot, claim, completion, checkpoint, wakeability, and directed-message writers.',
  guidance: {
    when: 'Postmortem, handoff, or machine export that needs durable fleet evidence rather than only live roster state.',
    notWhen: 'Immediate fleet supervision; use fleet:leader-brief. Whole-workspace current assignment state; use fleet:assignments.',
    chaining: 'Follow page.nextCursor with the same fleet/workspace/harness/since scope. Treat unavailable legs and unknowns as unknown, never zero.',
  },
  capability: 'work_items:read',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    fleet: z.string().min(1).max(120),
    workspace: z.string().min(1).max(120).optional(),
    harness: z.string().max(80).optional(),
    since: z.string().max(40).optional(),
    limit: z.number().int().min(1).max(FLEET_AUDIT_MAX_LIMIT).optional(),
    cursor: z.string().max(4096).optional(),
  }),
  async handler(args, ctx) {
    let actorWorkspace: string | null = null;
    try {
      actorWorkspace = resolveAgentIdentity(ctx).workspaceId ?? null;
    } catch {
      actorWorkspace = null;
    }
    const workspace = resolveConcreteWorkspaceId(args.workspace, actorWorkspace);
    return { data: await readFleetAudit({ ...args, workspace }) };
  },
});
