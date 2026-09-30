/**
 * SPA static fallback for the operator Hono host — Phase G3 of the
 * operator-vite migration.
 *
 * Serves the built Vite SPA (`apps/operator-vite/dist/`) for every request
 * that the API / docs / page-namespace routes didn't claim:
 *
 *   - Path WITH a file extension (`/assets/index-abc.js`, `/favicon.ico`)
 *     → serve that file from `dist/`; a miss is a real 404 (never shell a
 *     missing `.js`/`.css` — that produces confusing MIME errors).
 *   - Path WITHOUT an extension (`/`, `/login`, `/settings/voice`,
 *     `/nonexistent`) → serve `dist/index.html` with 200. The TSR client
 *     router owns routing, including its own not-found component — so even
 *     an unknown client path returns the 200 shell (plan G acceptance).
 *
 * `dist/` is resolved from `__dirname` (NOT `process.cwd()`) — same
 * audit-3-safe pattern as `host-docs.ts`. `bin/` is `apps/operator/bin/`;
 * the Vite dist is the sibling `apps/operator-vite/dist/`.
 *
 * Final home (Phase H): when `apps/operator/` is removed, the host moves
 * under `apps/operator-vite/server/` and this resolve() shortens.
 */
import { Hono } from 'hono';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { isHashedAssetPath } from '../../operator-vite/dist-atomic-writes';
// P-006: the destination invariant as a POLICY (the prevention leg), kept in one
// place so this host, the vite dev server and the desktop cannot drift apart.
// Imported from the LEAF module, not the '@papercusp/desktop-ipc' barrel: this
// host is a Node process, and the barrel pulls in @tauri-apps/api and the
// webview bootstrap, which have no business being loaded server-side.
// csp-policy.ts imports nothing at all, so it is safe in any environment.
import { cspHeaders, crossOriginIsolationHeaders } from '../../../libs/generic/desktop-ipc/src/csp-policy';
import { describeMissingBundle, readBundleIdentity } from '../lib/spa-build-status';
import { hostedBrowserApiMarker } from "../lib/hosted-browser-api";
export { hostedBrowserApiMarker };
export type { HostedBrowserApiMarker } from "../lib/hosted-browser-api";

/**
 * Vite SPA `dist/` root. In dev (host run via `tsx` from source) this
 * resolves `__dirname`-relative — `bin/` → sibling `apps/operator-vite/dist`.
 * In the packaged desktop the host is esbuild-bundled into a single file
 * whose `__dirname` is the sidecar root, so the build sets
 * `PAPERCUSP_SPA_DIST` to the bundled `dist/` location explicitly.
 */
function resolveSpaDistRoot(): string {
  // 1. Explicit — the build/env launcher sets this to the bundled SPA
  //    (env-operator-launcher passes `<envDir>/spa`).
  if (process.env.PAPERCUSP_SPA_DIST) return resolve(process.env.PAPERCUSP_SPA_DIST);
  // 2. Packaged desktop: the host is esbuild-bundled into a single file at the
  //    sidecar ROOT, and the bundled SPA lives beside it at `sidecar/spa/`. If a
  //    launch path forgot to export PAPERCUSP_SPA_DIST (the `serve --ensure`
  //    self/discovery operator did — it 404'd every UI route while the API stayed
  //    up), fall back to that bundled location instead of the dev-source path,
  //    which does not exist in the bundle. Defense-in-depth: a missing env var
  //    must never blank the desktop UI.
  const bundled = resolve(__dirname, 'spa');
  if (existsSync(join(bundled, 'index.html'))) return bundled;
  // 3. Dev (host run via `tsx` from source): `bin/` → sibling `operator-vite/dist`.
  return resolve(__dirname, '..', '..', 'operator-vite', 'dist');
}
const SPA_DIST_ROOT = resolveSpaDistRoot();

const EXT_CONTENT_TYPE: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const TEXT_EXTS = new Set([
  '.html', '.js', '.mjs', '.css', '.json', '.map', '.svg', '.txt', '.webmanifest',
]);

/**
 * Immutable, version-pinned third-party runtime assets (WI-7088).
 *
 * `/vditor/**` is a wholesale mirror of one PINNED vditor version, regenerated
 * by replacing the directory when the dependency changes (setup-vditor-runtime.sh
 * rm -rf's and re-copies), never mutated in place — so a long-lived `immutable`
 * cache entry can never go stale under a reader.
 *
 * Why it earns a special case: the mirror exists to stop Vditor fetching ~4.9MB
 * from unpkg.com on every cold render, and lute.min.js alone is 3.9MB. Without a
 * cache header, `serveFile` below readFileSync's all 3.9MB on EVERY page load —
 * measured at ~30ms a time inside the desktop webview, versus ~4ms when the
 * browser is allowed to reuse its copy. unpkg was, ironically, sending
 * `max-age=31536000` and we were not, so the local mirror won the cold fetch
 * (~30ms vs ~225ms) but lost the warm one. This closes that last gap.
 */
