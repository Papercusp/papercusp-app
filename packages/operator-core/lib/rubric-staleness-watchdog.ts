/**
 * rubric-staleness-watchdog.ts — the RELEASE-GATING rubric grading floor
 * (rubric-system-hardening-2026-07-14 P-004, EI-12149).
 *
 * The motivating gap: the blender-release-readiness rubric — the bar an actual
 * release decision reads — went ~14h ungraded on 2026-07-13/14 because the grader's
 * loop died silently, and NOTHING paged: scorecard-emission-pulse watches only the
 * pot-coordination-health monoculture, and scorecards:freshness answers only when
 * someone asks. A release bar nobody is grading is a SILENT gate, not a green one —
 * the next release call then reads a days-old verdict as if it were current.
 *
 * This watchdog closes that class for EVERY rubric that opts in: an ACTIVE rubric
 * whose `template_data.releaseGating === true` must have a COMPLETE scorecard
 * (rubricResolved + no missing/extra keys — checkScorecardFreshness's contract)
 * within the threshold window (default 6h). When one doesn't, the sweep fires ONE
 * debounced alert: a `pot_watchdog_fires` row (source 'rubric-staleness' — the
 * infra-liveness-style countable condition) + a coord ESCALATION naming the rubric,
 * the last complete grade, and how to grade it now.
 *
 * Same chassis as the sibling hive watchdogs (release-deploy-staleness, the
 * emission pulse): a PURE decider unit-tested with no DB, a thin PG sweep wired
 * into the shared routinesTick as one durable step, fail-soft throughout, an
 * env `<=0` kill switch, and the shared fires-ledger debounce.
 */
import { listRubrics, type Rubric, type RubricCriterion } from './rubrics';
import { checkScorecardFreshness, type ScorecardFreshness } from './scorecard-freshness';
import { recentWatchdogFires, recordFire } from './pot/watchdog';
import { openEscalation } from './agent-tools/coordination/escalations';
import type { AgentIdentity } from './agent-tools/coordination/identity';

// ── tunables (env-overridable, like the sibling watchdog floors) ───────────────

/** How long an ACTIVE releaseGating rubric may go without a COMPLETE scorecard
 *  before this watchdog alerts. Default 6h. `<=0` DISABLES the sweep (kill switch). */
export function rubricStalenessThresholdSec(): number {
  const n = Number(process.env.PAPERCUSP_RUBRIC_STALENESS_THRESHOLD_SEC ?? 21_600);
  return Number.isFinite(n) ? n : 21_600;
}

/** How long a proposed rubric may wait for independent review before the
 * proposal-dwell watchdog alerts. Default 24h; `<=0` disables that sweep. */
export function rubricProposalDwellThresholdSec(): number {
  const n = Number(process.env.PAPERCUSP_RUBRIC_PROPOSAL_DWELL_THRESHOLD_SEC ?? 86_400);
  return Number.isFinite(n) ? n : 86_400;
}

// ── pure decider (unit-tested with no DB) ──────────────────────────────────────

/**
 * Instrument bindings whose measured SUBSYSTEM no longer runs (WI-2145252). The
 * Mug/Cup/Kettle tier was retired 2026-08-09 (plan retire-mug-kettle-su-only-2026-08-09
 * D-001; the `papercusp-mug-kettle-system` flag is DELETED, not default-OFF, and the
 * actuator tools REFUSE — see agent-tools/_mug-kettle-gate.ts), so a criterion bound to
 * one of these can never earn a rating above `unknown`, and the rubric holding it can
 * never produce a COMPLETE scorecard.
 *
 * WHY THIS LIVES IN THE WATCHDOG and not in a standalone lint: a rubric is a DB row, so
 * no build-time check can see one. This is the one place that already reads every ACTIVE
 * releaseGating rubric on a cadence, which makes it the only surface that can catch a
 * retired-tier criterion being re-added later — the "pin the removal" half of the
 * precedent set one level up in apps/operator/lib/release/release-profile.ts
 * (AUTOLOOP_COMPONENT_RUBRIC_REFS, WI-5379): a mandatory component that CANNOT be graded
 * is not a strict gate, it is a permanently-red one.
 */
