/** Stable, target-explicit assertions over the authenticated Tauri dev bridge. */
import type {
  AppReady,
  AssertionResult,
  BridgeStatus,
  LayoutElement,
  LayoutExpectation,
  LayoutInfo,
  RouteInfo,
  ScopeInfo,
  VerifyConfig,
  VerifyResult,
} from './types.js';
import { bridgeEval, resolveBridge } from './bridge-client.js';

function parseJsonResult<T>(result: unknown, label: string): VerifyResult<T> {
  if (typeof result !== 'string') {
    return { ok: false, code: 'invalid_eval_result', error: `${label} did not return JSON text.` };
  }
  try {
    return { ok: true, value: JSON.parse(result) as T };
  } catch {
    return { ok: false, code: 'invalid_eval_json', error: `Failed to parse ${label}.` };
  }
}

export async function readRoute(config: VerifyConfig): Promise<VerifyResult<RouteInfo>> {
  const result = await bridgeEval<string>(
    config,
    'JSON.stringify({ href: location.href, pathname: location.pathname, search: location.search, hash: location.hash })',
  );
  return result.ok ? parseJsonResult<RouteInfo>(result.value, 'route info') : result;
}

export async function assertBridgeConnected(config: VerifyConfig): Promise<VerifyResult<BridgeStatus>> {
  const bridge = await resolveBridge(config);
  if (!bridge.ok) return bridge;
  const result = await bridgeEval<string>(
    config,
    'JSON.stringify({ href: location.href, title: document.title, readyState: document.readyState })',
  );
  if (!result.ok) return result;
  const page = parseJsonResult<{ href: string; title: string; readyState: string }>(result.value, 'bridge page state');
  if (!page.ok) return page;
  return {
    ok: true,
    value: {
      bridgeAlive: true,
      bridgeVersion: 'authenticated-eval',
      tauriPID: bridge.value.pid ?? 0,
      port: bridge.value.port,
      webviewURL: page.value.href,
      pageTitle: page.value.title,
    },
  };
}

export async function assertAppReady(config: VerifyConfig): Promise<VerifyResult<AppReady>> {
  const bridge = await assertBridgeConnected(config);
  if (!bridge.ok) return { ...bridge, error: `Bridge not ready: ${bridge.error}` };

  const stateResult = await bridgeEval<string>(
    config,
    `JSON.stringify({
      readyState: document.readyState,
      rootMounted: (document.querySelector('#root')?.childElementCount ?? 0) > 0,
      href: location.href,
      pathname: location.pathname,
      search: location.search,
      hash: location.hash,
      origin: location.origin,
      routeError: Array.from(document.querySelectorAll('[role="alert"] h2'))
        .map((node) => node.textContent?.trim())
        .find((text) => text === 'This view hit an error') ?? null
    })`,
  );
  if (!stateResult.ok) return stateResult;
  const state = parseJsonResult<{
    readyState: string;
    rootMounted: boolean;
    href: string;
    pathname: string;
    search: string;
    hash: string;
    origin: string;
    routeError: string | null;
  }>(stateResult.value, 'app readiness state');
  if (!state.ok) return state;

  const webviewLoaded = ['interactive', 'complete'].includes(state.value.readyState);
  const routerReady = state.value.rootMounted && state.value.pathname.startsWith('/');
  if (!webviewLoaded || !routerReady) {
    return {
      ok: false,
      code: 'webview_not_ready',
      error: `Webview not ready: readyState=${state.value.readyState}, rootMounted=${state.value.rootMounted}`,
      evidence: state.value,
    };
  }
  if (state.value.routeError) {
    return {
      ok: false,
      code: 'route_error_boundary',
      error: `Target webview is showing its route error boundary: ${state.value.routeError}`,
      evidence: state.value,
    };
  }

  const apiBaseUrl = config.apiBaseUrl ?? state.value.origin;
  try {
    const response = await fetch(new URL('/api/health', apiBaseUrl), {
      signal: AbortSignal.timeout(config.timeout ?? 10_000),
    });
    if (!response.ok) {
      return {
        ok: false,
        code: 'api_unhealthy',
        error: `Target webview API is unhealthy: ${response.status} ${response.statusText}`,
        evidence: { apiBaseUrl, webviewURL: state.value.href },
      };
    }
  } catch (error) {
    return {
      ok: false,
      code: 'api_unreachable',
      error: `Target webview API is unreachable: ${error instanceof Error ? error.message : String(error)}`,
      evidence: { apiBaseUrl, webviewURL: state.value.href },
    };
  }

  return {
    ok: true,
    value: {
      bridgeConnected: true,
      webviewLoaded: true,
      apiHealthy: true,
      routerReady: true,
      route: {
        href: state.value.href,
        pathname: state.value.pathname,
        search: state.value.search,
        hash: state.value.hash,
      },
    },
  };
}

export function routeMatches(route: RouteInfo, expected: string | RegExp): boolean {
  if (typeof expected === 'string') return route.pathname === expected;
  expected.lastIndex = 0;
  return expected.test(route.pathname);
}

export async function assertRoute(
  config: VerifyConfig,
  expectedRoute: string | RegExp,
): Promise<VerifyResult<RouteInfo>> {
  const route = await readRoute(config);
  if (!route.ok) return route;
  if (!routeMatches(route.value, expectedRoute)) {
    return {
      ok: false,
      code: 'route_mismatch',
      error: `Route mismatch: expected ${String(expectedRoute)}, got ${route.value.pathname}${route.value.search}`,
      evidence: { ...route.value },
    };
  }
  return route;
}

