/**
 * FrontierSWE's {@link CloneGradeSeam} (plan benchmark-suite-frontier-swe-2026-06-18 P-008) — the per-benchmark
 * clone/grade half that EVERY coordination-topology arm shares (the C5 fairness invariant: identical across
 * arms, differs across benchmarks). su-37e53a76's topology runtime drives the agent inside the container per the
 * arm's {@link CoordinationSpec}; THIS seam owns only the benchmark-specific lifecycle:
 *
 *   clone(task)   → `docker run -d <image> sleep infinity` → a live container handle (the agent execs in and
 *                   works in /app; the task workspace is baked into the image). `--gpus all` for GPU tasks.
 *   grade(task,h) → run the task's OWN verifier (`tests/test.sh`) in the container, read `/logs/verifier/
 *                   reward.txt` → a continuous `score∈[0,1]`. We author NO verifier (D-001).
 *   teardown(h)   → `docker rm -f` (never-throw — always called, leak-free).
 *
 * Composes the existing FrontierSWE grader primitives (liveBuildVerifierCommand / liveReadReward /
 * parseFrontierSweReward), so the seam and the standalone OfficialGrader can never diverge. Subprocess is
 * INJECTED ({@link ProcExec}) → unit-testable with a fake docker, no daemon.
 */
import type { CloneGradeSeam } from './coordination-topology';
import type { BenchTask } from './types';
import type { ProcExec } from './grader/swe-bench-pro';
import { liveProcExec } from './grader/index';
import { liveBuildVerifierCommand, liveReadReward } from './grader/frontier-swe-live';
import { parseFrontierSweReward } from './grader/frontier-swe';

/** The opaque environment handle for a FrontierSWE task — a live Docker container the arm operated. */
export interface FrontierSweEnvHandle {
  containerId: string;
  image: string;
  instanceId: string;
}

export interface FrontierSweSeamConfig {
  /** Grader version pinned on results (repo commit / image-set tag). Required for reproducibility. */
  version: string;
  /** Inject a fake in tests; production uses the shell-free `liveProcExec` (execFile, no host shell). */
  exec?: ProcExec;
  /** Run the verifier in oracle mode (HARBOR_ORACLE_MODE=1) — the gold/positive control path. Default false. */
  oracle?: boolean;
  /** Extra `docker run` flags (e.g. resource limits) the driver wants applied uniformly. Default none. */
  extraRunArgs?: string[];
  /**
   * The vendored Proximal-Labs/frontier-swe checkout (default PAPERCUSP_FRONTIER_SWE_DIR). At GRADE time the
   * seam `docker cp`s `<repoDir>/tasks/<id>/tests` into the container at `/tests` (and `/solution` in oracle
   * mode) — the task image bakes only `/app`; Harbor uploads tests/ at verify time, so we mirror that. Staging
   * at GRADE time (post-agent) keeps the hidden tests away from the agent (anti-cheat). Confirmed against the
   * real harness 2026-06-18: gold control → 0.985, empty → 0.0 (libexpat-to-x86asm).
   */
  repoDir?: string;
}

/** Build FrontierSWE's CloneGradeSeam — supplied once to the shared topology runtime; every arm uses it identically. */
export function makeFrontierSweCloneGradeSeam(cfg: FrontierSweSeamConfig): CloneGradeSeam<FrontierSweEnvHandle> {
  const exec = cfg.exec ?? liveProcExec;

  return {
    modality: 'in-container',

    async clone(task: BenchTask): Promise<FrontierSweEnvHandle> {
      const image = task.graderMeta?.['dockerImage'] as string | undefined;
      if (!image) throw new Error(`FrontierSWE clone: task ${task.instanceId} has no dockerImage in graderMeta`);
      const gpus = Number(task.graderMeta?.['gpus'] ?? 0);
      const runArgs = ['run', '-d'];
      if (gpus > 0) runArgs.push('--gpus', 'all');
      if (cfg.extraRunArgs?.length) runArgs.push(...cfg.extraRunArgs);
      // Keep the container alive so the topology runtime can exec the agent into the baked-in /app workspace.
      runArgs.push(image, 'sleep', 'infinity');
      const r = await exec('docker', runArgs);
      const containerId = r.stdout.trim().split('\n').pop() ?? '';
      if (r.code !== 0 || !containerId) {
        throw new Error(`FrontierSWE clone: docker run failed for ${task.instanceId} (${image}) — exit ${r.code}: ${r.stderr.slice(0, 300)}`);
      }
      return { containerId, image, instanceId: task.instanceId };
    },

    async grade(task: BenchTask, handle: FrontierSweEnvHandle) {
      // Stage the hidden tests INTO the container at GRADE time (post-agent) — the image bakes only /app; Harbor
      // uploads tests/ at verify time. Doing it here (not in clone) keeps /tests away from the agent (anti-cheat).
      const repoDir = cfg.repoDir ?? process.env.PAPERCUSP_FRONTIER_SWE_DIR;
      if (repoDir) {
        try {
          await exec('docker', ['cp', `${repoDir}/tasks/${handle.instanceId}/tests`, `${handle.containerId}:/tests`]);
          if (cfg.oracle) await exec('docker', ['cp', `${repoDir}/tasks/${handle.instanceId}/solution`, `${handle.containerId}:/solution`]);
        } catch (e) {
          return { resolved: null, score: null, graderStatus: 'error', detail: { stageTestsError: e instanceof Error ? e.message : String(e) } };
        }
      }
      // Run the task's OWN verifier in the container, then read the reward back — reusing the grader primitives.
      const { cmd, args, cwd, env } = liveBuildVerifierCommand({
        instanceId: handle.instanceId,
        envRef: handle.containerId,
        task,
        oracle: cfg.oracle,
      });
      let verifierExit = 0;
      try {
        const run = await exec(cmd, args, { cwd, env });
        verifierExit = run.code;
      } catch (e) {
        return { resolved: null, score: null, graderStatus: 'error', detail: { verifierExecError: e instanceof Error ? e.message : String(e) } };
      }

      let raw;
      try {
        raw = await liveReadReward({ instanceId: handle.instanceId, envRef: handle.containerId, task, readFile: async () => '', exec });
      } catch (e) {
        return {
          resolved: null,
          score: null,
          graderStatus: 'error',
          detail: { rewardReadError: e instanceof Error ? e.message : String(e), verifierExit },
        };
      }

      const g = parseFrontierSweReward(raw, handle.instanceId, 'seam', cfg.version);
      if (g.graderError || g.score == null) {
        // Verifier produced no numeric verdict → infra, surfaced + excluded (C6), never a silent 0.
        return { resolved: null, score: null, graderStatus: 'error', detail: { graderError: g.graderError, raw: g.rawGraderOutput, verifierExit } };
      }
      // A genuine capability outcome (incl. score 0). resolved = (score === 1) is degenerate for FrontierSWE.
      return { resolved: g.resolved, score: g.score, graderStatus: g.resolved ? 'passed' : 'failed', detail: g.rawGraderOutput };
    },

    async teardown(handle: FrontierSweEnvHandle): Promise<void> {
      // Never-throw: teardown is ALWAYS called (success / capability-fail / infra-fail) — must not leak a container.
      try {
        await exec('docker', ['rm', '-f', handle.containerId]);
      } catch {
        /* swallow — a teardown failure must never break the run */
      }
    },
  };
}
