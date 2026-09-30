import { useCallback, useEffect, useRef, type ClipboardEvent, type CSSProperties } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import RichGrid, { type RichGridProps } from './RichGrid';
import { buildCopyPayloads } from './copy-payloads';

/**
 * VirtualGrid — the drop-in answer to "I have an in-memory row array and I don't
 * want every row mounted as DOM."
 *
 * RichGrid supports virtualization via its `virtualMode` prop, but the caller has
 * to own the scroll element, build a TanStack virtualizer, wire `rowAt`, and
 * re-`measure()` when the rows change. That boilerplate was being copy-pasted
 * (and, more often, SKIPPED — `<RichGrid rows={...}>` renders every row, so teams
 * "fixed" the resulting jank by capping the fetch). VirtualGrid owns all of it:
 * pass `rows` + `columns` + `getRowId` and only the visible window mounts, so the
 * row count stops driving render cost and a cap is no longer needed.
 *
 * It is a thin wrapper — every other RichGrid prop (selection, resizable columns,
 * sort, expansion, getRowBg, onRowClick, empty, …) passes straight through. For
 * the rare case that needs an external/shared scroll element or paged sync, use
 * RichGrid's `virtualMode` directly (or `@papercusp/sync`'s `useSyncVirtualizer`
 * for windowed/infinite-scroll reads).
 *
 * **Copy & print.** RichGrid's own Ctrl+C / Ctrl+P live on its non-inline outer
 * wrapper, which virtualization can't use (it owns its own scroll element). So
 * VirtualGrid re-wires **Ctrl+C copy itself**, over the FULL `rows` array (built
 * at copy time — no render cost). Full-page **print is intentionally NOT restored**:
 * RichGrid's print mirror renders every row into a hidden `<table>`, which would
 * re-introduce the exact all-rows-in-DOM cost virtualization removes. Ctrl+P thus
 * prints only the on-screen window — copy → paste is the path for the full set.
 */
export interface VirtualGridProps<TRow>
  extends Omit<RichGridProps<TRow>, 'rows' | 'virtualMode' | 'inline'> {
  /** The full in-memory row set. Only the visible window is mounted. */
  rows: TRow[];
  /**
   * Estimated row height in px (the virtualizer's `estimateSize`). Defaults to
   * `rowMinHeight ?? 30`. For uniform-height rows the estimate IS the height;
   * for variable-height rows set `measureVariableHeight` and this is just the
   * pre-measure guess.
   */
  estimateRowHeight?: number;
  /** Rows rendered beyond the viewport on each side. Default 12. */
  overscan?: number;
  /**
   * Measure every visible row's real height (forwards RichGrid's
   * `virtualMode.measureAll`). Opt in ONLY for genuinely variable-height rows
   * (multi-line cards, wrap-on-tags) — for uniform rows it's pure layout cost.
   */
  measureVariableHeight?: boolean;
  /**
   * className for the scroll container. When provided, the caller owns the
   * container's sizing/overflow; when omitted VirtualGrid supplies a sensible
   * `flex: 1; min-height: 0; overflow: auto` (fills a flex parent + scrolls).
   */
  scrollClassName?: string;
  /** Extra style merged onto the scroll container. */
  scrollStyle?: CSSProperties;
  /**
   * Infinite scroll: fired once when the user scrolls within
   * `endReachedThreshold` px of the bottom. Wire it to grow the fetch window
   * (bump the sync-query `limit`) so `rows` extends on demand — the row count
   * never needs a visible cap. Undefined ⇒ no infinite scroll (default). Re-arms
   * once the user scrolls back up, so it fires again for each new page.
   */
  onEndReached?: () => void;
  /** Distance from the bottom (px) that triggers `onEndReached`. Default 1500. */
  endReachedThreshold?: number;
  /**
   * Bring the row with this `getRowId` into view when the value CHANGES — the
   * deep-link / "select it in this list" landing.
   *
   * Virtualization silently breaks the older ways of doing this. A caller that
   * highlights the target row (`getRowBg`) or expands it (`expandedRowKey`) has
   * done nothing observable when the row sits outside the mounted window, and a
   * per-row `scrollIntoView` effect cannot help because the row is not mounted
   * to run one. Only the virtualizer can move to an unmounted index, so the
   * scroll has to be asked for HERE.
   *
   * Semantics that matter:
   * - It fires on CHANGE, not on every render, so the reader can scroll away
   *   from the target and stay there.
   * - A key that is not (yet) in `rows` does NOT latch. The deep-link target is
   *   routinely absent on first paint — the read has not resolved, or a filter
   *   still excludes it — so the scroll is re-attempted when `rows` changes and
   *   lands when the row actually arrives.
   */
  scrollToRowKey?: string | null;
  /** Where the scrolled-to row lands. Default 'center'. */
  scrollToRowAlign?: 'start' | 'center' | 'end' | 'auto';
}

const DEFAULT_SCROLL_STYLE: CSSProperties = { flex: 1, minHeight: 0, overflow: 'auto' };

