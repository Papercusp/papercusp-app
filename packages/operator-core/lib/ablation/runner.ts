/**
 * The shadow-ablation cycle runner (self-learning-frontier P-023 / FB-09 —
 * prompt sedimentology). One cycle =
 *
 *   1. snapshot the SU playbook body (the exact text the llm-testing `su`
 *      target feeds the SUT) and segment it into rule units (rules.ts);
 *   2. pick ONE rule — least-recently-ablated rotation over the store;
 *   3. run every selected `su` scenario twice: a 'snapshot-baseline' arm and
 *      an 'ablate:<rule>' arm. BOTH arms ride the target's systemPromptText
 *      variant seam carrying the same body snapshot (the ablated arm minus the
 *      rule), so the arms differ ONLY in the removed rule — never in disk
 *      state, framing, or cache shape;
 *   4. score the behavioral delta (scoring.ts) and persist one evidence row
 *      (store.ts) with the D-003 attribution context: recent behavior-change-
 *      ledger rows, so a delta is readable against whatever prompt mutations
 *      were live that week.
 *
 * SHADOW-ONLY BY CONSTRUCTION: this module never writes a prompt file, never
 * calls the prompts API, and never records to the behavior-change ledger
 * (shadow runs mutate nothing — change-ledger.ts's 'ablation' source is
 * reserved for a future LIVE ablation seam that does not exist in this lane).
 * Run rows are origin='shadow' (D-002).
 *
 * Shadow runs deliberately use STRIPPED runner deps (shadowRunnerDeps):
 * no `store` (a shadow run must not pollute harness_shared.llm_test_runs
 * trend lines) and no `claim` (it must not contend with real CI runs over the
 * scenario claim ledger — both arms share the scenario's identityHash).
 *
 * Spend is capped per cycle (`maxCycleCostUsd` — the governor's per-cycle
 * budget): the loop stops opening new scenario pairs once realized cost
 * crosses the cap and the row records `capped: true`.
 */

import type { RunnerDeps, RunReport, Scenario, ScenarioVariant } from '@papercusp/testing-shell/llm';
import { meanCostScorer, passRateScorer, runScenario } from '@papercusp/testing-shell/llm';
import type { Sql } from 'postgres';

import { readRecentChanges } from '../change-ledger/change-ledger';
import { operatorRunnerDeps } from '../llm-testing/deps';
import { getScenariosForTarget } from '../llm-testing/scenarios';
import { loadPlaybookBody, SU_PLAYBOOK_FRAMING } from '../llm-testing/targets/su';
import { ablateRule, extractAblatableRules, hashPlaybookBody, type AblatableRule } from './rules';
import {
  DEFAULT_ABLATION_THRESHOLDS,
  scoreAblationCycle,
  type AblationCycleScore,
  type AblationThresholds,
  type ArmMetrics,
  type ScenarioArmOutcome,
} from './scoring';
import { insertAblationRun, lastAblatedAtByRule, type InsertAblationRunInput } from './store';
import { resolveLearningPotSlug } from '../learning/pot-scope';
import { LEARNING_MODEL_SPEC } from '../learning/model-policy';

/** The repo-relative canonical blueprint identity recorded on every run row. */
export const SU_PLAYBOOK_REPO_PATH = 'libs/papercusp/packages/harness/blueprints/base/prompts/su.md';

/** Reserved arm ids (run-row detail vocabulary). */
export const SNAPSHOT_BASELINE_VARIANT = 'snapshot-baseline';

export interface AblationCycleConfig {
  workspaceId: string;
  /** Restrict to these scenario ids (default: every registered `su` scenario). */
  scenarioIds?: string[];
  /** Matrix repeat per arm (default 1 — weekly evidence accumulates across cycles instead). */
  repeat?: number;
  /** Hard per-cycle spend cap (USD) — the governor's per-cycle budget. Omit = uncapped (supervised runs only). */
  maxCycleCostUsd?: number | null;
  /** Ablate THIS rule instead of the rotation pick (payload override / supervised runs). */
  ruleKey?: string;
  /** D-003 attribution window for the ledger context (default 14 days). */
  ledgerWindowDays?: number;
  thresholds?: Partial<AblationThresholds>;
}

