/**
 * hive-backlog-utilities.ts — GENERIC, suite-agnostic helpers shared by every fleet-arm backlog driver
 * (the su-independent pool, the hive-realqueen driver, and the METR HCAST in-container pool).
 *
 * WHY THIS EXISTS (benchmark-suite-metr-hcast-2026-06-17, owner-directed extraction). The SWE-bench-Pro
 * drivers ({@link ./su-independent-backlog.ts} + {@link ./hive-backlog-realqueen.ts}) and the METR HCAST
 * driver ({@link ./metr-hcast-backlog.ts}) all share the SAME orchestration skeleton — a concurrency pool,
 * live-occupancy sampling into a {@link ConcurrencyTimeline}, and the never-throw drain. Only the per-task
 * WORK SURFACE differs (M1 host-worktree + diff vs M2 in-container + score). This module factors the
 * work-surface-AGNOSTIC pieces out so all drivers build on ONE implementation, and the suite-specific bit is
 * just the injected per-task ops. Pure (only `now()` injected) → unit-testable without docker/fleet.
 */
import type { CoordEvent, FleetArmId } from '@papercusp/bench-metrics';
import type {
  ConcurrencyTimeline,
  FleetTaskResult,
  HiveBacklogDriver,
  HiveBacklogResult,
  HiveBacklogRunRequest,
} from './hive-backlog';
import type { BenchTask, GenerationBudget } from './types';

/**
 * Live-concurrency accounting for a backlog pool. `live` is the ground-truth occupancy (++ when a task's
 * agent goes live, -- when it finishes); the sampler reads it on a cadence into `samples`, and `peak` is
 * tracked inline so the scalar peak stays correct even when the run is shorter than one sample interval.
 * The driver owns the timer (a real `setInterval`); this owns the counter + the {@link ConcurrencyTimeline}
 * projection. Extracted verbatim from the su-independent pool so its semantics are unchanged.
 */
export interface ConcurrencySampler {
  /** ++ occupancy (a task's agent just went live). */
  enter(): void;
  /** -- occupancy (a task just finished), floored at 0. */
  exit(): void;
  /** Snapshot the current occupancy into the timeline (call on a fixed cadence + at start/finish). */
  sample(): void;
  /** The inline scalar peak (max occupancy ever observed) — populated even with zero samples. */
  peak(): number;
  /** Project the accumulated samples → the {@link ConcurrencyTimeline} (avg + sampled/inline peak). */
  finalize(): ConcurrencyTimeline;
}

/**
 * Build a {@link ConcurrencySampler} for a run that started at `startedAtMs`, reading logical time from
 * the injected `now` (so a fake-clock unit test drives it deterministically). Take an initial + final
 * `sample()` around the run so the timeline is never empty.
 */
export function makeConcurrencySampler(startedAtMs: number, now: () => number): ConcurrencySampler {
  let live = 0;
  let peak = 0;
  const samples: { tMs: number; live: number }[] = [];
  return {
    enter(): void {
      live += 1;
      if (live > peak) peak = live;
    },
    exit(): void {
      live = Math.max(0, live - 1);
    },
    sample(): void {
      samples.push({ tMs: now() - startedAtMs, live });
      if (live > peak) peak = live;
    },
    peak(): number {
      return peak;
    },
    finalize(): ConcurrencyTimeline {
      const avgConcurrent = samples.length > 0 ? samples.reduce((s, x) => s + x.live, 0) / samples.length : 0;
      const sampledPeak = samples.reduce((m, x) => Math.max(m, x.live), 0);
      return { samples, avgConcurrent, peakConcurrent: Math.max(sampledPeak, peak) };
    },
  };
}

/** Default cadence for the concurrency sampler (ms) — shared so every driver samples on the same beat. */
export const DEFAULT_SAMPLE_INTERVAL_MS = 1_000;
/** Default wall-clock ceiling for a whole backlog drain (ms) before a driver gives up and returns partial. */
export const DEFAULT_FLEET_TIMEOUT_MS = 90 * 60 * 1_000;

/**
 * Run a backlog through a bounded concurrency POOL (the work-surface-agnostic core every fleet-arm pool
 * driver shares). `cap` worker loops each pull the next un-started task, run `perTask(task, index)` to a
 * settled result, then loop — so ≤`cap` agents are live at once and the backlog drains in waves of ≤cap.
 * `perTask` MUST NOT throw (mirror the never-throw generation contract — return an error-result instead);
 * a deadline stops pulling. `onEntered`/`onExited` bracket the live window for the {@link ConcurrencySampler}.
 * Results are returned in completion order. This is exactly the su-independent pool loop, generalised over
 * the per-task work so the SWE-bench (M1) and METR HCAST (M2) drivers share ONE implementation.
 */
