import { createRootRoute, Outlet } from '@tanstack/react-router';
import { Suspense, useEffect, type ReactNode } from 'react';
// Boot-critical shell chunks (LeftSidebar, the dev rail) load via lazyWithRetry,
// not bare React.lazy: on the packaged WebKitGTK desktop a first-boot dynamic
// import can transiently fail while the self-hosting operator is busy, and bare
// lazy escalates that straight to the fatal route error boundary (WI-2902).
import { lazyWithRetry as lazy } from '@papercusp/operator-core/lib/lazy-with-retry';
import { Toaster } from 'sonner';
// Custom nuqs adapter (NOT nuqs/adapters/tanstack-router): the stock adapter
// rebuilds the URL from only nuqs-watched keys, dropping TanStack-native typed
// search params (?dock, ?switch) on every nuqs write. Ours merges over the full
// current search. See ../lib/nuqs-tanstack-router-adapter.
import { NuqsAdapter } from '../lib/nuqs-tanstack-router-adapter';
import * as Tooltip from '@radix-ui/react-tooltip';
import { RootSyncProvider } from '@/app/_components/RootSyncProvider';
import { OperatorConversationProvider } from '@/app/_components/OperatorConversationProvider';
import { PostHogProvider } from '@/app/_components/PostHogProvider';
import WslOnboardingGate from '@/app/_components/WslOnboardingGate';
import { useWslGateBlocking } from '@/app/_components/useWslGateBlocking';
import GlobalShortcutDispatcher from '@/app/_components/GlobalShortcutDispatcher';
import GlobalNavShortcuts from '@/app/_components/GlobalNavShortcuts';
import GlobalCommandPalette from '@/app/_components/GlobalCommandPalette';
import GlobalShortcutsHelp from '@/app/_components/GlobalShortcutsHelp';
import GlobalAppShortcuts from '@/app/_components/GlobalAppShortcuts';
import GlobalVoiceShortcuts from '@/app/_components/GlobalVoiceShortcuts';
import GlobalSearchDialog from '@/app/_components/GlobalSearchDialog';
import PresenceRail from '@/app/_components/PresenceRail';
// Side effect: register the browser voice controls into operator-core's
// voice-control bridge so voice.* commands reach the UI voice engine without a
// core→@/app back-edge (operator-core stays headless/UI-free).
import '@/lib/commands/voice-controls-entry';
import GlobalFindInPage from '@/app/_components/GlobalFindInPage';
import RouteTransitionProvider from '@/app/_components/RouteTransitionProvider';
import ExternalLinkProvider from '@/app/_components/ExternalLinkProvider';
import { ToasterSelectionFix } from '@/app/_components/ToasterSelectionFix';
import { ToastHistoryRecorder } from '@/app/_components/ToastHistoryRecorder';
import { PotThemeBridge } from '@/app/_components/PotThemeBridge';
import DesktopAttentionNotifier from '@/app/_components/DesktopAttentionNotifier';
import DesktopConsoleLaunchBridge from '@/app/_components/DesktopConsoleLaunchBridge';
import FlagStreamSubscriber from '@/app/_components/FlagStreamSubscriber';
import TerminalDivider from '@/app/_components/TerminalDivider';
import NativeTerminalGate from '@/app/_components/NativeTerminalGate';
import { UiPresenceProvider } from '@/app/_components/UiPresenceProvider';
import DevReloadGate from '@/app/_components/DevReloadGate';
// EI-15848: the counterpart to DevReloadGate. That one suppresses auto-reloads
// so concurrent saves cannot keep the page half-mounted; this one tells the
// user when a reload has actually become worth doing, so a window can no longer
// silently serve a stale bundle.
import BundleFreshnessNotice from '../components/BundleFreshnessNotice';
import PerfObserverProvider from '@/app/admin/testing/_components/PerfObserverProvider';
// Universal in-app perf-recorder host (channel/storage-compatible with the
// operator's _lib — same CHANNEL_NAME + localStorage key). Activates only when
// ?perf-recorder=1 is set (the chaos-desktop recorder window). Phase 6 of
// universal-testing-domains-generic-2026-06-03.
import { RecorderHost } from '@papercusp/testing-shell';
import { FLAGS } from '@papercusp/flags';
import { useFlag } from '@papercusp/flags/client';
import ChromeShellWithChatFaces from '../components/chat-faces/ChatFacesHost';
import LeftSidebar from '../components/left-sidebar/LeftSidebar';
import ChatRefPopupHost from '@/app/_components/chat/ChatRefPopupHost';
import RoutedPlanDashboardHost from '../components/RoutedPlanDashboardHost';
import PlanCleanupReportHost from '@/app/_components/plans/PlanCleanupReportHost';
import InboxBulkReportHost from '@/app/_components/inbox/InboxBulkReportHost';
import { usePathname, useSearchParams } from '@/lib/router-compat/navigation';
import { isChromelessPath, isPortalEmbedLocation, routeHasSteeringSidebar } from '@papercusp/operator-core/lib/chromeless-routes';
import { PortalEmbedThemeBridge } from '@/app/_components/PortalEmbedThemeBridge';
// Slim top progress bar for the "Papercusp dogfood hive clone-on-first-boot"
// (desktop UI part A). Mounted here — inside RootSyncProvider, at the router
// root — so it can read the `hiveFromRepo.progress` sync rows and overlay EVERY
// route (it self-hides when the flow is ready / has no rows). Non-blocking:
// position:fixed at the top, routes scroll underneath.
import { DogfoodBootstrapBanner } from '@/app/_components/DogfoodBootstrapBanner';
import { ProgressProvider } from '@bprogress/react';
import NotFound from '../components/NotFound';
import { NavigationProgress } from '../components/NavigationProgress';
import ChunkReloadPrompt from '../components/ChunkReloadPrompt';
import OfflineIndicator from '../components/OfflineIndicator';
import ServerConnectionGate from '../components/ServerConnectionGate';
import StaleOperatorIndicator from '../components/StaleOperatorIndicator';
import VersionBadge from '../components/VersionBadge';
// Cross-platform env switcher top bar (dogfood-silent-canonical-hive-join P-013/P-014/
// P-017). The data-driven, public-shippable twin of the Linux-only native GTK dev bar;
// ungated (P-013) but self-hides unless ≥2 envs are reachable.
import EnvSwitcherBar from '../components/env-switcher/EnvSwitcherBar';
import RouteErrorBoundary from '../components/RouteErrorBoundary';
import '@/app/globals.css';
// App-wide command-palette chrome (⌘K / Ctrl+P). The palette markup uses
// `.h-cmd*` classes that used to live in harness.css; they now live here.
import '@/app/command-palette.css';
// App-wide find-in-page (Ctrl/⌘+F): the ::highlight() rules for the CSS
// Custom Highlight API + the `.pc-find*` find-bar chrome.
import '@/app/find-in-page.css';
// Harness panel styles (the `h-*` classes). The legacy /harness page loaded
// these via HarnessDashboard; now that /adv tabs render harness panel
// components directly (prs/settings/insights — see
// AdvHarnessPanelPage), the shell must load the stylesheet so those panels
// keep their styling without mounting the whole dashboard.
import '@/app/harness/harness.css';

