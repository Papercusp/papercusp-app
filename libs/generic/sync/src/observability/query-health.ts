'use client';

/**
 * Query-health observer — dev-time guardrails for the recurring "new view,
 * slow first click" data-fetching defect class (papercusp WI-5412, owner ask
 * 2026-07-18: every new interface kept re-introducing the same fetch bugs;
 * catch them AT THE LIBRARY, not in review).
 *
 * Watches every `useSyncQuery` call (transport-agnostic — it observes the
 * result, never the wire) and console-warns ONCE per query per defect shape:
 *
 *   1. **args-flip waterfall** — the query fetched, then its args changed
 *      moments after mount (a dependency like a default-scope list resolved)
 *      and it fetched AGAIN. The first fetch's work was thrown away; the
 *      first paint paid for both, serially. Fires only when the change is an
 *      input resolving late (blank → value) on an ENABLED query — a user
 *      re-selection (value → value) refetches data they asked for, and a
 *      disabled query does not refetch at all (WI-39558). Fix: gate with
 *      `enabled` until the query's inputs are actually resolved.
 *   2. **oversized payload** — the parsed result is far bigger than a view
 *      needs. Usually the resolver is shipping fields nothing renders, or an
 *      unpaginated corpus. Fix: slim the projection / paginate.
 *   3. **oversized row count** — hundreds of rows in one result usually mount
 *      hundreds of DOM nodes. Fix: paginate or window the render.
 *   4. **slow fetch** — the first load took long enough that server compute
 *      (not transfer — this library's consumers are mostly loopback) is the
 *      likely cost. Fix: measure the resolver, don't guess.
 *   7. **blank arg on an ENABLED query** — the query is live and one of its
 *      args is `''`. An id/slug arg is the resolver's lookup key, so a blank
 *      one is a round-trip that cannot resolve to anything; it repeats on
 *      every poll. Fix: `enabled` until the arg is non-empty. Fires ONLY when
 *      the query is enabled, so a correctly-gated `{ id: id ?? '' }` call site
 *      is silent (papercusp no-http-anywhere-2026-07-28 P-027).
 *
 * OFF outside development (`NODE_ENV === 'development'`), free-ish inside it:
 * the only non-trivial work (JSON size estimate) runs once per query and only
 * after a cheap row-count screen. `configureQueryHealth` overrides thresholds
 * (or force-enables under test).
 */
import { useEffect, useRef } from 'react';
import type { SyncQueryOptions, SyncQueryResult } from '../types';

export interface QueryHealthConfig {
  enabled: boolean;
  /** An args change this soon after the previous fetch STARTED counts as a waterfall. */
  waterfallWindowMs: number;
  /** Warn when the serialized result exceeds this many bytes. */
  payloadBytesWarn: number;
  /** Warn when one result carries more rows than this. */
  rowsWarn: number;
  /** Only results with at least this many rows pay the JSON size estimate. */
  payloadCheckMinRows: number;
  /** Warn when the first load's fetch takes longer than this. */
  slowFetchMsWarn: number;
  /** Sliding window for the args-churn check. */
  argsChurnWindowMs: number;
  /** Warn when args change more than this many times inside argsChurnWindowMs
   *  (an unmemoized args object / a value recomputed every render). */
  argsChurnCountWarn: number;
  /** Sliding window for the refetch-thrash check. */
  refetchWindowMs: number;
  /** Warn when the SAME query fetches more than this many times inside
   *  refetchWindowMs (usually an over-broad SSE invalidation bridge). */
  refetchCountWarn: number;
  /**
   * Arg names for which an empty string is a MEANINGFUL value rather than an
   * unresolved id — the blank-arg check skips these. Deliberately empty by
   * default: the resolvers this library fronts treat `''` as "no value", and
   * an exemption should be a considered, named decision, not a default.
   */
  blankArgAllow: readonly string[];
  /** Injectable warn sink (tests). */
  warn: (message: string) => void;
}

const config: QueryHealthConfig = {
  enabled: typeof process !== 'undefined' && process.env?.NODE_ENV === 'development',
  waterfallWindowMs: 3_000,
  payloadBytesWarn: 262_144, // 256KB parsed — transfer is not the concern; parse + render is.
  rowsWarn: 1_000,
  payloadCheckMinRows: 25,
  slowFetchMsWarn: 1_000,
  argsChurnWindowMs: 2_000,
  argsChurnCountWarn: 4, // >4 distinct arg identities in 2s ⇒ unstable args
  refetchWindowMs: 10_000,
  refetchCountWarn: 12, // >12 fetches in 10s ⇒ over-broad invalidation thrash
  blankArgAllow: [],
  // eslint-disable-next-line no-console
  warn: (message: string) => console.warn(message),
};

/** Override thresholds / force-enable (tests, apps with different budgets). */
export function configureQueryHealth(overrides: Partial<QueryHealthConfig>): void {
  Object.assign(config, overrides);
}

/** One warning per (queryName, defect shape) per page load — never a spam source. */
const warned = new Set<string>();