const IMMUTABLE_ASSET_PREFIX = 'vditor/';
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * A SPA asset is immutable when its URL carries a content hash (the Vite
 * `assets/` naming contract) or when it belongs to the pinned Vditor mirror.
 * Keep this predicate next to the response policy so a new route cannot
 * accidentally make a mutable file long-lived in browser caches.
 */
export function isImmutableSpaAssetPath(relPath: string): boolean {
  return relPath.startsWith(IMMUTABLE_ASSET_PREFIX) || isHashedAssetPath(relPath);
}

function serveFile(absPath: string, status = 200, cacheControl?: string): Response {
  const ext = extname(absPath).toLowerCase();
  const contentType = EXT_CONTENT_TYPE[ext] ?? 'application/octet-stream';
  // Do not read the whole bundle into the event-loop thread for every request.
  // Node's stream-to-web adapter gives Hono a backpressured body, so a large
  // chunk is bounded by the socket/high-water marks instead of multiplying its
  // full byte length by the number of concurrent cold page loads. Text assets
  // still decode correctly in Response.text() because their content type keeps
  // the UTF-8 charset above.
  const body = Readable.toWeb(createReadStream(absPath)) as ReadableStream<Uint8Array>;
  const headers = new Headers({
    'content-type': contentType,
    'content-length': String(statSync(absPath).size),
  });
  if (cacheControl) headers.set('cache-control', cacheControl);
  return new Response(body, {
    status,
    headers,
  });
}

/**
 * Serve the SPA shell with pre-hydration globals injected:
 *
 *   - `window.__PAPERCUSP_WS__` — the active workspace id. The browser
 *     namespaces per-workspace localStorage off this, so it must be set
 *     before the deferred module bundle runs — and independent of the URL,
 *     which doesn't reliably carry `?ws=` (workspace-localstorage-isolation-
 *     2026-05-27, D-001). The operator process is workspace-specific
 *     (HOME-remapped), so `activeWorkspaceId()` is the right source.
 *
 *   - `window.__PAPERCUSP_TAURI_ISOLATED__` — a launch-time safety marker for
 *     the opt-in headless verifier. It is injected from the sidecar env rather
 *     than read from the URL because the SPA may redirect away from the
 *     verifier's initial query before voice-mode initializes.
 *
 *   - `window.__PAPERCUSP_FLAGS__` — the resolved feature-flag payload. The
 *     flags client (`libs/flags` client `readInitialPayload`) seeds its
 *     snapshot from this global, so flag-gated UI paints with the real flag
 *     state on first render instead of FLAG_DEFAULTS. Without it, an enabled
 *     flag's surface renders hidden for one paint, then pops in once the
 *     async `/api/flags/bootstrap` fetch resolves — the flash this removes.
 *     This is data injection into a static shell, NOT server-side rendering:
 *     the client still renders 100% of the UI, and still revalidates via
 *     `loadFlags()` + the shared sync SSE bus. We compute it exactly as the
 *     `/flags/bootstrap` route does (same reinit guard + distinct-id), since
 *     this host owns the same in-process flag backend. Best-effort: a flag
 *     backend hiccup must never break the shell, so on any error we omit the
 *     seed and let the client fall back to its async bootstrap.
 */
export type SpaRouteProfile =
  | { readonly kind?: 'local' }
  | {
      readonly kind: 'hosted';
      /** Fixed control-plane workspace; never a customer-selected workspace. */
      readonly controlPlaneWorkspaceId: string;
    };

/** Escape the three characters that can terminate or mutate a script element. */
function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

