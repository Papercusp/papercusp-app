import type { ColdStartOptions, ColdStartResult, LivenessProbe, ReadinessProbe } from './types.js';
import { waitUntilReady } from './wait-until-ready.js';

/**
 * Wait for GUI readiness and, only for a genuinely fresh launch, report the
 * cold-start latency (birth → ready).
 *
 * The caller declares `origin` up front:
 *
 * - `'launched'` — this call (or its caller, immediately before calling this)
 *   observed the process's birth. Pass `launchedAtMs` (defaults to "now" at call
 *   entry). `coldStartMs` is `readyAt - launchedAtMs` when the wait succeeds.
 * - `'attached'` — this call is attaching to a process whose birth it did NOT
 *   observe (it may be a long-lived, persistent app process that was already
 *   running). The SAME bounded, level-triggered wait still runs (so the caller
 *   gets a definite ready/not-ready answer, never a hang), but `coldStartMs` is
 *   always `null` — reporting "how long THIS call happened to wait" as a
 *   cold-start number would be fabricated, not measured, for a process that may
 *   have been ready long before this call started watching it.
 *
 * This split is the point of the library: nothing here EVER blocks waiting for a
 * one-shot "just started" signal, so attaching to a persistent, already-ready
 * process resolves immediately in both branches — only the *interpretation* of
 * the elapsed time differs.
 */
export async function measureGuiColdStart(
  probe: ReadinessProbe,
  liveness: LivenessProbe | undefined,
  options: ColdStartOptions,
): Promise<ColdStartResult> {
  const now = options.now ?? Date.now;
  const callStart = now();
  const launchedAtMs = options.origin === 'launched' ? options.launchedAtMs ?? callStart : undefined;

  const outcome = await waitUntilReady(probe, liveness, options);

  const readyAtMs = now();
  const coldStartMs =
    options.origin === 'launched' && outcome.ok && launchedAtMs !== undefined
      ? Math.max(0, readyAtMs - launchedAtMs)
      : null;

  return {
    ok: outcome.ok,
    ready: outcome.ready,
    origin: options.origin,
    waitedMs: outcome.elapsedMs,
    coldStartMs,
    ...(outcome.ok ? {} : { reason: outcome.reason }),
  };
}