/** Test-only: forget which warnings fired. */
export function __resetQueryHealthForTests(): void {
  warned.clear();
}

function warnOnce(queryName: string, kind: string, message: string): void {
  const key = `${queryName}\0${kind}`;
  if (warned.has(key)) return;
  warned.add(key);
  config.warn(`[sync query-health] ${message}`);
}

function argsKeyOf(args: Record<string, unknown> | undefined): string {
  if (!args) return '{}';
  try {
    return JSON.stringify(args, Object.keys(args).sort());
  } catch {
    return '{}';
  }
}

function hasNonBlankScopeArg(args: Record<string, unknown>): boolean {
  return ['harnessSlug', 'workspaceId'].some((name) => {
    const value = args[name];
    return value != null && (typeof value !== 'string' || value.trim() !== '');
  });
}

function isBlankArgAllowed(name: string, args: Record<string, unknown>): boolean {
  // `q` is an optional filter for an already-scoped query, but it is not a
  // globally meaningful blank value. Keep the exemption tied to the scope so
  // a blank lookup key still warns when no scope has been resolved.
  return config.blankArgAllow.includes(name) || (name === 'q' && hasNonBlankScopeArg(args));
}

/**
 * True when some arg went unresolved → resolved (absent/null/'' → a real
 * value) across an args change — the waterfall defect's signature ("the query
 * fetched before its inputs finished resolving"). A value → value change is a
 * re-selection: its refetch is work the user asked for, not waste (WI-39558).
 */
function argsResolvedLate(
  prev: Record<string, unknown> | undefined,
  next: Record<string, unknown> | undefined,
): boolean {
  if (!next) return false;
  for (const [name, value] of Object.entries(next)) {
    if (value === '' || value == null) continue;
    const prevValue = prev?.[name];
    if (prevValue === '' || prevValue == null) return true;
  }
  return false;
}

