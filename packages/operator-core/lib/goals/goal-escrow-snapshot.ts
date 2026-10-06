/**
 * Read-only snapshot collector for the goal escrow evaluator (WI-10004498).
 *
 * `goal-escrow.ts` judges a plain-data snapshot; this file builds one from the
 * records that already exist — the goal row, its linked work-items and plans, the
 * green-checkpoint gate's published health, scorecards, the goal's spend snapshot,
 * and owner-report envelopes in the coord log. Every query is a SELECT; nothing in
 * here writes to goal or orchestration state.
 *
 * The row→snapshot mappers are exported and pure so their normalisation rules
 * (especially the free-text `testResult`) are unit-tested without a database.
 */

import type { Sql } from 'postgres';
import { diagnoseGoalOwnerReportEnvelope } from '../goal-owner-report';
import type {
  EscrowGateReading,
  EscrowGrade,
  EscrowNoGoReason,
  EscrowOwnerReport,
  EscrowWorkItem,
  GoalEscrowSnapshot,
} from './goal-escrow';

type Row = Record<string, unknown>;

function str(value: unknown): string | null {
  return value == null || value === '' ? null : String(value);
}

function num(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function isoToMs(value: unknown): number | null {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * `_completionEvidence.testResult` is agent-authored PROSE ("192/192 passed,
 * TEST_FILE_RESULT status=passed"), not an enum. Be conservative: a counted-zero
 * failure phrase ("0 failed", "failed: 0", "no failures") is not a failure; text
 * that names both a pass and a failure is `unknown` rather than guessed at.
 */
export function normaliseTestResult(text: unknown): 'pass' | 'fail' | 'unknown' | null {
  const raw = str(text);
  if (raw === null) return null;
  const cleaned = raw
    .replace(/\b0\s+fail(?:ed|ing|ures?|s)?\b/gi, '')
    .replace(/\bfail(?:ed|ing|ures?|s)?\s*[:=]?\s*0\b/gi, '')
    .replace(/\bno\s+fail(?:ed|ing|ures?|s)?\b/gi, '')
    .replace(/\bwithout\s+fail(?:ed|ing|ures?|s)?\b/gi, '');
  // A failure needs an EXPLICIT marker: a non-zero count, an uppercase FAIL token, or
  // status=failed. The bare word "fail" is not one — a close that ADJUDICATED red tests
  // ("5 of 6 reds proven already-fixed ... still failing") talks about failures without
  // reporting one, and reading it as a failing result fabricates a contradiction
  // (measured on WI-10002029, which made a clean standing goal read green=conflicting).
  const hasFailMarker =
    /\b[1-9]\d*\s+(?:tests?\s+|files?\s+)?fail(?:ed|ing|ures?|s)?\b/i.test(cleaned) ||
    /\bfail(?:ed|ing|ures?|s)?\s*[:=]\s*[1-9]/i.test(cleaned) ||
    /\bstatus=fail(?:ed)?\b/i.test(cleaned) ||
    /\bFAIL(?:ED)?\b/.test(cleaned);
  const hasPass = /\bpass(?:ed|es|ing)?\b|status=passed|\bgreen\b/i.test(cleaned);
  if (hasFailMarker && hasPass) return 'unknown';
  if (hasFailMarker) return 'fail';
  if (hasPass) return 'pass';
  return 'unknown';
}

export function mapWorkItemRow(row: Row): EscrowWorkItem {
  const evidence = asObject(row.completion_evidence);
  return {
    id: String(row.feature_id),
    status: String(row.status),
    completionAuthority: str(row.authority),
    assignee: str(row.assignee),
    takenBy: str(row.taken_by),
    terminalOwner: str(row.terminal_owner),
    closedAtMs: num(row.closed_ts),
    // `done` closes land on payload._completionEvidence, `dropped` closes on
    // terminal_completion_ref, and no route writes both — read both.
    hasCompletionEvidence: evidence !== null || str(row.terminal_completion_ref) !== null,
    testResult: normaliseTestResult(evidence?.testResult),
  };
}

export function mapGateReading(health: unknown): { gate: EscrowGateReading | null; noGoReason: EscrowNoGoReason | null } {
  const gh = asObject(health);
  if (gh === null) return { gate: null, noGoReason: null };
  const freeze = asObject(gh.freezeAndConverge);
  const observed = [num(gh.observedAt), num(freeze?.observedAtMs)].filter((v): v is number => v !== null);
  const observedAtMs = observed.length > 0 ? Math.max(...observed) : null;
  const gate: EscrowGateReading = {
    lastVerdict: str(gh.lastVerdict),
    observedAtMs,
    lastGreenAtMs: num(gh.lastGreenAt),
  };
  // The gate's own freeze-and-converge disposition IS the bounded reason a red tree
  // gives: it names what is held and why. Only an active hold counts.
  const state = str(freeze?.state);
  const reason = str(freeze?.reason);
  const noGoReason: EscrowNoGoReason | null =
    reason !== null && (state === 'converging' || state === 'held') && observedAtMs !== null
      ? { text: `freeze-and-converge ${state}: ${reason.slice(0, 160)}`, observedAtMs }
      : null;
  return { gate, noGoReason };
}

export function mapGoalRow(
  row: Row,
  nowMs: number,
): {
  goal: GoalEscrowSnapshot['goal'];
  spend: GoalEscrowSnapshot['spend'];
  ownerReportRequired: boolean;
  ownerReportNotRequiredReason: string | null;
} {
  const metadata = asObject(row.metadata) ?? {};
  const breakdown = asObject(metadata.spentCentsBreakdown);
  const standing = Boolean(row.standing);
  return {
    goal: {
      id: String(row.id),
      status: String(row.status),
      standing,
      disposition: str(metadata.disposition),
      dispositionAtMs: isoToMs(metadata.dispositionAt),
      closureReason: str(metadata.dispositionReason) ?? str(metadata.closureReason) ?? str(metadata.reason),
      killCriterion: str(row.kill_criterion),
      budgetCents: num(row.budget_cents),
      updatedAtMs: isoToMs(row.updated_at) ?? nowMs,
    },
    spend: {
      spentCents: num(metadata.spentCents),
      spentAtMs: isoToMs(metadata.spentCentsAt),
      lineageCents: num(breakdown?.lineageCents),
      unmeasuredReason: str(metadata.spentCentsUnmeasuredReason),
    },
    ownerReportRequired: !standing,
    ownerReportNotRequiredReason: standing ? 'standing goal: owner reports ride the cadence rail, not closure' : null,
  };
}

export interface ReadGoalEscrowSnapshotArgs {
  sql: Sql;
  workspaceId: string;
  goalId: string;
  nowMs: number;
  /**
   * Scorecards that graded any of these subjects (work-item ids and plan slugs).
   * `gaps` counts subject reads that FAILED (timeout, pool exhaustion) — the caller
   * must report them, never swallow them, so "no grade" is not claimed on a read
   * that did not complete.
   */
  readGrades: (subjectRefs: readonly string[]) => Promise<{ grades: readonly EscrowGrade[]; gaps: number }>;
  /** The install whose green-checkpoint routine carries the gate health. Default `papercusp`. */
  gateInstallSlug?: string;
}

/** Returns null when the goal does not exist in the workspace. */
export async function readGoalEscrowSnapshot(args: ReadGoalEscrowSnapshotArgs): Promise<GoalEscrowSnapshot | null> {
  const { sql, workspaceId, goalId, nowMs } = args;
  const goalRows = (await sql`
    SELECT id, status, standing, budget_cents, kill_criterion, metadata, updated_at, created_at
      FROM harness_shared.goals
     WHERE workspace_id = ${workspaceId} AND id = ${goalId}
     LIMIT 1
  `) as unknown as Row[];
  if (goalRows.length === 0) return null;
  const mapped = mapGoalRow(goalRows[0]!, nowMs);
  const goalCreatedAt = isoToMs(goalRows[0]!.created_at) ?? 0;

  const itemRows = (await sql`
    SELECT feature_id, status, authority, taken_by, terminal_owner, closed_ts,
           payload->'_completionEvidence' AS completion_evidence, terminal_completion_ref
      FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId}
       AND goal_id = ${goalId}
       AND lane IS DISTINCT FROM 'observation'
     ORDER BY closed_ts DESC NULLS LAST
  `) as unknown as Row[];
  const workItems = itemRows.map(mapWorkItemRow);

  const planRows = (await sql`
    SELECT plan_slug, status
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${workspaceId} AND goal_id = ${goalId} AND archived = false
  `) as unknown as Row[];
  const plans = planRows.map((r) => ({ slug: String(r.plan_slug), status: String(r.status) }));

  const gateRows = (await sql`
    SELECT metadata->'gate_health' AS gate_health
      FROM harness_shared.routines
     WHERE workspace_id = ${workspaceId}
       AND name = 'green-checkpoint'
       AND install_slug = ${args.gateInstallSlug ?? 'papercusp'}
     LIMIT 1
  `) as unknown as Row[];
  const { gate, noGoReason } = mapGateReading(gateRows[0]?.gate_health);

  const { grades, gaps: gradeReadGaps } = await args.readGrades([
    ...workItems.map((i) => i.id),
    ...plans.map((p) => p.slug),
  ]);

  // Owner reports: any message to the human or escalation after the goal began that
  // names this goal. Diagnosed by the same reader the kickoff gate uses.
  const reportRows = (await sql`
    SELECT ts, body
      FROM harness_shared.coord_event_log
     WHERE workspace_id = ${workspaceId}
       AND ts >= ${new Date(goalCreatedAt).toISOString()}::timestamptz
       AND superseded_by_msg_id IS NULL
       AND ((surface = 'messages' AND body->'to' @> '["human"]'::jsonb) OR surface = 'escalations')
       AND body::text LIKE ${'%' + goalId + '%'}
     ORDER BY ts DESC
     LIMIT 256
  `) as unknown as Row[];
  const ownerReports: EscrowOwnerReport[] = [];
  for (const row of reportRows) {
    const atMs = isoToMs(row.ts);
    if (atMs === null) continue;
    ownerReports.push({ diagnosis: diagnoseGoalOwnerReportEnvelope(row.body, goalId).kind, atMs });
  }

  return {
    observedAtMs: nowMs,
    goal: mapped.goal,
    workItems,
    plans,
    gate,
    noGoReason,
    grades,
    gradeReadGaps,
    spend: mapped.spend,
    ownerReports,
    ownerReportRequired: mapped.ownerReportRequired,
    ownerReportNotRequiredReason: mapped.ownerReportNotRequiredReason,
  };
}

/** The 5–10 goals the experiment samples: most recently updated, newest first. */
export async function listRecentGoalIds(sql: Sql, workspaceId: string, limit: number): Promise<string[]> {
  const rows = (await sql`
    SELECT id FROM harness_shared.goals
     WHERE workspace_id = ${workspaceId}
     ORDER BY updated_at DESC
     LIMIT ${Math.max(1, Math.min(50, limit))}
  `) as unknown as Row[];
  return rows.map((r) => String(r.id));
}