/**
 * Root route — the app shell for the Vite SPA at
 * `apps/operator-vite/src/routes/__root.tsx`. It supersedes the retired Next
 * layout (Phase A3 of the operator-vite migration).
 *
 * INVARIANT (host-architecture Phase 1): the IPC polyfill that installs
 * `window.EventSource = IpcEventSource` / `window.fetch = ipcFetch` runs
 * inside `RootSyncProvider` (via `installDesktopIpcPolyfills`) and must run
 * before any provider that opens a transport — that ordering is preserved
 * by keeping `RootSyncProvider` outermost of the data-layer providers.
 *
 * There is no `QueryClientProvider` — react-query is a `libs/sync` internal,
 * not an app-wide provider. Do not add one here.
 *
 * DEFERRED (need `next/navigation` → TanStack Router translation; Phase B/D):
 *   - `ChromeShell`         — header + sidebars; renders around `<Outlet/>`.
 *   - `RouteProgressProvider` — top-of-page progress bar (Phase B6, the
 *     `@bprogress/next` → `@bprogress/react` adapter).
 * Both are the only two layout-level components that import `next/*`; the
 * other 12 are translated here unchanged.
 *
 * NOT YET PORTED (Phase D/E — no SSR in a Vite SPA):
 *   - `await getAllFlags()` SSR flag resolution → `window.__PAPERCUSP_FLAGS__`.
 *     Until ported, flag-gated UI falls back to its default branch.
 *
 * PORTED to `apps/operator-vite/index.html` (the pre-paint `<head>`/body-start
 * bootstraps that the legacy Next layout provided; each is client-rendered-SPA-safe
 * and reads the same wsLocalKey-scoped keys the React libs use):
 *   - Color theme — `data-theme` + cached custom-theme CSS.
 *   - Visual-effects mode — `data-visual-effects` / `data-visual-effects-mode`.
 *   - Op-chat width — was ported as a body-start script + a `<head>`
 *     `<style id="op-chat-width-reserve">`, then REMOVED again (D-017):
 *     flags are unknowable pre-paint, so the revived OperatorChatSidebar
 *     reserves its own space at mount instead (see the index.html comment +
 *     index-html-no-op-chat-reservation.test.ts).
 */
