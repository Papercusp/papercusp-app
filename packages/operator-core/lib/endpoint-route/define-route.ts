/**
 * `registerRoute` — the host-side mount seam for the endpoint system.
 *
 * **Phase E6 (endpoint-unification-2026-05-21) is complete: `defineRoute`
 * is gone.** Routes are declared with the unified `defineTool` primitive
 * from `@papercusp/agent-mcp` — a route-shaped input (`{ method, path,
 * auth, handler }`) yields a `RouteDefinition`; a tool-shaped input
 * yields a `ToolDefinition`. There is one primitive.
 *
 * What stays HOST-side (here): `registerRoute` — the Hono mounting +
 * `corsFor` middleware — plus the route-type re-exports for callsite
 * convenience. A route is *declared* with the package primitive and
 * *mounted* by the host; the host owns Hono and the `requirePrincipal`
 * auth chain, the package must not.
 *
 * Plan: apps/operator/docs/plans/endpoint-unification-2026-05-21.md
 */

import type { Hono } from 'hono';
import type { ZodTypeAny } from 'zod';
import type { RouteDefinition } from '@papercusp/agent-mcp';
import { runRouteStack, type RouteStep } from './route-stack';
import { corsFor } from './cors';

/* ─── The route types — canonical home is now @papercusp/agent-mcp ────── */
export type {
  RouteDefinition,
  RouteContext,
  RouteMethod,
  RouteAuth,
} from '@papercusp/agent-mcp';

/**
 * Per-app set of paths that already have CORS middleware mounted. Keyed
 * on the Hono app instance (each test builds a fresh app) so a
 * module-level Set can't wrongly skip CORS on a second app. Deduped
 * because the agent-tools catch-all is an array of 5 same-path routes —
 * without this, `app.use` would stack the middleware 5×.
 */
const CORS_PATHS = Symbol.for('papercusp.endpoint-route.corsPaths');

/**
 * Mount one route definition onto a Hono app. The Hono handler runs the
 * route through the route-stack (`route-stack.ts`) — auth, input
 * validation, timeout, invoke, telemetry.
 *
 * For `cors`-enabled routes, the shared CORS middleware is mounted (once
 * per path) ahead of the handler so the cross-origin client + its OPTIONS
 * preflight are handled centrally.
 *
 * `stack` selects the dispatch pipeline. Omitted, it is the default local
 * stack, whose `auth` step resolves the local principal chain. The hosted
 * control plane passes its own stack (`hosted-route-stack.ts`) so an
 * internet-facing mount never runs the local chain — the profile chooses the
 * pipeline at mount time rather than a route trying to describe which
 * authority model it wants.
 */
export function registerRoute(
  app: Hono,
  def: RouteDefinition<ZodTypeAny | undefined>,
  stack?: ReadonlyArray<RouteStep>,
): void {
  if (def.cors) {
    const reg = app as unknown as Record<symbol, Set<string> | undefined>;
    let paths = reg[CORS_PATHS];
    if (!paths) {
      paths = new Set<string>();
      reg[CORS_PATHS] = paths;
    }
    if (!paths.has(def.path)) {
      paths.add(def.path);
      const origins = typeof def.cors === 'object' ? def.cors.origins : undefined;
      app.use(def.path, corsFor(origins));
    }
  }
  app.on(def.method, def.path, (c) => (stack ? runRouteStack(def, c, stack) : runRouteStack(def, c)));
}
