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
import { createHash } from 'node:crypto';
import { gymRunIdentity, type GymRunIdentity, type GymRunKey } from './run-identity';
import { planVariantOverlay, type VariantOverlay } from './variant-overlay';
import { classifyGymRun, type GymRunOutcome } from './pipeline-status';
import { regressionsFromTests, testResultKey, type TestResult } from './signals';

/** Actual assertion results plus oracle bytes measured around the test process. */
export interface GymOracleRun {
  results: TestResult[];
  testPath: string;
  pinCommit: string;
  sourceHashes: { pinned: string | null; before: string | null; after: string | null };
  /** Principal implementation bytes measured around this test process. This
   * does not identify imported code, the runner, or the remote pipeline. */
  implementation?: { path: string; before: string | null; after: string | null } | null;
  execution?: { command: string[]; cwd: string; report: string; unresolved: string[];
    exitCode: number | null; signal: string | null;
    /** npm run resolves the script and its lifecycle hooks from this manifest.
     * This covers the repository manifest, not npm/config/native runtime code. */
    npmManifest?: { path: string; sourceHashes: {
      pinned: string | null; before: string | null; after: string | null;
    } };
    /** Repository native main-process inputs observed by the early Node hook.
     * This excludes external/native dependencies and other processes. */
    mainProcessSources?: {
      reference: { pinCommit: string; sources: Array<{ path: string; sha256: string | null }> };
      evidence: { schemaVersion: string; scope: string; basis: string; status: string;
        sources: Array<{ path: string; sha256: string | null; currentSha256: string | null }>;
        reasons: string[] } | null;
    };
    /** Exit observations from the npm command and inherited Node descendants.
     * The process population, preloads and external/native runtime remain open. */
    commandProcessSources?: {
      report: string | null;
      /** Exact JSONL emitted by the committed-source hook before later
       * transforms. Retained for diagnosis, never final runtime authority. */
      loaderReport?: string | null;
      reference: { pinCommit: string; sources: Array<{ path: string; sha256: string | null }> };
      processes: Array<{ schemaVersion: string; scope: string; basis: string; status: string;
        entrypoint: string | null; pid: number; parentPid: number; exitCode: number;
        isMainThread?: boolean; threadId?: number;
        sources: Array<{ path: string; sha256: string | null; currentSha256: string | null }>;
        reasons: string[]; unresolved: string[] }>;
      unresolved: string[];
    };
    /** Config dependency disk snapshots begin at reporter initialization, after
     * config loading. Matching pins do not establish original loaded bytes. */
    configSources?: {
      reference: { pinCommit: string; sources: Array<{ path: string; sha256: string | null }> };
      /** Original config input bytes witnessed by the Node load hook. Kept
       * separate from later reporter-init disk observations. */
      loaded?: { schemaVersion: string; scope: string; basis: string; status: string;
        sources: Array<{ path: string; sha256: string | null; currentSha256: string | null }>;
        reasons: string[] } | null;
      evidence: { schemaVersion: string; scope: string; basis: string; status: string;
        sources: Array<{ path: string; sha256: string | null; currentSha256: string | null }>;
        reasons: string[] } | null;
    };
    /** Original worker sources from the existing framework OUT channel. This
     * scope excludes runner/config/native code and the remote pipeline. */
    workerSources?: { report: string | null;
      /** Immutable repository blobs for the measured worker source population.
       * Kept separate from the bytes actually evaluated by Vitest. */
      reference?: { pinCommit: string; sources: Array<{ path: string; sha256: string | null }> };
      modules: Array<{ testFile: string; state: string;
      sourceEvidence: { schemaVersion: string; scope: string; status: string;
        sources: Array<{ path: string; sha256: string; currentSha256: string | null }>; reasons: string[] } }> };
  };
}

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
  runOracle?(i: { clonePath: string; testPath: string; pinCommit?: string; implPath?: string }): Promise<TestResult[] | GymOracleRun | undefined>;
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
  // The caller may mutate its spec while effects are awaited. Identity, filed
  // work and both oracle measurements must describe the same original task.
  spec = structuredClone(spec);
  const executionInput = {
    task: structuredClone(spec.task),
    variant: structuredClone(spec.variant),
    // Requested harness pin, not proof of the runtime code actually loaded.
    harnessCommit: spec.harnessCommit,
    taskHash: createHash('sha256').update(JSON.stringify(spec.task)).digest('hex'),
    variantHash: createHash('sha256').update(JSON.stringify(spec.variant)).digest('hex'),
  };
  const runKey: GymRunKey = { taskId: spec.task.id, variantId: spec.variant.id, cycle: spec.cycle, repeat: spec.repeat };
  const identity = gymRunIdentity(runKey);
  const clonePath = join(spec.scratchRoot, identity.cloneDirName);
  const overlayPlan = planVariantOverlay(spec.variant.overlay);

  // --- setup phase: any failure → best-effort teardown of what we created, then rethrow ---
  let workflowID: string;
  let preOracle: GymOracleRun | undefined;
  const measureOracle = async (): Promise<GymOracleRun | undefined> => {
    if (!spec.task.oracle || !ports.runOracle) return undefined;
    try {
      const results = await ports.runOracle({
        clonePath,
        testPath: spec.task.oracle.testPath,
        pinCommit: spec.task.oracle.pinCommit,
        implPath: spec.task.oracle.implPath,
      });
      if (!results) return undefined;
      // Legacy/custom array ports have no immutable-source receipt. Retain their
      // results for diagnosis, but they cannot authorize a no-regression claim.
      return structuredClone(Array.isArray(results) ? {
        results, testPath: spec.task.oracle.testPath, pinCommit: spec.task.oracle.pinCommit,
        sourceHashes: { pinned: null, before: null, after: null },
      } : results);
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
      let deterministicSignals: Record<string, unknown> = { executionInput };
      if (spec.task.oracle) {
        const pre = preOracle?.results ?? [];
        const post = postOracle?.results ?? [];
        const beforeKeys = pre.map(testResultKey);
        const afterKeys = post.map(testResultKey);
        const populationComplete = beforeKeys.length > 0 && beforeKeys.length === afterKeys.length &&
          new Set(beforeKeys).size === beforeKeys.length && new Set(afterKeys).size === afterKeys.length &&
          beforeKeys.every((key) => afterKeys.includes(key)) &&
          [...pre, ...post].every((t) => t.name.trim().length > 0 && t.executed !== false);
        const pinned = preOracle?.sourceHashes.pinned;
        const sourceCurrent = typeof pinned === 'string' && /^[a-f0-9]{64}$/.test(pinned) &&
          [preOracle, postOracle].every((receipt) => receipt &&
            receipt.testPath === spec.task.oracle!.testPath && receipt.pinCommit === spec.task.oracle!.pinCommit &&
            Object.values(receipt.sourceHashes).every((value) => value === pinned));
        // The task may legitimately change the implementation between runs.
        // Each individual oracle must evaluate one stable principal artifact.
        const implementationCurrent = [preOracle, postOracle].every((receipt) => {
          const impl = receipt?.implementation;
          return impl?.path === spec.task.oracle!.implPath && typeof impl.before === 'string' &&
            /^[a-f0-9]{64}$/.test(impl.before) && impl.before === impl.after;
        });
        const workerSources = (receipt: GymOracleRun | undefined): Map<string, string> | null => {
          const measured = receipt?.execution?.workerSources;
          if (!measured?.report || !Array.isArray(measured.modules) || measured.modules.length !== 1) return null;
          const module = measured.modules[0];
          const evidence = module?.sourceEvidence;
          if (module?.testFile !== spec.task.oracle!.testPath ||
              evidence?.schemaVersion !== 'vite-collected-source-evidence-v1' ||
              evidence.scope !== 'repository-worker-vite-original-sources' || evidence.status !== 'stable' ||
              !Array.isArray(evidence.reasons) || evidence.reasons.length > 0 || !Array.isArray(evidence.sources)) return null;
          const hashes = new Map<string, string>();
          for (const source of evidence.sources) {
            if (!source || typeof source.path !== 'string' || typeof source.sha256 !== 'string' ||
                !/^[a-f0-9]{64}$/.test(source.sha256) || source.currentSha256 !== source.sha256 || hashes.has(source.path)) return null;
            hashes.set(source.path, source.sha256);
          }
          if (hashes.get(spec.task.oracle!.testPath) !== receipt?.sourceHashes.pinned) return null;
          // Hashing a file on disk does not prove the oracle evaluated it.
          if (hashes.get(spec.task.oracle!.implPath) !== receipt?.implementation?.before) return null;
          const reference = measured.reference;
          if (reference?.pinCommit !== spec.task.oracle!.pinCommit || !Array.isArray(reference.sources)) return null;
          const referenceHashes = new Map<string, string>();
          for (const source of reference.sources) {
            if (!source || typeof source.path !== 'string' || typeof source.sha256 !== 'string' ||
                !/^[a-f0-9]{64}$/.test(source.sha256) || referenceHashes.has(source.path)) return null;
            referenceHashes.set(source.path, source.sha256);
          }
          if (referenceHashes.size !== hashes.size || [...hashes].some(([path, hash]) =>
            !referenceHashes.has(path) || (path !== spec.task.oracle!.implPath && referenceHashes.get(path) !== hash))) return null;
          // The declared implementation may change between arms. Other imported
          // sources are part of the fixed oracle/environment, not the candidate.
          hashes.delete(spec.task.oracle!.implPath);
          return hashes;
        };
        const preWorkerSources = workerSources(preOracle);
        const postWorkerSources = workerSources(postOracle);
        const workerSourcesCurrent = preWorkerSources !== null && postWorkerSources !== null &&
          preWorkerSources.size === postWorkerSources.size &&
          [...preWorkerSources].every(([path, hash]) => postWorkerSources.get(path) === hash);
        // Stable worker sources alone cannot identify the command that ran them:
        // npm scripts and their pre/post hooks come from a separate manifest.
        const manifestPin = preOracle?.execution?.npmManifest?.sourceHashes?.pinned;
        const npmManifestCurrent = typeof manifestPin === 'string' && /^[a-f0-9]{64}$/.test(manifestPin) &&
          [preOracle, postOracle].every((receipt) => {
            const execution = receipt?.execution;
            const manifest = execution?.npmManifest;
            const hashes = manifest?.sourceHashes;
            return manifest?.path === 'package.json' &&
              hashes?.pinned === manifestPin && hashes.before === manifestPin && hashes.after === manifestPin &&
              ['npm', 'run', 'test:file', '--', spec.task.oracle!.testPath].every((arg, index) =>
                execution?.command?.[index] === arg);
          });
        const configSourceHashes = (receipt: GymOracleRun | undefined, loaded = false, mainProcess = false): Map<string, string> | null => {
          const measured = mainProcess ? receipt?.execution?.mainProcessSources : receipt?.execution?.configSources;
          const evidence = mainProcess ? measured?.evidence : loaded ? receipt?.execution?.configSources?.loaded : measured?.evidence;
          const reference = measured?.reference;
          if (evidence?.schemaVersion !== (mainProcess ? 'node-loaded-main-process-sources-v1' : loaded ? 'node-loaded-config-sources-v1' : 'vitest-config-disk-snapshots-v1') ||
              evidence.scope !== (mainProcess ? 'repository-node-main-process-sources' : 'repository-vite-config-dependencies') ||
              evidence.basis !== (loaded || mainProcess ? 'node-load-hook' : 'reporter-init-disk') ||
              evidence.status !== (loaded || mainProcess ? 'stable' : 'unchanged') || !Array.isArray(evidence.reasons) || evidence.reasons.length > 0 ||
              !Array.isArray(evidence.sources) || evidence.sources.length === 0 ||
              reference?.pinCommit !== spec.task.oracle!.pinCommit || !Array.isArray(reference.sources)) return null;
          const hashes = new Map<string, string>();
          const pins = new Map<string, string>();
          for (const source of evidence.sources) {
            if (!source || typeof source.path !== 'string' || typeof source.sha256 !== 'string' ||
                !/^[a-f0-9]{64}$/.test(source.sha256) || source.currentSha256 !== source.sha256 || hashes.has(source.path)) return null;
            hashes.set(source.path, source.sha256);
          }
          for (const source of reference.sources) {
            if (!source || typeof source.path !== 'string' || typeof source.sha256 !== 'string' ||
                !/^[a-f0-9]{64}$/.test(source.sha256) || pins.has(source.path)) return null;
            pins.set(source.path, source.sha256);
          }
          return pins.size === hashes.size && [...hashes].every(([path, hash]) => pins.get(path) === hash) ? hashes : null;
        };
        const preConfigSnapshots = configSourceHashes(preOracle);
        const postConfigSnapshots = configSourceHashes(postOracle);
        const configSnapshotsCurrent = preConfigSnapshots !== null && postConfigSnapshots !== null &&
          preConfigSnapshots.size === postConfigSnapshots.size &&
          [...preConfigSnapshots].every(([path, hash]) => postConfigSnapshots.get(path) === hash);
        const preConfigLoaded = configSourceHashes(preOracle, true);
        const postConfigLoaded = configSourceHashes(postOracle, true);
        const configLoadedCurrent = preConfigLoaded !== null && postConfigLoaded !== null &&
          preConfigLoaded.size === postConfigLoaded.size &&
          [...preConfigLoaded].every(([path, hash]) => postConfigLoaded.get(path) === hash);
        const preMainProcess = configSourceHashes(preOracle, false, true);
        const postMainProcess = configSourceHashes(postOracle, false, true);
        const mainProcessCurrent = preMainProcess !== null && postMainProcess !== null &&
          preMainProcess.size === postMainProcess.size &&
          [...preMainProcess].every(([path, hash]) => postMainProcess.get(path) === hash);
        const commandSourceHashes = (receipt: GymOracleRun | undefined): Map<string, string> | null => {
          const measured = receipt?.execution?.commandProcessSources;
          if (!measured || typeof measured.report !== 'string' ||
              measured.reference?.pinCommit !== spec.task.oracle!.pinCommit ||
              !Array.isArray(measured.reference.sources) || !Array.isArray(measured.processes) ||
              measured.processes.length === 0) return null;
          const hashes = new Map<string, string>();
          const pins = new Map<string, string>();
          const pids = new Set<number>();
          const safePath = (path: unknown): path is string => typeof path === 'string' && path.length > 0 &&
            !path.startsWith('/') && !/^[a-zA-Z]:/.test(path) && !path.includes('\\') &&
            !path.split('/').some(part => part === '..' || part === '.' || part === '');
          for (const process of measured.processes) {
            if (!process || process.schemaVersion !== 'node-loaded-process-sources-v1' ||
                process.scope !== 'repository-node-process-sources' || process.basis !== 'node-load-hook' ||
                process.status !== 'stable' || !Number.isInteger(process.pid) || process.pid <= 0 || pids.has(process.pid) ||
                !Number.isInteger(process.exitCode) || (process.exitCode !== 0 && process.exitCode !== 1) ||
                !safePath(process.entrypoint) || !Array.isArray(process.reasons) || process.reasons.length > 0 ||
                !Array.isArray(process.sources) || process.sources.length === 0) return null;
            pids.add(process.pid);
            if (!process.sources.some(source => source?.path === process.entrypoint && source.sha256 !== null)) return null;
            for (const source of process.sources) {
              if (!source || !safePath(source.path) || typeof source.sha256 !== 'string' ||
                  !/^[a-f0-9]{64}$/.test(source.sha256) || source.currentSha256 !== source.sha256 ||
                  (hashes.has(source.path) && hashes.get(source.path) !== source.sha256)) return null;
              hashes.set(source.path, source.sha256);
            }
          }
          for (const source of measured.reference.sources) {
            if (!source || !safePath(source.path) || typeof source.sha256 !== 'string' ||
                !/^[a-f0-9]{64}$/.test(source.sha256) || pins.has(source.path)) return null;
            pins.set(source.path, source.sha256);
          }
          if (pins.size !== hashes.size || [...hashes].some(([path, hash]) =>
              !pins.has(path) || (path !== spec.task.oracle!.implPath && pins.get(path) !== hash))) return null;
          hashes.delete(spec.task.oracle!.implPath);
          return hashes;
        };
        const preCommandSources = commandSourceHashes(preOracle);
        const postCommandSources = commandSourceHashes(postOracle);
        const commandProcessesCurrent = preCommandSources !== null && postCommandSources !== null &&
          preCommandSources.size === postCommandSources.size &&
          [...preCommandSources].every(([path, hash]) => postCommandSources.get(path) === hash);
        const regression = sourceCurrent && implementationCurrent ? regressionsFromTests(pre, post) : undefined;
        // A JSON report may exist even when the command is killed or fails after
        // writing it. Retain witnessed failures, but require a successful process
        // outcome before using that report to claim success.
        const executionCompleted = [preOracle, postOracle].every((receipt) => receipt?.execution?.signal === null &&
          (receipt.execution.exitCode === 0 || (receipt.execution.exitCode === 1 &&
            receipt.results.some((test) => test.executed !== false && !test.passed))));
        const taskPassed = post.every((t) => t.passed);
        const regressionPopulation = pre.filter((t) => t.executed !== false && t.passed).length;
        deterministicSignals = {
          executionInput,
          // Collector/store preserve this receipt in the existing trace/signals.
          oracle: { sourceRef: spec.task.oracle.sourceRef, testPath: spec.task.oracle.testPath,
            pinCommit: spec.task.oracle.pinCommit, pre: preOracle ?? null, post: postOracle ?? null,
            sourceCurrent, implementationCurrent, workerSourcesCurrent, npmManifestCurrent, configSnapshotsCurrent, configLoadedCurrent, mainProcessCurrent, commandProcessesCurrent,
            executionCompleted, populationComplete, regressionPopulation },
          ...(regression === true || (regression === false && workerSourcesCurrent && npmManifestCurrent && configSnapshotsCurrent && configLoadedCurrent && mainProcessCurrent && commandProcessesCurrent && executionCompleted && populationComplete && regressionPopulation > 0)
            ? { regressions: regression } : {}),
          ...(sourceCurrent && implementationCurrent && populationComplete && (!taskPassed || (executionCompleted && workerSourcesCurrent && npmManifestCurrent && configSnapshotsCurrent && configLoadedCurrent && mainProcessCurrent && commandProcessesCurrent))
            ? { taskPassed } : {}),
        };
      }
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
        deterministicSignals,
      };
    }
    await ports.sleep(spec.pollIntervalMs);
  }
}
