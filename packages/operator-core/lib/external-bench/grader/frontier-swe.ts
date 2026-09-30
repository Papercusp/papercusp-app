/**
 * {@link OfficialGrader} backend for **FrontierSWE** (Proximal Labs — github.com/Proximal-Labs/frontier-swe;
 * plan `benchmark-suite-frontier-swe-2026-06-18`).
 *
 * UNLIKE the SWE-bench-family graders (apply a unified diff → run hidden tests → boolean resolved), FrontierSWE
 * is an ULTRA-LONG-HORIZON, CONTINUOUS-SCORE suite (17 tasks; implementation / performance / ML-research;
 * 4–20h agent budgets; no model fully solves the implementation tasks). Each task is a self-contained Docker
 * environment that ships ITS OWN scorer — `tests/test.sh` (the verifier entrypoint) runs `tests/compute_reward.py`
 * which writes `/logs/verifier/reward.txt` (the bare [0,1] scalar) + `/logs/verifier/reward.json` (structured,
 * per-task keys). We do NOT author a verifier — the fairness invariant is that every arm hits the byte-identical
 * task scorer (D-001 / metr-hcast D-004: drive the task's own score, don't reimplement it).
 *
 * SCORE: continuous `score ∈ [0,1]` rides {@link GradeResult.score}; `resolved = (score >= 1)` is the degenerate
 * binary (≈never true for implementation tasks — like agentsnet). The suite headline is mean@5 / best@5 over the
 * continuous score + AVG-RANK / dominance across a coordination-topology arm pool (see
 * `@papercusp/bench-metrics` frontier-rank.ts), NEVER a single resolved% (plan D-002 / D-003).
 *
 * MODALITY = `in-container`: there is no diff to apply — the agent mutated the task container over a long horizon
 * and the task's own verifier grades it in place. The grade step runs `test.sh` against the (still-live) container
 * the arm operated, then reads the reward. The verifier invocation + the reward read are INJECTED
 * (`buildVerifierCommand` / `readReward`) — exactly like the SWE-bench-Verified + TheAgentCompany graders inject
 * their harness CLI — because the Harbor/Docker invocation is host-specific (see `frontier-swe-live.ts`). The pure
 * scoring math ({@link parseFrontierSweReward}) is unit-tested with fixtures, NO docker.
 *
 * C1/C6 FAIRNESS RECONCILIATION (plan D-003): a verifier that RAN and emitted a numeric reward — even `0` from an
 * empty / no-progress workspace — is a genuine capability outcome that COUNTS (score 0, never a vanished row). A
 * verifier that itself FAILED to produce a reward (image/infra/OOM/timeout) is a `graderError` — surfaced and
 * excluded symmetrically across arms, NEVER silently scored 0 as if the agent failed.
 */
import type { ArmSubmission, BenchTask, GradeResult, OfficialGrader } from '../types';
import type { GraderFs, ProcExec } from './swe-bench-pro';

const GRADER_FAMILY = 'frontier-swe';

/**
 * The reward a task's verifier emitted, as read out of the container. `reward.txt` (the bare scalar) is the
 * uniform primary across all 17 tasks; `reward.json` carries the per-task structured breakdown (kept verbatim
 * for reproducibility and used as a fallback when `reward.txt` is absent).
 */
export interface FrontierSweRawReward {
  /** The bare [0,1] scalar parsed from `/logs/verifier/reward.txt`. `null` when the file is absent/unparseable. */
  rewardScalar: number | null;
  /** The structured `/logs/verifier/reward.json` (per-task keys), stored verbatim. Optional. */
  rewardJson?: unknown;
}

