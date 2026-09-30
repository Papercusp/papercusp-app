'use client';

import { startTransition, useCallback, useMemo } from 'react';
import { useLocation, useRouter } from '@tanstack/react-router';
import {
  unstable_createAdapterProvider as createAdapterProvider,
  type unstable_AdapterOptions as AdapterOptions,
} from 'nuqs/adapters/custom';

/**
 * Custom nuqs adapter for TanStack Router that preserves search params nuqs
 * does not manage — and, crucially, lets TanStack Router own URL
 * serialization.
 *
 * Why this exists: the stock `nuqs/adapters/tanstack-router` adapter writes
 * the whole URL as a STRING (`to: pathname + renderQueryString(<watched>)`).
 * That fights TanStack's typed search in two ways:
 *   1. It rebuilds from only the nuqs-watched keys, so params owned by
 *      TanStack's native typed search (`validateSearch` + `useSearch`) — e.g.
 *      `?dock=1` on /harness/$slug — are dropped on every nuqs write.
 *   2. TanStack re-stringifies that string-`to` with its own JSON encoder, so
 *      a value it has already encoded (e.g. the string `"1"`) gets re-encoded
 *      and duplicated on each pass — an encoding feedback loop.
 *
 * The fix: write via TanStack's FUNCTIONAL search updater
 * (`navigate({ search: () => … })`), rebuilding the search object from the
 * composed flush state, and TanStack stringifies exactly once.
 *
 * FLUSH SCOPE (the "plan popup won't close" bug, 2026-07-17): nuqs passes an
 * adapter instance whose `watchKeys` are ONLY THE FLUSHING HOOK'S keys — but
 * its GLOBAL throttle queue drains EVERY pending update (across all hooks)
 * through that one adapter (`globalThrottleQueue.flush` → `applyPendingUpdates`
 * composes all pending keys onto `getSearchParamsSnapshot()` and hands the
 * result to `updateUrl`). Two same-tick setters from two components (the plan
 * popup's `setView(null)` + the pane's `setPopupPlan(null)`) therefore flush
 * once, under ONE hook's watchKeys. A `watchKeys`-scoped merge-over-prev
 * dropped the OTHER hook's REMOVAL (sets survived via overlay; removals died
 * with the key still in `prev`) — the popup's `pplan` could never be cleared
 * by its own close button. So:
 *   - `getSearchParamsSnapshot` returns ALL current params (NOT filtered to
 *     watchKeys), making the queue's composed output the COMPLETE authoritative
 *     next search — non-nuqs params ride through the compose untouched;
 *   - `updateUrl` rebuilds the search object purely from that composed state.
 *     A removed key is simply absent. Nothing merges over `prev`, so no scope
 *     list can silently resurrect a key.
 *
 * TYPE-FAITHFUL HANDOFF (the "clicking the dev rail closes it" regression):
 * nuqs serializes values as plain strings (`parseAsBoolean` → 'true'), but
 * TanStack's `defaultStringifySearch` JSON-quotes any STRING that itself
 * JSON-parses, to keep string-ness round-trippable (`'true'` → `?k=%22true%22`).
 * Handing nuqs's raw strings to the search updater therefore quote-wrapped
 * every boolean/number param — and because nuqs's default flush snapshot reads
 * the raw `location.search`, each subsequent write re-quoted the value
 * (`%22true%22` → `%22%5C%22true%5C%22%22` …) until the parser rejected it and
 * the param snapped back to its default (the dev rail closing on any section
 * click). Two-part fix:
 *   - `applyNuqsToSearch` DECODES each nuqs value the way TanStack's
 *     `defaultParseSearch` would (qss `toValue`, then JSON.parse), guarded so a
 *     value only decodes when it re-encodes to the exact same string — nuqs's
 *     read-back is identity, and canonical values write plainly
 *     (`?devRail=true`, not `?devRail=%22true%22`).
 *   - the adapter supplies `getSearchParamsSnapshot` built from the router's
 *     PARSED search re-encoded with the same rules the read-side
 *     `searchParams` uses, so nuqs composes flushes from values consistent
 *     with what its hooks read (and an already-quoted legacy URL self-heals on
 *     the next write) instead of from the raw `location.search`.
 */

/**
 * Mirror of qss `toValue` — the first decode stage TanStack's
 * `defaultParseSearch` applies to every raw query value.
 */
function qssToValue(str: string): unknown {
  if (!str) return '';
  if (str === 'false') return false;
  if (str === 'true') return true;
  return +str * 0 === 0 && +str + '' === str ? +str : str;
}

/**
 * How the read side of this adapter (and `searchObjectToParams`) turns one
 * TanStack-typed search value back into the string nuqs sees. Returns null for
 * values that cannot round-trip through a single string (arrays — the read
 * side splits those into repeated keys).
 */
function reencodeValue(value: unknown): string | null {
  if (Array.isArray(value)) return null;
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  }
  return String(value);
}

