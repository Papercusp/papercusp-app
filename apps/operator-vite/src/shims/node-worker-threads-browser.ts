/**
 * Browser shim for `node:worker_threads` (WI-4518 — the last externalized-warnings
 * holdout; also documented in libs/generic/tooldef/src/browser-safe-barrel.test.ts as
 * the ORIGINAL 2026-07-04 white-page incident source).
 *
 * `libs/generic/tooldef/src/code-orchestration/run-script.ts` already loads this LAZILY
 * (`await import('node:worker_threads')` inside `runOrchestrationScript`, itself
 * server-only code-execution plumbing the SPA never calls) — the crash that shipped
 * 2026-07-04 was a STATIC top-level import, which the barrel test now pins against.
 * The lazy load no longer crashes the SPA, but Rolldown still resolves the dynamic
 * import target to emit a chunk, which is what shows up as an "externalized for
 * browser compatibility" warning. Shimming it closes that last warning; the throw
 * contract matches every other shim in this directory (never reached — the SPA never
 * actually calls `runOrchestrationScript`).
 */

function serverOnly(): never {
  throw new Error('node:worker_threads is server-only and cannot run in the operator-vite browser bundle');
}

const trap: ProxyHandler<object> = {
  get(_t, prop) {
    if (prop === Symbol.toPrimitive || prop === 'toString') return () => '[worker_threads-browser-shim]';
    return serverOnly;
  },
  apply: serverOnly,
  construct: serverOnly,
};

export const Worker = new Proxy(function Worker() {
  serverOnly();
}, trap) as never;
export const parentPort = null;
export const workerData = undefined;
export const isMainThread = true;
export const threadId = 0;
// packages/operator-core/lib/release/admission-offthread.ts passes it as a Worker env.
export const SHARE_ENV = Symbol.for('nodejs.worker_threads.SHARE_ENV');
export default new Proxy({}, trap) as never;
