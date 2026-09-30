/**
 * Continuous autonomous loop driver (P-022).
 *
 * One cycle: select parent from the frontier → reflect & propose (prompts-only) →
 * evaluate the candidate → gate (accept iff all gates hold) → on accept update the
 * frontier + champion and promote the champion's overrides into the dedicated gym
 * harness (D-012) → append the changelog → check the arithmetic circuit-breaker
 * (auto-revert on drift) → repeat until budget / maxCycles / breaker. Unattended.
 *
 * All effects are injected, so the orchestration is unit-tested without a real
 * pipeline, real agents, or PG. The bounded budget is the unattended-spend guard
 * (D-019): the loop never exceeds `budgetUsd`.
 */
import { createHash } from 'node:crypto';
import { paretoFrontier } from './frontier';
import { decideAccept, selectParent, type AcceptThresholds, type VariantEval } from './gate-engine';
import type { GateResult, GateStatus } from './gates';
import { selectParentQD } from './qd-selection';
import { appendChangelog } from './changelog';
import { circuitBreakerTripped } from './circuit-breaker';
import { runWithRatePause } from './rate-pause';
import type { VariantOverlay } from './variant-overlay';
import { costUsdOf } from './proposer';
import type { CandidateProposal, WorstTrace } from './proposer';
import type { ArchiveCandidateRecord } from './qd/niche';

export interface LoopConfig {
  thresholds: AcceptThresholds;
  baselineMeanCost: number;
  /** Dev-anchor baseline-of-record for the circuit-breaker. */
  baselineOfRecord: number;
  dropThreshold: number;
  maxCycles: number;
  /** Hard unattended-spend cap (D-019); null ⇒ rely on maxCycles only. */
  budgetUsd: number | null;
  proposerModel: string;
  /**
   * Write a new champion's overrides into the gym harness automatically (default).
   * Set false for the HUMAN-GATED product (gym UI): the loop still proposes +
   * evaluates + scores + records proposals for review, but the human promotes via
   * gym:accept. Internal champion/frontier tracking still advances (for exploration).
   */
  autoPromote?: boolean;
  /**
   * Quality-diversity parent selection (P-011, D-008). When set, the loop blends
   * distance-from-archive novelty into parent selection (requires
   * deps.noveltyForVariant); absent ⇒ pure fitness-headroom selection
   * (unchanged). noveltyWeight ∈ [0,1]: 0 ≡ the legacy selectParent, 1 ⇒ pure
   * novelty search.
   */
  qualityDiversity?: { noveltyWeight: number };
  /** Hashes pinned to the candidate-version verdict (P-002). */
  provenance?: {
    evaluatorHash: string;
    rubricHash: string;
    taskHash: string;
    codeHash: string;
  };
}

