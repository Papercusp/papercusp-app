/**
 * Real `LoopDeps` builder for the autonomous optimization loop (P-022 / D-020 runner service).
 *
 * `runOptimizationLoop` (loop.ts) is pure orchestration over injected effects; this binds those
 * effects to the SAME smoke-proven per-run engine the A/B uses (`buildAbDeps`), then layers the
 * loop-specific aggregation on top:
 *   evaluate(variantId, overlay) → run the variant over the task pools (train + dev-anchor + probe),
 *     collect + distill + judge each run, and roll the per-run composites up into a `VariantEval`
 *     (trainAgg/trainVector drive the frontier; devAnchorAgg gates; regressions/probe are the
 *     un-gameable signals) + the worst train traces (the proposer's reflection signal).
 *   propose(...) → the real reflective proposer (proposer.ts), prompts-only (D-015).
 *   promote/revert → optional gym-harness override writes (no-op in the human-gated product, D-020).
 *   persistCycle → gym_cycles (store.ts).
 *   recordProposal → the live control-plane recorder (makeLoopProposalRecorder), so each scored
 *     candidate surfaces in the gym UI's diff-review for human accept/reject.
 *
 * Everything is injected, so the aggregation + sequencing are unit-tested with fakes (zero LLM,
 * no operator, no real PG); `gym-loop-run.ts` passes the real adapters.
 */
import type { Sql } from 'postgres';
import { randomBytes } from 'node:crypto';
import { buildAbDeps } from './ab-runner-real';
import { judgeGymRun, type JudgeLlmCall } from './judge';
import { costUsdOf, proposeCandidate, throwWithCostUsd, type WorstTrace } from './proposer';
import { insertCycle } from './store';
import { runWithRatePause } from './rate-pause';
import { ratePauseEventHooks } from './rate-pause-events';
import { GYM_JUDGE_RUBRIC_V1, rubricHash, type GymJudgeRubric } from './judge-scoring';
import type { GymRunnerPorts } from './gym-runner';
import type { LoopDeps, EvaluateResult, LoopProposalRecord } from './loop';
import type { ArchiveCandidateRecord } from './qd/niche';
import type { VariantOverlay } from './variant-overlay';
import type { VariantEval } from './gate-engine';
import { rollUpEvidenceStatus, type DeterministicEvidence, type GateStatus } from './gates';
import type { GymLlmCall, GymTaskPool } from './task-generator';
import type { AbTask, AbDeps } from './ab-runner';

/**
 * Roll per-task deterministic signals into one gate's evidence (P-003).
 *
 * The coverage counts are what make the status auditable rather than asserted: a
 * reader can see how many tasks owed the signal, how many reported it, and exactly
 * which ones did not. An EMPTY contributor list yields `required: 0` and a
 * `not-measured` status — the case that used to be reported as a satisfied gate.
 */
function buildEvidence(
  contributions: readonly { taskId: string; status: GateStatus; traceRefs: readonly string[] }[],
): DeterministicEvidence {
  const unmeasuredTaskIds = contributions.filter((c) => c.status === 'not-measured').map((c) => c.taskId);
  return {
    status: rollUpEvidenceStatus(contributions.map((c) => c.status)),
    coverage: {
      measured: contributions.length - unmeasuredTaskIds.length,
      required: contributions.length,
      unmeasuredTaskIds,
    },
    artifacts: contributions.flatMap((c) => c.traceRefs),
  };
}

/** A task the loop evaluates, tagged with the pool that decides how its composite is rolled up. */
export interface LoopTask extends Omit<AbTask, 'pool'> {
  pool: GymTaskPool;
}

