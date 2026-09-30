/**
 * @module endpoint-route — the HTTP route projection.
 *
 * The endpoint-system's route projection: HTTP-native plumbing endpoints
 * declared with `defineTool` (route-shaped input), mounted on the Hono
 * app via `registerRoute`, with the cross-cutting machinery (auth, input
 * validation, timeout, telemetry, uniform errors) — but deliberately NOT
 * in the agent tool catalog.
 *
 * Plan: apps/operator/docs/plans/endpoint-route-migration-2026-05-20.md
 */

export {
  registerRoute,
  type RouteDefinition,
  type RouteContext,
  type RouteMethod,
  type RouteAuth,
} from './define-route';
export {
  runRouteStack,
  DEFAULT_ROUTE_STACK,
  type RouteStep,
  type RouteStepName,
  type RouteExecution,
} from './route-stack';
export { registerAllRoutes, registeredRouteCount } from './register';
export { ALL_ROUTES } from './routes';
export { routeToOpenApiFragment, allRouteFragments } from './openapi';