/** Injectable seams — every default is the production wiring, every test fakes them. */
export interface AblationCycleDeps {
  loadBody?: () => string | Promise<string>;
  scenarios?: () => Scenario[];
  runScenarioFn?: typeof runScenario;
  /** LLM-capable runner deps for the arms (default shadowRunnerDeps()). */
  runnerDeps?: RunnerDeps;
  /** PG handle for the run store. Optional when both store seams are injected (hermetic tests). */
  sql?: Sql;
  /** Store seams (default: the real store.ts fns bound over `sql`). */
  insertRun?: (input: InsertAblationRunInput) => Promise<string>;
  lastAblatedAt?: (workspaceId: string) => Promise<Map<string, string>>;
  /** D-003 conditioning (default: change-ledger readRecentChanges, trimmed). Null = unavailable. */
  readLedgerContext?: (workspaceId: string, sinceMs: number) => Promise<unknown[] | null>;
  /**
   * The FB-06 replay-sample evidence leg (frontier:replay-landed). Absent
   * until lib/replay ships its scoring API; when wired it receives the same
   * snapshot the scenario legs measured and its result lands in replay_leg.
   */
  replayLeg?: (input: {
    workspaceId: string;
    rule: AblatableRule;
    body: string;
    ablatedBody: string;
  }) => Promise<unknown | null>;
  nowMs?: () => number;
  log?: (msg: string) => void;
}

export interface AblationCycleResult {
  runRowId: string;
  ruleKey: string;
  ruleHash: string;
  ruleLead: string;
  score: AblationCycleScore;
  costUsd: number;
  capped: boolean;
  replayLegRan: boolean;
}

/**
 * Runner deps for SHADOW arms: the operator's LLM/judge/sim wiring WITHOUT the
 * llm_test_runs store and WITHOUT the scenario claim ledger (see module doc).
 */
export function shadowRunnerDeps(): RunnerDeps {
  const { claim: _claim, store: _store, ...rest } = operatorRunnerDeps({ persist: false });
  return rest;
}

/** Mean judge score per rubric axis across a report's matrix runs. */
function judgeAxisMeans(report: RunReport): Record<string, number> {
  const sums = new Map<string, { total: number; n: number }>();
  for (const run of report.runs) {
    for (const [axis, score] of Object.entries(run.judge?.scores ?? {})) {
      if (typeof score !== 'number') continue;
      const cell = sums.get(axis) ?? { total: 0, n: 0 };
      cell.total += score;
      cell.n += 1;
      sums.set(axis, cell);
    }
  }
  const means: Record<string, number> = {};
  for (const [axis, { total, n }] of sums) means[axis] = total / n;
  return means;
}

function armMetrics(report: RunReport): ArmMetrics {
  const out: ArmMetrics = { judgeAxes: judgeAxisMeans(report) };
  const passRate = passRateScorer.score(report);
  if (passRate !== undefined) out.passRate = passRate;
  const meanCost = meanCostScorer.score(report);
  if (meanCost !== undefined) out.meanCostUsd = meanCost;
  return out;
}

function reportCostUsd(report: RunReport): number {
  return report.runs.reduce((s, r) => s + (r.summary?.totalCostUsd ?? 0), 0);
}

