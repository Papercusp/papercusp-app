'use client';
/**
 * RichGrid — generic, DOM-based, column-config-driven datagrid.
 *
 * Sibling to DataGridShell (canvas / glide-data-grid). RichGrid uses CSS
 * Grid + divs so each cell can render arbitrary JSX — color-mixed pills,
 * stepper inputs, hover popovers, badges, anything React. Trade-off: caps
 * out around a few thousand rendered rows at a time. For larger sets, pass
 * `virtualMode` and only the visible window mounts.
 *
 * Designed so domain-specific grids (BulkOrderGrid for wholesale procurement,
 * future harness grids, etc.) can be thin specializations that pass:
 *   - their `columns` (with bespoke `render(ctx)` callbacks; ctx = { row, rowIndex, rowBg, isSelected })
 *   - their `rows` or `virtualMode`
 *   - their selection / sort / load-more behaviour
 *
 * What RichGrid owns:
 *   - CSS-grid layout via `gridTemplateColumns` derived from column widths
 *   - Sticky header rendering with sort affordances
 *   - Row-striping / hover background
 *   - Row selection (controlled or uncontrolled)
 *   - Optional virtualization via `@tanstack/virtual-core`
 *   - Optional infinite scroll (`onLoadMore` + threshold)
 *
 * What RichGrid does NOT own:
 *   - Cell content (you write `render(ctx)` per column; destructure `{ row }`)
 *   - Data shape (rows are `TRow`; the only requirement is `getRowId(row)`)
 *   - Business logic (no money formatters, no stepper math, no quote callbacks)
 *
 * This file is intentionally domain-agnostic. Anything specific to wholesale,
 * harness, or any other product should live in the consumer, not here.
 */
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type HTMLAttributes,
  type MutableRefObject,
  type ReactNode,
} from 'react';
import type { Virtualizer } from '@tanstack/virtual-core';
import { GRID_COLORS, getGridThemeVersion, subscribeGridTheme } from './grid-theme';
import { buildCopyPayloads, headerTextFor, cellTextFor } from './copy-payloads';
import type { ColumnFilterSpec } from './column-filter';

// ─── Public API types ───────────────────────────────────────────────────────

export type SortDir = 'asc' | 'desc';

export interface SortState {
  /** Matches ColumnDef.sortKey */
  column: string;
  dir: SortDir;
}

export type ColumnAlign = 'left' | 'center' | 'right';

export interface CellRenderContext<TRow> {
  row: TRow;
  rowIndex: number;
  rowBg: string;
  isSelected: boolean;
}

export interface ColumnDef<TRow> {
  /** Stable identifier used for React keys and the active sort. */
  key: string;
  /** Header content. Can be a string or arbitrary JSX (e.g. icon + label). */
  header: ReactNode;
  /**
   * Plain-text representation of the header for the print mirror + copy
   * payloads (Ctrl+C, paste into Excel). Defaults to `header` if it's a
   * string; if `header` is JSX, supply this for spreadsheet fidelity.
   */
  headerText?: string;
  /**
   * Plain-text representation of this column's value for `row` — used by
   * the print mirror and the Ctrl+C TSV/HTML payload. Optional; columns
   * without it print/copy empty for that cell. Provide whenever the cell
   * has meaningful text (status, name, count); skip when the cell is pure
   * affordance (action buttons, icons).
   */
  toCopyText?: (row: TRow) => string;
  /** Column width as CSS-grid track: number → fr, string → fixed/minmax track. */
  width: number | string;
  /** How cells in this column are aligned. Default 'left'. */
  align?: ColumnAlign;
  /**
   * When set, the column header becomes a sortable button. The value is
   * passed back to `onSortChange` — typically the upstream column name the
   * data source should sort by (DB column, ZQL field, etc.).
   */
  sortKey?: string;
  /** Direction applied on first click. Default 'asc'. */
  defaultSortDir?: SortDir;
  /** Render function for cells in this column. Called per visible row. */
  render: (ctx: CellRenderContext<TRow>) => ReactNode;
  /**
   * Extra style merged onto this column's cell wrapper (after the default
   * align/padding/font). Either a static object or a per-row callback.
   * Use for per-column tinting, gradient backgrounds, custom borders, etc.
   */
  cellStyle?: CSSProperties | ((ctx: CellRenderContext<TRow>) => CSSProperties);
  /** Class name added to this column's HEADER cell. Useful for hover effects. */
  headerClassName?: string;
  /**
   * Opts this column into generic per-column filtering — the symmetric sibling
   * of `sortKey`. The consumer holds the `ColumnFilterState` (typically a nuqs
   * URL param) and calls `applyColumnFilters(rows, state, columns)` before
   * passing rows in; RichGrid renders no filter UI and applies no predicate
   * itself. See `./column-filter`.
   */
  filter?: ColumnFilterSpec<TRow>;
}

