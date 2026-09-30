import { Component, useEffect, useState, type CSSProperties, type ErrorInfo, type ReactNode } from 'react';
import { useLocation } from '@tanstack/react-router';
import { hardReload } from '@papercusp/operator-core/lib/hard-reload';
import { CHUNK_LOAD_ERROR_RE } from '@papercusp/operator-core/lib/lazy-with-retry';
import { inDevBuildWatcherShell } from '../lib/dev-build-shell';
import { ErrorDetail } from './ErrorDetail';
import { reportRenderCrash } from '../lib/render-crash-report';

/**
 * Error boundary around the route content (`<Outlet/>`).
 *
 * Why this exists: a render error thrown by a route used to bubble to
 * TanStack's bare root "Something went wrong!" boundary, which replaced the
 * WHOLE shell (ChromeShell included) with a dead end — no reload, no way out.
 * And because `/adv` is a single route (its tabs are just `?tab=`), one tab's
 * throw latched the boundary for *every* tab.
 *
 * Wrapping just the Outlet (ChromeShell is a sibling, outside this boundary)
 * keeps the chrome mounted, and `resetKey` (the location) clears the error on
 * navigation — so changing `?tab=` escapes a crashed tab instead of staying
 * stuck. The fallback offers a WORKING reload: `hardReload()` bypasses the
 * desktop host's reload suppression, and the usual cause here is a stale
 * bundle after a ONE-SHOT dev rebuild (a gate run, a timer, `npm run build`)
 * swapped `dist/` underneath the page — NOT `vite build --watch`, which
 * retains old chunks specifically so this doesn't happen (EI-18694489428714850).
 */
interface Props {
  children: ReactNode;
  /** Changing this (the location) clears a caught error — escape-on-navigate. */
  resetKey: string;
}
interface State {
  error: Error | null;
  /** React component stack from componentDidCatch — names the component that
   *  threw (the console's "occurred in <X>"), shown in the detail pane. */
  componentStack: string | null;
  expanded: boolean;
  /** A delayed chunk self-retry is armed — the card says so instead of
   *  implying a human must click Reload. */
  autoRetryArmed: boolean;
}

/** The canonical chunk-load-error matcher (every engine's phrasing — WebKit
 *  "Importing a module script failed", Chromium/Firefox/webpack variants) lives
 *  in lazy-with-retry so the RETRY site and THIS boundary can never disagree
 *  about what counts as a (retryable / auto-reloadable) chunk failure. The old
 *  divergence — the retry helper's regex missed WebKit's phrasing while this one
 *  matched it — is exactly why transients escalated to this fatal card on the
 *  packaged desktop (WI-2902). Re-exported for this module's existing tests. */
export { CHUNK_LOAD_ERROR_RE };

/** The error-card explanatory copy, honest for the current shell: blame a
 *  dev-shell rebuild only in a dev shell; in the packaged app describe it as
 *  the transient load hiccup it actually is (WI-2902).
 *
 *  Deliberately does NOT say "the dev build watcher" (EI-18694489428714850):
 *  a real `vite build --watch` singleton RETAINS old chunks (emptyOutDir:false
 *  + age-prune) precisely so an open page keeps resolving them — the watcher
 *  is the one dev regime that does NOT cause this. The actual usual cause is a
 *  ONE-SHOT rebuild (a gate run, a timer, an agent typing `npm run build`)
 *  that swaps `dist/` out from under an already-open page. Blaming "the
 *  watcher" sent readers looking in the wrong place; keep this generic. */
function ErrorCardBody(): ReactNode {
  return inDevBuildWatcherShell() ? (
    <p style={BODY}>
      Often this just means the app was rebuilt underneath the page — a dev
      build ran and replaced part of the bundle, so an already-open view can no
      longer load part of itself. Reloading picks up the latest build. If it
      persists after a reload, it&rsquo;s a real bug; the details are below.
    </p>
  ) : (
    <p style={BODY}>
      This part of the app failed to load. It&rsquo;s usually a temporary hiccup
      while Papercusp is still starting up — reloading almost always fixes it. If
      it persists after a reload, it&rsquo;s a real bug; the details are below.
    </p>
  );
}
/** SessionStorage key holding the last chunk-auto-reload timestamp. SHARED by
 *  RouteErrorBoundary (Outlet) + DefaultRouterErrorComponent (root) so the two
 *  boundaries share ONE 60s debounce and can't double-reload. Exported for tests. */
