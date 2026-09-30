/**
 * Tracked fire-and-forget dynamic imports — the import analogue of `managedSpawn`
 * (task-manager) and `managedSetInterval` (scheduler): a detached thing stays VISIBLE.
 *
 * WHY THIS EXISTS. Several modules deliberately fire a lazy side-effect import and return
 * without awaiting it, so a pure/PG-free core never statically depends on the SSE, health,
 * or calibration layers:
 *
 *     void import('../../sync-sse').then((m) => m.notifySyncInvalidate(...)).catch(() => {});
 *
 * Under Vitest that promise routinely outlives the test file that started it. When the file's
 * environment is torn down mid-graph, the module runner throws
 *
 *     EnvironmentTeardownError: Cannot load '<mod>' imported from '<mod>' after the
 *     environment was torn down.
 *
 * and in the PURE lane (`isolate: false`, so files share a fork — libs/test-config
 * vitest-config.ts) the failure is attributed to whichever CO-RESIDENT file is collecting when
 * it lands. Those victims report `(0 test)` — they genuinely fail to load — and pass again in a
 * fresh isolated process. Measured on the 2026-08-18 gate (candidate 079cd254): 8 failed suites,
 * a rotating cast, callstack `decay.test.ts → decay.ts → sync-sse.ts → @papercusp/sync
 * server/index.ts → invalidation-bus.ts`.
 *
 * ⚠ A `.catch()` ON THE FLOATING IMPORT DOES NOT PREVENT THIS, so "just add a catch" is not a
 * fix. Both sites in `decay.ts` already had `.catch(() => {})` and still reddened the gate: the
 * throw happens on an INNER module request inside the static re-export graph, and Vitest raises
 * it through its own error channel rather than rejecting the outer promise.
 *
 * THE FIX. Register the promise here and DRAIN it before the environment goes away —
 * `drainDetached()` runs from an `afterEach`/`afterAll` in the unit-layer setup
 * (`./setup-vitest.ts`, wired in packages/operator-core/vitest.config.ts).
 *
 * PRODUCTION SEMANTICS ARE UNCHANGED: `trackDetached` returns the SAME promise it was given,
 * callers still `void` it, nothing is awaited, and the registry drops each entry as it settles,
 * so the Set is bounded by in-flight concurrency. Nothing calls `drainDetached()` outside tests.
 */

import { pinModuleState } from '@papercusp/module-singleton';

interface DetachedState {
  /** In-flight detached work, as never-rejecting mirrors of the caller's promises. */
  pending: Set<Promise<void>>;
}

// pinModuleState, NOT a module-scoped `new Set()`: the registry is written by operator-core
// modules and read by the Vitest setup file, which can reach this file through a different
// module record (bare specifier vs relative path, tsx's CJS preflight beside the ESM loader,
// a symlinked node_modules/@papercusp copy). A split record would give the drain its OWN empty
// Set and it would return instantly while the real imports were still in flight — the exact
// failure this module exists to remove, reintroduced silently.
const state = pinModuleState<DetachedState>(
  '@papercusp/operator-core.detached-imports',
  () => ({ pending: new Set<Promise<void>>() }),
);

const swallow = (): void => undefined;

/**
 * Register a fire-and-forget promise so a test environment can wait for it.
 *
 * Returns `promise` UNCHANGED — this is a pass-through, so wrapping a call site never alters
 * its control flow, its rejection behaviour, or when it resolves.
 *
 * ```ts
 * void trackDetached(import('../../sync-sse').then((m) => m.notifySyncInvalidate('x'))).catch(() => {});
 * ```
 */
export function trackDetached<T>(promise: Promise<T>): Promise<T> {
  // Mirror it: the tracked copy must never itself become an unhandled rejection, and the
  // caller keeps ownership of the real error handling.
  const mirror = promise.then(swallow, swallow);
  state.pending.add(mirror);
  void mirror.then(() => {
    state.pending.delete(mirror);
  });
  return promise;
}

/**
 * Await every registered detached promise. Returns how many were drained.
 *
 * Loops until the registry is quiescent because a settling import can register more work
 * (a `.then()` that fires another lazy import).
 */
export async function drainDetached(): Promise<number> {
  let drained = 0;
  while (state.pending.size > 0) {
    const batch = [...state.pending];
    // Take the batch out up-front: `Promise.all` can resume before the per-promise cleanup
    // microtask runs, which would otherwise re-await the same settled entries.
    for (const p of batch) state.pending.delete(p);
    drained += batch.length;
    await Promise.all(batch);
  }
  return drained;
}

/** How many detached promises are currently in flight. */
export function pendingDetachedCount(): number {
  return state.pending.size;
}
