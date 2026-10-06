/**
 * WI-10005695 — per-step timings for `release:repair-queue` admit/converge.
 *
 * An admit is a chain of slow, opaque steps (queue inspection, edit-ledger read, hunk-exact
 * synthesis, the proving build, dependency prediction, containment, queue writes). One
 * 31-path wholeBlob dry-run ran ~9 minutes server-side while its client gave up at 300s, and
 * nothing said which step held it. This clock gives every step a name and a duration, and it
 * writes them to two places:
 *
 * - the RESPONSE (`timings`), for a call that returns, however slowly;
 * - the operator JOURNAL, for a call that does not return before its client gives up. A step
 *   still running after `stillRunningMs` logs once, naming the step, so `logs:read` localizes a
 *   hang even when no response ever reaches the caller.
 *
 * Wall-clock only. The clock observes; it never cancels or times out a step.
 */

export interface AdmissionStepTiming {
  step: string;
  ms: number;
  ok: boolean;
}

export interface AdmissionStepTimings {
  /** Elapsed since the clock was created, at the moment the summary was taken. */
  totalMs: number;
  /** Completed steps, in completion order. A repeated step name appears once per run. */
  steps: AdmissionStepTiming[];
  /** Steps started but not yet settled when the summary was taken (normally empty). */
  inFlight: string[];
}

export interface AdmissionStepClockOptions {
  /** Context stamped on every journal line, e.g. `op=admit paths=31 dryRun=true`. */
  context: string;
  /** A settled step at or above this duration is logged. Default 5s. */
  slowLogMs?: number;
  /** A step still running at this age is logged once. Default 30s. */
  stillRunningMs?: number;
  /** Journal sink; defaults to console.warn. Injected by tests. */
  log?: (line: string) => void;
  /** Clock source; defaults to Date.now. Injected by tests. */
  now?: () => number;
}

export interface AdmissionStepClock {
  step<T>(name: string, run: () => Promise<T>): Promise<T>;
  summary(): AdmissionStepTimings;
}

const LOG_PREFIX = '[release:repair-queue]';

export function createAdmissionStepClock(options: AdmissionStepClockOptions): AdmissionStepClock {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.warn(line));
  const slowLogMs = options.slowLogMs ?? 5_000;
  const stillRunningMs = options.stillRunningMs ?? 30_000;
  const startedAtMs = now();
  const steps: AdmissionStepTiming[] = [];
  const inFlight = new Map<number, string>();
  let nextId = 0;

  return {
    async step<T>(name: string, run: () => Promise<T>): Promise<T> {
      const id = nextId++;
      const stepStartedAtMs = now();
      inFlight.set(id, name);
      const watchdog = setTimeout(() => {
        log(
          `${LOG_PREFIX} step '${name}' still running after ${Math.round((now() - stepStartedAtMs) / 1000)}s ` +
            `(${options.context}; call age ${Math.round((now() - startedAtMs) / 1000)}s)`,
        );
      }, stillRunningMs);
      watchdog.unref?.();
      let ok = false;
      try {
        const value = await run();
        ok = true;
        return value;
      } finally {
        clearTimeout(watchdog);
        inFlight.delete(id);
        const ms = now() - stepStartedAtMs;
        steps.push({ step: name, ms, ok });
        if (ms >= slowLogMs) {
          log(`${LOG_PREFIX} step '${name}' ${ok ? 'settled' : 'threw'} after ${ms}ms (${options.context})`);
        }
      }
    },
    summary(): AdmissionStepTimings {
      return {
        totalMs: now() - startedAtMs,
        steps: steps.map((s) => ({ ...s })),
        inFlight: [...inFlight.values()],
      };
    },
  };
}
