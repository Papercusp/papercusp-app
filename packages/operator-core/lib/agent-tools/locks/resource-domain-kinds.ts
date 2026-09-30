/**
 * WI-562584 (root fix) — the DECLARED coordination-domain kind of a named
 * resource, cached so `resourceLockDomain()` can stay SYNCHRONOUS.
 *
 * `resourceLockDomain()` has to answer from a name alone, and until now it did
 * so by inference: a hardcoded host-global set plus a `git-sync:` prefix rule.
 * That inference cannot cover the resources that actually break, because the
 * system-side acquirer's lock set is per-install human configuration
 * (`trigger_config.extra_lock_resources`) — shared operator-core code can never
 * enumerate it, so a wrong answer is structural, not an omission. sql/027 moves
 * the fact onto the registry row, where the acquirer DECLARES it
 * (`stampResourceCoordinationDomainKind`) and every reader agrees by
 * construction.
 *
 * Why a cache rather than an async `resourceLockDomain()`: it has four
 * production call sites (`locks/acquire_resource.ts`, `locks/release_resource.ts`,
 * `dev/restart.ts`, `system-health/compute.ts`), two of them inside expressions
 * whose surrounding control flow would have to change to await, and the last two
 * resolve only `dev-server` / `cfg.resource` — names the hardcoded sets already
 * cover, so they gain nothing from the round trip.
 *
 * ⚠ The refresh is EXPLICIT and awaited by the handlers that need it, never
 * kicked off in the background from the sync read. A background refresh looks
 * tidier and is a trap: `resourceLockDomain()` is called from unit tests that
 * mock `./su-lock-store`, so a lazy load would either throw into a floating
 * promise (a warning that lands in whichever test happens to be running when
 * the microtask settles) or, in a suite using the real shim, open a postgres-js
 * pool with `idle_timeout: 0` — a handle nothing closes. Making the refresh a
 * deliberate await inside a handler that already holds the store keeps every
 * DB touch attributable.
 *
 * Why the staleness is SAFE, which is the property that makes this legitimate
 * rather than a shortcut:
 *
 *  - A miss (never refreshed, failed refresh, a declaration written seconds ago)
 *    degrades to exactly today's name inference — the behaviour every caller
 *    already had.
 *  - The declaration can only promote a resource OUT of the caller-tree domain,
 *    never demote one into it: `tree` is the column default and is treated here
 *    as UNDECLARED. So an empty cache can never re-key a lock that the hardcoded
 *    sets already resolve correctly.
 *  - The window where a miss matters is covered fail-CLOSED by the step-1
 *    cross-domain conflict guard (`cross-domain-conflict.ts`), which refuses an
 *    acquire whose resource is held in another candidate domain. A stale cache
 *    costs a refusal, never a false grant.
 */
import { pinModuleState } from '@papercusp/module-singleton';
import type { ResourceCoordinationDomainKind } from './su-lock-store';

export type { ResourceCoordinationDomainKind };

/** How long a load (successful or failed) is trusted before another is allowed.
 *  A declaration changes only when an install's lock configuration changes, so
 *  a short TTL buys nothing; a failure honours the same window so a degraded
 *  registry cannot turn every acquire into a retry. */
const REFRESH_TTL_MS = 30_000;

type Loader = () => Promise<Map<string, ResourceCoordinationDomainKind>>;

interface DomainKindCache {
  /** Only NON-default kinds are stored — an absent entry means UNDECLARED. */
  kinds: Map<string, ResourceCoordinationDomainKind>;
  loadedAtMs: number | null;
  nextAttemptAtMs: number;
  inFlight: Promise<void> | null;
  lastError: string | null;
  /** Test seam. null = read the real registry. */
  loader: Loader | null;
}

