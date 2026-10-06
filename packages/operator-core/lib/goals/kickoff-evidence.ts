/**
 * GOAL kickoff evidence — the structural answer to "may this GOAL holder place
 * portfolio work yet?" (WI-939561).
 *
 * The GOAL contract has always required four portfolio reads followed by an
 * owner-facing report before the first create/launch/placement. Prompt prose did
 * not make that ordering real: a holder could launch a fleet immediately and do
 * the reads much later (or never). This module reuses the two durable ledgers
 * that already record the facts instead of introducing a parallel checklist:
 *
 *   - harness_shared.tool_invocations — successful current-window reads;
 *   - harness_shared.coord_event_log  — the delivered owner-facing report.
 *
 * A "window" begins at the current GOAL-mode row's set_at. A reason/subject
 * change intentionally starts a new window; an idempotent mode re-assertion does
 * not rewrite set_at. The report must be delivered AFTER all four reads and must
 * name the current mode subject, so evidence from a previous goal cannot unlock
 * a newly adopted one.
 *
 * The gate applies only to the session that HOLDS mode='goal'. Descendants may
 * inherit goal provenance through session_briefs.goal_id, but they implement the
 * work and must not inherit the portfolio-manager kickoff gate.
 */

import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { getModes } from '../modes/store';
import {
  portfolioActFacet,
  PORTFOLIO_CREATE_TOOLS,
  PORTFOLIO_PLACE_TOOLS,
} from './portfolio-acts';
import {
  diagnoseGoalOwnerReportEnvelope,
  GOAL_OWNER_REPORT_DIAGNOSIS_RANK,
  GOAL_OWNER_REPORT_HEADING_LIST,
  GOAL_OWNER_REPORT_HEADINGS,
  type GoalOwnerReportEnvelopeDiagnosis,
} from '../goal-owner-report';

export const GOAL_KICKOFF_REQUIRED_READS = ['goals:list', 'pot:list', 'plans:list', 'search:semantic'] as const;

export type GoalKickoffRead = (typeof GOAL_KICKOFF_REQUIRED_READS)[number];

/**
 * Creation, launch and placement doors a GOAL holder may not cross before the
 * kickoff evidence exists. The unconditional names are derived from the same
 * facet registry that measures portfolio activity; args-sensitive acts are
 * resolved by {@link isGoalKickoffGuardedTool}. Keep this at the shared dispatch
 * seam: an inner call through tools:invoke is re-dispatched under its canonical
 * name and is covered exactly like a direct MCP/HTTP/IPC call.
 */
export const GOAL_KICKOFF_GUARDED_TOOLS: readonly string[] = Object.freeze(
  [...new Set<string>([...PORTFOLIO_CREATE_TOOLS, ...PORTFOLIO_PLACE_TOOLS])].sort(),
);

export function isGoalKickoffGuardedTool(toolName: string, args?: unknown): boolean {
  const facet = portfolioActFacet(toolName, args);
  return facet === 'create' || facet === 'place';
}

export type GoalKickoffMissingLeg =
  | GoalKickoffRead
  | 'owner-report'
  | 'goal-subject'
  | 'goal-record'
  | 'evidence-unavailable';

export interface GoalKickoffEvidence {
  /** false means this caller has no active GOAL-mode row; descendants are false. */
  applies: boolean;
  complete: boolean;
  workspaceId: string;
  ownerId: string;
  goalId: string | null;
  windowStartedAt: string | null;
  /** Informational only. A standing goal's absent kill criterion is valid. */
  standing: boolean | null;
  killCriterion: string | null;
  reads: Partial<Record<GoalKickoffRead, string>>;
  ownerReportAt: string | null;
  /**
   * Why the owner-report leg is unsatisfied, when it was actually evaluated.
   *
   * `null` means the leg was never reached (reads still missing, no GOAL row,
   * or a degraded ledger) — never "nothing was sent". `candidates: 0` is the
   * honest "no owner-facing message exists in this window"; a non-zero count
   * with a `closest` reason is the case a bare `missing:['owner-report']` used
   * to render indistinguishable from it (EI-23742424491420721).
   */
  ownerReportDiagnosis: GoalKickoffOwnerReportDiagnosis | null;
  missing: GoalKickoffMissingLeg[];
  degradedReason: string | null;
}

