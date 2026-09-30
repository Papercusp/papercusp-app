#!/usr/bin/env node
/**
 * llm-test — CLI for the LLM testing framework.
 *
 * Usage:
 *   pnpm llm-test --scenario <id>             run one scenario
 *   pnpm llm-test --target operator           run all scenarios for one target
 *   pnpm llm-test --list                      list scenarios + behaviors
 *   pnpm llm-test lint                        static scenario-registry validator
 *   pnpm llm-test --no-matrix                 force N=1 even when scenario declares more
 *   pnpm llm-test replay --fixture <id>       (Phase 1.5) re-evaluate stored fixture
 *   pnpm llm-test promote-candidates          (Phase 1.5) list novel_failure shapes ≥3×
 *
 * Reads ANTHROPIC_API_KEY from env. Persists results to PG via storage.ts.
 *
 * Plan §9.1, §12.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { runScenario, type ScenarioVariant } from '@papercusp/testing-shell/llm';

import { isLlmAvailable } from '@papercusp/operator-core/lib/llm-testing/llm-client';
import { operatorRunnerDeps } from '@papercusp/operator-core/lib/llm-testing/deps';
import { SCENARIOS, getScenario, listScenarioIds } from '@papercusp/operator-core/lib/llm-testing/scenarios';
import { listTargets } from '@papercusp/operator-core/lib/llm-testing/targets';
import { findPromotionCandidates, formatCandidatesReport } from '@papercusp/operator-core/lib/llm-testing/promotion/candidates';
import { promoteShape } from '@papercusp/operator-core/lib/llm-testing/promotion/promote';
import { replayFixture, reEvaluateRun } from '@papercusp/operator-core/lib/llm-testing/replay';
import { validateSuContracts } from '@papercusp/operator-core/lib/llm-testing/targets/su-contracts';
import { runScenarioBattery } from '@papercusp/operator-core/lib/llm-testing/battery-harness';
import {
  LLM_TEST_EXIT_NOTHING_RAN,
  llmTestExitCode,
  runSummaryLine,
  type ScenarioOutcome,
} from '@papercusp/operator-core/lib/llm-testing/run-exit-code';
import {
  beginLlmScenarioLedger,
  recordLlmScenarioTestRun,
  resolveScenarioSourceFile,
} from '@papercusp/operator-core/lib/llm-testing/test-run-ledger';

type Verb = 'run' | 'promote-candidates' | 'promote' | 'replay' | 'export-fixture' | 'lint';

interface Args {
  verb: Verb;
  scenarioId?: string;
  targetId?: string;
  shape?: string;
  fixture?: string;
  reEvaluate?: string;
  runId?: string;
  fixtureSlug?: string;
  noMatrix: boolean;
  list: boolean;
  noPersist: boolean;
  help: boolean;
  all: boolean;
  seed?: number;
  parallel?: number;
  /** Eval variant (test-gym-apiary P-001): inline JSON or @path/to/variant.json. */
  variant?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    verb: 'run',
    noMatrix: false,
    list: false,
    noPersist: false,
    help: false,
    all: false,
  };
  // First positional non-flag arg may be a verb.
  if (
    argv[0] === 'promote-candidates'
    || argv[0] === 'promote'
    || argv[0] === 'replay'
    || argv[0] === 'export-fixture'
    || argv[0] === 'lint'
  ) {
    args.verb = argv[0] as Verb;
    argv = argv.slice(1);
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--scenario': args.scenarioId = argv[++i]; break;
      case '--target': args.targetId = argv[++i]; break;
      case '--shape': args.shape = argv[++i]; break;
      case '--fixture': args.fixture = argv[++i]; break;
      case '--re-evaluate': args.reEvaluate = argv[++i]; break;
      case '--run': args.runId = argv[++i]; break;
      case '--as': args.fixtureSlug = argv[++i]; break;
      case '--no-matrix': args.noMatrix = true; break;
      case '--no-persist': args.noPersist = true; break;
      case '--list': args.list = true; break;
      case '--all': args.all = true; break;
      case '--seed': args.seed = Number(argv[++i]); break;
      case '--parallel': args.parallel = Math.max(1, Number(argv[++i])); break;
      case '--variant': args.variant = argv[++i]; break;
      case '-h':
      case '--help': args.help = true; break;
      default:
        if (a?.startsWith('-')) {
          console.error(`Unknown flag: ${a}`);
          process.exit(2);
        }
    }
  }
  return args;
}

