/**
 * Reflective proposer (P-015) — GEPA's reflective-mutation mechanism (D-007),
 * v1 prompts-only (D-015).
 *
 * Reads the parent variant's worst-scoring train traces + the judge's RATIONALES
 * (the reflection signal) + the running changelog, and emits a targeted PROMPT diff
 * for one or a few roles → a candidate overlay (parent overrides ⊕ the proposed
 * changes). Model/orchestration mutation is reserved for a later phase (D-015). LLM
 * injected so build → call → parse → merge is unit-tested without the network.
 */
import { tryParseJson } from './parse-json';
import { planVariantOverlay, type VariantOverlay } from './variant-overlay';
import type { GymLlmCall } from './task-generator';
import type { JudgeLlmCall } from './judge';

export interface WorstTrace {
  taskId: string;
  composite: number;
  rationale: string;
  /** Optional distilled trace excerpt for deeper reflection. */
  distilledTrace?: string;
}

export interface ProposeInput {
  /** The parent variant's overlay to mutate from. */
  parentOverlay: VariantOverlay;
  /** The parent's worst-scoring train traces (with judge rationales). */
  worstTraces: WorstTrace[];
  /** The running judge changelog (anchored to hard numbers + narrative). */
  changelog: string;
  /** Model that proposes — should differ from the judge for the same decorrelation spirit. */
  proposerModel: string;
  /**
   * P-032 (learning-system-audit): operator improvement ideas TRIAGED TO THE GYM
   * (payload.ideaLifecycle.triageDecision='gym'), pre-formatted one per line.
   * Surfaced to the proposer as OPTIONAL candidate directions; empty/absent ⇒
   * the prompt is byte-identical to before (purely additive).
   */
  candidateDirections?: string[];
  /**
   * P-030 (consume-edges B-09): recent champions' MEASURED post-acceptance
   * outcomes (live success-rate delta vs the pre-acceptance baseline),
   * pre-formatted one entry per line (post-acceptance-outcomes.ts,
   * formatChampionOutcomeEntries). Empty/absent ⇒ byte-identical prompt.
   */
  championOutcomes?: string[];
}

export interface ParsedProposal {
  promptOverrides: Record<string, string>;
  rationale: string;
}

export interface CandidateProposal {
  overlay: VariantOverlay;
  rationale: string;
  diffFromParent: string;
  /** Cost of the proposer call, including a response that later fails validation. */
  costUsd: number;
  /** The reported cost is only a subtotal; keep the reservation open. */
  costUsdMeasurementMissing?: boolean;
  unreportedFrames?: number;
}

/** Native judge/proposer network recovery. Another dispatch is safe here only
 * after a complete, explicitly measured zero-cost failure. A network error
 * alone does not establish that inference never ran; preserve unknown spend
 * for the caller's reservation/settlement path. */
export function withGymLlmNetworkRetry<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  deps: { log: (message: string) => void; sleep?: (ms: number) => Promise<void> },
): (...args: A) => Promise<R> {
  const sleep = deps.sleep ?? (async (ms: number) => { await new Promise(resolve => setTimeout(resolve, ms)); });
  return async (...args: A): Promise<R> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= 2; attempt++) {
      try { return await fn(...args); }
      catch (error) {
        lastErr = error;
        const message = error instanceof Error ? error.message : String(error);
        const usage = error as { costUsd?: unknown; costUsdMeasurementMissing?: unknown; unreportedFrames?: unknown } | null;
        const measuredZero = usage?.costUsd === 0 &&
          (usage.costUsdMeasurementMissing === undefined || usage.costUsdMeasurementMissing === false) &&
          (usage.unreportedFrames === undefined || usage.unreportedFrames === 0);
        if (!/fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(message) ||
          !measuredZero || attempt === 2) throw error;
        deps.log(`llm call known-zero network failure (attempt ${attempt + 1}/3): ${message.slice(0, 120)}`);
        await sleep(2_000 * (attempt + 1));
      }
    }
    throw lastErr;
  };
}

