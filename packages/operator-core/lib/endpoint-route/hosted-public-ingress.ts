/**
 * hosted-public-ingress — which public route families on the hosted origin
 * (app.papercusp.com) must reach the hosted control plane, and two checks that
 * they do: one over a cloudflared ingress config, one over the live origin.
 * WI-10004437.
 *
 * ## Why
 *
 * The app.papercusp.com tunnel ingress is hand-maintained outside the repo
 * (`~/.cloudflared/papercup-demos.yml`). A path with no rule falls to the
 * session-gated portal's catch-all, which answers `401 portal_auth_required`.
 * Four public routes shipped without their rule, and each was found only by an
 * end-to-end run or by hand: WI-10003292 (`/api/hosted/cli/`), EAA P-014 F2
 * (`/api/hosted/relay/`), WI-10004436 (app relay and MCP OAuth) and
 * WI-10005066 (`/api/auth/workos/webhook`).
 *
 * ## Where the route list comes from
 *
 * Not from a copy. Every key in `HOSTED_RUNTIME_MOUNTED_ROUTE_KEYS` must fall in
 * exactly one family below; the suite fails on an unclassified key, so a new
 * public route cannot ship without someone deciding where the tunnel sends it.
 * The app-relay and MCP OAuth samples must be accepted by the predicates the
 * control plane itself routes with (`parseAppRelayPath`, `isPortalMcpOAuthPath`).
 * The MCP OAuth samples are one per entry of `PORTAL_MCP_OAUTH_ROUTES`, the
 * table that router matches against, so a new OAuth route is sampled too
 * (WI-10005092).
 */
import { parse as parseYaml } from 'yaml';
import { PORTAL_MCP_OAUTH_ROUTES, isPortalMcpOAuthPath, portalMcpOAuthRoutePath } from '../connected-apps/portal-mcp-oauth';
import type { CloudflaredIngressRule } from '../own-tunnel/config';
import { parseAppRelayPath } from '../workspace-host/hosted-app-relay';
import { HOSTED_RUNTIME_MOUNTED_ROUTE_KEYS } from './hosted-runtime';

/** `apps/operator/bin/hosted-handler.ts` mounts the hosted plane at `/api/*`. */
export const HOSTED_PLANE_PUBLIC_PREFIX = '/api';

/** The portal session gate's error code. The portal emits it; the control plane never does. */
export const PORTAL_SESSION_GATE_ERROR = 'portal_auth_required';

/**
 * `control-plane`: must be routed straight to the control plane (its callers have no portal session).
 * `portal`: reaches the plane through the portal, which serves or forwards it itself.
 * `unpublished`: must NOT be routed to the control plane on the public origin.
 */
export type HostedIngressExpectation = 'control-plane' | 'portal' | 'unpublished';

export interface HostedIngressFamily {
  readonly id: string;
  readonly expect: HostedIngressExpectation;
  readonly why: string;
  /** For a family of mounted plane routes: the route-key path prefix it owns. */
  readonly mountedPrefix?: string;
}

