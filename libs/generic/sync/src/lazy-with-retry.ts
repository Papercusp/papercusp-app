import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

// Canonical chunk-retry wrapper for code-split components. A dynamic import()
// can transiently fail to fetch its chunk for several reasons:
//   - a dev rebuild (Vite `build --watch`, webpack) rolled the chunk hash out
//     from under the loaded page (chunk-A → chunk-B);
//   - a production redeploy rolled the asset hashes;
//   - (the packaged-desktop case, WI-2902) the host self-serves the SPA over
//     HTTP from the SAME process doing heavy first-boot work, so a chunk fetch
//     momentarily times out / resets while that process's event loop is starved.
// React.lazy does NOT retry; this wrapper retries a few times with exponential
// backoff (which simply keeps the Suspense fallback showing — the correct
// "still loading" UX) and, only as a last resort *in a browser dev session*,
// forces a one-time full reload so the fresh chunk graph is fetched.
//
// The set of error phrasings this treats as a (retryable) chunk failure is the
// SINGLE SOURCE OF TRUTH — CHUNK_LOAD_ERROR_RE below. The route error boundary
// imports the SAME regex, so the "is this a chunk failure" decision can't drift
// between the retry site and the boundary that catches an exhausted-retry throw.
//
// CRITICAL — never auto-reload on the Tauri desktop / static desktop host
// (:3070, :4173). There `vite build --watch` rewrites dist out from under the
// loaded webview on every fleet edit; an auto-reload would yank the user's
// session on each rebuild (the symptom: "settings tabs reload / take several
// seconds sometimes"). The desktop is manual-refresh only — see
// papercusp-desktop/bin/desktop-dev-nohmr. This guard is the single source of
// truth; apps/operator/lib/lazy-with-retry.ts re-exports it so the two can't
// drift (they did once — the operator copy had the guard, this one didn't).
export function shouldAutoReloadChunkFailure(
  reloadOnFail: boolean,
  inTauriDesktop: boolean,
  origin?: string,
): boolean {
  if (!reloadOnFail) return false;
  if (inTauriDesktop) return false;
  if (origin === 'http://localhost:3070' || origin === 'http://127.0.0.1:3070') return false;
  if (origin === 'http://localhost:4173' || origin === 'http://127.0.0.1:4173') return false;
  return true;
}

/**
 * Every browser engine's phrasing for a failed dynamic `import()` / chunk load —
 * the SINGLE source of truth. The route error boundary imports THIS regex.
 *   - webpack:  ChunkLoadError / "Loading chunk N failed" / "Failed to load|fetch chunk"
 *   - WebKit (the Tauri/WebKitGTK webview!): "Importing a module script failed"
 *   - Chromium: "Failed to fetch dynamically imported module"
 *   - Firefox:  "error loading dynamically imported module"
 *
 * The WebKit phrasing is why this MUST be shared and complete: the packaged
 * desktop runs on WebKitGTK, and the OLD narrow regex here matched only the
 * webpack phrasings — so lazyWithRetry silently NEVER retried a transient chunk
 * failure on the Tauri desktop, the one platform where a first-boot chunk fetch
 * is most likely to momentarily fail, and every such transient escalated
 * straight to the fatal route error boundary + a reload loop (WI-2902).
 */
export const CHUNK_LOAD_ERROR_RE =
  /Failed to (load|fetch) chunk|Loading chunk \d+ failed|Importing a module script failed|Failed to fetch dynamically imported module|error loading dynamically imported module/i;

/** True when `err` is a transient dynamic-import / chunk-load failure (any
 *  engine), vs a genuine render/logic bug (never retried/reloaded). Pure;
 *  exported for tests and shared with the route error boundary. */
export function isChunkLoadError(err: unknown): boolean {
  if ((err as { name?: unknown } | null)?.name === 'ChunkLoadError') return true;
  const msg = String((err as { message?: unknown } | null)?.message ?? err ?? '');
  return CHUNK_LOAD_ERROR_RE.test(msg);
}