async function localPreHydrationGlobals(req: Request): Promise<string[]> {
  // Keep every process-global/local data dependency behind this branch. The
  // hosted profile below never imports these modules, much less calls them.
  const { activeWorkspaceId } = await import('@papercusp/operator-core/lib/workspace-registry');
  let wsId = 'default';
  try {
    // Phase E (P-053): each window self-identifies via `?ws=<id>` in its URL
    // (the multi-window shell opens `/harness?ws=<id>`). The SPA index route is
    // NOT under the /api workspace middleware, so prefer the request's `?ws=`
    // here and fall back to the registry/global `activeWorkspaceId()` only for a
    // bare load. This makes `window.__PAPERCUSP_WS__` (→ getBrowserWorkspaceId)
    // match the window's workspace, so its fetch/EventSource stamping scopes to
    // the right workspace against the one shared sidecar.
    const reqWs = new URL(req.url).searchParams.get('ws');
    wsId = reqWs && reqWs.trim() ? reqWs.trim() : activeWorkspaceId();
  } catch {
    /* registry/url unreadable — fall back to 'default' */
  }
  const globals = [`window.__PAPERCUSP_WS__=${JSON.stringify(wsId)};`];
  if (process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED === '1') {
    globals.push('window.__PAPERCUSP_TAURI_ISOLATED__=true;');
  }
  // Pre-paint presentation preferences (theme, visual-effects). The boot
  // scripts in index.html read these synchronously BEFORE React mounts so the
  // page paints the user's saved theme + effects with no flash. PG is the
  // source of truth (the desktop webview's localStorage is unreliable across
  // reloads/restarts — see lib/profile-pref.ts), read here for the same
  // workspace the window self-identifies as. Best-effort: on any error the
  // boot scripts fall back to the localStorage cache + defaults.
  try {
    const { readProfile } = await import('@papercusp/operator-core/lib/session');
    const profile = await readProfile(wsId);
    const prefs = {
      theme_id: typeof profile.theme_id === 'string' ? profile.theme_id : null,
      visual_effects_mode:
        typeof profile.visual_effects_mode === 'string' ? profile.visual_effects_mode : null,
    };
    globals.push(`window.__PAPERCUSP_PREFS__=${JSON.stringify(prefs)};`);
  } catch {
    /* profile unreadable — boot scripts fall back to localStorage + defaults */
  }
  try {
    const [flagsModule, distinctId, flagBus, posthog] = await Promise.all([
      import('@papercusp/flags/server'),
      import('@papercusp/operator-core/lib/flag-distinct-id'),
      import('@papercusp/operator-core/lib/flag-bus'),
      import('@papercusp/operator-core/lib/posthog-config'),
    ]);
    const { getAllFlags, isBackendConfigured } = flagsModule;
    const { resolveDistinctId } = distinctId;
    const { reinitFlagBackend } = flagBus;
    const { isTestingFeaturesEnabled } = posthog;
    if (isBackendConfigured() !== isTestingFeaturesEnabled()) {
      reinitFlagBackend();
    }
    const resolvedFlags = await getAllFlags(resolveDistinctId(req));
    globals.push(`window.__PAPERCUSP_FLAGS__=${JSON.stringify(resolvedFlags)};`);
  } catch {
    /* flag backend unavailable — client bootstraps flags asynchronously */
  }
  return globals;
}

async function serveIndexHtml(
  indexPath: string,
  req: Request,
  hostedControlPlaneWorkspaceId: string | null,
): Promise<Response> {
  let html = readFileSync(indexPath, 'utf-8');
  // EI-15848: stamp the page with the identity of the bundle it is booting
  // from, so the running UI can later notice it has gone stale. Hashed from the
  // file on disk BEFORE the per-request injection below, so a flag flip (which
  // changes the injected globals, not the build) never reads as a new build.
  const bootBundleId = readBundleIdentity(SPA_DIST_ROOT);
  const globals = hostedControlPlaneWorkspaceId === null
    ? await localPreHydrationGlobals(req)
    : [
        `window.__PAPERCUSP_WS__=${scriptSafeJson(hostedControlPlaneWorkspaceId)};`,
        `window.__PAPERCUSP_HOSTED_BROWSER__=${scriptSafeJson(hostedBrowserApiMarker(hostedControlPlaneWorkspaceId))};`,
        // Alias retained for clients that used the more explicit name during
        // the hosted-browser rollout; both values are the same immutable data.
        `window.__PAPERCUSP_HOSTED_BROWSER_API__=window.__PAPERCUSP_HOSTED_BROWSER__;`,
      ];
  if (bootBundleId) globals.push(`window.__PAPERCUSP_BUILD_ID__=${scriptSafeJson(bootBundleId)};`);
  const inject = `<script>${globals.join('')}</script>`;
  // Insert right after <head> so it runs before the deferred module bundle.
  html = html.includes('<head>') ? html.replace('<head>', `<head>${inject}`) : inject + html;
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // EI-2425 fix C: this shell injects per-request state (window.__PAPERCUSP_FLAGS__,
      // __PAPERCUSP_WS__, __PAPERCUSP_PREFS__) and references content-hashed bundles, so
      // it must NEVER be cached. A cached shell serves STALE baked flags + an outdated
      // bundle — which is why a flag flip or a fresh deploy required a HARD reload to
      // surface (a normal reload / reopen reused WebKitGTK's cached shell). Mirrors the
      // /api/flags/bootstrap `no-store`. The hashed assets stay cacheable (served
      // elsewhere); only this dynamic shell opts out, so any normal reload now gets the
      // latest flags + bundle.
      // `no-transform` also prevents Cloudflare from rewriting the hosted shell
      // to inject its Web Analytics beacon. Keep `no-store`: the per-request
      // globals above make this document unsafe to cache even though its
      // content-hashed assets remain immutable.
      'cache-control': 'no-store, max-age=0, no-transform',
      // P-006: the CSP goes on the SPA DOCUMENT (a CSP applies to the document it
      // is served with, so the hashed asset responses are the wrong place for it).
      // Now ENFORCING (P-005 clause 4) after the policy was validated against live
      // sessions — see csp-policy.ts for the measurement that licensed the flip.
      // It stays permissive on every axis EXCEPT origin, so the only thing it can
      // block is a fetch from a host we do not own, which is the point.
      ...cspHeaders(),
      // P-005 (WI-4498): cross-origin isolation, so onnxruntime-web's threaded
      // wasm backend (the only backend it ships) can use SharedArrayBuffer.
      // See crossOriginIsolationHeaders() for why this is safe unconditionally.
      ...crossOriginIsolationHeaders(),
    },
  });
}

