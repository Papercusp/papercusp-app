/**
 * @papercusp/fanout-resolver — a generic, pure generative fan-out core.
 *
 * Two halves of "list → N items":
 *   1. RESOLVE a fan-out spec to its item-set — `resolveFanout(spec, { runGlob,
 *      runSql, cap })`. The spec is data (`items` / `glob` / `sql` / `deferred`),
 *      not a generator function; glob/sql runners are injected so the resolver
 *      names no host. Over-cap or failure throws (escalate, never silent
 *      truncation / zero).
 *   2. EXPAND that item-set into N outputs — `expandFanout(items, build, { cap })`
 *      — deduped, trimmed, capped; `shortHash` gives deterministic ids for
 *      idempotent re-expansion.
 *
 * PURE: zero I/O, zero timers, zero domain coupling. The host injects the glob /
 * sql runners and owns the output shape; the lib owns the resolve/dedupe/cap and
 * the deterministic-id hash. First consumer is the promote-policy generative
 * waves, but the lib is consumer-agnostic.
 */

export {
  type FanoutSpec,
  DEFAULT_FANOUT_CAP,
  FanoutCapError,
  FanoutResolverError,
  isFanoutSpec,
  isDeferredFanout,
} from './types';
export { type ResolveFanoutCtx, resolveFanout, dedupeTrim } from './resolve';
export { shortHash, expandFanout } from './expand';
