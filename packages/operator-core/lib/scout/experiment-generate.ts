/**
 * The LLM "proposal→experiment" step (experiment-registry-invocation-api #2, the sharp
 * version). A Scout Proposal is PROSE; the mechanical `proposalToExperimentRequest`
 * stuffs that prose into the candidate overlay + case verbatim (valid but crude). This
 * step uses the Scout LLM to GENERATE a sharp candidate system-prompt overlay (an
 * imperative instruction that induces the proposed behavior) + a realistic synthetic
 * case (context + intent) — turning a hypothesis into a testable A/B.
 *
 * It SPENDS (one LLM call per proposal) and so runs ONLY when the SCOUT_EXPERIMENT_RAIL
 * is armed (the cycle-deps fork is flag-gated). On any failure (LLM error, unparseable
 * output) it falls back to the mechanical mapping — the rail never breaks, never silently
 * drops a proposal. The dispatch still dry-runs the result (no replay spend until the
 * owner separately arms experiment:run).
 */
import type { Proposal, ScoutLlmCall } from './types';
import { parseLlmJson } from './llm-json';
import { proposalToExperimentRequest } from './experiment-rail';
import type { RunExperimentInput } from '../experiment/run-core';
import { DEFAULT_SCOUT_EXPERIMENT_MODEL } from './models';

export const DEFAULT_EXPERIMENT_GEN_MODEL = DEFAULT_SCOUT_EXPERIMENT_MODEL;
const OVERLAY_CAP = 4000;

interface ParsedGen {
  overlay: string;
  caseContext: string;
  caseIntent: string;
}

function parseGen(raw: unknown): ParsedGen | null {
  if (raw == null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const overlay = str(o.overlay ?? o.systemOverlay ?? o.policy);
  const caseIntent = str(o.caseIntent ?? o.intent);
  // Need at least an overlay (the thing under test) + a judge intent; context can default.
  if (!overlay || !caseIntent) return null;
  return { overlay, caseContext: str(o.caseContext ?? o.context), caseIntent };
}

export function buildGenerateExperimentPrompt(p: Proposal): { system: string; user: string } {
  const system = [
    'You convert a Scout PROPOSAL (a hypothesis about how to improve a coding agent) into a CONCRETE replay A/B experiment. The experiment re-runs an agent mid-task under a CANDIDATE policy and scores whether it does better than the baseline.',
    'Produce two things:',
    '1. A candidate SYSTEM-PROMPT OVERLAY — a crisp instruction appended to the agent\'s prompt that induces the proposed behavior. Imperative, specific, self-contained, ≤ 1500 chars.',
    '2. A synthetic CASE — a realistic mid-task context the agent resumes from, plus the task intent the judge scores against.',
    'Reason briefly, then output ONLY this JSON (no prose, no fences):',
    '{"overlay": "...the candidate system-prompt overlay...", "caseContext": "...a realistic mid-task context the agent resumes from...", "caseIntent": "...the task the judge scores against..."}',
  ].join('\n');
  const e = p.cheapExperiment;
  const user = [
    '## Proposal',
    `Framing: ${p.framing}`,
    `Mechanism: ${p.mechanism}`,
    `Bet: ${p.bet}`,
    e ? `Cheap experiment — hypothesis: ${e.hypothesis}; method: ${e.method}; falsifiable signal: ${e.falsifiableSignal}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return { system, user };
}

/**
 * LLM-generate a sharp replay experiment request from a proposal, falling back to the
 * mechanical mapping on any failure. Always `dryRun:true` (the dispatch enforces it too).
 */
export async function generateExperimentRequest(
  p: Proposal,
  llmCall: ScoutLlmCall,
  opts: { model?: string; thinkingBudgetTokens?: number } = {},
): Promise<RunExperimentInput> {
  try {
    const { system, user } = buildGenerateExperimentPrompt(p);
    const thinkingBudgetTokens = opts.thinkingBudgetTokens ?? 2048;
    const res = await llmCall({
      model: opts.model ?? DEFAULT_EXPERIMENT_GEN_MODEL,
      system,
      messages: [{ role: 'user', content: user }],
      responseFormat: 'json',
      thinkingBudgetTokens,
      // Server-side thinking headroom (EI-13119 class — see ideators.ts).
      maxTokens: thinkingBudgetTokens + 8192,
    });
    const parsed = parseGen(parseLlmJson(res));
    if (parsed) {
      return {
        testId: 'replay',
        batteryId: `scout:${p.id}`,
        arms: [
          { id: 'baseline', knobs: {} },
          { id: 'candidate', label: (p.framing || p.id).slice(0, 80), knobs: { 'overlay.systemOverlay': parsed.overlay.slice(0, OVERLAY_CAP) } },
        ],
        cases: [{ caseId: p.id, context: parsed.caseContext || p.framing || p.mechanism, intent: parsed.caseIntent }],
        repeats: 1,
        dryRun: true,
      };
    }
  } catch {
    // Any failure → the mechanical mapping below (the rail never breaks).
  }
  return proposalToExperimentRequest(p);
}
