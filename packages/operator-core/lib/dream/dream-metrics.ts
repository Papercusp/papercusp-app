/** Dream measurement over the existing run, routed-idea and experiment ledgers. */
import type { Sql } from 'postgres';
import type { CapabilityReviewResult } from './capability-review';
import { DREAM_REVIEW_OUTCOMES, dreamReviewOutcome } from './dream-config';
import { DREAM_RUN_TERMINAL_STATUSES, mapDreamRun, type DreamRun } from './dream-run-store';
import {
  DREAM_CALL_PHASES, dreamCapabilityRun, dreamRunAssessments, dreamRunReuse,
  type DreamRunAssessment,
} from './dream-run-provenance';
import type { ExperimentRunSummary } from '../experiment/ledger';

type Finding = 'supported' | 'disproven' | 'unknown';
type Cost = { knownUsd: number; unresolvedBoundUsd: number; unknownCalls: number; actualUsd: number | null };
export interface DreamMetricRow {
  run: DreamRun;
  routed: { rail: string; humanGrade: number | null; outcome: string | null } | null;
  experiments: Array<ExperimentRunSummary & { baselineId: string }>;
}
export interface DreamMetricsScope {
  workspaceId: string;
  potSlug: string;
  since: string;
  until: string;
}
const ratio = (numerator: number, denominator: number) => ({
  numerator, denominator, value: denominator > 0 ? numerator / denominator : null,
});
const tally = () => ({ supported: 0, disproven: 0, unknown: 0 });
const cost = (): Cost => ({ knownUsd: 0, unresolvedBoundUsd: 0, unknownCalls: 0, actualUsd: 0 });
const increment = (map: Record<string, number>, key: string) => { map[key] = (map[key] ?? 0) + 1; };

function validateScope(scope: DreamMetricsScope) {
  const since = Date.parse(scope.since), until = Date.parse(scope.until);
  if (!scope.workspaceId.trim() || !scope.potSlug.trim() || !Number.isFinite(since) ||
      !Number.isFinite(until) || until <= since || until - since > 31 * 86_400_000)
    throw new RangeError('Dream metrics require a workspace, pot and a positive window of at most 31 days');
  return { since, until };
}

/** Revisions by one assessor are not independent votes. Keep the latest per assessor. */
function currentAssessments(run: DreamRun): DreamRunAssessment[] {
  const current = new Map<string, DreamRunAssessment>();
  for (const a of dreamRunAssessments(run)) {
    if (a.candidateHash !== run.review?.candidateHash || a.evidenceHash !== run.review?.evidenceHash)
      throw new Error('Dream assessment is not bound to its frozen review');
    const previous = current.get(a.assessor);
    if (!previous || a.recordedAt >= previous.recordedAt) current.set(a.assessor, a);
  }
  return [...current.values()];
}

