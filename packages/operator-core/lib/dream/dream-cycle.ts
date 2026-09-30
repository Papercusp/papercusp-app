/** Capability orchestration over the existing Dream run, governor and Blender seams. */
import { createHash } from 'node:crypto';
import { costFromTokens } from '@papercusp/model-pricing';
import type { ScoutLlmCall } from '../scout/types';
import {
  resolveDreamCycleConfig,
  resolveDreamPassConfig,
  resolveDreamReviewConfig,
  type DreamCycleConfig,
  type DreamPassConfig,
  type DreamReviewConfig,
} from './dream-config';
import { CAPABILITY_DREAM_PROMPT_VERSION, runCapabilityDreamPass, scopeDreamProblems, type DreamProblemContext } from './capability-pass';
import {
  CAPABILITY_REVIEW_VERSION,
  runCapabilityDreamReview,
  preflightCapabilityReview,
  rerankCapabilityPriors,
  type CapabilityReviewSources,
} from './capability-review';
import {
  buildCapabilitySamplingSnapshot,
  sampleCapabilityCombination,
  type CapabilitySamplingOptions,
  type CapabilitySamplingResult,
} from './capability-sampler';
import type { CapabilityManifest, CapabilityPacket } from './capability-contracts';
import { dreamCapabilityRun, type BeginCapabilityRunInput, type DreamRunCall } from './dream-run-provenance';
import { verifyCapabilityPacket } from './capability-packets';
import { DreamAdmissionError, type DreamGovernorPreflight, type RecordDreamSpendResult } from './dream-governor';
import type { DreamPassUsage } from './dream-pass';
import type { SinkDreamInsightResult } from './dream-sink';
import type { DreamRun, DreamRunMode, FinalizeDreamRunInput } from './dream-run-store';
import { DreamPilotPinSchema, requireDreamPilotProtocol, type DreamPilotPin } from './dream-evaluation';

export interface DreamCycleInput {
  workspaceId: string;
  potSlug: string;
  repositoryId: string;
  rootPath: string;
  manifest: CapabilityManifest;
  mode: DreamRunMode;
  cycleId: string;
  cycle?: Partial<DreamCycleConfig>;
  sampler?: Omit<CapabilitySamplingOptions, 'seed' | 'now' | 'promptVersion' | 'history' | 'exposures'>;
  pass?: Partial<DreamPassConfig>;
  review?: Partial<DreamReviewConfig>;
  problemMode?: DreamProblemContext['mode'];
  signal?: AbortSignal;
  /** Explicit evaluation runs require a frozen protocol; ordinary manual cycles keep their existing controls. */
  pilot?: DreamPilotPin;
}
type FinalizeInput = Omit<FinalizeDreamRunInput, 'workspaceId'>;
type CallInput = Pick<DreamRunCall, 'callId' | 'phase' | 'model' | 'reservedUsd'>;
export interface DreamCycleDeps {
  llmCall: ScoutLlmCall;
  /** Only the durable workflow executor can attest exclusive ownership of a recovery replay. */
  exclusiveReplay?: boolean;
  preflight: () => Promise<DreamGovernorPreflight>;
  /** Re-read the Start/Pause/auto switches before every phase and sink. */
  canContinue?: () => Promise<boolean>;
  loadPackets: (signal: AbortSignal) => Promise<CapabilityPacket[]>;
  loadHistory: () => Promise<DreamRun[]>;
  reviewSources: (packets: CapabilityPacket[]) => CapabilityReviewSources;
  loadProblems?: () => Promise<DreamProblemContext>;
  beginRun: (input: {
    runId: string;
    cycleId: string;
    capability: BeginCapabilityRunInput;
  }) => Promise<{ created: boolean; run: DreamRun }>;
  recordSelection: (input: { runId: string; capability: CapabilitySamplingResult }) => Promise<DreamRun>;
  beginCall: (input: {
    runId: string;
    call: CallInput;
  }) => Promise<{ started: boolean; run: DreamRun; call: DreamRunCall }>;
  settleCall: (input: {
    runId: string;
    callId: string;
    usage: DreamPassUsage | null;
    error?: string;
  }) => Promise<DreamRun>;
  recordReview: (input: {
    runId: string;
    outcome: Record<string, unknown>;
    review: Record<string, unknown>;
  }) => Promise<DreamRun>;
  finalizeRun: (input: FinalizeInput) => Promise<DreamRun>;
  recordSpend: (run: DreamRun) => Promise<RecordDreamSpendResult>;
  sink: (runId: string, packets: CapabilityPacket[]) => Promise<SinkDreamInsightResult>;
  buildSnapshot?: typeof buildCapabilitySamplingSnapshot;
  sample?: typeof sampleCapabilityCombination;
  dream?: typeof runCapabilityDreamPass;
  review?: typeof runCapabilityDreamReview;
  rerank?: typeof rerankCapabilityPriors;
  estimateCall?: (input: Parameters<ScoutLlmCall>[0]) => number;
  now?: () => number;
}
export interface DreamCycleRunSummary {
  runId: string;
  status: DreamRun['status'];
  costUsd: number;
  routedRef: string | null;
  replayed: boolean;
}
export type DreamCycleReason =
  | 'completed'
  | 'no-pair'
  | 'cycle-cost-cap'
  | 'rolling-cost-cap'
  | 'governor-refused'
  | 'review-unavailable'
  | 'aborted'
  | 'in-progress';
