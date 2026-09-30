/**
 * Turn @papercusp/sync's dev-time query-health guardrails ON in the shells that
 * are actually used for development.
 *
 * WHY THIS FILE EXISTS — the guardrails were shipping dark. `query-health.ts`
 * self-gates on `process.env.NODE_ENV === 'development'`, which is the correct
 * default for a generic library but is FALSE in every desktop dev shell here:
 * the default shell (`papercusp-desktop/bin/desktop-dev-nohmr`) serves a
 * `vite build --watch --mode development` bundle, and `vite build` pins
 * `NODE_ENV` to `production` regardless of `--mode`. Measured in the checked-in
 * bundle: both `dist/assets/SyncContext-*.js` chunks minify the gate to
 * `typeof process<"u"&&!1` — statically false. So defects 1–7 (waterfall,
 * oversized payload, oversized row count, slow load, args churn, refetch
 * thrash, blank arg) had never fired in the shell anyone actually drives.
 *
 * `import.meta.env.MODE` is the predicate that IS correct in both dev shells
 * and `production` in the shipped build — the same one `__root.tsx` uses to gate
 * the dev admin rail. See /internal/docs/agent-insights/dev-only-ui-gating-mode-not-dev.
 *
 * Imported for side effect from `main.tsx` before any route module evaluates,
 * so the first query a shell issues is already observed.
 */
import { configureQueryHealth } from '@papercusp/sync';

configureQueryHealth({ enabled: import.meta.env.MODE !== 'production' });