export interface VirtualMode<TRow> {
  /** TanStack virtualizer instance. Caller owns sizing + scroll element. */
  virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>;
  /** Total row count for the virtualized window. */
  totalRows: number;
  /** Lookup row by index. Return `undefined` for not-yet-loaded indexes. */
  rowAt: (index: number) => TRow | undefined;
  /**
   * Measure EVERY rendered virtual row, not just the expanded one. By default
   * RichGrid only calls `measureElement` for the expanded row (see
   * `expandedRowKey`/`expandedRowKeys`) and trusts the virtualizer's
   * `estimateSize` for all others — each measurement is a forced layout read in
   * the scroll path, so for uniform-height rows it's pure cost. Opt in when rows
   * are *genuinely* variable height (multi-line summary cards, day-grouped
   * feeds, wrap-on-tags rails): the virtualizer then measures each visible
   * row's real height and keeps offsets exact. Scope is the visible window plus
   * overscan, so the cost is bounded to a few dozen rows per frame.
   */
  measureAll?: boolean;
}

export interface RichGridProps<TRow> {
  /** Column definitions in display order. */
  columns: ColumnDef<TRow>[];

  /** Stable id extractor — required for React keys + selection set. */
  getRowId: (row: TRow) => string;

  /** Legacy mode: render every row in `rows`. Ignored when `virtualMode` is set. */
  rows?: TRow[];

  /** Opt-in virtualization. */
  virtualMode?: VirtualMode<TRow>;

  /** Show a checkbox column on the left for multi-row selection. */
  selectable?: boolean;

  /**
   * Allow the user to drag column borders to resize columns. Opt-in — when
   * off (default) header cells render exactly as before, so existing grids
   * are unaffected. Resized widths live in RichGrid's internal state
   * (reset on remount).
   */
  resizableColumns?: boolean;
  /**
   * Controlled column-width overrides (px, keyed by column key). When
   * provided, RichGrid renders these widths and reports drags through
   * `onColumnWidthsChange` instead of keeping internal state — the same
   * controlled/uncontrolled split as `selectedRowIds`. Lets callers keep
   * resized widths across remounts (see `usePersistedColumnWidths`).
   */
  columnWidths?: Record<string, number>;
  onColumnWidthsChange?: (next: Record<string, number>) => void;
  /** Controlled selection (row IDs). When omitted, selection is uncontrolled. */
  selectedRowIds?: ReadonlySet<string>;
  onSelectedRowIdsChange?: (next: ReadonlySet<string>) => void;

  /** Click handler for a row. Receives the row, index, and the click event. */
  onRowClick?: (row: TRow, index: number, e: React.MouseEvent) => void;

  /**
   * Fires on `mouseenter` / `mouseleave` for each row. On enter, both args
   * are non-null; on leave, both are `null`. Use for hover-driven UI
   * outside the grid (e.g. side panels). For purely visual hover the
   * `getRowBg` callback is usually enough.
   */
  onRowHover?: (row: TRow | null, index: number | null) => void;

  /**
   * Single-row expansion: when set, RichGrid renders `renderExpandedRow(row)`
   * immediately below the row whose id matches `expandedRowKey`. The
   * expanded content is part of the same measured wrapper, so virtualization
   * resizes correctly via `measureElement`. The caller fully owns the state
   * — RichGrid does not toggle on click/hover.
   */
  expandedRowKey?: string | null;
  /**
   * Multi-row expansion: any row whose id is in the set will render the
   * expanded content. Combined with `expandedRowKey` (union), so callers
   * can use either or both depending on UX needs.
   */
  expandedRowKeys?: ReadonlySet<string>;
  renderExpandedRow?: (row: TRow) => ReactNode;

  /**
   * Override the default striping/selected/hovered background for a row.
   * Return a CSS color string to override; return `undefined` to fall back
   * to RichGrid's default (selected → rowHover, alternating bg/rowAlt).
   */
  getRowBg?: (row: TRow, rowIndex: number, isSelected: boolean) => string | undefined;

  /**
   * Returns extra HTML attributes (className, tabIndex, aria-*, focus events,
   * data-*) to spread onto the row root. Use for class-based CSS hooks,
   * keyboard accessibility, focus-driven UI, etc. The default `onClick`,
   * `onMouseEnter`, `onMouseLeave` are merged BEFORE this — return them here
   * to override (rare).
   */
  /** Extra props for the row element. `data-*` attributes are explicitly allowed:
   *  they are valid on any DOM node and are how consumers hang test hooks off a
   *  row, but React's `HTMLAttributes` does not model them, so a bare
   *  `HTMLAttributes` return type rejected `{ 'data-testid': … }`. */
  rowProps?: (
    ctx: CellRenderContext<TRow>,
  ) => HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, string | number | boolean | undefined>;

  /** Extra style merged onto the sticky header row. */
  headerStyle?: CSSProperties;

  /**
   * In virtual mode: render a placeholder for a row whose data hasn't yet
   * loaded (when `rowAt(index)` returns `undefined`). Defaults to a small
   * "loading…" line. Pass a shimmer skeleton to match your theme.
   */
  renderLoadingRow?: (rowIndex: number, gridTemplateColumns: string) => ReactNode;