interface ObserverState {
  argsKey: string;
  /** The args object behind argsKey (for the waterfall's blank→value test). */
  args: Record<string, unknown> | undefined;
  /** performance.now() when the CURRENT argsKey started fetching (NaN = never). */
  fetchStartedAt: number;
  /** A fetch was observed (started or finished) under the current argsKey. */
  fetchedCurrentArgs: boolean;
  /** First data arrival was already inspected for size/rows. */
  sizeChecked: boolean;
  /** First-load duration was already judged. */
  durationChecked: boolean;
  wasFetching: boolean;
  /** performance.now() of recent args-identity changes (for the churn check). */
  argsChangeTimes: number[];
  /** performance.now() of recent fetch starts (for the refetch-thrash check). */
  fetchStartTimes: number[];
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Observe one useSyncQuery call site. Called unconditionally from the hook —
 * every check is a no-op unless `config.enabled`.
 */
export function useQueryHealthObserver(opts: SyncQueryOptions, result: SyncQueryResult<unknown>): void {
  const stateRef = useRef<ObserverState | null>(null);
  const { queryName } = opts;
  const argsKey = argsKeyOf(opts.args);
  const enabled = opts.enabled !== false;
  const { data, fetching, loading } = result;

  useEffect(() => {
    if (!config.enabled) return;
    const state =
      stateRef.current ??
      (stateRef.current = {
        argsKey,
        args: opts.args,
        fetchStartedAt: NaN,
        fetchedCurrentArgs: false,
        sizeChecked: false,
        durationChecked: false,
        wasFetching: false,
        argsChangeTimes: [],
        fetchStartTimes: [],
      });

    // ── Defect 7: a blank arg on an ENABLED query ────────────────────────
    // An id/slug arg IS the resolver's lookup key. A live query keyed on `''`
    // cannot resolve to a row, yet still costs a round-trip on every poll
    // interval for the life of the mount. The zod schema that actually
    // requires the arg lives server-side and is not shipped to the client, so
    // the client-side signal is "enabled + empty string" — which is why the
    // check is scoped to ENABLED queries: `{ id: id ?? '' }` behind an
    // `enabled: Boolean(id)` gate is the CORRECT shape and must stay silent.
    if (enabled && opts.args) {
      for (const [name, value] of Object.entries(opts.args)) {
        if (value !== '' || isBlankArgAllowed(name, opts.args)) continue;
        warnOnce(
          queryName,
          `blank-arg:${name}`,
          `"${queryName}" is enabled with \`${name}: ""\`. A blank id/slug is the resolver's lookup key, so this ` +
            `request cannot resolve to anything — and it repeats every poll. Gate the query with ` +
            `\`enabled: Boolean(${name})\` until the value is resolved (papercusp no-http-anywhere-2026-07-28 P-027).`,
        );
      }
    }

    // ── Defect 1: the args-flip waterfall ────────────────────────────────
    if (argsKey !== state.argsKey) {
      const nowMs = now();
      const sinceFetchStart = nowMs - state.fetchStartedAt;
      // Only an ENABLED change refetches, and only a late-resolving input
      // (blank → value) is wasted work — see argsResolvedLate (WI-39558).
      if (
        enabled &&
        state.fetchedCurrentArgs &&
        sinceFetchStart <= config.waterfallWindowMs &&
        argsResolvedLate(state.args, opts.args)
      ) {
        warnOnce(
          queryName,
          'waterfall',
          `"${queryName}" refetched ${Math.round(sinceFetchStart)}ms after its previous fetch because its args changed ` +
            `(${state.argsKey} → ${argsKey}). The first fetch's work was thrown away and the first paint paid for both, ` +
            `serially. Gate the query with \`enabled\` until its inputs are resolved (papercusp WI-5412).`,
        );
      }
      // ── Defect 5: args-identity churn ──────────────────────────────────
      // A single flip is a waterfall; MANY flips in a short window is an
      // unstable args object (a `{}`/array literal or a value like Date.now()
      // recomputed every render). react-query hashes keys structurally, so
      // this only fires when the CONTENT actually changes each render — the
      // costly kind. Only ENABLED changes count: a disabled query never
      // refetches, so its args moving (a cross-kind selection rippling into
      // it) costs nothing (WI-39558). Fix: useMemo the args (or stabilise the
      // derived value).
      if (enabled) {
        state.argsChangeTimes.push(nowMs);
        state.argsChangeTimes = state.argsChangeTimes.filter((t) => nowMs - t <= config.argsChurnWindowMs);
        if (state.argsChangeTimes.length > config.argsChurnCountWarn) {
          warnOnce(
            queryName,
            'churn',
            `"${queryName}" changed its args ${state.argsChangeTimes.length}× in ${config.argsChurnWindowMs}ms — the args ` +
              `identity is unstable (a fresh object/array every render, or a value like Date.now() computed inline). Each ` +
              `change is a new cache key and a refetch. useMemo the args object / stabilise the derived value (papercusp WI-5412).`,
          );
        }
      }
      state.argsKey = argsKey;
      state.args = opts.args;
      state.fetchStartedAt = NaN;
      state.fetchedCurrentArgs = false;
      state.sizeChecked = false;
      state.durationChecked = false;
    }

    // Track fetch lifecycle under the current args.
    if (enabled && fetching && !state.wasFetching) {
      const nowMs = now();
      state.fetchStartedAt = nowMs;
      state.fetchedCurrentArgs = true;
      // ── Defect 6: refetch thrash ─────────────────────────────────────
      // Too many fetches of the SAME query in a short window — almost always
      // an over-broad SSE-invalidation bridge firing this query on writes it
      // doesn't depend on (the EI-278 poll-storm class). Fix: narrow the
      // table→query invalidation mapping, or raise the query's staleTime.
      state.fetchStartTimes.push(nowMs);
      state.fetchStartTimes = state.fetchStartTimes.filter((t) => nowMs - t <= config.refetchWindowMs);
      if (state.fetchStartTimes.length > config.refetchCountWarn) {
        warnOnce(
          queryName,
          'thrash',
          `"${queryName}" fetched ${state.fetchStartTimes.length}× in ${config.refetchWindowMs}ms. That is refetch thrash — ` +
            `usually an over-broad invalidation firing this query on unrelated writes. Narrow the table→query invalidation ` +
            `mapping or raise its staleTime (papercusp WI-5412).`,
        );
      }
    }

    // ── Defect 4: slow first load ────────────────────────────────────────
    if (state.wasFetching && !fetching && !state.durationChecked && !Number.isNaN(state.fetchStartedAt)) {
      state.durationChecked = true;
      const tookMs = now() - state.fetchStartedAt;
      if (tookMs > config.slowFetchMsWarn) {
        warnOnce(
          queryName,
          'slow',
          `"${queryName}" took ${Math.round(tookMs)}ms to load. On a local/loopback deployment that is server ` +
            `compute, not transfer — time the resolver's stages before optimizing anything else.`,
        );
      }
    }
    state.wasFetching = fetching;

    // ── Defects 2 + 3: oversized result ──────────────────────────────────
    if (!loading && !state.sizeChecked && Array.isArray(data) && data.length > 0) {
      state.sizeChecked = true;
      state.fetchedCurrentArgs = true;
      if (data.length > config.rowsWarn) {
        warnOnce(
          queryName,
          'rows',
          `"${queryName}" returned ${data.length} rows in one result. Paginate server-side or window the render — ` +
            `mounting them all is a real first-click cost.`,
        );
      }
      if (data.length >= config.payloadCheckMinRows) {
        let bytes = 0;
        try {
          bytes = JSON.stringify(data).length;
        } catch {
          /* cyclic / non-serializable — skip the size check */
        }
        if (bytes > config.payloadBytesWarn) {
          warnOnce(
            queryName,
            'payload',
            `"${queryName}" result is ~${Math.round(bytes / 1024)}KB parsed. Check the resolver for fields no ` +
              `consumer renders (ranking/debug metadata is the usual offender) and slim the wire projection.`,
          );
        }
      }
    }
  });
}