type NativeGymLlmRequest = Parameters<JudgeLlmCall>[0] & {
  priority?: string;
  harnessSlug?: string;
  requireOutputTokenLimit?: boolean;
};

/** The real cycle's transport binding. A frozen judge limit must be enforced
 * by the selected provider route, including SDK retries. This does not issue
 * a monetary grant; the proposer still needs its admitted resource policy. */
export function bindNativeGymLlmCalls(
  call: (opts: NativeGymLlmRequest) => ReturnType<JudgeLlmCall>,
  harnessSlug: string,
  deps: { log: (message: string) => void; sleep?: (ms: number) => Promise<void> },
): { judge: JudgeLlmCall; proposer: GymLlmCall } {
  const dispatch = withGymLlmNetworkRetry((opts: NativeGymLlmRequest) =>
    call({ ...opts, priority: 'gym', harnessSlug }), deps);
  const snapshot = (opts: NativeGymLlmRequest): NativeGymLlmRequest => ({
    ...opts, messages: opts.messages.map(message => ({ ...message })),
  });
  return {
    async judge(opts) {
      const request = snapshot(opts);
      if (!Number.isSafeInteger(request.maxTokens) || request.maxTokens! <= 0) {
        throw Object.assign(new RangeError('Native Gym judge requires its frozen output token limit'), { costUsd: 0 });
      }
      return dispatch({ ...request, requireOutputTokenLimit: true });
    },
    proposer: opts => dispatch(snapshot(opts)),
  };
}

/** Read a provider-reported cost from a successful value or a thrown error. */
export function costUsdOf(value: unknown): number {
  const candidate =
    typeof value === 'number'
      ? value
      : (value as { costUsd?: unknown } | null | undefined)?.costUsd;
  return typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0 ? candidate : 0;
}

/** Preserve the known subtotal separately from whether this call's usage is complete.
 * Validation failures may supply the completed response as their usage evidence. */
export function throwWithCostUsd(error: unknown, incurredCostUsd: number, usageEvidence: unknown = error): never {
  const usage = usageEvidence as { costUsd?: unknown; costUsdMeasurementMissing?: unknown; unreportedFrames?: unknown } | null;
  const measured = typeof usage?.costUsd === 'number' && Number.isFinite(usage.costUsd) && usage.costUsd >= 0;
  const unreportedFrames = typeof usage?.unreportedFrames === 'number' && usage.unreportedFrames > 0
    ? usage.unreportedFrames : undefined;
  const missing = !measured || usage?.costUsdMeasurementMissing === true || unreportedFrames !== undefined;
  const costUsd = costUsdOf(error) + costUsdOf(incurredCostUsd);
  const failure = error instanceof Error ? error : new Error(String(error));
  Object.assign(failure, { costUsd, ...(missing ? { costUsdMeasurementMissing: true } : {}),
    ...(unreportedFrames === undefined ? {} : { unreportedFrames }) });
  throw failure;
}