export interface BuildLoopDepsConfig {
  /** A postgres-js client connected to the gym PG (execution data: runs/scores/variants/cycles). */
  gymSql: Sql;
  /** Real runner ports (clone/register/overlay/file/start/poll) — createGymRunnerPorts(...). */
  ports: GymRunnerPorts;
  /** The frozen Opus judge llm call (real anthropic-direct/claude-code call, or a fake in tests). */
  judgeCall: JudgeLlmCall;
  /** The proposer llm call (decorrelated from the judge model per D-015). */
  proposerCall: GymLlmCall;
  /** Proposer model id (should differ from the judge's). */
  proposerModel: string;
  /** The task pools the loop evaluates each variant over (train + dev-anchor [+ probe]). */
  tasks: LoopTask[];
  /** The frozen judge rubric (defaults to GYM_JUDGE_RUBRIC_V1). */
  rubric?: GymJudgeRubric;
  baseline: { variantId: string; overlay: VariantOverlay };
  harnessCommit: string;
  workspaceId: string;
  scratchRoot: string;
  /** Retained trace storage, outside every directory the host tears down. */
  traceRoot?: string;
  timeoutMs: number;
  pollIntervalMs: number;
  maxDistillChars: number;
  /** How many worst train traces to feed the proposer (default 3). */
  worstK?: number;
  /**
   * P-032: triage-routed gym ideas (pre-formatted lines) handed to the proposer as
   * optional candidate directions every cycle. Empty/absent ⇒ unchanged proposer prompt.
   */
  candidateDirections?: string[];
  /**
   * P-030 (consume-edges B-09): recent champions' measured post-acceptance outcome
   * lines (gatherChampionOutcomeEntries) — primes the proposer with what its past
   * accepted changes did to LIVE runs. Empty/absent ⇒ unchanged proposer prompt.
   */
  championOutcomes?: string[];
  /**
   * P-025: repeats per (variant × task) — the per-task composite is the MEAN over repeats,
   * to average out the judge's per-run noise. Default 1; P-014 measured sd≤0.5 → minRepeats≈4,
   * so the loop driver should set this ≥4 for accept decisions to be trustworthy.
   */
  repeats?: number;
  /** Override the per-run engine (defaults to buildAbDeps); injected in unit tests. */
  abDeps?: AbDeps;
  /** Promote a champion's overrides into the gym harness (P-020). Omit ⇒ human-gated (D-020). */
  promote?: (overlay: VariantOverlay) => Promise<void>;
  /** Auto-revert the harness overrides (circuit-breaker). Omit ⇒ no external write to undo. */
  revert?: () => Promise<void>;
  /** Live control-plane recorder (makeLoopProposalRecorder) — surfaces candidates for review. */
  recordProposal?: (rec: LoopProposalRecord) => Promise<void>;
  /** Live QD-archive recorder (makeLoopArchiveRecorder) — feeds each variant to the MAP-Elites archive (P-010). */
  recordArchive?: (rec: ArchiveCandidateRecord) => Promise<void>;
  /** Live elite publisher (F1-4/P-014, makeLoopQdSeams.federateAcceptedElite) — stamps an
   *  accepted candidate's niche elite federatable so it rides the peer-log to the hive. */
  federateAcceptedElite?: (
    variantId: string,
    eligibility: { outcome?: string | null; grade?: number | null },
  ) => Promise<void>;
  /**
   * Live QD novelty signal (P-011): a frontier member's distance-from-archive. Pair with
   * `config.qualityDiversity` to bias parent selection toward sparse niches (novelty search).
   * Build both this and `recordArchive` from one `makeLoopQdSeams(...)` so they share an archive.
   */
  noveltyForVariant?: (variantId: string) => Promise<number>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * WI-5697: a token unique to THIS run, folded into candidate ids
   * (`cand-<runId>-c<cycle>`). `newVariantId` must stay DETERMINISTIC per cycle
   * WITHIN a run (a rate-limited retry must reuse the same id — RB-006's
   * intra-run idempotency, see loop.ts), but a bare `cand-c${cycle}` is also
   * deterministic ACROSS every run of the same harness (autoloop cycles almost
   * always run maxCycles=1, so it was ALWAYS "cand-c1"). Once that id's
   * proposal rows were decided by an earlier run, `recordProposal`'s
   * idempotent upsert (control-plane.ts `recordProposal`'s
   * `WHERE gym_proposals.status = 'pending'`) silently no-ops on every later
   * run — no error, no new row, forever — which is exactly the "gym cycles no
   * longer mint gym_proposals rows" bug. Default: a fresh random token per
   * `buildLoopDeps` call, so callers get the fix for free even without
   * threading their own per-run id.
   */
  runId?: string;
}