// `process.env.NODE_ENV !== 'production'` is the correct DEFAULT for a
// generic library (the standard Node/bundler convention) — but `vite build`
// pins `process.env.NODE_ENV` to `'production'` regardless of `--mode`, and
// the bundler constant-folds that comparison at BUILD time. Under the
// desktop dev shell (`vite build --watch --mode development`) that folds this
// default to a static `false` in every build, permanently disabling
// `reloadOnFail` unless a caller overrides it (WI-7002) — and per the class
// this bug belongs to, NO caller does.
//
// Fix pattern (matching `configureQueryHealth` / `query-health-gate.ts`,
// P-027): keep the generic-library-correct default here, unmodified, and let
// the one bundler context where it's known to be wrong (Vite) correct it
// through an explicit `configureLazyWithRetry` call — not by baking a
// bundler-specific global (`import.meta.env`) into this domain-free lib. See
// `apps/operator-vite/src/lazy-reload-gate.ts`.
let defaultReloadOnFail = process.env.NODE_ENV !== 'production';

/** Override the default `reloadOnFail` this module falls back to when a
 *  `lazyWithRetry` call site doesn't pass one explicitly. See WI-7002 —
 *  intended for a one-time side-effect call from the consuming app's entry
 *  point, before any `lazyWithRetry` call site evaluates. */
export function configureLazyWithRetry(opts: { defaultReloadOnFail?: boolean }): void {
  if (opts.defaultReloadOnFail !== undefined) defaultReloadOnFail = opts.defaultReloadOnFail;
}

export function lazyWithRetry<T extends ComponentType<any>>(
  loader: () => Promise<{ default: T }>,
  opts: {
    retries?: number;
    intervalMs?: number;
    maxIntervalMs?: number;
    reloadOnFail?: boolean;
  } = {},
): LazyExoticComponent<T> {
  // 5 retries with exponential backoff (300·2^k, capped 3000ms) span ~7.5s of
  // "still loading" — enough to ride out a first-boot event-loop stall on the
  // self-hosting desktop (WI-2902) while the Suspense fallback stays up. Each
  // extra retry costs nothing but a longer pending state, never a fatal card.
  const retries = opts.retries ?? 5;
  const intervalMs = opts.intervalMs ?? 300;
  const maxIntervalMs = opts.maxIntervalMs ?? 3000;
  // Note: `shouldAutoReloadChunkFailure` also unconditionally returns false
  // for `inTauriDesktop`, so this default was already inert on the packaged
  // desktop regardless of the WI-7002 fix above — it only changes behavior
  // for a non-Tauri browser dev session (the retired standalone webapp path
  // today; kept correct so the option is available to any future non-Tauri
  // consumer).
  const reloadOnFail = opts.reloadOnFail ?? defaultReloadOnFail;
  const origin = typeof window !== 'undefined' ? window.location.origin : undefined;
  const inTauriDesktop =
    typeof window !== 'undefined'
    && Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
  return lazy(() =>
    new Promise<{ default: T }>((resolve, reject) => {
      const attempt = (n: number) => {
        loader().then(resolve).catch((err: unknown) => {
          const isChunkErr = isChunkLoadError(err);
          if (!isChunkErr || n <= 0) {
            if (
              isChunkErr
              && shouldAutoReloadChunkFailure(reloadOnFail, inTauriDesktop, origin)
              && typeof window !== 'undefined'
            ) {
              const k = '__chunkReloadOnce__';
              if (!sessionStorage.getItem(k)) {
                sessionStorage.setItem(k, '1');
                window.location.reload();
                return;
              }
            }
            reject(err);
            return;
          }
          // Exponential backoff, capped. This only prolongs the Suspense
          // fallback — the correct "still loading" UX for a chunk that is
          // momentarily unreachable while the self-hosting host is busy.
          const delay = Math.min(maxIntervalMs, intervalMs * 2 ** (retries - n));
          setTimeout(() => attempt(n - 1), delay);
        });
      };
      attempt(retries);
    }),
  );
}