/** Streaming fold: the display's recent-row limit never bounds measurement. */
class DreamMetricsFold {
  private readonly window;
  private readonly seen = new Set<string>();
  private readonly families = new Map<string, number>();
  private readonly qualified = new Set<string>();
  private readonly packets = new Map<string, { costUsd: number | null; durationMs: number }>();
  private readonly units = new Set<string>();
  private readonly mechanisms = new Set<string>();
  private readonly routedRefs = new Set<string>();
  private readonly linkedBatteries = new Set<string>();
  private readonly domainPairs = new Set<string>();
  private readonly snapshots = new Set<string>();
  private readonly populations = new Map<string, { eligible: Set<string>; selected: Set<string> }>();
  private readonly experiments = new Map<string, DreamMetricRow['experiments'][number]>();
  private readonly phases = Object.fromEntries(DREAM_CALL_PHASES.map(p => [p, cost()])) as Record<string, Cost>;
  private readonly models: Record<string, Cost> = {};
  private readonly statuses: Record<string, number> = Object.fromEntries(['running', ...DREAM_RUN_TERMINAL_STATUSES].map(s => [s, 0]));
  private readonly reviewOutcomes: Record<string, number> = Object.fromEntries(DREAM_REVIEW_OUTCOMES.map(s => [s, 0]));
  private readonly arities: Record<string, number> = {};
  private readonly recipes: Record<string, number> = {};
  private readonly versions: Record<string, number> = {};
  private readonly configurations: Record<string, number> = {};
  private readonly thirdRoles: Record<string, number> = {};
  private readonly indexHealth: Record<string, number> = {};
  private readonly curve: Array<{ runId: string; at: string; knownCallUsd: number; qualifiedFamilies: number; costIncomplete: boolean }> = [];
  private readonly strategies: Record<string, number> = {};
  private readonly exclusions: Record<string, number> = {};
  private readonly routes: Record<string, number> = {};
  private readonly grades: Record<string, number> = {};
  private readonly outcomes: Record<string, number> = {};
  private readonly quality = { novelty: tally(), usefulness: tally(), feasibility: tally(), maintainability: tally() };
  private readonly reuse = { rediscovery: 0, refinement: 0, linkedToPrior: 0, usefulness: tally() };
  private readonly errors: string[] = [];
  private attempts = 0;
  private eligible = 0;
  private proposals = 0;
  private reviewed = 0;
  private reviewPassed = 0;
  private assessed = 0;
  private compared = 0;
  private disagreement = 0;
  private familyUnknown = 0;
  private qualificationUnknown = 0;
  private legacy = 0;
  private missingUsage = 0;
  private knownUsd = 0;
  private boundUsd = 0;
  private coldPacketUsd = 0;
  private unknownPacketUses = 0;
  private packetUses = 0;
  private incompletePackets = 0;
  private routed = 0;

  constructor(private readonly scope: DreamMetricsScope) { this.window = validateScope(scope); }

