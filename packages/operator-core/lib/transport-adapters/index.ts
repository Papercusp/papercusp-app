/**
 * Re-export shim — the endpoint-stream transport (IPC + HTTP picker, shared
 * types + sse-parser, desktop polyfills) now lives in @papercusp/desktop-ipc
 * (extracted per papercusp-systems-abstraction-2026-05-29, P-030). Kept at
 * this path so `@/lib/transport-adapters` consumers resolve unchanged; new
 * code should import from '@papercusp/desktop-ipc' directly.
 */
import './configure';
export * from '@papercusp/desktop-ipc';
export {
  classifyOriginSchedulerFetch,
  installOriginSchedulerFetch,
  isIdempotentReadMethod,
} from './origin-scheduler-fetch';
export type { OriginSchedulerFetchDecision } from './origin-scheduler-fetch';
