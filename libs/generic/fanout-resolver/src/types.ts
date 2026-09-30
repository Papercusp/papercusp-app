/**
 * Generative fan-out — the shared shapes, cap, and error taxonomy.
 *
 * A fan-out *spec* declares how a runtime item-set is produced; resolving it
 * yields a list of string items, each of which the host then expands into one
 * output (a feature, a job, a file, …). The spec is data, not a generator
 * function — its set is produced by RUNNING A QUERY (or read from an upstream
 * producer), never by an LLM.
 */

/**
 * A generative fan-out spec: resolves to a list of string items.
 *  - `items`:    an inline, explicit set
 *  - `glob`:     paths matching a glob, via an injected runner
 *  - `sql`:      the first column of each row, via an injected query runner
 *  - `deferred`: the set is produced LATER by a named upstream producer (its
 *                items aren't known at resolve time, so resolving throws — the
 *                host expands it at completion time instead).
 *
 * The four kinds are mutually exclusive; a well-formed spec has exactly one key.
 */
export type FanoutSpec =
  | { items: string[] }
  | { glob: string }
  | { sql: string }
  | { deferred: string };

/** Default cap on how many items one fan-out may resolve/expand to. */
export const DEFAULT_FANOUT_CAP = 200;

/**
 * A fan-out resolved/expanded to MORE items than the cap allows → escalate.
 * Never silently truncate: raise the cap or narrow the query.
 */
export class FanoutCapError extends Error {
  readonly count: number;
  readonly cap: number;
  constructor(count: number, cap: number) {
    super(
      `fan-out resolved ${count} items > cap ${cap} — escalate ` +
        `(raise the cap or narrow the query) rather than silently truncating`,
    );
    this.name = 'FanoutCapError';
    this.count = count;
    this.cap = cap;
  }
}

/** A resolver failed to run (bad glob, query error, missing runner, deferred spec) → escalate. */
export class FanoutResolverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FanoutResolverError';
  }
}

/**
 * True when a value is a fan-out *spec* (an object), as opposed to some other
 * representation a host may also allow (e.g. a bare named-set string the caller
 * resolves itself). A null-safe object check — the spec's key discriminates which
 * kind it is.
 */
export function isFanoutSpec(value: unknown): value is FanoutSpec {
  return typeof value === 'object' && value !== null;
}

/**
 * True when a spec is `deferred` — its item-set is produced by an upstream
 * producer at completion time and is NOT resolvable now. The promote-time kinds
 * (items/glob/sql) return false.
 */
export function isDeferredFanout(spec: FanoutSpec): spec is { deferred: string } {
  return isFanoutSpec(spec) && 'deferred' in spec;
}
