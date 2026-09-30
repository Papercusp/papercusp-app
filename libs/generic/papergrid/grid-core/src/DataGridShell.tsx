'use client';
/**
 * Wrapper around `@glideapps/glide-data-grid` that takes a simple
 * (headers, data) interface and resolves nested column paths against the
 * row objects.
 *
 * Why a wrapper:
 *  - Glide DG's native API is verbose: column definitions, getCellContent
 *    callback, manual measurement, etc. We use a flat (`headers: string[]`)
 *    column-config style that's easier to author and matches the user's
 *    existing tooling format.
 *  - The wrapper handles the dot-path resolution, blank-spacer columns,
 *    title humanization, and dark-theme integration in one place. Pages
 *    just import the config + data and drop this in.
 *
 * The component is client-only (Glide DG uses canvas + DOM measurements
 * which don't work in SSR).
 */
import {
  CompactSelection,
  DataEditor,
  GridCellKind,
  type BooleanCell,
  type CellClickedEventArgs,
  type EditableGridCell,
  type GridCell,
  type GridColumn,
  type GridMouseEventArgs,
  type GridSelection,
  type Highlight,
  type Item,
  type NumberCell,
  type TextCell,
  type Theme,
} from '@glideapps/glide-data-grid';
import '@glideapps/glide-data-grid/dist/index.css';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  evaluateFormatter,
  formatCellValue,
  normalizeColumns,
  pathToTitle,
  resolveColor,
  resolvePath,
  type CellStyle,
  type ColumnFormatter,
  type ColumnPath,
  type GridColumnDef,
  type GridConfig,
} from './grid-config';
import {
  GRID_COLORS,
  getGridThemeVersion,
  glideTheme,
  subscribeGridTheme,
  EDIT_INPUT_STYLE,
  STEPPER_BTN_STYLE,
  STEPPER_PILL_STYLE,
  STEPPER_GLOBAL_CSS,
} from './grid-theme';

export interface ButtonDef {
  label: string;
  onClick: () => void;
  /** Maps to the button's className — matches the dashboard's existing CSS conventions. */
  variant?: 'primary' | 'danger';
  disabled?: boolean;
  style?: React.CSSProperties;
}

export interface DataGridShellProps {
  /**
   * Either a full GridConfig (preferred — picks up widths and formatters)
   * or just the headers array for the simple case.
   */
  config?: GridConfig;
  headers?: ColumnPath[] | GridColumnDef[];
  /** Row objects. The wrapper resolves each header's path against each row. */
  data: any[];
  /**
   * Virtual mode: provide `getRow` + `rowCount` instead of a full `data` array.
   * When `getRow` is set, `data` is ignored for cell rendering — rows are fetched
   * on demand via this callback. Return undefined for not-yet-loaded rows.
   */
  getRow?: (index: number) => any | undefined;
  /** Total number of rows when using virtual mode (`getRow`). */
  rowCount?: number;
  /** Page title rendered above the grid. */
  title?: string;
  /** Optional subtitle shown below the title (e.g. usage hints). */
  subtitle?: string;
  /**
   * Action buttons rendered to the right of the title. Parents supply onClick
   * handlers; this component only handles layout and rendering.
   */
  buttons?: ButtonDef[];
  /** Container height. Defaults to filling the available main-area space. */
  height?: number | string;
  /** When true, renders a semi-transparent overlay over the grid canvas. */
  loading?: boolean;

  // ── Editing support ──────────────────────────────────────────────────────────
  /**
   * Column paths that should be editable inline. When a user commits a cell
   * edit in one of these columns, `onCellEdited` is called.
   */
  editableColumns?: string[];
  /**
   * Column paths (subset of editableColumns) that should render as an integer
   * stepper (− / number / +) instead of a plain text input when editing.
   * The cell value must be parseable as an integer.
   */
  numberColumns?: string[];
  /**
   * Column paths that should render as a native checkbox (GridCellKind.Boolean).
   * The row data value must be a boolean (or coercible to one).
   * Toggle fires `onCellEdited(path, rowIdx, 'true' | 'false')`.
   * These columns must also appear in `editableColumns` to be interactive.
   */
  booleanColumns?: string[];
  /**
   * Called when the user commits an edit to an editable cell.
   * @param colPath  The column path string (matches `editableColumns` entry).
   * @param rowIndex Zero-based row index.
   * @param newValue The string value the user typed / stepped to.
   */
  onCellEdited?: (colPath: string, rowIndex: number, newValue: string) => void;

