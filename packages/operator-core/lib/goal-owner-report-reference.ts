/** Canonical GOAL reference admission on the existing Reports/coordination rails.
 * Cadence is the timestamp of the stamped notification row, not a second write.
 * Preparation and append share PgCoordLog's replay transaction. Inline reports
 * retain their separate, existing fail-open truth evaluator.
 */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Sql, TransactionSql } from 'postgres';
import { PgCoordLog } from '@papercusp/coordination/event-log';
import type { CoordEnvelope } from '@papercusp/coordination';
import { GOAL_SPEND_SNAPSHOT_SOURCE } from '@papercusp/db-org';
import {
  parseGoalOwnerReportSnapshot, serializeGoalOwnerReportSnapshot,
  type GoalOwnerReportRefV1, type GoalOwnerReportSnapshotV1,
} from '@papercusp/chat-protocol';
import { getReport, reportBodySha256, type ReportRecord, type ReportViewer } from './report-library';
import { ownerWallActionSql, openOwnerWallPredicateSql } from './goal-owner-report-truth';
import {
  GOAL_OWNER_REPORT_FIELD, parseGoalOwnerReport, stampGoalOwnerReport,
  type GoalOwnerReportStamp, type GoalOwnerReportTruthSummary, type GoalReportCitedRef,
} from './goal-owner-report';
import { resolveGoalHolders } from './goals/holder';

type Snapshot = GoalOwnerReportSnapshotV1;
type Db = Sql | TransactionSql;
export class GoalReportReferenceRefusal extends Error {
  constructor(readonly oracle: string, readonly code = 'goal-owner-report-untruthful') {
    super(`GOAL report reference refused by ${oracle}; no notification or cadence stamp was created.`);
  }
}
function refuse(oracle: string, code?: string): never { throw new GoalReportReferenceRefusal(oracle, code); }
const iso = (value: Date | string | number): string => new Date(value).toISOString();
/** Content generations include metadata: spend rollups deliberately do not bump goal.updated_at. */
export const goalReportSourceRevision = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = isDeepStrictEqual;

export interface GoalReportReferenceReads {
  source(ref: string): Promise<Snapshot['sources'][number] | null>;
  cost(): Promise<Snapshot['cost'] | null>;
  ownerWalls(): Promise<Snapshot['ownerWalls'] | null>;
  movement(ref: string): Promise<Snapshot['moved'][number] | null>;
  wake(wake: Snapshot['nextWake']): Promise<boolean>;
  killed(entry: Snapshot['killed'][number]): Promise<boolean>;
}

/** Exact comparisons, never a prose truth heuristic. Any missing critical read refuses. */
export async function validateGoalReportReferenceSnapshot(s: Snapshot, reads: GoalReportReferenceReads, now: number): Promise<void> {
  const observed = Date.parse(s.observedAt);
  if (observed > now || now - observed > 300_000) refuse('snapshot-age');
  const atOrBefore = (at: string | null) => at !== null && Date.parse(at) <= observed;
  if (!s.sources.some((source) => source.ref === `goal:${s.goalId}` && source.availability === 'value')) refuse('current-goal-source');
  if (new Set(s.sources.map((source) => source.ref)).size !== s.sources.length) refuse('duplicate-source');
  for (const source of s.sources) {
    if (!atOrBefore(source.observedAt) || (source.measuredAt !== null && Date.parse(source.measuredAt) > Date.parse(source.observedAt))) refuse(`source-time:${source.ref}`);
    const current = await reads.source(source.ref);
    if (!current || current.revision !== source.revision || current.availability !== source.availability ||
      (source.availability === 'value' && current.observedAt !== source.observedAt) ||
      current.measuredAt !== source.measuredAt || current.unknownReason !== source.unknownReason) refuse(`source-generation:${source.ref}`);
  }
  const cost = await reads.cost();
  if (!cost || cost.spentCents === null || cost.measuredAt === null || !atOrBefore(s.cost.readAt) ||
    !atOrBefore(s.cost.measuredAt) || Date.parse(s.cost.measuredAt!) > Date.parse(s.cost.readAt) ||
    !same({ ...s.cost, readAt: '' }, { ...cost, readAt: '' })) refuse('current-measured-cost');
  const walls = await reads.ownerWalls();
  const ordered = (rows: Snapshot['ownerWalls']) => [...rows].sort((a, b) => a.itemRef.localeCompare(b.itemRef));
  if (!walls || !same(ordered(s.ownerWalls), ordered(walls))) refuse('complete-exact-owner-actions');
  if (new Set(s.moved.map((m) => m.ref)).size !== s.moved.length) refuse('duplicate-movement');
  for (const moved of s.moved) {
    if (!atOrBefore(moved.stateObservedAt) || moved.successfulMutations.some((m) => !atOrBefore(m.persistedAt))) refuse(`movement-time:${moved.ref}`);
    const current = await reads.movement(moved.ref);
    if (!current || !same(moved, current)) refuse(`movement-receipts:${moved.ref}`);
  }
  if (s.nextWake.kind === 'unknown' || !s.nextWake.ref || !s.nextWake.evidenceRef ||
    !s.nextWake.expectedAt || Date.parse(s.nextWake.expectedAt) < observed || !await reads.wake(s.nextWake)) refuse('next-wake-evidence');
  for (const killed of s.killed) if (!atOrBefore(killed.at) || !await reads.killed(killed)) refuse(`historical-disposition:${killed.ref}`);
}

