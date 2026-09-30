/**
 * Retry wrapper for TanStack Router's autoCodeSplitting route-component chunk
 * loads (WI-2902).
 *
 * PROBLEM. `vite.config.ts` sets `autoCodeSplitting: true`, so
 * `@tanstack/router-plugin` rewrites every route's `component` into its own
 * lazy chunk and wraps the import with TanStack's
 * `lazyRouteComponent(importer, 'component')`. That importer is a bare
 * `() => import('…?tsr-split=component')` with NO retry: if the chunk fetch
 * transiently fails, `lazyRouteComponent` caches the rejection and re-throws it
 * to the route error boundary — the fatal "This view hit an error / Importing a
 * module script failed" card. On the packaged Linux desktop this fires on first
 * boot: the operator serving the SPA over HTTP starves its own event loop
 * (git clone + PG migrate + ~1.9GB corestore restore), so the route-component
 * chunk request it can't answer rejects.
 *
 * This is the EXACT class `lazyWithRetry` already fixes for the React shell
 * (LeftSidebar / DevAdminRail / tabs); route components just weren't covered
 * because TanStack loads them through its own path, bypassing `lazyWithRetry`.
 *
 * FIX. A build-time Vite plugin (`../../tanstack-lazy-retry.ts`) rewrites the
 * plugin-emitted `import { lazyRouteComponent } from '@tanstack/react-router'`
 * in every route module to import `lazyRouteComponentWithRetry` from HERE — so
 * every split route component gets a retrying importer with ZERO per-route
 * edits. We wrap the importer (a fresh `import()` promise → fresh fetch per
 * attempt) and only let the FINAL outcome reach TanStack: on success no error
 * ever surfaces; only genuine exhaustion (after the patient budget below) shows
 * the card. Because `lazyRouteComponent` caches a REJECTED import, the retry
 * MUST happen here at the import site — a boundary reset alone cannot recover.
 */
import { lazyRouteComponent } from '@tanstack/react-router';
import { isChunkLoadError } from '@papercusp/operator-core/lib/lazy-with-retry';

export interface RouteRetryOptions {
  /** Max retries AFTER the first attempt (default 8). */
  retries?: number;
  /** Base backoff in ms; doubles each retry (default 500). */
  intervalMs?: number;
  /** Backoff ceiling in ms (default 8000). */
  maxIntervalMs?: number;
}

// Patient by design: a first-boot operator can starve its event loop for tens
// of seconds, so a route-component chunk fetch it serves transiently fails.
// 8 retries at 500ms→8s exponential backoff ≈ up to ~39s of patience — long
// enough to outlast the corestore-restore window and recover WITHOUT the fatal
// card, while still terminating (never an infinite spinner) if the chunk is
// genuinely gone.
const DEFAULT_RETRIES = 8;
const DEFAULT_INTERVAL_MS = 500;
const DEFAULT_MAX_INTERVAL_MS = 8000;

/**
 * Wrap a route-component importer so a chunk-load failure is retried with
 * exponential backoff (a fresh `import()`/fetch per attempt). Non-chunk errors
 * (a genuine render/logic bug in the module) are re-thrown immediately — never
 * retried. Exported for unit tests.
 */
export function retryingImporter<T>(
  importer: () => Promise<T>,
  opts: RouteRetryOptions = {},
): () => Promise<T> {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxIntervalMs = opts.maxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS;
  return () => {
    let attempt = 0;
    const attemptLoad = (): Promise<T> =>
      importer().catch((err: unknown) => {
        if (attempt >= retries || !isChunkLoadError(err)) throw err;
        const delay = Math.min(maxIntervalMs, intervalMs * 2 ** attempt);
        attempt += 1;
        return new Promise<void>((resolve) => setTimeout(resolve, delay)).then(attemptLoad);
      });
    return attemptLoad();
  };
}

/**
 * Drop-in replacement for `@tanstack/react-router`'s `lazyRouteComponent` that
 * retries the importer's chunk load. The build plugin swaps every route
 * module's `lazyRouteComponent` import to this; the call signature is identical.
 */
export function lazyRouteComponentWithRetry<
  T extends Record<string, unknown>,
  // `& string`: an export NAME is a string, and lazyRouteComponent's `exportName`
  // param is typed `TKey` where it expects a string key. Without the intersection,
  // `keyof T` widens to `string | number | symbol` and the passthrough call errors.
  TKey extends keyof T & string = 'default',
>(importer: () => Promise<T>, exportName?: TKey) {
  return lazyRouteComponent(retryingImporter(importer), exportName);
}