/**
 * Parse `--variant` (test-gym-apiary P-001): inline JSON or `@path` to a JSON
 * file. Validates the minimal shape here so a malformed variant fails before
 * any LLM spend; per-target configDelta keys are validated by the target.
 */
function parseVariantArg(raw: string | undefined): ScenarioVariant | undefined {
  if (!raw) return undefined;
  const text = raw.startsWith('@') ? readFileSync(raw.slice(1), 'utf8') : raw;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (err) {
    console.error(`--variant: invalid JSON (${(err as Error).message})`);
    process.exit(2);
  }
  const obj = v as Partial<ScenarioVariant>;
  if (!obj || typeof obj !== 'object' || typeof obj.id !== 'string' || !obj.id.trim()) {
    console.error('--variant: must be a JSON object with a non-empty string `id`');
    process.exit(2);
  }
  if (obj.promptOverlay !== undefined && typeof obj.promptOverlay !== 'string') {
    console.error('--variant: `promptOverlay` must be a string when present');
    process.exit(2);
  }
  if (obj.configDelta !== undefined && (typeof obj.configDelta !== 'object' || obj.configDelta === null || Array.isArray(obj.configDelta))) {
    console.error('--variant: `configDelta` must be an object when present');
    process.exit(2);
  }
  if (obj.promptOverlay === undefined && obj.configDelta === undefined) {
    console.error('--variant: needs at least one of `promptOverlay` / `configDelta` (a variant with neither IS the baseline — just omit --variant)');
    process.exit(2);
  }
  return obj as ScenarioVariant;
}

function usage(): void {
  console.log(`llm-test — LLM testing framework

Usage:
  llm-test --scenario <id>            Run a single scenario
  llm-test --target operator          Run every scenario for a target
  llm-test --all                      Run every scenario across all targets
  llm-test --list                     List scenarios + targets
  llm-test --no-matrix                Force N=1 (overrides runMatrix.repeat)
  llm-test --no-persist               Skip PG persistence (printing only)
  llm-test --seed <n>                 Determinism hint: forces sim-user
                                      temperature to 0 (SDK has no seed
                                      param; this is the closest we get).
  llm-test --parallel <n>             Batch scenarios into Promise.all
                                      groups of size N. Bounded by SUT
                                      single-flight per conversationId.
  llm-test --variant <json|@file>     Eval variant knob (test-gym-apiary
                                      P-001): run the scenario(s) WITH a
                                      runtime-injected variant — JSON
                                      {id, promptOverlay?, configDelta?}
                                      inline or @path to a .json file.
                                      The target must support variants
                                      (the runner fails loudly otherwise).
                                      Omit for the baseline run.

  llm-test lint                       Static scenario-registry validator —
                                      assert kinds, persona refs, rubric
                                      shape, trigger values, scripted-
                                      trigger params vs caps, fixture
                                      paths, etc. No LLM calls. Exits
                                      non-zero on any error.
  llm-test lint --scenario <id>       Lint one scenario.
  llm-test lint --target <id>         Lint every scenario for a target.

  llm-test promote-candidates         List novel_failure shapes seen
                                      in ≥3 scenarios over the last 14d
  llm-test promote --shape <hash>     Scaffold an asserts/<id>.ts stub
                                      from a candidate shape

  llm-test replay --fixture <id> --scenario <id>
                                      Re-evaluate a stored .sse fixture
                                      (+ optional sibling .telemetry.json)
                                      against the current rubric.
                                      No SUT or sim-user calls — just
                                      asserts + judge. ~$0.10/run.

  llm-test replay --re-evaluate <run-uuid> --scenario <id>
                                      Re-judge a historical run row
                                      (e.g. after a rubric edit).

  llm-test export-fixture --run <uuid> --as <slug>
                                      Export a stored run as a paired
                                      <slug>.sse + <slug>.telemetry.json
                                      under fixtures/operator/. Used to
                                      freeze a good (or bad) transcript
                                      for replay-driven regression.

Env:
  ANTHROPIC_API_KEY                   Required (sim-user + judge). Falls
                                      back to
                                      harness_shared.operator_credentials
                                      .anthropic_api_key when unset.
  PAPERCUSP_LLM_TEST_SKIP_CLAIM=1     Skip the parallel-runner claim
                                      ledger (unit tests without PG).
  PAPERCUSP_LLM_TEST_OPERATOR_URL     Operator HTTP origin the targets POST to
                                      (default http://127.0.0.1:3070).
                                      PAPERCUSP_OPERATOR_URL is honored as a
                                      fallback but reduced to its ORIGIN — its
                                      fleet-wide meaning is the MCP endpoint
                                      (…/api/mcp), not an API base.
  LLM_TEST_SUT_MODEL                  Override SUT model (default claude-sonnet-4-6)
  LLM_TEST_JUDGE_MODEL                Override judge model (default claude-sonnet-4-6)
  LLM_TEST_SIM_MODEL                  Override sim-user model (default claude-haiku-4-5)

Plan: apps/operator/docs/plans/llm-testing-framework-2026-05-14.md
`);
}