export const HOSTED_INGRESS_FAMILIES: ReadonlyArray<HostedIngressFamily> = [
  {
    id: 'health',
    expect: 'unpublished',
    mountedPrefix: '/health',
    why: 'Supervisor probes on the loopback listener. The portal answers its own /api/health on the public origin.',
  },
  {
    id: 'workos-webhook',
    expect: 'control-plane',
    mountedPrefix: '/auth/workos/webhook',
    why: 'WorkOS delivers signed webhooks with no session; the plane checks the signature (WI-10005066).',
  },
  {
    id: 'hosted-browser',
    expect: 'control-plane',
    mountedPrefix: '/hosted/browser/',
    why: 'The hosted browser surface; the plane checks its own session cookie.',
  },
  {
    id: 'workspace-connectors',
    expect: 'control-plane',
    mountedPrefix: '/hosted/workspaces/:workspaceId/connectors/',
    why: 'Connector enrollment and session tickets; the plane authenticates the caller itself (D-403).',
  },
  {
    id: 'connectors',
    expect: 'control-plane',
    mountedPrefix: '/hosted/connectors/',
    why: 'A workspace connector authenticates with its own bearer, never a portal session (D-403).',
  },
  {
    id: 'provider-delegations',
    expect: 'unpublished',
    mountedPrefix: '/hosted/workspaces/:workspaceId/provider-delegations/',
    why: 'Deliberately not published on the public origin (D-403, byoc-cloud-workspaces-gcp-aws-azure-2026-08-22).',
  },
  {
    id: 'cli',
    expect: 'control-plane',
    mountedPrefix: '/hosted/cli/',
    why: 'RFC 8628 device sign-in: the CLI has no session yet (WI-10003292).',
  },
  {
    id: 'relay-link',
    expect: 'control-plane',
    mountedPrefix: '/hosted/relay/',
    why: 'A local install links to the portal relay by device grant (EAA P-008, P-014 F2).',
  },
  {
    id: 'hosted-auth',
    expect: 'portal',
    mountedPrefix: '/hosted/auth/',
    why: 'The portal serves sign-in and forwards these routes to the plane itself.',
  },
  {
    id: 'app-relay',
    expect: 'control-plane',
    why: 'Apps authenticate with an app key or OAuth bearer, never a portal session (EAA P-007/P-016, WI-10004436).',
  },
  {
    id: 'mcp-oauth',
    expect: 'control-plane',
    why: 'MCP clients discover and run OAuth before they hold any session (P-325, WI-10004436).',
  },
];

export interface HostedIngressSample {
  readonly family: string;
  readonly expect: HostedIngressExpectation;
  readonly method: string;
  readonly path: string;
  /** The route key or predicate the sample was built from. */
  readonly source: string;
}

/** Workspace and webhook-source ids that satisfy the plane's path patterns. */
export const HOSTED_INGRESS_SAMPLE_WORKSPACE_ID = 'ws-ingress-probe';
export const HOSTED_INGRESS_SAMPLE_WEBHOOK_SOURCE_ID = '00000000-0000-4000-8000-000000000000';

function splitRouteKey(key: string): { method: string; path: string } {
  const space = key.indexOf(' ');
  return { method: key.slice(0, space), path: key.slice(space + 1) };
}

/** Every family whose mounted prefix owns this route key. A well-formed key has exactly one. */
export function familiesForMountedRouteKey(key: string): HostedIngressFamily[] {
  const { path } = splitRouteKey(key);
  return HOSTED_INGRESS_FAMILIES.filter((family) => {
    const prefix = family.mountedPrefix;
    if (!prefix) return false;
    return prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix || path.startsWith(`${prefix}/`);
  });
}

function familyById(id: string): HostedIngressFamily {
  const family = HOSTED_INGRESS_FAMILIES.find((candidate) => candidate.id === id);
  if (!family) throw new Error(`unknown hosted ingress family ${id}`);
  return family;
}

/**
 * One sample request per mounted plane route, plus the app-relay and MCP OAuth
 * paths. An unclassified mounted key is sampled as `control-plane`, so a probe
 * flags it loudly instead of skipping it.
 */
export function hostedIngressSamples(workspaceId: string = HOSTED_INGRESS_SAMPLE_WORKSPACE_ID): HostedIngressSample[] {
  const samples: HostedIngressSample[] = [];
  for (const key of HOSTED_RUNTIME_MOUNTED_ROUTE_KEYS) {
    const { method, path } = splitRouteKey(key);
    const [family] = familiesForMountedRouteKey(key);
    samples.push({
      family: family?.id ?? 'unclassified',
      expect: family?.expect ?? 'control-plane',
      method,
      path: `${HOSTED_PLANE_PUBLIC_PREFIX}${path.replaceAll(':workspaceId', workspaceId)}`,
      source: key,
    });
  }
  const workspaceBase = `/api/workspaces/${workspaceId}`;
  const relay = familyById('app-relay');
  for (const [method, path] of [
    ['POST', `${workspaceBase}/mcp`],
    ['POST', `${workspaceBase}/agent-tools/coord/whoami`],
    ['POST', `${workspaceBase}/hooks/${HOSTED_INGRESS_SAMPLE_WEBHOOK_SOURCE_ID}`],
  ] as const) {
    samples.push({ family: relay.id, expect: relay.expect, method, path, source: 'parseAppRelayPath' });
  }
  const oauth = familyById('mcp-oauth');
  for (const route of PORTAL_MCP_OAUTH_ROUTES) {
    samples.push({
      family: oauth.id,
      expect: oauth.expect,
      method: route.sampleMethod,
      path: portalMcpOAuthRoutePath(route, workspaceId),
      source: route.template,
    });
  }
  return samples;
}

