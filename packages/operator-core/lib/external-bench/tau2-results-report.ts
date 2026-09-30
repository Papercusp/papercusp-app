/**
 * tau2-results-report.ts — adapt a standalone tau2-bench run's `results.json` into the canonical
 * {@link TaskRunResult} rows + run the capability-injection attribution + fairness audit on them
 * (plan benchmark-capability-injection-redesign-2026-06-17, P-009 + P-011).
 *
 * A `pc_run.sh` invocation writes `data/simulations/<save-to>/results.json` (NOT the PG
 * benchmark_run_result table that `buildRunCapabilityAttribution` reads). This bridges that gap: given the
 * vanilla + +memory arms' results.json, map each simulation → a TaskRunResult row (reward → resolved/score,
 * agent+user cost → costUsd, trial → seed), then produce the fair per-capability attribution
 * ({@link buildCapabilityAttribution}, pass@1 AND meanScore for the partial-credit reward) + the mandatory
 * C1-C10 fairness audit ({@link buildFairnessAudit}) + a markdown report. So a real tau2 run lands the
 * vanilla-vs-+memory lift through the SAME fair-reporting path as every other suite.
 *
 * The mapping is pure (no IO) so it unit-tests with synthetic results.json; the CLI reads the files.
 */
import type { ArmId, BenchSuite, CapabilityAttributionReport, FairnessAudit, TaskRunResult } from '@papercusp/bench-metrics';
import {
  buildCapabilityAttribution,
  buildFairnessAudit,
  formatAttributionLines,
  formatFairnessAuditMarkdown,
  formatPerInstanceMatrix,
} from '@papercusp/bench-metrics';

/** The slice of a tau2 simulation we read (other keys ignored). */
export interface Tau2Simulation {
  task_id?: string | number;
  trial?: number;
  seed?: number;
  agent_cost?: number;
  user_cost?: number;
  reward_info?: { reward?: number | null } | null;
  termination_reason?: string;
  messages?: unknown[];
}
export interface Tau2ResultsFile {
  info?: { max_steps?: number; agent_info?: Record<string, unknown> } | null;
  simulations?: Tau2Simulation[];
}

const TAU2_SUITE: BenchSuite = 'tau2-bench';

/** Strip a litellm provider prefix so the id matches the bench-metrics price table
 *  (`anthropic/claude-opus-4-8` → `claude-opus-4-8`; `claude-opus-4-8[1m]` is left intact for prefix-match). */
export function normalizeModelId(model: string): string {
  const slash = model.lastIndexOf('/');
  return slash >= 0 ? model.slice(slash + 1) : model;
}

/** Best-effort model id from results.json info.agent_info; falls back to the passed default. Normalized to
 *  the price-table id so the cost layer (priceRun) resolves it. */
function readModel(results: Tau2ResultsFile, fallback: string): string {
  const ai = results.info?.agent_info as Record<string, unknown> | undefined;
  for (const k of ['llm', 'model', 'model_id']) {
    const v = ai?.[k];
    if (typeof v === 'string' && v.length > 0) return normalizeModelId(v);
  }
  return normalizeModelId(fallback);
}

/**
 * Map one arm's tau2 results.json → canonical {@link TaskRunResult} rows. A simulation with no numeric reward
 * (a conversation that infra-failed) → an infra row (resolved=null, generationStatus='error') so the fairness
 * same-denominator headline counts it `false` rather than dropping it (C1/C6).
 */
export function tau2ResultsToRows(
  results: Tau2ResultsFile,
  arm: ArmId,
  opts: { runId: string; modelId?: string; createdAt?: string },
): TaskRunResult[] {
  const modelId = readModel(results, opts.modelId ?? 'claude-opus-4-8');
  const createdAt = opts.createdAt ?? '';
  return (results.simulations ?? []).map((s, i): TaskRunResult => {
    const reward = s.reward_info?.reward;
    const scored = typeof reward === 'number';
    const costUsd = (s.agent_cost ?? 0) + (s.user_cost ?? 0);
    return {
      runId: opts.runId,
      suite: TAU2_SUITE,
      modality: 'interactive',
      taskId: String(s.task_id ?? i),
      arm: String(arm),
      seed: typeof s.trial === 'number' ? s.trial : 0,
      resolved: scored ? reward === 1 : null,
      graderStatus: scored ? (reward === 1 ? 'passed' : 'failed') : 'error',
      graderFamily: 'tau2',
      graderVersion: 'tau2-bench',
      score: scored ? reward : null,
      tokensIn: 0,
      tokensOut: 0,
      tokensTotal: 0,
      costUsd,
      priceTableVersion: 'tau2-results',
      wallClockMs: 0,
      turns: Array.isArray(s.messages) ? s.messages.length : 0,
      budgetTokens: null, // tau2 is step-capped (max_steps), not token-capped → C3 reports best-effort + cost.
      capped: false,
      generationStatus: scored ? 'completed' : 'error',
      modelId,
      harnessVersion: 'tau2-bench',
      preregHash: opts.runId,
      rolloutId: `${arm}-${String(s.task_id ?? i)}-${s.trial ?? 0}`,
      createdAt,
    };
  });
}