export const RETIRED_TIER_INSTRUMENT_KEYS: Readonly<Record<string, string>> = {
  'pot-throughput-ticks': 'Mug placement (harness_shared.pot_placements — 0 rows since 2026-07-19)',
  'mug-dispatched-cup-spawns': 'Cup execution (spawned_agents child_role=cup — none since 2026-08-17)',
  'kettle-autoloop-state': 'Kettle supervision',
  'e2e-traversal-trace': 'the Mug -> Cup -> Kettle traversal',
};

/** PURE: which of a rubric's criteria are bound to a retired subsystem's instrument. */
export function retiredTierCriteria(
  criteria: ReadonlyArray<Pick<RubricCriterion, 'key'> & { instrumentKey?: string | null }> | undefined,
): Array<{ key: string; instrumentKey: string; subsystem: string }> {
  if (!criteria) return [];
  const out: Array<{ key: string; instrumentKey: string; subsystem: string }> = [];
  for (const c of criteria) {
    const ik = c.instrumentKey ?? '';
    const subsystem = RETIRED_TIER_INSTRUMENT_KEYS[ik];
    if (subsystem) out.push({ key: c.key, instrumentKey: ik, subsystem });
  }
  return out;
}

/** The diagnosis appended to a STALE reason when the rubric cannot be graded at all.
 *  Empty string when no criterion is retired-tier bound, so the reason is unchanged. */
function ungradeableSuffix(
  criteria: ReadonlyArray<Pick<RubricCriterion, 'key'> & { instrumentKey?: string | null }> | undefined,
): string {
  const dead = retiredTierCriteria(criteria);
  if (dead.length === 0) return '';
  const named = dead.map((d) => `${d.key} (instrument ${d.instrumentKey} -> ${d.subsystem})`).join('; ');
  return (
    ` ⚠ UNGRADEABLE BY CONSTRUCTION — this is NOT a dead grader: ${dead.length} criteri` +
    `${dead.length === 1 ? 'on is' : 'a are'} bound to a RETIRED subsystem, so no complete scorecard is ` +
    `reachable no matter how often it is graded: ${named}. The repair is a rubrics:propose ` +
    `whole-document revision dropping them (rubrics:amend REFUSES criteria removal), not more grading.`
  );
}

export interface RubricStalenessVerdict {
  stale: boolean;
  /** Human-readable reason — the alert body for a stale read, the "why not" for a healthy one. */
  reason: string;
}

/**
 * PURE: is a release-gating rubric's grading stale? `freshness` is the
 * checkScorecardFreshness read over the threshold window, so `complete === true`
 * means a COMPLETE scorecard landed in-window (the mandate). A partial-only window
 * is called out distinctly — grading that silently truncates is a different failure
 * from grading that stopped, and the responder should know which they are chasing.
 *
 * A THIRD failure the first two cannot express (WI-2145252): the rubric is not
 * gradeable AT ALL because a criterion measures a subsystem that no longer runs. That
 * read fired here every ~3h for ~27 days on `autoloop-release-readiness` while blaming
 * "a dead grader loop", which sent every responder looking for a grader that was never
 * the problem. `criteria` is optional so no existing caller is stranded; when supplied,
 * a retired-tier binding is named in the reason.
 */