export async function runConcurrencyPool<R>(input: {
  backlogLength: number;
  cap: number;
  now: () => number;
  deadlineMs: number;
  perTask: (index: number) => Promise<R>;
  onEntered?: () => void;
  onExited?: () => void;
  onResult?: (r: R, index: number) => void | Promise<void>;
}): Promise<{ results: R[]; timedOut: boolean }> {
  const { backlogLength, now, deadlineMs, perTask } = input;
  const cap = Math.max(1, Math.floor(input.cap) || 1);
  const results: R[] = [];
  let nextIndex = 0;
  let timedOut = false;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (now() >= deadlineMs) {
        timedOut = true;
        return;
      }
      const i = nextIndex;
      if (i >= backlogLength) return;
      nextIndex += 1;
      input.onEntered?.();
      let r: R;
      try {
        r = await perTask(i);
      } finally {
        input.onExited?.();
      }
      results.push(r);
      if (input.onResult) await input.onResult(r, i);
    }
  };

  const poolSize = Math.max(1, Math.min(cap, backlogLength || 1));
  await Promise.all(Array.from({ length: poolSize }, () => worker()));
  return { results, timedOut };
}

/** The injected per-task work for {@link makePoolBacklogDriver}: run ONE backlog task → one canonical
 *  {@link FleetTaskResult}. MUST NOT throw (the never-throw generation contract — return an error result
 *  instead). The whole call is bracketed as the task's live window for the concurrency timeline. */
export type PoolPerTask = (input: {
  task: BenchTask;
  index: number;
  arm: FleetArmId;
  seed: string;
  budget: GenerationBudget;
}) => Promise<FleetTaskResult>;

/** Deps for {@link makePoolBacklogDriver}. */
export interface PoolBacklogDeps {
  now: () => number;
  concurrencyCap: () => number | Promise<number>;
  /** The per-task work (the only suite-specific bit). */
  perTask: PoolPerTask;
  fleetTimeoutMs?: number;
  sampleIntervalMs?: number;
  /** Optional run-level coordination trace (hive arms emit placements; pool/independent arms → []). */
  collectCoordEvents?: () => CoordEvent[] | Promise<CoordEvent[]>;
  /** Fired the instant each task settles → durability (a partial/killed run still banks its rows). */
  onResult?: (r: FleetTaskResult) => void | Promise<void>;
}

/**
 * Build a generic POOL-topology {@link HiveBacklogDriver} — the whole shell every non-diff (M2 / interactive)
 * fleet-arm shares: the {@link ConcurrencySampler} + the bounded never-throw {@link runConcurrencyPool} +
 * the canonical {@link HiveBacklogResult} projection. A suite supplies ONLY its {@link PoolPerTask} (e.g.
 * METR HCAST: prepare container → driveArm → score; tau2: run the agent↔sim conversation → reward-score).
 * `req.arm` selects which agent loop the suite's perTask runs; the orchestration is identical → causal
 * arm isolation. Never throws (a per-task failure lands its error FleetTaskResult; a run-level failure →
 * a partial result carrying `runError`).
 */
export function makePoolBacklogDriver(deps: PoolBacklogDeps): HiveBacklogDriver {
  const fleetTimeoutMs = deps.fleetTimeoutMs ?? DEFAULT_FLEET_TIMEOUT_MS;
  const sampleIntervalMs = deps.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;

  return {
    async run(req: HiveBacklogRunRequest): Promise<HiveBacklogResult> {
      const startedAtMs = deps.now();
      const occupancy = makeConcurrencySampler(startedAtMs, deps.now);
      occupancy.sample();
      const timer = setInterval(() => occupancy.sample(), Math.max(1, sampleIntervalMs));
      if (typeof timer.unref === 'function') timer.unref();

      const taskResults: FleetTaskResult[] = [];
      let cap = 1;
      try {
        cap = Math.max(1, Math.floor(await deps.concurrencyCap()) || 1);
      } catch {
        cap = 1;
      }

      const finalize = (runError?: string, coordEvents: CoordEvent[] = []): HiveBacklogResult => {
        clearInterval(timer);
        occupancy.sample();
        return {
          arm: req.arm,
          suite: req.suite,
          runId: req.runId,
          seed: req.seed,
          startedAtMs,
          finishedAtMs: deps.now(),
          peakConcurrentBees: occupancy.peak(),
          taskResults,
          coordEvents,
          concurrencyTimeline: occupancy.finalize(),
          ...(runError ? { runError } : {}),
        };
      };

      try {
        const { timedOut } = await runConcurrencyPool<FleetTaskResult>({
          backlogLength: req.backlog.length,
          cap,
          now: deps.now,
          deadlineMs: startedAtMs + fleetTimeoutMs,
          onEntered: () => occupancy.enter(),
          onExited: () => occupancy.exit(),
          perTask: (i) => deps.perTask({ task: req.backlog[i], index: i, arm: req.arm, seed: String(req.seed), budget: req.budget }),
          onResult: async (r) => {
            taskResults.push(r);
            await Promise.resolve(deps.onResult?.(r)).catch(() => {});
          },
        });
        const coordEvents = (await deps.collectCoordEvents?.()) ?? [];
        return finalize(timedOut ? `run wall-clock timeout after ${fleetTimeoutMs}ms (backlog not fully drained)` : undefined, coordEvents);
      } catch (e) {
        return finalize(e instanceof Error ? e.message : String(e));
      }
    },
  };
}