// Pinned through @papercusp/module-singleton rather than a hand-rolled
// globalThis/Symbol.for pair: a split module record here would give one half of
// the process a permanently cold cache while listModuleDuplications() reported
// a confident `[]` (EI-19479108855357092).
const __domainKinds = pinModuleState<DomainKindCache>(
  '@papercusp/operator-core.resourceDomainKinds',
  () => ({ kinds: new Map(), loadedAtMs: null, nextAttemptAtMs: 0, inFlight: null, lastError: null, loader: null }),
);

async function loadFromRegistry(): Promise<Map<string, ResourceCoordinationDomainKind>> {
  // Imported lazily so merely RESOLVING a lock domain never pulls the locks host
  // seam (and its embedded-pg discovery) into the static module graph of every
  // caller of coordination-domain.ts.
  const { ensureBootstrap, getTxPool, readResourceCoordinationDomainKinds } = await import('./su-lock-store');
  // Same preamble every other direct reader of this pool uses (owner-lock-domains,
  // live-lock-paths, queue). It is idempotent, and it is what applies sql/027 —
  // without it the first read after a deploy queries a column that does not exist
  // yet, which the caller would (correctly but pointlessly) swallow for a whole TTL.
  await ensureBootstrap();
  return readResourceCoordinationDomainKinds(getTxPool());
}

/**
 * Refresh the declarations if the cache is older than {@link REFRESH_TTL_MS},
 * and WAIT for it. Concurrent callers share one load.
 *
 * NEVER throws: a registry read that fails must not fail the acquire it was
 * about to inform — the resolver falls back to the name inference it used
 * before this cache existed, and the cross-domain conflict guard still refuses
 * a genuinely conflicting acquire. The failure is recorded on
 * {@link resourceDomainKindsHealth} instead of logged, so a long-lived operator
 * exposes it continuously rather than in one startup line nobody re-reads.
 */
export async function ensureResourceDomainKindsFresh(): Promise<void> {
  const st = __domainKinds;
  if (st.inFlight) return st.inFlight;
  if (Date.now() < st.nextAttemptAtMs) return;
  const load = st.loader ?? loadFromRegistry;
  const run = (async () => {
    try {
      st.kinds = await load();
      st.loadedAtMs = Date.now();
      st.lastError = null;
    } catch (err) {
      st.lastError = err instanceof Error ? err.message : String(err);
    } finally {
      st.nextAttemptAtMs = Date.now() + REFRESH_TTL_MS;
      st.inFlight = null;
    }
  })();
  st.inFlight = run;
  return run;
}

/**
 * The declared domain kind for `resource`, or null when it is UNDECLARED —
 * absent from the cache, or explicitly `tree` (the column default, which means
 * "no declaration", not "the tree domain"). Pure, sync, never throws.
 */
export function declaredResourceDomainKind(
  resource: string,
): Exclude<ResourceCoordinationDomainKind, 'tree'> | null {
  const kind = __domainKinds.kinds.get(resource);
  return kind === 'workspace' || kind === 'host-global' ? kind : null;
}

/** Whether the declarations are loaded, and why not if they are not — the
 *  observable form of the swallowed refresh failure above. */
export function resourceDomainKindsHealth(): {
  loaded: boolean;
  declarationCount: number;
  loadedAtMs: number | null;
  lastError: string | null;
} {
  const st = __domainKinds;
  return {
    loaded: st.loadedAtMs !== null,
    declarationCount: st.kinds.size,
    loadedAtMs: st.loadedAtMs,
    lastError: st.lastError,
  };
}

/**
 * Reset the cache THROUGH this module's own seam — test-only.
 *
 * Do not reach for `globalThis[Symbol.for(...)]` in a test: that targets the
 * storage LOCATION rather than this module's state, so it keeps compiling and
 * silently resets nothing if the state ever moves (EI-19479108855357092).
 */
export function __resetResourceDomainKindsForTest(loader?: Loader): void {
  __domainKinds.kinds = new Map();
  __domainKinds.loadedAtMs = null;
  __domainKinds.nextAttemptAtMs = 0;
  __domainKinds.inFlight = null;
  __domainKinds.lastError = null;
  __domainKinds.loader = loader ?? null;
}
