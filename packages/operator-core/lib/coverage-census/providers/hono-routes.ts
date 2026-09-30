/**
 * `hono-routes` — the declared census provider for HTTP surfaces.
 *
 * Plan: deterministic-coverage-census-2026-08-17 (P-003), Decision D-001.
 *
 * THE POPULATION IS THE MOUNT ORDER, NOT A GLOB. `routeRegistrationOrder()` is the single
 * source of truth for what the app actually mounts — `registerSubset` mounts exactly what it
 * reports, in exactly that order (see endpoint-route/register.ts). Enumerating from it means a
 * route cannot exist in production and be missing from the census: the same call that answers
 * "what did we mount" answers "what must be covered". A filesystem glob over `routes/**` would
 * drift the moment a route file exists but is not wired into the `ALL_ROUTES` barrel — it would
 * report an UNMOUNTED file as a live surface, demanding tests for an endpoint nobody can call.
 *
 * WHY WE STILL READ `ALL_ROUTES`. The registration-order seam deliberately projects to
 * `{ method, path }` — it exists for the shadowing regression test, which cares only about
 * ordering. The census additionally wants each route's input schema (the L2 fuzz seed) and its
 * auth posture, which live on the full `RouteDefinition`. So the ORDER + POPULATION come from
 * the seam, and the per-route detail is joined on from `ALL_ROUTES` by `(method, path)`. Both
 * derive from the same array, so the join cannot invent a surface; a route the seam reports is
 * authoritative even if the join misses, in which case it is emitted without a schema rather
 * than dropped.
 *
 * DUPLICATES ARE EMITTED, NOT SWALLOWED. `registerSubset` throws on a duplicate `(method, path)`
 * at mount time, so a duplicate here means the app could not boot. `diffCensus` reports duplicate
 * emissions as a first-class finding; silently de-duplicating would hide a fatal registry bug
 * behind a tidy census.
 */

import { toJsonSchema } from '@papercusp/tooldef';
import type { ObservedSurface, SurfaceCensusProvider } from '@papercusp/testing-shell/census';
import { routeRegistrationOrder, isCatchAll } from '../../endpoint-route/register';
import { ALL_ROUTES } from '../../endpoint-route/routes';
import { assertRegistryNonEmpty } from './_non-empty';

/** The surface kind this provider owns — and therefore the only kind it may retire. */
export const HTTP_ROUTE_KIND = 'http-route';

function identity(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

/**
 * Best-effort JSON Schema for a route's declared input. A route whose schema cannot be
 * projected is emitted WITHOUT one — a missing fuzz seed is a weaker census row, whereas a
 * throw here would fail the whole provider and freeze retirement for every HTTP surface.
 */
function schemaOf(input: unknown): unknown {
  if (input == null) return undefined;
  try {
    return toJsonSchema(input);
  } catch {
    return undefined;
  }
}

export const honoRoutesProvider: SurfaceCensusProvider = {
  provider: 'hono-routes',
  kinds: [HTTP_ROUTE_KIND],

  enumerate(): ObservedSurface[] {
    // Join table for per-route detail. Built from ALL_ROUTES — the same array the seam projects.
    const detail = new Map<string, (typeof ALL_ROUTES)[number]>();
    for (const def of ALL_ROUTES) detail.set(identity(def.method, def.path), def);

    const mounted = routeRegistrationOrder();

    const surfaces = mounted.map((route): ObservedSurface => {
      const surfaceId = identity(route.method, route.path);
      const def = detail.get(surfaceId);

      return {
        kind: HTTP_ROUTE_KIND,
        surfaceId,
        // The route registry carries no file provenance (routes/index.ts imports each module
        // under a local identifier and flattens it), so we assert nothing rather than guess a
        // path. Runtime attribution — which test exercised which route — is P-004's job.
        sourceFile: null,
        schemaRef: schemaOf(def?.input),
        attrs: {
          method: route.method.toUpperCase(),
          path: route.path,
          catchAll: isCatchAll(route.path),
          // Auth posture is a coverage-relevant attribute: a public route with no test is a
          // materially different risk from an admin-gated one.
          auth: typeof def?.auth === 'string' ? def.auth : (def?.auth ?? null),
          hasInputSchema: def?.input != null,
        },
        fidelity: 'declared',
      };
    });

    return assertRegistryNonEmpty(
      surfaces,
      'routeRegistrationOrder() (endpoint-route)',
      'Check that lib/endpoint-route/routes/index.ts loaded and ALL_ROUTES is populated.',
    ) as ObservedSurface[];
  },
};