/** Rotation: unseen rules first (file order), then the stalest last-ablated. */
export function pickRuleForRotation(
  rules: readonly AblatableRule[],
  lastAblatedAt: ReadonlyMap<string, string>,
): AblatableRule {
  if (rules.length === 0) throw new Error('prompt-ablation: no ablatable rules extracted from the playbook');
  const unseen = rules.find((r) => !lastAblatedAt.has(r.ruleKey));
  if (unseen) return unseen;
  return [...rules].sort((a, b) => {
    const la = lastAblatedAt.get(a.ruleKey)!;
    const lb = lastAblatedAt.get(b.ruleKey)!;
    return la < lb ? -1 : la > lb ? 1 : a.ruleKey.localeCompare(b.ruleKey);
  })[0]!;
}

async function defaultLedgerContext(workspaceId: string, sinceMs: number): Promise<unknown[] | null> {
  try {
    const rows = await readRecentChanges(workspaceId, { sinceMs, limit: 50 });
    return rows.map((r) => ({
      source: r.source,
      mutationClass: r.mutationClass,
      target: r.target,
      recordedAt: r.recordedAt,
      summary: r.summary,
    }));
  } catch {
    return null;
  }
}

export async function runAblationCycle(
  cfg: AblationCycleConfig,
  deps: AblationCycleDeps,
): Promise<AblationCycleResult> {
  const log = deps.log ?? ((m: string) => console.log(`[prompt-ablation] ${m}`));
  const nowMs = deps.nowMs ?? (() => Date.now());
  const loadBody = deps.loadBody ?? loadPlaybookBody;
  const listScenarios = deps.scenarios ?? (() => getScenariosForTarget('su'));
  const run = deps.runScenarioFn ?? runScenario;
  const runnerDeps = deps.runnerDeps ?? shadowRunnerDeps();
  const readLedger = deps.readLedgerContext ?? defaultLedgerContext;
  const requireSql = (): Sql => {
    if (!deps.sql) throw new Error('prompt-ablation: deps.sql is required when store seams are not injected');
    return deps.sql;
  };
  const insertRun = deps.insertRun ?? ((input: InsertAblationRunInput) => insertAblationRun(requireSql(), input));
  const lastAblatedAt =
    deps.lastAblatedAt ?? ((workspaceId: string) => lastAblatedAtByRule(requireSql(), workspaceId));
  const thresholds: AblationThresholds = { ...DEFAULT_ABLATION_THRESHOLDS, ...cfg.thresholds };
  const startedAtMs = nowMs();

  // 1. Snapshot + segment.
  const body = await loadBody();
  const playbookHash = hashPlaybookBody(body);
  const rules = extractAblatableRules(body);

  // 2. Pick the rule.
  let rule: AblatableRule;
  if (cfg.ruleKey) {
    const found = rules.find((r) => r.ruleKey === cfg.ruleKey);
    if (!found) throw new Error(`prompt-ablation: ruleKey '${cfg.ruleKey}' not found in the current playbook`);
    rule = found;
  } else {
    rule = pickRuleForRotation(rules, await lastAblatedAt(cfg.workspaceId));
  }
  const ablatedBody = ablateRule(body, rule);
  log(
    `cycle: ablating '${rule.ruleKey}' (${rule.contentHash}) — ${rules.length} rules in rotation, ` +
      `playbook ${playbookHash}`,
  );

  // 3. Run the arms. Both ride the systemPromptText seam so they share the
  //    exact snapshot; the no-variant path would re-read disk per process and
  //    could drift mid-cycle.
  const baselineVariant: ScenarioVariant = {
    id: SNAPSHOT_BASELINE_VARIANT,
    configDelta: { systemPromptText: SU_PLAYBOOK_FRAMING + body },
  };
  const ablatedVariant: ScenarioVariant = {
    id: `ablate:${rule.ruleKey}`,
    configDelta: { systemPromptText: SU_PLAYBOOK_FRAMING + ablatedBody },
  };

  const wanted = cfg.scenarioIds?.length
    ? listScenarios().filter((s) => cfg.scenarioIds!.includes(s.id))
    : listScenarios();
  if (wanted.length === 0) throw new Error('prompt-ablation: no su scenarios selected');

  const cap = cfg.maxCycleCostUsd ?? null;
  const repeat = cfg.repeat ?? 1;
  let costUsd = 0;
  let capped = false;
  const outcomes: ScenarioArmOutcome[] = [];

  const runArm = async (scenario: Scenario, variant: ScenarioVariant): Promise<ArmMetrics> => {
    try {
      const report = await run(
        scenario,
        {
          forceRepeat: repeat,
          variant,
          sutModel: LEARNING_MODEL_SPEC,
          judgeModel: LEARNING_MODEL_SPEC,
          simModel: LEARNING_MODEL_SPEC,
        },
        runnerDeps,
      );
      costUsd += reportCostUsd(report);
      return armMetrics(report);
    } catch (err) {
      return { error: (err as Error).message };
    }
  };

  for (const scenario of wanted) {
    if (cap !== null && costUsd >= cap) {
      capped = true;
      log(`budget cap $${cap} reached after ${outcomes.length}/${wanted.length} scenarios — stopping (capped)`);
      break;
    }
    const baseline = await runArm(scenario, baselineVariant);
    const ablated = await runArm(scenario, ablatedVariant);
    outcomes.push({ scenarioId: scenario.id, baseline, ablated });
  }

  // 4. Score + the optional FB-06 replay leg + persist.
  const score = scoreAblationCycle(outcomes, thresholds);
  let replayLeg: unknown | null = null;
  if (deps.replayLeg) {
    try {
      replayLeg = await deps.replayLeg({ workspaceId: cfg.workspaceId, rule, body, ablatedBody });
    } catch (err) {
      log(`replay leg failed (scenario evidence stands alone this cycle): ${(err as Error).message}`);
    }
  }
  const ledgerContext = await readLedger(
    cfg.workspaceId,
    startedAtMs - (cfg.ledgerWindowDays ?? 14) * 24 * 60 * 60 * 1000,
  );

  const excerpt = `${rule.lead} — ${rule.text.replace(/\s+/g, ' ').slice(0, 200)}`;
  // P-002 pot-scope: a playbook ablation has no harness grain — it scopes to the
  // process's home pot (env), or null for a genuinely pot-less host (D-002).
  const potSlug = await resolveLearningPotSlug({ workspaceId: cfg.workspaceId });
  const runRowId = await insertRun({
    workspaceId: cfg.workspaceId,
    startedAtMs,
    playbookPath: SU_PLAYBOOK_REPO_PATH,
    playbookHash,
    ruleKey: rule.ruleKey,
    ruleHash: rule.contentHash,
    ruleExcerpt: excerpt.slice(0, 300),
    scenarioCount: score.scenarioCount,
    baselinePassRate: score.baselinePassRate,
    ablatedPassRate: score.ablatedPassRate,
    passRateDelta: score.passRateDelta,
    verdict: score.verdict,
    capped,
    costUsd,
    ledgerContext,
    detail: {
      scenarios: outcomes,
      repeat,
      thresholds,
      judgeAxisDeltas: score.judgeAxisDeltas,
      regressions: score.regressions,
      improvements: score.improvements,
      ruleSpan: { startLine: rule.startLine, endLine: rule.endLine, section: rule.sectionHeading },
    },
    replayLeg,
    potSlug,
  });

  log(
    `cycle done: '${rule.ruleKey}' verdict=${score.verdict} ` +
      `pass-rate ${score.baselinePassRate?.toFixed(2) ?? '—'}→${score.ablatedPassRate?.toFixed(2) ?? '—'} ` +
      `(${score.measurableCount}/${score.scenarioCount} measurable) cost=$${costUsd.toFixed(2)}${capped ? ' CAPPED' : ''}`,
  );

  return {
    runRowId,
    ruleKey: rule.ruleKey,
    ruleHash: rule.contentHash,
    ruleLead: rule.lead,
    score,
    costUsd,
    capped,
    replayLegRan: replayLeg !== null,
  };
}
