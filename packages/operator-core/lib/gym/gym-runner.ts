/**
 * The hermetic gym runner (P-001): orchestrates ONE `(task × variant × cycle)`
 * run on the dedicated gym-operator instance (D-018).
 *
 *   clone substrate@commit → register throwaway harness → apply variant overlay
 *   → file the synthetic feature → start the pipeline → poll to terminal.
 *
 * All effects are injected via {@link GymRunnerPorts}, so this sequencing +
 * teardown-on-setup-failure logic is unit-tested with fakes (no live operator,
 * no real agents). The runner deliberately does NOT tear down on success: the
 * trace collector (P-002) reads the clone (for the diff) and the harness schema
 * (for the transcript) AFTER the run, then calls teardown.
 */
import { join } from 'node:path';
import { gymRunIdentity, type GymRunIdentity, type GymRunKey } from './run-identity';
import { planVariantOverlay, type VariantOverlay } from './variant-overlay';
import { classifyGymRun, type GymRunOutcome } from './pipeline-status';
import { regressionsFromTests, type TestResult } from './signals';

export interface GymOracleSpec {
  /** Repo-relative path of the real test file that judges the task. */
  testPath: string;
  /** Repo-relative implementation file the task restores. */
  implPath: string;
  /** Commit at which the oracle and reference implementation are pinned. */
  pinCommit: string;
  /** Auditable work-item/commit provenance for the real task. */
  sourceRef: string;
}

export interface GymTaskSpec {
  id: string;
  /** Substrate repo: local path or remote URL. */
  source: string;
  /** Pinned substrate commit SHA (D-009). */
  commit: string;
  /** The (deliberately mildly-underspecified) feature spec. */
  spec: string;
  /** The high-level intent the work should achieve. */
  intent: string;
  /** Real-corpus oracle metadata, when this task is test-anchored. */
  oracle?: GymOracleSpec;
}

export interface GymVariantSpec {
  id: string;
  overlay: VariantOverlay;
}

export interface GymRunSpec {
  task: GymTaskSpec;
  variant: GymVariantSpec;
  /** Optimization cycle (0 for the spine's manual A/B). */
  cycle: number;
  /** Repeat index within a (task × variant × cycle) — the P-014 variance sample; each repeat gets its own harness. */
  repeat?: number;
  /** The pinned harness-under-test commit (D-016) — recorded with the run. */
  harnessCommit: string;
  workspaceId: string;
  /** Scratch dir root the substrate clone lands under. */
  scratchRoot: string;
  /** Hard wall-clock cap for the pipeline. */
  timeoutMs: number;
  /** Delay between status polls. */
  pollIntervalMs: number;
}

/** The effectful operations the runner needs — bound to real operator functions in the wiring layer. */
export interface GymRunnerPorts {
  cloneSubstrate(i: { source: string; commit: string; destDir: string }): Promise<void>;
  registerThrowawayHarness(i: { slug: string; clonePath: string; workspaceId: string }): Promise<void>;
  applyPromptOverride(i: { workspaceId: string; slug: string; role: string; promptMd: string }): Promise<void>;
  fileFeature(i: { slug: string; featureId: string; spec: string; intent: string }): Promise<void>;
  startPipeline(i: { slug: string; featureId: string; workspaceId: string }): Promise<{ workflowID: string }>;
  pollStatus(i: { workflowID: string; slug: string; featureId: string }): Promise<{
    workflowStatus: string;
    featureStatus: string | null;
  }>;
  /** Run the task's immutable oracle inside the clone and return per-test results. */
  runOracle?(i: { clonePath: string; testPath: string }): Promise<TestResult[] | undefined>;
  teardownHarness(i: { slug: string; clonePath: string; workspaceId: string }): Promise<void>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface GymRunResult {
  runKey: GymRunKey;
  identity: GymRunIdentity;
  harnessSlug: string;
  featureId: string;
  clonePath: string;
  workflowID: string;
  outcome: GymRunOutcome;
  terminal: boolean;
  elapsedMs: number;
  /** Deterministic signals measured by the runner; absent means not measured. */
  deterministicSignals?: Record<string, unknown>;
}

export async function runGymPipeline(spec: GymRunSpec, ports: GymRunnerPorts): Promise<GymRunResult> {
  const runKey: GymRunKey = { taskId: spec.task.id, variantId: spec.variant.id, cycle: spec.cycle, repeat: spec.repeat };
  const identity = gymRunIdentity(runKey);
  const clonePath = join(spec.scratchRoot, identity.cloneDirName);
  const overlayPlan = planVariantOverlay(spec.variant.overlay);

  // --- setup phase: any failure → best-effort teardown of what we created, then rethrow ---
  let workflowID: string;
  let preOracle: TestResult[] | undefined;
  const measureOracle = async (): Promise<TestResult[] | undefined> => {
    if (!spec.task.oracle || !ports.runOracle) return undefined;
    try {
      const results = await ports.runOracle({
        clonePath,
        testPath: spec.task.oracle.testPath,
      });
      return results && results.length > 0 ? results : undefined;
    } catch {
      // Oracle collection is evidence, not a reason to hide the pipeline outcome.
      return undefined;
    }
  };
  try {
    await ports.cloneSubstrate({ source: spec.task.source, commit: spec.task.commit, destDir: clonePath });
    // The task commit starts with the implementation rewound. Measure the oracle
    // BEFORE the agent pipeline changes the clone so regressionsFromTests compares
    // the same immutable test set pre/post.
    preOracle = await measureOracle();
    await ports.registerThrowawayHarness({ slug: identity.harnessSlug, clonePath, workspaceId: spec.workspaceId });
    for (const op of overlayPlan.promptOverrideOps) {
      await ports.applyPromptOverride({
        workspaceId: spec.workspaceId,
        slug: identity.harnessSlug,
        role: op.role,
        promptMd: op.promptMd,
      });
    }
    await ports.fileFeature({
      slug: identity.harnessSlug,
      featureId: identity.featureId,
      spec: spec.task.spec,
      intent: spec.task.intent,
    });
    const started = await ports.startPipeline({
      slug: identity.harnessSlug,
      featureId: identity.featureId,
      workspaceId: spec.workspaceId,
    });
    workflowID = started.workflowID;
  } catch (err) {
    try {
      await ports.teardownHarness({ slug: identity.harnessSlug, clonePath, workspaceId: spec.workspaceId });
    } catch {
      // best-effort cleanup; surface the original setup error
    }
    throw err;
  }

  // --- poll phase: the pipeline owns the feature now; keep artifacts and return
  //     the outcome (including errored/timeout) so the collector can capture the trace ---
  const start = ports.now();
  for (;;) {
    const snap = await ports.pollStatus({ workflowID, slug: identity.harnessSlug, featureId: identity.featureId });
    const elapsedMs = ports.now() - start;
    const cls = classifyGymRun({
      workflowStatus: snap.workflowStatus,
      featureStatus: snap.featureStatus,
      elapsedMs,
      timeoutMs: spec.timeoutMs,
    });
    if (cls.terminal) {
      const postOracle = await measureOracle();
      const deterministicSignals =
        preOracle && postOracle
          ? { regressions: regressionsFromTests(preOracle, postOracle) }
          : undefined;
      return {
        runKey,
        identity,
        harnessSlug: identity.harnessSlug,
        featureId: identity.featureId,
        clonePath,
        workflowID,
        outcome: cls.outcome,
        terminal: true,
        elapsedMs,
        ...(deterministicSignals ? { deterministicSignals } : {}),
      };
    }
    await ports.sleep(spec.pollIntervalMs);
  }
}