export interface DreamCycleResult {
  fired: boolean;
  reason: DreamCycleReason;
  governorReason?: string;
  cycleId: string;
  attempts: number;
  accepted: number;
  costUsd: number;
  newSpendUsd: number;
  runs: DreamCycleRunSummary[];
  sources?: { units: number; eligible: number; exclusions: Array<{ unitId: string; reason: string }> };
}
export function dreamRunId(cycleId: string, index: number): string {
  if (!cycleId.trim()) throw new RangeError('cycleId must be a non-empty string');
  if (!Number.isInteger(index) || index < 0) throw new RangeError('dream index must be a non-negative integer');
  return cycleId + ':dream:' + (index + 1);
}
/** Reconstructible from the persisted run/call ledger; bounded below the gateway's
 * owner limit even for long workflow IDs, without conflating scopes or phases. */
export function dreamCallOwnerId(
  scope: Pick<DreamCycleInput, 'workspaceId' | 'potSlug'>,
  runId: string,
  phase: 'generation' | 'control-a' | 'control-b' | 'review',
): string {
  const key = createHash('sha256').update(JSON.stringify([scope.workspaceId, scope.potSlug, runId])).digest('hex');
  return `system:dream:${key}:${phase}`;
}
const record = (value: unknown) => JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
/** List-price admission estimate, not a promise about the final provider bill. */
export function estimateDreamCall(input: Parameters<ScoutLlmCall>[0]): number {
  const bytes = Buffer.byteLength((input.system ?? '') + JSON.stringify(input.messages), 'utf8') + 256;
  const estimate = costFromTokens(input.model, {
    inputTokens: bytes,
    outputTokens: (input.maxTokens ?? 4096) + (input.thinkingBudgetTokens ?? 0),
  });
  if (!estimate.priced || !Number.isFinite(estimate.usd) || estimate.usd <= 0)
    throw new Error('Dream cannot admit an unpriced model: ' + input.model);
  return estimate.usd;
}
async function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('Dream aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([operation(), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** Terminal replays spend nothing. A recent in-flight run is left to its owner;
 * an expired interrupted run retains its reservations as unknown usage. */
export async function runDreamCycle(input: DreamCycleInput, deps: DreamCycleDeps): Promise<DreamCycleResult> {
  if (input.problemMode !== undefined && !['observed-problems', 'open-exploration'].includes(input.problemMode))
    throw new RangeError('Unsupported Dream problem mode');
  const config = resolveDreamCycleConfig(input.cycle);
  const pass = resolveDreamPassConfig({ maxOutputTokens: 4096, ...input.pass });
  const reviewConfig = resolveDreamReviewConfig({ maxOutputTokens: 4096, ...input.review });
  const pilot = input.pilot === undefined ? null : DreamPilotPinSchema.parse(input.pilot);
  const pilotConfig = pilot
    ? {
        generator: pass.model,
        reviewer: reviewConfig.model,
        mode: input.mode,
        samplerMode: input.sampler?.mode ?? 'structured',
        arity: input.sampler?.arity ?? 2,
        cycle: config,
        manifestRevision: input.manifest.revision,
        scope: { workspaceId: input.workspaceId, potSlug: input.potSlug },
      }
    : null;
  // Validate the protocol pin and policy before any adapter can perform work.
  // The real on-disk population is independently compared below, before generation.
  if (pilot) requireDreamPilotProtocol(pilot, { ...pilotConfig!, sourceSnapshot: pilot.protocol.sourceSnapshot });
  if (pilot?.matchedPairIndex !== undefined && pilot.matchedPairIndex + config.maxDreamsPerCycle > 50)
    throw new Error('Matched Dream cycle exceeds the bounded pair assignment window');
  const now = deps.now ?? Date.now;
  const result: DreamCycleResult = {
    fired: false,
    reason: 'completed',
    cycleId: input.cycleId,
    attempts: 0,
    accepted: 0,
    costUsd: 0,
    newSpendUsd: 0,
    runs: [],
  };
  const ctrl = new AbortController();
  const cancel = () => ctrl.abort(input.signal?.reason ?? new Error('Dream aborted'));
  if (input.signal?.aborted) cancel();
  else input.signal?.addEventListener('abort', cancel, { once: true });
  const signal = ctrl.signal;
  const deadlineMs = now() + config.timeoutMs;
  const timer = setTimeout(() => ctrl.abort(new Error('Dream cycle deadline exceeded')), config.timeoutMs);
  timer.unref?.();
  let packets: CapabilityPacket[] | undefined;
  let history: DreamRun[] | undefined;
  const account = async (run: DreamRun) => {
    const spend = await deps.recordSpend(run);
    if (spend.recorded) result.newSpendUsd += spend.costUsd;
  };
  const summarize = (run: DreamRun, replayed: boolean) => {
    result.runs.push({
      runId: run.runId,
      status: run.status,
      costUsd: run.costUsd,
      routedRef: run.routedRef,
      replayed,
    });
    result.costUsd += run.costUsd;
    if (run.status === 'accepted') result.accepted++;
    result.attempts++;
    result.fired = true;
  };
  const proceed = async () => {
    signal.throwIfAborted();
    if (deps.canContinue && !(await deps.canContinue())) ctrl.abort(new Error('Dream paused'));
    signal.throwIfAborted();
  };
  try {
    if (signal.aborted) {
      result.reason = 'aborted';
      return result;
    }
    const preflight = await deps.preflight();
    if (!preflight.allow) {
      result.reason = 'governor-refused';
      result.governorReason = preflight.reason;
      return result;
    }
    if (config.maxCostUsd <= 0) {
      result.reason = 'cycle-cost-cap';
      return result;
    }
    for (let index = 0; index < config.maxDreamsPerCycle; index++) {
      try {
        await proceed();
      } catch {
        result.reason = 'aborted';
        break;
      }
      if (result.costUsd >= Math.min(config.maxCostUsd, preflight.cycleRemainingUsd)) {
        result.reason = 'cycle-cost-cap';
        break;
      }
      if (result.newSpendUsd >= preflight.rollingRemainingUsd) {
        result.reason = 'rolling-cost-cap';
        break;
      }
      const runId = dreamRunId(input.cycleId, index);
      const begun = await deps.beginRun({
        runId,
        cycleId: input.cycleId,
        capability: {
          manifest: input.manifest,
          dreamerModel: pass.model,
          reviewerModel: reviewConfig.model,
          dreamPromptVersion: CAPABILITY_DREAM_PROMPT_VERSION,
          reviewPromptVersion: CAPABILITY_REVIEW_VERSION,
          ...(pilot
            ? {
                evaluation: {
                  protocolPin: pilot.pin,
                  arm: pilot.arm as 'uniform-pair' | 'structured-pair' | 'structured-triple',
                  ...(pilot.protocol.comparison ? { inputHash: pilot.protocol.comparison.inputHash } : {}),
                  ...(pilot.matchedPairIndex !== undefined ? { matchedPairIndex: pilot.matchedPairIndex + index } : {}),
                },
              }
            : {}),
        },
      });
      if (begun.run.status !== 'running') {
        await account(begun.run);
        summarize(begun.run, true);
        if (begun.run.status === 'no-pair') {
          result.reason = 'no-pair';
          break;
        }
        if (begun.run.review?.schemaVersion === 'dream-capability-preflight-v1') {
          result.reason = 'review-unavailable';
          break;
        }
        continue;
      }
      if (!begun.created) {
        if (!deps.exclusiveReplay && now() < Date.parse(begun.run.startedAt) + config.timeoutMs + 5000) {
          result.reason = 'in-progress';
          break;
        }
        // Never regenerate an uncertain call. A frozen accepted review may finish its idempotent sink.
        if (begun.run.review?.verdict === 'accept' && dreamCapabilityRun(begun.run)?.sampling?.status === 'selected') {
          const saved = dreamCapabilityRun(begun.run)!.sampling!;
          if (saved.status === 'selected') {
            const savedPackets = [
              saved.selection.a.packet,
              saved.selection.b.packet,
              ...(saved.selection.c ? [saved.selection.c.entry.packet] : []),
            ];
            await proceed();
            const sunk = await deps.sink(runId, savedPackets);
            const run = await deps.finalizeRun({
              runId,
              status: sunk.sunk ? 'accepted' : 'rejected',
              error: sunk.sunk ? null : sunk.reason,
            });
            await account(run);
            summarize(run, true);
            continue;
          }
        }
        const run = await deps.finalizeRun({
          runId,
          status: 'error',
          error: 'Interrupted Dream; prior call reservations remain charged. No call was repeated.',
        });
        await account(run);
        summarize(run, true);
        continue;
      }

      let outcome: Record<string, unknown> | undefined;
      let latest = begun.run;
      let stopped: DreamCycleReason | undefined;
      const pending = new Set<Promise<unknown>>();
      const phase = async <T>(
        callId: string,
        kind: DreamRunCall['phase'],
        model: string,
        reservedUsd: number,
        execute: () => Promise<T>,
        usage: (value: T) => DreamPassUsage,
      ): Promise<T> => {
        await proceed();
        let admitted: Awaited<ReturnType<DreamCycleDeps['beginCall']>>;
        try {
          admitted = await deps.beginCall({ runId, call: { callId, phase: kind, model, reservedUsd } });
        } catch (error) {
          if (error instanceof DreamAdmissionError) stopped = error.reason;
          throw error;
        }
        latest = admitted.run;
        if (!admitted.started) throw new Error('Dream call already dispatched: ' + callId);
        let value: T;
        try {
          value = await abortable(execute, signal);
        } catch (error) {
          latest = await deps.settleCall({
            runId,
            callId,
            usage: reservedUsd === 0 ? { model, costUsd: 0, inputTokens: 0, outputTokens: 0 } : null,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
        latest = await deps.settleCall({ runId, callId, usage: usage(value) });
        return value;
      };
      const local = <T>(callId: string, kind: DreamRunCall['phase'], execute: () => Promise<T>) =>
        phase(callId, kind, 'local:' + kind, 0, execute, () => ({
          model: 'local:' + kind,
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
        }));
      const llmFor =
        (kind: 'generation' | 'control-a' | 'control-b' | 'review'): ScoutLlmCall =>
        (call) => {
          const task = phase(
            kind,
            kind,
            call.model,
            (deps.estimateCall ?? estimateDreamCall)(call),
            () =>
              abortable(
                () => deps.llmCall({
                  ...call,
                  ownerId: dreamCallOwnerId(input, runId, kind),
                  retryDeadlineMs: deadlineMs,
                }),
                call.signal ?? signal,
              ),
            (r) => ({
              model: call.model,
              costUsd: r.costUsd,
              inputTokens: r.inputTokens,
              outputTokens: r.outputTokens,
            }),
          );
          pending.add(task);
          void task.then(
            () => pending.delete(task),
            () => pending.delete(task),
          );
          return task;
        };
      const finish = async (value: FinalizeInput) => {
        await Promise.allSettled([...pending]);
        const run = await deps.finalizeRun(value);
        await account(run);
        summarize(run, false);
        history?.push(run);
      };
      try {
        packets ??= await local('packet:catalogue', 'packet', () => deps.loadPackets(signal));
        history ??= await local('retrieval:history', 'retrieval', deps.loadHistory);
        const snapshot = await local('retrieval:snapshot', 'retrieval', () =>
          (deps.buildSnapshot ?? buildCapabilitySamplingSnapshot)({
            rootPath: input.rootPath,
            manifest: input.manifest,
            packets: packets!,
            scope: { workspaceId: input.workspaceId, potSlug: input.potSlug, repositoryId: input.repositoryId },
          }),
        );
        result.sources = {
          units: input.manifest.units.length,
          eligible: snapshot.eligible.length,
          exclusions: snapshot.exclusions,
        };
        if (pilot) requireDreamPilotProtocol(pilot, { ...pilotConfig!, sourceSnapshot: snapshot.fingerprint });
        const past = history
          .filter((r) => r.workspaceId === input.workspaceId && r.potSlug === input.potSlug)
          .flatMap((r) => {
            const saved = dreamCapabilityRun(r)?.sampling;
            return saved?.status === 'selected'
              ? [{ selection: saved.selection, selectedAt: Date.parse(r.startedAt) }]
              : [];
          });
        const exposures: Record<string, number> = {};
        for (const p of past)
          for (const entry of [p.selection.a, p.selection.b, ...(p.selection.c ? [p.selection.c.entry] : [])])
            exposures[entry.packet.unit.id] = (exposures[entry.packet.unit.id] ?? 0) + 1;
        // A matched ablation uses the same frozen population, assignment and exposure
        // weights on both sides. Live history differs after the first side runs and
        // otherwise changes the draw even with an identical seed.
        const matchedIndex = pilot?.matchedPairIndex === undefined ? undefined : pilot.matchedPairIndex + index;
        const sampling = (deps.sample ?? sampleCapabilityCombination)(snapshot, {
          ...input.sampler,
          seed: matchedIndex !== undefined ? `${pilot!.protocol.seed}:matched-pair:${matchedIndex}` :
            pilot ? `${pilot.protocol.seed}:${pilot.arm}:${runId}` : runId,
          promptVersion: CAPABILITY_DREAM_PROMPT_VERSION,
          now: now(),
          exposures: matchedIndex !== undefined ? {} : exposures,
          history: matchedIndex !== undefined ? [] : past.map((p) => ({ pairKey: p.selection.pairKey, selectedAt: p.selectedAt })),
        });
        latest = await deps.recordSelection({ runId, capability: sampling });
        if (sampling.status === 'no-pair') {
          await finish({ runId, status: 'no-pair', outcome: { verdict: 'no-pair', reason: sampling.reason } });
          result.reason = 'no-pair';
          break;
        }
        if (pilot?.arm === 'structured-triple' && !sampling.selection.c)
          throw new Error(
            'Dream pilot triple arm requires a role-labeled C; pair fallback is not a triple observation',
          );
        const reviewPreflight = await local('retrieval:review-preflight', 'retrieval', () =>
          preflightCapabilityReview({
            selection: sampling.selection, rootPath: input.rootPath, manifest: input.manifest,
            sources: deps.reviewSources(packets!), dreamerModel: pass.model, config: reviewConfig,
            signal, cycleDeadlineMs: deadlineMs,
          }, {
            verifyPacket: verifyCapabilityPacket,
            rerank: (query, priors, options) => local('rerank:preflight', 'rerank', () =>
              (deps.rerank ?? rerankCapabilityPriors)(query, priors, options)),
          }),
        );
        if (!reviewPreflight.ready) {
          await finish({ runId, status: 'rejected',
            outcome: { verdict: 'unverified', generationSkipped: true },
            review: { ...reviewPreflight, verdict: 'unverified', schemaVersion: 'dream-capability-preflight-v1' },
          });
          result.reason = 'review-unavailable';
          // A required dependency is down; do not repeat the same probe or spend
          // on additional attempts within this cycle.
          break;
        }
        // Frozen legacy pilots retain their original input. An ordinary cycle is
        // problem-led by default, with an explicit open-exploration comparison.
        const problemContext = pilot?.protocol.comparison?.problemContext ?? (!pilot && input.problemMode !== 'open-exploration' && deps.loadProblems
          ? await local('retrieval:problems', 'retrieval', async () => {
              const found = await deps.loadProblems!();
              return scopeDreamProblems(found.evidence, input, found.mode);
            })
          : scopeDreamProblems([], input, 'open-exploration'));
        const dreamed = await (deps.dream ?? runCapabilityDreamPass)({
          selection: sampling.selection,
          llmCall: llmFor('generation'),
          config: pass,
          signal,
          cycleDeadlineMs: deadlineMs,
          problemContext,
        });
        await Promise.allSettled([...pending]);
        outcome = record({ ...dreamed, problemContext });
        if (dreamed.verdict !== 'insight') {
          await finish({
            runId,
            status: dreamed.verdict === 'none' ? 'abstained' : 'malformed',
            outcome,
            error: dreamed.verdict === 'malformed' ? dreamed.error : null,
          });
          continue;
        }
        const reviewed = await local('retrieval:review', 'retrieval', () =>
          (deps.review ?? runCapabilityDreamReview)(
            {
              candidate: dreamed.insight.capability,
              selection: sampling.selection,
              rootPath: input.rootPath,
              manifest: input.manifest,
              sources: deps.reviewSources(packets!),
              dreamerModel: pass.model,
              llmCall: llmFor('review'),
              callForPhase: llmFor,
              config: reviewConfig,
              signal,
              cycleDeadlineMs: deadlineMs,
              problemContext,
            },
            {
              verifyPacket: verifyCapabilityPacket,
              rerank: (query, priors, options) =>
                local('rerank', 'rerank', () => (deps.rerank ?? rerankCapabilityPriors)(query, priors, options)),
            },
          ),
        );
        await Promise.allSettled([...pending]);
        latest = await deps.recordReview({ runId, outcome, review: record(reviewed) });
        if (reviewed.verdict !== 'accept') {
          await finish({ runId, status: reviewed.reason === 'duplicate' ? 'duplicate' : 'rejected' });
        } else {
          await proceed();
          const sunk = await deps.sink(runId, packets);
          if (!sunk.sunk) throw new Error('Reviewed Dream not sunk: ' + sunk.reason);
          await finish({ runId, status: 'accepted' });
        }
      } catch (error) {
        // A sibling control can settle after the review aborts; drain its accounting first.
        await Promise.allSettled([...pending]);
        await finish({
          runId,
          status: 'error',
          ...(latest.review ? {} : { outcome }),
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (signal.aborted) {
        result.reason = 'aborted';
        break;
      }
      if (stopped) {
        result.reason = stopped;
        break;
      }
    }
    return result;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', cancel);
  }
}
