/**
 * Live binding + preflight for the FrontierSWE grader (plan benchmark-suite-frontier-swe-2026-06-18 P-006).
 * Makes the in-container grader ONE-COMMAND-READY: the live `buildVerifierCommand` / `readReward` drive the task's
 * OWN verifier (`tests/test.sh`) against the arm's container via shell-free `docker exec` (the injected
 * {@link ProcExec} is `execFile`-based — `liveProcExec` — so no host shell string is ever built), and read the
 * `[0,1]` reward back out. A preflight reports readiness WITHOUT pulling the GB-scale `ghcr.io/proximal-labs/...`
 * images or running a multi-hour task (those + the full run are owner-gated: disk + budget + 4–20h/task).
 *
 * Config comes from env so the grading host owns the paths/pins without a code change:
 *   PAPERCUSP_FRONTIER_SWE_VERSION — the grader version pin (repo commit / image-set tag) — REQUIRED.
 *   PAPERCUSP_FRONTIER_SWE_DIR     — the vendored Proximal-Labs/frontier-swe checkout (for preflight + the
 *                                    solution/oracle gold control + ingest); not needed to grade a live container.
 */
import { access } from 'node:fs/promises';
import type { OfficialGrader } from '../types';
import type { FrontierSweGraderConfig, FrontierSweRawReward } from './frontier-swe';
import type { ProcExec } from './swe-bench-pro';
import { getOfficialGrader, liveGraderFs, liveProcExec } from './index';

const DEFAULT_VERIFIER_CMD = 'bash /tests/test.sh';
const DEFAULT_REWARD_PATH = '/logs/verifier/reward.txt';
const DEFAULT_REWARD_JSON_PATH = '/logs/verifier/reward.json';

/** Run the task's own verifier inside the arm's container via `docker exec` (oracle mode sets HARBOR_ORACLE_MODE=1). */
export const liveBuildVerifierCommand: FrontierSweGraderConfig['buildVerifierCommand'] = ({ envRef, task, oracle }) => {
  const verifierCmd = (task?.graderMeta?.['verifierCmd'] as string | undefined) ?? DEFAULT_VERIFIER_CMD;
  const args = ['exec'];
  if (oracle) args.push('-e', 'HARBOR_ORACLE_MODE=1');
  // `bash -lc <verifierCmd>` runs in the CONTAINER's shell (not the host); docker is invoked shell-free via execFile.
  args.push(envRef, 'bash', '-lc', verifierCmd);
  return { cmd: 'docker', args };
};

/** Read `/logs/verifier/reward.txt` (the bare [0,1] scalar) + `reward.json` (structured) out of the container. */
export const liveReadReward: FrontierSweGraderConfig['readReward'] = async ({ envRef, task, exec }) => {
  const rewardPath = (task?.graderMeta?.['rewardPath'] as string | undefined) ?? DEFAULT_REWARD_PATH;
  const rewardJsonPath = (task?.graderMeta?.['rewardJsonPath'] as string | undefined) ?? DEFAULT_REWARD_JSON_PATH;

  let rewardScalar: number | null = null;
  const txt = await exec('docker', ['exec', envRef, 'cat', rewardPath]);
  if (txt.code === 0) {
    const v = Number.parseFloat(txt.stdout.trim());
    if (Number.isFinite(v)) rewardScalar = v;
  }

  let rewardJson: unknown;
  const js = await exec('docker', ['exec', envRef, 'cat', rewardJsonPath]);
  if (js.code === 0) {
    try {
      rewardJson = JSON.parse(js.stdout);
    } catch {
      /* a partial/empty reward.json is non-fatal — reward.txt is the primary */
    }
  }
  return { rewardScalar, rewardJson } satisfies FrontierSweRawReward;
};

/** Resolve the live FrontierSWE grader config from env. Throws a clear error if the version pin is missing. */
export function resolveFrontierSweConfigFromEnv(env: NodeJS.ProcessEnv = process.env): FrontierSweGraderConfig {
  const version = env.PAPERCUSP_FRONTIER_SWE_VERSION;
  if (!version) {
    throw new Error(
      'FrontierSWE grader not configured — set PAPERCUSP_FRONTIER_SWE_VERSION (the repo commit / image-set tag pin, ' +
        'e.g. "frontier-swe@<sha> / task-images v4-v6") so every graded row is reproducible.',
    );
  }
  return { version, buildVerifierCommand: liveBuildVerifierCommand, readReward: liveReadReward };
}

