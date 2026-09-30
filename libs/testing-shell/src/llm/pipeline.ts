/**
 * PipelineTarget / InvokeTarget — the framework extension P-030 calls for
 * (plan harness-test-coverage-for-launch).
 *
 * The conversational LLM-testing framework (types.ts `ChatTarget`, runner.ts)
 * drives a multi-turn SimUser↔SUT chat and judges the transcript. That shape
 * fits the chat surfaces (operator / oracle / architect) but NOT the pipeline
 * roles (scoper / worker / validator / reviewer / test-writer): those are
 * headless, invoke-once agents whose product is SIDE EFFECTS — files written
 * to the workspace, a feature-status change, and a final stdout decision — not
 * an assistant chat turn. There is no user to simulate and no `send()` loop.
 *
 * This module is the complementary target kind: run ONE pipeline role
 * invoke-once against a seeded harness, capture (stdout, exit, files-written,
 * feature outcome), evaluate pipeline-shaped deterministic asserts, and
 * (on-demand) judge the work with the shipped judge. Like every LLM scenario
 * the live run needs model credentials, so the deliverable in CI is
 * author + register + lint + the deterministic capture-mechanics test below
 * (which injects a stub role-runner — no real agent, no real model).
 *
 * Relationship to the harness gym (`lib/gym/`): the gym runs the WHOLE pipeline
 * to terminal to OPTIMIZE prompts; this runs a SINGLE role to ASSERT its
 * behavior. Both could later share one hermetic-run primitive (coordinated with
 * the gym owner); kept separate + lightweight here so single-role behavioral
 * scenarios don't pull in the gym's substrate-clone optimizer machinery.
 */
import type { JudgeRubric, JudgeResult, Violation } from './types';

// =============================================================================
// Role run — the unit a PipelineTarget produces
// =============================================================================

export interface RoleRunInput {
  /** Pipeline role to invoke (scoper, validator, reviewer, test-writer, …). */
  role: string;
  /** The throwaway harness the role runs against. */
  harnessSlug: string;
  /** The seeded feature the role acts on. */
  featureId: string;
  /** Per-run identity for telemetry / workspace isolation. */
  runId: string;
  /** Positional K=V extras passed to invoke-once (e.g. VAL_ID=…). */
  extras?: string[];
}

export interface RoleRunResult {
  /** The agent's final decision/output line(s) (timestamp-stripped stdout). */
  stdout: string;
  exitCode: number;
  /** Workspace-relative paths the role created or modified this run. */
  filesWritten: string[];
  /** The feature's status after the role ran (null if unchanged / unread). */
  featureStatus: string | null;
}

/**
 * Spawns one role invoke-once and captures its observable product. Injected so
 * the framework is testable with a stub (the capture-mechanics test) and the
 * REAL spawn (a seeded harness + `spawnInvokeOnce` + a workspace file diff) is
 * wired only for on-demand live runs — exactly the `setPipelineInvokeRunner`
 * seam pattern the DBOS workflow uses.
 */
export type RoleSpawner = (input: RoleRunInput) => Promise<RoleRunResult>;

// =============================================================================
// Scenario contract
// =============================================================================

/** Deterministic asserts over a single role run — the un-gameable half that
 *  runs WITHOUT a judge (a file truly appeared; the verdict line is present). */
export type PipelineAssert =
  | { kind: 'output_contains'; pattern: string | RegExp }
  | { kind: 'output_excludes'; pattern: string | RegExp }
  | { kind: 'file_created'; matching: string | RegExp; minCount?: number }
  | { kind: 'no_file_created'; matching: string | RegExp }
  | { kind: 'feature_status_is'; expected: string }
  | { kind: 'exit_code_is'; expected: number }
  | { kind: 'custom'; name: string; eval: (r: RoleRunResult) => Violation[] };

export interface PipelineScenarioSetup {
  /** The feature the role acts on — its spec + acceptance criteria + a status. */
  feature: {
    id: string;
    title: string;
    spec: string;
    acceptance?: string[];
    status?: string;
  };
  /** Files to pre-seed in the workspace (e.g. an implementation the validator
   *  should check, or a "done" feature WITHOUT tests for the reviewer gate). */
  files?: Array<{ path: string; content: string }>;
}

export interface PipelineScenario {
  id: string;
  version: number;
  /** The pipeline role under test. */
  role: string;
  description: string;
  setup: PipelineScenarioSetup;
  /** Extras passed to the role invoke (e.g. VAL_ID=VAL-1). */
  extras?: string[];
  asserts: PipelineAssert[];
  /** Judge rubric — the behavioral half ("did it write REAL tests, not stubs?"),
   *  scored on-demand by an injected judge. */
  rubric: JudgeRubric;
  caps: { maxWallSecs: number; maxCostUsd: number };
}