/** True when the control plane's own router accepts this sample's path for its family. */
export function sampleMatchesPlanePredicate(sample: HostedIngressSample): boolean {
  if (sample.family === 'app-relay') return parseAppRelayPath(sample.path) !== null;
  if (sample.family === 'mcp-oauth') return isPortalMcpOAuthPath(sample.path);
  return sample.path.startsWith(`${HOSTED_PLANE_PUBLIC_PREFIX}/`);
}

// ─── cloudflared ingress ─────────────────────────────────────────────────────

export interface HostedIngressRule extends CloudflaredIngressRule {
  readonly path?: string;
}

/** The `ingress:` list of a cloudflared config file. */
export function parseCloudflaredIngressYaml(text: string): HostedIngressRule[] {
  const document = parseYaml(text) as { ingress?: unknown } | null;
  const ingress = document?.ingress;
  if (!Array.isArray(ingress)) throw new Error('cloudflared config has no ingress list');
  return ingress.map((raw, index) => {
    const rule = (raw ?? {}) as Record<string, unknown>;
    if (typeof rule.service !== 'string' || !rule.service) {
      throw new Error(`cloudflared ingress rule ${index + 1} has no service`);
    }
    return {
      service: rule.service,
      ...(typeof rule.hostname === 'string' ? { hostname: rule.hostname } : {}),
      ...(typeof rule.path === 'string' ? { path: rule.path } : {}),
    };
  });
}

function hostnameMatches(ruleHost: string | undefined, host: string): boolean {
  if (!ruleHost || ruleHost === '*') return true;
  const rule = ruleHost.toLowerCase();
  const actual = host.toLowerCase();
  return rule.startsWith('*.') ? actual.endsWith(rule.slice(1)) : actual === rule;
}

/**
 * The rule cloudflared picks: the first whose hostname matches and whose `path`
 * regex (unanchored, as Go's `MatchString`) matches. `ruleNumber` is 1-based,
 * like `cloudflared tunnel ingress rule`.
 */
export function routeCloudflaredIngress(
  rules: ReadonlyArray<HostedIngressRule>,
  hostname: string,
  path: string,
): { ruleNumber: number; service: string } | null {
  for (const [index, rule] of rules.entries()) {
    if (!hostnameMatches(rule.hostname, hostname)) continue;
    if (rule.path !== undefined && !new RegExp(rule.path).test(path)) continue;
    return { ruleNumber: index + 1, service: rule.service };
  }
  return null;
}

/** Compare cloudflared service URLs, treating every loopback spelling as one host. */
export function sameIngressService(a: string, b: string): boolean {
  const normalize = (service: string): string => {
    try {
      const url = new URL(service);
      const host = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ? 'loopback' : url.hostname;
      return `${url.protocol}//${host}:${url.port}`;
    } catch {
      return service;
    }
  };
  return normalize(a) === normalize(b);
}

export type HostedIngressProblem = 'not-routed-to-control-plane' | 'published-on-control-plane';

export interface HostedIngressFinding {
  readonly family: string;
  readonly method: string;
  readonly path: string;
  readonly problem: HostedIngressProblem;
  readonly service: string | null;
  readonly ruleNumber: number | null;
}