  add(row: DreamMetricRow) {
    const { run } = row;
    if (run.workspaceId !== this.scope.workspaceId || run.potSlug !== this.scope.potSlug)
      throw new Error('Dream metrics row crosses workspace or pot');
    const started = Date.parse(run.startedAt);
    if (!Number.isFinite(started)) throw new Error('Invalid Dream start timestamp');
    if (started < this.window.since || started >= this.window.until || this.seen.has(run.runId)) return;
    this.seen.add(run.runId);
    this.attempts++;
    increment(this.statuses, run.status);
    increment(this.reviewOutcomes, dreamReviewOutcome(run.review));
    const reuse = dreamRunReuse(run);
    if (reuse) {
      this.reuse[reuse.kind]++;
      if (reuse.priorRefs.length) this.reuse.linkedToPrior++;
      this.reuse.usefulness[reuse.usefulness]++;
    }
    const provenance = dreamCapabilityRun(run);
    increment(this.versions, provenance?.schemaVersion ?? 'legacy');
    const selected = provenance?.sampling?.status === 'selected' ? provenance.sampling.selection : null;
    if (selected || (!provenance && run.fragmentRefs.length >= 2)) this.eligible++;
    const proposal = run.outcome?.verdict === 'insight';
    if (proposal) this.proposals++;
    if (run.review && run.review.schemaVersion !== 'dream-capability-preflight-v1') this.reviewed++;
    if (run.review?.verdict === 'accept') this.reviewPassed++;

    if (provenance) {
      increment(this.configurations, JSON.stringify([
        provenance.manifestRevision, provenance.dreamPromptVersion, provenance.reviewPromptVersion,
      ]));
      let accounted = 0;
      for (const call of provenance.calls) {
        const buckets = [this.phases[call.phase]!, this.models[call.model] ??= cost()];
        if (call.status === 'settled' && call.usage) {
          this.knownUsd += call.usage.costUsd;
          accounted += call.usage.costUsd;
          for (const b of buckets) b.knownUsd += call.usage.costUsd;
        } else {
          this.missingUsage++;
          this.boundUsd += call.reservedUsd;
          accounted += call.reservedUsd;
          for (const b of buckets) { b.unknownCalls++; b.unresolvedBoundUsd += call.reservedUsd; }
        }
      }
      if (Math.abs(accounted - run.costUsd) > 1e-8) this.errors.push(`${run.runId}: phase charges do not reconcile`);
      // An insight/error after selection without a generation receipt is not a free attempt.
      const generationSkipped = run.review?.schemaVersion === 'dream-capability-preflight-v1' && run.outcome?.generationSkipped === true;
      if (selected && run.status !== 'running' && !generationSkipped && !provenance.calls.some(c => c.phase === 'generation')) {
        this.missingUsage++;
        this.phases.generation!.unknownCalls++;
      }
      if (provenance.sampling) {
        const { log } = provenance.sampling;
        increment(this.strategies, log.strategy);
        if (!this.snapshots.has(log.snapshotFingerprint)) {
          this.snapshots.add(log.snapshotFingerprint);
          for (const e of log.exclusions) increment(this.exclusions, e.reason);
        }
        if (log.eligibleUnitIds) {
          const population = this.populations.get(log.snapshotFingerprint) ?? {
            eligible: new Set(log.eligibleUnitIds), selected: new Set<string>(),
          };
          if (population.eligible.size !== log.eligibleUnitIds.length ||
              log.eligibleUnitIds.some(id => !population.eligible.has(id)))
            throw new Error('A sampling snapshot has conflicting population records');
          if (selected) for (const e of [selected.a, selected.b, ...(selected.c ? [selected.c.entry] : [])])
            population.selected.add(e.packet.unit.id);
          this.populations.set(log.snapshotFingerprint, population);
        }
      }
    } else {
      this.legacy++;
      const expected = [
        { phase: 'generation', usage: run.dreamUsage, required: run.status !== 'no-pair' },
        { phase: 'review', usage: run.reviewUsage, required: Boolean(run.review) || run.status === 'accepted' || run.status === 'rejected' },
      ];
      let actual = 0;
      for (const e of expected) {
        if (e.usage) {
          actual += e.usage.costUsd;
          this.phases[e.phase]!.knownUsd += e.usage.costUsd;
          (this.models[e.usage.model] ??= cost()).knownUsd += e.usage.costUsd;
        } else if (e.required) { this.missingUsage++; this.phases[e.phase]!.unknownCalls++; }
      }
      this.knownUsd += actual;
      if (Math.abs(actual - run.costUsd) > 1e-8) this.errors.push(`${run.runId}: legacy summaries do not reconcile`);
    }

    if (selected) {
      const entries = [selected.a, selected.b, ...(selected.c ? [selected.c.entry] : [])];
      increment(this.arities, String(entries.length));
      increment(this.recipes, selected.recipe);
      increment(this.thirdRoles, selected.c?.declaration.role ?? 'none');
      this.domainPairs.add(JSON.stringify([selected.a.packet.unit.homeDomain, selected.b.packet.unit.homeDomain].sort()));
      for (const { packet } of entries) {
        this.units.add(`${packet.scope.repositoryId}:${packet.unit.id}`);
        if (packet.unit.granularity === 'mechanism') this.mechanisms.add(`${packet.scope.repositoryId}:${packet.unit.id}`);
        increment(this.indexHealth, packet.extraction.indexHealth);
        const key = `${packet.scope.repositoryId}:${packet.unit.id}:${packet.unitHash}:${packet.extraction.artifactHash}`;
        const value = { costUsd: packet.extraction.costUsd, durationMs: packet.extraction.durationMs };
        const prior = this.packets.get(key);
        if (prior && prior.costUsd !== value.costUsd) this.errors.push(`${run.runId}: packet cost identity conflicts`);
        this.packets.set(key, value);
        if (value.costUsd === null) this.unknownPacketUses++;
        else this.coldPacketUsd += value.costUsd;
        this.packetUses++;
        if (packet.coverage.truncated || packet.coverage.unresolved.length) this.incompletePackets++;
      }
    } else increment(this.arities, provenance ? 'unselected' : 'legacy');

    if (proposal) {
      const assessments = currentAssessments(run);
      const review = provenance ? run.review as unknown as CapabilityReviewResult | null : null;
      const consensus = (key: 'novelty' | 'usefulness' | 'maintainability'): Finding => {
        const values = new Set(assessments.map(a => a[key]));
        return values.size === 1 ? [...values][0]! : 'unknown';
      };
      const findings = {
        novelty: consensus('novelty'), usefulness: consensus('usefulness'),
        maintainability: consensus('maintainability'),
        feasibility: review?.judgment?.feasibility.status ?? 'unknown',
      };
      for (const key of Object.keys(findings) as Array<keyof typeof findings>) this.quality[key][findings[key]]++;
      if (assessments.length) this.assessed++;
      if (assessments.length >= 2) {
        this.compared++;
        if (new Set(assessments.map(a => JSON.stringify([a.familyId, a.novelty, a.usefulness, a.maintainability]))).size > 1)
          this.disagreement++;
      }
      const familyIds = new Set(assessments.map(a => a.familyId));
      const family = familyIds.size === 1 ? [...familyIds][0] : null;
      if (family) this.families.set(family, (this.families.get(family) ?? 0) + 1);
      else this.familyUnknown++;
      if (run.status === 'accepted') {
        if (!family || findings.novelty === 'unknown' || findings.usefulness === 'unknown' || findings.feasibility === 'unknown')
          this.qualificationUnknown++;
        if (family && findings.novelty === 'supported' && findings.usefulness === 'supported' &&
            findings.feasibility === 'supported' && review?.verdict === 'accept' &&
            review.judgment?.experiment.executable === true && review.controls.aOnly?.unchanged === false &&
            review.controls.bOnly?.unchanged === false && review.coverage.unknown.length === 0)
          this.qualified.add(family);
      }
    }
    if (run.routedRef) {
      this.routed++;
      if (!this.routedRefs.has(run.routedRef)) {
        this.routedRefs.add(run.routedRef);
        increment(this.routes, row.routed?.rail ?? 'unknown');
        increment(this.grades, row.routed?.humanGrade == null ? 'unknown' : String(row.routed.humanGrade));
        increment(this.outcomes, row.routed?.outcome ?? 'unknown');
      }
    }
    const linkedBatteries = new Set(dreamRunAssessments(run).flatMap(a => a.experimentBatteryIds));
    for (const id of linkedBatteries) this.linkedBatteries.add(id);
    for (const e of row.experiments) {
      if (!linkedBatteries.has(e.batteryId)) throw new Error('Experiment is not linked by a Dream assessment');
      this.experiments.set(e.batteryId, e);
    }
    this.curve.push({ runId: run.runId, at: run.startedAt, knownCallUsd: this.knownUsd,
      qualifiedFamilies: this.qualified.size, costIncomplete: this.missingUsage > 0 || this.legacy > 0 ||
        this.errors.length > 0 || this.unknownPacketUses > 0 || this.coldPacketUsd > 0 });
    if (this.curve.length > 256) this.curve.shift();
  }