/** Bounded, workspace/goal-scoped authoritative reads. Ref revisions are content hashes
 * of the persisted source rows; arbitrary supplied generation labels are never trusted.
 * Supported sources: goal:<id> and work-item:<id> (bare WI-/EI- accepted).
 * Extra unavailable sources must retain the resolver's explicit unknown reason.
 */
export function makeGoalReportReferenceReads(sql: Db, workspaceId: string, goalId: string): GoalReportReferenceReads {
  const goal = async () => (await sql`
    SELECT id, status, budget_cents, budget_window_sec, metadata, updated_at
      FROM harness_shared.goals WHERE workspace_id = ${workspaceId} AND id = ${goalId}`)[0];
  const item = async (ref: string) => (await sql`
    SELECT feature_id, status, updated_ts, payload, authority, terminal_completion_ref
      FROM harness_shared.work_items WHERE workspace_id = ${workspaceId}
       AND goal_id = ${goalId} AND feature_id = ${ref.replace(/^work-item:/, '')}`)[0];
  return {
    async source(ref) {
      if (ref === `goal:${goalId}`) {
        const row = await goal();
        return row ? { ref, revision: goalReportSourceRevision(row), observedAt: iso(row.updated_at), measuredAt: iso(row.updated_at), availability: 'value' } : null;
      }
      if (/^(work-item:)?(?:WI-|EI-)/.test(ref)) {
        const row = await item(ref);
        return row ? { ref, revision: goalReportSourceRevision(row), observedAt: iso(Number(row.updated_ts)), measuredAt: iso(Number(row.updated_ts)), availability: 'value' } : null;
      }
      return { ref, revision: 'unresolved', observedAt: new Date().toISOString(), measuredAt: null,
        availability: 'unknown', unknownReason: `No registered GOAL source resolver for ${ref}` };
    },
    async cost() {
      const row = await goal();
      const md = row?.metadata;
      if (!row || md?.spentCentsSource !== GOAL_SPEND_SNAPSHOT_SOURCE || md.spentCentsUnmeasuredReason ||
        typeof md.spentCents !== 'number' || !md.spentCentsAt || !md.spentCentsBreakdown) return null;
      return { spentCents: md.spentCents, budgetCents: row.budget_cents === null ? null : Number(row.budget_cents),
        budgetWindowSec: row.budget_window_sec, sourceRef: `goal:${goalId}`, sourceRevision: goalReportSourceRevision(row),
        measuredAt: md.spentCentsAt, readAt: new Date().toISOString(), coverage: JSON.stringify(md.spentCentsBreakdown) };
    },
    async ownerWalls() {
      const rows = await sql`
        SELECT wall.feature_id, wall.payload, wall.updated_ts, ${ownerWallActionSql(sql as Sql)} AS action
          FROM harness_shared.work_items wall WHERE wall.workspace_id = ${workspaceId}
           AND wall.goal_id = ${goalId} AND ${openOwnerWallPredicateSql(sql as Sql)} ORDER BY wall.feature_id LIMIT 501`;
      if (rows.length > 500 || rows.some((r) => !r.action)) return null;
      return rows.map((r) => ({ itemRef: r.feature_id, exactAction: r.action, sourceRevision: goalReportSourceRevision(r),
        decisionRefs: r.payload?.ownerDecisionRefs ?? [], artifactRefs: r.payload?.ownerArtifactRefs ?? [] }));
    },
    async movement(ref) {
      const row = await item(ref);
      if (!row) return null;
      const at = iso(Number(row.updated_ts));
      // A committed completion is the durable mutation receipt. An invocation
      // with status:ok alone does not establish that a mutation persisted.
      const verified = row.authority === 'committed' && Boolean(row.terminal_completion_ref);
      return { ref, state: row.status, stateObservedAt: at,
        successfulMutations: verified ? [{ receiptRef: row.terminal_completion_ref, operation: 'work_items:complete', persistedAt: at }] : [],
        completionEvidenceRefs: verified ? [row.terminal_completion_ref] : [], verification: verified ? 'verified' : 'unverified' };
    },
    async wake(wake) {
      const holders = await resolveGoalHolders(sql as Sql, { workspaceId, goalId });
      const liveOwnerId = holders.live[0]?.ownerId;
      if (!liveOwnerId) return false;
      if (wake.kind === 'loop') {
        const rows = await sql`SELECT r.id, r.next_fire_at, r.updated_at FROM harness_shared.routines r
          JOIN harness_shared.agent_modes m ON m.workspace_id = r.workspace_id AND m.owner_id = r.target_owner_id
           AND m.mode = 'goal' AND m.subject = ${goalId}
          WHERE r.workspace_id = ${workspaceId} AND r.id = ${wake.ref} AND r.active = true
            AND r.target_owner_id = ${liveOwnerId}`;
        return rows.length === 1 && iso(rows[0].next_fire_at) === wake.expectedAt &&
          wake.evidenceRef === `routine:${rows[0].id}@${iso(rows[0].updated_at)}`;
      }
      // Resolve a real registered await for the current GOAL holder. Owner and
      // event waits both require a bounded timeout wake; unregistered prose isn't evidence.
      if (!/^await:\d+$/.test(wake.evidenceRef ?? '')) return false;
      const rows = await sql`SELECT a.id, a.event_key, a.expires_ts FROM harness_shared.event_awaits a
        JOIN harness_shared.agent_modes m ON m.workspace_id = a.workspace_id AND m.owner_id = a.subscriber_id
         AND m.mode = 'goal' AND m.subject = ${goalId}
        WHERE a.workspace_id = ${workspaceId} AND a.id = ${Number(wake.evidenceRef!.slice(6))}
         AND a.subscriber_id = ${liveOwnerId}
         AND a.fired_at IS NULL AND a.cancelled_at IS NULL AND a.timeout_behavior = 'wake' AND a.policy = 'wake'`;
      return rows.length === 1 && rows[0].event_key === wake.ref && rows[0].expires_ts !== null && iso(rows[0].expires_ts) === wake.expectedAt;
    },
    async killed(entry) {
      const row = await item(entry.ref);
      return Boolean(row && ['dropped', 'deprecated'].includes(row.status) &&
        entry.at === iso(Number(row.updated_ts)) && entry.disposition === row.payload?.disposition &&
        same(entry.evidenceRefs, row.payload?.dispositionEvidenceRefs));
    },
  };
}

