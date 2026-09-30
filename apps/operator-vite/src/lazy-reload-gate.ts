/**
 * Turn on `lazyWithRetry`'s dev-only auto-reload-on-chunk-failure default in
 * the shells that are actually used for development.
 *
 * WHY THIS FILE EXISTS (WI-7002) — `lazyWithRetry`'s `reloadOnFail` defaults
 * to `process.env.NODE_ENV !== 'production'`, which is the correct default
 * for a generic library but is FALSE in every desktop dev shell here: the
 * default shell (`papercusp-desktop/bin/desktop-dev-nohmr`) serves a
 * `vite build --watch --mode development` bundle, and `vite build` pins
 * `NODE_ENV` to `production` regardless of `--mode`. No call site currently
 * passes `reloadOnFail` explicitly, so this default has been permanently off
 * in every build.
 *
 * `import.meta.env.MODE` is the predicate that IS correct in both dev shells
 * and `production` in the shipped build — the same one `query-health-gate.ts`
 * and `__root.tsx` use. See
 * /internal/docs/agent-insights/dev-only-ui-gating-mode-not-dev.
 *
 * Note: `shouldAutoReloadChunkFailure` (the actual gate `lazyWithRetry`
 * consults) unconditionally refuses to auto-reload on the Tauri desktop /
 * :3070 / :4173 regardless of `reloadOnFail` — so this file only changes
 * behavior for a non-Tauri browser dev session (the retired standalone
 * webapp path today; kept correct so the option is available to any future
 * non-Tauri consumer).
 *
 * Imported for side effect from `main.tsx` before any `lazyWithRetry` call
 * site evaluates, so every lazy component picks up the corrected default.
 */
import { configureLazyWithRetry } from '@papercusp/sync';

configureLazyWithRetry({ defaultReloadOnFail: import.meta.env.MODE !== 'production' });