  /**
   * Captures RichGrid's internal scroll element. Use this when you need to
   * tie an external virtualizer (e.g. `useSyncVirtualizer`) to the same
   * scroll container that RichGrid manages. The ref is populated on mount
   * and cleared on unmount. Ignored in `inline` mode.
   */
  scrollContainerRef?: MutableRefObject<HTMLDivElement | null>;

  /**
   * "Embedded" mode: skip RichGrid's outer flex container AND the internal
   * scroll wrapper. Render only `[topSlot, header, body, footerSlot]` as
   * siblings, suitable for consumers that own their own scroll element
   * (custom backgrounds, sticky overlays, an external virtualizer's
   * `scrollRef`, etc.). The sticky header still works because it pins to
   * the consumer's scroll ancestor. `onLoadMore` is ignored in this mode
   * — the consumer owns scroll-edge detection.
   */
  inline?: boolean;

  /** Current sort state. Pass `null` for "no column sorted". */
  sortState?: SortState | null;
  onSortChange?: (next: SortState | null) => void;

  /** Called when the user scrolls near the bottom (legacy mode only). */
  onLoadMore?: () => void;
  /** Pixels-from-bottom threshold to fire `onLoadMore`. Default 1500. */
  loadMoreThreshold?: number;
  /** When true, renders a "Loading…" affordance at the bottom of the list. */
  isLoadingMore?: boolean;

  /** Optional content rendered above the body (e.g. summary bar). */
  topSlot?: ReactNode;
  /** Optional content rendered below the body (e.g. footer / pagination). */
  footerSlot?: ReactNode;

  /** Empty-state ReactNode shown when rows is empty / virtual total is 0. */
  empty?: ReactNode;

  /** Min row height in px. Default 36. */
  rowMinHeight?: number;
  /** Header height in px. Default 36. */
  headerHeight?: number;

  /** Extra style for the outer container. */
  style?: CSSProperties;
  /** Extra className for the outer container. */
  className?: string;

  /**
   * Print fidelity (Pattern A: print-only `<table>` mirror).
   *
   * On `@media print`, RichGrid's virtualized div tree only contains the
   * rows currently in view — which prints as a snapshot of the viewport,
   * not the dataset. To fix that, RichGrid renders a hidden native `<table>`
   * alongside the grid; on print, the virtualized grid hides and the
   * native table shows. The browser handles pagination + repeating `<thead>`.
   *
   * Default: enabled for legacy (non-virtual) mode. In virtual mode,
   * pass `printRows` with the full dataset to also enable; otherwise the
   * print mirror is skipped (and Ctrl+P prints just the viewport).
   */
  disablePrintMirror?: boolean;
  /**
   * Virtual-mode only: the full dataset for the print mirror. RichGrid's
   * normal `rowAt(index)` API is for lazy loading; printing needs every
   * row up front. If omitted in virtual mode, no print mirror is rendered.
   */
  printRows?: TRow[];

  /**
   * Copy support (Ctrl+C → TSV + HTML clipboard payload).
   *
   * When the grid root has keyboard focus, Ctrl+A selects all rows and
   * Ctrl+C copies the current row selection (or all rows if none selected)
   * to the clipboard as both TSV (`text/plain`) and `<table>` markup
   * (`text/html`). Excel / Sheets prefer the HTML payload and paste rows
   * into cells correctly; plain editors get TSV.
   *
   * Default: enabled. Set `disableCopySupport` to opt out for grids where
   * Ctrl+C should fall through to native browser text selection.
   */
  disableCopySupport?: boolean;
}

// ─── Print mirror style injection ───────────────────────────────────────────

/**
 * One-time CSS injection for the print mirror. Lives in the global stylesheet
 * because @media print rules can't go in inline style. Idempotent — calling
 * from multiple RichGrid instances on the same page injects once.
 */
const PRINT_MIRROR_STYLE_ID = '__rg_print_mirror_css';
const PRINT_MIRROR_CSS = `
[data-rg-print-mirror] { display: none; }
@media print {
  [data-rg-screen-grid] { display: none !important; }
  [data-rg-print-mirror] { display: table !important; width: 100%; border-collapse: collapse; }
  [data-rg-print-mirror] thead { display: table-header-group; }
  [data-rg-print-mirror] tr { break-inside: avoid; page-break-inside: avoid; }
  [data-rg-print-mirror] th,
  [data-rg-print-mirror] td {
    border: 1px solid #ccc;
    padding: 4px 6px;
    text-align: left;
    font-size: 11px;
    color: #000;
  }
  [data-rg-print-mirror] th { background: #eee; font-weight: 600; }
}
`;

