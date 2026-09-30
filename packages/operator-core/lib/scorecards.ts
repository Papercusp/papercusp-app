/**
 * scorecards — the structured-observation READ surface
 * (plan-templates-and-rubric-v2-2026-06-20 P-013 / D-005).
 *
 * A "scorecard" is a RUBRIC-GRADED structured observation: an
 * `engineer_issues.payload.observation` carrying a `rubricRef` + a `ratings`
 * Record (one rating+evidence per rubric criterion key). The Overwatch emits one
 * every turn against the `pot-coordination-health` rubric; Scout's digest (B9 /
 * rubric-driven-observations P-006) consumes them. Until now they were
 * WRITE-ONLY — invisible except via raw PG (the verification gap D-005 found:
 * partial scorecards + emission stalls could not be seen). This is the READ tool
 * that closes that gap and the linchpin the monitoring layer builds on (P-010
 * trend, P-014 emission-freshness, the Overwatch's own turn-over-turn
 * self-comparison).
 *
 * Reuse-first: the structured shape + parse come from the canonical
 * `observation-types.ts` (`asStructuredObservation`, the same validator the READ
 * path read-items.ts uses); `missingKeys` resolves through the existing
 * `getRubric` (so it survives v2's Phase-3 rubric-as-a-plan re-point — the seam
 * stays, the backing changes). Workspace scope reuses `issuesScopeWorkspace()` so
 * scorecards flip per-workspace exactly like the engineer_issues store they ride.
 */
import { createHash } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import { acquireWithContentionRetry } from './agent-tools/locks/contention-retry';
import {
  asStructuredObservation,
  normalizeScorecardRatings,
  scorecardAdmissionExclusion,
  type ScorecardAdmissionExclusion,
  type ObservationRatings,
  type ObservationSubject,
  type StructuredObservation,
  type ScorecardAcceptance,
  type ScorecardRetraction,
  type ScorecardRatingRubric,
  type ScorecardGradingAudit,
  type ScorecardGradingAuditCurrentness,
  type ScorecardProvisional,
  type ScorecardVetting,
  type ScorecardReleaseGateBinding,
  type SpecTestAdequacyRerunRecipe,
} from './harness/improvements/observation-types';
import {
  getIssue,
  issuesScopeWorkspace,
  issuesOutLinksMany,
  issuesSupersededByRevision,
  resolveIssueWorkspace,
  type IssueOutLink,
} from './issues-engineer';
import { boundedOrgTxn } from './pg-bounded-txn';
import { OrgTxnTimeoutError } from './pg-bounded-txn';
import { boundedPgReadTxn } from './pg-read-query';
import {
  classifyRubricEvidenceCurrentness,
  getRubric,
  rubricInstrumentContract,
  type Rubric,
  type RubricStatus,
} from './rubrics';
import type { OrgSql } from './work-items';
import { pgTimestampToIso } from './pg-timestamp';
import {
  compareGenerationFreshness,
  readBgHostActiveEnterMs,
  type GenerationFreshness,
} from './scout/generation-watermark';
import { trackDetached } from './detached-imports';

/** The owner-mandated built-in rubric whose prompt/backstop contract is fixed. */
export const HIVE_COORDINATION_HEALTH_RUBRIC = 'pot-coordination-health';
export const WORK_ON_EVERYTHING_STEWARDSHIP_RUBRIC = 'work-on-everything-stewardship-health';

export type ScorecardRollup = NonNullable<StructuredObservation['rollup']>;

const WORK_ON_EVERYTHING_CRITICAL_KEYS = new Set([
  'goal-mode-foundation',
  'frontier-scope-sovereignty',
  'delegated-execution-and-drain-health',
  'claim-flow-and-completion-integrity',
  'rolling-budget-circuit-and-capacity',
  'owner-steering-and-reporting',
  'retired-tier-nonresurrection',
  'plan-fleet-materialization',
]);

const ROLLUP_UNKNOWN_RATINGS = new Set(['unknown']);
const ROLLUP_FAILURE_RATINGS = new Set(['fail', 'broken']);

/**
 * Compute the non-compensating roll-up for the Work on everything rubric.
 *
 * Critical failures dominate, critical unknowns are explicitly unassessable,
 * and a mean score can never hide either. Other rubrics remain free to use
 * their existing per-criterion scales until they declare a roll-up contract.
 */
export function computeWorkOnEverythingRollup(
  rubricRef: string,
  ratings: ObservationRatings,
  requiredKeys: readonly string[],
): ScorecardRollup | undefined {
  if (rubricRef !== WORK_ON_EVERYTHING_STEWARDSHIP_RUBRIC) return undefined;
  const criticalKeys = requiredKeys.filter((key) => WORK_ON_EVERYTHING_CRITICAL_KEYS.has(key));
  const ratedKeys = Object.keys(ratings);
  const criticalFailures = criticalKeys.filter((key) => {
    const rating = ratings[key]?.rating?.trim().toLowerCase();
    return rating ? ROLLUP_FAILURE_RATINGS.has(rating) || rating === 'severe' : false;
  });
  const criticalUnknowns = criticalKeys.filter((key) => {
    const rating = ratings[key]?.rating?.trim().toLowerCase();
    return rating ? ROLLUP_UNKNOWN_RATINGS.has(rating) : true;
  });
  const coverage = {
    rated: ratedKeys.filter((key) => requiredKeys.includes(key)).length,
    required: requiredKeys.length,
    sufficient: requiredKeys.length > 0 && requiredKeys.every((key) => Boolean(ratings[key])),
  };
  const values = requiredKeys.map((key) => ratings[key]?.rating.trim().toLowerCase());
  const severe = values.includes('severe');
  const failure = values.some((rating) => rating !== undefined && ROLLUP_FAILURE_RATINGS.has(rating));
  const partial = values.some((rating) => ['partial', 'degraded', 'unknown'].includes(rating ?? ''));
  const verdict = severe
    ? 'severe'
    : failure
      ? 'fail'
      : !coverage.sufficient || criticalUnknowns.length > 0
        ? 'unassessable'
        : partial
          ? 'partial'
          : values.every((rating) => rating === 'exemplary')
            ? 'exemplary'
            : 'pass';
  return {
    verdict,
    criticalKeys,
    criticalFailures,
    criticalUnknowns,
    coverage,
  };
}

/**
 * New Work on everything cards carry a structured, replay-oriented evidence
 * envelope. Historical cards remain readable; only new/regraded cards are
 * subject to this contract.
 */
export function validateWorkOnEverythingEvidenceEnvelope(
  rubricRef: string,
  ratings: ObservationRatings,
): void {
  if (rubricRef !== WORK_ON_EVERYTHING_STEWARDSHIP_RUBRIC) return;
  for (const [key, entry] of Object.entries(ratings)) {
    const rating = entry.rating.trim().toLowerCase();
    if (!entry.evidenceRef || !entry.evidenceKind || !entry.attribution) {
      throw new Error(
        `Work on everything rating '${key}' requires evidenceRef, evidenceKind, and attribution; ` +
          'legacy prose-only evidence is readable but cannot be regraded without an evidence envelope',
      );
    }
    if (entry.absenceClaim && !entry.positiveControlRef) {
      throw new Error(
        `Work on everything rating '${key}' declares absenceClaim:true but has no positiveControlRef`,
      );
    }
    if (
      ['partial', 'fail', 'severe', 'broken', 'degraded'].includes(rating) &&
      ['instrument', 'environment'].includes(entry.attribution)
    ) {
      throw new Error(
        `Work on everything rating '${key}' describes a measurement limitation, not subject conduct; ` +
          "use unknown with unknownReason and nextEvidenceAction",
      );
    }
    if (rating !== 'unknown' && entry.unknownReason) {
      throw new Error(`Work on everything rating '${key}' carries unknownReason but is not unknown`);
    }
    if (rating === 'unknown') {
      if (!entry.unknownReason || !entry.nextEvidenceAction) {
        throw new Error(
          `Work on everything unknown rating '${key}' requires unknownReason and nextEvidenceAction`,
        );
      }
      if (entry.attribution === 'subject') {
        throw new Error(
          `Work on everything unknown rating '${key}' cannot attribute an unmeasured condition to the subject`,
        );
      }
    }
  }
}

/**
 * One measurement attached to a scorecard evaluation/emission.
 *
 * EI-20270994401737114 — READ `provenance` BEFORE TREATING THIS AS EVIDENCE. Every
 * snapshot on both scorecard paths is SUPPLIED BY THE CALLER: `instrumentSnapshots`
 * is a caller zod record on `scorecards:evaluate` and `scorecards:emit` alike, and
 * this type is constructed ZERO times outside that caller path (no instrument
 * registry or resolver exists). So the default case is a number the GRADER derived
 * and typed, sitting in a field named `evidenceRef` next to a rating the same grader
 * wrote.
 *
 * Do not confuse it with `checkRuns`. Five of the six criterion-check arms —
 * tests / cargo / probe / coverage / requirements — ARE executed by the platform at
 * grading time, and their verdicts land in `observation.checkRuns` as
 * `CriterionCheckRun`, a different type entirely. `kind:'instrument'` is the one arm
 * that executes nothing, and this is the channel it reads from. The asymmetry is in
 * WHO MEASURES, and it is invisible at the criterion level, where all six arms sit in
 * one union and read as peers (independently measured in EI-22201156528923669).
 *
 * That matters because `evaluateScorecardInstrumentContract` compares the rating to
 * THIS snapshot: for a self-reported snapshot that is an INTERNAL-CONSISTENCY check,
 * not a measurement. A grader who derives the wrong number files a `fail` rating
 * beside a `fail` snapshot — coherent, and wrong. That is the exact shape that
 * produced the retracted grade in EI-20266169712430445.
 */
export interface ScorecardInstrumentSnapshot {
  verdict: 'pass' | 'fail' | 'unknown';
  measuredAt: string;
  /** Concrete evidence window, kept JSON-shaped for instrument diversity. */
  window?: Record<string, unknown>;
  /** Bounded measurement (count/rate/status payload). */
  value?: unknown;
  /** Stable ledger/query/run reference supporting the snapshot. */
  evidenceRef?: string;
  /**
   * WHO produced this measurement — the field that separates evidence from assertion.
   *
   * `'self-reported'` (and ABSENT, which means the same thing) = the grader computed
   * and supplied it themselves. `'platform-computed'` = a deterministic platform
   * instrument produced it independently of the grader.
   *
   * ABSENT is deliberately read as self-reported rather than unknown: every snapshot
   * ever stored predates any computed path, so self-reported is the honest reading,
   * and a default that flattered the record would defeat the point of the field.
   *
   * Do NOT materialize that default INTO a stored snapshot — derive it at read time
   * via `scorecardInstrumentProvenance()`. `scorecardEvidenceFingerprint()` hashes
   * these objects, so writing a default in would shift every historical hash (the
   * same add-only-when-supplied constraint as `testedSha`, EI-18706603928993591).
   */
  provenance?: 'self-reported' | 'platform-computed';
}

/**
 * The honest provenance reading for one snapshot: absent ⇒ 'self-reported'.
 * Read-only by contract — never write the result back onto the snapshot.
 */
export function scorecardInstrumentProvenance(
  snapshot: ScorecardInstrumentSnapshot,
): 'self-reported' | 'platform-computed' {
  return snapshot.provenance === 'platform-computed' ? 'platform-computed' : 'self-reported';
}

/**
 * Resolve registered measurements at the existing instrument seam. Caller
 * snapshots are assertions, regardless of their claimed provenance. Only a
 * resolver executing here may stamp platform-computed. Results ride the
 * existing append-only observation.instrumentSnapshots, not a second ledger.
 */
