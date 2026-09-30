import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import { resolve } from 'node:path';
import { isDesktopHmrEnabled, NO_VITE_CLIENT_BODY, shouldServeNoopViteClient } from './dev-mode';
import { devDistPrunePlugin, shouldRetainDistChunks } from './dev-dist-prune';
import { distAtomicWritesPlugin } from './dist-atomic-writes';
import { distWipeGuardPlugin } from './dist-wipe-guard';
import { flagsBootstrapPlugin } from './flags-bootstrap';
import { watchHeartbeatPlugin } from './watch-heartbeat';
import { tanstackLazyRetryPlugin } from './tanstack-lazy-retry';
import { createDevWatchIgnore } from './dev-watch-ignore';
import {
  filterInitialModulePreloadDependencies,
  stripNonCriticalLazyStylesheetsFromInitialHtml,
} from './build-preload-policy';
// P-006: the destination invariant as a POLICY (the prevention leg), kept in one
// place so the dev server, the SPA host and the desktop cannot drift apart.
import { cspHeaders, crossOriginIsolationHeaders } from '../../libs/generic/desktop-ipc/src/csp-policy';

// Operator SPA — Vite dev server. Takes over :3055 (was `next dev`).
// The API + internal docs are served by the @hono/node-server host on
// :3070 (Phase C); in dev, Vite proxies to it. Single static proxy —
// the backend endpoint-route migration shipped, so there is no
// per-prefix split and no Next sidecar. See
// apps/operator/docs/plans/operator-vite-migration-2026-05-20.md.
const operatorRoot = resolve(import.meta.dirname, '../operator');

const enableHmr = isDesktopHmrEnabled(process.env);

// Every fleet edit rebuilds `dist/`. With Vite's default emptyOutDir each
// rebuild DELETES the prior hashed chunks, so a long-open Tauri webview 404s its
// lazy imports ("Importing a module script failed" → dead error screen). We
// therefore RETAIN old chunks (emptyOutDir:false) and prune them by age instead
// (devDistPrunePlugin). Retention is the DEFAULT for every build; only an
// explicit PAPERCUSP_RETAIN_DIST_CHUNKS=0 opts out (and never for a --watch).
// This was an opt-IN until 2026-07-26 and NOTHING in the repo ever set the flag,
// so the cure shipped switched-off and the bug kept firing — see
// shouldRetainDistChunks() in dev-dist-prune.ts for the full reasoning. Plans:
// `adv-build-churn-retain-chunks-2026-06-03`, WI-1484,
// `dist-chunk-retention-default-2026-07-26` (D-001).
const retainDistChunks = shouldRetainDistChunks(process.argv, process.env);

// EI-10539: a clean-empty build is STAGED — bin/vite-build-singleflight points
// us at `dist.next/` and renames it over `dist/` only if we exit 0, so a build
// that dies AFTER vite's renderStart hook has already emptied outDir (a missing
// named export does exactly that — it killed the owner's desktop on 2026-07-12)
// can no longer destroy the bundle that is serving. Absent the env we build
// straight into `dist/` exactly as before, so a bare `npx vite build` still works.
const stagedOutDir = process.env.PAPERCUSP_VITE_OUT_DIR;
// The dist/ the staged build will be SWAPPED onto. The swap yanks an open
// webview's hashed chunks just as an in-place empty would, so the dist-wipe
// guard must judge the FINAL path, not the staging dir it never sees.
const finalOutDir = process.env.PAPERCUSP_VITE_FINAL_OUT_DIR;

// Operator API host the dev server proxies to. Overridable so an e2e rig can
// target the staging operator (:3170) — see the proxy block below.
const apiTarget = process.env.PAPERCUSP_API_TARGET ?? 'http://127.0.0.1:3070';

