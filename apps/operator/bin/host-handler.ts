/**
 * Composed request handler for the operator Hono host — side-effect free,
 * so it can be imported by tests and the import-resolution smoke without
 * starting a server or running bootstrap. `hono-host.ts` is the entrypoint
 * that wraps this with `runBootstrap()` + `serve()`.
 *
 * Phase E extension: a top-level Hono app layers the ported `next.config.js`
 * + `proxy.ts` behaviors on top of the inner `_hono/app.ts` API:
 *
 *   apiCors     — broad `/api/*` CORS port from proxy.ts; mounts on the host
 *                 (not inside `_hono/app.ts`) to preserve the Phase 0
 *                 BOUNDARY contract — the existing narrow `tauriApiCors`
 *                 inside `_hono` is left untouched. As-built deviation from
 *                 plan E2.
 *   rustOptIn   — env-gated `?backend=rust` proxy. Default off.
 *   crossApp    — `/api/org/*` etc. → :3061 / :3001 upstream proxies.
 *   docsRoutes  — `/internal/docs/*` loopback gate + slug→html + Accept→md.
 *   pageRoutes  — `/wiki`, `/drizzle-studio`.
 *   app.fetch   — local API fallthrough (`/api/*`).
 *   spaRoutes   — Phase G3: built Vite SPA (`operator-vite/dist/`) for every
 *                 remaining path. Static assets by extension; the index
 *                 shell for client routes.
 */
import { Hono } from 'hono';
import type { Http2Bindings, HttpBindings } from '@hono/node-server';
import { app } from './host-app';
import { apiCors } from './host-cors';
import { hostRebindingGuard } from './host-rebinding-guard';
import { docsRoutes } from './host-docs';
import { publicDocsRoutes } from './host-docs-public';
import { pageRoutes } from './page-routes';
import { crossAppRewrites, rustOptIn } from './host-proxies';
import { spaRoutes } from './host-spa';
import {
  faultInjectionEnabled,
  faultInjectionControl,
  faultInjectionMiddleware,
} from './host-fault-injection';
import { backpressureMiddleware } from './host-backpressure';
import { requestDeadlineMiddleware } from './host-request-deadline';
import { runWithLoopbackPeerVerdict } from '@papercusp/operator-core/lib/auth/loopback-peer-trust';
import { runAsExternalIngress } from '@papercusp/operator-core/lib/auth/forwarded-request-trust';

const host = new Hono();

// 1. NO RESPONSE COMPRESSION — deliberate, do not re-add.
//    Papercusp ships as a Tauri DESKTOP app: this host binds 127.0.0.1
//    (resolveBindHost) and every consumer is on the same machine. Over
//    loopback there is no bandwidth to save, so gzip is pure CPU on both
//    ends — it cost ~50–100 ms of main-thread block per large sync response
//    and is why cpu-task-worker.ts had to exist at all. The Tauri custom
//    protocol already strips `accept-encoding` for this exact reason
//    (src-tauri/src/custom_protocol.rs), and the one genuinely remote
//    consumer (`/device/*`, the mobile client) never compressed either.
//    If this host is ever fronted by a real network hop, compression belongs
//    at the edge proxy (see infra/defguard/Caddyfile `encode gzip`), not in
//    the app. Guarded by scripts/check-no-wire-compression.mjs.

// 1.5. DNS-rebinding guard (open-source-release P-010): a loopback-bound
//      operator refuses any /api request whose Host is not a loopback name.
//      Runs first so a rebinding page is refused before CORS/handlers.
host.use('/api/*', hostRebindingGuard);

// 2. Broad `/api/*` CORS (proxy.ts port). Handles OPTIONS preflight and
//    decorates downstream responses with the standard headers.
host.use('/api/*', apiCors);

// 2.25. Inbound-HTTP backpressure / load-shedding (P-018). Inert unless
//        PAPERCUSP_HTTP_BACKPRESSURE=1; even then it sheds ONLY caller-marked
//        deferrable requests (x-papercusp-deferrable header / configured path)
//        under CRITICAL event-loop pressure — never interactive or health
//        traffic. Runs early (after CORS preflight) so a shed costs no handler
//        dispatch. Reuses the existing loop-lag signal.
host.use('/api/*', backpressureMiddleware);