export const CHUNK_AUTO_RELOAD_KEY = 'pcusp-chunk-autoreload-at';

/** Should a chunk-shaped error auto-reload NOW? One shot per window (60s
 *  debounce via sessionStorage) so a genuinely-broken build can't reload-loop.
 *  Pure over its inputs; exported for tests. */
export function shouldAutoReloadForChunkError(
  error: unknown,
  nowMs: number,
  lastReloadAtMs: number,
): boolean {
  const msg = String((error as { message?: unknown } | null)?.message ?? error ?? '');
  if (!CHUNK_LOAD_ERROR_RE.test(msg)) return false;
  return nowMs - lastReloadAtMs > 60_000;
}

/** SessionStorage key holding a JSON array of epoch-ms timestamps of DELAYED
 *  self-retries, so a genuinely broken build settles on the manual card instead
 *  of reloading roughly once a minute forever. A SLIDING window (not a lifetime
 *  counter): a tab that exhausted its retries during an outage heals again once
 *  the window drains — a lifetime counter left such tabs permanently manual
 *  (observed during the 2026-07-26 gym-tab recovery). Exported for tests. */
export const CHUNK_DELAYED_RETRY_COUNT_KEY = 'pcusp-chunk-delayed-retry-log';
export const CHUNK_DELAYED_RETRY_MAX = 5;
export const CHUNK_DELAYED_RETRY_WINDOW_MS = 30 * 60_000;

/** Parse + prune the retry log to timestamps still inside the sliding window.
 *  Pure; exported for tests. */
export function pruneRetryLog(raw: string | null, nowMs: number): number[] {
  try {
    const arr: unknown = JSON.parse(raw ?? '[]');
    if (!Array.isArray(arr)) return [];
    return arr
      .map(Number)
      .filter((ts) => Number.isFinite(ts) && nowMs - ts < CHUNK_DELAYED_RETRY_WINDOW_MS);
  } catch {
    return [];
  }
}

/** When the 60s debounce BLOCKS an immediate auto-reload for a chunk-shaped
 *  error, how long to wait before ONE delayed self-retry — or null for "don't".
 *
 *  Why this exists (gym-tab outage, 2026-07-26): a rebuild's asset-write window
 *  on this box spans minutes and recurs every ~2 min, so the immediate
 *  auto-reload routinely lands MID-BUILD, fails again inside the debounce, and
 *  the card then waited for a HUMAN — on a failure that heals itself seconds
 *  after the build finishes. Retrying once just past the debounce (+5s pad for
 *  the build to finish writing) converts that dead-end into self-heal, while
 *  `priorRetries >= CHUNK_DELAYED_RETRY_MAX` keeps a truly broken build from
 *  looping. Pure over its inputs; exported for tests. */
export function delayedChunkRetryMs(
  error: unknown,
  nowMs: number,
  lastReloadAtMs: number,
  priorRetries: number,
): number | null {
  const msg = String((error as { message?: unknown } | null)?.message ?? error ?? '');
  if (!CHUNK_LOAD_ERROR_RE.test(msg)) return null;
  if (priorRetries >= CHUNK_DELAYED_RETRY_MAX) return null;
  const sinceMs = nowMs - lastReloadAtMs;
  if (sinceMs > 60_000) return null; // the immediate path owns this case
  return 60_000 - sinceMs + 5_000;
}

/** Shared by both boundaries: immediate auto-reload when allowed, else arm ONE
 *  delayed self-retry. Returns the armed timer id (caller clears it on
 *  unmount/reset) or null. `onArmed` fires only when a delayed retry was armed,
 *  so the card can say so instead of implying a human must act. */