  finish() {
    for (const b of [...Object.values(this.phases), ...Object.values(this.models)])
      b.actualUsd = b.unknownCalls ? null : b.knownUsd;
    const packetUsd = [...this.packets.values()].reduce((n, p) => n + (p.costUsd ?? 0), 0);
    const unknownPackets = [...this.packets.values()].filter(p => p.costUsd === null).length;
    const fullyAttributedUsd = this.missingUsage || this.legacy || this.errors.length ? null : this.knownUsd;
    const familyCounts = [...this.families.values()];
    const identified = familyCounts.reduce((a, b) => a + b, 0);
    const experiments = [...this.experiments.values()];
    const executed = experiments.filter(e => e.arms.some(a => a.scored > 0));
    const winners = executed.filter(e => !e.budgetExhausted && e.winner !== null && e.winner !== e.baselineId);
    return {
      schemaVersion: 'dream-metrics-v1' as const, scope: this.scope,
      population: { complete: true, attempts: this.attempts, legacy: this.legacy, versions: this.versions },
      configurationVersions: this.configurations,
      funnel: {
        statuses: this.statuses, terminal: this.attempts - this.statuses.running!, eligibleAttempts: this.eligible,
        proposalAttempts: this.proposals, reviewedAttempts: this.reviewed, assessedAttempts: this.assessed,
        reviewPassedAttempts: this.reviewPassed,
        reviewOutcomes: this.reviewOutcomes,
        reviewPassRate: ratio(this.reviewPassed,
          this.reviewOutcomes.accepted! + this.reviewOutcomes.rejected! + this.reviewOutcomes.duplicate! + this.reviewOutcomes.refinement!),
        dedupeSurvival: ratio(this.statuses.accepted!, this.reviewPassed),
        routedAttempts: this.routed, uniqueRoutedArtifacts: this.routedRefs.size, qualifiedFamilies: this.qualified.size,
        proposalsPerEligibleAttempt: ratio(this.proposals, this.eligible),
        qualifiedFamiliesPerEligibleAttempt: ratio(this.qualified.size, this.eligible),
        noPairRate: ratio(this.statuses['no-pair']!, this.attempts),
        errorRate: ratio(this.statuses.error!, this.attempts),
      },
      novelty: {
        scope: 'recorded-assessments' as const, identifiedFamilies: this.families.size,
        unidentifiedProposalAttempts: this.familyUnknown, qualificationUnknown: this.qualificationUnknown,
        repeatedFamilyRate: ratio(identified - this.families.size, identified),
        largestFamilyShare: ratio(familyCounts.reduce((n, v) => Math.max(n, v), 0), identified),
      },
      reuse: { ...this.reuse, noveltyCredit: 'none' as const },
      discoveryCurve: { points: this.curve, omittedEarlierPoints: Math.max(0, this.attempts - this.curve.length) },
      quality: this.quality, reviewerDisagreement: ratio(this.disagreement, this.compared),
      coverage: {
        selectedUnits: this.units.size, selectedMechanismUnits: this.mechanisms.size,
        domainPairs: this.domainPairs.size, sourceSnapshots: this.snapshots.size,
        sourcePopulationCoverage: ratio(
          [...this.populations.values()].reduce((n, p) => n + p.selected.size, 0),
          [...this.populations.values()].reduce((n, p) => n + p.eligible.size, 0),
        ),
        snapshotsWithUnknownPopulation: this.snapshots.size - this.populations.size,
        selectedPacketUses: this.packetUses, incompletePacketUses: this.incompletePackets,
        exclusions: this.exclusions, arities: this.arities, recipes: this.recipes, strategies: this.strategies,
        thirdRoles: this.thirdRoles, indexHealth: this.indexHealth,
      },
      cost: {
        knownCallUsd: this.knownUsd, unresolvedBoundUsd: this.boundUsd, unknownUsageCount: this.missingUsage,
        fullyAttributedCallUsd: fullyAttributedUsd, phases: this.phases, models: this.models,
        packetColdStartUsd: this.unknownPacketUses ? null : this.coldPacketUsd,
        packetColdStartKnownUsd: this.coldPacketUsd,
        distinctPacketHistoricalUsd: unknownPackets ? null : packetUsd,
        distinctPacketKnownUsd: packetUsd, unknownPacketUses: this.unknownPacketUses, unknownPackets,
        packetAmortizedUsdPerUse: this.packetUses && !unknownPackets ? packetUsd / this.packetUses : null,
        packetLocalDurationMs: [...this.packets.values()].reduce((n, p) => n + p.durationMs, 0),
        // Packet history is not a receipt that the build was charged in this reporting window.
        fullyAttributedDiscoveryUsd: fullyAttributedUsd !== null && packetUsd === 0 && !unknownPackets ? fullyAttributedUsd : null,
        reconciliationErrors: this.errors,
      },
      leading: {
        qualifiedFamiliesPerUsd: fullyAttributedUsd !== null && fullyAttributedUsd > 0 && packetUsd === 0 && !unknownPackets &&
          this.qualificationUnknown === 0 ? this.qualified.size / fullyAttributedUsd : null,
      },
      downstream: { routes: this.routes, grades: this.grades, outcomes: this.outcomes },
      experiments: {
        linked: experiments.length, executed: executed.length, winning: winners.length,
        declaredLinks: this.linkedBatteries.size, missingResults: this.linkedBatteries.size - experiments.length,
        recordedCostUsd: experiments.reduce((n, e) => n + e.totalCostUsd, 0),
        engineeringTimeMs: null, // The existing experiment ledger does not record engineer time.
        decisions: experiments.reduce<Record<string, number>>((acc, e) => { increment(acc, e.decision); return acc; }, {}),
      },
    };
  }
}
export type DreamMetrics = ReturnType<DreamMetricsFold['finish']>;

