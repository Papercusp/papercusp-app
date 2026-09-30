/**
 * report-core.ts — the scored what-would-have-helped report regret mining
 * files into the idea queue (self-learning-frontier-2026-06-12 P-021 / FB-07).
 *
 * One report per mined session, filed through the shared capture core as a
 * kind=change improvement with origin='replay' (D-002: every consumer
 * filters to organic unless opted in — a regret report never pollutes the
 * organic learners). watchdogKey `regret:<runId>` + dedupScope 'open' is the
 * anti-flood rail; report_improvement_id on the finding row is the local
 * never-re-file belt (the FB-04 carry-forward rule).
 *
 * Filing bar: a report files only once the replay leg has PRICED the
 * candidates (P-021: "counterfactual replay … output is a scored report") —
 * best improvementScore ≥ minFileScore. Detection alone never files.
 */

import type { CandidateChange, CandidateReplayScore } from './counterfactual-core';

/**
 * improvementScore is (candidate − baseline) mean judge composite as a
 * fraction of the 10-point rubric scale — 0.1 = a full composite point
 * better than the original trajectory.
 */
export const MIN_FILE_IMPROVEMENT_SCORE = 0.1;

export function regretWatchdogKey(runId: string): string {
  return `regret:${runId}`;
}

/* ────────────────────────────────────────────────────────────────────────
 * Kind/taxonomy fidelity at the filing edge (frontier P-044 / FB-18, D-008)
 *
 * Two shapes leave this miner:
 *
 *   tool-error-loop        — the divergence is ≥N CONSECUTIVE failing calls
 *                            to concrete, named tools: a real erroring
 *                            surface with a clear correct state (those calls
 *                            don't error / the error is handled) and a
 *                            regression test (invoke the tool) → kind=bug.
 *   process-counterfactual — repeat-loop / burn-inflection / rescue-marker
 *                            divergences propose prompt/process changes
 *                            priced by replay; whether to adopt the rule is
 *                            a judgment call → kind=change (today's shape).
 * ──────────────────────────────────────────────────────────────────────── */

export type RegretFindingClass = 'regret:tool-error-loop' | 'regret:process-counterfactual';

export interface RegretClassification {
  kind: 'bug' | 'change';
  findingClass: RegretFindingClass;
  severity: 'major' | 'minor';
  /** The erroring tools pinned by the divergence evidence — tool-error-loop only. */
  errorTools: string[];
}

/** Pure shape classifier over the finding's divergence — pinned by unit tests. */
export function classifyRegretFinding(
  input: Pick<RegretReportInput, 'divergenceKind' | 'divergenceEvidence'>,
): RegretClassification {
  if (input.divergenceKind === 'error-loop') {
    const rawTools = (input.divergenceEvidence as { tools?: unknown } | null)?.tools;
    const errorTools = Array.isArray(rawTools) ? rawTools.filter((t): t is string => typeof t === 'string') : [];
    if (errorTools.length > 0) {
      return { kind: 'bug', findingClass: 'regret:tool-error-loop', severity: 'major', errorTools };
    }
  }
  return { kind: 'change', findingClass: 'regret:process-counterfactual', severity: 'minor', errorTools: [] };
}

/** The slice of a regret finding the report renders (store.RegretFindingRecord satisfies it). */
export interface RegretReportInput {
  runId: string;
  harnessSlug: string;
  role: string | null;
  badnessScore: number;
  badnessReasons: string[];
  divergenceTurn: number | null;
  divergenceKind: string | null;
  divergenceEvidence: Record<string, unknown> | null;
  candidateChanges: CandidateChange[];
  replayScores: CandidateReplayScore[] | null;
}

function shortRunId(runId: string): string {
  return runId.length > 24 ? `${runId.slice(0, 24)}…` : runId;
}

export function bestReplayScore(input: Pick<RegretReportInput, 'replayScores'>): CandidateReplayScore | null {
  let best: CandidateReplayScore | null = null;
  for (const s of input.replayScores ?? []) if (best === null || s.improvementScore > best.improvementScore) best = s;
  return best;
}

export function regretReportTitle(input: RegretReportInput): string {
  const classification = classifyRegretFinding(input);
  if (classification.findingClass === 'regret:tool-error-loop') {
    return `Tool error loop: ${classification.errorTools.join(', ')} failed repeatedly in a ${
      input.role ?? 'agent'
    } session`;
  }
  const best = bestReplayScore(input);
  const change = input.candidateChanges.find((c) => c.id === best?.candidateId);
  return `Regret: ${input.role ?? 'agent'} session diverged (${input.divergenceKind ?? 'unknown'}) — ${
    change?.title ?? 'what would have helped'
  }`;
}

export function regretReportBody(input: RegretReportInput): string {
  const best = bestReplayScore(input);
  const lines: string[] = [
    `Regret-mining report for run \`${input.runId}\` (${input.role ?? 'unknown role'}, harness ${input.harnessSlug}).`,
    '',
    `**Why this session:** ${input.badnessReasons.join(', ')} (badness ${input.badnessScore.toFixed(2)})`,
    `**Divergence:** turn ${input.divergenceTurn ?? '?'}, ${input.divergenceKind ?? 'unknown'} — evidence: ${JSON.stringify(
      input.divergenceEvidence ?? {},
    )}`,
    '',
    '**Counterfactual replay scores** (0..1, higher = the change helped more):',
    '',
  ];
  for (const change of input.candidateChanges) {
    const score = (input.replayScores ?? []).find((s) => s.candidateId === change.id);
    lines.push(
      `- \`${change.id}\` — ${change.title}: ` +
        (score ? `**${score.improvementScore.toFixed(2)}** — ${score.summary}` : 'not replayed'),
    );
  }
  const classification = classifyRegretFinding(input);
  if (classification.findingClass === 'regret:tool-error-loop') {
    lines.push(
      '',
      `**Correct state** (kind-fidelity per frontier P-044): consecutive calls to ` +
        `${classification.errorTools.map((t) => `\`${t}\``).join(', ')} must not keep erroring — either the ` +
        `tool's failure is a real bug to fix, or its error response must carry enough signal that an agent ` +
        `stops retrying. Regression test: the failing call shape from the divergence evidence.`,
    );
  }
  lines.push(
    '',
    `Proposed rule (best candidate): ${input.candidateChanges.find((c) => c.id === best?.candidateId)?.promptDelta ?? 'n/a'}`,
    '',
    `_origin=replay (D-002); filed by system:regret-mine over run ${shortRunId(input.runId)}._`,
  );
  return lines.join('\n');
}