/** Pull a [0,1] reward out of a structured `reward.json` regardless of which key the task used (`reward`/`score`). */
export function rewardFromJson(json: unknown): number | null {
  if (typeof json === 'number' && Number.isFinite(json)) return json;
  if (json && typeof json === 'object') {
    const obj = json as Record<string, unknown>;
    for (const key of ['reward', 'score'] as const) {
      const v = obj[key];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
  }
  return null;
}

/** Clamp a raw reward into [0,1] (a buggy verifier can't push the score out of range). */
function clamp01(x: number): number {
  return Math.min(Math.max(x, 0), 1);
}

/**
 * The pure scoring map (the piece most worth getting exactly right). Folds one task's emitted reward into a
 * {@link GradeResult}. `reward.txt`'s scalar wins; else the `reward.json` `reward`/`score` key. A reward that is
 * present-and-numeric (incl. `0`) is SCORED (counts in the denominator); a reward that is entirely ABSENT means the
 * verifier produced no verdict → `graderError`, `score:null`, `resolved:false` — surfaced + excluded, never a
 * silent 0 (C6 / D-003).
 */
export function parseFrontierSweReward(
  raw: FrontierSweRawReward | null | undefined,
  instanceId: string,
  prefix: string,
  version: string,
): GradeResult {
  const scalar = raw?.rewardScalar ?? null;
  const reward = scalar ?? rewardFromJson(raw?.rewardJson);

  if (reward === null || !Number.isFinite(reward)) {
    return {
      instanceId,
      prefix,
      resolved: false,
      score: null,
      rawGraderOutput: { raw, note: 'no numeric reward in reward.txt/reward.json — verifier produced no verdict' },
      graderFamily: GRADER_FAMILY,
      graderVersion: version,
      graderError:
        'FrontierSWE verifier emitted no numeric reward (reward.txt/reward.json absent or unparseable) — image/infra failure?',
    };
  }

  const score = clamp01(reward);
  return {
    instanceId,
    prefix,
    // No model fully solves the implementation tasks → resolved is the degenerate (score === 1) binary; the
    // meaningful headline is `score` (mean@5 / best@5 + rank), not resolved%.
    resolved: score >= 1 - 1e-9,
    score,
    rawGraderOutput: { reward, score, rewardScalar: scalar, rewardJson: raw?.rewardJson ?? null },
    graderFamily: GRADER_FAMILY,
    graderVersion: version,
  };
}

export interface FrontierSweGraderConfig {
  /**
   * The exact grader version PINNED on every row (pre-registration): the FrontierSWE repo commit + the task
   * image-set tag, e.g. "frontier-swe@<sha> / task-images v4-v6". Required — a result must be reproducible.
   */
  version: string;
  /** Scratch root for any host-side temp the binding needs (default OS temp). */
  workRoot?: string;
  /**
   * Run the task's OWN verifier (`tests/test.sh`) against the arm's mutated container. The verifier writes
   * `/logs/verifier/reward.txt` + `reward.json` INSIDE the env. REQUIRED + injected because the Harbor/Docker
   * invocation is host-specific (the live binding `docker exec`s it — see `frontier-swe-live.ts`). `oracle:true`
   * sets `HARBOR_ORACLE_MODE=1` for the gold/positive-control run (skips anti-cheat).
   */
  buildVerifierCommand: (ctx: {
    instanceId: string;
    /** The arm's mutated-env handle ({@link ArmSubmission} `envRef`) — the task container the arm operated. */
    envRef: string;
    /** The matched {@link BenchTask} (its `graderMeta` carries the per-task `verifierCmd` / `rewardPath`). */
    task?: BenchTask;
    oracle?: boolean;
  }) => { cmd: string; args: string[]; cwd?: string; env?: Record<string, string> };
  /**
   * Read the [0,1] reward the verifier wrote for one task (reward.txt primary, reward.json fallback). REQUIRED +
   * injected because the path is INSIDE the container — the binding `docker exec cat` / `docker cp`s it out. May
   * throw (→ that task's grade errors, surfaced).
   */
  readReward: (ctx: {
    instanceId: string;
    envRef: string;
    /** The matched {@link BenchTask} (its `graderMeta.rewardPath` / `rewardJsonPath` say where the verifier wrote). */
    task?: BenchTask;
    readFile: (path: string) => Promise<string>;
    exec: ProcExec;
  }) => Promise<FrontierSweRawReward>;
}

export interface FrontierSweGraderDeps {
  exec: ProcExec;
  fs: GraderFs;
}

/**
 * Build the live FrontierSWE grader. Arm-agnostic (the fairness invariant) — it cannot tell which arm produced a
 * run. For each `in-container` submission it runs that task's `test.sh` against the arm's `envRef`, reads the
 * reward, and folds it into a {@link GradeResult} carrying the continuous `score`. A task whose verifier errors
 * (or whose reward is absent) → `graderError`, surfaced + excluded, never a silent fail. `diff`/`qa`/
 * `deliverable-bundle` submissions are ignored (FrontierSWE is in-container only).
 */
export function makeFrontierSweGrader(cfg: FrontierSweGraderConfig, deps: FrontierSweGraderDeps): OfficialGrader {
  const { exec, fs } = deps;

  return {
    family: GRADER_FAMILY,
    modality: 'in-container',
    async grade(submissions: ArmSubmission[], tasks: BenchTask[]): Promise<GradeResult[]> {
      const envSubs = submissions.filter(
        (s): s is Extract<ArmSubmission, { modality: 'in-container' }> => s.modality === 'in-container',
      );
      if (envSubs.length === 0) return [];

      const taskById = new Map(tasks.map((t) => [t.instanceId, t] as const));
      const out: GradeResult[] = [];
      for (const sub of envSubs) {
        const task = taskById.get(sub.instanceId);
        try {
          const { cmd, args, cwd, env } = cfg.buildVerifierCommand({ instanceId: sub.instanceId, envRef: sub.envRef, task });
          const { code, stderr } = await exec(cmd, args, { cwd, env });

          let raw: FrontierSweRawReward;
          try {
            raw = await cfg.readReward({
              instanceId: sub.instanceId,
              envRef: sub.envRef,
              task,
              readFile: (p) => fs.readFile(p),
              exec,
            });
          } catch (e) {
            const detail =
              `could not read FrontierSWE reward for ${sub.instanceId}: ` +
              `${e instanceof Error ? e.message : String(e)}` +
              (code !== 0 ? ` (verifier exit ${code}: ${stderr.slice(0, 400)})` : '');
            out.push({
              instanceId: sub.instanceId,
              prefix: sub.prefix,
              resolved: false,
              score: null,
              rawGraderOutput: { batchError: detail },
              graderFamily: GRADER_FAMILY,
              graderVersion: cfg.version,
              graderError: detail,
            });
            continue;
          }

          out.push(parseFrontierSweReward(raw, sub.instanceId, sub.prefix, cfg.version));
        } catch (e) {
          // The verifier exec itself threw (spawn failure) — an infra failure, surfaced not silently scored.
          const detail = `FrontierSWE verifier exec failed for ${sub.instanceId}: ${e instanceof Error ? e.message : String(e)}`;
          out.push({
            instanceId: sub.instanceId,
            prefix: sub.prefix,
            resolved: false,
            score: null,
            rawGraderOutput: { batchError: detail },
            graderFamily: GRADER_FAMILY,
            graderVersion: cfg.version,
            graderError: detail,
          });
        }
      }
      return out;
    },
  };
}
