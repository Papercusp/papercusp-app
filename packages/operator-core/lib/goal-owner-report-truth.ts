/**
 * DB half of the GOAL owner-report truth checks (plan
 * goal-holder-plans-ideation-truthful-reports-2026-10-03 P-005). The pure
 * judgement lives in ./goal-owner-report (`checkGoalOwnerReportTruth`); this
 * module reads the measured state it judges against, and is shared by both
 * report rails (coord:send to human and coord:escalate) so they cannot drift.
 *
 * Every read is independent and fails OPEN to `null` for its own check: a
 * report must never be refused because a measurement was unreadable, only
 * because a readable measurement contradicts it.
 */
import type { Sql } from 'postgres';
import { getOrgPg, GOAL_SPEND_SNAPSHOT_SOURCE, withDbCallDeadline } from '@papercusp/db-org';
import { ANY_FAMILY_TERMINAL_STATES } from './work-item-dispatch-states';
import {
  checkGoalOwnerReportTruth,
  citedRefStatesFor,
  GOAL_OWNER_REPORT_FIELD,
  GOAL_OWNER_REPORT_SCHEMA_VERSION,
  type GoalOwnerReportField,
  type GoalOwnerReportTruthInputs,
  type GoalOwnerReportTruthSummary,
  type GoalOwnerReportTruthViolation,
  type GoalReportCitedRef,
  type GoalReportMeasuredSpend,
  type GoalReportOwnerWall,
  goalSpendFromGoalRow,
  workItemRefsIn,
} from './goal-owner-report';

/**
 * The owner action recorded on an owner-walled work-item, for a row aliased
 * `wall`. Order: an explicit ownerAction / ownerAsk, then the summary (or next
 * verb) of the first ACTIVE human blocker written by work_items:set_blocker.
 * NULL when none is recorded. Shared with the goal portfolio read
 * (goal-launch-settings) so the draft and the send gate name the same action;
 * before P-005 the portfolio read only ownerAction/ownerAsk, which no live wall
 * carried, so every wall rendered "open this work item for the exact owner action".
 */
export function ownerWallActionSql(sql: Sql) {
  return sql`COALESCE(
    NULLIF(wall.payload->>'ownerAction', ''),
    NULLIF(wall.payload->>'ownerAsk', ''),
    (SELECT COALESCE(NULLIF(blocker->>'summary', ''), NULLIF(blocker->>'nextVerb', ''))
       FROM jsonb_array_elements(
              CASE WHEN jsonb_typeof(wall.payload->'externalBlockers') = 'array'
                   THEN wall.payload->'externalBlockers' ELSE '[]'::jsonb END) AS blocker
      WHERE blocker->>'kind' = 'human'
        AND COALESCE(blocker->>'status', 'active') = 'active'
        AND COALESCE(NULLIF(blocker->>'summary', ''), NULLIF(blocker->>'nextVerb', '')) IS NOT NULL
      ORDER BY blocker->>'createdAt'
      LIMIT 1))`;
}

/** The predicate that makes a goal work-item an open owner wall (row aliased `wall`). */
export function openOwnerWallPredicateSql(sql: Sql) {
  return sql`wall.status <> ALL(${[...ANY_FAMILY_TERMINAL_STATES]}::text[])
    AND (wall.status IN ('needs-human', 'needs_human') OR wall.needs_human_review
      OR COALESCE((wall.payload->>'needsOwnerAction')::boolean, false)
      OR COALESCE((wall.payload->>'needsHuman')::boolean, false))`;
}

export interface GoalOwnerReportTruthReads {
  readSpend(): Promise<GoalReportMeasuredSpend | null>;
  readOwnerWalls(): Promise<GoalReportOwnerWall[] | null>;
  readPreviousReport(): Promise<GoalOwnerReportTruthInputs['previousReport']>;
  readRefStates(refs: readonly string[]): Promise<Record<string, string> | null>;
}

const failOpen = async <T>(read: () => Promise<T>): Promise<T | null> => {
  try {
    return await read();
  } catch {
    return null;
  }
};

