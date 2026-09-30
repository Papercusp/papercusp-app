/**
 * Named-query registry + dispatcher — the server half of @papercusp/sync.
 *
 * A `QueryRegistry` maps a dot-separated query name (`plans.items`,
 * `harnessStatus.byHarness`) to a resolver that returns a flat row array.
 * `createResolver(registry)` turns it into a `(name, args) => rows[]`
 * dispatcher with optional per-entry arg validation.
 *
 * Domain-free by construction: the registry ENTRIES are supplied by the
 * host (each owns its own data access — drizzle, raw SQL, file reads,
 * an HTTP call, anything). This module never touches a database; it only
 * dispatches. The host maps its domain onto the seam by building the
 * registry and passing it in.
 *
 * Mirrors the contract the client transport expects: the polling/SSE
 * REST endpoint returns `{ rows }` for a `(name, args)` pair, and the
 * client caches it under `['sync', name, args]`.
 */

/** Sentinel returned when a name isn't in the registry. Callers map it to
 *  a 400 (single) / per-slot error (batch). */
export const NAME_NOT_FOUND = Symbol('@papercusp/sync:NAME_NOT_FOUND');
export type NameNotFound = typeof NAME_NOT_FOUND;

/**
 * Minimal validator shape — structurally satisfied by a Zod schema
 * (`z.object({...})` has `.parse`). Kept as a tiny interface so the lib
 * takes NO schema-library dependency; the host passes whatever it uses.
 */
export interface ArgsValidator<A> {
  parse(input: unknown): A;
}

export interface QueryEntry<A = unknown> {
  /** Optional arg validation/coercion. Omit to accept args unchanged. */
  argsSchema?: ArgsValidator<A>;
  /** Resolve validated args to a flat row array. */
  resolve: (args: A) => Promise<unknown[]>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type QueryRegistry = Record<string, QueryEntry<any>>;

export type NamedQueryResolver = (
  name: string,
  args: unknown,
) => Promise<unknown[] | NameNotFound>;

/** Thrown when an entry's `resolve()` doesn't settle within `timeoutMs` — see
 *  `CreateResolverOptions.timeoutMs`. Distinguishable from a downstream error
 *  so a caller/route can map it to a specific status (e.g. 504) if it wants. */
export class QueryResolveTimeoutError extends Error {
  constructor(
    public readonly queryName: string,
    public readonly timeoutMs: number,
  ) {
    super(`query "${queryName}" did not resolve within ${timeoutMs}ms (resolver timeout)`);
    this.name = 'QueryResolveTimeoutError';
  }
}

export interface CreateResolverOptions {
  /**
   * Max ms to wait for a single entry's `resolve()` before rejecting with a
   * {@link QueryResolveTimeoutError}. A resolver commonly awaits an
   * unbounded downstream primitive (a connection-pool acquire, an fs walk)
   * with no timeout of its own — when that primitive wedges (e.g. a starved
   * PG pool: see dbos/pool-pressure.ts for the same failure class on the
   * routines-tick path), the resolve() promise never settles, and with no
   * bound here the HTTP request hangs indefinitely until the underlying
   * wedge clears on its own (observed: advRoster.list, EI-18106470827657366
   * — self-recovered after 5-8 minutes with no visible error in between).
   * This turns that silent indefinite hang into a fast, loud, recoverable
   * failure. 0/undefined disables (byte-identical to the pre-timeout
   * behavior) — every existing caller that doesn't opt in is unaffected.
   *
   * NOTE: this bounds how long the CALLER waits — it does not cancel the
   * underlying work. A timed-out resolve() keeps running in the background
   * (its eventual settlement is swallowed); the fix for the wedge itself
   * (e.g. a pool-acquire timeout) belongs in the resolver's own downstream
   * primitive when one is available. This is the generic backstop for when
   * it isn't.
   */
  timeoutMs?: number;
}

/**
 * Build a dispatcher over a registry. Validation failure throws (the
 * route handler maps it to HTTP); an unknown name returns NAME_NOT_FOUND.
 * See {@link CreateResolverOptions.timeoutMs} to bound how long a single
 * resolve() may hang before the dispatcher gives up and rejects.
 */
export function createResolver(
  registry: QueryRegistry,
  opts: CreateResolverOptions = {},
): NamedQueryResolver {
  const timeoutMs = opts.timeoutMs ?? 0;
  return async (name: string, args: unknown): Promise<unknown[] | NameNotFound> => {
    const entry = registry[name];
    if (!entry) return NAME_NOT_FOUND;
    const validated = entry.argsSchema ? entry.argsSchema.parse(args) : args;
    const resultPromise = entry.resolve(validated);
    if (!timeoutMs) return resultPromise;
    // The loser of the race below is never awaited again — attach a no-op
    // handler now so a late rejection from a timed-out resolve() doesn't
    // surface as an unhandled-rejection warning (Promise.race doesn't do
    // this for you: the losing promise is still live, just unobserved).
    resultPromise.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new QueryResolveTimeoutError(name, timeoutMs)), timeoutMs);
      // Never let a pending resolver timeout keep the process alive.
      if (timer && typeof (timer as { unref?: () => void }).unref === 'function') {
        (timer as { unref: () => void }).unref();
      }
    });
    try {
      return await Promise.race([resultPromise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Sorted list of registered names. */
export function knownQueryNames(registry: QueryRegistry): string[] {
  return Object.keys(registry).sort();
}

/** True if a name is registered. */
export function isRegistered(registry: QueryRegistry, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(registry, name);
}
