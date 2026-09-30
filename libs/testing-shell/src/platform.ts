/**
 * Platform-variant selection for the testing shell (P-001 of
 * testing-shell-platform-variants-2026-06-01).
 *
 * A test domain like `chaos`/`live` ships two sibling tabs — a Tauri-desktop
 * variant and a browser variant — each tagged with `platform`. The host
 * declares which platform(s) it is via TestingShell's `platform` prop, and
 * `visibleTabs` filters the rail accordingly. A tab with no `platform` is
 * platform-agnostic (always shown). Explicit (not runtime-detected) per
 * decision D-001 — predictable + testable; papercup passes 'both', a web app
 * passes 'web'.
 */

/** What platform(s) a host runs on. 'both' = a Tauri app whose content is also a browser SPA (papercup). */
export type Platform = 'desktop' | 'web' | 'both';

/** A tab's platform tag. Omitted = platform-agnostic. */
export type TabPlatform = 'desktop' | 'web';

/**
 * Filter tabs to those visible on the active platform. Agnostic tabs (no
 * `platform`) always show; 'both' shows everything. Pure — preserves order,
 * never mutates the input.
 */
export function visibleTabs<T extends { platform?: TabPlatform }>(tabs: T[], platform: Platform): T[] {
  if (platform === 'both') return tabs.slice();
  return tabs.filter((t) => t.platform === undefined || t.platform === platform);
}