/** Postgres-backed reads for one goal. */
export function makeGoalOwnerReportTruthReads(sql: Sql, workspaceId: string, goalId: string): GoalOwnerReportTruthReads {
  return {
    async readSpend() {
      const [row] = await sql<{ spent: unknown; source: string | null; at: string | null; unmeasured: string | null }[]>`
        SELECT metadata->'spentCents' AS spent,
               metadata->>'spentCentsSource' AS source,
               metadata->>'spentCentsAt' AS at,
               NULLIF(metadata->>'spentCentsUnmeasuredReason', '') AS unmeasured
          FROM harness_shared.goals
         WHERE workspace_id = ${workspaceId} AND id = ${goalId}`;
      if (!row) return null;
      return goalSpendFromGoalRow(row, GOAL_SPEND_SNAPSHOT_SOURCE);
    },
    async readOwnerWalls() {
      const rows = await sql<{ ref: string; action: string | null }[]>`
        SELECT wall.feature_id AS ref, ${ownerWallActionSql(sql)} AS action
          FROM harness_shared.work_items wall
         WHERE wall.workspace_id = ${workspaceId} AND wall.goal_id = ${goalId}
           AND ${openOwnerWallPredicateSql(sql)}
         ORDER BY wall.feature_id
         LIMIT 50`;
      return rows.map((row) => ({ ref: row.ref, action: row.action }));
    },
    async readPreviousReport() {
      // Any holder's report counts: a correction owed by a predecessor is owed
      // by its successor too (WI-10005610 handed it on instead of sending it).
      const [row] = await sql<{ ts: Date | string; stamp: unknown }[]>`
        SELECT e.ts, e.body -> ${GOAL_OWNER_REPORT_FIELD} AS stamp
          FROM harness_shared.coord_event_log e
         WHERE e.workspace_id = ${workspaceId}
           AND e.surface IN ('messages', 'escalations')
           AND e.ts > now() - interval '7 days'
           AND e.body -> ${GOAL_OWNER_REPORT_FIELD} ->> 'goalId' = ${goalId}
           AND e.body -> ${GOAL_OWNER_REPORT_FIELD} ->> 'schemaVersion' = ${GOAL_OWNER_REPORT_SCHEMA_VERSION}
         ORDER BY e.ts DESC
         LIMIT 1`;
      if (!row) return null;
      const stamp = row.stamp && typeof row.stamp === 'object' ? (row.stamp as Record<string, unknown>) : {};
      const cited = Array.isArray(stamp.citedRefStates)
        ? (stamp.citedRefStates as unknown[]).flatMap((value) => {
            const entry = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
            return entry && typeof entry.ref === 'string' && typeof entry.state === 'string'
              ? [{ ref: entry.ref, state: entry.state }]
              : [];
          })
        : null;
      return { at: new Date(row.ts).toISOString(), citedRefStates: cited };
    },
    async readRefStates(refs) {
      if (refs.length === 0) return {};
      const rows = await sql<{ ref: string; status: string }[]>`
        SELECT feature_id AS ref, status
          FROM harness_shared.work_items
         WHERE workspace_id = ${workspaceId} AND feature_id = ANY(${[...refs]}::text[])`;
      return Object.fromEntries(rows.map((row) => [row.ref, row.status]));
    },
  };
}

export interface GoalOwnerReportTruthVerdict {
  violations: GoalOwnerReportTruthViolation[];
  summary: GoalOwnerReportTruthSummary;
  /** States of the refs this report's MOVED cites, for the stamp (the next report's baseline). */
  citedRefStates: GoalReportCitedRef[] | null;
}

/**
 * Read the measured state and judge a complete report against it. Never
 * throws: each failed read leaves its check `unread`.
 */
export async function evaluateGoalOwnerReportTruth(
  fields: Record<GoalOwnerReportField, string>,
  reads: GoalOwnerReportTruthReads,
): Promise<GoalOwnerReportTruthVerdict> {
  const [spend, ownerWalls, previousReport] = await Promise.all([
    failOpen(() => reads.readSpend()),
    failOpen(() => reads.readOwnerWalls()),
    failOpen(() => reads.readPreviousReport()),
  ]);
  const movedRefs = workItemRefsIn(fields.moved);
  const previousRefs = previousReport?.citedRefStates?.map((cited) => cited.ref) ?? [];
  const refStates = await failOpen(() => reads.readRefStates([...new Set([...movedRefs, ...previousRefs])]));
  const { violations, summary } = checkGoalOwnerReportTruth(fields, {
    spend,
    ownerWalls,
    previousReport,
    currentRefStates: refStates,
  });
  return { violations, summary, citedRefStates: citedRefStatesFor(fields.moved, refStates) };
}

/** The truth reads are one goal row, the goal's open walls, one event-log row and a ref lookup. */
export const GOAL_OWNER_REPORT_TRUTH_DEADLINE_MS = 5_000;

/**
 * The entry point both report rails call (coord:send to human, coord:escalate).
 * Null when the DB handle is unavailable or the deadline passes: the report is
 * then stamped without a truth summary, exactly as before P-005.
 */
export async function readGoalOwnerReportTruth(
  workspaceId: string,
  goalId: string,
  fields: Partial<Record<GoalOwnerReportField, string>>,
): Promise<GoalOwnerReportTruthVerdict | null> {
  try {
    return await withDbCallDeadline(
      evaluateGoalOwnerReportTruth(
        fields as Record<GoalOwnerReportField, string>,
        makeGoalOwnerReportTruthReads(getOrgPg().sql, workspaceId, goalId),
      ),
      { ms: GOAL_OWNER_REPORT_TRUTH_DEADLINE_MS, label: 'goal-owner-report.truth' },
    );
  } catch {
    return null;
  }
}
