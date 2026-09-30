/**
 * swarmbench-live.ts — the live `RunSwarmSim` port (plan benchmark-suite-swarmbench-2026-06-17 P-002/P-003).
 *
 * SwarmBench is a Python round-based 2D-grid sim (RUC-GSAI/YuLan-SwarmIntell, MIT, vendored at
 * `~/.papercusp/bench-harnesses/swarmbench`). Like metr-hcast's taskhelper path, we shell out to the vendored
 * `swarmbench_run.py`, which runs ONE scenario to its deterministic sim score and prints a single
 * `SWARMBENCH_RESULT_JSON` line. This port runs that subprocess + parses the result; generation (the agents
 * acting) and grading (the sim score) are ONE act inside the running sim (M2-style, gen+grade together).
 *
 * The `mode` selects the swarm-control topology = the ARM: `openai` = SwarmBench's NATIVE decentralized flow
 * (each agent an independent OpenAI-compatible call → the `su-independent` arm); `queen` = the aggregated-local
 * centralized coordinator (the `hive-realqueen` arm, D-001; added in P-005); `random` = no-LLM (the spike/test).
 * The model route is the gateway's OpenAI-compatible `/v1/chat/completions` (D-003) — `apiBase` ends in `/v1`.
 *
 * The exec seam is injected so the orchestration unit-tests with a fake (no subprocess, no spend); the live
 * binding spawns the vendored python. Never throws — a sim/infra failure returns `{ error }` (the caller maps
 * it to an excluded result), mirroring the native-harness-terminal-bench parser tolerance.
 */
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The result separator `swarmbench_run.py` prints before its JSON line. */
const RESULT_SEP = 'SWARMBENCH_RESULT_JSON';

/** One SwarmBench scenario config (programmatic — no download; task × grid × agents × seed × view). */
export interface SwarmScenario {
  /** Transport | Pursuit | Synchronization | Foraging | Flocking. */
  task: string;
  numAgents: number;
  width: number;
  height: number;
  seed: number;
  viewSize: number;
  maxRound: number;
}

/** A stable scenario id (task + the config that defines it) — the per-task instanceId. */
export function scenarioId(s: SwarmScenario): string {
  return `${s.task}__n${s.numAgents}_${s.width}x${s.height}_v${s.viewSize}_r${s.maxRound}_s${s.seed}`;
}

/** The swarm-control mode = the arm. */
export type SwarmMode = 'random' | 'openai' | 'mug';

/** Normalized result of one scenario run (what `swarmbench_run.py` emits). */
export interface SwarmSimResult {
  /** The sim's deterministic per-task score (continuous; higher = better coordination). */
  score: number | null;
  /** Rounds the sim ran (≤ maxRound). */
  rounds: number;
  /** Total agent LLM calls (summed across agents × rounds) — the cost/coordination-overhead proxy. */
  agentTokens: number;
  done: boolean;
  /** Infra failure (sim crash / subprocess error) — excluded from scoring, never a capability fail. */
  error?: string;
  /** Raw JSON the python emitted, stored verbatim. */
  raw: unknown;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Injected process-exec seam (fakes in tests; `execFile` in prod). */
export type ExecFn = (file: string, args: string[], opts?: { timeoutMs?: number; env?: Record<string, string> }) => Promise<ExecResult>;

export const liveExec: ExecFn = (file, args, opts = {}) =>
  new Promise<ExecResult>((resolve) => {
    const child = execFile(
      file,
      args,
      { timeout: opts.timeoutMs ?? 1_800_000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, ...(opts.env ?? {}) } },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0;
        resolve({ stdout: String(stdout), stderr: String(stderr), code });
      },
    );
    void child;
  });