/** Resolve `rel` under `dist/`, guarding against path traversal. */
function safeDistPath(rel: string): string | null {
  const abs = resolve(SPA_DIST_ROOT, rel);
  if (abs !== SPA_DIST_ROOT && !abs.startsWith(SPA_DIST_ROOT + sep)) return null;
  return abs;
}

export function createSpaRoutes(profile: SpaRouteProfile = { kind: 'local' }): Hono {
  let hostedControlPlaneWorkspaceId: string | null = null;
  if (profile.kind === 'hosted') {
    const configuredWorkspaceId = profile.controlPlaneWorkspaceId.trim();
    if (configuredWorkspaceId.length === 0) {
      throw new TypeError('hosted_spa_requires_a_control_plane_workspace_id');
    }
    hostedControlPlaneWorkspaceId = configuredWorkspaceId;
  }

  const routes = new Hono();

  // EI-15848: the identity of the bundle on disk RIGHT NOW. The running UI
  // compares this against the `window.__PAPERCUSP_BUILD_ID__` it booted with and
  // offers a reload when they diverge — the signal that was missing while the
  // owner's window silently served a stale bundle and re-reported already-fixed
  // bugs. Registered BEFORE the `*` fallback below, which would otherwise answer
  // this extension-less path with index.html.
  //
  // `no-store` for the same reason the shell is: a cached answer here would
  // report the build that was current when it was cached, which is precisely the
  // staleness this endpoint exists to detect.
  routes.get('/__spa/build-id', (c) =>
    c.json(
      { buildId: readBundleIdentity(SPA_DIST_ROOT) },
      200,
      { 'cache-control': 'no-store, max-age=0' },
    ),
  );

  // Final fallback — registered last in `host-handler.ts`, so `/api/*`,
  // `/internal/docs/*`, `/wiki`, `/drizzle-studio` and the cross-app proxies
  // have all already terminated before a request reaches here.
  routes.get('*', async (c) => {
    const pathname = decodeURI(new URL(c.req.url).pathname);
    const rel = pathname.replace(/^\/+/, '');

    // (1) Extension'd path → static asset from dist/. Miss = real 404.
    if (rel && extname(rel)) {
      const abs = safeDistPath(rel);
      if (abs && existsSync(abs) && statSync(abs).isFile()) {
        return serveFile(
          abs,
          200,
          isImmutableSpaAssetPath(rel) ? IMMUTABLE_CACHE_CONTROL : undefined,
        );
      }
      return new Response('Not found', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    // (2) Extensionless → SPA shell. Client router (TSR) owns the route,
    //     including its own not-found component, so this is always 200.
    const indexPath = join(SPA_DIST_ROOT, 'index.html');
    if (existsSync(indexPath)) {
      return serveIndexHtml(indexPath, c.req.raw, hostedControlPlaneWorkspaceId);
    }

    // No bundle. If the last build FAILED, say that — and do NOT prescribe the
    // build, because that is the command that failed (EI-10539). Otherwise
    // (never built) the build advice is right and stands.
    return new Response(describeMissingBundle(SPA_DIST_ROOT), {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  });
  return routes;
}

/** Local/desktop SPA behavior retained as the default profile. */
export const spaRoutes = createSpaRoutes();