export async function resolveScorecardInstrumentSnapshots(
  input: {
    rubric: Rubric;
    subject?: ObservationSubject;
    supplied?: Record<string, ScorecardInstrumentSnapshot>;
  },
  deps: {
    list?: typeof listScorecardPage;
    rubric?: typeof getRubric;
    now?: () => number;
  } = {},
): Promise<Record<string, ScorecardInstrumentSnapshot> | undefined> {
  const snapshots: Record<string, ScorecardInstrumentSnapshot> = Object.fromEntries(
    Object.entries(input.supplied ?? {}).map(([key, value]) => [
      key,
      value.provenance === 'platform-computed' ? { ...value, provenance: 'self-reported' as const } : { ...value },
    ]),
  );
  const registered = new Set(['woe.goal-mode-base-scorecard']);
  const keys = new Set(input.rubric.criteria.map((criterion) =>
    criterion.check?.kind === 'instrument' ? criterion.check.instrumentKey : criterion.instrumentKey,
  ));
  for (const key of keys) {
    if (!key || !registered.has(key)) continue;
    const measuredAt = new Date((deps.now ?? Date.now)()).toISOString();
    const subject = input.subject;
    const window = subject
      ? { subjectRef: subject.ref, windowStart: subject.windowStart, windowEnd: subject.windowEnd }
      : {};
    const unknown = (reason: string): ScorecardInstrumentSnapshot => ({
      verdict: 'unknown',
      measuredAt,
      provenance: 'platform-computed',
      window,
      value: { resolver: key, resolverVersion: 1, reason },
      evidenceRef: 'scorecards:list:goal-mode-e2e',
    });
    if (!subject?.ref || !subject.windowStart || !subject.windowEnd) {
      snapshots[key] = unknown('An exact subject observation window is required.');
      continue;
    }
    const start = Date.parse(subject.windowStart);
    const end = Date.parse(subject.windowEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
      snapshots[key] = unknown('The subject window is invalid.');
      continue;
    }
    try {
      const base = await (deps.rubric ?? getRubric)('goal-mode-e2e');
      const page = await (deps.list ?? listScorecardPage)({
        rubricRef: 'goal-mode-e2e',
        subjectRef: subject.ref,
        limit: 500,
      });
      const card = page.rows.find((candidate) =>
        candidate.subject?.ref === subject.ref &&
        Date.parse(candidate.subject?.windowStart ?? '') === start &&
        Date.parse(candidate.subject?.windowEnd ?? '') === end &&
        candidate.rubricResolved &&
        candidate.missingKeys.length === 0 &&
        candidate.extraKeys.length === 0 &&
        !candidate.synthesized && !candidate.provisional && !candidate.retracted &&
        candidate.gradingAudit?.state === 'passed' &&
        settledGradingAuditIsCurrent(candidate) &&
        Boolean(base?.criteriaHash) && candidate.criteriaHash === base?.criteriaHash,
      );
      if (!base || !card) {
        snapshots[key] = unknown(
          page.hasMore
            ? 'No matching audited base card in the bounded page; coverage is incomplete.'
            : 'No complete, audited, current-contract base card for this exact subject window.',
        );
        continue;
      }
      const verdicts = Object.values(card.ratings).map((entry) => entry.rating.toLowerCase());
      // Partial/unknown base behavior cannot establish a passing foundation.
      const verdict = verdicts.some((rating) => ['fail', 'severe', 'broken'].includes(rating))
        ? 'fail'
        : verdicts.length > 0 && verdicts.every((rating) => ['pass', 'exemplary', 'healthy'].includes(rating))
          ? 'pass'
          : 'unknown';
      snapshots[key] = {
        verdict,
        measuredAt,
        provenance: 'platform-computed',
        window,
        evidenceRef: card.issueId,
        value: {
          resolver: key,
          resolverVersion: 1,
          baseCard: card.issueId,
          rubricRevision: card.rubricRevision,
          criteriaHash: card.criteriaHash,
          subject: card.subject,
          ratings: card.ratings,
          gradingAudit: card.gradingAudit,
        },
      };
    } catch (error) {
      snapshots[key] = unknown(`Base-card instrument unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return Object.keys(snapshots).length ? snapshots : undefined;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Stable evidence identity used by scorecards:evaluate/emit. Timestamps that are
 * measurement DATA remain significant; object insertion order and criterion order do
 * not. This keeps append-only history meaningful while declining byte-shuffled repeats.
 */
export function scorecardEvidenceFingerprint(input: {
  rubricRef: string;
  ratings: ObservationRatings;
  instrumentSnapshots?: Record<string, ScorecardInstrumentSnapshot>;
  acceptance?: ScorecardAcceptance;
  rerunRecipe?: SpecTestAdequacyRerunRecipe;
  testedSha?: string;
}): string {
  // Keep the pre-D-001 byte shape unchanged when no acceptance verdict exists,
  // so historical stored fingerprints remain comparable without a migration.
  const material: Record<string, unknown> = {
    rubricRef: input.rubricRef,
    ratings: input.ratings,
    instrumentSnapshots: input.instrumentSnapshots ?? {},
  };
  if (input.acceptance) material.acceptance = input.acceptance;
  // Preserve every historical fingerprint when the optional replay contract is absent,
  // while making a persisted spec-test-adequacy recipe part of the scorecard identity.
  if (input.rerunRecipe) material.rerunRecipe = input.rerunRecipe;
  // EI-18706603928993591: a release grade against a different tested commit is
  // different evidence even when its prose ratings and instrument values match.
  // Keep historical hashes byte-stable by adding the field only when supplied.
  if (input.testedSha) material.testedSha = input.testedSha;
  return createHash('sha256').update(canonicalJson(material)).digest('hex');
}

export interface ScorecardInstrumentContractEvaluation {
  valid: boolean;
  bindings: Record<string, string | null>;
  missingBindings: string[];
  duplicateBindings: string[];
  missingSnapshots: string[];
  extraSnapshots: string[];
  staleSnapshots: string[];
  windowMismatches: string[];
  verdictMismatches: string[];
  /**
   * EI-20270994401737114 — bound instrument keys whose supplied snapshot is
   * SELF-REPORTED (see `ScorecardInstrumentSnapshot.provenance`). For these keys the
   * `verdictMismatches` check above is an INTERNAL-CONSISTENCY test of the grader's
   * two claims, not an independent measurement: a grader who derived the wrong number
   * agrees with themselves and passes it cleanly.
   *
   * Deliberately does NOT affect `valid`. Today every stored snapshot is self-reported,
   * so failing on it would refuse every existing grading path; the honest move is to
   * make the epistemic class VISIBLE to the caller (and to `scorecards:evaluate`, which
   * returns this whole contract to the grader) rather than to pretend it away.
   */
  selfReportedInstruments: string[];
}

function expectedInstrumentVerdict(rating: string): ScorecardInstrumentSnapshot['verdict'] | null {
  const key = rating.trim().toLowerCase();
  if (['pass', 'healthy', 'green', 'good', 'yes', 'exemplary', 'exceptional'].includes(key)) return 'pass';
  if (['fail', 'broken', 'red', 'bad', 'no', 'severe'].includes(key)) return 'fail';
  if (key === 'unknown') return 'unknown';
  return null;
}

/** True when at least one criterion claims a positive/pass-like verdict. */
export function scorecardRatingsClaimPass(ratings: ObservationRatings): boolean {
  return Object.values(ratings).some((entry) => expectedInstrumentVerdict(entry.rating) === 'pass');
}

/** The small live-pipeline slice needed to bind a positive release scorecard. */
export interface ScorecardReleaseGateSnapshot {
  generatedAtMs: number;
  gate: {
    /**
     * The pipeline writer distinguishes a measured zero-red state from a
     * defaulted zero whose counters were absent. A release proof must preserve
     * that distinction: an unmeasured gate is not green evidence.
     */
    countersUnknown?: unknown | null;
    recordedVerdict: 'green' | 'not-green' | null;
    verdictStale: boolean;
    verdictStaleReason: string | null;
    fireStale: boolean;
    fireStaleReason: string | null;
    consecutiveNoVerdict: number;
    inconclusive: { status: string; detail: string | null } | null;
    observedCandidate: string | null;
    failingTests: string[];
  };
  deploy: {
    greenPin: { sha: string } | null;
    stagingHead: { sha: string } | null;
    greenPinBehindStaging: number | null;
  };
}

function scorecardShaMatches(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = a?.trim().toLowerCase() ?? '';
  const right = b?.trim().toLowerCase() ?? '';
  if (left.length < 7 || right.length < 7) return false;
  return left.startsWith(right) || right.startsWith(left);
}

/**
 * Bind a pass-claiming release scorecard to the exact commit the authoritative
 * gate proved green. The current staging HEAD is part of the proof: a drill run
 * against yesterday's green pin cannot paint today's release rubric green.
 */
export function evaluateScorecardReleaseGateBinding(input: {
  testedSha?: string | null;
  snapshot: ScorecardReleaseGateSnapshot;
}): ScorecardReleaseGateBinding {
  const testedSha = input.testedSha?.trim() || null;
  const { gate, deploy } = input.snapshot;
  const checkedAt = Number.isFinite(input.snapshot.generatedAtMs)
    ? new Date(input.snapshot.generatedAtMs).toISOString()
    : new Date().toISOString();
  const base = {
    checkedAt,
    testedSha,
    gateVerdict: gate.recordedVerdict,
    gateCandidate: gate.observedCandidate,
    lastGreenCommit: deploy.greenPin?.sha ?? null,
    stagingHead: deploy.stagingHead?.sha ?? null,
    commitsBehindHead: deploy.greenPinBehindStaging,
    failingTests: gate.failingTests,
  };
  const blocked = (reasonCode: string, reason: string): ScorecardReleaseGateBinding => ({
    status: 'stale-pass-blocked',
    reasonCode,
    reason,
    ...base,
  });

  if (!testedSha) {
    return blocked(
      'tested-sha-required',
      'positive ratings on a release-gating rubric require testedSha so the gate and drill can be bound to one commit',
    );
  }
  if (gate.countersUnknown) {
    return blocked(
      'gate-counters-unknown',
      'the release-gate counters are unmeasured; its displayed colour cannot authorize a scorecard pass',
    );
  }
  if (gate.inconclusive) {
    return blocked(
      'gate-inconclusive',
      `the latest gate run produced no code verdict (${gate.inconclusive.status})${
        gate.inconclusive.detail ? `: ${gate.inconclusive.detail}` : ''
      }`,
    );
  }
  if (gate.consecutiveNoVerdict > 0) {
    return blocked(
      'gate-no-verdict',
      `the gate has ${gate.consecutiveNoVerdict} consecutive run(s) without a verdict; its older colour cannot authorize a pass`,
    );
  }
  if (gate.verdictStale) {
    return blocked('gate-verdict-stale', gate.verdictStaleReason ?? 'the recorded gate verdict is stale');
  }
  if (gate.fireStale) {
    return blocked('gate-fire-stale', gate.fireStaleReason ?? 'the green-checkpoint routine is stale');
  }
  if (gate.recordedVerdict !== 'green') {
    const failures = gate.failingTests.length > 0 ? `; failing tests: ${gate.failingTests.join(', ')}` : '';
    return blocked(
      gate.recordedVerdict === 'not-green' ? 'gate-not-green' : 'gate-verdict-unavailable',
      `the authoritative gate verdict is ${gate.recordedVerdict ?? 'unavailable'}, not green${failures}`,
    );
  }
  if (!deploy.greenPin?.sha) {
    return blocked('green-pin-unavailable', 'the gate is green but its last green commit is unavailable');
  }
  if (!deploy.stagingHead?.sha) {
    return blocked('staging-head-unavailable', 'the current staging HEAD is unavailable');
  }
  if (!scorecardShaMatches(testedSha, deploy.greenPin.sha)) {
    return blocked(
      'tested-sha-not-green-pin',
      `testedSha ${testedSha} does not match the last green commit ${deploy.greenPin.sha}`,
    );
  }
  if (!scorecardShaMatches(testedSha, deploy.stagingHead.sha)) {
    return blocked(
      'tested-sha-behind-head',
      `testedSha ${testedSha} is not current staging HEAD ${deploy.stagingHead.sha}`,
    );
  }
  if (gate.observedCandidate && !scorecardShaMatches(testedSha, gate.observedCandidate)) {
    return blocked(
      'gate-candidate-mismatch',
      `testedSha ${testedSha} does not match the gate candidate ${gate.observedCandidate}`,
    );
  }

  return {
    status: 'bound',
    reasonCode: null,
    reason: null,
    ...base,
  };
}

/** Live resolver shared by scorecards:evaluate and scorecards:emit. Fail closed. */
export async function resolveScorecardReleaseGateBinding(
  testedSha: string | null | undefined,
  deps: { snapshot?: () => Promise<ScorecardReleaseGateSnapshot>; now?: () => number } = {},
): Promise<ScorecardReleaseGateBinding> {
  try {
    const snapshot = await (deps.snapshot ?? (async () => {
      const { gitPipelineSnapshot } = await import('./git-pipeline-stats');
      return gitPipelineSnapshot();
    }))();
    return evaluateScorecardReleaseGateBinding({ testedSha, snapshot });
  } catch (error) {
    return {
      status: 'stale-pass-blocked',
      reasonCode: 'gate-state-unavailable',
      reason: `the authoritative release gate could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
      checkedAt: new Date((deps.now ?? Date.now)()).toISOString(),
      testedSha: testedSha?.trim() || null,
      gateVerdict: null,
      gateCandidate: null,
      lastGreenCommit: null,
      stagingHead: null,
      commitsBehindHead: null,
      failingTests: [],
    };
  }
}

/**
 * Validate the one-criterion↔one-instrument contract and the evidence freshness/window
 * that a release-gating scorecard claims. UNKNOWN or stale evidence is never silently
 * green: callers get exact missing/stale/mismatch arrays and must fix them before emit.
 */
export function evaluateScorecardInstrumentContract(input: {
  rubric: Rubric;
  ratings: ObservationRatings;
  instrumentSnapshots?: Record<string, ScorecardInstrumentSnapshot>;
  nowMs?: number;
}): ScorecardInstrumentContractEvaluation {
  const contract = rubricInstrumentContract(input.rubric);
  const snapshots = input.instrumentSnapshots ?? {};
  const required = new Set(
    Object.values(contract.bindings).filter((key): key is string => Boolean(key) && key !== 'none'),
  );
  const missingSnapshots = [...required].filter((key) => !snapshots[key]);
  const extraSnapshots = Object.keys(snapshots).filter((key) => !required.has(key));
  const staleSnapshots: string[] = [];
  const windowMismatches: string[] = [];
  const verdictMismatches: string[] = [];
  const selfReportedInstruments: string[] = [];
  const nowMs = input.nowMs ?? Date.now();

  for (const criterion of input.rubric.criteria) {
    const instrumentKey = contract.bindings[criterion.key];
    if (!instrumentKey || instrumentKey === 'none') continue;
    const snapshot = snapshots[instrumentKey];
    if (!snapshot) continue;
    // EI-20270994401737114 — record the epistemic class BEFORE the freshness/window
    // `continue`s below. A stale or window-mismatched snapshot is still self-reported,
    // and that is exactly when a reader most needs to know the number came from the
    // grader rather than from a measurement.
    if (scorecardInstrumentProvenance(snapshot) === 'self-reported') {
      selfReportedInstruments.push(instrumentKey);
    }
    const measuredAtMs = Date.parse(snapshot.measuredAt);
    if (!Number.isFinite(measuredAtMs) || measuredAtMs > nowMs + 60_000) {
      staleSnapshots.push(instrumentKey);
      continue;
    }
    if (criterion.window?.kind === 'rolling') {
      const rollingMs = criterion.window.ms;
      if (typeof rollingMs !== 'number' || !Number.isFinite(rollingMs) || rollingMs <= 0) {
        windowMismatches.push(instrumentKey);
      } else if (nowMs - measuredAtMs > rollingMs) {
        staleSnapshots.push(instrumentKey);
      }
    } else if (criterion.window?.kind === 'post-watermark') {
      const window = snapshot.window ?? {};
      const sinceMs = typeof window.sinceMs === 'number' ? window.sinceMs : null;
      const watermarkRef = typeof window.watermarkRef === 'string' ? window.watermarkRef : null;
      if (
        watermarkRef !== criterion.window.watermarkRef ||
        sinceMs === null ||
        !Number.isFinite(sinceMs) ||
        measuredAtMs < sinceMs
      ) {
        windowMismatches.push(instrumentKey);
      }
    }
    const expected = expectedInstrumentVerdict(input.ratings[criterion.key]?.rating ?? '');
    if (expected && expected !== snapshot.verdict) verdictMismatches.push(instrumentKey);
  }

  return {
    valid:
      contract.valid &&
      missingSnapshots.length === 0 &&
      extraSnapshots.length === 0 &&
      staleSnapshots.length === 0 &&
      windowMismatches.length === 0 &&
      verdictMismatches.length === 0,
    bindings: contract.bindings,
    missingBindings: contract.criteriaWithoutInstrument,
    duplicateBindings: contract.duplicateInstrumentKeys,
    missingSnapshots,
    extraSnapshots,
    staleSnapshots: [...new Set(staleSnapshots)],
    windowMismatches: [...new Set(windowMismatches)],
    verdictMismatches: [...new Set(verdictMismatches)],
    selfReportedInstruments: [...new Set(selfReportedInstruments)],
  };
}

/** The canonical 15 keys for pot-coordination-health. This is a fallback for
 * read-side completeness only: if the rubric-template store is temporarily
 * unreachable/unresolvable, the monitor-of-monitor must not mark a 15-key
 * owner-mandated scorecard partial. Unknown rubrics still stay unresolved.
 *
 * EI-13292: this list drifted to 14 keys (missing `context-burn`, added by the
 * loop-wake context-diet work / EI-7624) after the rubric itself was extended to
 * 15 criteria — so a scorecard rating all 15 (correctly) would be misread as
 * carrying an "extra" key whenever this fallback was consulted (rubric store
 * briefly unreachable). Keep this in sync with `rubrics/pot-coordination-health/rubric.json`
 * (the first-party seed bundle) — the true source of truth — whenever a criterion
 * is added/removed there. */
export const HIVE_COORDINATION_HEALTH_KEYS = [
  'end-to-end-flow',
  'ideation-quality',
  'queen-workitem-selection',
  'queen-plan-selection',
  'parallel-distribution',
  'bee-execution',
  'bee-observation-quality',
  'overwatch-observation-quality',
  'watchdog-determinism',
  'coordination-comms',
  'chatter-economy',
  'coordination-utilization',
  'tool-utilization',
  'scheduler-usage',
  'context-burn',
] as const;

export function builtInCriterionKeysForRubric(rubricRef: string): string[] | null {
  return rubricRef === HIVE_COORDINATION_HEALTH_RUBRIC ? [...HIVE_COORDINATION_HEALTH_KEYS] : null;
}

/** One scorecard row — a rubric-graded observation projected for monitoring. */
export interface ScorecardRow {
  /** The engineer_issue id (EI-/WI-…) — the drill-back key. */
  issueId: string;
  /** ISO timestamp the scorecard was filed. */
  createdAt: string;
  /** Who emitted it (ownerId), when recorded. */
  createdBy: string | null;
  /** The hive the observation came FROM (the grouping axis), when set. */
  sourceHive?: string;
  /**
   * WHAT this scorecard graded, when the emitter said so (P-009): the drill
   * parameter binding `{ ref, kind?, windowStart?, windowEnd? }`. For a per-RUN
   * rubric this is the identity that makes a scorecard attributable to its run and
   * re-runnable from its own record. Absent on every pre-P-009 scorecard — treat
   * absence as "not recorded", never as "graded nothing".
   */
  subject?: ObservationSubject;
  /** Exact replay selector/currentness attestation for spec-test-adequacy cards. */
  rerunRecipe?: SpecTestAdequacyRerunRecipe;
  /** The rubric graded against (a `rubrics.rubric_id`). */
  rubricRef: string;
  /** The graded rubric's plan-row revision at emit time; absent on historical cards. */
  rubricRevision?: number;
  /** Acceptance-BAR meaning epoch at emit time; absent on legacy or non-BAR cards. */
  rubricMeaningRevision?: number;
  /** The graded rubric's substantive criteria/method identity at emit time. */
  criteriaHash?: string;
  /** Emit-time identity of a rubric named as the subject, distinct from rubricRef. */
  subjectRubricIdentity?: NonNullable<StructuredObservation['subjectRubricIdentity']>;
  /** Read-time comparison of the graded subject rubric with its live identity. */
  subjectRubricCurrentness?: ScorecardSubjectRubricCurrentness;
  /** Per-criterion ratings, keyed by rubric criterion `key` (each {rating, evidence}). */
  ratings: ObservationRatings;
  /** Server-derived categorical roll-up when the rubric declares one. */
  rollup?: ScorecardRollup;
  /** Commit the positive release-gating ratings tested, when gate-bound. */
  testedSha?: string;
  /** Server-stamped release-gate proof for `testedSha`, when gate-bound. */
  releaseGateBinding?: ScorecardReleaseGateBinding;
  /** Deterministic instrument snapshots persisted alongside the ratings, when supplied. */
  instrumentSnapshots?: Record<string, ScorecardInstrumentSnapshot>;
  /** The acceptance-rubric author's post-independent-grading verdict, when recorded. */
  acceptance?: ScorecardAcceptance;
  /** How many criteria this scorecard rated (`Object.keys(ratings).length`). */
  nKeys: number;
  /**
   * Rubric criterion keys the scorecard did NOT rate — the completeness signal
   * (P-014's gate reads this). Empty when the scorecard is complete OR when the
   * rubric can't be resolved (then `rubricResolved` is false, so an empty list is
   * never misread as "complete"). Sorted in the rubric's own criteria order.
   */
  missingKeys: string[];
  /**
   * Rated keys that the current rubric does NOT declare. Historical malformed
   * scorecards remain auditable, but are incomplete and never become trend axes.
   */
  extraKeys: string[];
  /** Whether `rubricRef` resolved to a known rubric (so `missingKeys` is meaningful). */
  rubricResolved: boolean;
  /** Stable canonical evidence identity when filed through scorecards:emit. */
  evidenceFingerprint?: string;
  /** The scorecard issue this filing corrected, when present on the raw payload. */
  supersedes?: string;
  /** Machine-readable withdrawal metadata, when the scorecard was retracted. */
  retracted?: ScorecardRetraction;
  /**
   * P-008 provisional stamp (EI-20581177540737568): this card rated 'violatable'-class
   * criteria without the emitter affirming subject termination — a working note
   * (D-004), excluded from the trend until a terminal re-emit supersedes it.
   */
  provisional?: ScorecardProvisional;
  /**
   * P-013: the grade-the-grader audit stamp. state:'pending' behaves like
   * `provisional` in the trend (excluded, loudly counted) until a NON-AUTHOR audit
   * against the grading-integrity meta-rubric settles it passed/failed.
   */
  gradingAudit?: ScorecardGradingAudit;
  /** Read-time comparison of the audit stamp with the live meta-rubric identity. */
  gradingAuditCurrentness?: ScorecardGradingAuditCurrentness;
  /**
   * The vetting linkage (consult-min-max-and-rubric-vetting-2026-08-17 P-004) —
   * present only on a vetting scorecard (a meta-rubric grading of an acceptance
   * rubric; `subject` then names the vetted rubric). The acceptance gate's
   * `acceptance_rubric_unvetted` check reads the critique channel — `consultId`
   * (the linked get_feedback consult) or `workItemId` (WI-41477: the review
   * work-item a launched independent reviewer's comments land on) — and
   * `rubricRevision` (the vetted rubric's plan-row version at emit).
   */
  vetting?: ScorecardVetting;
  /** The newest payload superseder that points at this scorecard, when known. */
  supersededBy?: string;
  /**
   * True when this scorecard is a SYNTHESIZED floor (`payload.observation.synthesized`),
   * not an agent emission — the deterministic backstop filed by overwatch/scorecard-backstop
   * when an Overwatch turn ended without one. EXCLUDED by default (see `includeSynthesized`)
   * so the agent-emission freshness/trend/staleness signals never count the floor as the
   * agent doing its job.
   */
  synthesized: boolean;
  /**
   * READ-TIME 0–10 projection of this scorecard (rubrics-tab-scorecard-ui-2026-07-09
   * P-004 / D-001): the mean of the per-criterion numeric projections
   * ({@link ratingScore10}) over the criteria whose rating maps (unknown/custom
   * ratings are excluded, never counted as 0). Null when NO rating maps. Grading
   * stays CATEGORICAL at capture time — this number is derived on read, so past
   * scorecards get it automatically (numeric "backfill" with no migration).
   */
  score10: number | null;
  /**
   * Outbound coord_links edges from this scorecard's issue (WI-3594: the
   * scorecard→improvement flow) — e.g. a `relates`/`fixes` edge to the
   * improvement/work-item this grading is about, when one was linked at file
   * time (via `improvements:capture`'s `observation.linkTo`, or `work_items:link`
   * after the fact). Empty when nothing is linked; excludes `tagged` (topic tags
   * are not references).
   */
  linkedItems: { rel: string; dst: { kind: string; ref: string } }[];
  /**
   * The GENERATION this scorecard graded (EI-12147; reworked WI-5397): stamped
   * SERVER-SIDE by improvements:capture at file time (never caller-supplied) via
   * generation-watermark.ts's readRunningGeneration(). A reader comparing an older
   * `hostStartedAt` to the current one knows the scorecard judged a DIFFERENT
   * generation (stale evidence after a restart/deploy), which is the ambiguity
   * that stalled the 2026-07-14 GO call. WI-5397 widened the stamp to make that
   * staleness EXPLICIT (`staleHost`) instead of relying on the reader to notice a
   * hostStartedAt mismatch by hand — see generation-watermark.ts's RunningGeneration
   * doc comment for the full shape rationale. Absent on pre-stamp scorecards.
   */
  gradedGeneration?: GradedGeneration;
  /**
   * WI-5277: whether {@link gradedGeneration}'s boundary is STILL the running one, judged
   * at READ time against the live bg-host watermark. Present whenever the row carries a
   * `gradedGeneration` at all.
   *
   * ⚠ Do NOT substitute `gradedGeneration.staleHost` for this. That field is frozen at
   * stamp time and says whether the scout was provably running the graded code THEN; it
   * cannot say whether the generation has since ENDED. A row reading `staleHost: false`
   * can still be `{ status: 'stale' }` here — which is precisely the 2026-07-17 failure
   * (a 4.5h soak + 6/6 verdict voided by a restart 3 minutes after emit) that no reader
   * noticed because a plausible-looking `staleHost` was sitting right next to it.
   */
  generationFreshness?: GenerationFreshness;
}

/**
 * The evidence-first projection for one scorecard.
 *
 * This is deliberately not a smaller `ScorecardRow`: the history row carries
 * replay recipes, generation stamps, instrument snapshots, and link metadata
 * for monitoring and trend consumers. An auditor needs the opposite shape —
 * the exact criterion evidence and only the identity/completeness fields that
 * tell them which card they are re-running. Keeping this projection separate
 * prevents a future list-row field from silently making the single-card audit
 * read spill again (EI-22710824425098387).
 */
export type ScorecardEvidenceCriterion = ObservationRatings[string] & {
  key: string;
};

export interface ScorecardEvidenceRow {
  issueId: string;
  createdAt: string;
  createdBy: string | null;
  rubricRef: string;
  rubricRevision?: number;
  criteriaHash?: string;
  /** Stable identity of the exact rated evidence, when recorded at emit time. */
  evidenceFingerprint?: string;
  sourceHive?: string;
  subject?: ObservationSubject;
  criteria: ScorecardEvidenceCriterion[];
  rollup?: ScorecardRollup;
  nKeys: number;
  missingKeys: string[];
  extraKeys: string[];
  rubricResolved: boolean;
  synthesized: boolean;
  gradingAudit?: ScorecardGradingAudit;
  provisional?: ScorecardProvisional;
  retracted?: ScorecardRetraction;
  /** Read-time: the live subject rubric vs the identity recorded at grading (subject.kind==='rubric' only). */
  subjectRubricCurrentness?: ScorecardSubjectRubricCurrentness;
  /** Read-time: the newer card whose observation.supersedes names this one. */
  supersededBy?: string;
  /**
   * Always-present, explicit answer to "may a grading audit still target this
   * card?" so an auditor never has to infer currentness from an ABSENT key.
   */
  auditTarget: ScorecardAuditTargetStatus;
}

export interface ScorecardAuditTargetStatus {
  /** true only when not superseded, not retracted, and (for a rubric subject) the subject rubric is current. */
  current: boolean;
  superseded: boolean;
  supersededBy: string | null;
  retracted: boolean;
  /** null when the subject is not a rubric (the check does not apply). */
  subjectRubricCurrentness: ScorecardSubjectRubricCurrentness | null;
}

export type ScorecardEvidenceReadResult =
  | { kind: 'found'; scorecard: ScorecardEvidenceRow }
  | { kind: 'not_found' }
  | { kind: 'not_scorecard' };

interface ScorecardEvidenceDb {
  issue_id: string;
  created_by: string | null;
  created_at: string | Date;
  rubric_ref: string | null;
  rubric_revision: unknown;
  rubric_meaning_revision: unknown;
  criteria_hash: string | null;
  evidence_fingerprint: string | null;
  source_hive: string | null;
  subject: unknown;
  ratings: unknown;
  rollup: unknown;
  synthesized: unknown;
  grading_audit: unknown;
  provisional: unknown;
  retracted: unknown;
  subject_rubric_identity: unknown;
  superseded_by: string | null;
}

/**
 * Read one scorecard with an evidence-first storage projection.
 *
 * Do not implement this as `listScorecards({ limit: ... })` plus an in-memory
 * lookup: that path selects and parses every history-only field, including
 * replay recipes and generation metadata, before the transport can shape the
 * result. Selecting only the audit identity, completeness markers, and ratings
 * keeps the exact evidence available while making the bounded wire contract
 * independent of those unrelated fields (EI-22710824425098387).
 */
export async function readScorecardEvidence(issueId: string): Promise<ScorecardEvidenceReadResult> {
  const rows = await acquireWithContentionRetry(() =>
    boundedPgReadTxn<ScorecardEvidenceDb[]>((tx) => tx<ScorecardEvidenceDb[]>`
      SELECT scorecard.issue_id,
             scorecard.created_by,
             scorecard.created_at,
             scorecard.payload -> 'observation' ->> 'rubricRef' AS rubric_ref,
             scorecard.payload -> 'observation' -> 'rubricRevision' AS rubric_revision,
             scorecard.payload -> 'observation' -> 'rubricMeaningRevision' AS rubric_meaning_revision,
             scorecard.payload -> 'observation' ->> 'criteriaHash' AS criteria_hash,
             scorecard.payload -> 'observation' ->> 'evidenceFingerprint' AS evidence_fingerprint,
             scorecard.payload -> 'observation' ->> 'sourceHive' AS source_hive,
             scorecard.payload -> 'observation' -> 'subject' AS subject,
             scorecard.payload -> 'observation' -> 'ratings' AS ratings,
             scorecard.payload -> 'observation' -> 'rollup' AS rollup,
             scorecard.payload -> 'observation' -> 'synthesized' AS synthesized,
             scorecard.payload -> 'observation' -> 'gradingAudit' AS grading_audit,
             scorecard.payload -> 'observation' -> 'provisional' AS provisional,
             scorecard.payload -> 'observation' -> 'retracted' AS retracted,
             scorecard.payload -> 'observation' -> 'subjectRubricIdentity' AS subject_rubric_identity,
             -- Same supersession predicate as listScorecards: supersession is a
             -- READ-TIME relation (a later card names this one in "supersedes"),
             -- never a stamp on this card's own observation (EI-24583166035391772).
             (
               SELECT superseder.issue_id
                 FROM harness_shared.engineer_issues AS superseder
                WHERE superseder.workspace_id = scorecard.workspace_id
                  AND superseder.payload -> 'observation' ->> 'supersedes' = scorecard.issue_id
                  AND superseder.payload -> 'observation' ->> 'rubricRef' = scorecard.payload -> 'observation' ->> 'rubricRef'
                  AND superseder.payload -> 'observation' ->> 'sourceHive' IS NOT DISTINCT FROM scorecard.payload -> 'observation' ->> 'sourceHive'
                ORDER BY superseder.created_at DESC
                LIMIT 1
             ) AS superseded_by
        FROM harness_shared.engineer_issues AS scorecard
       WHERE scorecard.workspace_id = ${issuesScopeWorkspace()}
         AND scorecard.issue_id = ${issueId}
       ORDER BY scorecard.created_at DESC NULLS LAST
       LIMIT 1`),
  );
  const row = rows[0];
  if (!row) return { kind: 'not_found' };

  const observation = asStructuredObservation({
    rubricRef: row.rubric_ref,
    rubricRevision: row.rubric_revision,
    rubricMeaningRevision: row.rubric_meaning_revision,
    criteriaHash: row.criteria_hash,
    evidenceFingerprint: row.evidence_fingerprint,
    sourceHive: row.source_hive,
    subject: row.subject,
    ratings: row.ratings,
    rollup: row.rollup,
    synthesized: row.synthesized,
    gradingAudit: row.grading_audit,
    provisional: row.provisional,
    retracted: row.retracted,
    subjectRubricIdentity: row.subject_rubric_identity,
  });
  if (!observation?.rubricRef || !observation.ratings) return { kind: 'not_scorecard' };

  const rubric = await getRubric(observation.rubricRef);
  const criteriaKeys = rubric
    ? rubric.criteria.map((criterion) => criterion.key)
    : builtInCriterionKeysForRubric(observation.rubricRef);
  const rubricResolved = criteriaKeys !== null;
  const normalizedRatings = normalizeScorecardRatings(
    observation.ratings,
    rubric ? { ratingScale: rubric.ratingScale, criteria: rubric.criteria } : null,
  );
  const ratedKeys = new Set(Object.keys(normalizedRatings));
  const missingKeys = rubricResolved ? criteriaKeys!.filter((key) => !ratedKeys.has(key)) : [];
  const criterionKeySet = rubricResolved ? new Set(criteriaKeys!) : null;
  const extraKeys = criterionKeySet
    ? [...ratedKeys].filter((key) => !criterionKeySet.has(key))
    : [];
  const orderedKeys = [
    ...(criteriaKeys ?? []),
    ...Object.keys(normalizedRatings).filter((key) => !criteriaKeys?.includes(key)),
  ];
  const criteria = orderedKeys.flatMap((key) => {
    const rating = normalizedRatings[key];
    return rating ? [{ key, ...rating }] : [];
  });

  // Read-time currentness, computed exactly as listScorecards does. These are
  // RELATIONS (a later superseding card; the live subject rubric), never stamps
  // on this card, so an evidence read that only projects the observation cannot
  // answer them — the grading-audit brief requires all three (EI-24583166035391772).
  let subjectRubricCurrentness: ScorecardSubjectRubricCurrentness | null = null;
  if (observation.subject?.kind === 'rubric') {
    const subjectRef = observation.subject.ref;
    const liveSubjectRubric = subjectRef === observation.rubricRef
      ? rubric
      : await getRubric(subjectRef).catch(() => null);
    subjectRubricCurrentness = classifySubjectRubricCurrentness(
      subjectRef,
      observation.subjectRubricIdentity,
      liveSubjectRubric ?? null,
    );
  }
  const supersededBy = row.superseded_by ?? null;
  const retracted = Boolean(observation.retracted);
  const auditTarget: ScorecardAuditTargetStatus = {
    current:
      supersededBy === null &&
      !retracted &&
      (subjectRubricCurrentness === null || subjectRubricCurrentness.state === 'current'),
    superseded: supersededBy !== null,
    supersededBy,
    retracted,
    subjectRubricCurrentness,
  };

  return {
    kind: 'found',
    scorecard: {
      issueId: row.issue_id,
      createdAt: tsIso(row.created_at),
      createdBy: row.created_by,
      rubricRef: observation.rubricRef,
      ...(observation.rubricRevision != null ? { rubricRevision: observation.rubricRevision } : {}),
      ...(observation.rubricMeaningRevision != null
        ? { rubricMeaningRevision: observation.rubricMeaningRevision }
        : {}),
      ...(observation.criteriaHash ? { criteriaHash: observation.criteriaHash } : {}),
      ...(observation.evidenceFingerprint ? { evidenceFingerprint: observation.evidenceFingerprint } : {}),
      ...(observation.sourceHive ? { sourceHive: observation.sourceHive } : {}),
      ...(observation.subject ? { subject: observation.subject } : {}),
      ...(observation.rollup ? { rollup: observation.rollup } : {}),
      criteria,
      nKeys: ratedKeys.size,
      missingKeys,
      extraKeys,
      rubricResolved,
      synthesized: row.synthesized === true || row.synthesized === 'true',
      ...(observation.gradingAudit ? { gradingAudit: observation.gradingAudit } : {}),
      ...(observation.provisional ? { provisional: observation.provisional } : {}),
      ...(observation.retracted ? { retracted: observation.retracted } : {}),
      ...(subjectRubricCurrentness ? { subjectRubricCurrentness } : {}),
      ...(supersededBy ? { supersededBy } : {}),
      auditTarget,
    },
  };
}

/**
 * The settled-evidence admission policy (EI-21949865560276745) lives in the neutral
 * observation-types leaf so a reader can inherit it without importing this store.
 * Re-exported here because this module's trend is its other consumer.
 */
export { scorecardAdmissionExclusion, type ScorecardAdmissionExclusion };
export type { ScorecardGradingAuditCurrentness };

export interface ScorecardSubjectRubricCurrentness {
  state: 'current' | 'stale' | 'unknown';
  reason: 'current' | 'subject-rubric-mismatch' | 'recorded-identity-missing' | 'live-identity-missing' |
    'revision-mismatch' | 'meaning-revision-mismatch' | 'criteria-hash-mismatch';
  recordedRevision: number | null;
  currentRevision: number | null;
  recordedCriteriaHash: string | null;
  currentCriteriaHash: string | null;
}

export function classifySubjectRubricCurrentness(
  subjectRef: string,
  recorded: StructuredObservation['subjectRubricIdentity'],
  live: Pick<Rubric, 'rubricId' | 'revision' | 'criteriaHash' | 'barContract'> | null,
): ScorecardSubjectRubricCurrentness {
  const base = {
    recordedRevision: recorded?.revision ?? null,
    currentRevision: live?.revision ?? null,
    recordedCriteriaHash: recorded?.criteriaHash ?? null,
    currentCriteriaHash: live?.criteriaHash ?? null,
  };
  if (!live) return { state: 'unknown', reason: 'live-identity-missing', ...base };
  if (recorded?.rubricRef && recorded.rubricRef !== subjectRef) {
    return { state: 'unknown', reason: 'subject-rubric-mismatch', ...base };
  }
  return {
    ...classifyRubricEvidenceCurrentness(
      recorded ?? {},
      { revision: live.revision, criteriaHash: live.criteriaHash, meaningRevision: live.barContract?.meaningRevision },
    ),
    ...base,
  };
}

/** A settled audit is admissible only when its read-time identity is current. */
export function settledGradingAuditIsCurrent(row: {
  gradingAudit?: ScorecardGradingAudit;
  gradingAuditCurrentness?: ScorecardGradingAuditCurrentness;
}): boolean {
  if (!row.gradingAudit) return true;
  if (row.gradingAudit.state !== 'passed') return false;
  // Older injected/test rows do not carry the read-time projection. Production
  // scorecards:list always does; preserving the absent case keeps the helper
  // compatible with pre-P-013 readers while rejecting explicit uncertainty.
  return row.gradingAuditCurrentness?.state !== 'stale' && row.gradingAuditCurrentness?.state !== 'unknown';
}

export function classifyGradingAuditCurrentness(
  audit: ScorecardGradingAudit,
  liveMetaRubric: Pick<Rubric, 'rubricId' | 'revision' | 'criteriaHash'> | null,
): ScorecardGradingAuditCurrentness {
  const recordedRevision = audit.rubricRevision ?? null;
  const currentRevision = liveMetaRubric?.revision ?? null;
  const recordedCriteriaHash = audit.criteriaHash ?? null;
  const currentCriteriaHash = liveMetaRubric?.criteriaHash ?? null;
  const base = { recordedRevision, currentRevision, recordedCriteriaHash, currentCriteriaHash };
  if (!liveMetaRubric) return { state: 'unknown', reason: 'live-identity-missing', ...base };
  if (audit.metaRubricRef !== liveMetaRubric.rubricId) {
    return { state: 'unknown', reason: 'meta-rubric-mismatch', ...base };
  }
  return {
    ...classifyRubricEvidenceCurrentness(
      { revision: recordedRevision, criteriaHash: recordedCriteriaHash },
      { revision: currentRevision, criteriaHash: currentCriteriaHash },
    ),
    ...base,
  };
}

/** The projected {@link parseGradedGeneration} shape — see RunningGeneration
 *  (generation-watermark.ts) for what each field means. `bootHeadSha`/`scoutCodeHash`/
 *  `staleHost` are optional: a pre-WI-5397 stamp (or a row this parser degrades) never
 *  carried them, so their ABSENCE means "not recorded", never "known false/null". */
export interface GradedGeneration {
  deployedSha: string | null;
  hostStartedAt: string | null;
  bootHeadSha?: string | null;
  scoutCodeHash?: string | null;
  staleHost?: boolean;
}

/** Result of the scorecards:retract write path. */
export interface ScorecardRetractionResult {
  ok: boolean;
  issueId: string;
  retracted: boolean;
  retraction?: ScorecardRetraction;
  error?: string;
}

const GRADING_INTEGRITY_RUBRIC_REF = 'grading-integrity';

interface AtomicGradingAuditRetraction {
  retraction: ScorecardRetraction;
  subjectReset: boolean;
}

type RetractGradingAudit = (
  auditIssueId: string,
  subjectIssueId: string,
  retraction: ScorecardRetraction,
) => Promise<AtomicGradingAuditRetraction | null>;

interface AtomicScorecardRetraction {
  retraction: ScorecardRetraction;
  updated: boolean;
}

type RetractScorecardAtomically = (
  issueId: string,
  retraction: ScorecardRetraction,
) => Promise<AtomicScorecardRetraction | null>;

interface ScorecardAtomicWriteDeps {
  resolveWorkspace?: typeof resolveIssueWorkspace;
  transact?: typeof boundedOrgTxn;
}

/**
 * Retract one scorecard while holding its row lock. A pending audit is cancelled
 * in the same write so a dispatcher with an older candidate snapshot cannot
 * reserve or launch against the withdrawn card. Replays repair legacy rows that
 * already have `retracted` plus a stale pending stamp/reservation.
 */
export async function retractScorecardAtomically(
  issueId: string,
  requestedRetraction: ScorecardRetraction,
  deps: ScorecardAtomicWriteDeps = {},
): Promise<AtomicScorecardRetraction | null> {
  const workspaceId = await (deps.resolveWorkspace ?? resolveIssueWorkspace)(issueId);
  const transact = deps.transact ?? boundedOrgTxn;

  return transact(async (tx: OrgSql) => {
    const rows = await tx<{ feature_id: string; payload: unknown }[]>`
      SELECT feature_id, payload
        FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId}
         AND feature_id = ${issueId}
         AND item_kind = ANY (ARRAY['bug', 'change', 'task'])
       FOR UPDATE`;
    const row = rows[0];
    if (!row) return null;

    const payload =
      row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
        ? (row.payload as Record<string, unknown>)
        : {};
    const rawObservation = payload.observation;
    if (!rawObservation || typeof rawObservation !== 'object' || Array.isArray(rawObservation)) return null;
    const raw = rawObservation as Record<string, unknown>;
    const hasRubricRef = typeof raw.rubricRef === 'string' && raw.rubricRef.trim().length > 0;
    const hasRatingsRecord = raw.ratings !== null && typeof raw.ratings === 'object' && !Array.isArray(raw.ratings);
    if (!hasRubricRef || !hasRatingsRecord) return null;

    const parsed = asStructuredObservation(rawObservation);
    const priorRetraction = parsed?.retracted;
    const gradingAudit = raw.gradingAudit;
    const auditRecord =
      gradingAudit && typeof gradingAudit === 'object' && !Array.isArray(gradingAudit)
        ? (gradingAudit as Record<string, unknown>)
        : null;
    const cancelPendingAudit = auditRecord?.state === 'pending';
    if (priorRetraction && !cancelPendingAudit) {
      return { retraction: priorRetraction, updated: false };
    }

    const retraction = priorRetraction ?? requestedRetraction;
    const nextObservation: Record<string, unknown> = { ...raw, retracted: retraction };
    if (cancelPendingAudit && auditRecord) {
      const cancelledAudit: Record<string, unknown> = { ...auditRecord, state: 'cancelled' };
      delete cancelledAudit.dispatchReservation;
      delete cancelledAudit.dispatchBackoff;
      nextObservation.gradingAudit = cancelledAudit;
    }

    const updated = await tx<{ feature_id: string }[]>`
      UPDATE harness_shared.work_items
         SET payload = jsonb_set(
               COALESCE(payload, '{}'::jsonb),
               '{observation}',
               ${JSON.stringify(nextObservation)}::jsonb,
               true
             ),
             origin = 'local',
             updated_ts = ${Date.now()}
       WHERE workspace_id = ${workspaceId}
         AND feature_id = ${issueId}
         AND item_kind = ANY (ARRAY['bug', 'change', 'task'])
      RETURNING feature_id`;
    if (!updated[0]) return null;
    return { retraction, updated: true };
  });
}

/** Return the subject observation with a withdrawn audit's settlement cleared. */
export function resetGradingAuditStampForRetraction(
  rawSubjectObservation: unknown,
  auditIssueId: string,
  auditIdentity?: { rubricRevision?: number; criteriaHash?: string },
): Record<string, unknown> | null {
  const subjectObservation = asStructuredObservation(rawSubjectObservation);
  const gradingAudit = subjectObservation?.gradingAudit;
  const auditRubricRevision =
    Number.isInteger(auditIdentity?.rubricRevision) && (auditIdentity?.rubricRevision ?? 0) > 0
      ? auditIdentity?.rubricRevision
      : undefined;
  const auditCriteriaHash =
    typeof auditIdentity?.criteriaHash === 'string' && auditIdentity.criteriaHash.trim()
      ? auditIdentity.criteriaHash.trim()
      : undefined;
  const completeAuditIdentity = auditRubricRevision != null && Boolean(auditCriteriaHash);
  const citesRetractedAudit = gradingAudit?.auditIssueId === auditIssueId;
  // A pre-identity reset already cleared auditIssueId before this repair shipped.
  // Permit an idempotent replay to fill that single legacy shape, but never
  // replace an active reservation, a partial/complete identity, or settlement
  // metadata that could belong to a newer audit.
  const isLegacyIdentityRepair = Boolean(
    completeAuditIdentity &&
    gradingAudit?.state === 'pending' &&
    gradingAudit.metaRubricRef === GRADING_INTEGRITY_RUBRIC_REF &&
    gradingAudit.auditIssueId == null &&
    gradingAudit.auditor == null &&
    gradingAudit.auditedAt == null &&
    gradingAudit.dispatchReservation == null &&
    gradingAudit.rubricRevision == null &&
    gradingAudit.criteriaHash == null,
  );
  if (!citesRetractedAudit && !isLegacyIdentityRepair) return null;
  if (!rawSubjectObservation || typeof rawSubjectObservation !== 'object' || Array.isArray(rawSubjectObservation)) {
    return null;
  }
  const rawSubject = rawSubjectObservation as Record<string, unknown>;
  const rawGradingAudit = rawSubject.gradingAudit;
  if (!rawGradingAudit || typeof rawGradingAudit !== 'object' || Array.isArray(rawGradingAudit)) return null;
  const pendingGradingAudit: Record<string, unknown> = {
    ...(rawGradingAudit as Record<string, unknown>),
    state: 'pending',
  };
  // The retracted audit row is the authority for the meta-rubric identity it
  // used. Carry the pair onto the reopened subject atomically so a replacement
  // audit can settle against a complete current identity. Never synthesize or
  // mix a partial pair; historical identity-less audits remain identity-less.
  if (completeAuditIdentity) {
    pendingGradingAudit.rubricRevision = auditRubricRevision;
    pendingGradingAudit.criteriaHash = auditCriteriaHash;
  }
  // A retracted audit re-opens the subject for dispatch. Do not carry the old
  // launch reservation across that boundary or the repaired subject would stay
  // blocked until the reservation TTL elapsed.
  delete pendingGradingAudit.dispatchReservation;
  delete pendingGradingAudit.auditIssueId;
  delete pendingGradingAudit.auditor;
  delete pendingGradingAudit.auditedAt;
  return { ...rawSubject, gradingAudit: pendingGradingAudit };
}

/**
 * Retract a grading-integrity audit and repair the stamp it settled in one
 * transaction. The subject UPDATE is a compare-and-set on auditIssueId: a
 * later correction wins the race and must never be returned to pending by an
 * older audit's retraction.
 */
async function retractGradingAuditAtomically(
  auditIssueId: string,
  subjectIssueId: string,
  requestedRetraction: ScorecardRetraction,
): Promise<AtomicGradingAuditRetraction | null> {
  const workspaceId = await resolveIssueWorkspace(auditIssueId);
  const refs = [...new Set([auditIssueId, subjectIssueId])].sort();

  return boundedOrgTxn(async (tx: OrgSql) => {
    const rows = await tx<{ feature_id: string; payload: unknown }[]>`
      SELECT feature_id, payload
        FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId}
         AND feature_id = ANY(${refs}::text[])
         AND item_kind = ANY (ARRAY['bug', 'change', 'task'])
       ORDER BY feature_id
       FOR UPDATE`;
    const auditRow = rows.find((row) => row.feature_id === auditIssueId);
    if (!auditRow) return null;

    const auditPayload =
      auditRow.payload && typeof auditRow.payload === 'object' && !Array.isArray(auditRow.payload)
        ? (auditRow.payload as Record<string, unknown>)
        : {};
    const rawAuditObservation = auditPayload.observation;
    if (!rawAuditObservation || typeof rawAuditObservation !== 'object' || Array.isArray(rawAuditObservation)) {
      return null;
    }
    const auditObservation = asStructuredObservation(rawAuditObservation);
    if (
      auditObservation?.rubricRef !== GRADING_INTEGRITY_RUBRIC_REF ||
      auditObservation.subject?.kind !== 'scorecard' ||
      auditObservation.subject.ref !== subjectIssueId
    ) {
      return null;
    }

    const retraction = auditObservation.retracted ?? requestedRetraction;
    if (!auditObservation.retracted) {
      const updated = await tx<{ feature_id: string }[]>`
        UPDATE harness_shared.work_items
           SET payload = jsonb_set(
                 COALESCE(payload, '{}'::jsonb),
                 '{observation}',
                 ${JSON.stringify({ ...(rawAuditObservation as Record<string, unknown>), retracted: retraction })}::jsonb,
                 true
               ),
               origin = 'local',
               updated_ts = ${Date.now()}
         WHERE workspace_id = ${workspaceId}
           AND feature_id = ${auditIssueId}
           AND item_kind = ANY (ARRAY['bug', 'change', 'task'])
        RETURNING feature_id`;
      if (!updated[0]) return null;
    }

    const subjectRow = rows.find((row) => row.feature_id === subjectIssueId);
    const subjectPayload =
      subjectRow?.payload && typeof subjectRow.payload === 'object' && !Array.isArray(subjectRow.payload)
        ? (subjectRow.payload as Record<string, unknown>)
        : {};
    const rawSubjectObservation = subjectPayload.observation;
    const resetSubjectObservation = resetGradingAuditStampForRetraction(rawSubjectObservation, auditIssueId, {
      rubricRevision: auditObservation.rubricRevision,
      criteriaHash: auditObservation.criteriaHash,
    });
    let subjectReset = false;
    if (resetSubjectObservation) {
      const updated = await tx<{ feature_id: string }[]>`
        UPDATE harness_shared.work_items
           SET payload = jsonb_set(
                 COALESCE(payload, '{}'::jsonb),
                 '{observation}',
                 ${JSON.stringify(resetSubjectObservation)}::jsonb,
                 true
               ),
               origin = 'local',
               updated_ts = ${Date.now()}
         WHERE workspace_id = ${workspaceId}
           AND feature_id = ${subjectIssueId}
           AND item_kind = ANY (ARRAY['bug', 'change', 'task'])
           AND (
             payload->'observation'->'gradingAudit'->>'auditIssueId' = ${auditIssueId}
             OR (
               payload->'observation'->'gradingAudit'->>'state' = 'pending'
               AND payload->'observation'->'gradingAudit'->>'metaRubricRef' = ${GRADING_INTEGRITY_RUBRIC_REF}
               AND payload->'observation'->'gradingAudit'->>'auditIssueId' IS NULL
               AND payload->'observation'->'gradingAudit'->>'auditor' IS NULL
               AND payload->'observation'->'gradingAudit'->>'auditedAt' IS NULL
               AND payload->'observation'->'gradingAudit'->'dispatchReservation' IS NULL
               AND payload->'observation'->'gradingAudit'->>'rubricRevision' IS NULL
               AND payload->'observation'->'gradingAudit'->>'criteriaHash' IS NULL
             )
           )
        RETURNING feature_id`;
      subjectReset = updated.length > 0;
    }

    return { retraction, subjectReset };
  });
}

/**
 * Retract one scorecard without deleting or flattening its evidence payload.
 * The row-locked writer preserves the latest nested observation and cancels a
 * pending audit lease. This deliberately accepts incomplete historical cards:
 * retraction is the cleanup path for malformed cards predating the emit gate.
 */
export async function retractScorecard(
  issueId: string,
  input: { by: string; reason: string; at?: string },
  deps: {
    getIssue?: typeof getIssue;
    retractGradingAudit?: RetractGradingAudit;
    retractScorecardAtomically?: RetractScorecardAtomically;
  } = {},
): Promise<ScorecardRetractionResult> {
  const issue = await (deps.getIssue ?? getIssue)(issueId);
  if (!issue) return { ok: false, issueId, retracted: false, error: `scorecard '${issueId}' not found` };

  const payload =
    issue.payload && typeof issue.payload === 'object' && !Array.isArray(issue.payload)
      ? (issue.payload as Record<string, unknown>)
      : {};
  const rawObservation = payload.observation;
  if (!rawObservation || typeof rawObservation !== 'object' || Array.isArray(rawObservation)) {
    return { ok: false, issueId, retracted: false, error: `'${issueId}' is not a scorecard` };
  }
  const raw = rawObservation as Record<string, unknown>;
  const hasRubricRef = typeof raw.rubricRef === 'string' && raw.rubricRef.trim().length > 0;
  const hasRatingsRecord = raw.ratings !== null && typeof raw.ratings === 'object' && !Array.isArray(raw.ratings);
  if (!hasRubricRef || !hasRatingsRecord) {
    return { ok: false, issueId, retracted: false, error: `'${issueId}' is not a complete scorecard` };
  }
  const observation = asStructuredObservation(rawObservation);
  const retraction =
    observation?.retracted ??
    ({
      at: input.at ?? new Date().toISOString(),
      by: input.by,
      reason: input.reason.trim(),
    } satisfies ScorecardRetraction);
  const gradingAuditSubjectId =
    observation?.rubricRef === GRADING_INTEGRITY_RUBRIC_REF &&
    observation.subject?.kind === 'scorecard'
      ? observation.subject.ref
      : undefined;
  if (gradingAuditSubjectId) {
    const repaired = await (deps.retractGradingAudit ?? retractGradingAuditAtomically)(
      issueId,
      gradingAuditSubjectId,
      retraction,
    );
    if (!repaired) {
      return { ok: false, issueId, retracted: false, error: `failed to retract grading audit '${issueId}'` };
    }
    void trackDetached(import('./sync-sse'))
      .then((m) => {
        m.notifySyncInvalidate('scorecards.list');
        m.notifySyncInvalidate('rubrics.trend');
        m.notifySyncInvalidate('learning.releaseReadiness');
      })
      .catch(() => {});
    return { ok: true, issueId, retracted: true, retraction: repaired.retraction };
  }
  const updated = await (deps.retractScorecardAtomically ?? retractScorecardAtomically)(issueId, retraction);
  if (!updated) {
    return { ok: false, issueId, retracted: false, error: `failed to retract scorecard '${issueId}'` };
  }

  if (updated.updated) {
    void trackDetached(import('./sync-sse'))
      .then((m) => {
        m.notifySyncInvalidate('scorecards.list');
        m.notifySyncInvalidate('rubrics.trend');
        m.notifySyncInvalidate('learning.releaseReadiness');
      })
      .catch(() => {});
  }
  return { ok: true, issueId, retracted: true, retraction: updated.retraction };
}

/** P-013: the shared rating→verdict vocabulary, exported so the grading-audit
 *  verdict and the instrument contract cannot drift. */
export function ratingVerdict(rating: string): 'pass' | 'fail' | 'unknown' | null {
  return expectedInstrumentVerdict(rating);
}

/** P-013: failures dominate, but a pass requires every nonempty rating to be
 * explicitly pass-like. Unknown/custom ratings cannot settle the source card. */
export function auditVerdictFromRatings(
  ratings: Record<string, { rating: string }>,
): 'passed' | 'failed' | null {
  const entries = Object.values(ratings);
  if (entries.length === 0) return null;
  let unresolved = false;
  for (const entry of entries) {
    const verdict = expectedInstrumentVerdict(entry.rating);
    if (verdict === 'fail') return 'failed';
    if (verdict !== 'pass') unresolved = true;
  }
  return unresolved ? null : 'passed';
}

export interface GradingAuditRecordResult {
  ok: boolean;
  issueId: string;
  error?: string;
  gradingAudit?: ScorecardGradingAudit;
}

type ReplaceSettledGradingAudit = (
  issueId: string,
  expectedAuditIssueId: string,
  gradingAudit: ScorecardGradingAudit,
) => Promise<boolean>;

/**
 * Replace one SETTLED grading-audit stamp only while it still names the audit
 * the caller explicitly superseded. The compare-and-set lives in the UPDATE,
 * not in the preceding application read: a concurrent correction therefore
 * wins instead of being overwritten by whichever emit finishes last.
 */
async function replaceSettledGradingAuditAtomically(
  issueId: string,
  expectedAuditIssueId: string,
  gradingAudit: ScorecardGradingAudit,
): Promise<boolean> {
  const workspaceId = await resolveIssueWorkspace(issueId);
  const rows = await boundedOrgTxn(
    (tx: OrgSql) => tx<{ feature_id: string }[]>`
    UPDATE harness_shared.work_items AS target
       SET payload = jsonb_set(
             COALESCE(payload, '{}'::jsonb),
             '{observation,gradingAudit}',
             ${JSON.stringify(gradingAudit)}::jsonb,
             true
           ),
           origin = 'local',
           updated_ts = ${Date.now()}
     WHERE workspace_id = ${workspaceId}
       AND feature_id = ${issueId}
       AND item_kind = ANY (ARRAY['bug', 'change', 'task'])
       AND payload->'observation'->'retracted' IS NULL
       AND target.ctid = (
         SELECT candidate.ctid
           FROM harness_shared.work_items AS candidate
          WHERE candidate.workspace_id = ${workspaceId}
            AND candidate.feature_id = ${issueId}
            AND candidate.item_kind = ANY (ARRAY['bug', 'change', 'task'])
          ORDER BY candidate.updated_ts DESC NULLS LAST
          LIMIT 1
       )
       AND payload->'observation'->'gradingAudit'->>'state' IN ('passed', 'failed')
       AND payload->'observation'->'gradingAudit'->>'auditIssueId' = ${expectedAuditIssueId}
    RETURNING feature_id`,
  );
  return rows.length > 0;
}

interface ActiveSourceAuditConsultRow {
  answering_owner_id: string | null;
}

async function readActiveSourceAuditConsultResponder(
  tx: OrgSql,
  workspaceId: string,
  issueId: string,
  reservation: { key: string; reservedAt: string },
): Promise<ActiveSourceAuditConsultRow | null> {
  const rows = await tx<ActiveSourceAuditConsultRow[]>`
    SELECT routing #>> ARRAY[
             'selection',
             'selected',
             cascade_cursor::text,
             'answeringOwnerId'
           ] AS answering_owner_id
      FROM harness_shared.consult_state
     WHERE workspace_id = ${workspaceId}
       AND routing->'cascade'->>'flavor' = 'grading-integrity'
       AND routing->'cascade'->>'issueId' = ${issueId}
       AND routing->'cascade'->>'reservationKey' = ${reservation.key}
       AND routing->'cascade'->>'reservationReservedAt' = ${reservation.reservedAt}
       AND state IN ('awaiting_responder', 'active')
       AND closed_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1
     FOR UPDATE`;
  return rows[0] ?? null;
}

/**
 * Every candidate in a grading-audit consult receives the same reservation
 * epoch. Bind a routed emission to the answerer on the current cascade cursor
 * so an earlier fork cannot settle with the next candidate's still-live lease.
 * Direct launch fallbacks have no active consult row and use the launcher's
 * existing single-task idempotency guard.
 */
export async function isCurrentSourceAuditResponder(
  issueId: string,
  reservation: { key: string; reservedAt: string },
  auditor: string,
  deps: ScorecardAtomicWriteDeps = {},
): Promise<boolean> {
  const workspaceId = await (deps.resolveWorkspace ?? resolveIssueWorkspace)(issueId);
  const transact = deps.transact ?? boundedOrgTxn;
  return transact(async (tx) => {
    const current = await readActiveSourceAuditConsultResponder(tx, workspaceId, issueId, reservation);
    return !current || current.answering_owner_id === auditor;
  });
}

/** Settle only the exact pending stamp read by the caller, unless retraction has won. */
export async function settlePendingGradingAuditAtomically(
  issueId: string,
  expected: ScorecardGradingAudit,
  settled: ScorecardGradingAudit,
  deps: ScorecardAtomicWriteDeps = {},
): Promise<boolean> {
  const workspaceId = await (deps.resolveWorkspace ?? resolveIssueWorkspace)(issueId);
  const transact = deps.transact ?? boundedOrgTxn;
  const rows = await transact(async (tx: OrgSql) => {
    if (expected.dispatchReservation) {
      const current = await readActiveSourceAuditConsultResponder(
        tx,
        workspaceId,
        issueId,
        expected.dispatchReservation,
      );
      if (current && current.answering_owner_id !== settled.auditor) return [];
    }
    return tx<{ feature_id: string }[]>`
      UPDATE harness_shared.work_items
         SET payload = jsonb_set(
               COALESCE(payload, '{}'::jsonb),
               '{observation,gradingAudit}',
               ${JSON.stringify(settled)}::jsonb,
               true
             ),
             origin = 'local',
             updated_ts = ${Date.now()}
       WHERE workspace_id = ${workspaceId}
         AND feature_id = ${issueId}
         AND item_kind = ANY (ARRAY['bug', 'change', 'task'])
         AND payload->'observation'->'retracted' IS NULL
         AND payload->'observation'->'gradingAudit'->>'state' = 'pending'
         AND payload->'observation'->'gradingAudit'->>'metaRubricRef' = ${expected.metaRubricRef}
         AND payload->'observation'->'gradingAudit'->>'stampedAt' = ${expected.stampedAt}
         AND payload->'observation'->'gradingAudit'->>'rubricRevision' IS NOT DISTINCT FROM ${expected.rubricRevision == null ? null : String(expected.rubricRevision)}
         AND payload->'observation'->'gradingAudit'->>'criteriaHash' IS NOT DISTINCT FROM ${expected.criteriaHash ?? null}
         AND payload->'observation'->'gradingAudit'->'dispatchReservation'->>'key' IS NOT DISTINCT FROM ${expected.dispatchReservation?.key ?? null}
         AND payload->'observation'->'gradingAudit'->'dispatchReservation'->>'reservedAt' IS NOT DISTINCT FROM ${expected.dispatchReservation?.reservedAt ?? null}
       RETURNING feature_id`;
  });
  return rows.length > 0;
}

/**
 * Stop dispatching an audit whose exact evaluator replay proved the source card
 * must be re-emitted. This compare-and-set uses the exact pending lease, so a
 * refusal from an old auditor cannot block a newer reservation or settlement.
 */
export async function markGradingAuditAwaitingReemit(
  issueId: string,
  expected: ScorecardGradingAudit,
  input: { reason: string; at?: string },
  deps: ScorecardAtomicWriteDeps & {
    notifySyncInvalidate?: (key: 'scorecards.list' | 'rubrics.trend') => void;
  } = {},
): Promise<boolean> {
  if (expected.state !== 'pending') return false;
  const awaitingReemit: ScorecardGradingAudit = {
    ...expected,
    state: 'awaiting-reemit',
    reemitRequired: {
      code: 'grading_audit_evaluator_changed',
      at: input.at ?? new Date().toISOString(),
      reason: input.reason.trim().slice(0, 1000) || 'The source card must be re-emitted under the current evaluator.',
    },
  };
  delete awaitingReemit.dispatchReservation;
  const updated = await settlePendingGradingAuditAtomically(issueId, expected, awaitingReemit, deps);
  if (!updated) return false;
  if (deps.notifySyncInvalidate) {
    deps.notifySyncInvalidate('scorecards.list');
    deps.notifySyncInvalidate('rubrics.trend');
  } else {
    void trackDetached(import('./sync-sse'))
      .then((m) => {
        m.notifySyncInvalidate('scorecards.list');
        m.notifySyncInvalidate('rubrics.trend');
      })
      .catch(() => {});
  }
  return true;
}

/**
 * P-013: settle a graded card's audit-pending stamp after its audit scorecard filed.
 * The pending path is a compare-and-set write against the exact stamp read above;
 * it cannot restore a stale observation over a concurrent retraction. Idempotent
 * replays of the same audit card return the existing stamp as-is.
 * A validated correction that supersedes a settled audit card carries a different
 * auditIssueId and must replace the target stamp too; the replacement is a database
 * compare-and-set on the superseded audit id so two corrections cannot overwrite one
 * another. A legacy identity-less stamp may be upgraded only through that explicit
 * supersession edge; otherwise a retracted false audit leaves the target permanently
 * failed or a late writer can regress a newer verdict.
 */
export async function recordGradingAudit(
  issueId: string,
  input: {
    auditIssueId: string;
    auditor: string;
    verdict: 'passed' | 'failed';
    at?: string;
    rubricRevision?: number;
    criteriaHash?: string;
    requireCurrentIdentity?: boolean;
    supersedesAuditIssueId?: string;
    dispatchReservation?: { key: string; reservedAt: string };
  },
  deps: {
    getIssue?: typeof getIssue;
    replaceSettledGradingAudit?: ReplaceSettledGradingAudit;
    notifySyncInvalidate?: (key: 'scorecards.list' | 'rubrics.trend' | 'learning.releaseReadiness') => void;
  } = {},
): Promise<GradingAuditRecordResult> {
  const issue = await (deps.getIssue ?? getIssue)(issueId);
  if (!issue) return { ok: false, issueId, error: `scorecard '${issueId}' not found` };
  const payload =
    issue.payload && typeof issue.payload === 'object' && !Array.isArray(issue.payload)
      ? (issue.payload as Record<string, unknown>)
      : {};
  const rawObservation = payload.observation;
  const observation = asStructuredObservation(rawObservation);
  if (!observation?.rubricRef || !observation.ratings) {
    return { ok: false, issueId, error: `'${issueId}' is not a scorecard` };
  }
  if (observation.retracted) {
    return { ok: false, issueId, error: `'${issueId}' is retracted and cannot receive a grading-audit settlement` };
  }
  const existing = observation.gradingAudit;
  if (!existing) {
    return { ok: false, issueId, error: `'${issueId}' carries no gradingAudit stamp to settle` };
  }
  const incomingIdentitySupplied = input.rubricRevision != null || input.criteriaHash != null;
  const incomingIdentityComplete = input.rubricRevision != null && Boolean(input.criteriaHash);
  if (input.requireCurrentIdentity && !incomingIdentityComplete) {
    return {
      ok: false,
      issueId,
      error: `'${issueId}' cannot be settled without the grading-integrity rubric revision and criteria hash`,
    };
  }
  if (existing.state !== 'pending' && existing.auditIssueId === input.auditIssueId) {
    return { ok: true, issueId, gradingAudit: existing };
  }
  const explicitSettledSupersession =
    existing.state !== 'pending' &&
    input.supersedesAuditIssueId != null &&
    existing.auditIssueId === input.supersedesAuditIssueId &&
    input.auditIssueId !== input.supersedesAuditIssueId;
  if (existing.state !== 'pending' && !explicitSettledSupersession) {
    return {
      ok: false,
      issueId,
      error:
        `'${issueId}' is already audited (${existing.state}) by '${existing.auditIssueId ?? 'unknown'}'; ` +
        'a replacement must explicitly supersede that audit card',
    };
  }
  if (existing.state === 'pending') {
    const activeReservation = existing.dispatchReservation;
    const suppliedReservation = input.dispatchReservation;
    const reservationMatches = activeReservation
      ? suppliedReservation?.key === activeReservation.key &&
        suppliedReservation.reservedAt === activeReservation.reservedAt
      : suppliedReservation == null;
    if (!reservationMatches) {
      return {
        ok: false,
        issueId,
        error: `'${issueId}' grading-audit dispatch reservation no longer matches this auditor's lease`,
      };
    }
  }
  const recordedIdentityComplete = existing.rubricRevision != null && Boolean(existing.criteriaHash);
  const recordedIdentityAbsent = existing.rubricRevision == null && !existing.criteriaHash;
  const upgradesLegacySettledIdentity = explicitSettledSupersession && recordedIdentityAbsent;
  if (
    !upgradesLegacySettledIdentity &&
    incomingIdentitySupplied &&
    (input.requireCurrentIdentity || existing.state !== 'pending' || recordedIdentityComplete)
  ) {
    const currentness = classifyGradingAuditCurrentness(existing, {
      rubricId: existing.metaRubricRef,
      revision: input.rubricRevision,
      criteriaHash: input.criteriaHash,
    });
    if (currentness.state !== 'current') {
      return {
        ok: false,
        issueId,
        error:
          `'${issueId}' carries a ${currentness.state} gradingAudit stamp (${currentness.reason}); ` +
          're-open it through the pending-audit dispatcher before settling a new audit',
      };
    }
  }
  const settled: ScorecardGradingAudit = {
    ...existing,
    state: input.verdict,
    ...(input.rubricRevision != null ? { rubricRevision: input.rubricRevision } : {}),
    ...(input.criteriaHash ? { criteriaHash: input.criteriaHash } : {}),
    auditIssueId: input.auditIssueId,
    auditor: input.auditor,
    auditedAt: input.at ?? new Date().toISOString(),
  };
  delete settled.dispatchReservation;
  const updated = explicitSettledSupersession
    ? await (deps.replaceSettledGradingAudit ?? replaceSettledGradingAuditAtomically)(
        issueId,
        input.supersedesAuditIssueId!,
        settled,
      )
    : await settlePendingGradingAuditAtomically(issueId, existing, settled);
  if (!updated) {
    return { ok: false, issueId, error: `failed to record grading audit on '${issueId}'` };
  }
  if (deps.notifySyncInvalidate) {
    deps.notifySyncInvalidate('scorecards.list');
    deps.notifySyncInvalidate('rubrics.trend');
    deps.notifySyncInvalidate('learning.releaseReadiness');
  } else {
    void trackDetached(import('./sync-sse'))
      .then((m) => {
        m.notifySyncInvalidate('scorecards.list');
        m.notifySyncInvalidate('rubrics.trend');
        m.notifySyncInvalidate('learning.releaseReadiness');
      })
      .catch(() => {});
  }
  return { ok: true, issueId, gradingAudit: settled };
}

/**
 * PURE: validate a raw payload `gradedGeneration` into the projected shape.
 * Backward-compatible with pre-WI-5397 rows, which carried `{ sha, hostStartedAt }`
 * only — `sha` is read as `deployedSha` when the new key is absent (a read-time
 * projection of history, not a write-time shim: every NEW stamp writes
 * `deployedSha` directly). Anything unparseable (malformed / absent / pre-stamp
 * rows) is null so a bad row degrades, never throws.
 */
export function parseGradedGeneration(raw: unknown): GradedGeneration | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const deployedShaRaw = 'deployedSha' in o ? o.deployedSha : o.sha;
  const deployedSha = typeof deployedShaRaw === 'string' && deployedShaRaw ? deployedShaRaw : null;
  const hostStartedAt = typeof o.hostStartedAt === 'string' && o.hostStartedAt ? o.hostStartedAt : null;
  const bootHeadSha = typeof o.bootHeadSha === 'string' && o.bootHeadSha ? o.bootHeadSha : null;
  const scoutCodeHash = typeof o.scoutCodeHash === 'string' && o.scoutCodeHash ? o.scoutCodeHash : null;
  const staleHost = typeof o.staleHost === 'boolean' ? o.staleHost : undefined;
  // An all-null/absent stamp carries no identity at all.
  if (deployedSha === null && hostStartedAt === null && bootHeadSha === null && scoutCodeHash === null) return null;
  return {
    deployedSha,
    hostStartedAt,
    ...(bootHeadSha !== null ? { bootHeadSha } : {}),
    ...(scoutCodeHash !== null ? { scoutCodeHash } : {}),
    ...(staleHost !== undefined ? { staleHost } : {}),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Numeric projection (P-004 / D-001) — capture stays categorical; 0–10 is a
// READ-TIME projection so history is "backfilled" for free and the categorical
// evidence trail stays the source of truth.
// ───────────────────────────────────────────────────────────────────────────

/**
 * The default rating→score map, covering the shared rating vocabularies
 * (pass/partial/fail and healthy/degraded/broken plus common synonyms).
 * `unknown` and any unmapped custom rating project to null (EXCLUDED from
 * means — an unassessed criterion must never drag a score toward 0).
 * A rubric wanting different weights passes `overrides` (per-rubric map).
 */
export const DEFAULT_RATING_SCORE10: Record<string, number> = {
  exemplary: 10,
  exceptional: 10,
  pass: 10,
  healthy: 10,
  good: 10,
  yes: 10,
  green: 10,
  partial: 5,
  degraded: 5,
  mixed: 5,
  warn: 5,
  fail: 0,
  broken: 0,
  bad: 0,
  no: 0,
  red: 0,
  severe: 0,
};

/** Project one categorical rating to 0–10 (null = unmapped/excluded). */
export function ratingScore10(rating: string, overrides?: Record<string, number>): number | null {
  const key = rating.toLowerCase();
  const v = overrides?.[key] ?? DEFAULT_RATING_SCORE10[key];
  return v === undefined ? null : v;
}

/**
 * The extended-scale re-map: a rubric whose ratingScale carries the EXTENDED
 * vocabulary (exemplary above pass / severe below fail) spreads its five levels
 * monotonically — exemplary 10 / pass 8 / partial 5 / fail 2 / severe 0.
 * A plain pass/partial/fail rubric keeps pass=10/fail=0: pass IS its ceiling,
 * so its historical projections never shift when OTHER rubrics adopt the
 * extended scale.
 */
export const EXTENDED_SCALE_OVERRIDES: Record<string, number> = { pass: 8, fail: 2 };

/**
 * Derive the per-rubric score overrides from the rubric's own ratingScale
 * (scale-aware read-time projection): extended vocabulary present → the
 * {@link EXTENDED_SCALE_OVERRIDES} re-map; otherwise undefined (default map fits).
 */
export function scoreOverridesForScale(
  ratingScale: readonly string[] | null | undefined,
): Record<string, number> | undefined {
  if (!ratingScale?.length) return undefined;
  const s = ratingScale.map((r) => r.toLowerCase());
  return s.includes('exemplary') || s.includes('severe') ? EXTENDED_SCALE_OVERRIDES : undefined;
}

/**
 * A whole scorecard's 0–10 score: the mean of its mappable criterion ratings,
 * rounded to 1 decimal. Null when no rating maps (e.g. an all-unknown idle
 * scorecard — "no signal", not "0/10").
 */
export function scorecardScore10(
  ratings: Record<string, { rating: string }>,
  overrides?: Record<string, number>,
): number | null {
  const nums = Object.values(ratings)
    .map((r) => ratingScore10(r.rating, overrides))
    .filter((n): n is number => n !== null);
  if (nums.length === 0) return null;
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10;
}

/**
 * TRUE, unbounded per-rubric scorecard counts (WI-5415 owner surprise-check: "do we
 * really have 17 rubrics ratified but never scored?"). A raw grouped `COUNT(*)` over
 * every organic, non-synthesized scorecard row — independent of ANY read-side row cap.
 *
 * WHY this exists as its own query rather than reusing `listScorecards`: the
 * `rubrics.list` sync-resolver used to roll up ONE globally-capped
 * `listScorecards({ limit: 500 })` read shared across EVERY rubric combined. A
 * high-volume rubric graded every turn (hive-coordination-health: 968 real scorecards)
 * fills that shared 500-row window entirely on its own, crowding a low/no-volume rubric
 * (fleet-execution-health: 11 real scorecards) completely OUT of it — so the panel
 * showed `scorecardCount: 0` for BOTH the high-volume rubric (once its most recent grade
 * aged past the window) and the crowded-out one, misreading real grading history as
 * "never scored". Live audit (papercusp-workspace, 2026-07-19): of the 23 active
 * rubrics, this bug alone zeroed out at least 2 (hive-coordination-health,
 * fleet-execution-health) that carry hundreds of real scorecards between them.
 *
 * The fix: the resolver reads PER RUBRIC for the latest/avg projection (mirrors
 * rubrics:trend's own per-rubric window) + this unbounded count for the true total —
 * so no rubric's count depends on how many OTHER rubrics were graded recently.
 */
export interface ScorecardCountFilter {
  /** Restrict the grouped aggregate to one rubric while preserving the map shape. */
  rubricRef?: string;
  /** Preserve the historic aggregate population by default. */
  includeSuperseded?: boolean;
  /** Preserve the historic aggregate population by default. */
  includeRetracted?: boolean;
}

export async function scorecardTotalCountsByRubric(filter: ScorecardCountFilter = {}): Promise<Record<string, number>> {
  const { sql } = getOrgPg();
  const rows = await sql<{ rubric_ref: string; n: string }[]>`
    SELECT scorecard.payload -> 'observation' ->> 'rubricRef' AS rubric_ref,
           count(*) AS n
      FROM harness_shared.engineer_issues AS scorecard
     WHERE scorecard.workspace_id = ${issuesScopeWorkspace()}
       AND COALESCE(scorecard.signal_origin, 'organic') = 'organic'
       AND scorecard.payload -> 'observation' ->> 'rubricRef' IS NOT NULL
       AND scorecard.payload -> 'observation' ->> 'synthesized' IS DISTINCT FROM 'true'
       AND ${
         filter.rubricRef ? sql`scorecard.payload -> 'observation' ->> 'rubricRef' = ${filter.rubricRef}` : sql`TRUE`
       }
       AND ${
         filter.includeSuperseded === false
           ? sql`NOT EXISTS (
         SELECT 1
           FROM harness_shared.engineer_issues AS superseder
          WHERE superseder.workspace_id = scorecard.workspace_id
            AND superseder.payload -> 'observation' ->> 'supersedes' = scorecard.issue_id
            AND superseder.payload -> 'observation' ->> 'rubricRef' = scorecard.payload -> 'observation' ->> 'rubricRef'
            AND superseder.payload -> 'observation' ->> 'sourceHive' IS NOT DISTINCT FROM scorecard.payload -> 'observation' ->> 'sourceHive'
       )`
           : sql`TRUE`
       }
       AND ${
         filter.includeRetracted === false ? sql`scorecard.payload -> 'observation' -> 'retracted' IS NULL` : sql`TRUE`
       }
     GROUP BY 1`;
  return Object.fromEntries(rows.map((r) => [r.rubric_ref, Number(r.n)]));
}

export interface ScorecardListCursor {
  createdAt: string;
  issueId: string;
}

export interface ListScorecardsFilter {
  /** Restrict to one rubric (e.g. 'pot-coordination-health'). */
  rubricRef?: string;
  /** Restrict to scorecards from one source-hive. */
  sourceHive?: string;
  /**
   * Restrict to scorecards grading ONE subject — `payload.observation.subject.ref`
   * (goal-mode-rubric-v2-2026-08-10 P-009). The per-RUN axis: `sourceHive` answers
   * which POT, this answers which RUN/agent/item. Without it a per-run rubric's
   * scorecards can only be listed in bulk and told apart by reading prose.
   */
  subjectRef?: string;
  /** Select exact scorecard issue IDs before applying the newest-first limit. */
  issueIds?: readonly string[];
  /** Only scorecards filed at/after this ISO timestamp (the time-window). */
  since?: string;
  /**
   * Stable newest-first keyset boundary. The row at this exact
   * `(created_at, issue_id)` position is excluded from the next page.
   */
  before?: ScorecardListCursor;
  /** Max rows (newest-first). Default 100, max 500. */
  limit?: number;
  /**
   * Include SYNTHESIZED floor scorecards (`payload.observation.synthesized`). Default
   * FALSE — every monitoring consumer (the agent-emission freshness detector, the trend,
   * the staleness signal, Scout's digest) reads AGENT scorecards only, so the deterministic
   * floor (overwatch/scorecard-backstop) never masks an agent skip nor pollutes the trend.
   * Set true only for an explicit "did the monitor speak at all (incl. the floor)" read.
   */
  includeSynthesized?: boolean;
  /** Include scorecards that a later payload `supersedes` filing replaced. */
  includeSuperseded?: boolean;
  /** Include scorecards carrying a deliberate `retracted` disposition. */
  includeRetracted?: boolean;
  /**
   * Resolve each row's outbound coord_links edges into {@link ScorecardRow.linkedItems}.
   * Default FALSE — links are OPT-IN. Pass true only on a read that actually SURFACES
   * them; today that is exactly two sites (the `scorecards.list` sync-resolver, which
   * populates the ScorecardDetail panel, and the `scorecards:list` agent tool, which
   * hands whole rows to agents).
   *
   * WHY OPT-IN (WI-6124, 2026-08-02). Resolving links costs one join-heavy query per
   * call — `issuesOutLinksMany` over up to `limit` issue refs, LEFT JOINing
   * engineer_issues AND features. Measured (pg_stat_statements): that statement —
   * queryid 4304231427406153880, reachable ONLY from here — was the most-called query
   * on the box at 1,209,724 calls / 64,865s / 279 rows per call, heavier than either
   * wide-read survivor P-008 was chasing. Nearly all of it was waste: NO server-side
   * caller reads `linkedItems` at all (verified tree-wide), only the one UI panel.
   *
   * It was eager-by-default, so each new aggregate caller silently inherited the cost —
   * which is precisely how it grew this large: `scorecardTrend` and the derived-reads
   * producer both arrived later and both paid it for a field they never read. Neither
   * default is compile-enforceable (both surfacing sites pass rows straight through, so
   * TS cannot see the read), so the default is chosen on cost asymmetry instead: a
   * missed opt-in omits a UI field — visible to whoever is looking at the panel, and
   * pinned by a test below — while a missed opt-out silently costs ~1.2M heavy joins.
   * Cheap+visible beats expensive+invisible, so absence of an opinion must mean "don't".
   */
  includeLinks?: boolean;
  /**
   * Test seam (WI-5277) — override the LIVE generation-boundary read used to judge each
   * row's {@link ScorecardRow.generationFreshness}. Production leaves this unset and
   * reads systemd. Injectable so the freshness verdict is testable without a running
   * bg-host, and so a test can prove the STALE branch (which no fixture can otherwise
   * reach, since the live boundary is whatever this box happens to be doing).
   */
  deps?: {
    readBgHostActiveEnterMs?: () => Promise<number | null>;
  };
}

interface ScorecardRowDb {
  issue_id: string;
  created_by: string | null;
  created_at: string | Date;
  payload: unknown | null;
  superseded_by: string | null;
  audit_rubric_revision: unknown;
  audit_criteria_hash: string | null;
}

/** PG contention codes that can be retried without changing the read semantics. */
function scorecardContentionPgCode(error: unknown): '55P03' | '57014' | null {
  if (!error || typeof error !== 'object') return null;
  const value = (error as { code?: unknown; pgCode?: unknown }).code ?? (error as { pgCode?: unknown }).pgCode;
  return value === '55P03' || value === '57014' ? value : null;
}

// EI-18691099450966094: was `typeof v === 'string' ? v : ...` — a raw
// Postgres-text timestamptz string (session-offset, no 'Z') passed straight
// through unparsed. Delegate to the shared helper, which parses+re-emits any
// string as an explicit UTC ISO value instead.
const tsIso = pgTimestampToIso;

/**
 * List rubric-graded scorecards (newest-first), optionally filtered by rubric,
 * source-hive, and time-window. A direct, workspace-scoped jsonb query over
 * `engineer_issues` (only rows whose `payload.observation.rubricRef` is set —
 * indexed by the sourceHive backfill), parsed through the canonical
 * `asStructuredObservation`, with `missingKeys` resolved via `getRubric`
 * (cached per rubric within the call). Organic emissions only — synthetic
 * (drill/replay/shadow) scorecards are not real Overwatch output and must not
 * pollute the monitoring read (mirrors read-items.ts's organic provenance gate;
 * a NULL origin reads organic, the backfill default).
 */
async function listScorecardsAtLimit(filter: ListScorecardsFilter, limit: number): Promise<ScorecardRow[]> {
  // EI-21592547181442895: the primary scorecard SELECT is a correctness read that
  // can overlap grading/audit writes. Keep it in a READ ONLY transaction with a
  // DB-side timeout, retry transient lock/statement contention, and only normalize
  // an exhausted contention sequence after the shared retry helper gives up.
  //
  // The SQL limit is a RAW-row batch size, not the public page size. The canonical
  // parser deliberately drops malformed historical observations below, so a single
  // LIMIT can otherwise underfill a page and make `hasMore` lie. Walk the immutable
  // `(created_at, issue_id)` keyset until we have `limit` valid scorecard rows (or
  // the raw population is exhausted). `listScorecardPage` asks for one extra valid
  // row, making its boundedness bit authoritative even when malformed rows intervene.
  let rows: ScorecardRowDb[] = [];
  let before = filter.before;
  let exhausted = false;
  while (rows.length < limit && !exhausted) {
    const batchLimit = Math.max(limit - rows.length, 1);
    let batch: ScorecardRowDb[];
    try {
      batch = await acquireWithContentionRetry(() =>
        boundedPgReadTxn<ScorecardRowDb[]>((tx) => tx<ScorecardRowDb[]>`
    SELECT scorecard.issue_id, scorecard.created_by, scorecard.created_at, scorecard.payload,
           (
             SELECT audit.payload -> 'observation' -> 'rubricRevision'
               FROM harness_shared.engineer_issues AS audit
              WHERE audit.workspace_id = scorecard.workspace_id
                AND audit.issue_id = scorecard.payload -> 'observation' -> 'gradingAudit' ->> 'auditIssueId'
              LIMIT 1
           ) AS audit_rubric_revision,
           (
             SELECT audit.payload -> 'observation' ->> 'criteriaHash'
               FROM harness_shared.engineer_issues AS audit
              WHERE audit.workspace_id = scorecard.workspace_id
                AND audit.issue_id = scorecard.payload -> 'observation' -> 'gradingAudit' ->> 'auditIssueId'
              LIMIT 1
           ) AS audit_criteria_hash,
           (
             SELECT superseder.issue_id
               FROM harness_shared.engineer_issues AS superseder
              WHERE superseder.workspace_id = scorecard.workspace_id
                AND superseder.payload -> 'observation' ->> 'supersedes' = scorecard.issue_id
                AND superseder.payload -> 'observation' ->> 'rubricRef' = scorecard.payload -> 'observation' ->> 'rubricRef'
                AND superseder.payload -> 'observation' ->> 'sourceHive' IS NOT DISTINCT FROM scorecard.payload -> 'observation' ->> 'sourceHive'
              ORDER BY superseder.created_at DESC
              LIMIT 1
           ) AS superseded_by
      FROM harness_shared.engineer_issues AS scorecard
     WHERE scorecard.workspace_id = ${issuesScopeWorkspace()}
       AND COALESCE(scorecard.signal_origin, 'organic') = 'organic'
       AND scorecard.payload -> 'observation' ->> 'rubricRef' IS NOT NULL
       AND ${filter.rubricRef ? tx`scorecard.payload -> 'observation' ->> 'rubricRef' = ${filter.rubricRef}` : tx`TRUE`}
       AND ${filter.sourceHive ? tx`scorecard.payload -> 'observation' ->> 'sourceHive' = ${filter.sourceHive}` : tx`TRUE`}
       AND ${filter.subjectRef ? tx`scorecard.payload -> 'observation' -> 'subject' ->> 'ref' = ${filter.subjectRef}` : tx`TRUE`}
       AND ${filter.issueIds ? tx`scorecard.issue_id = ANY(${[...filter.issueIds]}::text[])` : tx`TRUE`}
       AND ${filter.since ? tx`scorecard.created_at >= ${filter.since}` : tx`TRUE`}
       AND ${
         before
           ? tx`(scorecard.created_at, scorecard.issue_id) < (${before.createdAt}::timestamptz, ${before.issueId}::text)`
           : tx`TRUE`
       }
       AND ${filter.includeSynthesized ? tx`TRUE` : tx`scorecard.payload -> 'observation' ->> 'synthesized' IS DISTINCT FROM 'true'`}
       AND ${
         filter.includeSuperseded
           ? tx`TRUE`
           : tx`NOT EXISTS (
         SELECT 1
           FROM harness_shared.engineer_issues AS superseder
          WHERE superseder.workspace_id = scorecard.workspace_id
            AND superseder.payload -> 'observation' ->> 'supersedes' = scorecard.issue_id
            AND superseder.payload -> 'observation' ->> 'rubricRef' = scorecard.payload -> 'observation' ->> 'rubricRef'
            AND superseder.payload -> 'observation' ->> 'sourceHive' IS NOT DISTINCT FROM scorecard.payload -> 'observation' ->> 'sourceHive'
       )`
       }
       AND ${filter.includeRetracted ? tx`TRUE` : tx`scorecard.payload -> 'observation' -> 'retracted' IS NULL`}
     ORDER BY scorecard.created_at DESC, scorecard.issue_id DESC
     LIMIT ${batchLimit}`),
      );
    } catch (error) {
      const pgCode = scorecardContentionPgCode(error);
      if (pgCode) throw new OrgTxnTimeoutError(pgCode, error);
      throw error;
    }

    if (batch.length === 0) {
      exhausted = true;
      break;
    }

    // Advance by every raw row, including malformed ones. Only structurally valid
    // scorecards count toward the requested page. This keeps malformed history
    // auditable without letting it consume a visible page slot.
    rows.push(
      ...batch.filter((row) => {
        const observation = asStructuredObservation((row.payload as { observation?: unknown } | null)?.observation);
        return Boolean(observation?.rubricRef && observation.ratings);
      }),
    );
    const tail = batch[batch.length - 1]!;
    before = { createdAt: tsIso(tail.created_at), issueId: tail.issue_id };
    if (batch.length < batchLimit) exhausted = true;
  }

  // Resolve each distinct rubric ONCE (a scorecard read touches a handful of rubrics):
  // its criterion keys (completeness) + its scale-aware score overrides (projection).
  const rubricMeta = new Map<
    string,
    {
      keys: string[] | null;
      overrides?: Record<string, number>;
      ratingRubric: ScorecardRatingRubric | null;
    }
  >();
  const out: ScorecardRow[] = [];
  // WI-3594: when links ARE wanted, batch-fetch every row's in ONE query (no N+1)
  // rather than a per-row listOut — a scorecard page can be up to `limit` (500) rows.
  // WI-6124: ...and skip that query ENTIRELY unless the caller asked for links. Batching
  // fixed the N+1, but every aggregate-only reader still paid one join-heavy query per
  // call for a field it never read — see ListScorecardsFilter.includeLinks.
  const linksByIssue = filter.includeLinks
    ? await issuesOutLinksMany(rows.map((r) => r.issue_id))
    : new Map<string, IssueOutLink[]>();

  // WI-5277: resolve the LIVE generation boundary AT MOST ONCE per call, and only when
  // some row actually carries a stamp to judge — a read that could produce no freshness
  // verdict anyway must not pay for a systemd probe. Deliberately NOT
  // readRunningGeneration(): that also runs a `git log --before` and a tick-ledger query
  // to rebuild the full identity, and all we need here is the boundary itself.
  const anyStamped = rows.some(
    (r) =>
      (r.payload as { observation?: { gradedGeneration?: unknown } } | null)?.observation?.gradedGeneration != null,
  );
  const readLiveBoundary = filter.deps?.readBgHostActiveEnterMs ?? readBgHostActiveEnterMs;
  // Best-effort by construction: a freshness verdict must never fail the read it rides
  // on, and an unreadable boundary degrades to `unknown`, never to a false `fresh`.
  const liveHostStartedAtMs = anyStamped ? await readLiveBoundary().catch(() => null) : null;
  let gradingAuditRubricRead = false;
  let gradingAuditRubric: Rubric | null = null;
  const subjectRubrics = new Map<string, Rubric | null>();

  for (const row of rows) {
    const observation = asStructuredObservation((row.payload as { observation?: unknown } | null)?.observation);
    // The SQL guarantees rubricRef is set, but parse defensively (a malformed
    // payload yields no structured view) so a bad row degrades, never throws.
    if (!observation?.rubricRef || !observation.ratings) continue;
    if (!rubricMeta.has(observation.rubricRef)) {
      const rubric = await getRubric(observation.rubricRef);
      rubricMeta.set(observation.rubricRef, {
        keys: rubric ? rubric.criteria.map((c) => c.key) : builtInCriterionKeysForRubric(observation.rubricRef),
        overrides: scoreOverridesForScale(rubric?.ratingScale),
        ratingRubric: rubric ? { ratingScale: rubric.ratingScale, criteria: rubric.criteria } : null,
      });
    }
    const meta = rubricMeta.get(observation.rubricRef)!;
    const auditRevision =
      typeof row.audit_rubric_revision === 'number' && Number.isFinite(row.audit_rubric_revision)
        ? row.audit_rubric_revision
        : typeof row.audit_rubric_revision === 'string' && row.audit_rubric_revision.trim()
          ? Number(row.audit_rubric_revision)
          : null;
    const gradingAudit = observation.gradingAudit
      ? {
          ...observation.gradingAudit,
          ...(observation.gradingAudit.rubricRevision == null && auditRevision != null && Number.isFinite(auditRevision)
            ? { rubricRevision: auditRevision }
            : {}),
          ...(observation.gradingAudit.criteriaHash == null && row.audit_criteria_hash
            ? { criteriaHash: row.audit_criteria_hash }
            : {}),
        }
      : undefined;
    if (gradingAudit && !gradingAuditRubricRead) {
      gradingAuditRubricRead = true;
      gradingAuditRubric = await getRubric(GRADING_INTEGRITY_RUBRIC_REF).catch(() => null);
    }
    let subjectRubricCurrentness: ScorecardSubjectRubricCurrentness | undefined;
    if (observation.subject?.kind === 'rubric') {
      const subjectRef = observation.subject.ref;
      if (!subjectRubrics.has(subjectRef)) {
        subjectRubrics.set(subjectRef, await getRubric(subjectRef).catch(() => null));
      }
      subjectRubricCurrentness = classifySubjectRubricCurrentness(
        subjectRef,
        observation.subjectRubricIdentity,
        subjectRubrics.get(subjectRef) ?? null,
      );
    }
    // Canonical READ boundary: historic `PASS`/`pass` rows project to the rubric's
    // exact scale spelling, so distributions, RLE, and direction math never split a
    // semantic rating merely because an older writer used different case.
    const ratings = normalizeScorecardRatings(observation.ratings, meta.ratingRubric);
    const ratedKeys = new Set(Object.keys(ratings));
    const criteriaKeys = meta.keys;
    const rubricResolved = criteriaKeys !== null;
    const missingKeys = rubricResolved ? criteriaKeys!.filter((k) => !ratedKeys.has(k)) : [];
    const criterionKeySet = rubricResolved ? new Set(criteriaKeys!) : null;
    const extraKeys = criterionKeySet ? [...ratedKeys].filter((k) => !criterionKeySet.has(k)) : [];
    // Preserve raw ratings for audit, but project the numeric score only across
    // the rubric's declared dimensions. A historical extra must not inflate or
    // depress the score while still being visible via `extraKeys`.
    const projectionRatings = criterionKeySet
      ? Object.fromEntries(Object.entries(ratings).filter(([k]) => criterionKeySet.has(k)))
      : ratings;
    // Read the synthesized marker from the RAW payload (not the parsed observation,
    // which may strip unknown keys) so the floor stays distinguishable.
    const synthRaw = (row.payload as { observation?: { synthesized?: unknown } } | null)?.observation?.synthesized;
    const synthesized = synthRaw === true || synthRaw === 'true';
    // EI-12147: the generation stamp, also from the RAW payload — the parsed structured
    // observation may strip keys it does not know.
    const gradedGeneration = parseGradedGeneration(
      (row.payload as { observation?: { gradedGeneration?: unknown } } | null)?.observation?.gradedGeneration,
    );
    // WI-5277: the stamp alone never told a reader whether the generation it names is
    // still alive — that answer only exists at READ time. Attach it to the row so no
    // consumer has to remember to compare boundaries by hand (nobody did).
    const generationFreshness = gradedGeneration
      ? compareGenerationFreshness(gradedGeneration.hostStartedAt, liveHostStartedAtMs)
      : null;

    out.push({
      issueId: row.issue_id,
      createdAt: tsIso(row.created_at),
      createdBy: row.created_by,
      ...(observation.sourceHive ? { sourceHive: observation.sourceHive } : {}),
      ...(observation.subject ? { subject: observation.subject } : {}),
      ...(observation.rerunRecipe ? { rerunRecipe: observation.rerunRecipe } : {}),
      rubricRef: observation.rubricRef,
      ...(observation.rubricRevision != null ? { rubricRevision: observation.rubricRevision } : {}),
      ...(observation.rubricMeaningRevision != null
        ? { rubricMeaningRevision: observation.rubricMeaningRevision }
        : {}),
      ...(observation.criteriaHash ? { criteriaHash: observation.criteriaHash } : {}),
      ...(observation.subjectRubricIdentity ? { subjectRubricIdentity: observation.subjectRubricIdentity } : {}),
      ...(subjectRubricCurrentness ? { subjectRubricCurrentness } : {}),
      ...(observation.rollup ? { rollup: observation.rollup } : {}),
      ratings,
      ...(observation.testedSha ? { testedSha: observation.testedSha } : {}),
      ...(observation.releaseGateBinding
        ? { releaseGateBinding: observation.releaseGateBinding }
        : {}),
      ...(observation.instrumentSnapshots
        ? {
            // scorecards:emit validates this shape before persistence; the read-side
            // observation parser intentionally keeps historical snapshot payloads
            // opaque so they remain auditable.
            instrumentSnapshots: observation.instrumentSnapshots as Record<string, ScorecardInstrumentSnapshot>,
          }
        : {}),
      ...(observation.acceptance ? { acceptance: observation.acceptance } : {}),
      nKeys: ratedKeys.size,
      missingKeys,
      extraKeys,
      rubricResolved,
      ...(observation.evidenceFingerprint ? { evidenceFingerprint: observation.evidenceFingerprint } : {}),
      ...(observation.supersedes ? { supersedes: observation.supersedes } : {}),
      ...(observation.retracted ? { retracted: observation.retracted } : {}),
      ...(observation.provisional ? { provisional: observation.provisional } : {}),
      ...(gradingAudit ? { gradingAudit } : {}),
      ...(gradingAudit
        ? { gradingAuditCurrentness: classifyGradingAuditCurrentness(gradingAudit, gradingAuditRubric) }
        : {}),
      ...(observation.vetting ? { vetting: observation.vetting } : {}),
      ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}),
      synthesized,
      score10: scorecardScore10(projectionRatings, meta.overrides),
      linkedItems: linksByIssue.get(row.issue_id) ?? [],
      ...(gradedGeneration ? { gradedGeneration } : {}),
      ...(generationFreshness ? { generationFreshness } : {}),
    });
  }

  return out;
}