/** Five nonempty bounded summaries; full exact actions remain in the pinned card. */
export function deriveGoalReportNotification(s: Snapshot): string {
  const compact = (value: string) => value.replace(/[\r\n]+/g, ' ').slice(0, 90);
  return [
    `MOVED: ${s.moved.length ? compact(s.moved.map((m) => `${m.ref} ${m.state} (${m.verification})`).join('; ')) : 'none recorded'}`,
    `COST: ${s.cost.spentCents}c / ${s.cost.budgetCents ?? 'unknown'}c; ${compact(s.cost.coverage)}`,
    `OWNER-WALLED: ${s.ownerWalls.length} exact actions in the attached report`,
    `KILLED: ${s.killed.length} historical dispositions in the attached report`,
    `NEXT WAKE: ${s.nextWake.kind}; ${compact(s.nextWake.ref ?? 'unknown')}; ${s.nextWake.expectedAt}`,
  ].join('\n');
}

/**
 * The truth a snapshot that PASSED validateGoalReportReferenceSnapshot already proves
 * (WI-10006545). That validator refuses unless the cost is measured and current and the
 * owner walls are exact, so both checks are settled here; corrections are not checked on
 * this path and stay 'unread'. Cited ref states come from the receipt-verified movements,
 * so the next inline report's corrections check has a baseline. The prose truth evaluator
 * is NOT run on the derived notification: it renders cost in cents and only counts walls,
 * so that evaluator would refuse a fully validated reference.
 */