function autoHealChunkError(error: unknown, onArmed?: () => void): number | null {
  try {
    const now = Date.now();
    const last = Number(window.sessionStorage.getItem(CHUNK_AUTO_RELOAD_KEY) ?? 0);
    if (shouldAutoReloadForChunkError(error, now, last)) {
      window.sessionStorage.setItem(CHUNK_AUTO_RELOAD_KEY, String(now));
      hardReload();
      return null;
    }
    const retryLog = pruneRetryLog(
      window.sessionStorage.getItem(CHUNK_DELAYED_RETRY_COUNT_KEY),
      now,
    );
    const delay = delayedChunkRetryMs(error, now, last, retryLog.length);
    if (delay === null) return null;
    onArmed?.();
    return window.setTimeout(() => {
      try {
        const nowRetry = Date.now();
        const lastRetry = Number(window.sessionStorage.getItem(CHUNK_AUTO_RELOAD_KEY) ?? 0);
        if (nowRetry - lastRetry <= 60_000) return; // someone else reloaded meanwhile
        window.sessionStorage.setItem(CHUNK_AUTO_RELOAD_KEY, String(nowRetry));
        window.sessionStorage.setItem(
          CHUNK_DELAYED_RETRY_COUNT_KEY,
          JSON.stringify([...pruneRetryLog(
            window.sessionStorage.getItem(CHUNK_DELAYED_RETRY_COUNT_KEY),
            nowRetry,
          ), nowRetry]),
        );
        hardReload();
      } catch {
        /* manual fallback stays */
      }
    }, delay);
  } catch {
    return null; /* sessionStorage unavailable → manual fallback stays */
  }
}

class RouteErrorBoundaryInner extends Component<Props, State> {
  state: State = { error: null, componentStack: null, expanded: false, autoRetryArmed: false };

  private retryTimer: number | null = null;

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidUpdate(prev: Props): void {
    // Navigated since the error was caught → clear it and re-render the new
    // route. If the new route also throws, getDerivedStateFromError re-sets it
    // (resetKey is now stable, so no loop).
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.clearRetryTimer();
      this.setState({ error: null, componentStack: null, expanded: false, autoRetryArmed: false });
    }
  }

  componentWillUnmount(): void {
    this.clearRetryTimer();
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Capture the component stack so the detail pane can show it (the console's
    // "occurred in <X>" — the part that actually names the broken component).
    this.setState({ componentStack: info.componentStack ?? null });
    // eslint-disable-next-line no-console
    console.error('[RouteErrorBoundary] caught render error:', error, info.componentStack);
    reportRenderCrash('route', error, info.componentStack ?? null);
    // Stale-chunk AUTO-HEAL (2026-07-01): a long-open window whose lazy tab
    // chunk 404s after a rebuild used to sit on "Something went wrong" until a
    // human clicked Reload. Reload once automatically; if the 60s debounce
    // blocks (the usual case when the reload itself landed mid-build — the
    // 2026-07-26 gym-tab outage), arm ONE delayed retry just past the debounce
    // instead of dead-ending on the manual card. A genuinely broken build still
    // settles manual via CHUNK_DELAYED_RETRY_MAX.
    this.clearRetryTimer();
    this.retryTimer = autoHealChunkError(error, () => this.setState({ autoRetryArmed: true }));
  }

  render(): ReactNode {
    const { error, expanded } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" style={WRAP}>
        <div style={CARD}>
          <h2 style={TITLE}>This view hit an error</h2>
          <ErrorCardBody />
          {this.state.autoRetryArmed && <AutoRetryNote />}
          <div style={ROW}>
            <button type="button" style={PRIMARY} onClick={() => hardReload()}>
              Reload
            </button>
            <button
              type="button"
              style={SECONDARY}
              onClick={() => {
                this.clearRetryTimer();
                this.setState({
                  error: null,
                  componentStack: null,
                  expanded: false,
                  autoRetryArmed: false,
                });
              }}
            >
              Try again
            </button>
            <button
              type="button"
              style={LINK}
              onClick={() => this.setState((s) => ({ expanded: !s.expanded }))}
            >
              {expanded ? 'Hide details' : 'Show details'}
            </button>
          </div>
          {expanded && <ErrorDetail error={error} componentStack={this.state.componentStack} />}
        </div>
      </div>
    );
  }
}

/**
 * Functional wrapper: feeds the current location as `resetKey` so the class
 * boundary clears on navigation (class components can't use hooks).
 */
export default function RouteErrorBoundary({ children }: { children: ReactNode }) {
  const location = useLocation();
  return (
    <RouteErrorBoundaryInner resetKey={location.href}>{children}</RouteErrorBoundaryInner>
  );
}

