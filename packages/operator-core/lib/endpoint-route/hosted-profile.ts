/**
 * Hosted-control-plane HTTP profile.
 *
 * The local Server intentionally mounts the complete endpoint registry. The
 * internet-facing hosted control plane must use the opposite posture: an
 * explicit, reviewed allowlist where absence means "not mounted". Keeping the
 * profile separate also prevents a future local route added to ALL_ROUTES from
 * becoming remotely reachable by accident.
 *
 * This leaf is deliberately not wired into the local host. Hosted integration
 * chooses this profile explicitly once the hosted identity/session routes are
 * available.
 *
 * That integration is `createHostedControlPlane` at the bottom of this file: it
 * composes the static allowlist with the dependency-injected hosted auth
 * routes, and mounts the whole surface on the HOSTED route stack so no hosted
 * request ever reaches the local principal chain.
 */
import { Hono } from 'hono';
import type { ZodTypeAny } from 'zod';
import type { HostedPrincipalResolver } from '../auth/hosted-principal-resolver';
import type { RouteDefinition, RouteMethod } from './define-route';
import { registerRoute } from './define-route';
import { createHostedRouteStack } from './hosted-route-stack';
import type { RouteStep } from './route-stack';
import { ALL_ROUTES } from './routes';
import {
  HOSTED_AUTH_ROUTES,
  createHostedAuthRoutes,
  type HostedAuthRouteDependencies,
} from './routes/hosted-auth';

type AnyRoute = RouteDefinition<ZodTypeAny | undefined>;

export type HostedRouteAccess = 'public' | 'authenticated';

export interface HostedRouteAllowlistEntry {
  readonly method: RouteMethod;
  readonly path: string;
  readonly access: HostedRouteAccess;
}

/**
 * The statically-registered hosted surface — the subset servable from
 * `ALL_ROUTES` alone.
 *
 * It stays tiny on purpose. The hosted auth routes are NOT here because they
 * are not in `ALL_ROUTES`: they are dependency-injected (a provider, a session
 * store, a cookie codec), so they are constructed per-deployment and
 * allowlisted through `HOSTED_AUTH_ROUTE_ALLOWLIST` below. Keeping the two
 * lists apart means this constant continues to answer exactly one question —
 * "which of the shared registry's routes may the internet reach?" — and adding
 * a route to `ALL_ROUTES` still cannot make it remotely reachable by accident.
 */
export const HOSTED_CONTROL_PLANE_ROUTE_ALLOWLIST = [
  { method: 'GET', path: '/health', access: 'public' },
  { method: 'GET', path: '/health/ready', access: 'public' },
] as const satisfies ReadonlyArray<HostedRouteAllowlistEntry>;

/**
 * The hosted browser-authentication surface.
 *
 * Derived from `HOSTED_AUTH_ROUTES` — the manifest `routes/hosted-auth/index.ts`
 * publishes as "consumed by the later hosted-profile integration item" — rather
 * than restated here, so the mounted set cannot drift from the implemented set.
 */
export const HOSTED_AUTH_ROUTE_ALLOWLIST =
  HOSTED_AUTH_ROUTES satisfies ReadonlyArray<HostedRouteAllowlistEntry>;

/** Local single-user authentication routes that can never enter this profile. */
export const HOSTED_FORBIDDEN_ROUTE_KEYS: ReadonlySet<string> = new Set([
  'POST /auth/login',
  'POST /auth/logout',
  'POST /auth/signup',
  'POST /auth/change-password',
  'GET /auth/me',
  'PATCH /auth/me',
]);

/** Local installation surfaces are likewise never valid hosted endpoints. */
const HOSTED_FORBIDDEN_PATH_PREFIXES = [
  '/cupboard/install-',
  '/desktop/install-',
  '/provision/',
] as const;

function routeKey(route: Pick<AnyRoute, 'method' | 'path'>): string {
  return `${route.method} ${route.path}`;
}