// Dev admin rail (plan dev-admin-sidebar-2026-06-05; RUNTIME gate added by
// desktop-build-switcher-wrapper-2026-06-09 P-007 / D-004). Two ways in:
//
//   - `MODE !== 'production'` — both dev shells (the nohmr `vite build
//     --watch --mode development` and the :3055 HMR serve), as before.
//     (Why MODE, not `import.meta.env.DEV`: Vite ties DEV/PROD to the
//     COMMAND — `vite` serve vs `vite build` — NOT to `--mode`, so the
//     nohmr BUILD has DEV===false and a DEV gate would hide the rail in
//     the desktop.)
//   - `window.__PAPERCUSP_DEV_WRAPPER__` — a document-start user script the
//     desktop's dev wrapper injects on EVERY navigation (papercusp-desktop
//     src-tauri/src/dev_wrapper.rs), so the rail is present on ANY build
//     the wrapper's switcher shows — the production :3070 green build
//     included. Document-start runs before any module here, so reading it
//     at module scope is safe. The signal is compiled out of real-
//     production desktop builds (`dev-wrapper` Cargo feature, D-005), so a
//     shipped build can never flip it.
//
// Consequence vs the old build-time-only gate: the rail's lazy chunk is now
// EMITTED by a production `vite build` (the ternary is no longer statically
// false), but it is FETCHED only when the gate is true at runtime — a real
// production run (no wrapper, MODE==='production') never loads it.
const DevAdminRail =
  import.meta.env.MODE !== 'production' ||
  (typeof window !== 'undefined' &&
    (window as { __PAPERCUSP_DEV_WRAPPER__?: boolean }).__PAPERCUSP_DEV_WRAPPER__ === true)
    ? lazy(() => import('../components/dev-admin-rail/DevAdminRail'))
    : null;

// Left sidebar (left-sidebar-tauri-2026-06-07) — first-class app chrome, not a
// deferred panel. Its shell is eager so the first React commit reserves the
// rail's width; the individual tab bodies remain lazy inside LeftSidebar.
// Deferring this shell produced a deterministic 0.714 CLS on the hosted portal.
// NOTE: the operator-voice controls (PapercupVoiceBar) used to mount here as a
// top strip; they now live at the TOP of the left rail (LeftSidebar), always
// visible on every tab (owner request 2026-06-22).

export const Route = createRootRoute({
  component: RootComponent,
  notFoundComponent: NotFound,
});

function TestingRouteTransition({ children }: { children: ReactNode }) {
  const testingEnabled = useFlag(FLAGS.TESTING);
  if (!testingEnabled) return <>{children}</>;
  return <RouteTransitionProvider>{children}</RouteTransitionProvider>;
}