// 2.3. Handler deadline (P-006 / B2). Inert unless PAPERCUSP_HTTP_HANDLER_DEADLINE=1;
//       when on, bounds a non-streaming /api handler's time-to-Response and fast-503s a
//       wedge (a stuck PG query / native hang) instead of hanging the client forever.
//       Excludes MCP + every SSE/streaming endpoint + health + WS upgrades. Runs AFTER
//       load-shedding (a shed request never starts a deadline) and BEFORE the rust /
//       cross-app / local-API handlers, so its `next()` wraps the actual handler.
host.use('/api/*', requestDeadlineMiddleware);

// 2.5. Fault injection (EI-297) — test-only, inert unless the host started
//      with PAPERCUSP_FAULT_INJECTION=1. Sits in front of every API path
//      (local, rust, cross-app) so desktop e2e can exercise server-error /
//      timeout legs through the IPC-first /api path no HTTP proxy can reach.
if (faultInjectionEnabled()) {
  host.route('/', faultInjectionControl());
  host.use('/api/*', faultInjectionMiddleware);
}

// 3. Rust opt-in proxy. Inert unless PAPERCUSP_ENABLE_RUST_REWRITES=1.
//    Must run before the cross-app rewrites and local API so the
//    `?backend=rust` flag wins.
host.use('/api/*', rustOptIn);

// 4. Cross-app upstream proxies (`/api/org/*` → :3061 etc.). These match
//    before the local-API fallthrough below; the URL spaces don't overlap
//    so order is unambiguous.
host.route('/', crossAppRewrites);

// 5. Docs surfaces. `/internal/docs/*` is loopback-only engineering docs;
//    `/docs/*` is the public Papercusp docs (Starlight at apps/papercusp-docs).
host.route('/', docsRoutes);
host.route('/', publicDocsRoutes);

// 6. Page-namespace routes (`/wiki`, `/drizzle-studio`).
host.route('/', pageRoutes);

// 7. Local API fallthrough — every remaining `/api/*` request goes to the
//    inner Hono app. Calling `app.fetch(c.req.raw)` (not `c.req`) preserves
//    the original Web `Request` object — `_hono/app.ts` handlers index off
//    `c.req.raw` for things like `request.signal` (abort propagation).
//
//    `/api/*` terminates here: an unknown API path returns the inner app's
//    real (JSON) 404, NOT the SPA shell — so the SPA fallback below never
//    sees an `/api/*` request.
host.all('/api/*', (c) => app.fetch(c.req.raw, c.env));

// 8. SPA fallback (Phase G3) — the built Vite app for everything the API,
//    docs, page-namespace, and cross-app routes above did not claim.
//    Registered last so it only catches client routes + static assets.
//
//    Gated by PAPERCUSP_SERVE_UI (default '1'/on). The headless
//    `papercusp serve` entry (SP1, operator-core-headless-serve-2026-06-04 C2)
//    sets it to '0' to drop the UI entirely; the desktop's webview consumes
//    spaRoutes as its content source, so default-on leaves the desktop/dev
//    box unchanged.
if (process.env.PAPERCUSP_SERVE_UI !== '0') {
  host.route('/', spaRoutes);
}

export async function handler(
  req: Request,
  env?: HttpBindings | Http2Bindings,
): Promise<Response> {
  // WI-10003619: bind loopback trust to the connecting socket's uid on hosts whose
  // loopback interface is shared with another account (a hosted workspace VM). Every
  // loopback trust decision below (the auth:'loopback' tier, the loopback principal,
  // ad-hoc isLoopbackRequest callers) reads the verdict this establishes. A no-op on
  // single-user hosts — see loopbackPeerUidPolicyActive().
  const socket = env?.incoming?.socket ?? null;
  return runWithLoopbackPeerVerdict(socket, () => host.fetch(req, env));
}

/**
 * external-app-access P-004 / R-7: the handler for the external-ingress listener
 * (`PAPERCUSP_EXTERNAL_INGRESS_PORT`). A user's own tunnel points here; every request
 * runs as external ingress, so every local-trust gate refuses it — even one whose
 * tunnel rewrote Host to localhost and stripped every forwarding header (D-010's
 * third case, which headers alone cannot tell apart from the desktop).
 */
export function externalIngressHandler(
  req: Request,
  env?: HttpBindings | Http2Bindings,
): Promise<Response> {
  return runAsExternalIngress('external-ingress', () => handler(req, env));
}