function isCatchAllPath(path: string): boolean {
  return path.includes('*') || /\{\.[+*]/.test(path) || path === '/:transport';
}

function assertAllowlistEntryIsSafe(entry: HostedRouteAllowlistEntry): void {
  const key = routeKey(entry);
  if (HOSTED_FORBIDDEN_ROUTE_KEYS.has(key)) {
    throw new Error(`hosted-profile: local authentication route is forbidden: ${key}`);
  }
  if (HOSTED_FORBIDDEN_PATH_PREFIXES.some((prefix) => entry.path.startsWith(prefix))) {
    throw new Error(`hosted-profile: local installation route is forbidden: ${key}`);
  }
  if (isCatchAllPath(entry.path)) {
    throw new Error(`hosted-profile: catch-all routes cannot be allowlisted: ${key}`);
  }
}

function assertRouteAccess(route: AnyRoute, expected: HostedRouteAccess): void {
  const key = routeKey(route);
  if (expected === 'public') {
    if (route.auth !== 'public') {
      throw new Error(`hosted-profile: ${key} is allowlisted as public but declares a different auth tier`);
    }
    return;
  }

  if (typeof route.auth !== 'object' || route.auth === null) {
    throw new Error(`hosted-profile: ${key} must require an authenticated principal`);
  }
  const capabilities = route.auth.capabilities;
  if (!capabilities?.length) {
    throw new Error(`hosted-profile: ${key} must require at least one concrete capability`);
  }
  if (capabilities.includes('*')) {
    throw new Error(`hosted-profile: ${key} cannot require or admit wildcard capability authority`);
  }
}

/**
 * Resolve and validate the exact routes mounted by the hosted profile.
 *
 * Both arguments are injectable so focused security tests and later hosted
 * integration can exercise the profile without mutating the shared registry.
 */
export function selectHostedControlPlaneRoutes(
  routes: ReadonlyArray<AnyRoute>,
  allowlist: ReadonlyArray<HostedRouteAllowlistEntry> = HOSTED_CONTROL_PLANE_ROUTE_ALLOWLIST,
): ReadonlyArray<AnyRoute> {
  const selected: AnyRoute[] = [];
  const allowlistedKeys = new Set<string>();

  for (const entry of allowlist) {
    assertAllowlistEntryIsSafe(entry);
    const key = routeKey(entry);
    if (allowlistedKeys.has(key)) {
      throw new Error(`hosted-profile: duplicate allowlist entry: ${key}`);
    }
    allowlistedKeys.add(key);

    const matches = routes.filter((route) => routeKey(route) === key);
    if (matches.length === 0) {
      throw new Error(`hosted-profile: allowlisted route is not registered: ${key}`);
    }
    if (matches.length > 1) {
      throw new Error(`hosted-profile: allowlisted route is ambiguous: ${key}`);
    }

    const route = matches[0];
    assertRouteAccess(route, entry.access);
    selected.push(route);
  }

  return selected;
}

/** Mount only the validated hosted allowlist onto an existing Hono app. */
export function registerHostedControlPlaneRoutes(
  app: Hono,
  routes: ReadonlyArray<AnyRoute> = ALL_ROUTES,
  allowlist: ReadonlyArray<HostedRouteAllowlistEntry> = HOSTED_CONTROL_PLANE_ROUTE_ALLOWLIST,
  stack?: ReadonlyArray<RouteStep>,
): ReadonlyArray<AnyRoute> {
  const selected = selectHostedControlPlaneRoutes(routes, allowlist);
  for (const route of selected) registerRoute(app, route, stack);
  return selected;
}

/** Create a default-deny `/api` app using the dedicated hosted profile. */
export function createHostedControlPlaneApp(
  routes: ReadonlyArray<AnyRoute> = ALL_ROUTES,
  allowlist: ReadonlyArray<HostedRouteAllowlistEntry> = HOSTED_CONTROL_PLANE_ROUTE_ALLOWLIST,
  stack?: ReadonlyArray<RouteStep>,
): Hono {
  const app = new Hono().basePath('/api');
  registerHostedControlPlaneRoutes(app, routes, allowlist, stack);
  return app;
}

export interface HostedControlPlaneOptions {
  /** Dependencies for the injected hosted sign-in/callback/logout/session routes. */
  readonly hostedAuth: HostedAuthRouteDependencies;
  /**
   * Resolves a request into a hosted principal. Build it with
   * `createHostedPrincipalResolver`; the profile never resolves a principal any
   * other way.
   */
  readonly resolvePrincipal: HostedPrincipalResolver;
  /** The shared registry to select the static allowlist from. */
  readonly routes?: ReadonlyArray<AnyRoute>;
  /** Static allowlist, if a deployment narrows it further. Never widened here. */
  readonly staticAllowlist?: ReadonlyArray<HostedRouteAllowlistEntry>;
}

export interface HostedControlPlane {
  readonly app: Hono;
  /** Exactly what was mounted, in mount order — the auditable surface. */
  readonly mounted: ReadonlyArray<AnyRoute>;
}

/**
 * Build the production hosted control plane: the static allowlist plus the
 * injected hosted auth routes, mounted on the hosted route stack.
 *
 * This is the one function that turns the finished-but-unmounted hosted auth
 * leaf into a reachable surface. Three properties hold by construction:
 *
 *   - every mounted route passed `selectHostedControlPlaneRoutes`, so local
 *     auth, install surfaces, catch-alls, and wildcard capabilities are all
 *     refused at mount time;
 *   - every mounted route dispatches through the HOSTED stack, so the local
 *     principal chain is unreachable even for a route that would otherwise
 *     resolve one;
 *   - the mounted set is returned, so a deployment can assert its exact
 *     surface rather than trusting that the allowlist was applied.
 */
export function createHostedControlPlane(options: HostedControlPlaneOptions): HostedControlPlane {
  const hostedAuthRoutes = createHostedAuthRoutes(options.hostedAuth);
  const routes = [...(options.routes ?? ALL_ROUTES), ...hostedAuthRoutes];
  const allowlist = [
    ...(options.staticAllowlist ?? HOSTED_CONTROL_PLANE_ROUTE_ALLOWLIST),
    ...HOSTED_AUTH_ROUTE_ALLOWLIST,
  ];

  const app = new Hono().basePath('/api');
  const mounted = registerHostedControlPlaneRoutes(
    app,
    routes,
    allowlist,
    createHostedRouteStack(options.resolvePrincipal),
  );
  return { app, mounted };
}
