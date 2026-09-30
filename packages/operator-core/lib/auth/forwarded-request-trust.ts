/**
 * Forwarded-request trust — outside traffic never gets local trust.
 *
 * external-app-access-to-workspaces-2026-09-29 P-004 / R-7 / D-010. Local trust on
 * this host (the `'*'` loopback principal, the `auth:'loopback'` route tier, the
 * superuser loopback gate, the default-user session fallback, desktop pair-token
 * minting) was decided from the request's `Host` header. A tunnel daemon (cloudflared,
 * Tailscale Funnel, ngrok) runs on the same machine, connects from loopback, and can
 * be configured to rewrite `Host` to `localhost` — D-010 measured that such a request
 * resolved a full loopback principal because the Host check returned before
 * `X-Forwarded-For` was read.
 *
 * This module is the ONE verdict every local-trust gate consults. A request is
 * EXTERNAL — never local, whatever its `Host` says — when any of these hold:
 *
 *   1. it arrived on the external-ingress listener (`runAsExternalIngress`, bound by
 *      `hono-host` on `PAPERCUSP_EXTERNAL_INGRESS_PORT`). This is the durable answer
 *      for a tunnel that strips every forwarding header: point the tunnel at that
 *      listener and no header can talk its way into local trust;
 *   2. it carries the deny-only ingress marker (`x-papercusp-ingress`). A relay that
 *      replays outside calls to the local operator (the connector relay, P-007) sets
 *      it. The marker can only REMOVE trust, so a caller forging it harms only itself;
 *   3. it carries a header only an edge or tunnel adds (`cf-ray`, …);
 *   4. it carries proxy forwarding headers that do not prove every hop is loopback —
 *      a non-loopback client address, an unparseable one, a non-loopback
 *      `X-Forwarded-Host`, or forwarding headers with no client address at all.
 *
 * A request whose forwarding headers name ONLY loopback clients is a local proxy
 * (`local-proxy`) and keeps local trust. A request with no forwarding headers at all
 * is `direct`, and the caller falls back to its own Host check. No local hop in this
 * tree (the Vite dev proxy, the MCP proxy, the Tauri protocol) adds forwarding headers,
 * so this changes nothing for the desktop.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { pinModuleState } from '@papercusp/module-singleton';
import { isLoopbackAddress } from './loopback-peer-trust';

/** Deny-only marker a relay sets on every request it replays from outside. */
export const EXTERNAL_INGRESS_MARKER_HEADER = 'x-papercusp-ingress';

/** Port for the listener that serves tunnel traffic with no local trust. */
export const EXTERNAL_INGRESS_PORT_ENV = 'PAPERCUSP_EXTERNAL_INGRESS_PORT';

/** Headers that name the ORIGINAL client of a proxied request. */
const CLIENT_ADDRESS_HEADERS = [
  'x-forwarded-for',
  'x-real-ip',
  'cf-connecting-ip',
  'cf-connecting-ipv6',
  'true-client-ip',
  'x-client-ip',
  'x-cluster-client-ip',
  'fly-client-ip',
  'fastly-client-ip',
] as const;

/** Headers only an internet edge or tunnel adds — their presence alone is external. */
const EDGE_ONLY_HEADERS = ['cf-ray', 'cf-visitor', 'cf-ipcountry', 'cdn-loop', 'tailscale-funnel-request'] as const;

/** Forwarding headers that carry no client address but still mean "a proxy hop". */
const PROXY_HOP_HEADERS = ['x-forwarded-proto', 'x-forwarded-port', 'x-forwarded-server', 'via'] as const;

export type ForwardedRequestVerdict =
  /** No forwarding headers: the caller decides locality from its own Host check. */
  | { kind: 'direct' }
  /** Forwarding headers that name only loopback clients: a local proxy, still local. */
  | { kind: 'local-proxy' }
  /** Outside traffic: never local, whatever the Host header says. */
  | { kind: 'external'; reason: string };

const state = pinModuleState('@papercusp/operator-core.forwarded-request-trust', () => ({
  ingress: new AsyncLocalStorage<{ listener: string }>(),
}));

/**
 * Run `fn` (a listener's request handler) as external ingress: every local-trust
 * gate inside it refuses, whatever the request's headers say.
 */
export function runAsExternalIngress<T>(listener: string, fn: () => T): T {
  return state.ingress.run({ listener }, fn);
}

/** The external-ingress listener serving the current request, or null. */
export function currentExternalIngressListener(): string | null {
  return state.ingress.getStore()?.listener ?? null;
}