export function buildLoopDeps(cfg: BuildLoopDepsConfig): LoopDeps {
  const rubric = cfg.rubric ?? GYM_JUDGE_RUBRIC_V1;
  const now = cfg.now ?? (() => Date.now());
  const sleep = cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const worstK = cfg.worstK ?? 3;
  const repeats = Math.max(1, cfg.repeats ?? 1);
  // WI-5697: unique-per-run token — see BuildLoopDepsConfig.runId's doc for why this must
  // never collapse to a bare per-cycle id across runs.
  const runId = cfg.runId ?? randomBytes(4).toString('hex');

  // Reuse the smoke-proven per-run engine (runPipeline + collectAndDistill + gym-PG store).
  const ab =
    cfg.abDeps ??
    buildAbDeps({
      gymSql: cfg.gymSql,
      ports: cfg.ports,
      llmCall: cfg.judgeCall,
      timeoutMs: cfg.timeoutMs,
      pollIntervalMs: cfg.pollIntervalMs,
      scratchRoot: cfg.scratchRoot,
      traceRoot: cfg.traceRoot,
    });

  // Cycle metadata for gym_runs (the baseline is evaluated first → cycle 0).
  let evalSeq = 0;

  async function evaluate(variantId: string, overlay: VariantOverlay): Promise<EvaluateResult> {
    let incurredCostUsd = 0;
    try {
      const cycle = evalSeq++;
      const variant = { variantId, label: variantId, overlay };
      await ab.store.upsertVariant(variant);
      const runIds: string[] = [];

      const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

      /** One per (task), aggregated over `repeats` runs (P-025: average out judge noise). */
      interface PerTask {
        taskId: string;
        pool: GymTaskPool;
        composite: number; // mean over repeats
        rationale: string; // the worst repeat's rationale (most informative for the proposer)
        distilled: string; // the worst repeat's distilled trace
        cost: number; // SUM over repeats
        /**
         * P-003 — three-state, per task. `not-measured` means at least one repeat's
         * deterministic signals did not CONTAIN the key at all, which a boolean could
         * not distinguish from a reported `false`.
         */
        regressionStatus: GateStatus;
        /** Probe pool only; `null` for a task that owes no probe signal. */
        probeStatus: GateStatus | null;
        /**
         * How many of this task's repeats actually produced a judge composite. P-002:
         * `composite` above is a MEAN, and `mean([])` is 0 — indistinguishable from a
         * genuine zero score. The count is what lets the real-anchor gate tell "scored
         * badly" (a regression) apart from "never scored" (nothing to compare).
         */
        scoredRepeats: number;
        /** Trace refs for this task's runs — the artifact references the verdict cites. */
        traceRefs: string[];
      }
      const perTask: PerTask[] = [];

      for (const task of cfg.tasks) {
        await ab.store.upsertTask({ ...task, pool: task.pool });
        const composites: number[] = [];
        let cost = 0;
        const traceRefs: string[] = [];
        // Three accumulators per signal, because "did any repeat regress" and "did every
        // repeat actually report" are different questions and only the pair of them can
        // tell a clean run apart from an uninstrumented one.
        let regressionSeen = false;
        let regressionReportedEveryRepeat = true;
        let probeMissed = false;
        let probeReportedEveryRepeat = true;
        let worst: { composite: number; rationale: string; distilled: string } | null = null;

        for (let repeat = 0; repeat < repeats; repeat++) {
          // The baseline variant is reused across independent loop runs. Its
          // durable run key must carry the existing loop token, just as candidate
          // and cycle keys do, so a later run cannot replace earlier evidence.
          const evaluationRunId = `${runId}::${variantId}::${task.taskId}::c${cycle}::r${repeat}`;
          const handle = await ab.runPipeline({
            variant,
            task: { ...task, pool: task.pool },
            repeat,
            cycle,
            harnessCommit: cfg.harnessCommit,
            workspaceId: cfg.workspaceId,
            scratchRoot: cfg.scratchRoot,
          });
          // Retain the known subtotal before any later stage can throw. This is
          // local accounting, not a governor reservation or settlement.
          const pipelineCostUsd = costUsdOf(handle.pipelineUsd);
          incurredCostUsd += pipelineCostUsd;
          if (handle.pipelineSpend?.complete === false) {
            throw Object.assign(new Error('Gym pipeline usage evidence is incomplete'), {
              costUsdMeasurementMissing: true, pipelineSpend: handle.pipelineSpend,
            });
          }
          await ab.store.startRun({
            runId: evaluationRunId,
            variantId,
            taskId: task.taskId,
            cycle,
            repeat,
            harnessSlug: handle.harnessSlug,
            workflowId: handle.workflowID,
            params: {
              harnessCommit: cfg.harnessCommit,
              substrateCommit: task.repoCommit,
              judgeModel: rubric.model,
              judgeTemp: rubric.temperature,
              weights: rubric.weights,
              rubricHash: rubricHash(rubric),
            },
          });
          runIds.push(evaluationRunId);
          const { distilledTrace, traceRef, rawSignals } = await ab.collectAndDistill({
            handle,
            task: { ...task, pool: task.pool },
            maxChars: cfg.maxDistillChars,
          });
          await ab.store.finishRun(evaluationRunId, { terminalState: handle.outcome, deterministicSignals: rawSignals, traceRef });
          const score = await runWithRatePause(
            () =>
              judgeGymRun(
                { intent: task.intent, projectContext: task.projectContext, distilledTrace, rubric },
                { llmCall: cfg.judgeCall },
              ),
            // P-010 (await-event): pauses emit rate-limit:paused/reset:gym-judge —
            // awaitable + on the wake meter instead of an invisible in-process sleep.
            { now, sleep, ...ratePauseEventHooks('gym-judge') },
          );
          // The judge response is billed even if recording the score fails.
          const judgeCostUsd = costUsdOf(score.costUsd);
          incurredCostUsd += judgeCostUsd;
          if (score.costUsdMeasurementMissing || score.unreportedFrames) {
            // The successful score still carries only a usage subtotal. Stop
            // before another task spends and let the attempt remain OPEN.
            // Its subtotal is already in incurredCostUsd; do not charge twice.
            throw Object.assign(new Error('Gym judge usage evidence is incomplete'), {
              costUsd: 0, costUsdMeasurementMissing: true,
              ...(score.unreportedFrames ? { unreportedFrames: score.unreportedFrames } : {}),
            });
          }
          await ab.store.recordScore(evaluationRunId, score);
          const sig = (rawSignals ?? {}) as Record<string, unknown>;
          composites.push(score.composite);
          cost += pipelineCostUsd + judgeCostUsd;
          if (typeof traceRef === 'string' && traceRef.length > 0) traceRefs.push(traceRef);
          // PRESENCE first, value second. `sig.regressions` being falsy is ambiguous —
          // it is equally "the run reported no regressions" and "the run never reported".
          // Only `in` separates them, and that separation is the whole point of P-003.
          if ('regressions' in sig) {
            if (sig.regressions) regressionSeen = true;
          } else {
            regressionReportedEveryRepeat = false;
          }
          if (task.pool === 'probe') {
            if ('planted_bug_caught' in sig) {
              if (!sig.planted_bug_caught) probeMissed = true;
            } else {
              probeReportedEveryRepeat = false;
            }
          }
          if (!worst || score.composite < worst.composite) {
            worst = { composite: score.composite, rationale: score.rationale, distilled: distilledTrace };
          }
        }

        perTask.push({
          taskId: task.taskId,
          pool: task.pool,
          composite: mean(composites), // P-025: per-task reward = mean over repeats
          rationale: worst?.rationale ?? '',
          distilled: worst?.distilled ?? '',
          cost,
          // A measured failure outranks a gap even within one task: if any repeat
          // regressed, the task regressed, whatever a sibling repeat failed to report.
          regressionStatus: regressionSeen ? 'fail' : regressionReportedEveryRepeat ? 'pass' : 'not-measured',
          probeStatus:
            task.pool !== 'probe'
              ? null
              : probeMissed
                ? 'fail'
                : probeReportedEveryRepeat
                  ? 'pass'
                  : 'not-measured',
          scoredRepeats: composites.length,
          traceRefs,
        });
      }

    const train = perTask.filter((r) => r.pool === 'train');
    const devAnchor = perTask.filter((r) => r.pool === 'dev-anchor');
    const probes = perTask.filter((r) => r.pool === 'probe');
    // P-002: the real-anchor pool stops being scored-then-discarded here. Its aggregate
    // is built exactly like the dev-anchor's, and it now reaches `decideAccept` as a gate.
    const realAnchor = perTask.filter((r) => r.pool === 'real-anchor');
    const trainVector = train.map((r) => r.composite);

    const totalCost = perTask.reduce((s, r) => s + r.cost, 0);
    const totalRuns = perTask.length * repeats;
    const evalResult: VariantEval = {
      variantId,
      trainAgg: mean(trainVector),
      trainVector,
      devAnchorAgg: mean(devAnchor.map((r) => r.composite)),
      realAnchorAgg: mean(realAnchor.map((r) => r.composite)),
      // P-002 / D-004(3) — coverage-only evidence for the real-anchor comparison. A task
      // counts as measured when EVERY repeat produced a composite, mirroring the
      // per-repeat discipline the regression signal already uses: a partially-scored task
      // yields a mean over fewer runs than the champion's, which is not apples-to-apples.
      // The zero-real-anchor case is `not-measured`, so a cycle that never exercised real
      // work cannot promote — never the vacuous `mean([]) === 0` that would read as a
      // catastrophic regression, and never a silent pass.
      realAnchorEvidence: buildEvidence(
        realAnchor.map((r) => ({
          taskId: r.taskId,
          status: (repeats > 0 && r.scoredRepeats === repeats ? 'pass' : 'not-measured') as GateStatus,
          traceRefs: r.traceRefs,
        })),
      ),
      // Mean cost PER RUN across every (task × repeat).
      meanCost: totalRuns ? totalCost / totalRuns : 0,
      // P-003 — typed evidence, not booleans. Every task owes the regression signal;
      // only probe tasks owe the probe signal.
      regressionEvidence: buildEvidence(perTask.map((r) => ({ taskId: r.taskId, status: r.regressionStatus, traceRefs: r.traceRefs }))),
      // The zero-probe case is `not-measured`, NOT the vacuous `true` it used to be.
      // "Probe is a guardrail, not a target" justified never REQUIRING probe tasks; it
      // never justified reporting an uncaught-bug guarantee for a pool that never ran.
      // A run with no probes now yields an inconclusive verdict — the loop still runs,
      // it just cannot autonomously promote on a guardrail it never exercised.
      probeEvidence: buildEvidence(
        probes.map((r) => ({ taskId: r.taskId, status: r.probeStatus ?? 'not-measured', traceRefs: r.traceRefs })),
      ),
    };

    // The proposer reflects on the WORST train traces (lowest per-task mean composite first).
    const worstTraces: WorstTrace[] = [...train]
      .sort((a, b) => a.composite - b.composite)
      .slice(0, worstK)
      .map((r) => ({ taskId: r.taskId, composite: r.composite, rationale: r.rationale, distilledTrace: r.distilled }));

      return { evalResult, worstTraces, costUsd: totalCost, runIds };
    } catch (error) {
      // Keep all pipeline/judge charges from completed work visible when a later
      // task or persistence step aborts the evaluation.
      throwWithCostUsd(error, incurredCostUsd);
    }
  }

  return {
    baseline: cfg.baseline,
    evaluate,
    async propose(parentOverlay, worstTraces, changelog) {
      return proposeCandidate(
        {
          parentOverlay,
          worstTraces,
          changelog,
          proposerModel: cfg.proposerModel,
          // P-032: routed-idea candidate directions ride every propose call (additive).
          ...(cfg.candidateDirections?.length ? { candidateDirections: cfg.candidateDirections } : {}),
          // P-030: measured champion outcomes ride every propose call (additive).
          ...(cfg.championOutcomes?.length ? { championOutcomes: cfg.championOutcomes } : {}),
        },
        { llmCall: cfg.proposerCall },
      );
    },
    async promote(overlay) {
      if (cfg.promote) await cfg.promote(overlay);
    },
    async revert() {
      if (cfg.revert) await cfg.revert();
    },
    async persistCycle(rec) {
      await insertCycle(cfg.gymSql, {
        // WI-5799: run-scoped for the SAME reason `newVariantId` is (WI-5697's
        // doc above) — a bare `cyc-${cycle}` is deterministic ACROSS runs
        // (autoloop always runs maxCycles=1 ⇒ always "cyc-1"), and the durable
        // copy upserts ON CONFLICT (workspace_id, harness_slug, cycle_id), so
        // every run OVERWROTE the previous run's cycle row. The gym's whole
        // durable history therefore collapsed to a single row and the Learning
        // tab could never show a recent run (owner report 2026-07-25). Still
        // deterministic per cycle WITHIN a run, so RB-006's rate-limit-retry
        // idempotency is preserved.
        cycleId: `cyc-${runId}-c${rec.cycle}`,
        cycle: rec.cycle,
        parentId: rec.parentId,
        candidateId: rec.candidateId,
        decision: rec.decision,
        gateResults: rec.gateResults,
      });
    },
    recordProposal: cfg.recordProposal,
    recordArchive: cfg.recordArchive,
    noveltyForVariant: cfg.noveltyForVariant,
    federateAcceptedElite: cfg.federateAcceptedElite,
    newVariantId: (cycle) => `cand-${runId}-c${cycle}`,
    now,
    sleep,
  };
}
