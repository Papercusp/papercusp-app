/**
 * OpenAPI fragment emitter for `defineTool` endpoints — R3.
 *
 * Produces one `OpenApiFragment` per route, which the host passes to
 * `assembleOpenApiDocument` as an `extraFragment`. A route is a plain
 * HTTP operation — no SSE/event-stream shape, no tool-catalog metadata.
 * That's the point: routes are plumbing, and the OpenAPI doc should
 * show the whole API surface, tools and routes alike.
 *
 * Plan: apps/operator/docs/plans/endpoint-route-migration-2026-05-20.md §6 R3
 */

import { z } from 'zod';
import type { OpenApiFragment } from '@papercusp/agent-mcp';
import type { RouteDefinition } from './define-route';
import type { ZodTypeAny } from 'zod';
import { ALL_ROUTES } from './routes';

/**
 * Hono path → OpenAPI path. `:slug` / `:path{.+}` → `{slug}` / `{path}`;
 * a `*` wildcard segment → `{wildcard}` (a bare `*` is not a legal
 * OpenAPI path-template token, so catch-all routes need a named param).
 */
function honoPathToOpenApi(path: string): string {
  return path
    .replace(/:([A-Za-z0-9_]+)(\{[^}]*\})?/g, '{$1}')
    .replace(/\*/g, '{wildcard}');
}

/** Path-parameter names declared in a Hono path (incl. the `*` wildcard). */
function pathParamNames(path: string): string[] {
  const named = [...path.matchAll(/:([A-Za-z0-9_]+)(?:\{[^}]*\})?/g)].map((m) => m[1]);
  if (path.includes('*')) named.push('wildcard');
  return named;
}

/** Stable, unique operationId from method + path. */
function operationId(method: string, path: string): string {
  // Map wildcard segments to a stable token before the generic non-
  // alphanumeric collapse — otherwise `/plugins` and `/plugins/*` both
  // reduce to `route_GET_plugins` (the trailing-underscore strip eats
  // the segment delimiter). Surfaced when /plugins was migrated off
  // _hono in endpoint-hono-elimination-2026-05-21 A3.
  const tokens = path.replace(/\*/g, 'wildcard');
  return `route.${method}.${tokens}`.replace(/[^A-Za-z0-9]+/g, '_').replace(/_+$/g, '');
}

function zodToJsonSchemaSafe(schema: unknown): Record<string, unknown> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (z as any).toJSONSchema(schema) as Record<string, unknown>;
    delete raw.$schema;
    return raw;
  } catch {
    return { description: 'Schema not representable in JSON Schema.' };
  }
}

/**
 * Emit the OpenAPI fragment for one route definition. `pathPrefix`
 * defaults to `/api` (the Hono app's basePath).
 */
export function routeToOpenApiFragment(
  def: RouteDefinition<ZodTypeAny | undefined>,
  opts: { pathPrefix?: string; securitySchemeName?: string } = {},
): OpenApiFragment {
  const pathPrefix = opts.pathPrefix ?? '/api';
  const securitySchemeName = opts.securitySchemeName ?? 'bearerAuth';
  const openApiPath = `${pathPrefix}${honoPathToOpenApi(def.path)}`;
  const httpMethod = def.method.toLowerCase() as OpenApiFragment['httpMethod'];

  const schemas: Record<string, Record<string, unknown>> = {};
  const operation: Record<string, unknown> = {
    operationId: operationId(def.method, def.path),
    summary: `${def.method} ${def.path}`,
    description: `${def.method} ${def.path}`,
    'x-papercusp-projection': 'route',
    // 'public'/'loopback' routes opt out of principal auth (own-auth,
    // unauthenticated, or host-gated); gated routes advertise the bearer scheme.
    security: def.auth === 'public' || def.auth === 'loopback' ? [] : [{ [securitySchemeName]: [] }],
    // Device-reachable routes (auth admits `kind: ['device']`) are tagged
    // so an OpenAPI consumer (and the /dev → Endpoints panel) can filter
    // the paired-device surface. Phase E10 (endpoint-unification-2026-05-21).
    ...(typeof def.auth === 'object' && def.auth.kind?.includes('device')
      ? { tags: ['papercusp:device'] }
      : {}),
  };

  // Path parameters.
  const params: Array<Record<string, unknown>> = pathParamNames(def.path).map((name) => ({
    name,
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }));

  // Input: a body for POST/PUT/PATCH, query parameters for GET/DELETE.
  if (def.input) {
    const inputSchema = zodToJsonSchemaSafe(def.input);
    if (def.method === 'POST' || def.method === 'PUT' || def.method === 'PATCH') {
      const schemaName = `${operationId(def.method, def.path)}.Input`;
      schemas[schemaName] = inputSchema;
      operation.requestBody = {
        required: true,
        content: { 'application/json': { schema: { $ref: `#/components/schemas/${schemaName}` } } },
      };
    } else {
      // Flatten the input object's top-level properties into query params.
      const props = (inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
      const required = new Set((inputSchema.required as string[] | undefined) ?? []);
      for (const [name, schema] of Object.entries(props)) {
        params.push({ name, in: 'query', required: required.has(name), schema });
      }
    }
  }
  if (params.length > 0) operation.parameters = params;

  operation.responses = {
    '200': { description: 'Success.' },
    '400': { $ref: '#/components/responses/InvalidInput' },
    '401': { $ref: '#/components/responses/Unauthorized' },
    '403': { $ref: '#/components/responses/RoleOrCapabilityDenied' },
    '408': { $ref: '#/components/responses/Timeout' },
    '500': { $ref: '#/components/responses/HandlerError' },
  };

  return { path: openApiPath, httpMethod, operation, schemas };
}

/** Every route's fragment — for `assembleOpenApiDocument`'s `extraFragments`. */
export function allRouteFragments(
  opts: { pathPrefix?: string; securitySchemeName?: string } = {},
): OpenApiFragment[] {
  return ALL_ROUTES.map((def) => routeToOpenApiFragment(def, opts));
}
