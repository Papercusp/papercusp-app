/**
 * Framework-free find-in-page navigation engine.
 *
 * `react-css-highlight` owns the matching: it walks the target subtree and
 * registers every match under a CSS Custom Highlight whose name WE choose
 * (`HIGHLIGHT_NAME`), via `CSS.highlights.set(name, …)`. Its public API only
 * hands back a `matchCount`, not the matched ranges — so for active-match
 * navigation we read the ranges straight off the global highlight registry
 * (`CSS.highlights.get(name)`) after each paint, order them, and drive a
 * SECOND highlight (`ACTIVE_HIGHLIGHT_NAME`) for the currently-focused match.
 *
 * The pure helpers (index math, label, range ordering) are unit-tested; the
 * registry/scroll helpers need the real Custom Highlight API + layout and are
 * covered by the Playwright e2e + the manual Tauri-shell pass.
 */

/** Name we pass to react-css-highlight; also the `::highlight()` selector. */
export const HIGHLIGHT_NAME = 'papercup-find';
/** Our own highlight for the active match; styled stronger. */
export const ACTIVE_HIGHLIGHT_NAME = 'papercup-find-active';

// ── Pure helpers (unit-tested) ──────────────────────────────────────────

/** Next match index with wrap-around. -1 (none) → first. len 0 → -1. */
export function nextIndex(current: number, len: number): number {
  if (len <= 0) return -1;
  if (current < 0) return 0;
  return (current + 1) % len;
}

/** Previous match index with wrap-around. -1 (none) → last. len 0 → -1. */
export function prevIndex(current: number, len: number): number {
  if (len <= 0) return -1;
  if (current < 0) return len - 1;
  return (current - 1 + len) % len;
}

/** "3/12" — 1-based active position over the total; "0/0" / "0/N" edges. */
export function formatMatchLabel(activeIndex: number, total: number): string {
  if (total <= 0) return '0/0';
  return `${activeIndex < 0 ? 0 : activeIndex + 1}/${total}`;
}

/** Sort a copy of `ranges` into document order (does not mutate the input). */
export function orderRanges(ranges: Range[]): Range[] {
  return [...ranges].sort((a, b) => a.compareBoundaryPoints(Range.START_TO_START, b));
}

// ── DOM / Custom Highlight API helpers (browser-only) ───────────────────

/** True when the webview supports the CSS Custom Highlight API. */
export function isHighlightApiSupported(): boolean {
  return (
    typeof CSS !== 'undefined' &&
    !!(CSS as unknown as { highlights?: unknown }).highlights &&
    typeof Highlight !== 'undefined'
  );
}

/**
 * Read the all-matches highlight react-css-highlight registered under
 * `name` and return its ranges in document order. Empty when unsupported,
 * not yet painted, or no matches.
 */
export function collectOrderedRanges(name: string = HIGHLIGHT_NAME): Range[] {
  if (!isHighlightApiSupported()) return [];
  const highlight = CSS.highlights.get(name);
  if (!highlight) return [];
  const ranges: Range[] = [];
  for (const r of highlight) {
    // react-css-highlight registers live Range objects (not StaticRange),
    // so compareBoundaryPoints in orderRanges is safe.
    if (r instanceof Range) ranges.push(r);
  }
  return orderRanges(ranges);
}

/** Register/replace the active-match highlight for `range`. */
export function setActiveHighlight(range: Range): void {
  if (!isHighlightApiSupported()) return;
  CSS.highlights.set(ACTIVE_HIGHLIGHT_NAME, new Highlight(range));
}

/** Remove a highlight by name (no-op if absent / unsupported). */
export function clearHighlight(name: string): void {
  if (!isHighlightApiSupported()) return;
  CSS.highlights.delete(name);
}

/** Remove the active-match highlight (the all-matches one is the lib's). */
export function clearActiveHighlight(): void {
  clearHighlight(ACTIVE_HIGHLIGHT_NAME);
}

/**
 * Scroll the match into view if it isn't already, centering it. Walks every
 * scrollable ancestor via the start node's parent element, so it works inside
 * nested scroll containers. No-op for zero-size (hidden) ranges.
 */
export function scrollRangeIntoView(range: Range): void {
  const rect = range.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) return;
  const fullyInView = rect.top >= 0 && rect.bottom <= window.innerHeight;
  if (fullyInView) return;
  const anchor =
    range.startContainer.nodeType === Node.ELEMENT_NODE
      ? (range.startContainer as Element)
      : range.startContainer.parentElement;
  anchor?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
}