// WI-5502 item 2: Vite/rolldown's default `build.modulePreload` behavior walks
// each entry's full STATIC-import dependency graph to decide what to preload
// for the initial `index.html`, and it can hoist a chunk into that eager list
// even when the ONLY path that reaches it in the running app is a runtime
// dynamic import() — e.g. a `React.lazy` pane behind a closed-by-default UI
// state, or a route nobody has navigated to yet. Confirmed against a fresh
// operator-vite dist build (2026-09-03): these named route/panel chunks are
// genuinely lazy at the source level (TanStack Router's autoCodeSplitting /
// explicit React.lazy) yet still shipped as
// `<link rel="modulepreload"|"stylesheet">` on EVERY first paint regardless
// of route or panel state — 10 chunks, none on the always-rendered chrome's
// critical path. (Ruled out as an alternative cause: `main.tsx`'s
// `defaultPreload: 'intent'` is a DIFFERENT, runtime-only TanStack Router
// hover-preload mechanism — it cannot produce a build-time HTML preload link.
// Full investigation: WI-5502 thread.)
const noViteClientPlugin: Plugin = {
  name: 'papercusp-no-vite-client',
  configureServer(server) {
    if (enableHmr) return;
    server.middlewares.use((req, res, next) => {
      if (!shouldServeNoopViteClient(req.url, enableHmr)) {
        next();
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/javascript');
      res.end(NO_VITE_CLIENT_BODY);
    });
  },
};

// Vite's modulePreload hook filters only JS dependencies. Its HTML builder
// separately injects CSS gathered from the entry's imported chunk graph, so a
// post transform is required to keep the same known-lazy stylesheets off the
// initial document. The dynamic import() dependency map keeps those CSS files,
// preserving on-demand route/pane loading; see build-preload-policy.ts.
const initialLazyStylesheetFilterPlugin: Plugin = {
  name: 'papercusp-initial-lazy-stylesheet-filter',
  apply: 'build',
  transformIndexHtml: {
    order: 'post',
    handler: stripNonCriticalLazyStylesheetsFromInitialHtml,
  },
};

// flagsBootstrapPlugin (./flags-bootstrap) seeds dev-server flags. It is
// `apply: 'serve'`, so a built index.html carries no seed (WI-10004079).

export default defineConfig({
  // Static assets (wordmark.svg, mascot.svg, the Oracle/header icons,
  // onnx/wasm voice models, …) live in the operator's own `public/`.
  // operator-vite has no `public/` of its own, so point Vite's
  // publicDir there — otherwise `/wordmark.svg` & co. fall through to
  // the SPA-fallback index.html and render as broken images.
  publicDir: resolve(operatorRoot, 'public'),

  // EI-22037046116395640: a long-open portal embed can request an optimized
  // dependency with the browser hash from before Vite regenerated its dep cache.
  // Vite otherwise answers that stale request with 504 "Outdated Optimize Dep",
  // which leaves the route blank until a manual reload. Keep the stale module
  // usable while the optimizer settles; the next request receives the current
  // optimized copy.
  optimizeDeps: {
    ignoreOutdatedRequests: true,
  },

  // The Vite app imports operator components from `apps/operator/app/**`
  // in place. The operator's `@/*` tsconfig path maps to `apps/operator/*`;
  // mirror it here. (The former `next/{navigation,link,dynamic}` +
  // `@bprogress/next` aliases are gone — those imports were rewritten to
  // `@/lib/router-compat/*` and `@bprogress/react`; see plan
  // `finish-next-removal-2026-06-01`.)
  resolve: {
    alias: [
      // operator-core (headless backend) — carved from apps/operator (SP1 C4).
      // Must precede the '@' alias (first match wins).
      { find: '@papercusp/operator-core', replacement: resolve(operatorRoot, '../../packages/operator-core') },
      // Client-reachable operator-core modules import the coordination event-log
      // barrel for DEFAULT_COORD_WORKSPACE. The real barrel also exports its
      // Postgres + filesystem backends, pulling node:fs into the SPA graph.
      {
        find: '@papercusp/coordination/event-log',
        replacement: resolve(import.meta.dirname, 'src/shims/coordination-event-log-browser.ts'),
      },
      {
        find: /^posthog-node(?:\/.*)?$/,
        replacement: resolve(import.meta.dirname, 'src/shims/posthog-node-browser.ts'),
      },
      // The browser bundle may import server modules through the generated
      // route tree; postgres-js touches Buffer at module eval and blanks the SPA.
      { find: /^postgres(?:\/.*)?$/, replacement: resolve(import.meta.dirname, 'src/shims/postgres-browser.ts') },
      // @dbos-inc/dbos-sdk is server-only; its telemetry CJS requires
      // winston-transport at module scope, which only resolves by accident on
      // hosts with a stray $HOME/node_modules (broke the macOS build VM).
      { find: /^@dbos-inc\/dbos-sdk(?:\/.*)?$/, replacement: resolve(import.meta.dirname, 'src/shims/dbos-browser.ts') },
      // Server-only P2P substrate networking (corestore/hyperswarm/hyperdht/
      // hyperbee/hypercore/udx-native → sodium-universal → the native
      // sodium-native addon). Reachable through the route-tree import graph via
      // operator-core backend modules (work-items, issues-engineer,
      // orchestrator/*, hive-*, sync/hyperbee/*) but tree-shaken out of the
      // browser bundle; Rolldown still hard-fails resolving the native deps
      // during its scan. Shim them out — the SPA never runs substrate code.
      // (compact-encoding/protomux/b4a are pure-JS browser-safe — NOT shimmed.)
      {
        find: /^(corestore|hyperswarm|hyperdht|hyperbee|hypercore|hypercore-crypto|sodium-universal|sodium-native|sodium-secretstream|udx-native|dht-rpc|blind-relay)(?:\/.*)?$/,
        replacement: resolve(import.meta.dirname, 'src/shims/substrate-browser.ts'),
      },
      // node:module has NO browser polyfill (unlike path/url/fs/buffer/process), so Vite
      // externalizes it → `createRequire` is undefined. An eager
      // `const require = createRequire(import.meta.url)` at module scope in any
      // route-tree-reachable backend module (connection.ts, plugin-host-runtime, …) then
      // crashed the WHOLE desktop app at module-eval ("createRequire is not a function").
      // Shim node:module so createRequire EXISTS (no-op) in the browser; the require it
      // returns throws only if called, which never happens in the SPA.
      { find: /^node:module$/, replacement: resolve(import.meta.dirname, 'src/shims/node-module-browser.ts') },
      { find: /^node:async_hooks$/, replacement: resolve(import.meta.dirname, 'src/shims/async-hooks-browser.ts') },
      // node:worker_threads: tooldef's run-script.ts lazily loads it for server-only
      // script-orchestration (`await import`, never a static top-level import — see
      // browser-safe-barrel.test.ts). The dynamic-import TARGET still gets resolved
      // by Rolldown, which is the last externalized-warnings holdout (WI-4518).
      { find: /^node:worker_threads$/, replacement: resolve(import.meta.dirname, 'src/shims/node-worker-threads-browser.ts') },
      // Server-only test-infra native addons: testcontainers → dockerode /
      // ssh-remote-port-forward → ssh2 → cpu-features. ssh2 + cpu-features each
      // require() a native `.node` binary at module scope, which Rolldown
      // HARD-FAILS to resolve during its full-graph scan (even though the whole
      // subtree is tree-shaken out of the SPA) — this was failing the
      // operator-vite build and freezing every deploy at green-checkpoint.
      // Shim the two native packages; the pure-JS layers above them externalize
      // cleanly. The SPA never runs Docker/SSH test-container code.
      { find: /^(ssh2|cpu-features)(?:\/.*)?$/, replacement: resolve(import.meta.dirname, 'src/shims/testcontainers-native-browser.ts') },
      // undici is server-only; reachable via inference-gateway/*'s lazy
      // `await import('undici')` egress-dispatcher plumbing. Rolldown still
      // resolves the dynamic-import target to emit a chunk even though the SPA
      // never calls it, dragging ~20 transitive node:* modules into the
      // externalized-warnings count (WI-4518). Shim it out; server/test
      // consumers import the real package untouched.
      { find: /^undici(?:\/.*)?$/, replacement: resolve(import.meta.dirname, 'src/shims/undici-browser.ts') },
      // EI-13213: `commands/defs/delegation.ts`'s `delegates.*` handlers only
      // reach `../../delegated-tasks` behind `if (typeof window !== 'undefined')
      // { ...fetch...; return; }` — a RUNTIME guard Rolldown can't see, so it
      // still traces the dynamic import() target statically. delegated-tasks.ts
      // in turn statically imports work-items.ts, which fans out into dbos/*,
      // sync/hyperbee/*, and the whole ~550-tool agent-tools/index.ts catalog —
      // all reachable-but-dead server code no browser code path ever executes,
      // and that competing static edge is exactly what Rollup flags as
      // INEFFECTIVE_DYNAMIC_IMPORT for work-items.ts/boot-all.ts/
      // account-pool-store.ts. Shim just this one entry point; the real module
      // is untouched for server/test consumers (this alias only applies inside
      // the operator-vite Vite build).
      {
        find: /^\.\.\/\.\.\/delegated-tasks$/,
        replacement: resolve(import.meta.dirname, 'src/shims/delegated-tasks-browser.ts'),
      },
      { find: '@', replacement: operatorRoot },
    ],
    // Operator components and the Vite shell must share ONE React
    // instance — two copies would break hooks ("invalid hook call").
    dedupe: ['react', 'react-dom'],
  },
  build: {
    // Staged (EI-10539) when the singleflight script asks for it; otherwise the
    // default `dist`. Emptying is safe here BECAUSE it is the staging dir.
    ...(stagedOutDir ? { outDir: stagedOutDir } : {}),
    // Retain old hashed chunks across a retain-regime rebuild so an open webview
    // never 404s a lazy import; a release/CI `build` (no --watch, no retain env)
    // still empties for a clean bundle. The prune plugin (below) caps growth.
    emptyOutDir: !retainDistChunks,
    // MUST stay 'esbuild'. Vite 8 is rolldown-backed, and rolldown's DEFAULT
    // minifier emits a bundle in which a component reference mangles to
    // `undefined` — every route then dies at render with React #306 ("Element
    // type is invalid ... but got: undefined"), taking the whole chrome subtree
    // (ChromeShell + EnvSwitcherBar) with it. The dev server never sees it
    // (unbundled module-per-file), so it only breaks the BUILT app — i.e. the
    // shipped desktop artifact, while :3055 looks healthy.
    //
    // Isolated 2026-07-19 by a three-way build of identical source:
    //   default (rolldown)  -> React #306 on every route, blank/error app
    //   --minify false      -> renders correctly
    //   --minify esbuild    -> renders correctly, and still minified
    // Do not drop this to "take the default" without re-running that comparison.
    minify: 'esbuild',
    // EI-13210: `build.minify` above governs JS minification only. Vite's CSS
    // minifier is a SEPARATE setting (`build.cssMinify`) that does NOT inherit
    // the literal 'esbuild' string above — its default is
    // `cssMinify ?? !!build.minify`, and `!!'esbuild'` is just `true`, which
    // Vite resolves to **lightningcss**, not esbuild. lightningcss (current
    // latest, 1.32.0) doesn't recognize the standards-track CSS Custom
    // Highlight API's `::highlight()` pseudo-element and warns on every
    // occurrence during minification (harmless — errorRecovery still emits
    // the selector correctly, but the noise drowns real warnings). Pin CSS
    // minification to esbuild explicitly, which handles `::highlight()`
    // cleanly with zero warnings (verified directly against esbuild's CSS
    // transform) — this also keeps JS and CSS minification on the same
    // toolchain, avoiding a second one for no benefit.
    cssMinify: 'esbuild',
    // WI-5502 item 2: strip the named lazy route/panel chunks (see
    // EAGER_ROUTE_CHUNK_PRELOAD_EXCLUDE_RE above) out of the INITIAL
    // index.html preload list only. `hostType` distinguishes the two call
    // sites Vite uses this hook for: 'html' is the entry's eager
    // <link rel="modulepreload"|"stylesheet"> list injected into index.html
    // (what this fix targets); 'js' is the runtime modulePreload-polyfill's
    // per-dynamic-import dependency map, fired only when the app actually
    // import()s one of these chunks (route navigation / opening a lazy
    // panel) — left untouched, so on-demand loading and correctness are
    // unaffected. This must be verified with a real dist build + a live
    // network waterfall (see the WI-5502 thread for the verification
    // recipe) before being trusted, not assumed from the Vite docs alone —
    // this file already documents three other Vite-8/rolldown default-
    // behavior divergences from classic Rollup.
    modulePreload: {
      resolveDependencies: (_filename, deps, { hostType }) => {
        if (hostType !== 'html') return deps;
        return filterInitialModulePreloadDependencies(deps);
      },
    },
    rollupOptions: {
      output: {
        // P-046 / D-178: content hashes MUST NOT use the base64url alphabet.
        //
        // Rollup's default `[hash]` alphabet is base64url, which includes `-`
        // and `_`. Both are regex WORD-BOUNDARY characters, so a hash like
        // `owner-w_hC` puts `\b`-delimited tokens inside a filename that nothing
        // semantic ever produced. The release identity audit
        // (papercusp-desktop/bin/audit-release-bundle.py) word-boundaries short
        // owner-name literals precisely so it does not fire on substrings —
        // `\bAvi\b` — and that correct rule then matches
        // `spa/assets/factor-aVI-w_hC.js` for real, red-ing the release gate on
        // a filename that carries no identity at all.
        //
        // This is not rare. Measured over 300 generated chunks on rollup 4.60.2:
        //   DEFAULT (base64) -> 64/300 hashes contain `-` or `_`  (21.3%)
        //   hashCharacters: 'hex' -> 0/300
        // so ~1 chunk in 5 is a chance for any short owner token to collide.
        //
        // Fixing it HERE rather than in the auditor is deliberate: the audit rule
        // is behaving correctly and must not be weakened to let a bundle through
        // (D-172 / D-174 / D-175). A hex alphabet ([0-9a-f]) cannot contain a
        // word-boundary character, so the whole false-positive class disappears
        // at the source. Hash strength is unchanged — same digest, wider encoding.
        //
        // ⚠ This is a ROLLUP option. Vite 7 is rollup-backed, but Vite 8 is
        // rolldown-backed and rolldown does not expose `hashCharacters`; if this
        // app moves to Vite 8, re-establish the guarantee before assuming it holds
        // (the symptom is a release-gate identity red on an asset filename).
        hashCharacters: 'hex',
      },
    },
  },
  server: {
    // EI-18739245749680446: apps/operator/playwright.config.ts reads OPERATOR_E2E_PORT
    // to build its baseURL/webServer.url for an isolated e2e run (default 3055, same as
    // here), and spreads process.env into the spawned webServer's env — but this file
    // used to hardcode 3055 unconditionally, so the spawned vite NEVER honored a
    // non-default OPERATOR_E2E_PORT: Playwright polled the port IT built while vite kept
    // binding 3055, and on this box 3055 is permanently held by the standing
    // papercup-vite.service, so an isolated run either collided or timed out waiting on
    // a port nothing bound. PORT is also honored as the more generic fallback (both
    // unset ⇒ unchanged default 3055 for every existing caller — Tauri desktop, the
    // standing systemd service, bin/dev).
    //
    // ⚠ EI-19424980348813193 — IF YOU SPAWN VITE AS A CHILD, SCRUB `PORT` FIRST.
    // "both unset" holds for a human shell; it does NOT hold for a child of a service.
    // `PORT` is the most ambient variable name there is, and in a papercusp operator it
    // already means "the port I myself listen on" (env-operator-launcher's
    // defaultSelfPort() reads `PAPERCUSP_HONO_PORT ?? PORT`). A spawner that inherits its
    // own env therefore hands this line the OPERATOR's port, and the SPA silently binds
    // there instead of 3055 — or, on collision and without `--strictPort`, WALKS to the
    // next free port and serves happily somewhere nobody is looking. That is not a
    // hypothetical: the packaged mac `local` env operator bound :3071, served HTTP 200
    // for 26+ minutes, and was filed as a 26-minute HANG because every probe asked :3055.
    // Spawners must pass `--port <p> --strictPort` AND delete PORT/OPERATOR_E2E_PORT —
    // see viteChildArgv/viteChildEnv in packages/operator-core/lib/harness/
    // env-operator-launcher.ts, whose tests re-evaluate THIS expression to police it.
    port: Number(process.env.OPERATOR_E2E_PORT ?? process.env.PORT) || 3055,
    host: process.env.PAPERCUSP_BIND_HOST ?? '127.0.0.1',
    // P-006: report-only CSP expressing the destination invariant. REPORT-ONLY
    // never blocks anything, so this cannot break the app — it makes the browser
    // itself a second egress sensor, with different blind spots from resource
    // timing (it sees a fetch the monitor's ring buffer has evicted, and a
    // request blocked before it ever reaches the network stack).
    //
    // Applied to every dev-server response rather than just the document. A CSP
    // on a .js/.css response is simply ignored by the browser, so the broader
    // application is harmless and avoids having to special-case the SPA shell.
    //
    // P-005 (WI-4498): cross-origin isolation headers too, applied to every
    // response for the same "harmless off-document" reason — COOP/COEP are
    // ignored by the browser on anything but the document response, and this
    // dev server serves every asset same-origin (see crossOriginIsolationHeaders()).
    headers: { ...cspHeaders(), ...crossOriginIsolationHeaders() },
    // CORS policy for /api belongs to the Hono host (:3070) — its middleware
    // allows `last-event-id` etc. and echoes the origin. Vite's own default
    // CORS middleware answers OPTIONS preflights BEFORE the proxy with a
    // conflicting policy (no allow-origin for non-localhost origins), so any
    // preflighted /api request (e.g. a fetch with a Last-Event-ID header from
    // a non-localhost origin) fails with TypeError while the same simple GET
    // proxies fine. Disable it; preflights then reach the API host that owns
    // the policy.
    cors: false,
    // The Tauri shell is the product surface, and this checkout is edited by
    // multiple agents at once. Vite HMR/full-reload traffic makes the desktop
    // look like it is constantly refreshing while unrelated files are saved.
    // Default to manual refresh; opt in with PAPERCUSP_ENABLE_HMR=1 when an
    // engineer explicitly wants hot module replacement for a local UI tweak.
    hmr: enableHmr ? undefined : false,
    // WI-6539: don't burn inotify watches on build output, served-static docs,
    // and docs-swap leftovers. A COLD dev server here held 11,959 watches
    // against a 10,000 per-process budget — 91% of them on those three
    // categories, only 9% on the actual module graph. This is a startup cost,
    // not drift: eleven days of uptime added just 3% more. See dev-watch-ignore.ts
    // for the measurement and why this is a predicate rather than glob strings.
    watch: { ignored: createDevWatchIgnore({ viteRoot: import.meta.dirname, operatorRoot }) },
    proxy: {
      // PAPERCUSP_API_TARGET points the /api proxy at a different operator —
      // e.g. the staging host (:3170) when an e2e rig must exercise staging-tree
      // server code instead of the green :3070 deployment. Default unchanged.
      '/api': { target: apiTarget, ws: true, changeOrigin: true },
      '/internal/docs': { target: apiTarget, changeOrigin: true },
      '/docs': { target: apiTarget, changeOrigin: true },
    },
  },
  plugins: [
    noViteClientPlugin,
    flagsBootstrapPlugin,
    initialLazyStylesheetFilterPlugin,
    // Route generation must run before the React plugin.
    tanstackRouter({
      target: 'react',
      routesDirectory: './src/routes',
      generatedRouteTree: './src/routeTree.gen.ts',
      // EI-13211: co-located *.test.ts(x) files live inside src/routes/** (e.g.
      // index.test.ts, login.test.tsx, harness/$.test.tsx) and don't export a
      // Route — every production build re-scanned and warned on each one. Skip
      // them at the generator level instead of the ignore-prefix-rename dance.
      routeFileIgnorePattern: '\\.test\\.tsx?$',
      // Automatic route code-splitting (perf: FCP). Without this, every route's
      // `component` (all 81 — admin, pi, gym, editors, dockview panes, …) is
      // statically imported into routeTree.gen.ts → the eager boot bundle
      // (~14MB raw across the entry + modulepreload graph), which is the ~2s
      // FCP. autoCodeSplitting moves each route's non-critical config
      // (component/errorComponent/notFoundComponent) into its own lazy chunk so
      // boot loads only the entry + the matched route; loaders stay critical so
      // data prefetch isn't delayed. See /internal/docs/performance + the E2E
      // perf sweep (2026-06-23). Measured: drops the eager src-* mega-chunks.
      autoCodeSplitting: true,
    }),
    // WI-2902: give the autoCodeSplitting route-component chunk loads the same
    // retry the React shell already has. Runs `post` (after the splitter's
    // `pre` transform) to rewrite the emitted `lazyRouteComponent` import to our
    // retry wrapper. Without this, a transient chunk-fetch failure on first boot
    // (operator event-loop starvation) dead-ends at the fatal route error card.
    tanstackLazyRetryPlugin(),
    react(),
    // Retain-regime builds retain+prune old chunks (emptyOutDir:false); a
    // clean-empty build (release/CI) instead gets the dist-wipe guard so it
    // can't wipe a LIVE watcher's :3170 dist out from under open webviews (the
    // 2026-06-29 blank-page incident). The guard only fires on a confirmed
    // same-dist live watcher and fails open otherwise, so it never wedges the
    // deploy pipeline. See dist-wipe-guard.ts.
    ...(retainDistChunks ? [devDistPrunePlugin()] : [distWipeGuardPlugin({ outDir: finalOutDir })]),
    // Retention stops rebuilds DELETING old chunks; this stops them CORRUPTING
    // current ones: an in-place rewrite of a same-hash asset is a non-atomic
    // truncate+write, and a webview fetching that file mid-write reads a
    // truncated module ("Importing a module script failed" — the gym-tab outage,
    // 2026-07-26). Skip identical rewrites (mtime-bump instead, so the prune TTL
    // still sees them as current) and swap index.html atomically. No-op for a
    // clean-empty/staged build (nothing exists in the fresh outDir to skip).
    distAtomicWritesPlugin(),
    // EI-5202: stamp a heartbeat (build time + git SHA) after every `--watch`
    // rebuild, so a health probe can detect a wedged-but-running watcher
    // instead of the only signal being a manual dist/index.html mtime check.
    // No-op for a one-shot production/CI build. See watch-heartbeat.ts.
    watchHeartbeatPlugin(),
  ],
});