export function evaluateRubricStaleness(
  rubric: Pick<Rubric, 'rubricId'> & Partial<Pick<Rubric, 'criteria'>>,
  freshness: Pick<ScorecardFreshness, 'status' | 'complete' | 'count' | 'lastCompleteAt' | 'lastEmittedAt'>,
  thresholdMs: number,
): RubricStalenessVerdict {
  if (thresholdMs <= 0) return { stale: false, reason: 'kill switch (thresholdMs <= 0)' };
  if (freshness.complete) {
    return {
      stale: false,
      reason: `complete scorecard in-window (last at ${freshness.lastCompleteAt ?? 'unknown'})`,
    };
  }
  if (freshness.status === 'unknown-rubric') {
    return {
      stale: false,
      reason:
        `rubric '${rubric.rubricId}' is not registered — this is an invalid rubric reference, ` +
        `not a stale grader or emission gap; repair the reference separately.`,
    };
  }
  const hours = Math.max(1, Math.round(thresholdMs / 3_600_000));
  const ungradeable = ungradeableSuffix(rubric.criteria);
  if (freshness.status === 'partial-only') {
    return {
      stale: true,
      reason:
        `release-gating rubric '${rubric.rubricId}' has ${freshness.count} scorecard(s) in the last ${hours}h ` +
        `but NONE complete (silent truncation — the grader is filing partial cards). ` +
        `Newest emission ${freshness.lastEmittedAt ?? 'unknown'}; last COMPLETE grade predates the window.` +
        ungradeable,
    };
  }
  return {
    stale: true,
    reason:
      `release-gating rubric '${rubric.rubricId}' has NO scorecard in the last ${hours}h ` +
      `(grading stopped — a dead grader loop, not a healthy quiet period). ` +
      `The newest verdict on record predates the window; a release call reading it is reading stale evidence.` +
      ungradeable,
  };
}

export interface RubricProposalDwellVerdict {
  stale: boolean;
  reason: string;
  ageMs: number | null;
}

/** PURE: is a proposed rubric stuck awaiting its independent ratifier? */
export function evaluateRubricProposalDwell(
  rubric: Pick<Rubric, 'rubricId' | 'status' | 'updatedAt' | 'proposedBy'>,
  thresholdMs: number,
  nowMs = Date.now(),
): RubricProposalDwellVerdict {
  if (thresholdMs <= 0) return { stale: false, ageMs: 0, reason: 'kill switch (thresholdMs <= 0)' };
  if (rubric.status !== 'proposed') return { stale: false, ageMs: 0, reason: 'rubric is not proposed' };
  const updatedAtMs = Date.parse(rubric.updatedAt);
  if (!Number.isFinite(updatedAtMs)) {
    return {
      stale: true,
      ageMs: null,
      reason:
        `proposed rubric '${rubric.rubricId}' has an invalid updatedAt; ` +
        `cannot establish independent-ratifier progress`,
    };
  }
  const ageMs = Math.max(0, nowMs - updatedAtMs);
  if (ageMs < thresholdMs) {
    return {
      stale: false,
      ageMs,
      reason: `proposal updated ${Math.round(ageMs / 3_600_000)}h ago; within dwell threshold`,
    };
  }
  const hours = Math.max(1, Math.round(thresholdMs / 3_600_000));
  return {
    stale: true,
    ageMs,
    reason:
      `proposed rubric '${rubric.rubricId}' has no independent ratifier after ` +
      `${Math.max(1, Math.round(ageMs / 3_600_000))}h (dwell threshold ${hours}h); ` +
      `last updated ${rubric.updatedAt}; proposed by ${rubric.proposedBy ?? 'unknown'}`,
  };
}

// ── the PG sweep ───────────────────────────────────────────────────────────────

export interface RubricStalenessSweepResult {
  rubricRef: string;
  outcome: 'alerted' | 'healthy' | 'debounced' | 'skipped' | 'error';
  reason: string;
}

/** Synthetic identity for the background staleness escalation (mirrors the
 *  emission pulse's wedge identity). */
