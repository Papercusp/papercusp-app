/**
 * Core types for Tauri verification surface.
 *
 * Provides stable types for:
 * - App readiness verification
 * - Route assertions
 * - Scope (harness/workspace) assertions
 * - Semantic screen identification
 */

/**
 * Result of a verification operation.
 * Either a successful value or an error message.
 */
export type VerifyResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; code?: string; evidence?: Record<string, unknown> };

/**
 * Bridge connection status.
 */
export interface BridgeStatus {
  bridgeAlive: boolean;
  bridgeVersion: string;
  tauriPID: number;
  port: number;
  webviewURL: string;
  pageTitle: string;
}

/**
 * App readiness state.
 */
export interface AppReady {
  bridgeConnected: boolean;
  webviewLoaded: boolean;
  apiHealthy: boolean;
  routerReady: boolean;
  route: RouteInfo;
}

/**
 * Current route information.
 */
export interface RouteInfo {
  href: string;
  pathname: string;
  search: string;
  hash: string;
}

/**
 * A single element's box + scroll geometry, measured over the bridge.
 */
export interface LayoutElement {
  selector: string;
  found: boolean;
  left?: number;
  right?: number;
  width?: number;
  /** Element's own content width — exceeds clientWidth when it scrolls internally. */
  scrollWidth?: number;
  clientWidth?: number;
  /** True when scrollWidth > clientWidth (an overflow:auto container scrolling its own content). */
  overflowsInternally?: boolean;
}

/**
 * Result of a bridge-based layout check — the xdotool-free alternative to a
 * `screenshot --selector` layout verification (EI-11084).
 */
export interface LayoutInfo {
  /** documentElement.clientWidth — the usable viewport width. */
  viewportWidth: number;
  /** documentElement.scrollWidth — > viewportWidth means the PAGE scrolls horizontally. */
  documentScrollWidth: number;
  /** True when the page itself overflows horizontally (beyond tolerance). */
  horizontalOverflow: boolean;
  /** Measured target elements (from `selectors` + `scrollContainer`). */
  elements: LayoutElement[];
  /** The declared overflow:auto container, if one was checked. */
  scrollContainer: LayoutElement | null;
}

/**
 * What a layout check should hold. All fields optional: with no selectors the
 * check still verifies the page does not overflow horizontally.
 */
export interface LayoutExpectation {
  /** Elements that must sit fully within the viewport (right edge ≤ viewport width). */
  selectors?: string[];
  /**
   * A single overflow:auto container that is ALLOWED to scroll its own content.
   * Its internal scroll is never a failure; it is still checked for sitting
   * within the viewport, and its geometry is returned for inspection.
   */
  scrollContainer?: string;
  /** Pixel slack for sub-pixel rounding (default 1). */
  tolerance?: number;
}

/**
 * Harness/workspace scope information.
 */
export interface ScopeInfo {
  harnessSlug?: string;
  workspaceId?: string;
  userId?: string;
  role?: string;
}

/**
 * Semantic screen identifier.
 * Provides meaningful names for testable UI surfaces.
 */
export interface Screen {
  id: string;
  name: string;
  /** Stable destination used by navigateToScreen. */
  href: string;
  route: {
    pathname: string | RegExp;
    query?: Record<string, string | RegExp>;
  };
  requiredElements?: string[];
}

/**
 * Configuration for verification environment.
 */
export interface VerifyConfig {
  /** Preferred target: the exact Tauri process to drive. */
  tauriPID?: number;
  /** Explicit bridge target alternative; both port and token are required. */
  bridgePort?: number;
  bridgeToken?: string;
  windowLabel?: string;
  timeout?: number; // milliseconds
  /** Optional override; defaults to the origin the target webview is actually using. */
  apiBaseUrl?: string;
}

/**
 * Assertion result with metadata.
 */
export interface AssertionResult {
  passed: boolean;
  message: string;
  details?: Record<string, unknown>;
  timestamp: number;
}
