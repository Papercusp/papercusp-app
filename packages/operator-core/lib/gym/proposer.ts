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
}

/** Read a provider-reported cost from a successful value or a thrown error. */
export function costUsdOf(value: unknown): number {
  const candidate =
    typeof value === 'number'
      ? value
      : (value as { costUsd?: unknown } | null | undefined)?.costUsd;
  return typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0 ? candidate : 0;
}

/** Preserve already-burned provider spend when a call fails after dispatch. */
export function throwWithCostUsd(error: unknown, incurredCostUsd: number): never {
  const costUsd = costUsdOf(error) + costUsdOf(incurredCostUsd);
  if (error instanceof Error) {
    Object.assign(error, { costUsd });
    throw error;
  }
  const wrapped = new Error(String(error));
  Object.assign(wrapped, { costUsd });
  throw wrapped;
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
    return { overlay, rationale: proposal.rationale, diffFromParent, costUsd: costUsdOf(res.costUsd) };
  } catch (error) {
    // The model response may have been billed even when parsing/validation rejects it.
    throwWithCostUsd(error, res.costUsd);
  }
}
