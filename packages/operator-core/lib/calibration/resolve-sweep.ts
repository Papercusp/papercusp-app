/**
 * Calibration resolution sweep (P-041 / FB-13) — matures open bets against
 * their domain's observed outcome. Cadence glue: the
 * `system:calibration-resolve` routine action calls runCalibrationResolveTick
 * after its flag + governor gates pass.
 *
 * Maturity-only by design: a bet resolves when its horizon passes, not when
 * the outcome first becomes visible — uniform timing keeps the Brier scores
 * comparable across domains (an early "plan shipped" still waits for the
 * horizon; what's scored is the claim AS BOUND, "X within the horizon").
 *
 * A probe answers true/false, or null = undeterminable (subject vanished,
 * probe read failed). Undeterminable bets stay open and re-probe next tick;
 * past VOID_GRACE_DAYS they are VOIDED (resolved_at set, outcome NULL) so
 * they leave the work list without ever entering a Brier score.
 */
import type { Sql } from 'postgres';
import { listMaturedUnresolved, resolvePrediction, voidPrediction } from './store';
import type { PredictionRow } from './types';

/** Per-domain outcome probes — injectable (tests run the sweep with no PG). */
export interface OutcomeProbes {
  /** fix-survival: the issue stayed resolved/closed AND its watchdogKey was not re-captured after the bet. */
  fixSurvived: (bet: PredictionRow) => Promise<boolean | null>;
  /** plan-ship: the plan reached frontmatter status 'shipped'. */
  planShipped: (bet: PredictionRow) => Promise<boolean | null>;
  /** flake-recurrence: the bet's watchdogKey re-captured after the bet was placed. */
  flakeRecurred: (bet: PredictionRow) => Promise<boolean | null>;
}

export interface CalibrationSweepDeps {
  sql: Sql;
  probes: OutcomeProbes;
  /** Store ops — injectable so sweep unit tests run with no PG. */
  list?: typeof listMaturedUnresolved;
  resolve?: typeof resolvePrediction;
  voidBet?: typeof voidPrediction;
  nowMs?: () => number;
  log?: (msg: string) => void;
}

export interface CalibrationSweepResult {
  matured: number;
  resolved: number;
  voided: number;
  /** Undeterminable inside grace — left open for the next tick. */
  skipped: number;
}

export const VOID_GRACE_DAYS = 45;
const DAY_MS = 24 * 60 * 60 * 1000;

function probeFor(probes: OutcomeProbes, domain: string): ((bet: PredictionRow) => Promise<boolean | null>) | null {
  switch (domain) {
    case 'fix-survival':
      return probes.fixSurvived;
    case 'plan-ship':
      return probes.planShipped;
    case 'flake-recurrence':
      return probes.flakeRecurred;
    default:
      return null; // unknown domain (vocabulary drift) — handled like undeterminable
  }
}

/** One sweep pass: resolve every matured bet whose probe answers, void past grace. Never throws. */
export async function runCalibrationResolveTick(
  workspaceId: string,
  deps: CalibrationSweepDeps,
  opts: { limit?: number } = {},
): Promise<CalibrationSweepResult> {
  const nowMs = deps.nowMs ?? (() => Date.now());
  const log = deps.log ?? ((m: string) => console.log(`[calibration-resolve] ${m}`));
  const list = deps.list ?? listMaturedUnresolved;
  const resolve = deps.resolve ?? resolvePrediction;
  const voidBet = deps.voidBet ?? voidPrediction;
  const nowIso = new Date(nowMs()).toISOString();
  const matured = await list(deps.sql, {
    workspaceId,
    nowIso,
    limit: opts.limit ?? 200,
  });
  const result: CalibrationSweepResult = { matured: matured.length, resolved: 0, voided: 0, skipped: 0 };
  for (const bet of matured) {
    const probe = probeFor(deps.probes, bet.domain);
    let outcome: boolean | null = null;
    if (probe) {
      try {
        outcome = await probe(bet);
      } catch (e) {
        log(`probe failed for ${bet.domain} bet ${bet.id} (left open): ${e instanceof Error ? e.message : e}`);
      }
    }
    if (outcome !== null) {
      if (await resolve(deps.sql, { id: bet.id, outcome, nowIso })) result.resolved += 1;
    } else if (nowMs() - bet.horizonTs > VOID_GRACE_DAYS * DAY_MS) {
      const note = probe ? 'probe undeterminable past grace' : `unknown domain '${bet.domain}' past grace`;
      if (await voidBet(deps.sql, { id: bet.id, note, nowIso })) result.voided += 1;
    } else {
      result.skipped += 1;
    }
  }
  return result;
}

/**
 * The live PG probes. fix-survival / flake-recurrence read through
 * issues-engineer (its own pool); plan-ship reads harness_plans on the
 * injected sql — same admin DB either way.
 */
export function defaultOutcomeProbes(sql: Sql): OutcomeProbes {
  return {
    async fixSurvived(bet) {
      const { getIssue, findIssuesByWatchdogKeys } = await import('../issues-engineer');
      const issue = await getIssue(bet.subjectId);
      if (!issue) return null;
      if (issue.state === 'open') return false; // reopened — the fix did not hold
      const payload = issue.payload as Record<string, unknown> | null | undefined;
      const key = bet.watchdogKey ?? (typeof payload?.watchdogKey === 'string' ? payload.watchdogKey : null);
      if (!key) return true; // no signal identity to re-capture on — resolved state is the whole truth
      const peers = await findIssuesByWatchdogKeys([key]);
      const recaptured = peers.some(
        (p) => p.id !== bet.subjectId && Date.parse(p.createdAt) > bet.createdAt,
      );
      return !recaptured;
    },
    async planShipped(bet) {
      const rows = await sql`
        SELECT status FROM harness_shared.harness_plans
         WHERE workspace_id = ${bet.workspaceId} AND plan_slug = ${bet.subjectId}
         ORDER BY updated_at DESC LIMIT 1
      `;
      if (rows.length === 0) return null;
      // harness_plans.status is NULLABLE with no default. `?? ''` resolved a NULL status to
      // `false` — "this plan did not ship" — from a row that records no status at all, which
      // is the one thing this resolver must not do: `null` is its own "cannot decide yet"
      // answer (the no-row branch above), and a bet resolved false on absent evidence is
      // scored against the forecaster (WI-5977: absence needs its own representation).
      const status = rows[0].status;
      if (status === null || status === undefined) return null;
      return String(status) === 'shipped';
    },
    async flakeRecurred(bet) {
      if (!bet.watchdogKey) return null;
      const { findIssuesByWatchdogKeys } = await import('../issues-engineer');
      const peers = await findIssuesByWatchdogKeys([bet.watchdogKey]);
      return peers.some((p) => p.id !== bet.subjectId && Date.parse(p.createdAt) > bet.createdAt);
    },
  };
}