export default function VirtualGrid<TRow>({
  rows,
  columns,
  getRowId,
  estimateRowHeight,
  overscan = 12,
  measureVariableHeight,
  scrollClassName,
  scrollStyle,
  onEndReached,
  endReachedThreshold = 1500,
  scrollToRowKey = null,
  scrollToRowAlign = 'center',
  rowMinHeight,
  disableCopySupport = false,
  ...richGridProps
}: VirtualGridProps<TRow>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const estimate = estimateRowHeight ?? rowMinHeight ?? 30;
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimate,
    overscan,
  });
  // Re-measure when the row set changes (filter/sort/sync update) so offsets and
  // the total scroll size track the new data.
  useEffect(() => {
    virtualizer.measure();
  }, [rows, virtualizer]);

  // Bring `scrollToRowKey` into view — see the prop doc for why this cannot be
  // done by the row itself under virtualization.
  //
  // `lastScrolled` is the latch. It is set ONLY on a scroll we actually
  // performed, which is what makes the two failure modes distinguishable: a key
  // whose row is missing leaves the latch alone, so the next `rows` change
  // re-attempts it, while a key whose row was found never scrolls twice and the
  // reader keeps control of the viewport. Clearing the target clears the latch,
  // so re-selecting the SAME row later scrolls to it again.
  const lastScrolled = useRef<string | null>(null);
  useEffect(() => {
    if (scrollToRowKey == null) {
      lastScrolled.current = null;
      return;
    }
    if (scrollToRowKey === lastScrolled.current) return;
    const index = rows.findIndex((row) => getRowId(row) === scrollToRowKey);
    if (index < 0) return;
    lastScrolled.current = scrollToRowKey;
    virtualizer.scrollToIndex(index, { align: scrollToRowAlign });
  }, [scrollToRowKey, scrollToRowAlign, rows, getRowId, virtualizer]);

  // Infinite scroll: fire `onEndReached` once per approach to the bottom edge.
  // The latch prevents a single near-bottom dwell from spamming the callback;
  // scrolling back out past the threshold re-arms it for the next page. A short
  // first page cannot emit a scroll event at all, so also check the geometry on
  // mount and when a new row count lands. Keep the latch in refs so callback
  // identity changes and parent re-renders cannot turn those checks into a fetch
  // storm. Mirrors RichGrid's legacy scroll-edge effect (which is inert in
  // virtualMode), but on VirtualGrid's own scroll element.
  const endReachedFired = useRef(false);
  const endReachedRowsLength = useRef<number | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !onEndReached) {
      // Dropping the callback means the caller reached the end of its corpus.
      // Clear the latches so a later cursor can intentionally re-arm.
      endReachedFired.current = false;
      endReachedRowsLength.current = null;
      return;
    }
    const checkEndReached = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (distanceFromBottom < endReachedThreshold) {
        if (
          !endReachedFired.current ||
          endReachedRowsLength.current !== rows.length
        ) {
          endReachedFired.current = true;
          endReachedRowsLength.current = rows.length;
          onEndReached();
        }
      } else {
        endReachedFired.current = false;
        endReachedRowsLength.current = null;
      }
    };
    el.addEventListener('scroll', checkEndReached, { passive: true });
    // Non-overflowing content never generates a scroll event, so evaluate the
    // initial geometry and the geometry after a new page lands as well.
    if (rows.length > 0) checkEndReached();
    return () => el.removeEventListener('scroll', checkEndReached);
  }, [onEndReached, endReachedThreshold, rows.length]);

  // Ctrl+C → TSV + HTML clipboard payload over the FULL row set (RichGrid's own
  // copy handler is on its non-inline wrapper, which we don't render). Built at
  // copy time, so no per-row DOM/render cost. A live text selection wins (the user
  // is grabbing specific text, not rows). Mirrors RichGrid.onCopy.
  const onCopy = useCallback(
    (e: ClipboardEvent<HTMLDivElement>) => {
      if (disableCopySupport || rows.length === 0) return;
      const sel = typeof window !== 'undefined' ? window.getSelection() : null;
      if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) return;
      const { tsv, html } = buildCopyPayloads(columns, rows);
      e.clipboardData.setData('text/plain', tsv);
      e.clipboardData.setData('text/html', html);
      e.preventDefault();
    },
    [columns, rows, disableCopySupport],
  );

  return (
    <div
      ref={scrollRef}
      className={scrollClassName}
      style={scrollClassName ? scrollStyle : { ...DEFAULT_SCROLL_STYLE, ...scrollStyle }}
      tabIndex={disableCopySupport ? undefined : 0}
      onCopy={disableCopySupport ? undefined : onCopy}
    >
      <RichGrid<TRow>
        {...richGridProps}
        columns={columns}
        getRowId={getRowId}
        rowMinHeight={rowMinHeight}
        disableCopySupport
        inline
        virtualMode={{
          virtualizer,
          totalRows: rows.length,
          rowAt: (i) => rows[i],
          measureAll: measureVariableHeight,
        }}
      />
    </div>
  );
}