function ensurePrintMirrorStyleInjected(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(PRINT_MIRROR_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = PRINT_MIRROR_STYLE_ID;
  style.textContent = PRINT_MIRROR_CSS;
  document.head.appendChild(style);
}

// ─── Internal helpers ───────────────────────────────────────────────────────

function justifyFor(align: ColumnAlign | undefined): CSSProperties['justifyContent'] {
  if (align === 'right') return 'flex-end';
  if (align === 'center') return 'center';
  return 'flex-start';
}

function textAlignFor(align: ColumnAlign | undefined): CSSProperties['textAlign'] {
  return align ?? 'left';
}

function rowBgFor(index: number, isSelected: boolean): string {
  if (isSelected) return GRID_COLORS.rowHover;
  return index % 2 === 0 ? GRID_COLORS.bg : GRID_COLORS.rowAlt;
}

/** Min width (px) a column can be dragged to when resizing. */
const MIN_COL_WIDTH = 40;

function buildGridTemplate(
  columns: ColumnDef<unknown>[],
  hasSelectionCol: boolean,
  overrides: Record<string, number> = {},
): string {
  const tracks: string[] = [];
  if (hasSelectionCol) tracks.push('40px');
  for (const c of columns) {
    const ov = overrides[c.key];
    if (typeof ov === 'number') tracks.push(`${ov}px`);
    else tracks.push(typeof c.width === 'number' ? `${c.width}fr` : c.width);
  }
  return tracks.join(' ');
}

// ─── Sort icon ──────────────────────────────────────────────────────────────

function SortIcon({ state }: { state: 'inactive' | 'asc' | 'desc' }) {
  const upColor = state === 'asc' ? GRID_COLORS.text : GRID_COLORS.muted;
  const downColor = state === 'desc' ? GRID_COLORS.text : GRID_COLORS.muted;
  return (
    <span
      style={{
        display: 'inline-flex',
        flexDirection: 'column',
        gap: 1,
        marginLeft: 4,
        opacity: state === 'inactive' ? 0.4 : 1,
      }}
      aria-hidden="true"
    >
      <span style={{ width: 0, height: 0, borderLeft: '3px solid transparent', borderRight: '3px solid transparent', borderBottom: `4px solid ${upColor}` }} />
      <span style={{ width: 0, height: 0, borderLeft: '3px solid transparent', borderRight: '3px solid transparent', borderTop: `4px solid ${downColor}` }} />
    </span>
  );
}

// ─── Header cell ────────────────────────────────────────────────────────────

interface HeaderCellProps<TRow> {
  col: ColumnDef<TRow>;
  sortState: SortState | null | undefined;
  onSortChange?: (next: SortState | null) => void;
  /** Show a drag handle on the right edge to resize this column. */
  resizable?: boolean;
  /** Called during a resize drag with the column key + new px width. */
  onResize?: (key: string, width: number) => void;
}

function HeaderCell<TRow>({ col, sortState, onSortChange, resizable, onResize }: HeaderCellProps<TRow>) {
  const cellRef = useRef<HTMLElement | null>(null);
  const setCellRef = (el: HTMLElement | null) => {
    cellRef.current = el;
  };
  const sortable = !!col.sortKey && !!onSortChange;
  const active = sortable && sortState?.column === col.sortKey;
  const iconState: 'inactive' | 'asc' | 'desc' = active ? sortState!.dir : 'inactive';
  // Resize-handle affordance: hover highlights the divider; a drag keeps it
  // highlighted even when the pointer drifts off the 7px hit strip.
  const [handleHover, setHandleHover] = useState(false);
  const [handleDrag, setHandleDrag] = useState(false);

  const cellStyle: CSSProperties = {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: justifyFor(col.align),
    padding: '0 10px',
    fontSize: 12,
    fontWeight: 600,
    color: GRID_COLORS.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    userSelect: 'none',
  };

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = cellRef.current?.getBoundingClientRect().width ?? 0;
    const move = (ev: PointerEvent) => {
      onResize?.(col.key, Math.max(MIN_COL_WIDTH, Math.round(startW + (ev.clientX - startX))));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
      setHandleDrag(false);
    };
    document.body.style.cursor = 'col-resize';
    setHandleDrag(true);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // The hit strip stays 7px wide; the visible affordance is a divider line
  // hugging the column edge — always present so column boundaries (and that
  // they're grabbable) are discoverable, accent-highlighted while hovered
  // or dragging.
  const handleActive = handleHover || handleDrag;
  const handle = resizable ? (
    <div
      onPointerDown={startResize}
      onPointerEnter={() => setHandleHover(true)}
      onPointerLeave={() => setHandleHover(false)}
      onClick={(e) => e.stopPropagation()}
      aria-hidden="true"
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        height: '100%',
        width: 7,
        cursor: 'col-resize',
        touchAction: 'none',
        zIndex: 3,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
      }}
    >
      <span
        style={{
          width: handleActive ? 3 : 1,
          height: handleActive ? '100%' : '60%',
          borderRadius: 2,
          background: handleActive ? GRID_COLORS.blue : GRID_COLORS.border,
          transition: 'background-color 100ms ease, width 100ms ease, height 100ms ease',
        }}
      />
    </div>
  ) : null;

  if (!sortable) {
    return (
      <div ref={setCellRef} className={col.headerClassName} style={cellStyle}>
        {col.header}
        {handle}
      </div>
    );
  }

  return (
    <button
      ref={setCellRef}
      type="button"
      className={col.headerClassName}
      onClick={() => {
        if (!onSortChange) return;
        const defaultDir = col.defaultSortDir ?? 'asc';
        if (!active) {
          onSortChange({ column: col.sortKey!, dir: defaultDir });
        } else if (sortState!.dir === defaultDir) {
          onSortChange({ column: col.sortKey!, dir: defaultDir === 'asc' ? 'desc' : 'asc' });
        } else {
          onSortChange(null);
        }
      }}
      style={{
        ...cellStyle,
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
        color: active ? GRID_COLORS.text : GRID_COLORS.muted,
      }}
    >
      {col.header}
      <SortIcon state={iconState} />
      {handle}
    </button>
  );
}