/** The configured external-ingress port, or null when the listener is not enabled. */
export function externalIngressPort(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env[EXTERNAL_INGRESS_PORT_ENV]?.trim();
  if (!raw) return null;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

/**
 * Strip quotes and a port from one forwarded address token. Handles `"[::1]:80"`,
 * `[::1]`, `127.0.0.1:5555`, and bare IPv6 (`::1`, kept whole — it has no port).
 */
function addressOf(token: string): string {
  let a = token.trim().replace(/^"|"$/g, '').trim().toLowerCase();
  if (a.startsWith('[')) {
    const end = a.indexOf(']');
    return end >= 0 ? a.slice(1, end) : a;
  }
  if ((a.match(/:/g) ?? []).length === 1) a = a.slice(0, a.indexOf(':'));
  return a;
}

function isLoopbackToken(token: string): boolean {
  const a = addressOf(token);
  return a === 'localhost' || isLoopbackAddress(a);
}

/** The `for=` values of an RFC 7239 `Forwarded` header, in hop order. */
function forwardedForValues(header: string): string[] {
  const out: string[] = [];
  for (const element of header.split(',')) {
    for (const pair of element.split(';')) {
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      if (pair.slice(0, eq).trim().toLowerCase() === 'for') out.push(pair.slice(eq + 1));
    }
  }
  return out;
}

/**
 * Classify a request by its forwarding headers alone (no listener or marker check —
 * see `externalIngressReason` for the full verdict).
 */
export function forwardedRequestVerdict(headers: Headers): ForwardedRequestVerdict {
  for (const name of EDGE_ONLY_HEADERS) {
    if (headers.has(name)) return { kind: 'external', reason: `edge-header:${name}` };
  }

  const clientAddresses: string[] = [];
  let forwardingSeen = false;
  for (const name of CLIENT_ADDRESS_HEADERS) {
    const value = headers.get(name);
    if (value === null) continue;
    forwardingSeen = true;
    for (const part of value.split(',')) {
      if (part.trim()) clientAddresses.push(part);
    }
  }
  const forwarded = headers.get('forwarded');
  if (forwarded !== null) {
    forwardingSeen = true;
    clientAddresses.push(...forwardedForValues(forwarded));
  }
  const forwardedHost = headers.get('x-forwarded-host');
  if (forwardedHost !== null) forwardingSeen = true;
  for (const name of PROXY_HOP_HEADERS) {
    if (headers.has(name)) forwardingSeen = true;
  }

  if (!forwardingSeen) return { kind: 'direct' };

  const outside = clientAddresses.find((token) => !isLoopbackToken(token));
  if (outside !== undefined) return { kind: 'external', reason: 'forwarded-client-not-loopback' };
  if (forwardedHost !== null) {
    const hosts = forwardedHost.split(',').map((h) => h.trim()).filter(Boolean);
    if (hosts.length === 0 || hosts.some((h) => !isLoopbackToken(h))) {
      return { kind: 'external', reason: 'forwarded-host-not-loopback' };
    }
  }
  // Forwarding headers with no client address cannot prove the hop was local.
  if (clientAddresses.length === 0) return { kind: 'external', reason: 'forwarded-without-client-address' };
  return { kind: 'local-proxy' };
}

/**
 * Why this request is outside traffic, or null when it may be treated as local
 * (subject to the caller's own Host check when the verdict is `direct`).
 */
export function externalIngressReason(headers: Headers): string | null {
  const listener = currentExternalIngressListener();
  if (listener) return `external-ingress-listener:${listener}`;
  if (headers.has(EXTERNAL_INGRESS_MARKER_HEADER)) return 'external-ingress-marker';
  const verdict = forwardedRequestVerdict(headers);
  return verdict.kind === 'external' ? verdict.reason : null;
}

/** True when this request must never receive local trust. */
export function requestIsExternal(headers: Headers): boolean {
  return externalIngressReason(headers) !== null;
}

/**
 * The single 403 a loopback-tier gate returns for outside traffic. Distinct from
 * `loopback_only` so the refusal names the real reason.
 */
export function externalIngressResponse(headers: Headers): Response | null {
  const reason = externalIngressReason(headers);
  if (reason === null) return null;
  return Response.json(
    {
      error: 'external_ingress_not_local',
      reason,
      detail:
        'This request arrived from outside the machine (a tunnel, relay, or proxy), so it gets no local trust. Authenticate with an app key instead.',
    },
    { status: 403 },
  );
}