export function goalReportReferenceTruth(s: Snapshot): { summary: GoalOwnerReportTruthSummary; citedRefStates: GoalReportCitedRef[] } {
  return {
    summary: { cost: 'cited-measured', ownerWalls: s.ownerWalls.length ? 'all-listed-with-action' : 'none-open', corrections: 'unread' },
    citedRefStates: s.moved.map((m) => ({ ref: m.ref, state: m.state })),
  };
}

/** The one stamp for a reference report, delivered (coord:send) and persisted alike. Only call it after validation. */
export function stampGoalReportReference(goalId: string, s: Snapshot, body: string): GoalOwnerReportStamp {
  return stampGoalOwnerReport(goalId, parseGoalOwnerReport(body), goalReportReferenceTruth(s));
}

export function goalReportDeliveryId(workspaceId: string, ref: GoalOwnerReportRefV1): string {
  return `goal-report-${goalReportSourceRevision([workspaceId, ref.goalId, ref.reportId, ref.bodySha256])}`;
}

export async function resolveGoalReportReference(sql: Db, workspaceId: string, goalId: string,
  ref: GoalOwnerReportRefV1, viewer: ReportViewer): Promise<ReportRecord> {
  if (goalId !== ref.goalId) refuse('current-goal-subject');
  const report = await getReport(sql as Sql, workspaceId, ref.reportId, viewer);
  if (!report) refuse('visible-exact-report', 'report_reference_unavailable');
  if (report.workspaceId !== workspaceId || report.reportId !== ref.reportId || report.subject.kind !== 'goal' ||
    report.subject.ref !== goalId || report.bodySha256 !== ref.bodySha256 || reportBodySha256(report.bodyMd) !== ref.bodySha256) refuse('exact-body-identity');
  if (report.retiredAt) refuse('retired-report', 'report_reference_unavailable');
  const successors = await sql`SELECT report_id FROM harness_shared.report_library
    WHERE workspace_id = ${workspaceId} AND supersedes_report_id = ${ref.reportId} LIMIT 1`;
  if (successors.length) refuse('superseded-report', 'report_reference_unavailable');
  const s = parseGoalOwnerReportSnapshot(report.goalOwnerReport);
  if (!s || s.workspaceId !== workspaceId || s.goalId !== goalId || serializeGoalOwnerReportSnapshot(s) !== report.bodyMd) refuse('canonical-snapshot', 'report_invalid');
  return report;
}

/** Existing event-log transaction: the notification AND cadence stamp are one row.
 * The narrow hooks are a real-transaction test seam, never exposed as tool args.
 */
export async function persistGoalReportReference(sql: Sql, envelope: CoordEnvelope,
  context: { workspaceId: string; goalId: string; ref: GoalOwnerReportRefV1; viewer: ReportViewer },
  hooks?: { phase?: (phase: 'before-notification' | 'before-stamp' | 'before-commit', tx: Db) => Promise<void> },
): Promise<CoordEnvelope> {
  const log = new PgCoordLog({ getSql: () => sql, workspaceId: context.workspaceId, ensureSchema: async () => {} });
  const msgId = goalReportDeliveryId(context.workspaceId, context.ref);
  const result = await log.appendLineIfAbsent('messages', envelope.from, { ...envelope, msg_id: msgId }, {
    transactionOptions: 'isolation level repeatable read',
    prepare: async (tx) => {
      // The preflight subject can change before persistence. Check the actual
      // sender's subject again on this transaction and hold it through commit.
      const modes = await tx`SELECT subject FROM harness_shared.agent_modes
        WHERE workspace_id = ${context.workspaceId} AND owner_id = ${context.viewer.ownerId ?? envelope.from}
          AND axis_key = 'goal' AND mode = 'goal' FOR SHARE`;
      if (modes.length !== 1 || modes[0].subject !== context.goalId) refuse('current-goal-subject');
      const report = await resolveGoalReportReference(tx, context.workspaceId, context.goalId, context.ref, context.viewer);
      const snapshot = report.goalOwnerReport!;
      await validateGoalReportReferenceSnapshot(snapshot,
        makeGoalReportReferenceReads(tx, context.workspaceId, context.goalId), Date.now());
      await hooks?.phase?.('before-notification', tx);
      const body = deriveGoalReportNotification(snapshot);
      await hooks?.phase?.('before-stamp', tx);
      return { ...envelope, msg_id: msgId, body, summary: report.title,
        sections: [{ text: body }], report: { plans: [], goalReport: context.ref },
        [GOAL_OWNER_REPORT_FIELD]: stampGoalReportReference(context.goalId, snapshot, body) };
    },
    afterAppend: async (tx) => { await hooks?.phase?.('before-commit', tx); },
  });
  return result.envelope;
}