  // ── Selection support ─────────────────────────────────────────────────────────
  /**
   * Called whenever the grid selection changes. Provides the set of selected
   * row indices so parents can drive summary bars or action buttons.
   */
  onRowSelectionChange?: (selectedIndices: Set<number>) => void;
  /** Called when the user clicks any cell in a row. Receives row index + raw row object. */
  onRowClick?: (rowIndex: number, row: any) => void;
  /** When true, hides the row markers column entirely (no checkbox, no numbers). */
  hideRowMarkers?: boolean;
}

// ─── Editor components ────────────────────────────────────────────────────────

/**
 * Custom editor for plain-text editable cells.
 * Replaces the default Glide DG overlay with a styled input matching
 * BulkOrderGrid's target-price input appearance.
 */
const StyledTextEditor: React.FunctionComponent<{
  readonly onChange: (newValue: GridCell) => void;
  readonly onFinishedEditing: (newValue?: GridCell, movement?: readonly [-1 | 0 | 1, -1 | 0 | 1]) => void;
  readonly isHighlighted: boolean;
  readonly value: GridCell;
  readonly initialValue?: string;
  readonly forceEditMode: boolean;
  readonly theme: Theme;
  readonly [key: string]: any;
}> = ({ value, onChange, onFinishedEditing, initialValue }) => {
  const cell = value as TextCell;
  const [text, setText] = useState(initialValue ?? cell.data ?? '');

  return (
    <input
      type="text"
      value={text}
      autoFocus
      onFocus={e => e.target.select()}
      onChange={e => {
        setText(e.target.value);
        onChange({ ...cell, data: e.target.value, displayData: e.target.value } as GridCell);
      }}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === 'Escape') onFinishedEditing(undefined);
      }}
      style={EDIT_INPUT_STYLE}
    />
  );
};
StyledTextEditor.displayName = 'StyledTextEditor';

/**
 * Custom editor for integer columns.
 * Renders a BulkOrderGrid-style pill stepper: − / input / +.
 */
const StepperEditor: React.FunctionComponent<{
  readonly onChange: (newValue: GridCell) => void;
  readonly onFinishedEditing: (newValue?: GridCell, movement?: readonly [-1 | 0 | 1, -1 | 0 | 1]) => void;
  readonly isHighlighted: boolean;
  readonly value: GridCell;
  readonly initialValue?: string;
  readonly forceEditMode: boolean;
  readonly theme: Theme;
  readonly [key: string]: any;
}> = ({ value, onChange, onFinishedEditing }) => {
  const cell = value as NumberCell;
  const current = cell.data ?? 0;

  const update = (n: number) => {
    const safe = Math.max(0, n);
    onChange({ ...cell, data: safe, displayData: String(safe) } as GridCell);
  };

  return (
    <>
      {/* global once — fine to inject multiple times, browser deduplicates */}
      <style dangerouslySetInnerHTML={{ __html: STEPPER_GLOBAL_CSS }} />
      <div style={STEPPER_PILL_STYLE}>
        <button
          type="button"
          className="gdg-stepper-btn"
          style={{ ...STEPPER_BTN_STYLE, opacity: current === 0 ? 0.35 : 1 }}
          onClick={() => update(current - 1)}
          disabled={current === 0}
        >
          &minus;
        </button>
        <input
          type="number"
          min={0}
          step={1}
          value={current === 0 ? '' : current}
          placeholder="0"
          autoFocus
          className="gdg-stepper-input"
          onChange={e => update(parseInt(e.target.value, 10) || 0)}
          onKeyDown={e => { if (e.key === 'Enter') onFinishedEditing(undefined); }}
          style={{
            width: 44,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            textAlign: 'center' as const,
            fontFamily: GRID_COLORS.font,
            fontSize: 13,
            fontWeight: 500,
            color: current === 0 ? GRID_COLORS.muted : GRID_COLORS.text,
            fontVariantNumeric: 'tabular-nums',
          }}
        />
        <button
          type="button"
          className="gdg-stepper-btn"
          style={STEPPER_BTN_STYLE}
          onClick={() => update(current + 1)}
        >
          +
        </button>
      </div>
    </>
  );
};
StepperEditor.displayName = 'StepperEditor';