export async function assertScope(
  config: VerifyConfig,
  expectedScope: Partial<ScopeInfo>,
): Promise<VerifyResult<ScopeInfo>> {
  const result = await bridgeEval<string>(
    config,
    `(() => {
      const url = new URL(location.href);
      const pathHarness = location.pathname.match(/^\\/harness\\/([^/]+)/)?.[1];
      return JSON.stringify({
        harnessSlug: url.searchParams.get('slug') || url.searchParams.get('harness') || pathHarness || undefined,
        workspaceId: window.__PAPERCUSP_WS__ || url.searchParams.get('ws') || 'default'
      });
    })()`,
  );
  if (!result.ok) return result;
  const scope = parseJsonResult<ScopeInfo>(result.value, 'scope info');
  if (!scope.ok) return scope;

  for (const [key, expectedValue] of Object.entries(expectedScope)) {
    if (expectedValue !== undefined && scope.value[key as keyof ScopeInfo] !== expectedValue) {
      return {
        ok: false,
        code: 'scope_mismatch',
        error: `Scope mismatch: expected ${key}=${String(expectedValue)}, got ${String(scope.value[key as keyof ScopeInfo])}`,
        evidence: { ...scope.value },
      };
    }
  }
  return scope;
}

/**
 * Verify layout over the authenticated bridge instead of a `screenshot --selector`
 * capture (EI-11084). `tauri-agent-tools screenshot --selector` resolves the OS
 * window by `document.title` via `xdotool search --name`, which silently fails when
 * the webview's document title ("Papercusp Operator") differs from the X11 window
 * title ("Papercusp") — e.g. on a self-spawned dev shell / non-default display. This
 * assertion measures the same layout facts the screenshot was proving — no window
 * geometry, no xdotool — so it cannot hit that trap.
 *
 * Checks (all against the viewport, with a `tolerance` px slack for sub-pixel rounding):
 * - the PAGE does not overflow horizontally (documentElement.scrollWidth ≤ clientWidth);
 * - each `selectors` element sits fully within the viewport (right edge ≤ viewport width);
 * - a declared `scrollContainer` (overflow:auto) may scroll its OWN content freely —
 *   internal scroll is never a failure — but it too must sit within the viewport.
 */
export async function assertLayout(
  config: VerifyConfig,
  expected: LayoutExpectation = {},
): Promise<VerifyResult<LayoutInfo>> {
  const tolerance = expected.tolerance ?? 1;
  const selectors = expected.selectors ?? [];
  const scrollContainer = expected.scrollContainer ?? null;
  const measured = [...selectors, ...(scrollContainer ? [scrollContainer] : [])];

  const result = await bridgeEval<string>(
    config,
    `(() => {
      const de = document.documentElement;
      const measure = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return { selector: sel, found: false };
        const r = el.getBoundingClientRect();
        return {
          selector: sel, found: true,
          left: r.left, right: r.right, width: r.width,
          scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
          overflowsInternally: el.scrollWidth > el.clientWidth,
        };
      };
      return JSON.stringify({
        viewportWidth: de.clientWidth,
        documentScrollWidth: de.scrollWidth,
        measured: ${JSON.stringify(measured)}.map(measure),
      });
    })()`,
  );
  if (!result.ok) return result;
  const parsed = parseJsonResult<{
    viewportWidth: number;
    documentScrollWidth: number;
    measured: LayoutElement[];
  }>(result.value, 'layout metrics');
  if (!parsed.ok) return parsed;

  const { viewportWidth, documentScrollWidth, measured: allMeasured } = parsed.value;
  const container = scrollContainer
    ? allMeasured.find((el) => el.selector === scrollContainer) ?? null
    : null;
  const elements = allMeasured;
  const horizontalOverflow = documentScrollWidth > viewportWidth + tolerance;
  const info: LayoutInfo = { viewportWidth, documentScrollWidth, horizontalOverflow, elements, scrollContainer: container };

  const missing = allMeasured.filter((el) => !el.found).map((el) => el.selector);
  if (missing.length) {
    return {
      ok: false,
      code: 'layout_element_not_found',
      error: `Layout target(s) not found: ${missing.join(', ')}`,
      evidence: { ...info },
    };
  }
  if (horizontalOverflow) {
    return {
      ok: false,
      code: 'horizontal_overflow',
      error: `Page overflows horizontally: scrollWidth ${documentScrollWidth} > viewport ${viewportWidth} (tolerance ${tolerance}).`,
      evidence: { ...info },
    };
  }
  const overflowing = allMeasured.filter((el) => (el.right ?? 0) > viewportWidth + tolerance);
  if (overflowing.length) {
    return {
      ok: false,
      code: 'element_overflow',
      error: `Element(s) extend past the viewport right edge (${viewportWidth}px): ${overflowing
        .map((el) => `${el.selector}@${Math.round(el.right ?? 0)}`)
        .join(', ')}.`,
      evidence: { ...info, overflowing },
    };
  }
  return { ok: true, value: info };
}

export function formatAssertionResult(result: AssertionResult): string {
  const status = result.passed ? '✓' : '✗';
  return `${status} ${result.message}${result.details ? ` | ${JSON.stringify(result.details)}` : ''}`;
}