/** Route every sample through the rules and report the ones that land in the wrong place. */
export function auditHostedIngressRules(input: {
  rules: ReadonlyArray<HostedIngressRule>;
  hostname: string;
  controlPlaneService: string;
  workspaceId?: string;
}): { checked: number; findings: HostedIngressFinding[] } {
  const samples = hostedIngressSamples(input.workspaceId);
  const findings: HostedIngressFinding[] = [];
  for (const sample of samples) {
    if (sample.expect === 'portal') continue;
    const routed = routeCloudflaredIngress(input.rules, input.hostname, sample.path);
    const onPlane = routed !== null && sameIngressService(routed.service, input.controlPlaneService);
    const problem: HostedIngressProblem | null =
      sample.expect === 'control-plane' && !onPlane
        ? 'not-routed-to-control-plane'
        : sample.expect === 'unpublished' && onPlane
          ? 'published-on-control-plane'
          : null;
    if (problem) {
      findings.push({
        family: sample.family,
        method: sample.method,
        path: sample.path,
        problem,
        service: routed?.service ?? null,
        ruleNumber: routed?.ruleNumber ?? null,
      });
    }
  }
  return { checked: samples.length, findings };
}

// ─── live origin ─────────────────────────────────────────────────────────────

export interface HostedIngressProbeFinding {
  readonly family: string;
  readonly path: string;
  readonly status: number | null;
  readonly problem: 'portal-session-gate' | 'unreachable';
  readonly detail: string;
}

/**
 * Request every `control-plane` sample on the live origin and flag each one the
 * portal's session gate answered. Every request is an unauthenticated GET:
 * ingress routes by path alone, so a GET exercises the same rule with no side
 * effects, and the plane answers a wrong method with 404/405, never the portal's
 * gate error.
 */
export async function probeHostedPublicIngress(input: {
  origin: string;
  fetch?: typeof fetch;
  workspaceId?: string;
  timeoutMs?: number;
}): Promise<{ checked: number; findings: HostedIngressProbeFinding[] }> {
  const doFetch = input.fetch ?? fetch;
  const origin = input.origin.replace(/\/+$/, '');
  const samples = hostedIngressSamples(input.workspaceId).filter((sample) => sample.expect === 'control-plane');
  const probeOne = async (sample: HostedIngressSample): Promise<HostedIngressProbeFinding | null> => {
    try {
      const response = await doFetch(`${origin}${sample.path}`, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
      });
      const body = await response.text();
      if (!body.includes(PORTAL_SESSION_GATE_ERROR)) return null;
      return {
        family: sample.family,
        path: sample.path,
        status: response.status,
        problem: 'portal-session-gate',
        detail: body.slice(0, 200),
      };
    } catch (error) {
      // `fetch failed` alone hides the reason; the socket/DNS/TLS error rides on `cause`.
      const cause = (error as { cause?: { code?: unknown; message?: unknown } } | null)?.cause;
      const causeText = cause ? ` (${String(cause.code ?? cause.message ?? cause)})` : '';
      return {
        family: sample.family,
        path: sample.path,
        status: null,
        problem: 'unreachable',
        detail: `${error instanceof Error ? error.message : String(error)}${causeText}`,
      };
    }
  };
  // A bounded number of requests in flight: a burst of every sample at once is not what
  // a real client does, and an origin or local agent that sheds the burst reads as a
  // routing failure.
  const findings: Array<HostedIngressProbeFinding | null> = new Array(samples.length).fill(null);
  let next = 0;
  const workers = Array.from({ length: Math.min(HOSTED_INGRESS_PROBE_CONCURRENCY, samples.length) }, async () => {
    while (next < samples.length) {
      const index = next++;
      findings[index] = await probeOne(samples[index]);
    }
  });
  await Promise.all(workers);
  return {
    checked: samples.length,
    findings: findings.filter((finding): finding is HostedIngressProbeFinding => finding !== null),
  };
}

/** Requests the live probe keeps in flight at once. */
export const HOSTED_INGRESS_PROBE_CONCURRENCY = 4;