// ─── Main component ───────────────────────────────────────────────────────────

export default function DataGridShell({
  config,
  headers,
  data,
  getRow: getRowProp,
  rowCount: rowCountProp,
  title,
  subtitle,
  buttons,
  height = 'calc(100vh - 140px)',
  loading,
  editableColumns,
  numberColumns,
  booleanColumns,
  onCellEdited,
  onRowSelectionChange,
  onRowClick,
  hideRowMarkers,
}: DataGridShellProps) {
  useSyncExternalStore(subscribeGridTheme, getGridThemeVersion, getGridThemeVersion);

  // Virtual mode: getRow + rowCount override data array
  const resolveRow = getRowProp ?? ((idx: number) => data[idx]);
  const effectiveRowCount = rowCountProp ?? data.length;
  // Unique class for scoping cursor override
  const clickableClass = onRowClick ? 'gdg-clickable-rows' : undefined;
  const effectiveHeaders = config?.headers ?? headers ?? [];
  const widthsMap = config?.widths;
  const formattersMap = config?.formatters;

  const cols = useMemo(() => normalizeColumns(effectiveHeaders), [effectiveHeaders]);

  // ── Auto-size: measure every header + cell value on an off-screen canvas ───────────
  const autoWidths = useMemo(() => {
    if (typeof document === 'undefined') return {} as Record<string, number>;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return {} as Record<string, number>;
    const FONT_CELL   = `13px ${GRID_COLORS.font}`;
    const FONT_HEADER = `600 11px ${GRID_COLORS.font}`;
    const PADDING = 32; // 2 × cellHorizontalPadding (14) + 4px breathing room
    const result: Record<string, number> = {};
    for (const col of cols) {
      if (!col.path) continue;
      ctx.font = FONT_HEADER;
      let maxW = ctx.measureText(col.title ?? pathToTitle(col.path)).width;
      ctx.font = FONT_CELL;
      for (const row of data) {
        const w = ctx.measureText(formatCellValue(resolvePath(row, col.path))).width;
        if (w > maxW) maxW = w;
      }
      result[col.path] = Math.min(Math.max(Math.ceil(maxW) + PADDING, 60), 600);
    }
    return result;
  }, [cols, data]);

  const columns: GridColumn[] = useMemo(
    () =>
      cols.map((c, i) => ({
        id: c.path || `__spacer_${i}`,
        title: c.title ?? pathToTitle(c.path),
        width: c.width ?? Math.min(c.path ? widthsMap?.[c.path] ?? autoWidths[c.path] ?? 160 : 40, 600),
      })),
    [cols, widthsMap, autoWidths],
  );

  const gridContainerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    const el = gridContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setContainerWidth(w);
    });
    ro.observe(el);
    setContainerWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const scaledColumns = useMemo(() => {
    if (containerWidth <= 0) return columns;
    const total = columns.reduce((s, c) => s + ((c as any).width as number ?? 100), 0);
    if (total <= 0) return columns;
    const scale = containerWidth / total;
    return columns.map((c) => ({ ...c, width: Math.max(40, Math.floor(((c as any).width as number ?? 100) * scale)) }));
  }, [columns, containerWidth]);

  const editableSet = useMemo(
    () => new Set(editableColumns ?? []),
    [editableColumns],
  );

  const numberSet = useMemo(
    () => new Set(numberColumns ?? []),
    [numberColumns],
  );

  const boolSet = useMemo(
    () => new Set(booleanColumns ?? []),
    [booleanColumns],
  );
  const getCellContent = useCallback(
    (cell: Item): GridCell => {
      const [colIdx, rowIdx] = cell;
      const def = cols[colIdx];
      const row = resolveRow(rowIdx);
      if (!def?.path || !row) {
        return { kind: GridCellKind.Loading, data: undefined, allowOverlay: false } as any;
      }
      const value = resolvePath(row, def.path);
      const display = formatCellValue(value);

      // Apply per-column conditional formatting.
      const style = evaluateFormatter(formattersMap?.[def.path], value, row);
      let themeOverride = style ? cellStyleToThemeOverride(style) : undefined;

      const isEditable = editableSet.has(def.path);
      const isNumber   = numberSet.has(def.path);
      const isBool     = boolSet.has(def.path);

      // Boolean columns: native checkbox, no edit-theme overlay, toggle via onCellEdited.
      // Must also be in editableColumns to be non-readonly.
      if (isBool) {
        const boolValue = typeof value === 'boolean' ? value : String(value) === 'true';
        return {
          kind: GridCellKind.Boolean,
          data: boolValue,
          allowOverlay: false,
          readonly: !isEditable,
          themeOverride,  // formatter colours apply (e.g. green bg when true)
        };
      }

      // Editable cell highlight — skip for bool (handled above)
      const editTheme: Partial<Theme> = {
        bgCell: GRID_COLORS.editBg,
        bgCellMedium: GRID_COLORS.editBg,
        textDark: GRID_COLORS.blue,
      };
      if (isEditable) {
        themeOverride = themeOverride ? { ...editTheme, ...themeOverride } : editTheme;
      }

      // Number cells — return NumberCell so provideEditor can give the stepper
      if (isNumber && isEditable) {
        const numValue = parseInt(display, 10);
        return {
          kind: GridCellKind.Number,
          data: isNaN(numValue) ? undefined : numValue,
          displayData: display,
          allowOverlay: true,
          readonly: false,
          themeOverride,
        };
      }

      return {
        kind: GridCellKind.Text,
        data: display,
        displayData: display,
        allowOverlay: isEditable,
        readonly: !isEditable,
        contentAlign: 'center',
        themeOverride,
      };
    },
    [cols, data, formattersMap, editableSet, numberSet, boolSet],
  );

  const handleCellEdited = useCallback(
    (cell: Item, newCell: EditableGridCell) => {
      if (!onCellEdited) return;
      const [colIdx, rowIdx] = cell;
      const def = cols[colIdx];
      if (!def?.path || !editableSet.has(def.path)) return;
      // BooleanCell: data is boolean | BooleanEmpty | BooleanIndeterminate
      if (newCell.kind === GridCellKind.Boolean) {
        const boolVal = typeof newCell.data === 'boolean' ? newCell.data : false;
        onCellEdited(def.path, rowIdx, String(boolVal));
        return;
      }
      const newValue =
        newCell.kind === GridCellKind.Text   ? newCell.data :
        newCell.kind === GridCellKind.Number ? String(newCell.data ?? '') :
        String((newCell as any).data ?? '');
      onCellEdited(def.path, rowIdx, newValue);
    },
    [cols, editableSet, onCellEdited],
  );

  // ── provideEditor: custom overlays that match BulkOrderGrid styling ───────────
  const provideEditor = useCallback(
    (cell: GridCell) => {
      if (cell.kind === GridCellKind.Number) {
        return {
          editor: StepperEditor,
          disableStyling: true,
          styleOverride: {
            background: 'transparent',
            border: 'none',
            boxShadow: 'none',
            padding: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          } as React.CSSProperties,
        };
      }
      if (cell.kind === GridCellKind.Text && (cell as TextCell).allowOverlay) {
        return {
          editor: StyledTextEditor,
          disableStyling: true,
          styleOverride: {
            background: 'transparent',
            border: 'none',
            boxShadow: 'none',
            padding: 0,
          } as React.CSSProperties,
        };
      }
      return undefined;
    },
    [],
  );

  // ── Grid selection ──────────────────────────────────────────────────────────
  const [gridSelection, setGridSelection] = useState<GridSelection>({
    columns: CompactSelection.empty(),
    rows: CompactSelection.empty(),
  });

  const handleGridSelectionChange = useCallback(
    (sel: GridSelection) => {
      setGridSelection(sel);
      if (!onRowSelectionChange) return;
      const indices = new Set<number>();
      const rows = sel.rows as any;
      if (rows && typeof rows[Symbol.iterator] === 'function') {
        for (const idx of rows) {
          indices.add(idx);
        }
      }
      onRowSelectionChange(indices);
    },
    [onRowSelectionChange],
  );

  const handleCellClicked = useCallback(
    (cell: Item, _event: CellClickedEventArgs) => {
      if (!onRowClick) return;
      const [, rowIdx] = cell;
      onRowClick(rowIdx, resolveRow(rowIdx));
    },
    [onRowClick, resolveRow],
  );

  // ── Clickable-row hover highlight ──────────────────────────────────────────
  const [hoverRow, setHoverRow] = useState<number | undefined>(undefined);

  const handleItemHovered = useCallback(
    (args: GridMouseEventArgs) => {
      setHoverRow(args.kind === 'cell' ? args.location[1] : undefined);
    },
    [],
  );

  const hoverHighlight = useMemo((): Highlight[] => {
    if (hoverRow === undefined || !onRowClick) return [];
    return [{
      color: 'rgba(255, 255, 255, 0.06)',
      range: { x: 0, y: hoverRow, width: scaledColumns.length, height: 1 },
      style: 'no-outline' as const,
    }];
  }, [hoverRow, onRowClick, scaledColumns.length]);

  return (
    <div style={{ width: '100%', height, display: 'flex', flexDirection: 'column' }}>
      {clickableClass && (
        <style dangerouslySetInnerHTML={{ __html: `.${clickableClass} canvas { cursor: pointer !important; }` }} />
      )}
      {(title || subtitle || buttons?.length) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', marginBottom: 16, flexShrink: 0 }}>
          {title && <h1 style={{ margin: 0, flexShrink: 0 }}>{title}</h1>}
          {subtitle && (
            <p style={{ margin: 0, flex: 1, fontSize: 12, color: GRID_COLORS.muted, fontFamily: GRID_COLORS.font, textAlign: 'center' }}>
              {subtitle}
            </p>
          )}
          {buttons?.map((btn, i) => (
            <button
              key={i}
              className={btn.variant}
              onClick={btn.onClick}
              disabled={btn.disabled}
              style={btn.style ?? (btn.variant === 'primary' ? {
                padding: '9px 22px',
                background: 'var(--primary, #3b82f6)',
                color: '#fff',
                border: 'none',
                borderRadius: '10px',
                fontSize: '14px',
                fontWeight: 600,
                cursor: 'pointer',
                boxShadow: '0 4px 14px rgba(59,130,246,0.35)',
                transition: 'opacity 0.2s, box-shadow 0.2s',
              } : undefined)}
            >
              {btn.label}
            </button>
          ))}
        </div>
      )}
      {/* flex: 1 + min-height: 0 lets DataEditor fill the remaining space */}
      <div ref={gridContainerRef} className={clickableClass} style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <DataEditor
          columns={scaledColumns}
          getCellContent={getCellContent}
          getCellsForSelection={true}
          onCellEdited={onCellEdited ? handleCellEdited : undefined}
          onCellClicked={onRowClick ? handleCellClicked : undefined}
          onItemHovered={onRowClick ? handleItemHovered : undefined}
          highlightRegions={hoverHighlight}
          gridSelection={gridSelection}
          onGridSelectionChange={handleGridSelectionChange}
          rows={effectiveRowCount}
          rowMarkers={hideRowMarkers ? 'none' : (onRowSelectionChange ? 'checkbox' : 'none')}
          provideEditor={provideEditor}
          smoothScrollX
          smoothScrollY
          rangeSelect="multi-rect"
          width="100%"
          height="100%"
          theme={glideTheme}
        />
        {loading && (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(13, 16, 22, 0.75)', zIndex: 10,
            color: GRID_COLORS.muted, fontFamily: GRID_COLORS.font, fontSize: 13,
          }}>
            Loading…
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Translate our higher-level CellStyle into a Glide DG themeOverride.
 * Symbolic color names ('good', 'bad', etc.) are mapped to the dashboard
 * palette via resolveColor.
 */
function cellStyleToThemeOverride(style: CellStyle): Partial<Theme> {
  const out: Partial<Theme> = {};
  const bg = resolveColor(style.bg);
  const fg = resolveColor(style.fg);
  if (bg) {
    out.bgCell = bg;
    out.bgCellMedium = bg;
  }
  if (fg) {
    out.textDark = fg;
  }
  if (style.bold || style.italic) {
    const weight = style.bold ? '700' : '400';
    const fstyle = style.italic ? 'italic ' : '';
    out.baseFontStyle = `${fstyle}${weight} 13px`;
  }
  return out;
}