/**
 * Router-level default error component — wired as `createRouter({
 * defaultErrorComponent })` in `main.tsx`.
 *
 * Why this exists (2026-07-01, WI-1484): `RouteErrorBoundary` above wraps ONLY
 * the `<Outlet/>`. `ChromeShell` / `LeftSidebar` / `DevAdminRail` / tab panels
 * are SIBLINGS outside it, several in bare `<Suspense fallback={null}>` with no
 * error boundary. When one of THEIR lazy chunks 404s — the page predates a
 * rebuild that deleted it (a one-shot `vite build` wiped `dist/` while no watch
 * singleton held the retain-lock, or the retain TTL elapsed, or a production
 * redeploy rolled the hashes) — TanStack surfaces the LOAD failure at the root
 * route's CatchBoundary, NOT at `RouteErrorBoundary`. With no
 * `defaultErrorComponent` set that dead-ended on TanStack's bare "Something
 * went wrong!" with no working reload (the owner hit this as a blank/broken
 * desktop after the bundle was rebuilt underneath the open window).
 *
 * Same chunk-aware auto-heal as `RouteErrorBoundary`, at the layer that
 * actually catches this failure: reload ONCE (60s-debounced via the SHARED
 * `CHUNK_AUTO_RELOAD_KEY`, so the two boundaries can't double-reload) to pick up
 * the fresh build; a genuinely broken build lands on the manual Reload fallback
 * instead of looping. `reset` is TanStack's retry (re-attempts the route).
 */
export function DefaultRouterErrorComponent({
  error,
  reset,
}: {
  error: unknown;
  reset?: () => void;
}): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const [autoRetryArmed, setAutoRetryArmed] = useState(false);
  useEffect(() => {
    // Same immediate-then-delayed auto-heal as RouteErrorBoundary (shared
    // debounce + retry-cap keys, so the two boundaries can't double-reload).
    const timer = autoHealChunkError(error, () => setAutoRetryArmed(true));
    return () => {
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [error]);
  return (
    <div role="alert" style={WRAP}>
      <div style={CARD}>
        <h2 style={TITLE}>This view hit an error</h2>
        <ErrorCardBody />
        {autoRetryArmed && <AutoRetryNote />}
        <div style={ROW}>
          <button type="button" style={PRIMARY} onClick={() => hardReload()}>
            Reload
          </button>
          {reset && (
            <button type="button" style={SECONDARY} onClick={() => reset()}>
              Try again
            </button>
          )}
          <button type="button" style={LINK} onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Hide details' : 'Show details'}
          </button>
        </div>
        {/* TanStack's default-error path passes only `error` (no component
            stack); ErrorDetail still surfaces the message + linkified react.dev
            decode + the JS stack, all copyable. */}
        {expanded && <ErrorDetail error={error} />}
      </div>
    </div>
  );
}

/** Shown when a delayed chunk self-retry is armed — tells the user the card
 *  heals itself so they don't have to babysit the Reload button. */
function AutoRetryNote(): ReactNode {
  return (
    <p style={{ ...BODY, color: 'var(--accent, #57d7ff)' }}>
      A new build is still rolling out — this view retries automatically in about a minute. No
      action needed.
    </p>
  );
}

const WRAP: CSSProperties = {
  display: 'grid',
  placeItems: 'center',
  minHeight: '60vh',
  padding: 24,
};
const CARD: CSSProperties = {
  maxWidth: 560,
  width: '100%',
  background: 'var(--bg-2, #0b1220)',
  border: '1px solid var(--border, #2a2a2a)',
  borderRadius: 12,
  padding: '22px 24px',
  color: 'var(--fg, #e7f7ff)',
  boxShadow: '0 18px 54px rgba(0,0,0,0.5)',
};
const TITLE: CSSProperties = { margin: '0 0 8px', fontSize: 16, fontWeight: 600 };
const BODY: CSSProperties = {
  margin: '0 0 16px',
  fontSize: 13,
  lineHeight: 1.55,
  color: 'var(--fg-dim, #b9d4e8)',
};
const ROW: CSSProperties = { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' };
const PRIMARY: CSSProperties = {
  padding: '6px 16px',
  fontSize: 13,
  fontWeight: 600,
  color: '#06121b',
  background: 'var(--accent, #57d7ff)',
  border: '1px solid var(--accent, #57d7ff)',
  borderRadius: 6,
  cursor: 'pointer',
};
const SECONDARY: CSSProperties = {
  padding: '6px 14px',
  fontSize: 13,
  color: 'var(--fg, #e7f7ff)',
  background: 'transparent',
  border: '1px solid var(--border, #2a2a2a)',
  borderRadius: 6,
  cursor: 'pointer',
};
const LINK: CSSProperties = {
  padding: '6px 8px',
  fontSize: 12,
  color: 'var(--fg-mute, #7f9bb4)',
  background: 'transparent',
  border: 0,
  cursor: 'pointer',
  textDecoration: 'underline',
};