// =============================================================================
// Deterministic assert evaluation
// =============================================================================

const matches = (text: string, p: string | RegExp): boolean =>
  typeof p === 'string' ? text.includes(p) : p.test(text);

const fileMatches = (files: string[], p: string | RegExp): string[] =>
  files.filter((f) => (typeof p === 'string' ? f.includes(p) : p.test(f)));

export function evaluatePipelineAsserts(
  asserts: readonly PipelineAssert[],
  r: RoleRunResult,
): Violation[] {
  const out: Violation[] = [];
  const fail = (kind: string, claim: string): void => {
    out.push({ assertKind: kind, severity: 'error', claim });
  };
  for (const a of asserts) {
    switch (a.kind) {
      case 'output_contains':
        if (!matches(r.stdout, a.pattern)) fail(a.kind, `output did not contain ${String(a.pattern)}`);
        break;
      case 'output_excludes':
        if (matches(r.stdout, a.pattern)) fail(a.kind, `output unexpectedly contained ${String(a.pattern)}`);
        break;
      case 'file_created': {
        const hits = fileMatches(r.filesWritten, a.matching);
        const min = a.minCount ?? 1;
        if (hits.length < min) {
          fail(a.kind, `expected ≥${min} file(s) matching ${String(a.matching)}, saw ${hits.length} (${r.filesWritten.join(', ') || 'none'})`);
        }
        break;
      }
      case 'no_file_created': {
        const hits = fileMatches(r.filesWritten, a.matching);
        if (hits.length > 0) fail(a.kind, `expected NO file matching ${String(a.matching)}, saw ${hits.join(', ')}`);
        break;
      }
      case 'feature_status_is':
        if (r.featureStatus !== a.expected) fail(a.kind, `feature status ${JSON.stringify(r.featureStatus)} ≠ expected ${JSON.stringify(a.expected)}`);
        break;
      case 'exit_code_is':
        if (r.exitCode !== a.expected) fail(a.kind, `exit code ${r.exitCode} ≠ expected ${a.expected}`);
        break;
      case 'custom':
        out.push(...a.eval(r));
        break;
    }
  }
  return out;
}

// =============================================================================
// Runner
// =============================================================================

/** Scores a finished role run against the scenario rubric. Injected so live
 *  runs use the shipped LLM judge and tests use a deterministic stub. */
export type PipelineJudge = (
  scenario: PipelineScenario,
  result: RoleRunResult,
  violations: Violation[],
) => Promise<JudgeResult>;

export interface PipelineRunReport {
  scenarioId: string;
  role: string;
  result: RoleRunResult;
  violations: Violation[];
  judge: JudgeResult | null;
  /** 'errored' if the role couldn't produce usable output; else pass/fail from
   *  deterministic asserts + judge findings. */
  status: 'passed' | 'failed' | 'errored';
}

export interface RunPipelineDeps {
  spawnRole: RoleSpawner;
  /** Omit to run deterministic asserts only (no judge) — the CI-cheap path. */
  judge?: PipelineJudge;
}

/**
 * Run one pipeline scenario: spawn the role, capture its product, evaluate the
 * deterministic asserts, optionally judge. Pure orchestration over the injected
 * seams — no live agent or model unless `deps` provides the real ones.
 */
export async function runPipelineScenario(
  scenario: PipelineScenario,
  deps: RunPipelineDeps,
): Promise<PipelineRunReport> {
  const runId = `pipeline-test/${scenario.id}`;
  const result = await deps.spawnRole({
    role: scenario.role,
    harnessSlug: `pt-${scenario.id}`.toLowerCase(),
    featureId: scenario.setup.feature.id,
    runId,
    extras: scenario.extras,
  });

  // SUT-health gate: an empty/failed role run is inconclusive — the judge would
  // only describe the broken environment, so skip it (mirrors runner.ts).
  const inconclusive = result.exitCode !== 0 && result.stdout.trim() === '';
  const violations = inconclusive ? [] : evaluatePipelineAsserts(scenario.asserts, result);

  let judge: JudgeResult | null = null;
  if (!inconclusive && deps.judge) {
    judge = await deps.judge(scenario, result, violations);
  }

  // EI-133: mirrors runner.ts's computeRunStatus — a judge-only error finding
  // (deterministic asserts all passing) does not fail the run when the
  // scenario's rubric opts into judgeAdvisory (default false: unchanged).
  const hasErrorViolation = violations.some((v) => v.severity === 'error');
  const hasErrorFinding = judge?.findings.some((f) => f.severity === 'error') ?? false;
  const status: PipelineRunReport['status'] = inconclusive
    ? 'errored'
    : hasErrorViolation || (hasErrorFinding && !scenario.rubric.judgeAdvisory)
      ? 'failed'
      : 'passed';

  return { scenarioId: scenario.id, role: scenario.role, result, violations, judge, status };
}
