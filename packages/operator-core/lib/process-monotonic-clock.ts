import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

/** One immutable observation clock per loaded runtime module. Consumers in
 * the same Node process share the exact sampler and identity. A subprocess,
 * restart, or separately loaded copy gets another id: those observations must
 * not be subtracted without a separately verified cross-clock mapping.
 * This identity conveys no request, account, billing or admission authority.
 */
export const processMonotonicClock = Object.freeze({
  id: `process-monotonic:${randomUUID()}`,
  now: performance.now.bind(performance),
});