function RootComponent() {
  // Dev shells only (same gate as DevAdminRail): force the lazy voice-mode chunk
  // to evaluate at startup so its agent-e2e test seam (window.__pcVoiceTest) is
  // available without a prior voice interaction (sentinel-tui-shared-backend §3).
  // Real production (no wrapper, MODE==='production') leaves voice-mode lazy.
  useEffect(() => {
    if (!DevAdminRail) return;
    void import('@/app/_components/voice/voice-mode');
  }, []);

  // Chromeless routes (the Quick Panel popup, iframe/embedded targets) render
  // the bare route with NO global chrome — no env bar, ChromeShell header+chat,
  // or presence rail. Providers still wrap <Outlet/> (the panel uses sync +
  // nuqs); only the VISIBLE chrome is gated. See lib/chromeless-routes.
  const pathname = usePathname() ?? '';
  const searchParams = useSearchParams();
  const chromeless = isChromelessPath(pathname);
  const portalEmbed = isPortalEmbedLocation(pathname, searchParams.toString());

  // WI-2749 item #2: LeftSidebar (z-index 1290) and PresenceRail (z-index
  // 900) are position:fixed siblings mounted BEFORE <WslOnboardingGate> in
  // this tree, so they render OVER the gate's zIndex:60 overlay during
  // Windows WSL onboarding — real bleed-through, not a DOM/innerText
  // false-positive. Skip mounting them while the gate is blocking; see
  // useWslGateBlocking's doc comment for why this is read-only / cannot
  // duplicate the gate's own install/import/bootstrap side effects.
  const wslGateBlocking = useWslGateBlocking();

  return (
    <Tooltip.Provider delayDuration={150} skipDelayDuration={300}>
      <RootSyncProvider>
        <GlobalShortcutDispatcher />
        {/* EI-2425 / SSE budget fix: listen for flag flips on the sync bus
            rather than opening a private EventSource (see
            FlagStreamSubscriber's own doc comment). Mounted app-wide, before
            any flag-gated chrome below. */}
        <FlagStreamSubscriber />
        {/* Dogfood clone-on-first-boot progress bar (desktop UI part A) — inside
            RootSyncProvider so it reads `hiveFromRepo.progress`; fixed at the top,
            overlays every route, self-hides when ready / no rows. */}
        <DogfoodBootstrapBanner />
        {/* B6 — navigation progress bar. ProgressProvider renders the bar
            DOM + supplies the useProgress context (shared with RouteLink
            et al. via the @bprogress/next alias shim); NavigationProgress
            drives it from TanStack Router's status. Settings mirror the
            Next operator's RouteProgressProvider. */}
        <ProgressProvider
          height="3px"
          color="#57d7ff"
          delay={80}
          stopDelay={120}
          startPosition={0.08}
          disableSameURL
          options={{ showSpinner: false }}
        >
          <NavigationProgress />
          <Suspense fallback={null}>
            <NuqsAdapter>
              <UiPresenceProvider />
              {/* Route EXTERNAL links (e.g. GitHub links in the Insights tab) to
                  the OS browser instead of navigating the Tauri webview away from
                  the SPA — a desktop window has no back button. No-op in a plain
                  browser (isTauri() false). App-wide, not per-link. */}
              <ExternalLinkProvider />
              {/* Cross-platform env switcher — the single env bar on every platform
                  (the Linux-only native GTK bar and the chrome-webview experiment were
                  both removed). It sources the canonical env list from the desktop/Tauri
                  side and never self-hides, so a misrouted /api or a bad target build can't
                  make it vanish; a native global-shortcut + menu backstop (papercusp-desktop
                  src-tauri) is the unkillable escape hatch if a target build white-screens. */}
              {!chromeless && !portalEmbed && <EnvSwitcherBar />}
              {/* App-wide keyboard surfaces — mounted at the router root,
                  above ChromeShell, so Ctrl+P (palette) and Alt+Left/Right
                  (history nav) work on EVERY route, including /settings and
                  the chromeless iframe targets ChromeShell itself skips. */}
              <GlobalNavShortcuts />
              <GlobalCommandPalette />
              <GlobalFindInPage />
              {/* Discord-parity shortcuts (discord-shortcuts 2026-06-06):
                  Mod+/ cheat-sheet, Mod+, settings, Mod+I inbox,
                  Mod+Shift+N create, Mod+Shift+M/D voice mute/deafen,
                  Mod+Shift+F global search, Mod+U live-agents rail. */}
              <GlobalShortcutsHelp />
              <GlobalAppShortcuts />
              <GlobalVoiceShortcuts />
              <GlobalSearchDialog />
              {!chromeless && !portalEmbed && !wslGateBlocking && <PresenceRail />}
              {/* Far-left steering/settings sidebar (D-009). Inside NuqsAdapter
                  (its open/tab/selection state is URL-backed) + RootSyncProvider
                  (its panels use useSyncQuery); docked via
                  body.has-left-sidebar. Papercup chat mounts after it as the
                  middle pane. A portal-embedded /adv is BARE (owner ask
                  2026-09-01): the cloud portal frames this rail and the chat as
                  its own outer sidebars via /portal-panes/*, so the predicate
                  reads the search too. Focused /plans and /inbox embeds
                  self-suppress because LeftSidebar treats chromeless routes as
                  bare documents. Skipped while the WSL onboarding gate is
                  blocking (WI-2749 item #2) — see useWslGateBlocking. */}
              {routeHasSteeringSidebar(pathname, searchParams.toString()) && !wslGateBlocking && (
                <Suspense fallback={null}>
                  <LeftSidebar />
                </Suspense>
              )}
              <TestingRouteTransition>
                <WslOnboardingGate>
                  <OperatorConversationProvider>
                    <PostHogProvider>
                      <PortalEmbedThemeBridge />
                      <PotThemeBridge />
                      {/* Global chrome — header/navbar, left operator-chat
                          sidebar, Oracle dock. Renders before <main>,
                          mirroring the Next operator's layout.tsx.
                          (Deferred in A3 because it imports next/navigation;
                          the alias shim now resolves that.) */}
                      {/* WI-5162: ChromeShell + the Fleet/Peers chat-sidebar
                          faces. Those panes live in THIS tree and the sidebar
                          cannot import up-layer to reach them, so the wrapper
                          composes them here and passes them down. */}
                      {!chromeless && <ChromeShellWithChatFaces />}
                      {/* WI-6601: the ONE mount of the chat ref-pill popups
                          (`wpop`/`wppop`). Deliberately OUTSIDE the
                          `!chromeless` gate — /quick-panel is chromeless, and
                          it is one of the surfaces whose drill-in wrote a
                          correct param that nothing rendered. Inside
                          NuqsAdapter because it reads query state; both popups
                          are lazy inside it, so no route pays for the plan
                          editor until a popup is actually open. */}
                      <ChatRefPopupHost />
                      {/* Programmatic focus fallback for URL-owned app-pane
                          takeovers whose opening strip/row disappears when a
                          run completes. -1 keeps the landmark out of the Tab
                          order while letting takeover cleanup avoid <body>. */}
                      <main data-route-transition-page="true" tabIndex={-1}>
                        {/* Route-content error boundary: keeps ChromeShell
                            mounted on a route crash (so the user can navigate
                            away), resets on navigation, and offers a working
                            reload. Without it, a route throw bubbled to
                            TanStack's bare root boundary and blanked the whole
                            shell — and because /adv is one route, one tab's
                            crash latched every tab. */}
                        <RouteErrorBoundary>
                          <Outlet />
                        </RouteErrorBoundary>
                        {/* plan-visibility-revamp-2026-08-23 P-003 (D-002):
                            the plan-dashboard app-pane takeover. A SIBLING of
                            the routed Outlet inside <main> (position:relative),
                            so `?pdash=<harness>::<slug>` overlays exactly the
                            app pane — full width — while the routed page stays
                            mounted underneath (back = clear the param, route
                            state intact). Opened by the op-chat plan sidebar's
                            row click (P-005); deep-linkable like any nuqs URL.
                            Route-aware (portal-work-two-pane-2026-09-01 D-001):
                            skipped on /plans, whose split PlansPane hosts the
                            dashboard in its own aside. */}
                        <RoutedPlanDashboardHost />
                        {/* cleanup-report-flows-2026-08-24 P-007: `?opcln=`
                            remains a strip deep link while the resolver runs,
                            then becomes the grouped report takeover at review. */}
                        <PlanCleanupReportHost />
                        {/* cleanup-report-flows-2026-08-24 P-008: `?opcbr=`
                            remains the Inbox strip's run deep link while the
                            resolver works, then becomes the grouped app-pane
                            takeover when the run reaches review. */}
                        <InboxBulkReportHost />
                      </main>
                    </PostHogProvider>
                  </OperatorConversationProvider>
                </WslOnboardingGate>
              </TestingRouteTransition>
              <Toaster
                theme="dark"
                position="top-right"
                richColors
                closeButton
                style={{ zIndex: 2147483646 }}
              />
              <ToasterSelectionFix />
              <ToastHistoryRecorder />
              {/* Desktop-native attention pushes (planning-attention-importance
                  P-020/D-007). Mounted in this Vite root because the desktop
                  renders THIS operator-vite SPA, so without it the
                  attention.notify SSE event reaches the webview but nothing
                  turns it into a sonner toast + native OS notification. */}
              <DesktopAttentionNotifier />
              {/* WI-3289: Windows agent console-launch bridge — relays
                  console.launch-request sync-bus events (capability:terminal /
                  fleet:launch-on-plan on a WSL2-hosted operator) to the Tauri
                  console_launch command. No-op outside the Tauri webview. */}
              <DesktopConsoleLaunchBridge />
              {/* WI-3388: the native terminal dock's draggable divider +
                  collapse-to-rail control. Lives entirely on the webview side
                  of the seam (the terminal itself is a native surface outside
                  this webview) — mounted at the router root so it's present
                  on every route. No-op outside Tauri / when no docked native
                  terminal backend is running / behind FLAGS.TERMINAL_DIVIDER. */}
              <TerminalDivider />
              {/* D-004 (operator-chat-sidebar-revival P-014): relays the
                  webview's resolved FLAGS.TESTING to Rust's
                  native_terminal_set_enabled — the ONLY spawn path for the
                  testing-gated native dock (Rust no longer spawns at boot).
                  Renders nothing; no-op outside Tauri. */}
              <NativeTerminalGate />
              <PerfObserverProvider />
              <RecorderHost />
              {/* Dev admin rail — collapsible right cockpit (flags / run /
                  health / deploy-state / db / fleet). Mounted inside NuqsAdapter
                  (its open/section state is nuqs-backed) + RootSyncProvider (its
                  glance panels use useSyncQuery). Runtime-gated (dev mode OR the
                  desktop dev wrapper's signal) — see the DevAdminRail const above. */}
              {DevAdminRail && !portalEmbed && (
                <Suspense fallback={null}>
                  <DevAdminRail />
                </Suspense>
              )}
              <DevReloadGate />
              <ChunkReloadPrompt />
              {/* Operator-unreachable persistent toast (EI-239) — fed by the
                  @papercusp/sync connectivity store. */}
              <OfflineIndicator />
              {/* P-007: the GUI ships no backend runtime. If Rust cannot find or
                  launch the separate Server product, show the explicit local
                  install/retry and remote/hosted connection routes. */}
              <ServerConnectionGate />
              {/* Version-skewed operator persistent toast (WI-5956) — fed by the
                  @papercusp/sync stale-operator store: the origin is reachable
                  but is running OLDER code than this rebuilt client. */}
              <StaleOperatorIndicator />
              {/* Bottom-right "what's running" pill + out-of-date detector:
                  polls /api/desktop/version and flips to an amber click-to-reload
                  when the server's sha changes under us (Restart-parity). */}
              <VersionBadge />
            </NuqsAdapter>
          </Suspense>
        </ProgressProvider>
      </RootSyncProvider>
    </Tooltip.Provider>
  );
}