// ─── Body row ───────────────────────────────────────────────────────────────

interface BodyRowProps<TRow> {
  row: TRow;
  rowIndex: number;
  isSelected: boolean;
  rowId: string;
  columns: ColumnDef<TRow>[];
  gridTemplateColumns: string;
  selectable: boolean;
  rowMinHeight: number;
  bg: string;
  onRowClick?: (row: TRow, index: number, e: React.MouseEvent) => void;
  // Take the row + index so the caller's callback can stay
  // identity-stable across renders. BodyRow assembles its own
  // mouse-enter/leave handlers internally — that way, when the
  // parent re-renders, BodyRow's props (especially onRowHover)
  // stay equal and React.memo skips the row.
  onRowHover?: (row: TRow | null, index: number | null) => void;
  onSelectChange?: (rowId: string, next: boolean) => void;
  expanded?: ReactNode;
  extraRowProps?: HTMLAttributes<HTMLDivElement>;
}

// Memoized so visible rows that haven't actually changed don't re-render
// when the parent's hover / selection state ticks. The wholesale page
// flips `hoveredId` on every mouse-move, which without memo cascades into
// re-rendering every row in the visible window. With memo + stable prop
// references in the parent, only the previously-hovered and currently-
// hovered rows re-render — the rest stay identity-stable. Custom
// equality treats the `columns` array as immutable (caller memoizes it)
// and skips deep comparisons.
function BodyRowImpl<TRow>({
  row,
  rowIndex,
  isSelected,
  rowId,
  columns,
  gridTemplateColumns,
  selectable,
  rowMinHeight,
  bg,
  onRowClick,
  onRowHover,
  onSelectChange,
  expanded,
  extraRowProps,
}: BodyRowProps<TRow>) {
  const ctx: CellRenderContext<TRow> = { row, rowIndex, rowBg: bg, isSelected };
  const { style: extraStyle, ...restExtra } = extraRowProps ?? {};
  return (
    <div
      role="row"
      onClick={(e) => onRowClick?.(row, rowIndex, e)}
      onMouseEnter={onRowHover ? () => onRowHover(row, rowIndex) : undefined}
      onMouseLeave={onRowHover ? () => onRowHover(null, null) : undefined}
      {...restExtra}
      style={{
        background: bg,
        borderBottom: `1px solid ${GRID_COLORS.border}`,
        cursor: onRowClick ? 'pointer' : 'default',
        // contain:layout paint — row's layout/paint is contained, so a
        // hover bg-color change on row N doesn't trigger reflow of N±1.
        contain: 'layout paint',
        ...extraStyle,
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns,
          background: bg,
          minHeight: rowMinHeight,
        }}
      >
        {selectable && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '0 6px',
            }}
          >
            <input
              type="checkbox"
              checked={isSelected}
              onChange={(e) => onSelectChange?.(rowId, e.target.checked)}
              onClick={(e) => e.stopPropagation()}
              aria-label="Select row"
            />
          </div>
        )}
        {columns.map((col) => {
          const extra =
            typeof col.cellStyle === 'function'
              ? col.cellStyle(ctx)
              : col.cellStyle;
          return (
            <div
              key={col.key}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: justifyFor(col.align),
                textAlign: textAlignFor(col.align),
                padding: '0 10px',
                fontSize: 13,
                color: GRID_COLORS.text,
                overflow: 'hidden',
                ...extra,
              }}
            >
              {col.render(ctx)}
            </div>
          );
        })}
      </div>
      {expanded}
    </div>
  );
}
const BodyRow = memo(BodyRowImpl) as typeof BodyRowImpl;

// ─── Main component ─────────────────────────────────────────────────────────