const RUBRIC_STALENESS_IDENTITY: AgentIdentity = {
  ownerId: 'rubric-staleness-watchdog',
  ownerLabel: 'system · rubric-staleness-watchdog',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/** Injectable seams so the sweep's orchestration is testable without PG. */
export interface RubricStalenessSweepDeps {
  listRubrics?: typeof listRubrics;
  checkScorecardFreshness?: typeof checkScorecardFreshness;
  recentWatchdogFires?: typeof recentWatchdogFires;
  recordFire?: typeof recordFire;
  openEscalation?: typeof openEscalation;
  now?: number;
}

/**
 * The rubric-staleness sweep: every ACTIVE `releaseGating` rubric must carry a
 * COMPLETE in-window scorecard. Debounced per rubric via the shared fires ledger
 * (one alert per threshold window, keyed `rubric-staleness` + reason-embedded
 * rubricRef); fail-soft per rubric AND overall (a watchdog that crashes its host
 * guards nothing). Kill switch: PAPERCUSP_RUBRIC_STALENESS_THRESHOLD_SEC <= 0.
 */
export async function rubricStalenessSweep(
  opts: { workspaceId?: string; installSlug?: string } = {},
  deps: RubricStalenessSweepDeps = {},
): Promise<RubricStalenessSweepResult[]> {
  const thresholdSec = rubricStalenessThresholdSec();
  if (thresholdSec <= 0) return [{ rubricRef: '*', outcome: 'skipped', reason: 'kill switch' }];
  const thresholdMs = thresholdSec * 1_000;
  const now = deps.now ?? Date.now();
  const workspaceId = opts.workspaceId ?? 'papercusp-workspace';
  const installSlug = opts.installSlug ?? 'papercusp';
  const results: RubricStalenessSweepResult[] = [];
  try {
    // P-011: releaseGating OR stalenessWatched. The two answer different questions —
    // "does a stale verdict block a ship?" and "is anyone still grading this?" — and
    // while one flag served both, an ongoing HEALTH rubric could only get watched by
    // masquerading as a release bar. So none did, and a dead health loop looked exactly
    // like a healthy one (EI-16072: only 2 of 23 active rubrics were watched at all).
    const rubrics = (await (deps.listRubrics ?? listRubrics)({ status: 'active' })).filter(
      (r) => r.releaseGating === true || r.stalenessWatched === true,
    );
    for (const rubric of rubrics) {
      try {
        const freshness = await (deps.checkScorecardFreshness ?? checkScorecardFreshness)({
          rubricRef: rubric.rubricId,
          since: new Date(now - thresholdMs).toISOString(),
        });
        const verdict = evaluateRubricStaleness(rubric, freshness, thresholdMs);
        if (!verdict.stale) {
          results.push({ rubricRef: rubric.rubricId, outcome: 'healthy', reason: verdict.reason });
          continue;
        }
        // Debounce: one alert per RUBRIC per threshold window (EI-16071). scopeKey
        // narrows the fires-ledger check to fires whose reason names THIS rubric
        // (evaluateRubricStaleness always quotes rubric.rubricId in its reason) —
        // without it, the debounce key was source-only, so the first stale rubric
        // in iteration order suppressed every OTHER stale rubric for the rest of
        // the window, degrading coverage to exactly one rubric per window no
        // matter how many gating rubrics exist.
        const windowHours = Math.max(1, Math.round(thresholdSec / 3_600));
        const firedRecently =
          (await (deps.recentWatchdogFires ?? recentWatchdogFires)(
            workspaceId,
            installSlug,
            windowHours,
            'rubric-staleness',
            rubric.rubricId,
          )) > 0;
        if (firedRecently) {
          results.push({ rubricRef: rubric.rubricId, outcome: 'debounced', reason: 'fires-ledger debounce' });
          continue;
        }
        console.warn(`[rubric-staleness] ALERT: ${verdict.reason}`);
        await (deps.recordFire ?? recordFire)({
          workspaceId,
          installSlug,
          source: 'rubric-staleness',
          reason: verdict.reason,
          wakeAt: null,
        });
        await (deps.openEscalation ?? openEscalation)(RUBRIC_STALENESS_IDENTITY, {
          severity: 'advisory',
          summary: `Release-gating rubric '${rubric.rubricId}' is ungraded past its ${Math.max(1, Math.round(thresholdSec / 3_600))}h window`,
          body:
            `${verdict.reason}\n\n` +
            `To re-grade: rubrics:get { rubricRef: '${rubric.rubricId}' } → gather per-criterion evidence per its ` +
            `methodRef runbook → file ONE complete scorecard via improvements:capture { lane:'observation', ` +
            `observation: { rubricRef, ratings } } → verify scorecards:list newest has missingKeys: []. ` +
            `If the assigned grader's loop died, restart/re-arm it — the staleness, not just the grade, is the defect (EI-12149).`,
        });
        results.push({ rubricRef: rubric.rubricId, outcome: 'alerted', reason: verdict.reason });
      } catch (e) {
        results.push({
          rubricRef: rubric.rubricId,
          outcome: 'error',
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } catch (e) {
    results.push({ rubricRef: '*', outcome: 'error', reason: e instanceof Error ? e.message : String(e) });
  }
  return results;
}

export interface RubricProposalDwellSweepDeps {
  listRubrics?: typeof listRubrics;
  recentWatchdogFires?: typeof recentWatchdogFires;
  recordFire?: typeof recordFire;
  openEscalation?: typeof openEscalation;
  now?: number;
}

/**
 * Alert on proposed rubrics that have outlived the independent-review dwell
 * window. This is deliberately a sibling sweep to release-scorecard staleness:
 * a valid proposal can be waiting for a reviewer even when no scorecard exists
 * yet, and the retired Mug/Queen path must not be required for activation.
 */
export async function rubricProposalDwellSweep(
  opts: { workspaceId?: string; installSlug?: string } = {},
  deps: RubricProposalDwellSweepDeps = {},
): Promise<RubricStalenessSweepResult[]> {
  const thresholdSec = rubricProposalDwellThresholdSec();
  if (thresholdSec <= 0) return [{ rubricRef: '*', outcome: 'skipped', reason: 'kill switch' }];
  const thresholdMs = thresholdSec * 1_000;
  const now = deps.now ?? Date.now();
  const workspaceId = opts.workspaceId ?? 'papercusp-workspace';
  const installSlug = opts.installSlug ?? 'papercusp';
  const results: RubricStalenessSweepResult[] = [];
  try {
    const rubrics = await (deps.listRubrics ?? listRubrics)({ status: 'proposed' });
    for (const rubric of rubrics) {
      try {
        const verdict = evaluateRubricProposalDwell(rubric, thresholdMs, now);
        if (!verdict.stale) {
          results.push({ rubricRef: rubric.rubricId, outcome: 'healthy', reason: verdict.reason });
          continue;
        }
        const windowHours = Math.max(1, Math.round(thresholdSec / 3_600));
        const firedRecently =
          (await (deps.recentWatchdogFires ?? recentWatchdogFires)(
            workspaceId,
            installSlug,
            windowHours,
            'rubric-proposal-dwell',
            rubric.rubricId,
          )) > 0;
        if (firedRecently) {
          results.push({ rubricRef: rubric.rubricId, outcome: 'debounced', reason: 'fires-ledger debounce' });
          continue;
        }
        console.warn(`[rubric-proposal-dwell] ALERT: ${verdict.reason}`);
        await (deps.recordFire ?? recordFire)({
          workspaceId,
          installSlug,
          source: 'rubric-proposal-dwell',
          reason: verdict.reason,
          wakeAt: null,
        });
        await (deps.openEscalation ?? openEscalation)(RUBRIC_STALENESS_IDENTITY, {
          severity: 'advisory',
          summary: `Proposed rubric '${rubric.rubricId}' has no independent ratifier`,
          body:
            `${verdict.reason}\n\n` +
            `To clear: an agent other than proposedBy reviews via rubrics:get and calls ` +
            `rubrics:ratify { rubricRef: '${rubric.rubricId}' }; the proposer must not self-ratify. ` +
            `If the proposal is unsound, revise it or deprecate it.`,
        });
        results.push({ rubricRef: rubric.rubricId, outcome: 'alerted', reason: verdict.reason });
      } catch (e) {
        results.push({
          rubricRef: rubric.rubricId,
          outcome: 'error',
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } catch (e) {
    results.push({ rubricRef: '*', outcome: 'error', reason: e instanceof Error ? e.message : String(e) });
  }
  return results;
}