export interface CandidateVersionVerdict {
  schemaVersion: 1;
  candidateId: string;
  parentId: string;
  /** Complete candidate and parent overlays, captured before promotion. */
  variant: VariantOverlay;
  parent: VariantOverlay;
  hashes: {
    variantHash: string;
    parentHash: string;
    evaluatorHash: string;
    rubricHash: string;
    taskHash: string;
    codeHash: string;
  };
  gateResults: readonly GateResult[];
  verdict: 'accept' | 'reject' | 'inconclusive';
  recordedAt: number;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

/**
 * The candidate-version verdict implied by a gate set (P-003).
 *
 * Three-state, and the ORDER of the tests is the contract: a gate that actually
 * FAILED rejects even when a sibling gate went unmeasured (a measured failure is
 * decisive), while any remaining gap — including the empty set — is inconclusive
 * rather than an accept. The rule this closes: an un-collected deterministic
 * guardrail used to be indistinguishable from a satisfied one, so a candidate
 * could be promoted on evidence nobody ever gathered.
 *
 * A gate persisted before P-003 carries no `status`; its boolean `pass` is the only
 * thing recorded, so it is read as pass/fail. That is exactly right — those rows
 * were written by a pipeline that could not represent a gap in the first place.
 */
export function candidateVerdictFromGates(
  gateResults: readonly GateResult[],
): CandidateVersionVerdict['verdict'] {
  if (gateResults.length === 0) return 'inconclusive';
  // Cast, not optional chaining on a required field: rows read back from
  // gym_proposals.candidate_verdict are JSON.parse'd and cast, so a pre-P-003 row
  // really can arrive without `status` however the type reads.
  const statuses = gateResults.map(
    (g) => (g as { status?: GateStatus }).status ?? (g.pass ? 'pass' : 'fail'),
  );
  if (statuses.some((s) => s === 'fail')) return 'reject';
  if (statuses.some((s) => s === 'not-measured')) return 'inconclusive';
  return 'accept';
}

/** Build the immutable, hash-pinned verdict persisted with each changed-role proposal. */
export function createCandidateVersionVerdict(input: {
  candidateId: string;
  parentId: string;
  variant: VariantOverlay;
  parent: VariantOverlay;
  gateResults: readonly GateResult[];
  recordedAt: number;
  provenance?: LoopConfig['provenance'];
}): CandidateVersionVerdict {
  return {
    schemaVersion: 1,
    candidateId: input.candidateId,
    parentId: input.parentId,
    variant: input.variant,
    parent: input.parent,
    hashes: {
      variantHash: sha256(input.variant),
      parentHash: sha256(input.parent),
      // The gate engine is declarative and versioned by this contract. Callers pin
      // the remaining subject-specific hashes when wiring the live loop.
      evaluatorHash: input.provenance?.evaluatorHash ?? 'unresolved',
      rubricHash: input.provenance?.rubricHash ?? 'unresolved',
      taskHash: input.provenance?.taskHash ?? 'unresolved',
      codeHash: input.provenance?.codeHash ?? 'unresolved',
    },
    gateResults: input.gateResults,
    verdict: candidateVerdictFromGates(input.gateResults),
    recordedAt: input.recordedAt,
  };
}

/** One candidate's reviewable record, handed to deps.recordProposal (gym UI). */
export interface LoopProposalRecord {
  cycle: number;
  candidateId: string;
  parentId: string;
  /** The candidate's merged overlay (parent ⊕ proposed changes). */
  overlay: VariantOverlay;
  /** The parent's overlay (to diff against → which roles actually changed). */
  parentOverlay: VariantOverlay;
  rationale: string;
  /** Candidate dev-anchor minus the parent's (did this change help?). */
  devAnchorDelta: number;
  costDelta: number;
  /** The probe guardrail's three-state status ('pass' | 'fail' | 'not-measured'). */
  probeStatus: GateStatus;
  /**
   * The loop's own gate verdict — advisory for the human reviewer. `inconclusive`
   * means a guardrail went unmeasured, which is NOT a rejection of the candidate.
   */
  verdict: 'accept' | 'reject' | 'inconclusive';
  /** Immutable candidate-version evidence used by the promotion authority. */
  candidateVersion: CandidateVersionVerdict;
}

export interface EvaluateResult {
  evalResult: VariantEval;
  worstTraces: WorstTrace[];
  costUsd: number;
}

export interface LoopDeps {
  baseline: { variantId: string; overlay: VariantOverlay };
  evaluate(variantId: string, overlay: VariantOverlay): Promise<EvaluateResult>;
  propose(parentOverlay: VariantOverlay, worstTraces: WorstTrace[], changelog: string): Promise<CandidateProposal>;
  /** Promote the champion overrides into the dedicated gym harness (P-020/D-012). */
  promote(overlay: VariantOverlay): Promise<void>;
  /** Auto-revert the harness overrides to last-known-good (circuit-breaker). */
  revert(): Promise<void>;
  persistCycle(rec: {
    cycle: number;
    parentId: string;
    candidateId: string;
    decision: 'accept' | 'reject';
    gateResults: unknown;
  }): Promise<void>;
  /**
   * Record a candidate as a reviewable proposal (gym UI). Optional: when absent the
   * loop runs purely autonomously (unchanged). The live wiring maps the candidate's
   * changed-role prompts into harness_shared.gym_proposals for human review.
   */
  recordProposal?(rec: LoopProposalRecord): Promise<void>;
  newVariantId(cycle: number): string;
  /** RB-006: injected clock + sleep for the rate-limit pause+resume (default real time). */
  now?(): number;
  sleep?(ms: number): Promise<void>;
  /**
   * Quality-diversity novelty signal (P-011): distance-from-archive in [0,1] for
   * a frontier member, sourced from the P-010 ArchiveAPI (`sparseness(descriptor)`).
   * Optional — absent ⇒ fitness-only selection. Only consulted when
   * `config.qualityDiversity` is set.
   */
  noveltyForVariant?(variantId: string): Promise<number>;
  /**
   * Record an evaluated variant into the QD novelty/diversity archive (P-010, D-008).
   * Called for the baseline and each evaluated candidate. Optional — absent ⇒ no archive
   * (existing behavior unchanged). The live wiring derives the niche descriptor from the
   * overlay pair and upserts a `source:'gym'` elite into harness_shared.gym_qd_archive.
   * BEST-EFFORT: the loop swallows any failure so the archive can never abort the optimizer.
   */
  recordArchive?(rec: ArchiveCandidateRecord): Promise<void>;
  /**
   * F1-4/P-014: publish an ACCEPTED candidate's niche elite to the hive substrate (stamp
   * gym_qd_archive.federatable so the CDC trigger federates it — the live SEND path elites
   * were missing, parity with how shareable facts federate via assertFact). Called ONLY on a
   * gate accept (verdict.accept ⇒ outcome=won ⇒ D-002 federation-eligible). Optional — absent
   * ⇒ no federation (existing behavior unchanged). BEST-EFFORT: the loop swallows any failure
   * (incl. markEliteFederatable's WI-1564 non-federating-workspace refuse) so federation can
   * never abort the optimizer. The live wiring maps this to markEliteFederatable (no-signer
   * tier-1; the device-signed outcome record is a follow-up).
   */
  federateAcceptedElite?(
    variantId: string,
    eligibility: { outcome?: string | null; grade?: number | null },
  ): Promise<void>;
}

export interface LoopResult {
  cycles: number;
  accepts: number;
  championId: string;
  spentUsd: number;
  breakerTripped: boolean;
  /** RB-006: cycles skipped because their propose/evaluate failed (rate-limit past the pause,
      or another error) — recorded instead of crashing the loop. */
  skipped: number;
  /** WI-5674: the concrete reason each skipped cycle failed (propose/evaluate threw). Empty
      when nothing skipped. Surfaced so a silent skip (no candidate → no proposal → curator
      never runs) is diagnosable from the run report instead of a swallowed error. */
  skipReasons: string[];
}

interface Tracked {
  evalResult: VariantEval;
  overlay: VariantOverlay;
  worstTraces: WorstTrace[];
}

export async function runOptimizationLoop(config: LoopConfig, deps: LoopDeps): Promise<LoopResult> {
  const variants = new Map<string, Tracked>();
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // RB-006: a rate-limited turn pauses+resumes (near reset) rather than aborting the loop.
  let skipped = 0;
  // WI-5674: capture WHY each cycle skipped (propose/evaluate threw) so the silent-skip failure
  // mode is diagnosable from the report instead of vanishing into a bare catch.
  const skipReasons: string[] = [];

  // P-010 (D-008): feed each evaluated variant to the QD novelty/diversity archive. The
  // archive is auxiliary — a failure here must never abort the optimizer, so it's swallowed.
  const recordArchive = async (rec: ArchiveCandidateRecord): Promise<void> => {
    try {
      await deps.recordArchive?.(rec);
    } catch {
      /* best-effort: the QD archive never gates the loop */
    }
  };

  // Seed: evaluate the baseline. A transient rate-limit is waited out; a persistent failure
  // here genuinely can't start the loop, so it propagates to the (unattended) caller.
  const base = await runWithRatePause(() => deps.evaluate(deps.baseline.variantId, deps.baseline.overlay), { now, sleep });
  let spentUsd = base.costUsd;
  variants.set(deps.baseline.variantId, {
    evalResult: base.evalResult,
    overlay: deps.baseline.overlay,
    worstTraces: base.worstTraces,
  });
  // Seed the archive with the baseline (its niche is the origin point of the search).
  await recordArchive({
    variantId: deps.baseline.variantId,
    overlay: deps.baseline.overlay,
    fitness: base.evalResult.trainAgg,
  });
  let frontierIds = [deps.baseline.variantId];
  let championId = deps.baseline.variantId;
  let changelog = '';
  let accepts = 0;
  let breakerTripped = false;
  let cycles = 0;

  for (let cycle = 1; cycle <= config.maxCycles; cycle++) {
    if (config.budgetUsd !== null && spentUsd >= config.budgetUsd) break;
    cycles = cycle;

    // Select parent from the frontier. Default: most fitness headroom (selectParent).
    // Quality-diversity (P-011, D-008): when configured AND a novelty signal is
    // injected, blend distance-from-archive (novelty search) into the pick so the
    // search leaps toward under-explored niches instead of pure hill-climbing.
    const frontierEvals = frontierIds.map((id) => ({ variantId: id, trainAgg: variants.get(id)!.evalResult.trainAgg }));
    const qd = config.qualityDiversity;
    const noveltyForVariant = deps.noveltyForVariant;
    const parentPick =
      qd && noveltyForVariant
        ? selectParentQD(
            await Promise.all(frontierEvals.map(async (e) => ({ ...e, novelty: await noveltyForVariant(e.variantId) }))),
            { noveltyWeight: qd.noveltyWeight },
          )
        : selectParent(frontierEvals);
    const parentId = parentPick?.variantId ?? championId;
    const parent = variants.get(parentId)!;

    // Reflect & propose, then evaluate the candidate. Wrapped so a rate-limited (or otherwise
    // failed) turn never aborts the whole loop: a near reset is paused+resumed; a far-off
    // reset / other failure SKIPS this cycle, preserving the champion + frontier + accepts
    // accrued so far (RB-006). propose + evaluate are wrapped separately so a rate-limited
    // evaluate doesn't re-propose (which would mint a second candidate id).
    let proposal: CandidateProposal;
    let candidateId: string;
    let evalRes: EvaluateResult;
    try {
      proposal = await runWithRatePause(() => deps.propose(parent.overlay, parent.worstTraces, changelog), { now, sleep });
      // Charge the proposer as soon as its response arrives. This must happen
      // before evaluation so a later failure cannot erase the proposer spend.
      spentUsd += costUsdOf(proposal.costUsd);
      candidateId = deps.newVariantId(cycle);
      evalRes = await runWithRatePause(() => deps.evaluate(candidateId, proposal.overlay), { now, sleep });
      spentUsd += costUsdOf(evalRes.costUsd);
    } catch (err) {
      // Rate-limited past the bounded pause, or a non-rate failure → skip this cycle and
      // continue (the loop's progress is preserved). WI-5674: a silently-swallowed skip
      // means no candidate → no proposal → the curator never runs → nothing new in /gym,
      // so RECORD the concrete reason instead of discarding it. The caller surfaces
      // skipReasons via its own logger + the run report (the loop stays effect-injected —
      // it never writes to console itself). This is a diagnosis surface, not a control-flow
      // change: the loop still preserves its champion/frontier/accepts and continues.
      // A thrown attempt may have burned provider tokens, or an evaluator may
      // attach the cost of work completed before its failure. Count it even
      // though no candidate record can be produced for this cycle.
      spentUsd += costUsdOf(err);
      const reason = err instanceof Error ? (err.stack ?? err.message) : String(err);
      skipReasons.push(`cycle ${cycle}: ${reason}`);
      skipped++;
      continue;
    }
    variants.set(candidateId, { evalResult: evalRes.evalResult, overlay: proposal.overlay, worstTraces: evalRes.worstTraces });
    // P-010: offer the evaluated candidate to the QD archive (insert-if-better per niche).
    await recordArchive({
      variantId: candidateId,
      overlay: proposal.overlay,
      parentOverlay: parent.overlay,
      fitness: evalRes.evalResult.trainAgg,
      rationale: proposal.rationale,
    });

    const champion = variants.get(championId)!;
    const verdict = decideAccept(
      evalRes.evalResult,
      parent.evalResult,
      champion.evalResult,
      config.baselineMeanCost,
      config.thresholds,
    );

    const championDevBefore = champion.evalResult.devAnchorAgg;

    // Surface the candidate for human review (gym UI), advisory verdict included.
    if (deps.recordProposal) {
      await deps.recordProposal({
        cycle,
        candidateId,
        parentId,
        overlay: proposal.overlay,
        parentOverlay: parent.overlay,
        rationale: proposal.rationale,
        devAnchorDelta: evalRes.evalResult.devAnchorAgg - parent.evalResult.devAnchorAgg,
        costDelta: evalRes.evalResult.meanCost - config.baselineMeanCost,
        probeStatus: evalRes.evalResult.probeEvidence.status,
        verdict: verdict.outcome,
        candidateVersion: createCandidateVersionVerdict({
          candidateId,
          parentId,
          variant: proposal.overlay,
          parent: parent.overlay,
          gateResults: verdict.results,
          recordedAt: now(),
          provenance: config.provenance,
        }),
      });
    }

    if (verdict.accept) {
      accepts++;
      // F1-4/P-014: an accepted candidate cleared all gates (outcome=won ⇒ D-002 eligible) →
      // publish its niche's best elite to the hive. BEST-EFFORT: markEliteFederatable's
      // WI-1564 strand-guard THROWS under a non-federating workspace, and federation must
      // never abort the optimizer, so any failure here is swallowed (surfacing is a substrate
      // concern, not the loop's).
      if (deps.federateAcceptedElite) {
        try {
          await deps.federateAcceptedElite(candidateId, { outcome: 'won' });
        } catch {
          // best-effort — federation refusal/strand-guard never aborts the loop
        }
      }
      // Update frontier (Pareto prune) over the candidate set.
      const candidatesForFrontier = [...frontierIds, candidateId].map((id) => ({
        id,
        vector: variants.get(id)!.evalResult.trainVector,
      }));
      frontierIds = paretoFrontier(candidatesForFrontier).map((c) => c.id);
      // Champion = best dev-anchor; promote on a new champion. Internal champion
      // tracking always advances (drives parent selection); the EXTERNAL harness
      // write is skipped in human-gated mode (the human promotes via gym:accept).
      if (evalRes.evalResult.devAnchorAgg > champion.evalResult.devAnchorAgg) {
        championId = candidateId;
        if (config.autoPromote !== false) await deps.promote(proposal.overlay);
      }
      changelog = appendChangelog(changelog, {
        cycle,
        decision: 'accept',
        devAnchorDelta: variants.get(championId)!.evalResult.devAnchorAgg - championDevBefore,
        costDelta: evalRes.evalResult.meanCost - config.baselineMeanCost,
        // The changelog line is a human narrative, so it collapses to a boolean —
        // only a measured PASS reads as "caught"; a gap reads like a miss, which is
        // the conservative direction for a summary a person skims.
        probeCaught: evalRes.evalResult.probeEvidence.status === 'pass',
        narrative: proposal.rationale,
      });
    } else {
      changelog = appendChangelog(changelog, {
        cycle,
        decision: 'reject',
        devAnchorDelta: evalRes.evalResult.devAnchorAgg - championDevBefore,
        costDelta: evalRes.evalResult.meanCost - config.baselineMeanCost,
        // The changelog line is a human narrative, so it collapses to a boolean —
        // only a measured PASS reads as "caught"; a gap reads like a miss, which is
        // the conservative direction for a summary a person skims.
        probeCaught: evalRes.evalResult.probeEvidence.status === 'pass',
        narrative: proposal.rationale,
      });
    }

    await deps.persistCycle({
      cycle,
      parentId,
      candidateId,
      decision: verdict.accept ? 'accept' : 'reject',
      gateResults: verdict.results,
    });

    // Circuit-breaker: the real safety net (D-006/D-012).
    if (circuitBreakerTripped(variants.get(championId)!.evalResult.devAnchorAgg, config.baselineOfRecord, config.dropThreshold)) {
      await deps.revert();
      breakerTripped = true;
      break;
    }
  }

  return { cycles, accepts, championId, spentUsd, breakerTripped, skipped, skipReasons };
}
