/**
 * Route registration onto the Hono app — in two phases.
 *
 * **Why two phases.** Hono runs every matching handler for a request as
 * a middleware chain, in registration order; the first handler that
 * returns a Response without calling `next()` wins. The composed
 * `_hono/app.ts` mounts sub-apps — `app.route('/harness', harness)`,
 * `app.route('/plugins', plugins)` — and the `plugins` sub-app carries
 * a parametric catch-all (`installPluginApiDispatcher`). If a literal
 * `defineTool` like `/plugins/enabled` registers *after* that
 * catch-all, the catch-all shadows it and the literal 404s.
 *
 * So registration is split:
 *   - `registerRouteLiterals(app)` — every non-catch-all route. Called
 *     BEFORE the sub-apps mount, so a literal always out-ranks a
 *     sub-app's parametric/catch-all route at the same prefix.
 *   - `registerRouteCatchalls(app)` — the `*` / `:transport` dispatch
 *     routes. Called AFTER the sub-apps, so a sub-app's real route
 *     (e.g. a plugin's own apiRoutes) still gets first refusal before
 *     our projected-tool catch-all.
 *
 * `registerAllRoutes(app)` runs both phases back-to-back — correct for a
 * bare app with no sub-apps (the test harness). The real `_hono/app.ts`
 * calls the two phases separately, around the sub-app mounts.
 *
 * Plan: apps/operator/docs/plans/endpoint-route-migration-2026-05-20.md
 */

import type { Hono } from 'hono';
import { registerRoute } from './define-route';
import { ALL_ROUTES } from './routes';

/**
 * A route is "catch-all" if it cannot resolve to a single literal path
 * and must yield precedence to literal routes and sub-app routes:
 *   - a `*` wildcard segment (`/plugins/*`);
 *   - a greedy regex param — `:name{.+}` / `:name{.*}` — which is a
 *     wildcard in Hono's `:param{regex}` syntax (`/scratch/:path{.+}`);
 *   - the single-segment MCP transport route (`/:transport`).
 */
export function isCatchAll(path: string): boolean {
  return (
    path.includes('*') ||
    /\{\.[+*]/.test(path) ||
    path === '/:transport'
  );
}

/**
 * Per-segment specificity rank: a literal segment (`0`) is more specific
 * than a `:param` (`1`), which is more specific than a `*` wildcard (`2`).
 *
 * **Why this matters.** Hono resolves overlapping routes purely by
 * *registration order* — it has NO static-over-dynamic precedence (unlike
 * Next.js file routing, where `marketplace/spawnable/route.ts` always beat
 * `marketplace/[slug]/route.ts`). A `defineTool` handler never calls
 * `next()`, so whichever of two overlapping routes registers first wins
 * outright. Without ordering, `/marketplace/:slug` registered before
 * `/marketplace/spawnable` swallows `GET /api/marketplace/spawnable`.
 */
function specificityKey(path: string): number[] {
  return path
    .split('/')
    .filter(Boolean)
    .map((seg) => (seg.includes('*') ? 2 : seg.startsWith(':') ? 1 : 0));
}

/**
 * Order comparator: the more specific route registers first. Compares the
 * per-segment rank vectors lexicographically — a literal segment out-ranks
 * a `:param` at the same position.
 *
 * This MUST be a strict weak ordering (transitive, consistent) or
 * `Array.prototype.sort` is free to produce a garbage permutation. A
 * naive "return 0 when the common prefix matches" is NOT — it would make
 * `[0]` compare equal to both `[0,0]` and `[0,1]` while `[0,0] < [0,1]`,
 * an intransitive equivalence. So when the common prefix ties, the
 * shorter rank vector sorts first (`ka.length - kb.length`); that is a
 * total order. Truly-identical vectors return `0` and the stable sort
 * keeps their `ALL_ROUTES` order. Routes of different arity never both
 * match one request, so their relative order is correctness-irrelevant —
 * the length tie-break only exists to keep the comparator valid.
 */
function bySpecificity(
  a: { path: string },
  b: { path: string },
): number {
  const ka = specificityKey(a.path);
  const kb = specificityKey(b.path);
  const n = Math.min(ka.length, kb.length);
  for (let i = 0; i < n; i++) {
    if (ka[i] !== kb[i]) return ka[i] - kb[i];
  }
  return ka.length - kb.length;
}

/**
 * The subset of `ALL_ROUTES` for one phase, ordered for registration:
 * literal-before-param so a static path out-ranks a parametric sibling.
 * `Array.prototype.sort` is stable (V8 / Node 11+), so routes with an
 * equal rank vector keep their `ALL_ROUTES` order.
 *
 * The single source of truth for registration order — `registerSubset`
 * mounts exactly this, and `routeRegistrationOrder` (used by the
 * shadowing regression test) reports exactly this.
 */
function orderedSubset(wantCatchAll: boolean) {
  return ALL_ROUTES.filter((def) => isCatchAll(def.path) === wantCatchAll)
    .slice()
    .sort(bySpecificity);
}

/** Mount the subset of `ALL_ROUTES` matching `wantCatchAll`. */
function registerSubset(app: Hono, wantCatchAll: boolean): void {
  const seen = new Set<string>();
  for (const def of orderedSubset(wantCatchAll)) {
    const key = `${def.method} ${def.path}`;
    if (seen.has(key)) {
      throw new Error(
        `register: duplicate route "${key}" — two route files claim the same endpoint`,
      );
    }
    seen.add(key);
    registerRoute(app, def);
  }
}

/**
 * The exact `(method, path)` registration order the app mounts —
 * phase 1 (literals) then phase 2 (catch-alls). Exported for the
 * shadowing regression test, which asserts no parametric route is
 * registered before a literal sibling it would swallow.
 */
export function routeRegistrationOrder(): ReadonlyArray<{ method: string; path: string }> {
  return [...orderedSubset(false), ...orderedSubset(true)].map((d) => ({
    method: d.method,
    path: d.path,
  }));
}

/**
 * Phase 1 — mount every literal (non-catch-all) route. Call this BEFORE
 * `app.route('/harness', …)` / `app.route('/plugins', …)` so literals
 * out-rank the sub-apps.
 */
export function registerRouteLiterals(app: Hono): void {
  registerSubset(app, false);
}

/**
 * Phase 2 — mount the catch-all dispatch routes (`/plugins/*`,
 * `/agent-tools/*`, `/plugin-runtime/.../*`, `/:transport`). Call this
 * AFTER the sub-apps mount.
 */
export function registerRouteCatchalls(app: Hono): void {
  registerSubset(app, true);
}

/**
 * Mount all routes, both phases. Correct for a bare app with no
 * sub-apps (the in-process test harness). The composed `_hono/app.ts`
 * does NOT use this — it calls the two phases separately, around the
 * sub-app mounts.
 */
export function registerAllRoutes(app: Hono): void {
  registerRouteLiterals(app);
  registerRouteCatchalls(app);
}

/** Count of mounted routes — used by the OpenAPI assembler + tests. */
export function registeredRouteCount(): number {
  return ALL_ROUTES.length;
}