export function buildProposerPrompt(input: ProposeInput): { system: string; user: string } {
  const system = [
    'You optimize a multi-agent coding harness by improving its ROLE PROMPTS. You are given',
    'the harness’s worst-scoring runs with an independent judge’s RATIONALES, plus a changelog',
    'of past prompt changes. Diagnose the recurring failure mode and propose a TARGETED prompt',
    'change to ONE or a FEW roles that would most raise the judge’s scores. Change prompts only',
    '— do not propose model swaps or orchestration changes.',
    '',
    'Output ONLY a single JSON object (no prose, no fences):',
    '{"promptOverrides": {"<role>": "<full replacement prompt markdown>"}, "rationale": "<why this change targets the failures>"}',
  ].join('\n');

  const user = [
    '## Running changelog',
    input.changelog || '(none yet)',
    // P-030: live post-acceptance measurement of past accepted changes. Zero
    // finalized champions ⇒ no section (the prompt stays byte-identical).
    ...(input.championOutcomes?.length
      ? [
          '',
          '## Recent champion outcomes (live post-acceptance measurement)',
          'Live-run outcomes measured AFTER each recently accepted prompt change, vs the same window',
          'before it. Build on changes that improved live outcomes; avoid repeating ones that regressed.',
          ...input.championOutcomes,
        ]
      : []),
    '',
    '## Worst-scoring runs (judge rationales)',
    ...input.worstTraces.map(
      (t) =>
        `- task ${t.taskId} (composite ${t.composite.toFixed(2)}): ${t.rationale}` +
        (t.distilledTrace ? `\n  trace: ${t.distilledTrace}` : ''),
    ),
    // P-032: triage-routed improvement ideas as OPTIONAL candidate directions. Zero
    // routed ideas ⇒ no section at all (the prompt stays byte-identical to before).
    ...(input.candidateDirections?.length
      ? [
          '',
          '## Candidate directions (operator improvement ideas triaged to the gym)',
          'Optional directions from the operator’s improvement backlog. Adopt one ONLY when it',
          'plausibly targets the failure modes evidenced above; otherwise ignore them.',
          ...input.candidateDirections.map((d) => `- ${d}`),
        ]
      : []),
    '',
    '## Current role overrides (parent variant)',
    JSON.stringify(input.parentOverlay.promptOverrides, null, 2),
  ].join('\n');

  return { system, user };
}

export function parseProposal(raw: unknown): ParsedProposal {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`proposal must be a JSON object, got: ${typeof raw}`);
  }
  const o = raw as Record<string, unknown>;
  const po = o.promptOverrides;
  if (typeof po !== 'object' || po === null) {
    throw new Error('proposal is missing a "promptOverrides" object');
  }
  if (typeof o.rationale !== 'string' || !o.rationale.trim()) {
    throw new Error('proposal is missing a non-empty "rationale"');
  }
  const promptOverrides = po as Record<string, string>;
  // Validate the roles (rejects unknown roles incl. the frozen judge) — reuse the overlay validator.
  planVariantOverlay({ promptOverrides });
  return { promptOverrides, rationale: o.rationale };
}

export async function proposeCandidate(
  input: ProposeInput,
  deps: { llmCall: GymLlmCall },
): Promise<CandidateProposal> {
  const { system, user } = buildProposerPrompt(input);
  let res: Awaited<ReturnType<GymLlmCall>>;
  try {
    res = await deps.llmCall({
      model: input.proposerModel,
      system,
      messages: [{ role: 'user', content: user }],
      responseFormat: 'json',
    });
  } catch (error) {
    // A provider can attach costUsd even when the request ultimately throws.
    // Keep that property intact for the loop's spend ledger.
    throwWithCostUsd(error, 0);
  }

  try {
    const proposal = parseProposal(res.json ?? tryParseJson(res.text));

    // Candidate overlay = parent overrides ⊕ proposed changes (prompts-only).
    const merged: Record<string, string> = { ...input.parentOverlay.promptOverrides, ...proposal.promptOverrides };
    const overlay: VariantOverlay = { promptOverrides: merged };
    // Validate the merged overlay too.
    planVariantOverlay(overlay);

    const diffFromParent = Object.keys(proposal.promptOverrides).sort().join(', ');
    const measured = typeof res.costUsd === 'number' && Number.isFinite(res.costUsd) && res.costUsd >= 0;
    const missing = !measured || res.costUsdMeasurementMissing === true || (res.unreportedFrames ?? 0) > 0;
    return { overlay, rationale: proposal.rationale, diffFromParent, costUsd: costUsdOf(res.costUsd),
      ...(missing ? { costUsdMeasurementMissing: true } : {}),
      ...(res.unreportedFrames === undefined ? {} : { unreportedFrames: res.unreportedFrames }) };
  } catch (error) {
    // The model response may have been billed even when parsing/validation rejects it.
    throwWithCostUsd(error, res.costUsd, res);
  }
}