/** Public array-shaped scorecard read. The historical 500-row cap stays intact. */
export async function listScorecards(filter: ListScorecardsFilter = {}): Promise<ScorecardRow[]> {
  const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 100), 1), 500);
  return listScorecardsAtLimit(filter, limit);
}

export interface ScorecardPage {
  rows: ScorecardRow[];
  hasMore: boolean;
}

/**
 * One bounded scorecard-history page plus an authoritative exhaustion bit.
 * The private read over-fetches exactly one row; callers still receive at most
 * the public 500-row cap.
 */
export async function listScorecardPage(filter: ListScorecardsFilter = {}): Promise<ScorecardPage> {
  const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 100), 1), 500);
  const rows = await listScorecardsAtLimit(filter, limit + 1);
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
}

// ───────────────────────────────────────────────────────────────────────────
// Trend aggregation (P-010) — the qualitative health TREND over the scorecard
// time-series. The "data already exists" quick-win: every-turn scorecards ARE a
// per-criterion rating time-series; this rolls them up per criterion + computes
// a direction so the Queen/owner sees "queen-placement-health: degraded, worsening
// over 5 ratings / 3 days" instead of re-reading raw scorecards.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Trend direction over the window, from the FIRST→LATEST assessable rating:
 *  - improving  — severity fell (e.g. broken → degraded → healthy)
 *  - worsening  — severity rose (e.g. healthy → degraded → broken)
 *  - stable     — first and latest assessable ratings are equal
 *  - unknown    — fewer than 2 assessable ratings (can't tell a direction)
 * It is the NET first→latest trend; the RLE `series` (opt-in, `includeSeries`) shows
 * the within-window oscillation the single direction summarises.
 */
export type TrendDirection = 'improving' | 'worsening' | 'stable' | 'unknown';

/** Default-scale ordinal severity (healthy < degraded < broken; pass < partial < fail
 *  — the pass vocabulary was MISSING until P-004, so every pass-scale rubric's
 *  direction silently read 'unknown'). `unknown` and any custom per-criterion rating
 *  are NOT ordered (returns null → excluded from the direction calc) — only the
 *  shared default vocabularies have a meaningful order. */
const TREND_SEVERITY: Record<string, number> = {
  exemplary: -1,
  exceptional: -1,
  healthy: 0,
  degraded: 1,
  broken: 2,
  pass: 0,
  partial: 1,
  fail: 2,
  severe: 3,
};
function trendSeverity(rating: string): number | null {
  const s = TREND_SEVERITY[rating.toLowerCase()];
  return s === undefined ? null : s;
}

/**
 * An IDLE unknown: the grader saying "this stage did not RUN" (no signal),
 * vs a bare unknown = "I cannot assess it" (the drift signal staleness needs).
 * Canonical form is the `idle:` evidence prefix (EI-7624), but the convention
 * only surfaces in rubrics:trend's description — graders naturally write
 * "not exercised…" instead and silently poison staleness (rubric-system-
 * improvements-2026-07-12 P-001: three real scorecards did exactly that on
 * day one). Normalized READ-time so already-filed scorecards are fixed
 * retroactively: common not-run phrasings at the START of the evidence count
 * as idle. Exported for unit tests.
 */
export function isIdleUnknown(rating: string, evidence: string | undefined): boolean {
  if (rating.toLowerCase() !== 'unknown') return false;
  return /^\s*(idle\s*:|not\s+(exercised|applicable|assessable|observed)\b|n\/a\b|not\s+apply)/i.test(evidence ?? '');
}

/**
 * The net first→latest trend direction of a chronological rating series (default
 * ordinal healthy<degraded<broken; `unknown`/custom ratings are excluded as
 * unassessable). Exported so the (pure, DB-free) direction logic is unit-tested
 * exhaustively; `scorecardTrend` applies it per criterion.
 */
export function computeTrendDirection(series: readonly { at: string; rating: string }[]): TrendDirection {
  const assessable = series.map((s) => trendSeverity(s.rating)).filter((s): s is number => s !== null);
  if (assessable.length < 2) return 'unknown';
  const first = assessable[0];
  const last = assessable[assessable.length - 1];
  if (last > first) return 'worsening';
  if (last < first) return 'improving';
  return 'stable';
}

/**
 * One run of consecutive identical ratings — the series' run-length encoding.
 * A 500-scorecard series is mostly long runs of one rating, so RLE keeps the
 * within-window oscillation signal at ~10× less payload than per-scorecard
 * entries (WI-2943: the raw series made every realistic rubrics:trend result
 * blow the MCP token cap).
 */
export interface SeriesRun {
  rating: string;
  /** Timestamp of the first scorecard in the run (chronological). */
  from: string;
  /** Timestamp of the last scorecard in the run. */
  to: string;
  /** # consecutive scorecards in the run. */
  n: number;
}

/** Run-length encode a chronological rating series (WI-2943). Pure; exported for tests. */
export function compressSeries(series: readonly { at: string; rating: string }[]): SeriesRun[] {
  const runs: SeriesRun[] = [];
  for (const s of series) {
    const last = runs[runs.length - 1];
    if (last && last.rating === s.rating) {
      last.to = s.at;
      last.n += 1;
    } else {
      runs.push({ rating: s.rating, from: s.at, to: s.at, n: 1 });
    }
  }
  return runs;
}

/** One criterion's standing over the window: its rating series + trend direction. */
export interface CriterionTrend {
  criterion: string;
  /** # scorecards (in-window) that rated this criterion. */
  count: number;
  /** rating value → how many scorecards gave it. */
  distribution: Record<string, number>;
  /**
   * # in-window ratings that are IDLE-tagged unknowns: rating 'unknown' with
   * evidence prefixed `idle:` — the grader saying "this stage did not RUN in the
   * window" (no signal), not "I cannot assess it" (drift signal). Excluded from
   * the staleness calc (EI-7624: an idle/frozen hive flatlined 6 criteria to
   * 'unknown' and false-positived the model-drift detector).
   */
  idleCount: number;
  /** The earliest rating in the window (chronological). */
  first: { rating: string; at: string };
  /** The most-recent rating in the window. */
  latest: { rating: string; at: string };
  /** Net first→latest trend (see {@link TrendDirection}). */
  direction: TrendDirection;
  /**
   * Mean 0–10 numeric projection over the window's mappable ratings
   * (P-004 / D-001 read-time scale; unknown/custom excluded, null when none map).
   */
  mean10: number | null;
  /**
   * The criterion's machine-readable instrument binding, parsed from a trailing
   * `[instrumentKey: <key>|none]` token on the rubric criterion's `model` (WI-4607).
   * A real key = the concrete instrument that grades this criterion; `'none'` =
   * explicitly un-instrumented; `null`/absent = the criterion definition carries no
   * such token. Lets the trend view show which instrument backs each criterion.
   */
  instrumentKey?: string | null;
  /** The chronological series as RLE runs (oldest → newest). Only present when
   *  requested (`includeSeries`, WI-2943) — the summary fields above are the
   *  default payload. */
  series?: SeriesRun[];
}

// ───────────────────────────────────────────────────────────────────────────
// Staleness signal (P-011 / D-004) — flag a rubric whose MODEL has drifted from
// reality. The signal: criteria the Overwatch persistently rates 'unknown' (it
// cannot ASSESS them) — the rubric's model/method for that criterion no longer
// matches how the system works. A stale rubric re-enters the queen↔scout loop for
// re-ratification (a new revision). "Start with a simple flag; don't over-automate"
// (D-004): this is detection only — surfaced on rubrics:trend so the Queen decides.
//
// Why 'unknown' (not persistent 'broken'): an unassessable criterion means the
// rubric drifted; a persistently-BROKEN criterion usually means the SYSTEM is broken
// (a real finding the trend's worsening/broken distribution already surfaces) — NOT a
// stale rubric. Defaulting to 'unknown' avoids false-positiving staleness onto a
// working rubric correctly reporting a broken system. Override `staleRatings` to widen.
// ───────────────────────────────────────────────────────────────────────────

/** One criterion flagged as stale (persistently unassessable). */
export interface CriterionStaleness {
  criterion: string;
  /** Fraction of NON-IDLE in-window ratings that are a "stale" rating (default 'unknown'). */
  staleFraction: number;
  /** # non-idle in-window ratings for this criterion (the evidence base). */
  samples: number;
  /** # idle-tagged unknowns excluded from the calc (see {@link CriterionTrend.idleCount}). */
  idleExcluded: number;
  reason: string;
}

/** A rubric's staleness assessment over the scorecard window. */
export interface RubricStaleness {
  /** true when ≥1 criterion is flagged stale — the rubric's model may have drifted. */
  stale: boolean;
  /** The criteria flagged stale + why (empty when not stale). */
  staleCriteria: CriterionStaleness[];
  /**
   * How many criteria had enough non-idle evidence to actually be JUDGED. Zero means
   * `stale:false` is "we could not look", NOT "we looked and it was clean" — read this
   * before treating a false as a clean bill of health.
   */
  judgedCriteria: number;
  /**
   * false when NO criterion could be judged (a rubric that has never been graded, or
   * whose every criterion is below `minSamples`). Distinguishes the two opposite
   * realities that otherwise both render as `stale:false`.
   */
  assessed: boolean;
  /** Human-readable rubric-level summary. */
  reason: string;
}

export interface RubricStalenessOpts {
  /** Min in-window ratings for a criterion before staleness is judged (default 3) —
   *  too few ratings is "unknown", not "stale". */
  minSamples?: number;
  /** Stale-rating fraction at/above which a criterion is flagged (default 0.5). */
  staleFraction?: number;
  /** Ratings that count as "stale" evidence (default ['unknown']). Case-insensitive. */
  staleRatings?: readonly string[];
}

const STALENESS_DEFAULTS = {
  minSamples: 3,
  staleFraction: 0.5,
  staleRatings: ['unknown'] as readonly string[],
};

/**
 * Detect rubric staleness from its per-criterion trends (P-011). A criterion with
 * ≥ `minSamples` in-window ratings of which ≥ `staleFraction` are a stale rating
 * (default 'unknown') is flagged — the Overwatch keeps being unable to assess it, so
 * the rubric's model for it no longer matches reality. Pure (DB-free) so it unit-tests
 * exhaustively; `scorecardTrend` applies it over the criteria it builds.
 */
export function computeRubricStaleness(
  criteria: readonly CriterionTrend[],
  opts: RubricStalenessOpts = {},
): RubricStaleness {
  const minSamples = opts.minSamples ?? STALENESS_DEFAULTS.minSamples;
  const staleFraction = opts.staleFraction ?? STALENESS_DEFAULTS.staleFraction;
  const staleRatings = new Set((opts.staleRatings ?? STALENESS_DEFAULTS.staleRatings).map((r) => r.toLowerCase()));

  const staleCriteria: CriterionStaleness[] = [];
  let judgedCriteria = 0;
  for (const c of criteria) {
    // Idle-tagged unknowns are "the stage did not run" — no signal either way
    // (EI-7624). Exclude them from BOTH sides of the fraction, so a mostly-idle
    // window neither manufactures staleness nor dilutes a real drift signal in
    // the few non-idle samples.
    const idle = staleRatings.has('unknown') ? (c.idleCount ?? 0) : 0;
    const samples = c.count - idle;
    if (samples < minSamples) continue; // too little non-idle evidence → not "stale", just quiet
    judgedCriteria += 1;
    const rawStale = Object.entries(c.distribution).reduce(
      (n, [rating, k]) => (staleRatings.has(rating.toLowerCase()) ? n + k : n),
      0,
    );
    const staleCount = rawStale - idle;
    const fraction = staleCount / samples;
    if (fraction >= staleFraction) {
      staleCriteria.push({
        criterion: c.criterion,
        staleFraction: fraction,
        samples,
        idleExcluded: idle,
        reason: `${staleCount}/${samples} recent non-idle ratings are ${[...staleRatings].join('/')}${idle > 0 ? ` (${idle} idle-tagged excluded)` : ''} — the criterion's model may no longer match how the system works`,
      });
    }
  }

  const stale = staleCriteria.length > 0;
  // `stale:false` has TWO opposite meanings and they must not render alike: "we judged
  // the criteria and nothing drifted" vs "we could not judge anything at all". A rubric
  // that has NEVER been graded yields criteria:[], so the loop above never runs and the
  // old code returned the reassuring "criteria are being assessed" — a claim that is
  // simply false, and indistinguishable from a well-assessed rubric (measured: a 13-
  // scorecard rubric and a 0-scorecard one returned byte-identical staleness). That
  // false-clean is load-bearing here, because an agent standing up NEW success criteria
  // reads this to decide whether its grading rails are live. scorecards:freshness
  // already reports the same rubric correctly as status:'stale'/emitted:false.
  const assessed = judgedCriteria > 0;
  return {
    stale,
    staleCriteria,
    judgedCriteria,
    assessed,
    reason: stale
      ? `${staleCriteria.length} criteri${staleCriteria.length === 1 ? 'on' : 'a'} persistently unassessable (${staleCriteria
          .map((s) => s.criterion)
          .join(', ')}) — the rubric model may have drifted; re-ratify via the queen↔scout loop`
      : assessed
        ? `no staleness detected (${judgedCriteria} criteri${judgedCriteria === 1 ? 'on is' : 'a are'} being assessed)`
        : criteria.length === 0
          ? 'UNKNOWN, not clean — NO scorecards in window, so this rubric has never been graded and nothing could be judged. Check scorecards:freshness for the emission gap before treating this as healthy.'
          : `UNKNOWN, not clean — none of the ${criteria.length} criteri${criteria.length === 1 ? 'on' : 'a'} has the ${minSamples}+ non-idle ratings needed to judge staleness, so nothing could be judged.`,
  };
}

/** A rubric's qualitative health trend — per-criterion rating time-series + direction. */
export interface RubricTrend {
  rubricRef: string;
  sourceHive?: string;
  /**
   * Full rubric definition, opt-in for definition-aware detail surfaces. The trend
   * aggregation already resolves this exact rubric once for rating-scale and contract-
   * generation semantics, so including it adds no store read. Omitted by default to
   * keep the agent-facing rubrics:trend payload compact.
   */
  definition?: Rubric;
  /** # scorecards aggregated in the window. */
  scorecardCount: number;
  /**
   * Explicit bounded-input evidence. `inputCount` is the raw newest-first
   * sample before trend-only exclusions; it is never a corpus total.
   */
  sample: { limit: number; inputCount: number };
  /** The observed time span (oldest..newest scorecard) + the requested `since`. */
  window: { since?: string; from?: string; to?: string };
  /** Filing time remains separate from the subject observation window. */
  filingWindow?: { from: string; to: string };
  observationWindow?: { from: string; to: string };
  filingLagMs?: { min: number; max: number; mean: number; measured: number };
  /** Exact identities behind the aggregate, opt-in alongside the rating series. */
  scorecardIdentities?: Array<Pick<ScorecardRow,
    'issueId' | 'createdAt' | 'subject' | 'rubricRevision' | 'criteriaHash' | 'gradedGeneration' | 'generationFreshness'
  >>;
  /** Per-criterion trends, criterion key ASC (stable output). */
  criteria: CriterionTrend[];
  /** Governance provenance (WI-4607, D-012): the rubric's status + who proposed vs.
   *  ratified it, so the detail panel can surface author≠ratifier the same way the
   *  RubricsPanel list does. Sourced from the same getRubric() read the mean10 scale
   *  projection already runs — no extra store hit. Absent only for a missing rubric. */
  status?: RubricStatus;
  proposedBy?: string | null;
  ratifiedBy?: string | null;
  /** Staleness signal (P-011): criteria the Overwatch persistently can't assess,
   *  suggesting the rubric's model has drifted and should re-enter the queen↔scout
   *  loop for re-ratification. */
  staleness: RubricStaleness;
  /**
   * How many scorecards were EXCLUDED from this trend as superseded — each the DST
   * of a `revises` edge from a later correction (goal-mode-rubric-v2-2026-08-10 P-010).
   *
   * REPORTED, never silent, and that is the point. A re-grade used to enter the
   * series as an ADDITIONAL sample, so correcting a scorecard moved the trend twice:
   * once for the wrong reading and again for the right one. Measured on goal-mode-e2e:
   * three of its five samples are corrections of one another (their own titles say
   * "#4 (CORRECTION)" / "#5 (SECOND CORRECTION)"), so the reported direction was an
   * artifact of re-grading rather than a change in the thing being graded.
   *
   * Dropping them silently would trade one invisible distortion for another — a reader
   * seeing `scorecardCount: 2` with no explanation cannot tell a quiet window from a
   * heavily-corrected one. So the count is surfaced and `scorecardCount` counts only
   * what actually fed the series.
   */
  supersededExcluded: number;
  /**
   * How many scorecards were EXCLUDED as pre-dating the rubric's declared
   * contract-generation boundary (`Rubric.historyResetAt`, goal-mode-rubric-v2 D-015) —
   * gradings of a contract that has since been rewritten.
   *
   * Reported for the same reason supersededExcluded is: an exclusion nobody can see is
   * only a tidier version of the blend it replaced. A reader who sees the count drop
   * from 5 to 0 must be able to tell "this rubric was rewritten and its old gradings
   * retired" from "nobody has graded this in the window".
   *
   * 0 for every rubric that has never declared a boundary, which is all of them by
   * default — this can only ever remove samples an author explicitly retired.
   */
  preContractResetExcluded: number;
  /**
   * How many scorecards were EXCLUDED as PROVISIONAL (P-008 / EI-20581177540737568):
   * they rated 'violatable'-class criteria mid-run, and a violatable criterion is
   * monotonic-downward — the WI-39348 grading went stale 28 minutes after an honest
   * interim 'exemplary'. A provisional card is a working note (D-004); only its
   * terminal re-emit moves the trend. Reported, never silent, like the two counts
   * above. 0 for every rubric with no violatable criteria.
   */
  provisionalExcluded: number;
  /**
   * P-013 (D-004 grade-the-grader): terminal cards EXCLUDED because their grading is
   * final but UNAUDITED (gradingAudit.state 'pending') — a non-author audit against
   * the grading-integrity meta-rubric settles them into the series. Reported, never
   * silent, like the counts above. 0 wherever the audit gate is off or all cards
   * predate it.
   */
  gradingAuditPendingExcluded: number;
}

export interface ScorecardTrendFilter {
  /** The rubric to trend (required — a trend is per-rubric). */
  rubricRef: string;
  /** Restrict to one source-hive (trends are per-hive when set). */
  sourceHive?: string;
  /** Only scorecards filed at/after this ISO timestamp (the window). */
  since?: string;
  /** Max scorecards to aggregate (newest-first read; default 500). */
  limit?: number;
  /**
   * Include each criterion's chronological series as RLE runs (WI-2943). Default
   * FALSE: the raw per-scorecard series dominated the payload (~84% at 200
   * scorecards × 14 criteria, guaranteed over the MCP result cap at the default
   * limit) while every known consumer wants the summary fields.
   */
  includeSeries?: boolean;
  /**
   * Include the already-resolved full rubric definition in the result. Default FALSE:
   * replication drills can be long, and most trend consumers need only aggregates.
   */
  includeDefinition?: boolean;
}

/**
 * Parse a criterion's instrument binding from a trailing `[instrumentKey: <key>|none]`
 * token on its `model` prose (WI-4607). The token is greppable text, not a schema
 * field. Returns the key (or the literal `'none'` when explicitly un-instrumented),
 * or `null` when the model carries no such trailing token. Only a TRAILING token
 * binds — a mention mid-prose is not a binding, so a criterion that merely discusses
 * instrument keys does not accidentally acquire one.
 */
export function parseCriterionInstrumentKey(
  model: string | null | undefined,
  instrumentKey?: string | null,
): string | null {
  if (instrumentKey?.trim()) return instrumentKey.trim();
  const m = /\[instrumentKey:\s*([a-z0-9-]+|none)\]\s*$/.exec(model ?? '');
  return m ? m[1] : null;
}

/**
 * Aggregate a rubric's scorecards into a per-criterion rating time-series + a
 * trend direction (P-010). Reads {@link listScorecards} (P-013) — the trend is a
 * pure roll-up of the scorecard read, so it inherits the same workspace scope +
 * organic-only + rubric filtering, and stays correct as the storage evolves.
 */
export async function scorecardTrend(filter: ScorecardTrendFilter): Promise<RubricTrend> {
  const sampleLimit = Math.min(Math.max(Math.trunc(filter.limit ?? 500), 1), 500);
  const rows = await listScorecards({
    rubricRef: filter.rubricRef,
    sourceHive: filter.sourceHive,
    since: filter.since,
    limit: sampleLimit,
    // WI-6124: no includeLinks — the trend is a pure roll-up of ratings + createdAt and
    // never reads `linkedItems`, so it takes the default and skips the join.
  });
  // Scale-aware numeric projection for mean10 (one rubric per trend → one resolve).
  // Resolved BEFORE the exclusions below because the contract-generation boundary is
  // declared on the rubric.
  const trendRubric = await getRubric(filter.rubricRef);

  // D-015: drop gradings filed BEFORE the rubric's declared contract-generation
  // boundary. They rated a materially different contract, so they are not comparable
  // with post-rewrite ones — and dropping keys cannot express it, because the cases
  // that matter share a key: a question that NARROWED under a kept key (goal-mode-e2e
  // `dedup-before-creating`, D-009) and a kept key whose drill could not measure at all
  // (`child-execution-proven`, 5/5 unknown, D-012).
  //
  // Absent a declared boundary this is a no-op — every rubric that never rewrote its
  // contract trends exactly as before.
  const resetAtMs = trendRubric?.historyResetAt ? Date.parse(trendRubric.historyResetAt) : NaN;
  const inGeneration = Number.isFinite(resetAtMs) ? rows.filter((r) => Date.parse(r.createdAt) >= resetAtMs) : rows;
  const preContractResetExcluded = rows.length - inGeneration.length;

  // P-010: drop scorecards a later filing REVISED. A correction used to enter the
  // series as an extra sample, so re-grading moved the trend twice — once for the
  // reading now known to be wrong, again for the right one. One rel-filtered in-edge
  // query (NOT the heavy issuesOutLinksMany join the trend deliberately skips).
  //
  // Applied to `inGeneration`, not `rows`: a pre-boundary scorecard that was ALSO
  // superseded must count once, in one bucket. Counting it in both would make the two
  // exclusion figures sum past the number actually excluded — the same
  // invisible-arithmetic failure these counts exist to prevent.
  const supersededIds = await issuesSupersededByRevision(inGeneration.map((r) => r.issueId));
  const live = supersededIds.size ? inGeneration.filter((r) => !supersededIds.has(r.issueId)) : inGeneration;
  // P-008: drop PROVISIONAL cards — mid-run ratings of 'violatable' criteria are
  // working notes (D-004), not settled gradings; the terminal re-emit that supersedes
  // one is what enters the series. Applied after the superseded filter for the same
  // one-bucket arithmetic reason as above: a provisional card that was ALSO superseded
  // counts once, as superseded.
  // P-013: drop AUDIT-PENDING terminal cards the same way — the grading is final but
  // unverified until a non-author audit settles it (D-004). Same one-bucket
  // arithmetic: a card both provisional and audit-pending counts once, as provisional.
  //
  // EI-21949865560276745: both drops now route through the exported
  // `scorecardAdmissionExclusion` so a second reader inherits this policy rather than
  // re-deriving it. The precedence that produces the one-bucket arithmetic lives in the
  // helper; the two counts below are unchanged in value.
  const finalCards: ScorecardRow[] = [];
  let provisionalExcluded = 0;
  let gradingAuditPendingExcluded = 0;
  for (const r of live) {
    const excluded = scorecardAdmissionExclusion(r);
    if (excluded === 'provisional') provisionalExcluded += 1;
    else if (excluded === 'grading-audit-pending') gradingAuditPendingExcluded += 1;
    else finalCards.push(r);
  }
  // listScorecards is newest-first; the series wants chronological (oldest→newest).
  const chrono = [...finalCards].reverse();
  const filingTimes = chrono.map((card) => Date.parse(card.createdAt)).filter(Number.isFinite);
  const observationStarts = chrono
    .map((card) => (card.subject?.windowStart ? Date.parse(card.subject.windowStart) : NaN))
    .filter(Number.isFinite);
  const observationEnds = chrono
    .map((card) => (card.subject?.windowEnd ? Date.parse(card.subject.windowEnd) : NaN))
    .filter(Number.isFinite);
  const filingLags = chrono
    .map((card) => {
      const end = card.subject?.windowEnd ? Date.parse(card.subject.windowEnd) : NaN;
      const filed = Date.parse(card.createdAt);
      return Number.isFinite(end) && Number.isFinite(filed) ? filed - end : null;
    })
    .filter((lag): lag is number => lag !== null);

  const scoreOverrides = scoreOverridesForScale(trendRubric?.ratingScale);
  const declaredCriterionKeys = trendRubric ? new Set(trendRubric.criteria.map((c) => c.key)) : null;

  // WI-4607: parse each criterion's instrument binding once per key so the trend
  // view can show which instrument grades each criterion.
  const instrumentKeyByCriterion = new Map<string, string>();
  for (const c of trendRubric?.criteria ?? []) {
    const key = parseCriterionInstrumentKey(c.model, c.instrumentKey);
    if (key) instrumentKeyByCriterion.set(c.key, key);
  }

  const byCriterion = new Map<string, { at: string; rating: string; idle: boolean }[]>();
  for (const sc of chrono) {
    for (const [criterion, entry] of Object.entries(sc.ratings)) {
      // Historical writers could store ad-hoc rating keys while still passing
      // the old missing-only completeness gate (EI-11617). Keep those visible
      // on scorecards:list via extraKeys, but never promote them to rubric trend
      // dimensions. Unknown rubrics remain readable because there is no declared
      // key set to filter against.
      if (declaredCriterionKeys && !declaredCriterionKeys.has(criterion)) continue;
      const arr = byCriterion.get(criterion) ?? [];
      arr.push({ at: sc.createdAt, rating: entry.rating, idle: isIdleUnknown(entry.rating, entry.evidence) });
      byCriterion.set(criterion, arr);
    }
  }

  const criteria: CriterionTrend[] = [...byCriterion.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([criterion, series]) => {
      const distribution: Record<string, number> = {};
      for (const s of series) distribution[s.rating] = (distribution[s.rating] ?? 0) + 1;
      const nums = series.map((s) => ratingScore10(s.rating, scoreOverrides)).filter((n): n is number => n !== null);
      return {
        criterion,
        count: series.length,
        distribution,
        idleCount: series.reduce((n, s) => n + (s.idle ? 1 : 0), 0),
        first: { rating: series[0].rating, at: series[0].at },
        latest: { rating: series[series.length - 1].rating, at: series[series.length - 1].at },
        direction: computeTrendDirection(series),
        mean10: nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10 : null,
        instrumentKey: instrumentKeyByCriterion.get(criterion) ?? null,
        ...(filter.includeSeries ? { series: compressSeries(series) } : {}),
      };
    });

  const supersededExcluded = inGeneration.length - live.length;
  const staleness = computeRubricStaleness(criteria);
  // Trend-only exclusions happen before criteria are built. When every input card
  // is excluded, an empty criteria list otherwise looks identical to a rubric that
  // had no scorecards at all, which makes the diagnostic claim "never been graded"
  // false (EI-21167213678011223). Keep computeRubricStaleness's pure/direct-call
  // contract intact and add the aggregation context only where it is available.
  const excludedPopulationCounts: Array<[kind: string, count: number]> = [
    ['superseded', supersededExcluded],
    ['pre-contract-reset', preContractResetExcluded],
    ['provisional', provisionalExcluded],
    ['grading-audit-pending', gradingAuditPendingExcluded],
  ];
  const excludedPopulations = excludedPopulationCounts.filter(([, count]) => count > 0);
  const excludedTotal = excludedPopulations.reduce((total, [, count]) => total + count, 0);
  const stalenessWithExclusionContext =
    finalCards.length === 0 && !staleness.assessed && excludedTotal > 0
      ? {
          ...staleness,
          reason: `UNKNOWN, not clean — ${excludedTotal} scorecard${excludedTotal === 1 ? '' : 's'} in the window were excluded from trend aggregation (${excludedPopulations
            .map(([kind, count]) => `${count} ${kind}`)
            .join(', ')}); no scorecards remained to judge staleness.`,
        }
      : staleness;

  return {
    rubricRef: filter.rubricRef,
    ...(filter.sourceHive ? { sourceHive: filter.sourceHive } : {}),
    ...(filter.includeDefinition && trendRubric ? { definition: trendRubric } : {}),
    scorecardCount: finalCards.length,
    sample: { limit: sampleLimit, inputCount: rows.length },
    supersededExcluded,
    preContractResetExcluded,
    provisionalExcluded,
    gradingAuditPendingExcluded,
    window: {
      ...(filter.since ? { since: filter.since } : {}),
      ...(chrono.length ? { from: chrono[0].createdAt, to: chrono[chrono.length - 1].createdAt } : {}),
    },
    ...(filter.includeSeries ? {
      scorecardIdentities: chrono.map((card) => ({
        issueId: card.issueId,
        createdAt: card.createdAt,
        ...(card.subject ? { subject: card.subject } : {}),
        ...(card.rubricRevision != null ? { rubricRevision: card.rubricRevision } : {}),
        ...(card.criteriaHash ? { criteriaHash: card.criteriaHash } : {}),
        ...(card.gradedGeneration ? { gradedGeneration: card.gradedGeneration } : {}),
        ...(card.generationFreshness ? { generationFreshness: card.generationFreshness } : {}),
      })),
    } : {}),
    ...(filingTimes.length
      ? {
          filingWindow: {
            from: new Date(Math.min(...filingTimes)).toISOString(),
            to: new Date(Math.max(...filingTimes)).toISOString(),
          },
        }
      : {}),
    ...(observationStarts.length && observationEnds.length
      ? {
          observationWindow: {
            from: new Date(Math.min(...observationStarts)).toISOString(),
            to: new Date(Math.max(...observationEnds)).toISOString(),
          },
        }
      : {}),
    ...(filingLags.length
      ? {
          filingLagMs: {
            min: Math.min(...filingLags),
            max: Math.max(...filingLags),
            mean: Math.round(filingLags.reduce((sum, lag) => sum + lag, 0) / filingLags.length),
            measured: filingLags.length,
          },
        }
      : {}),
    criteria,
    ...(trendRubric ? { status: trendRubric.status } : {}),
    proposedBy: trendRubric?.proposedBy ?? null,
    ratifiedBy: trendRubric?.ratifiedBy ?? null,
    staleness: stalenessWithExclusionContext,
  };
}