/** Per-arm tau2 rollup (the suite's native headline: mean reward + pass^1 over scored conversations). */
export interface Tau2ArmRollup {
  arm: ArmId;
  scored: number;
  infra: number;
  avgReward: number;
  passAt1: number;
}

function rollupArm(rows: TaskRunResult[]): Tau2ArmRollup {
  const scored = rows.filter((r) => typeof r.score === 'number');
  const avgReward = scored.length ? scored.reduce((s, r) => s + (r.score as number), 0) / scored.length : 0;
  const passAt1 = scored.length ? scored.filter((r) => r.resolved === true).length / scored.length : 0;
  return { arm: String(rows[0]?.arm ?? '?'), scored: scored.length, infra: rows.length - scored.length, avgReward, passAt1 };
}

export interface Tau2ComparisonReport {
  runId: string;
  rows: TaskRunResult[];
  rollups: Tau2ArmRollup[];
  /** pass@1 attribution (reward===1 as the boolean headline) + meanScore attribution (the partial-credit reward). */
  attributionPassAt1: CapabilityAttributionReport;
  attributionMeanScore: CapabilityAttributionReport;
  audit: FairnessAudit;
  markdown: string;
}

/**
 * Run the full vanilla-vs-+memory comparison from the two arms' results.json: canonical rows → fair
 * attribution (both metrics) → fairness audit → markdown. The control is `vanilla` (the bare-model arm).
 */
export function reportTau2Comparison(input: {
  vanilla: Tau2ResultsFile;
  memory: Tau2ResultsFile;
  runId: string;
  modelId?: string;
}): Tau2ComparisonReport {
  const vanillaRows = tau2ResultsToRows(input.vanilla, 'vanilla', { runId: input.runId, modelId: input.modelId });
  const memoryRows = tau2ResultsToRows(input.memory, '+memory', { runId: input.runId, modelId: input.modelId });
  const rows = [...vanillaRows, ...memoryRows];
  const rollups = [rollupArm(vanillaRows), rollupArm(memoryRows)];
  const attributionPassAt1 = buildCapabilityAttribution(rows, { control: 'vanilla', metric: 'passAt1' });
  const attributionMeanScore = buildCapabilityAttribution(rows, { control: 'vanilla', metric: 'meanScore' });
  const audit = buildFairnessAudit(rows);

  const md: string[] = [];
  md.push(`# tau2-bench — vanilla vs +memory (run \`${input.runId}\`)`);
  md.push('');
  md.push('## Per-arm headline (tau2 native: mean reward + pass^1 over scored conversations)');
  md.push('| arm | scored | infra | avg_reward | pass^1 |');
  md.push('|---|---|---|---|---|');
  for (const r of rollups) md.push(`| \`${r.arm}\` | ${r.scored} | ${r.infra} | ${r.avgReward.toFixed(3)} | ${(r.passAt1 * 100).toFixed(1)}% |`);
  md.push('');
  md.push('## Capability attribution — +memory over vanilla (fair, same-denominator)');
  md.push('**pass@1 (reward===1):**');
  for (const l of formatAttributionLines(attributionPassAt1)) md.push(`- ${l}`);
  md.push('**meanScore (partial-credit reward):**');
  for (const l of formatAttributionLines(attributionMeanScore)) md.push(`- ${l}`);
  md.push('');
  md.push(formatFairnessAuditMarkdown(audit));
  md.push('');
  md.push(formatPerInstanceMatrix(rows, { metric: 'meanScore' }));
  md.push('');
  md.push('## Caveats');
  for (const c of attributionMeanScore.caveats) md.push(`- ${c}`);

  return { runId: input.runId, rows, rollups, attributionPassAt1, attributionMeanScore, audit, markdown: md.join('\n') };
}
