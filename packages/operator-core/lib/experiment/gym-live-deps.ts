/**
 * The gym un-staging primitive (experiment-registry-invocation-api #3/B) — composes
 * `createGymRunnerPorts` + `buildAbDeps` into the live `AbDeps` you inject as
 * `experiment:run`'s `ctx.gym.abDeps` to un-stage the gym tier.
 *
 * IMPORTANT infra reality: this REQUIRES a running **gym-operator** instance
 * (`operatorBaseUrl`, e.g. http://127.0.0.1:3971), a gym Postgres (`gymSql`), and the
 * superuser token — the heavy infra the **gym blueprint** provisions. `experiment:run`
 * cannot conjure a gym-operator, so the gym tier is un-staged ONLY when the owner
 * supplies a gym-operator config here. And the gym already **self-drives** over exactly
 * this infra (its director + autoloop), so driving it through `experiment:run` is the
 * rarely-needed ad-hoc path, not the primary one — the **replay tier** is the
 * experiment:run workhorse. (The same is true of the instance/hive tiers — they need
 * their own boot/Hive infra; this primitive is the gym worked example.)
 */
import type { AbDeps } from '../gym/ab-runner';
import { buildAbDeps, type RealAbDepsConfig } from '../gym/ab-runner-real';
import { createGymRunnerPorts, type GymRunnerPortsConfig } from '../gym/runner-ports';

export interface ExperimentGymDepsConfig extends GymRunnerPortsConfig {
  /** The judge LLM call (the real llmCall for a live run). */
  llmCall: RealAbDepsConfig['llmCall'];
  /** Scratch root for clones + trace bundles. */
  scratchRoot: string;
  /** Hard wall-clock cap per pipeline run (default 30 min). */
  timeoutMs?: number;
  /** Delay between status polls (default 5s). */
  pollIntervalMs?: number;
  /** The target blueprint's gym.collectTrace strategy (default git-diff). */
  collectStrategy?: RealAbDepsConfig['collectStrategy'];
}

/** Build the live gym AbDeps to inject as `experiment:run`'s `ctx.gym.abDeps`. Pure
 *  composition — no I/O until the returned deps are actually run. Requires a gym-operator
 *  config (see the file header). */
export function buildExperimentGymAbDeps(cfg: ExperimentGymDepsConfig): AbDeps {
  return buildAbDeps({
    gymSql: cfg.gymSql,
    ports: createGymRunnerPorts(cfg),
    llmCall: cfg.llmCall,
    timeoutMs: cfg.timeoutMs ?? 30 * 60_000,
    pollIntervalMs: cfg.pollIntervalMs ?? 5_000,
    scratchRoot: cfg.scratchRoot,
    ...(cfg.collectStrategy ? { collectStrategy: cfg.collectStrategy } : {}),
  });
}
