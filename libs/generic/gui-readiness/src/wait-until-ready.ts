import type { LivenessProbe, ReadinessOutcome, ReadinessProbe, WaitOptions } from './types.js';

const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_PROBE_TIMEOUT_MS = 5000;

function realNow(): number {
  return Date.now();
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Race a probe call against its own bound so ONE wedged/never-resolving call
 * cannot silently consume (or blow past) the overall wait budget. A timeout is
 * treated as the caller-provided fallback rather than an error. Readiness uses
 * `false` (not ready this round), while liveness uses `true` (alive UNKNOWN): a
 * slow or broken liveness sensor is not evidence that the process exited.
 */
async function boundedProbe(
  call: () => Promise<boolean>,
  timeoutMs: number,
  fallback: boolean,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs);
  });
  try {
    return await Promise.race([call().catch(() => fallback), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function validateDuration(name: string, value: number, allowZero: boolean): void {
  if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) {
    const qualifier = allowZero ? 'non-negative' : 'positive';
    throw new Error(`waitUntilReady: ${name} must be a ${qualifier} finite number, got ${value}`);
  }
}

/**
 * Wait for `probe.checkReady()` to report ready, bounded by `options.timeoutMs`.
 *
 * LEVEL-triggered by construction: the very first check happens immediately (no
 * initial poll delay), so a persistent process that was ALREADY ready before this
 * call started returns instantly instead of waiting for a poll interval or — the
 * bug class this exists to prevent — an edge-triggered signal that already fired
 * in the past and will never fire again. Every subsequent check is likewise a
 * fresh read of current state, never a wait on a one-shot event.
 *
 * Bounded by construction on every axis: the overall wait never exceeds
 * `timeoutMs`; each individual probe/liveness call never exceeds `probeTimeoutMs`
 * (so one wedged call can't eat the whole budget); and a dead process (per
 * `liveness.isAlive()`) fails fast with `reason: 'process_exited'` instead of
 * waiting out the remaining deadline for a readiness signal that can no longer
 * arrive.
 */
export async function waitUntilReady(
  probe: ReadinessProbe,
  liveness: LivenessProbe | undefined,
  options: WaitOptions,
): Promise<ReadinessOutcome> {
  validateDuration('timeoutMs', options.timeoutMs, true);
  const now = options.now ?? realNow;
  const sleep = options.sleep ?? realSleep;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const requestedProbeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  validateDuration('pollIntervalMs', pollIntervalMs, true);
  validateDuration('probeTimeoutMs', requestedProbeTimeoutMs, false);
  const probeTimeoutMs = Math.min(requestedProbeTimeoutMs, Math.max(options.timeoutMs, 1));

  const start = now();
  const deadline = start + options.timeoutMs;

  for (;;) {
    if (liveness) {
      const livenessBudgetMs = Math.max(1, Math.min(probeTimeoutMs, deadline - now()));
      const alive = await boundedProbe(() => liveness.isAlive(), livenessBudgetMs, true);
      if (!alive) {
        return { ok: false, ready: false, elapsedMs: now() - start, reason: 'process_exited' };
      }

      // A liveness call may have consumed the remaining budget. Its timeout or
      // exception means UNKNOWN (not dead), but it must not grant readiness an
      // additional full probe budget beyond the outer deadline.
      if (options.timeoutMs > 0 && now() >= deadline) {
        return { ok: false, ready: false, elapsedMs: now() - start, reason: 'timeout' };
      }
    }

    const readinessBudgetMs = Math.max(1, Math.min(probeTimeoutMs, deadline - now()));
    const ready = await boundedProbe(() => probe.checkReady(), readinessBudgetMs, false);
    if (ready && now() <= deadline) {
      return { ok: true, ready: true, elapsedMs: now() - start };
    }

    if (now() >= deadline) {
      return { ok: false, ready: false, elapsedMs: now() - start, reason: 'timeout' };
    }

    const remaining = deadline - now();
    await sleep(Math.max(0, Math.min(pollIntervalMs, remaining)));

    if (now() >= deadline) {
      return { ok: false, ready: false, elapsedMs: now() - start, reason: 'timeout' };
    }
  }
}
