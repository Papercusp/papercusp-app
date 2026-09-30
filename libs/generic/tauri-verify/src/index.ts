/**
 * Tauri verification surface — stable API for app-ready, route, and scope assertions.
 *
 * This module provides a programmatic, stable verification interface built on
 * tauri-agent-tools, enabling agents to:
 *
 * 1. Verify app readiness (bridge connected, webview loaded, API healthy, router ready)
 * 2. Assert on current route with semantic screen matching
 * 3. Verify harness/workspace scope and authorization
 * 4. Use semantic screen identifiers instead of raw selectors
 *
 * Example usage:
 *
 * const verify = createVerifier({ bridgePort: 42391 });
 *
 * // Verify app is ready
 * const appReady = await verify.appReady();
 * if (!appReady.ok) throw new Error(appReady.error);
 *
 * // Verify current route matches expected
 * const route = await verify.route(/^\/adv/);
 * if (!route.ok) throw new Error(route.error);
 *
 * // Verify scope
 * const scope = await verify.scope({ harnessSlug: 'test-harness' });
 * if (!scope.ok) throw new Error(scope.error);
 */

import type {
  VerifyConfig,
  VerifyResult,
  AppReady,
  RouteInfo,
  ScopeInfo,
  Screen,
  LayoutExpectation,
  LayoutInfo,
} from './types.js';
import { assertAppReady, assertLayout, assertRoute, assertScope, readRoute } from './assertions.js';
import { bridgeEval } from './bridge-client.js';
import { findScreen, findScreenByRoute, screenMatchesRoute } from './screens.js';

/**
 * Stable verification interface for Tauri-based UI testing.
 */
export interface Verifier {
  /**
   * Assert that the app is ready for testing.
   */
  appReady(): Promise<VerifyResult<AppReady>>;

  /**
   * Assert that the current route matches expected.
   */
  route(expected: string | RegExp): Promise<VerifyResult<RouteInfo>>;

  /**
   * Assert current harness/workspace scope.
   */
  scope(expected: Partial<ScopeInfo>): Promise<VerifyResult<ScopeInfo>>;

  /** Assert semantic route + required live selectors. */
  screen(screenId: string): Promise<VerifyResult<Screen>>;

  /**
   * Verify layout over the bridge (no screenshot / xdotool) — the reliable
   * alternative to `screenshot --selector` for layout checks (EI-11084).
   */
  layout(expected?: LayoutExpectation): Promise<VerifyResult<LayoutInfo>>;

  /**
   * Navigate to a semantic screen by ID.
   */
  navigateToScreen(screenId: string): Promise<VerifyResult<Screen>>;

  /**
   * Get current screen based on route.
   */
  currentScreen(): Promise<VerifyResult<Screen>>;

  /**
   * Get configuration.
   */
  config(): VerifyConfig;
}

/**
 * Create a verifier. Driving calls require an explicit tauriPID (recommended)
 * or bridgePort + bridgeToken, so multiple live desktops can never be confused.
 */
export function createVerifier(config?: VerifyConfig): Verifier {
  const finalConfig: VerifyConfig = {
    timeout: config?.timeout ?? 10000,
    ...config,
  };

  const assertSemanticScreen = async (screenId: string): Promise<VerifyResult<Screen>> => {
    const screen = findScreen(screenId);
    if (!screen) return { ok: false, code: 'screen_not_found', error: `Screen not found: ${screenId}` };
    const route = await readRoute(finalConfig);
    if (!route.ok) return route;
    if (!screenMatchesRoute(screen, route.value)) {
      return {
        ok: false,
        code: 'screen_route_mismatch',
        error: `Screen ${screenId} does not match ${route.value.pathname}${route.value.search}`,
        evidence: { ...route.value },
      };
    }
    const selectors = JSON.stringify(screen.requiredElements ?? []);
    const elements = await bridgeEval<string>(
      finalConfig,
      `JSON.stringify(${selectors}.map(selector => ({ selector, present: !!document.querySelector(selector) })))`,
    );
    if (!elements.ok) return elements;
    let checks: Array<{ selector: string; present: boolean }>;
    try {
      checks = JSON.parse(elements.value) as Array<{ selector: string; present: boolean }>;
    } catch {
      return { ok: false, code: 'invalid_screen_result', error: 'Screen selector check returned invalid JSON.' };
    }
    const missing = checks.filter((check) => !check.present).map((check) => check.selector);
    if (missing.length) {
      return {
        ok: false,
        code: 'screen_elements_missing',
        error: `Screen ${screenId} is missing required elements: ${missing.join(', ')}`,
        evidence: { route: route.value, missing },
      };
    }
    return { ok: true, value: screen };
  };

  return {
    async appReady(): Promise<VerifyResult<AppReady>> {
      return assertAppReady(finalConfig);
    },

    async route(expected: string | RegExp): Promise<VerifyResult<RouteInfo>> {
      return assertRoute(finalConfig, expected);
    },

    async scope(expected: Partial<ScopeInfo>): Promise<VerifyResult<ScopeInfo>> {
      return assertScope(finalConfig, expected);
    },

    async screen(screenId: string): Promise<VerifyResult<Screen>> {
      return assertSemanticScreen(screenId);
    },

    async layout(expected?: LayoutExpectation): Promise<VerifyResult<LayoutInfo>> {
      return assertLayout(finalConfig, expected);
    },

    async navigateToScreen(screenId: string): Promise<VerifyResult<Screen>> {
      const screen = findScreen(screenId);
      if (!screen) {
        return {
          ok: false,
          error: `Screen not found: ${screenId}`,
        };
      }

      const alreadyThere = await assertSemanticScreen(screenId);
      if (alreadyThere.ok) return alreadyThere;
      const navigate = await bridgeEval(finalConfig, `location.assign(${JSON.stringify(screen.href)}); true`);
      if (!navigate.ok) return navigate;
      const deadline = Date.now() + (finalConfig.timeout ?? 10_000);
      let last: VerifyResult<Screen> = alreadyThere;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        last = await assertSemanticScreen(screenId);
        if (last.ok) return last;
      }
      return {
        ok: false,
        code: 'screen_navigation_timeout',
        error: `Timed out navigating to ${screenId}: ${last.ok ? 'unknown error' : last.error}`,
        evidence: { href: screen.href },
      };
    },

    async currentScreen(): Promise<VerifyResult<Screen>> {
      const routeResult = await readRoute(finalConfig);
      if (!routeResult.ok) {
        return {
          ok: false,
          error: `Failed to determine current route: ${routeResult.error}`,
        };
      }

      const screen = findScreenByRoute(routeResult.value);
      if (!screen) {
        return {
          ok: false,
          error: `Current route does not match any semantic screen: ${routeResult.value.pathname}`,
        };
      }

      return { ok: true, value: screen };
    },

    config(): VerifyConfig {
      return finalConfig;
    },
  };
}

// Export types and functions for advanced usage
export * from './types.js';
export * from './assertions.js';
export * from './screens.js';
export * from './bridge-client.js';