/** Parse `swarmbench_run.py` stdout: the JSON on the line after the last `SWARMBENCH_RESULT_JSON` separator. */
export function parseSwarmSimResult(stdout: string): SwarmSimResult {
  const idx = stdout.lastIndexOf(RESULT_SEP);
  if (idx < 0) return { score: null, rounds: 0, agentTokens: 0, done: false, error: `no result separator in output: ${stdout.slice(-300)}`, raw: null };
  const after = stdout.slice(idx + RESULT_SEP.length).trim();
  const firstLine = after.split('\n')[0]?.trim() ?? '';
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(firstLine) as Record<string, unknown>;
  } catch {
    return { score: null, rounds: 0, agentTokens: 0, done: false, error: `result line not JSON: ${firstLine.slice(0, 200)}`, raw: firstLine };
  }
  if (typeof obj['error'] === 'string') {
    return { score: null, rounds: Number(obj['rounds'] ?? 0), agentTokens: Number(obj['agentTokens'] ?? 0), done: false, error: obj['error'] as string, raw: obj };
  }
  const score = typeof obj['score'] === 'number' && Number.isFinite(obj['score']) ? (obj['score'] as number) : null;
  return {
    score,
    rounds: Number(obj['rounds'] ?? 0),
    agentTokens: Number(obj['agentTokens'] ?? 0),
    done: obj['done'] === true,
    raw: obj,
  };
}

/** The injected port: run ONE scenario under a mode/arm → its sim result. Never throws. */
export type RunSwarmSim = (input: { scenario: SwarmScenario; mode: SwarmMode; workspaceId: string }) => Promise<SwarmSimResult>;

/** Paths/config for the live python runner. */
export interface SwarmLiveDeps {
  exec?: ExecFn;
  /** Vendored repo dir (holds swarmbench_run.py + .venv). */
  repoDir?: string;
  /** Python binary (default the vendored venv). */
  python?: string;
  /** Model id routed through the gateway. */
  model?: string;
  /** OpenAI-compatible gateway base (ends in /v1) — D-003. */
  apiBase?: string;
  apiKey?: string;
  /** Per-scenario wall-clock cap (ms). */
  timeoutMs?: number;
}

export function swarmbenchRepoDir(): string {
  return process.env.PAPERCUSP_SWARMBENCH_DIR ?? join(homedir(), '.papercusp', 'bench-harnesses', 'swarmbench');
}

/** Build the LIVE {@link RunSwarmSim} — shells out to the vendored `swarmbench_run.py`. */
export function pythonRunSwarmSim(deps: SwarmLiveDeps = {}): RunSwarmSim {
  const exec = deps.exec ?? liveExec;
  const repoDir = deps.repoDir ?? swarmbenchRepoDir();
  const python = deps.python ?? join(repoDir, '.venv', 'bin', 'python');
  const model = deps.model ?? 'claude-opus-4-8';
  const apiBase = deps.apiBase ?? `http://127.0.0.1:${process.env.PAPERCUSP_GATEWAY_PORT ?? '8788'}/v1`;
  const apiKey = deps.apiKey ?? process.env.SWARMBENCH_API_KEY ?? 'sk-papercusp-gateway';
  const timeoutMs = deps.timeoutMs ?? 1_800_000;

  return async ({ scenario, mode, workspaceId }): Promise<SwarmSimResult> => {
    const s = scenario;
    const args = [
      join(repoDir, 'swarmbench_run.py'),
      '--task', s.task,
      '--mode', mode,
      '--num-agents', String(s.numAgents),
      '--width', String(s.width),
      '--height', String(s.height),
      '--max-round', String(s.maxRound),
      '--seed', String(s.seed),
      '--view-size', String(s.viewSize),
      '--name', scenarioId(s),
      '--model', model,
      '--api-base', apiBase,
      '--api-key', apiKey,
    ];
    try {
      // Pass the ISOLATED benchmark workspace to the python's memory writes (never production — the
      // owner-flagged pollution; plan benchmark-workspace-isolation-2026-06-18).
      const r = await exec(python, args, { timeoutMs, env: { SWARMBENCH_WORKSPACE: workspaceId } });
      const parsed = parseSwarmSimResult(r.stdout);
      if (parsed.error === undefined && parsed.score === null && r.code !== 0) {
        return { ...parsed, error: `swarmbench_run exited ${r.code}: ${(r.stderr || r.stdout).slice(-300)}` };
      }
      return parsed;
    } catch (e) {
      return { score: null, rounds: 0, agentTokens: 0, done: false, error: `swarmbench_run spawn failed: ${e instanceof Error ? e.message : String(e)}`, raw: null };
    }
  };
}