export default function RichGrid<TRow>(props: RichGridProps<TRow>) {
  useSyncExternalStore(subscribeGridTheme, getGridThemeVersion, getGridThemeVersion);

  const {
    columns,
    getRowId,
    rows,
    virtualMode,
    selectable = false,
    resizableColumns = false,
    columnWidths: controlledWidths,
    onColumnWidthsChange,
    selectedRowIds: controlledSelected,
    onSelectedRowIdsChange,
    onRowClick,
    onRowHover,
    expandedRowKey = null,
    expandedRowKeys,
    renderExpandedRow,
    getRowBg,
    rowProps,
    headerStyle,
    renderLoadingRow,
    scrollContainerRef,
    inline = false,
    sortState = null,
    onSortChange,
    onLoadMore,
    loadMoreThreshold = 1500,
    isLoadingMore = false,
    topSlot,
    footerSlot,
    empty,
    rowMinHeight = 36,
    headerHeight = 36,
    style,
    className,
    disablePrintMirror = false,
    printRows,
    disableCopySupport = false,
  } = props;

  const resolveRowBg = useCallback(
    (row: TRow, rowIndex: number, isSelected: boolean): string => {
      const custom = getRowBg?.(row, rowIndex, isSelected);
      return custom ?? rowBgFor(rowIndex, isSelected);
    },
    [getRowBg],
  );

  const renderExpandedFor = useCallback(
    (row: TRow, rowId: string): ReactNode => {
      if (!renderExpandedRow) return null;
      const isOpen = expandedRowKey === rowId || expandedRowKeys?.has(rowId);
      if (!isOpen) return null;
      return renderExpandedRow(row);
    },
    [renderExpandedRow, expandedRowKey, expandedRowKeys],
  );

  // Uncontrolled selection fallback.
  const [uncontrolled, setUncontrolled] = useState<ReadonlySet<string>>(() => new Set());
  const selectedRowIds = controlledSelected ?? uncontrolled;
  // Latest-value refs so the selection callbacks below can stay IDENTITY-STABLE
  // across renders. `selectedRowIds` (and the controlled props) are typically a
  // fresh Set each render; if `setSelectedRowIds` / `handleRowSelect` closed over
  // them directly they'd change identity every render and — being passed to every
  // BodyRow — would defeat memo(BodyRow) on every selection toggle, re-rendering
  // the whole visible window instead of just the rows whose selection flipped.
  const selectedRowIdsRef = useRef(selectedRowIds);
  selectedRowIdsRef.current = selectedRowIds;
  const controlledSelectedRef = useRef(controlledSelected);
  controlledSelectedRef.current = controlledSelected;
  const onSelectedRowIdsChangeRef = useRef(onSelectedRowIdsChange);
  onSelectedRowIdsChangeRef.current = onSelectedRowIdsChange;
  const setSelectedRowIds = useCallback((next: ReadonlySet<string>) => {
    if (controlledSelectedRef.current !== undefined) {
      onSelectedRowIdsChangeRef.current?.(next);
    } else {
      setUncontrolled(next);
      onSelectedRowIdsChangeRef.current?.(next);
    }
  }, []);

  const handleRowSelect = useCallback(
    (rowId: string, checked: boolean) => {
      const next = new Set(selectedRowIdsRef.current);
      if (checked) next.add(rowId);
      else next.delete(rowId);
      setSelectedRowIds(next);
    },
    [setSelectedRowIds],
  );

  // Per-column px width overrides set by dragging the header resize handles.
  // Controlled when `columnWidths` is provided (the caller owns + persists the
  // map), internal otherwise — the same split as the selection props.
  const [internalWidths, setInternalWidths] = useState<Record<string, number>>({});
  const widthOverrides = controlledWidths ?? internalWidths;
  // Ref so the drag-loop merge sees the latest map (pointermove outpaces the
  // controlled-parent re-render) without re-binding the handler per move.
  const widthOverridesRef = useRef(widthOverrides);
  widthOverridesRef.current = widthOverrides;
  const handleColumnResize = useCallback(
    (key: string, width: number) => {
      if (onColumnWidthsChange) {
        const cur = widthOverridesRef.current;
        if (cur[key] !== width) onColumnWidthsChange({ ...cur, [key]: width });
        return;
      }
      setInternalWidths((prev) => (prev[key] === width ? prev : { ...prev, [key]: width }));
    },
    [onColumnWidthsChange],
  );

  const gridTemplateColumns = useMemo(
    () => buildGridTemplate(columns as ColumnDef<unknown>[], selectable, widthOverrides),
    [columns, selectable, widthOverrides],
  );

  const isVirtual = !!virtualMode;
  const totalRows = isVirtual ? virtualMode!.totalRows : (rows?.length ?? 0);
  const isEmpty = totalRows === 0;

  // Legacy-mode infinite scroll.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const loadMoreFiredRef = useRef(false);
  useEffect(() => {
    if (isVirtual || !onLoadMore) return;
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (distanceFromBottom < loadMoreThreshold) {
        if (!loadMoreFiredRef.current) {
          loadMoreFiredRef.current = true;
          onLoadMore();
        }
      } else {
        loadMoreFiredRef.current = false;
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [isVirtual, onLoadMore, loadMoreThreshold]);

  // Header
  const header = (
    <div
      role="row"
      style={{
        display: 'grid',
        gridTemplateColumns,
        background: GRID_COLORS.headerBg,
        borderBottom: `1px solid ${GRID_COLORS.border}`,
        position: 'sticky',
        top: 0,
        zIndex: 2,
        minHeight: headerHeight,
        ...headerStyle,
      }}
    >
      {selectable && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <input
            type="checkbox"
            aria-label="Select all rows"
            checked={
              !isEmpty &&
              !isVirtual &&
              !!rows &&
              selectedRowIds.size === rows.length &&
              rows.every((r) => selectedRowIds.has(getRowId(r)))
            }
            onChange={(e) => {
              if (!rows) return;
              if (e.target.checked) {
                setSelectedRowIds(new Set(rows.map(getRowId)));
              } else {
                setSelectedRowIds(new Set());
              }
            }}
            disabled={isVirtual || !rows}
          />
        </div>
      )}
      {columns.map((col) => (
        <HeaderCell
          key={col.key}
          col={col}
          sortState={sortState}
          onSortChange={onSortChange}
          resizable={resizableColumns}
          onResize={handleColumnResize}
        />
      ))}
    </div>
  );

  // Body — legacy or virtualized
  let body: ReactNode;
  if (isEmpty) {
    body = (
      <div style={{ padding: 24, color: GRID_COLORS.muted, textAlign: 'center', fontSize: 13 }}>
        {empty ?? 'No data'}
      </div>
    );
  } else if (isVirtual) {
    const items = virtualMode!.virtualizer.getVirtualItems();
    body = (
      <div style={{ position: 'relative', height: virtualMode!.virtualizer.getTotalSize() }}>
        {items.map((vi) => {
          const row = virtualMode!.rowAt(vi.index);
          if (!row) {
            return (
              <div
                key={vi.key}
                data-index={vi.index}
                ref={(el) => {
                  if (el) virtualMode!.virtualizer.measureElement(el);
                }}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${vi.start}px)`,
                }}
              >
                {renderLoadingRow ? (
                  renderLoadingRow(vi.index, gridTemplateColumns)
                ) : (
                  <div
                    style={{
                      minHeight: rowMinHeight,
                      borderBottom: `1px solid ${GRID_COLORS.border}`,
                      background: rowBgFor(vi.index, false),
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: GRID_COLORS.muted,
                      fontSize: 12,
                    }}
                  >
                    loading…
                  </div>
                )}
              </div>
            );
          }
          const rowId = getRowId(row);
          // By default only the row currently expanded has variable height (its
          // expanded panel can grow). Other rows are fixed at rowMinHeight, so
          // skip measureElement for them — every measurement is a forced layout
          // read in the scroll path. When the caller opts into `measureAll`
          // (genuinely variable-height rows), measure every visible row instead.
          const isExpandedRow = expandedRowKey === rowId || (expandedRowKeys?.has(rowId) ?? false);
          const measureThisRow = isExpandedRow || virtualMode!.measureAll === true;
          return (
            <div
              key={vi.key}
              data-index={vi.index}
              ref={
                measureThisRow
                  ? (el) => {
                      if (el) virtualMode!.virtualizer.measureElement(el);
                    }
                  : undefined
              }
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${vi.start}px)`,
              }}
            >
              <BodyRow
                row={row}
                rowIndex={vi.index}
                isSelected={selectedRowIds.has(rowId)}
                rowId={rowId}
                columns={columns}
                gridTemplateColumns={gridTemplateColumns}
                selectable={selectable}
                rowMinHeight={rowMinHeight}
                bg={resolveRowBg(row, vi.index, selectedRowIds.has(rowId))}
                onRowClick={onRowClick}
                onRowHover={onRowHover}
                onSelectChange={handleRowSelect}
                expanded={renderExpandedFor(row, rowId)}
                extraRowProps={
                  rowProps?.({
                    row,
                    rowIndex: vi.index,
                    rowBg: resolveRowBg(row, vi.index, selectedRowIds.has(rowId)),
                    isSelected: selectedRowIds.has(rowId),
                  })
                }
              />
            </div>
          );
        })}
      </div>
    );
  } else {
    body = (
      <>
        {(rows ?? []).map((row, idx) => {
          const rowId = getRowId(row);
          return (
            <BodyRow
              key={rowId}
              row={row}
              rowIndex={idx}
              isSelected={selectedRowIds.has(rowId)}
              rowId={rowId}
              columns={columns}
              gridTemplateColumns={gridTemplateColumns}
              selectable={selectable}
              rowMinHeight={rowMinHeight}
              bg={resolveRowBg(row, idx, selectedRowIds.has(rowId))}
              onRowClick={onRowClick}
              onRowHover={onRowHover}
              onSelectChange={handleRowSelect}
              expanded={renderExpandedFor(row, rowId)}
              extraRowProps={
                rowProps?.({
                  row,
                  rowIndex: idx,
                  rowBg: resolveRowBg(row, idx, selectedRowIds.has(rowId)),
                  isSelected: selectedRowIds.has(rowId),
                })
              }
            />
          );
        })}
        {isLoadingMore && (
          <div
            style={{
              padding: 12,
              textAlign: 'center',
              color: GRID_COLORS.muted,
              fontSize: 12,
            }}
          >
            loading more…
          </div>
        )}
      </>
    );
  }

  // ─── Print mirror + copy support ──────────────────────────────────────────

  // The full row set for print + copy:
  //   - legacy mode → `rows` (the only source we have)
  //   - virtual mode → `printRows` if the caller supplied one, else null
  //
  // Notes on memo: when neither rows nor printRows change, we want the
  // payload-building closures (copyHandler) to stay identity-stable.
  const printableRows: readonly TRow[] | null = virtualMode
    ? printRows ?? null
    : rows ?? null;
  const printMirrorEnabled =
    !disablePrintMirror && printableRows !== null && printableRows.length > 0;

  // Inject the print stylesheet once, lazily on first instance that needs it.
  useEffect(() => {
    if (printMirrorEnabled) ensurePrintMirrorStyleInjected();
  }, [printMirrorEnabled]);

  // Copy handler — wired as a `copy` listener on the root container. Builds
  // both TSV and HTML payloads. Selection priority:
  //   1. selectedRowIds (if any selected)
  //   2. browser text selection (if user selected text inside the grid) —
  //      we let the browser handle that case natively
  //   3. all rows (Ctrl+A or empty selection but user wants a full copy)
  const onCopy = useCallback(
    (e: React.ClipboardEvent<HTMLDivElement>) => {
      if (disableCopySupport) return;
      // If the user has a non-empty text range selected, let the browser
      // handle the copy (they're trying to grab specific text, not rows).
      const sel = typeof window !== 'undefined' ? window.getSelection() : null;
      if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) return;
      const baseRows = printableRows;
      if (!baseRows || baseRows.length === 0) return;
      const selected =
        selectedRowIds.size > 0
          ? baseRows.filter((r) => selectedRowIds.has(getRowId(r)))
          : baseRows;
      if (selected.length === 0) return;
      const { tsv, html } = buildCopyPayloads(columns, selected);
      e.clipboardData.setData('text/plain', tsv);
      e.clipboardData.setData('text/html', html);
      e.preventDefault();
    },
    [columns, disableCopySupport, getRowId, printableRows, selectedRowIds],
  );

  // Ctrl+A in the grid → select all rows (so the next Ctrl+C copies them).
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (disableCopySupport) return;
      const isMac =
        typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
      const ctrlOrMeta = isMac ? e.metaKey : e.ctrlKey;
      if (!(ctrlOrMeta && (e.key === 'a' || e.key === 'A'))) return;
      // Only intercept if focus is in the grid root itself, not in a
      // child input/select/textarea (where Ctrl+A should select text).
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      const baseRows = printableRows;
      if (!baseRows || baseRows.length === 0) return;
      e.preventDefault();
      setSelectedRowIds(new Set(baseRows.map(getRowId)));
    },
    [disableCopySupport, getRowId, printableRows, setSelectedRowIds],
  );

  // Print mirror — a hidden native `<table>` next to the grid. Browser uses
  // it on print; CSS in PRINT_MIRROR_CSS swaps display on @media print.
  const printMirror = printMirrorEnabled ? (
    <table data-rg-print-mirror aria-hidden="true">
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c.key}>{headerTextFor(c)}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {printableRows!.map((row) => (
          <tr key={getRowId(row)}>
            {columns.map((c) => (
              <td key={c.key}>{cellTextFor(c, row)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  ) : null;

  if (inline) {
    // Inline mode: the consumer owns the outer container (and the scroll
    // element), so there's no place to hang the screen-grid hide rule. We
    // skip the print mirror + copy support here; consumers in inline mode
    // who need them should add an outer wrapper themselves (and they can
    // do their own copy handling on it).
    return (
      <>
        {topSlot}
        {header}
        {body}
        {footerSlot}
      </>
    );
  }

  return (
    <div
      className={className}
      data-rg-screen-grid
      tabIndex={disableCopySupport ? undefined : 0}
      onCopy={disableCopySupport ? undefined : onCopy}
      onKeyDown={disableCopySupport ? undefined : onKeyDown}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: GRID_COLORS.bg,
        color: GRID_COLORS.text,
        fontFamily: GRID_COLORS.font,
        outline: 'none',
        ...style,
      }}
    >
      {topSlot}
      <div
        ref={(el) => {
          scrollRef.current = el;
          if (scrollContainerRef) scrollContainerRef.current = el;
        }}
        style={{ flex: 1, overflow: 'auto', position: 'relative' }}
      >
        {header}
        {body}
      </div>
      {footerSlot}
      {printMirror}
    </div>
  );
}