/** Build the live FrontierSWE grader (real `docker exec` + fs). cfg defaults to the env-resolved config. */
export function buildLiveFrontierSweGrader(
  cfg: FrontierSweGraderConfig = resolveFrontierSweConfigFromEnv(),
): OfficialGrader {
  return getOfficialGrader('frontier-swe', { frontierSwe: cfg }, { exec: liveProcExec, fs: liveGraderFs });
}

export interface FrontierSwePreflight {
  /** True iff Docker is reachable AND the vendored repo + corpus are present — safe to launch the grader. */
  ready: boolean;
  docker: { available: boolean; detail: string };
  repo: { present: boolean; path: string | null };
  corpus: { present: boolean; path: string };
  /** Human-actionable gaps (provisioning steps to run before a launch). */
  issues: string[];
}

export interface FrontierSwePreflightDeps {
  exec?: ProcExec;
  pathExists?: (p: string) => Promise<boolean>;
}

/**
 * Check readiness WITHOUT spending: Docker daemon reachable + the vendored checkout + the corpus JSONL present.
 * Never pulls a GB image / runs a task. `issues` lists exactly what to provision (clone the repo, ingest the
 * corpus). `corpusPath` defaults to `~/.papercusp/bench-results/frontier-swe/tasks.jsonl`.
 */
export async function preflightFrontierSwe(
  opts: { repoDir?: string; corpusPath?: string } = {},
  deps: FrontierSwePreflightDeps = {},
): Promise<FrontierSwePreflight> {
  const exec = deps.exec ?? liveProcExec;
  const pathExists =
    deps.pathExists ??
    (async (p: string) => {
      try {
        await access(p);
        return true;
      } catch {
        return false;
      }
    });

  const repoDir = opts.repoDir ?? process.env.PAPERCUSP_FRONTIER_SWE_DIR ?? null;
  const corpusPath =
    opts.corpusPath ??
    process.env.PAPERCUSP_BENCH_FRONTIER_SWE_JSONL ??
    `${process.env.HOME ?? ''}/.papercusp/bench-results/frontier-swe/tasks.jsonl`;

  const ver = await exec('docker', ['version', '--format', '{{.Server.Version}}']);
  const dockerAvailable = ver.code === 0 && ver.stdout.trim().length > 0;

  const repoPresent = repoDir ? await pathExists(`${repoDir}/tasks`) : false;
  const corpusPresent = await pathExists(corpusPath);

  const issues: string[] = [];
  if (!dockerAvailable)
    issues.push(`Docker daemon not reachable (docker version exit ${ver.code}: ${ver.stderr.slice(0, 200)})`);
  if (!repoDir) issues.push('PAPERCUSP_FRONTIER_SWE_DIR unset — point it at the vendored Proximal-Labs/frontier-swe checkout');
  else if (!repoPresent) issues.push(`vendored repo missing its tasks/ dir at ${repoDir} (clone Proximal-Labs/frontier-swe)`);
  if (!corpusPresent) issues.push(`corpus JSONL missing at ${corpusPath} — run the P-001 ingest to build it`);

  return {
    ready: dockerAvailable && repoPresent && corpusPresent,
    docker: { available: dockerAvailable, detail: dockerAvailable ? `Server ${ver.stdout.trim()}` : ver.stderr.slice(0, 200) || `exit ${ver.code}` },
    repo: { present: repoPresent, path: repoDir },
    corpus: { present: corpusPresent, path: corpusPath },
    issues,
  };
}

/** The exact grading command (for the runbook / a dry-run preview) — matches what the live grader runs. */
export function describeFrontierSweRun(envRef = '<container>', verifierCmd = DEFAULT_VERIFIER_CMD): string {
  return [
    `# Run the task's OWN verifier inside the arm's container, then read the [0,1] reward back:`,
    `docker exec ${envRef} bash -lc '${verifierCmd}'`,
    `docker exec ${envRef} cat ${DEFAULT_REWARD_PATH}     # → the bare [0,1] reward (primary)`,
    `docker exec ${envRef} cat ${DEFAULT_REWARD_JSON_PATH}  # → the structured reward (fallback / breakdown)`,
    `# Gold/oracle positive control (skips anti-cheat): docker exec -e HARBOR_ORACLE_MODE=1 ${envRef} bash -lc '${verifierCmd}'`,
  ].join('\n');
}