export function computeDreamMetrics(rows: readonly DreamMetricRow[], scope: DreamMetricsScope): DreamMetrics {
  // Input may contain repeated delivery or an earlier running snapshot of a terminal row.
  const latest = new Map<string, DreamMetricRow>();
  for (const row of rows) {
    if (row.run.workspaceId !== scope.workspaceId || row.run.potSlug !== scope.potSlug)
      throw new Error('Dream metrics row crosses workspace or pot');
    const previous = latest.get(row.run.runId);
    if (!previous || row.run.updatedAt > previous.run.updatedAt) latest.set(row.run.runId, row);
  }
  const fold = new DreamMetricsFold(scope);
  for (const row of [...latest.values()].sort((a, b) =>
    a.run.startedAt.localeCompare(b.run.startedAt) || a.run.runId.localeCompare(b.run.runId))) fold.add(row);
  return fold.finish();
}

/** One snapshot and one cursor; joins are scoped and cannot multiply attempts or paid calls. */
export async function readDreamMetrics(sql: Sql, scope: DreamMetricsScope): Promise<DreamMetrics> {
  const fold = new DreamMetricsFold(scope);
  const query = sql`
    SELECT r.*, routed.value AS metric_routed, experiments.value AS metric_experiments
    FROM harness_shared.dream_runs r
    LEFT JOIN LATERAL (
      SELECT jsonb_build_object('rail', s.rail, 'humanGrade', s.human_grade, 'outcome', s.outcome) AS value
      FROM harness_shared.scout_routed_ideas s
      WHERE s.workspace_id = r.workspace_id AND s.harness_slug = r.pot_slug
        AND s.origin = 'dream' AND s.idea_id = 'dream:' || r.run_id AND s.routed_ref = r.routed_ref
      LIMIT 1
    ) routed ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('batteryId', e.battery_id, 'testId', e.test_id, 'tier', e.tier,
        'baselineId', e.baseline_id, 'winner', e.winner, 'arms', e.arms, 'totalCostUsd', e.total_cost_usd,
        'budgetExhausted', e.budget_exhausted, 'decision', e.decision, 'createdAt', e.created_at)) AS value
      FROM harness_shared.experiment_runs e
      WHERE e.workspace_id = r.workspace_id AND e.battery_id IN (
        SELECT jsonb_array_elements_text(a->'experimentBatteryIds')
        FROM jsonb_array_elements(COALESCE(r.outcome->'assessments', '[]'::jsonb)) a
      )
    ) experiments ON true
    WHERE r.workspace_id = ${scope.workspaceId} AND r.pot_slug = ${scope.potSlug}
      AND r.started_at >= ${scope.since}::timestamptz AND r.started_at < ${scope.until}::timestamptz
    ORDER BY r.started_at, r.run_id`;
  for await (const rows of query.cursor(100)) {
    for (const row of rows) fold.add({
      run: mapDreamRun(row), routed: row.metric_routed ?? null, experiments: row.metric_experiments ?? [],
    });
  }
  return fold.finish();
}