/**
 * EI-2743: `run`/`replay` are the only verbs that make LLM calls — the SUT
 * (targets/su.ts's in-process anthropic-direct transport), sim-user, and judge
 * (llm-client.ts → chat-stream.ts) all egress DIRECT to api.anthropic.com on the
 * single `~/.claude` OAuth credential unless `PAPERCUSP_ANTHROPIC_URL` /
 * `ANTHROPIC_BASE_URL` point them at the localhost pacing gateway — this CLI is
 * the ONE call site for `runScenario` (ad-hoc, the nightly matrix via
 * llm-test-nightly.sh, AND the delta-gate's S23/S24/S25 Lane-C proof runs), so a
 * missing patch here 429s every one of those on one account's cap while the
 * pooled gateway accounts sit idle (spawn-env.ts D-011) — observed twice trying
 * to record the Lane-C de-risk verdict for agent-tool-delta-protocol. Same class
 * as gym/autoloop-cycle.ts + scout/register-scout-action.ts. Flag-OFF leaves env
 * untouched; the enabled path preserves deliberate custom endpoints but replaces
 * an inherited public api.anthropic.com default.
 */
async function applyGatewayEnv(): Promise<void> {
  const { FLAGS } = await import('@papercusp/flags');
  const { getFlag } = await import('@papercusp/flags/server');
  if (await getFlag(FLAGS.INFERENCE_GATEWAY, 'system')) {
    const { applyGatewayLlmEnv, gatewayPort } = await import('@papercusp/operator-core/lib/inference-gateway/spawn-env');
    applyGatewayLlmEnv(true);
    console.log(`[llm-test] inference-gateway ON → routing LLM calls through http://127.0.0.1:${gatewayPort()}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return; }
  // Only the verbs that actually make LLM calls need the gateway patch —
  // lint/promote-candidates/promote/export-fixture/--list never call an LLM.
  if (args.verb === 'run' || args.verb === 'replay') {
    await applyGatewayEnv();
  }

  if (args.verb === 'lint') {
    const { lintScenarios, formatViolations } = await import('@papercusp/testing-shell/llm');
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const scope = args.scenarioId
      ? [getScenario(args.scenarioId)]
      : args.targetId
        ? SCENARIOS.filter((s) => s.target === args.targetId)
        : [...SCENARIOS];
    const genericViolations = lintScenarios(scope, {
      fileExists: (p) => existsSync(p),
      fixtureRoot: resolve(__dirname, '../lib/llm-testing'),
      // The lib lint skips the target-registration check when this is absent;
      // pass the operator's registry so unknown-target scenarios still error
      // (matches the pre-P-073 behavior, which imported listTargets directly).
      registeredTargets: listTargets(),
    });
    const violations = [...genericViolations, ...await validateSuContracts(scope)];
    console.log(formatViolations(violations));
    process.exit(violations.some((v) => v.severity === 'error') ? 1 : 0);
  }

  if (args.verb === 'promote-candidates') {
    const cs = await findPromotionCandidates();
    console.log(formatCandidatesReport(cs));
    return;
  }

  if (args.verb === 'promote') {
    if (!args.shape) {
      console.error('promote requires --shape <hash>. Use `llm-test promote-candidates` to find one.');
      process.exit(2);
    }
    const result = await promoteShape(args.shape);
    console.log(`Promoted shape ${args.shape.slice(0, 12)}…`);
    console.log(`  Created: ${result.filePath}`);
    console.log(`  Linked findings: ${result.findingsLinkedCount}`);
    console.log(`  Example claim: ${result.exampleClaim.slice(0, 100)}`);
    console.log(`\nNext: implement the predicate in the stub, then reference it`);
    console.log(`from a scenario with { kind: 'custom', name: '${result.assertId}', eval: evaluate }`);
    return;
  }

  if (args.verb === 'export-fixture') {
    if (!args.runId || !args.fixtureSlug) {
      console.error('export-fixture requires --run <runId> and --as <fixture-slug>.');
      process.exit(2);
    }
    const { exportFixtureFromRun } = await import('@papercusp/operator-core/lib/llm-testing/replay');
    const result = await exportFixtureFromRun({ runId: args.runId, fixtureId: args.fixtureSlug });
    console.log(`exported run ${args.runId} → fixture '${args.fixtureSlug}'`);
    console.log(`  ${result.ssePath} (${result.bytesSse}B)`);
    console.log(`  ${result.telemetryPath} (${result.bytesTelemetry}B)`);
    console.log(`  ${result.transcriptPath} (${result.bytesTranscript}B)`);
    return;
  }

  if (args.verb === 'replay') {
    if (!args.scenarioId) {
      console.error('replay requires --scenario <id> (drives asserts + rubric).');
      process.exit(2);
    }
    if (!args.fixture && !args.reEvaluate) {
      console.error('replay requires --fixture <id|path> or --re-evaluate <run-uuid>.');
      process.exit(2);
    }
    if (!(await isLlmAvailable())) {
      console.error('ANTHROPIC_API_KEY required (replay still calls the judge).');
      process.exit(1);
    }
    const scenario = getScenario(args.scenarioId);
    const judgeModel = process.env.LLM_TEST_JUDGE_MODEL ?? 'claude-sonnet-4-6';

    const result = args.fixture
      ? await replayFixture({ fixture: args.fixture, scenario, judgeModel })
      : await reEvaluateRun({ runId: args.reEvaluate!, scenarioOverride: scenario, judgeModel });

    const icon = result.status === 'passed' ? '✓' : result.status === 'errored' ? '!' : '✗';
    console.log(`${icon} replay status=${result.status}`);
    console.log(`  scores: ${JSON.stringify(result.judge.scores)}`);
    console.log(`  asserts: ${result.violations.filter((v) => v.severity === 'error').length} error, ${result.violations.filter((v) => v.severity === 'warn').length} warn`);
    console.log(`  judge:   ${result.judge.findings.filter((f) => f.severity === 'error').length} error, ${result.judge.findings.filter((f) => f.severity === 'warn').length} warn`);
    for (const v of result.violations.filter((x) => x.severity === 'error')) {
      console.log(`    ✗ [${v.assertKind}] ${v.claim}`);
    }
    for (const f of result.judge.findings.filter((x) => x.severity === 'error').slice(0, 3)) {
      console.log(`    ✗ judge[${f.axis}]: ${f.claim}`);
    }
    process.exit(result.status === 'passed' ? 0 : 1);
  }

  if (args.list) {
    console.log('Targets:');
    for (const t of listTargets()) console.log(`  - ${t}`);
    console.log('\nScenarios:');
    for (const s of SCENARIOS) {
      console.log(`  - ${s.id}  [${s.target}]  ${s.description.slice(0, 80)}${s.description.length > 80 ? '...' : ''}`);
    }
    return;
  }

  if (!(await isLlmAvailable())) {
    console.error('ANTHROPIC_API_KEY is not set (env or harness_shared.operator_credentials).');
    process.exit(1);
  }

  const scenarios = args.scenarioId
    ? [getScenario(args.scenarioId)]
    : args.targetId
      ? SCENARIOS.filter((s) => s.target === args.targetId)
      : args.all
        ? [...SCENARIOS]
        : null;

  if (!scenarios) {
    console.error('Pass --scenario <id>, --target <id>, or --all. (See --list.)');
    process.exit(2);
  }
  if (scenarios.length === 0) {
    console.error('No scenarios match the filter.');
    process.exit(2);
  }

  const concurrency = Math.max(1, args.parallel ?? 1);
  if (concurrency > 1) {
    console.log(`[llm-test] --parallel ${concurrency} — up to ${concurrency} scenarios run at once.`);
  }

  // Operator seams for the generic runner. `--no-persist` omits the store seam
  // so the runner skips PG persistence; otherwise the runner persists each run
  // report once at end-of-run (it computes the scenario hash internally from
  // `scenarioFilePath`).
  const deps = operatorRunnerDeps({ persist: !args.noPersist });

  // Eval variant knob (test-gym-apiary-framework-2026-06-09 P-001): inline
  // JSON or @file. Parsed once; the runner gates target support per run.
  const variant = parseVariantArg(args.variant);
  if (variant) {
    console.log(`[llm-test] --variant '${variant.id}' (${[variant.promptOverlay && 'promptOverlay', variant.configDelta && 'configDelta'].filter(Boolean).join(' + ') || 'empty'})`);
  }

  const runOne = async (scenario: typeof scenarios[number], evidenceDir: string): Promise<ScenarioOutcome> => {
    const scenarioFilePath = resolveScenarioFilePath(scenario);
    process.stdout.write(`\n▶ ${scenario.id}  [${scenario.target}]\n`);
    let report;
    const ledgerBefore = args.noPersist ? null : beginLlmScenarioLedger();
    try {
      report = await runScenario(scenario, {
        forceRepeat: args.noMatrix ? 1 : undefined,
        scenarioFilePath,
        ...(args.seed !== undefined && { seed: args.seed }),
        ...(variant !== undefined && { variant }),
      }, deps);
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (msg.startsWith('claim_busy')) {
        process.stdout.write(`  ⊘ skipped [${scenario.id}]: ${msg}\n`);
        // Another runner is on it — not a FAILURE, but not a pass either: this
        // scenario measured nothing. The zero-executed guard below is what
        // keeps that from exiting 0 (EI-22032714687384561).
        return 'skipped';
      }
      console.error(`  ✗ runner error [${scenario.id}]: ${msg}`);
      return 'failed';
    }
    printReport(report);
    writeFileSync(join(evidenceDir, 'report-summary.json'), `${JSON.stringify(reportSummary(scenario.id, report), null, 2)}\n`);
    // A live-model run is the `llm` test layer; record it in the shared test ledger so
    // acceptance BARs requiring `llm` can bind to it (EI-24434635346407728).
    if (!args.noPersist) {
      const testRunId = await recordLlmScenarioTestRun(report, scenarioFilePath, ledgerBefore);
      process.stdout.write(testRunId === null
        ? `  ⚠ test_runs ledger row not recorded [${scenario.id}]\n`
        : `  ledger test_runs.id=${testRunId} layer=llm\n`);
    }
    // Verdict for the UI/PG ('preview' for single-run per plan §2.4);
    // exit-code from the per-run status so CI still flags single-run
    // failures.
    if (report.verdict === 'fail' || report.verdict === 'errored') return 'failed';
    return report.runs.some((r) => r.status === 'failed' || r.status === 'errored')
      ? 'failed'
      : 'executed';
  };

  // The battery runs through the verification-harness contract (EVL P-006): one phase per
  // scenario, one retained evidence dir per run, and a HARNESS_RESULT line naming the first
  // failing scenario. The exit code keeps its own semantics (nothing-ran is not a pass).
  const { outcomes, summaryLine } = await runScenarioBattery({ scenarios, concurrency, runScenario: runOne });
  console.log(`\n${summaryLine}`);

  const exitCode = llmTestExitCode(outcomes);
  if (outcomes.some((o) => o === 'skipped')) {
    console.log(`\n[llm-test] ${runSummaryLine(outcomes)}`);
  }
  if (exitCode === LLM_TEST_EXIT_NOTHING_RAN) {
    console.error(
      `[llm-test] NOTHING RAN — 0 of ${scenarios.length} requested scenario(s) executed. ` +
        `Exiting ${exitCode}: this is not a pass.`,
    );
  }
  process.exit(exitCode);
}

function resolveScenarioFilePath(scenario: { id: string; target: string }): string | undefined {
  // Strip the target prefix to recover the file basename.
  // Operator scenarios: 'op-S01-...' → files 'S01-...'
  // Oracle scenarios:   'oracle-O1-...' → files 'O1-...'
  // Architect:          'architect-A1-...' → files 'A1-...'
  const here = dirname(fileURLToPath(import.meta.url));
  // Scenarios live in operator-core. One file may define many scenarios (S33), so the id
  // is not the basename — resolveScenarioSourceFile maps it (EI-24434635346407728).
  return resolveScenarioSourceFile(
    scenario.id,
    scenario.target,
    join(here, '..', '..', '..', 'packages', 'operator-core', 'lib', 'llm-testing', 'scenarios'),
  );
}

/** The compact per-scenario record kept in the run's evidence dir (the full report is in PG). */
function reportSummary(scenarioId: string, report: ReturnType<typeof runScenario> extends Promise<infer R> ? R : never) {
  return {
    scenarioId,
    verdict: report.verdict,
    runs: report.runs.map((r) => ({
      status: r.status,
      costUsd: r.summary.totalCostUsd,
      turns: r.summary.turns.length,
      assertErrors: r.violations.filter((v) => v.severity === 'error').map((v) => `[${v.assertKind}] ${v.claim}`),
      judgeErrors: r.judge.findings.filter((f) => f.severity === 'error').map((f) => `${f.axis}: ${f.claim}`),
    })),
  };
}

function printReport(report: ReturnType<typeof runScenario> extends Promise<infer R> ? R : never): void {
  const verdict = report.verdict;
  const icon = verdict === 'pass' ? '✓' : verdict === 'preview' ? '○' : verdict === 'errored' ? '!' : '✗';
  console.log(`  ${icon} verdict=${verdict} (${report.runs.length} run${report.runs.length === 1 ? '' : 's'})`);
  for (let i = 0; i < report.runs.length; i++) {
    const r = report.runs[i];
    console.log(`     run #${i + 1} status=${r.status} cost=$${r.summary.totalCostUsd.toFixed(4)} turns=${r.summary.turns.length}`);
    const errs = r.violations.filter((v) => v.severity === 'error');
    const warns = r.violations.filter((v) => v.severity === 'warn');
    if (errs.length) console.log(`       asserts: ${errs.length} error / ${warns.length} warn`);
    const fErrs = r.judge.findings.filter((f) => f.severity === 'error');
    const fWarns = r.judge.findings.filter((f) => f.severity === 'warn');
    if (fErrs.length || fWarns.length) {
      console.log(`       judge:   ${fErrs.length} error / ${fWarns.length} warn`);
    }
    for (const a of errs) {
      console.log(`         ✗ [${a.assertKind}] ${a.claim}`);
    }
    for (const f of fErrs.slice(0, 3)) {
      console.log(`         ✗ judge[${f.axis}]: ${f.claim}`);
    }
  }
  if (Object.keys(report.varianceByAxis).length > 0) {
    const high = Object.entries(report.varianceByAxis).filter(([, v]) => v > 0.5);
    if (high.length > 0) {
      console.log(`     variance: ${high.map(([k, v]) => `${k}=${v.toFixed(2)}`).join(', ')}`);
    }
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