export interface GoalKickoffOwnerReportDiagnosis {
  /** Owner-facing messages found in this window AFTER the last required read. */
  candidates: number;
  /** The closest any of them came to satisfying the contract; null when none exist. */
  closest: GoalOwnerReportEnvelopeDiagnosis | null;
}

export interface ReadGoalKickoffEvidenceArgs {
  workspaceId: string;
  ownerId: string;
  /**
   * The dispatch host supplies flushPendingTelemetry. Requiring the seam keeps a
   * just-finished read/report from sitting in the deferred telemetry buffer while
   * the following launch is falsely refused.
   */
  flushTelemetry: () => Promise<void>;
  sql?: Sql;
}

function pg(sql?: Sql): Sql {
  return sql ?? getOrgPg().sql;
}

function iso(value: unknown): string | null {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function base(args: ReadGoalKickoffEvidenceArgs): GoalKickoffEvidence {
  return {
    applies: false,
    complete: false,
    workspaceId: args.workspaceId,
    ownerId: args.ownerId,
    goalId: null,
    windowStartedAt: null,
    standing: null,
    killCriterion: null,
    reads: {},
    ownerReportAt: null,
    ownerReportDiagnosis: null,
    missing: [],
    degradedReason: null,
  };
}

/**
 * Read the current, falsifiable kickoff proof. No write is made: completion is
 * derived from canonical ledgers on every guarded call, so a process restart or
 * carry-respawn cannot erase it and no second mutable "kickoff complete" bit can
 * drift from the evidence.
 */
export async function readGoalKickoffEvidence(args: ReadGoalKickoffEvidenceArgs): Promise<GoalKickoffEvidence> {
  const out = base(args);
  if (!args.workspaceId || args.workspaceId === '*' || !args.ownerId) return out;
  const sql = pg(args.sql);

  let mode: Awaited<ReturnType<typeof getModes>>[number] | undefined;
  try {
    mode = (await getModes(args.workspaceId, args.ownerId, sql)).find((row) => row.mode === 'goal');
  } catch (error) {
    // We cannot distinguish an ordinary caller from a GOAL holder when the mode
    // store itself is down. Preserve ordinary create/launch availability, but
    // make the missing enforcement visible to the host log.
    return {
      ...out,
      degradedReason: `GOAL kickoff mode read failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!mode) return out;
  out.applies = true;
  out.goalId = mode.subject;
  out.windowStartedAt = iso(mode.setAt);

  if (!out.goalId) {
    out.missing = ['goal-subject'];
    return out;
  }
  if (!out.windowStartedAt) {
    out.missing = ['evidence-unavailable'];
    out.degradedReason = 'the active GOAL-mode row has no readable set_at window boundary';
    return out;
  }

  try {
    const goalRows = (await sql`
      SELECT id, standing, kill_criterion
        FROM harness_shared.goals
       WHERE workspace_id = ${args.workspaceId}
         AND id = ${out.goalId}
       LIMIT 1
    `) as unknown as Array<Record<string, unknown>>;
    if (goalRows.length === 0) {
      out.missing = ['goal-record'];
      return out;
    }
    out.standing = goalRows[0]!.standing == null ? null : Boolean(goalRows[0]!.standing);
    out.killCriterion = goalRows[0]!.kill_criterion == null ? null : String(goalRows[0]!.kill_criterion);

    await args.flushTelemetry();

    const readRows = (await sql`
      -- WI-10004981: min, not max. The contract is "a report AFTER the four
      -- reads" — i.e. after the first moment all four existed. With max(), a
      -- routine re-read of any one of them later in the window moved the
      -- boundary past an already-valid report and re-locked every launch.
      SELECT tool_name, min(invoked_at) AS invoked_at
        FROM harness_shared.tool_invocations
       WHERE workspace_id = ${args.workspaceId}
         AND coord_owner_id = ${args.ownerId}
         AND invoked_at >= ${out.windowStartedAt}::timestamptz
         AND status = 'ok'
         AND tool_name IN ${sql([...GOAL_KICKOFF_REQUIRED_READS])}
       GROUP BY tool_name
    `) as unknown as Array<Record<string, unknown>>;

    for (const row of readRows) {
      const name = String(row.tool_name ?? '');
      if (!GOAL_KICKOFF_REQUIRED_READS.includes(name as GoalKickoffRead)) continue;
      const at = iso(row.invoked_at);
      if (at) out.reads[name as GoalKickoffRead] = at;
    }

    const missingReads = GOAL_KICKOFF_REQUIRED_READS.filter((name) => !out.reads[name]);
    if (missingReads.length > 0) {
      // A report cannot satisfy the contract until all four reads exist because
      // it must follow them. Say both halves are still missing/actionable.
      out.missing = [...missingReads, 'owner-report'];
      return out;
    }

    const latestReadAt = GOAL_KICKOFF_REQUIRED_READS.map((name) => out.reads[name]!)
      .sort()
      .at(-1)!;
    const reportRows = (await sql`
      SELECT ts, body
        FROM harness_shared.coord_event_log
       WHERE workspace_id = ${args.workspaceId}
         AND body->>'from' = ${args.ownerId}
         AND ts >= ${latestReadAt}::timestamptz
         AND superseded_by_msg_id IS NULL
         AND (
           (surface = 'messages' AND body->'to' @> '["human"]'::jsonb)
           OR surface = 'escalations'
         )
       ORDER BY ts DESC
       -- Compatibility is intentionally bounded. Modern reports carry a
       -- server-authored goalOwnerReport stamp; legacy rows are parsed below
       -- and must still contain all four labeled values plus the exact goal.
       LIMIT 256
    `) as unknown as Array<Record<string, unknown>>;

    // Diagnose every candidate in one pass. The verdict and the explanation
    // come from the same call, so a refusal can never claim a reason the gate
    // did not actually apply.
    let closest: GoalOwnerReportEnvelopeDiagnosis | null = null;
    let reportRow: Record<string, unknown> | undefined;
    for (const row of reportRows) {
      const diagnosis = diagnoseGoalOwnerReportEnvelope(row.body, out.goalId!);
      if (diagnosis.kind === 'complete') {
        reportRow = row;
        closest = diagnosis;
        break;
      }
      if (
        !closest ||
        GOAL_OWNER_REPORT_DIAGNOSIS_RANK[diagnosis.kind] > GOAL_OWNER_REPORT_DIAGNOSIS_RANK[closest.kind]
      ) {
        closest = diagnosis;
      }
    }

    out.ownerReportAt = reportRow ? iso(reportRow.ts) : null;
    if (!out.ownerReportAt) {
      out.ownerReportDiagnosis = { candidates: reportRows.length, closest: reportRows.length ? closest : null };
      out.missing = ['owner-report'];
      return out;
    }

    out.complete = true;
    return out;
  } catch (error) {
    out.missing = ['evidence-unavailable'];
    out.degradedReason = `GOAL kickoff evidence read failed: ${error instanceof Error ? error.message : String(error)}`;
    return out;
  }
}

/**
 * Turn the owner-report verdict into a repair an agent can act on.
 *
 * `missing:['owner-report']` alone reads as "you have not sent an owner report"
 * even when the truth is "you sent four, and all four parsed as non-attempts".
 * That ambiguity cost a GOAL holder ~90 minutes and produced a confidently
 * WRONG durable conclusion — that the send CHANNEL was at fault — which then
 * outlived the session (EI-23742424491420721). Name the schema instead.
 */
function explainOwnerReport(diagnosis: GoalKickoffOwnerReportDiagnosis | null): string {
  if (!diagnosis) return '';
  const { candidates, closest } = diagnosis;
  if (candidates === 0 || !closest) {
    return ' No owner-facing message was found in this window at all after the last required read.';
  }
  const one = candidates === 1;
  const found = one
    ? "1 owner-facing message was delivered in this window, but it did not register as this goal's report:"
    : `${candidates} owner-facing messages were delivered in this window, but none registered as this goal's report:`;
  switch (closest.kind) {
    case 'not-attempted':
      return (
        ` ${found} ${one ? 'it carried none of the four required headings, so it was never a report ATTEMPT.' : 'not one carried any of the four required headings, so none was even a report ATTEMPT.'}` +
        ` The channel was right and the report SHAPE was wrong — re-send the same content with ${GOAL_OWNER_REPORT_HEADING_LIST} as body-section headings.` +
        ' Naming the goal id in prose does not substitute for them.'
      );
    case 'incomplete':
      return (
        ` ${found} the closest attempted the report but left the contract unmet —` +
        ` missing: ${closest.missing.join(', ') || 'none'};` +
        ` empty: ${closest.empty.join(', ') || 'none'};` +
        ` duplicate: ${closest.duplicate.join(', ') || 'none'}.`
      );
    case 'wrong-goal':
      return (
        ` ${found} the closest carried a COMPLETE report, but for ${closest.stampedGoalId ? `goal ${closest.stampedGoalId}` : 'a subject it never named'} rather than this one.` +
        ' Re-send it while this goal is the active GOAL subject.'
      );
    case 'unstamped-complete':
      return (
        ` ${found} the closest parsed complete but carries no server-authored goalOwnerReport stamp, so nothing vouches for its subject` +
        ' (GOAL-subject validation was unavailable at send time). Re-send it now that the subject is readable.'
      );
    default:
      return ` ${found} none was a readable report envelope.`;
  }
}

export function goalKickoffRefusalPayload(toolName: string, evidence: GoalKickoffEvidence) {
  const missing = evidence.missing.length ? evidence.missing : ['evidence-unavailable'];
  const standingNote = evidence.standing
    ? ' This is a standing goal: no kill criterion is required; the gate checks only the four reads and the report.'
    : '';
  const ownerReportNote = missing.includes('owner-report') ? explainOwnerReport(evidence.ownerReportDiagnosis) : '';
  return {
    ok: false,
    error: 'goal_kickoff_incomplete',
    tool: toolName,
    goalId: evidence.goalId,
    windowStartedAt: evidence.windowStartedAt,
    missing,
    requiredOwnerReportHeadings: GOAL_OWNER_REPORT_HEADINGS,
    observed: {
      reads: evidence.reads,
      ownerReportAt: evidence.ownerReportAt,
      ownerReport: evidence.ownerReportDiagnosis,
    },
    ...(evidence.degradedReason ? { degradedReason: evidence.degradedReason } : {}),
    message:
      `GOAL kickoff incomplete for ${evidence.goalId ?? 'an unattributed GOAL holder'}; ${toolName} was refused before portfolio mutation/placement. ` +
      `In the current GOAL window, successfully run goals:list, pot:list, plans:list, and search:semantic on the goal's terms; then send an owner-facing report AFTER those reads (coord:send to ["human"] or coord:escalate) carrying all four required headings — ${GOAL_OWNER_REPORT_HEADING_LIST} — each present exactly once and non-empty (explicit \`none\` or \`unknown (<source>)\` is a valid value). ` +
      `A plain status message that merely names the goal id is NOT a report and will be delivered without registering. ` +
      `Missing: ${missing.join(', ')}.${standingNote}${ownerReportNote}`,
  };
}