/**
 * Decode one nuqs-serialized query value into the TanStack-typed value that
 * stringifies back to it. Mirrors `defaultParseSearch`'s per-value pipeline
 * (qss `toValue`, then JSON.parse on remaining strings), but only accepts the
 * decode when it round-trips to the exact input string — otherwise the raw
 * string is kept and TanStack's own string-symmetry quoting preserves it
 * (e.g. the literal string '1e2' must stay '1e2', not become the number 100).
 */
export function decodeQueryValue(raw: string): unknown {
  let decoded = qssToValue(raw);
  if (typeof decoded === 'string') {
    try {
      decoded = JSON.parse(decoded);
    } catch {
      return raw;
    }
  }
  return reencodeValue(decoded) === raw ? decoded : raw;
}

/**
 * Project a TanStack-typed search object onto the URLSearchParams nuqs reads:
 * arrays become repeated keys, objects JSON-stringify, scalars String().
 * Optionally filtered to a key list (the read side scopes to the hook's own
 * keys to limit re-renders; the flush snapshot passes null = ALL keys, so the
 * queue's composed output is the complete next search — see FLUSH SCOPE).
 */
export function searchObjectToParams(
  search: Record<string, unknown>,
  watchKeys: readonly string[] | null,
): URLSearchParams {
  return new URLSearchParams(
    Object.entries(search)
      .filter(([key]) => watchKeys === null || watchKeys.includes(key))
      .flatMap(([key, value]) => {
        if (Array.isArray(value))
          return value.map((v) => [key, String(v)] as [string, string]);
        if (typeof value === 'object' && value !== null)
          return [[key, JSON.stringify(value)] as [string, string]];
        return [[key, String(value)] as [string, string]];
      }),
  );
}

/**
 * Rebuild the TanStack search object from the queue's composed flush state —
 * the COMPLETE authoritative next search (snapshot of all params + every
 * pending update applied). Repeated keys group into arrays; each value decodes
 * to its TanStack-typed form (see decodeQueryValue). A key absent here was
 * either never set or was REMOVED by this flush — either way it must not
 * survive, which is why nothing merges over the previous search object.
 */
export function composedSearchToObject(nuqsSearch: URLSearchParams): Record<string, unknown> {
  const grouped: Record<string, unknown> = {};
  for (const [key, value] of nuqsSearch.entries()) {
    const decoded = decodeQueryValue(value);
    const cur = grouped[key];
    grouped[key] =
      cur === undefined ? decoded : Array.isArray(cur) ? [...cur, decoded] : [cur, decoded];
  }
  return grouped;
}

function useNuqsTanstackRouterAdapter(watchKeys: string[]) {
  const search = useLocation({
    select: (state) =>
      Object.fromEntries(
        Object.entries(state.search).filter(([key]) => watchKeys.includes(key)),
      ),
  });
  const router = useRouter();
  const { navigate } = router;
  const watchKeysJoined = watchKeys.join(',');
  return {
    searchParams: useMemo(
      () => searchObjectToParams(search, watchKeys),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [search, watchKeysJoined],
    ),
    // nuqs composes each flush on top of this snapshot. Default is the raw
    // `location.search`, whose encoding (TanStack's quoted strings) diverges
    // from what the read-side `searchParams` reports — read from the router's
    // parsed search instead so compose-base and read-back agree. UNFILTERED
    // (all params, not this hook's watchKeys): the global queue drains EVERY
    // pending hook's updates through this one snapshot, so it must carry the
    // full search for the composed output to be the complete next state (see
    // FLUSH SCOPE above).
    getSearchParamsSnapshot: useCallback(
      () =>
        searchObjectToParams(router.latestLocation.search as Record<string, unknown>, null),
      [router],
    ),
    updateUrl: useCallback(
      (nuqsSearch: URLSearchParams, options: AdapterOptions) => {
        // Resolve the path FRESH at flush time, never a closure-captured one.
        // Root cause of the desktop "constant refreshing on launch" (measured
        // 2026-06-09): at startup the route transitions `/` → `/adv` rapidly,
        // and a nuqs flush (notably the `ws` workspace param) that navigated to a
        // STALE captured `pathname` (`'/'`) dropped the path back to `/`, which
        // re-fired the index `/` → `/adv` redirect — a ~5s route oscillation the
        // user sees as the page constantly refreshing (t0/timeOrigin never
        // changes — it was NEVER a page reload). `router.latestLocation` is always
        // the live path, so a flush can no longer yank us off the current route.
        const currentPath = router.latestLocation.pathname;
        startTransition(() => {
          navigate({
            to: currentPath,
            search: () => composedSearchToObject(nuqsSearch),
            replace: options.history === 'replace',
            resetScroll: options.scroll,
            hash: (prevHash) => prevHash ?? '',
            state: (state) => state,
          });
        });
      },
      [navigate, router],
    ),
    rateLimitFactor: 1,
  };
}

export const NuqsAdapter = createAdapterProvider(useNuqsTanstackRouterAdapter);
