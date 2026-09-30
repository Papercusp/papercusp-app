'use client';
/**
 * GridTable — Declarative HTML table with built-in cell renderers.
 *
 * Accepts the same GridConfig / GridTableConfig used by DataGridShell so
 * existing column configs work without modification.  Interactive columns
 * (stepper, price, checkbox) are declared via the `type` field on
 * GridTableColumn — no per-consumer JSX required.
 *
 * @module @papercusp/grid/GridTable
 */
import React, { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { useHoverExpand } from './use-hover-expand';
import {
  GRID_COLORS,
  getGridThemeVersion,
  TD_BASE,
  TH_BASE,
  TABLE_WRAPPER_STYLE,
  TABLE_STYLE,
  CHECKBOX_STYLE,
  STEPPER_INPUT_STYLE,
  STEPPER_BTN_STYLE,
  STEPPER_PILL_STYLE,
  EDIT_INPUT_STYLE,
  EXPAND_BTN_STYLE,
  SUB_ROW_STYLE,
  badgeStyle,
  rowBg,
  stepperCSS,
  subscribeGridTheme,
} from './grid-theme';
import {
  normalizeColumns,
  resolvePath,
  evaluateFormatter,
  resolveColor,
  formatCellValue,
  pathToTitle,
} from './grid-config';
import type {
  GridTableColumn,
  GridTableConfig,
  ColumnFormatter,
  CellStyle,
} from './grid-config';

// ─── Public props ─────────────────────────────────────────────────────────────

export interface GridTableProps {
  /** Column + formatter configuration */
  config: GridTableConfig;
  /** Row data array */
  data: any[];
  /** CSS class prefix for stepper/input global styles. Default: 'gt' */
  classPrefix?: string;
  /** Disable all editable cells (locked state) */
  disabled?: boolean;
  /** Loading state — shows overlay */
  loading?: boolean;
  /** Empty-state message. Default: 'No data.' */
  emptyMessage?: string;

  // ─── Callbacks ──────────────────────────────────────────────────────────────
  /** Fires when any editable cell changes */
  onCellChange?: (path: string, rowIndex: number, value: unknown, row: any) => void;
  /** Fires on row click (not from input interaction) */
  onRowClick?: (rowIndex: number, row: any) => void;

  // ─── Row selection ──────────────────────────────────────────────────────────
  /** Enable checkbox row selection. Default: false */
  selectable?: boolean;
  /** Controlled selected row indices */
  selectedRows?: Set<number>;
  /** Selection change callback */
  onSelectionChange?: (selected: Set<number>) => void;

  // ─── Layout ─────────────────────────────────────────────────────────────────
  /** Table height constraint. Default: undefined (natural height) */
  height?: string | number;
  /** Sticky header. Default: true */
  stickyHeader?: boolean;

  // ─── Expandable rows ────────────────────────────────────────────────────────
  /** Render expanded content for a row. Return ReactNode or null to hide.
      When this prop is set, a chevron expand/collapse column is prepended. */
  expandRow?: (row: any, rowIndex: number) => React.ReactNode;
  /** Controlled set of expanded row indices. If omitted, internal state. */
  expandedRows?: Set<number>;
  /** Callback when expansion state changes */
  onExpandChange?: (expanded: Set<number>) => void;
  /** Allow multiple rows expanded at once. Default: true */
  multiExpand?: boolean;
  /** Open `expandRow` on row hover (and keyboard focus) instead of via a
      chevron click. When true, only one row is expanded at a time and the
      chevron column is hidden. Controlled/`expandedRows` is ignored. */
  hoverExpand?: boolean;
  /** ms delay before closing on mouse leave (hoverExpand only). Default 180. */
  hoverCloseDelayMs?: number;

  // ─── Composition slots ──────────────────────────────────────────────────────
  /** Rendered above the table (title bar, search, buttons) */
  header?: React.ReactNode;
  /** Rendered below the table (summary bar, action buttons) */
  footer?: React.ReactNode;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function centsToDisplay(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

const DEFAULT_ALIGN: Record<string, 'left' | 'center' | 'right'> = {
  text: 'left',
  stepper: 'center',
  price: 'center',
  checkbox: 'center',
  badge: 'center',
  currency: 'center',
  link: 'left',
  'image-text': 'left',
  custom: 'left',
};

// ─── Cell renderers ───────────────────────────────────────────────────────────

interface CellCtx {
  col: GridTableColumn;
  value: unknown;
  row: any;
  rowIndex: number;
  disabled: boolean;
  cellStyle: CellStyle | null;
  classPrefix: string;
  onCellChange?: (path: string, rowIndex: number, value: unknown, row: any) => void;
}

function TextCell({ value, cellStyle }: CellCtx) {
  const display = formatCellValue(value);
  const fg = cellStyle?.fg ? resolveColor(cellStyle.fg) : undefined;
  const bold = cellStyle?.bold;
  const italic = cellStyle?.italic;
  return (
    <span style={{
      color: fg,
      fontWeight: bold ? 700 : undefined,
      fontStyle: italic ? 'italic' : undefined,
    }}>
      {display}
    </span>
  );
}

function StepperCell({ col, value, row, rowIndex, disabled, classPrefix, onCellChange }: CellCtx) {
  const current = typeof value === 'number' ? value : parseInt(String(value ?? '0'), 10) || 0;
  const min = col.min ?? 0;
  const max = col.max;
  const step = col.step ?? 1;
  const path = col.path;

  const update = useCallback((n: number) => {
    let v = n;
    if (v < min) v = min;
    if (max !== undefined && v > max) v = max;
    onCellChange?.(path, rowIndex, v, row);
  }, [path, rowIndex, row, min, max, onCellChange]);

  return (
    <div style={STEPPER_PILL_STYLE}>
      <button
        type="button"
        className={`${classPrefix}-btn`}
        style={{ ...STEPPER_BTN_STYLE, opacity: current <= min ? 0.35 : 1 }}
        disabled={disabled || current <= min}
        onClick={e => { e.stopPropagation(); update(current - step); }}
      >&minus;</button>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        className={`${classPrefix}-input`}
        value={current === 0 ? '' : current}
        placeholder="0"
        disabled={disabled}
        onClick={e => e.stopPropagation()}
        onChange={e => {
          const v = parseInt(e.target.value, 10);
          update(isNaN(v) ? min : v);
        }}
        style={{
          ...STEPPER_INPUT_STYLE,
          color: current === 0 ? GRID_COLORS.muted : GRID_COLORS.text,
        } as React.CSSProperties}
      />
      <button
        type="button"
        className={`${classPrefix}-btn`}
        style={{ ...STEPPER_BTN_STYLE, opacity: (max !== undefined && current >= max) ? 0.35 : 1 }}
        disabled={disabled || (max !== undefined && current >= max)}
        onClick={e => { e.stopPropagation(); update(current + step); }}
      >+</button>
    </div>
  );
}

function PriceCell({ col, value, row, rowIndex, disabled, onCellChange }: CellCtx) {
  const cents = col.cents !== false; // default true
  const rawNum = typeof value === 'number' ? value : parseFloat(String(value ?? '0')) || 0;
  const asDecimal = cents ? rawNum / 100 : rawNum;
  const displayVal = '$' + asDecimal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const path = col.path;

  return (
    <input
      type="text"
      inputMode="decimal"
      disabled={disabled}
      defaultValue={displayVal}
      key={`price-${rowIndex}-${rawNum}`}
      onClick={e => e.stopPropagation()}
      onFocus={e => { e.target.select(); e.target.value = asDecimal.toFixed(2); }}
      onBlur={e => {
        const v = parseFloat(e.target.value.replace(/[$,]/g, ''));
        if (!isNaN(v) && v >= 0) {
          const stored = cents ? Math.round(v * 100) : v;
          onCellChange?.(path, rowIndex, stored, row);
          e.target.value = '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        }
      }}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      style={{
        ...EDIT_INPUT_STYLE,
        width: 100,
        height: 'auto',
        padding: '5px 10px',
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'not-allowed' : 'text',
      }}
    />
  );
}

function CheckboxCell({ col, value, row, rowIndex, disabled, onCellChange }: CellCtx) {
  const checked = typeof value === 'boolean' ? value : String(value) === 'true';
  const path = col.path;
  return (
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onClick={e => e.stopPropagation()}
      onChange={e => onCellChange?.(path, rowIndex, e.target.checked, row)}
      style={{
        ...CHECKBOX_STYLE,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    />
  );
}

function BadgeCell({ value, cellStyle }: CellCtx) {
  const display = formatCellValue(value);
  if (!display) return null;
  // Use the formatter fg/bg to derive badge color; fall back to muted
  const color = resolveColor(cellStyle?.fg) ?? resolveColor(cellStyle?.bg) ?? GRID_COLORS.muted;
  return <span style={badgeStyle(color)}>{display}</span>;
}

function CurrencyCell({ col, value }: CellCtx) {
  const cents = col.cents !== false;
  const rawNum = typeof value === 'number' ? value : parseFloat(String(value ?? '0')) || 0;
  return <>{cents ? centsToDisplay(rawNum) : centsToDisplay(rawNum * 100)}</>;
}

function LinkCell({ col, value, row }: CellCtx) {
  const display = formatCellValue(value);
  const href = col.hrefPath ? String(resolvePath(row, col.hrefPath) ?? '') : display;
  return (
    <a
      href={href}
      onClick={e => e.stopPropagation()}
      style={{ color: GRID_COLORS.blue, textDecoration: 'none' }}
    >
      {display}
    </a>
  );
}

function ImageTextCell({ col, value, row }: CellCtx) {
  const display = formatCellValue(value);
  const imgUrl = col.imagePath ? String(resolvePath(row, col.imagePath) ?? '') : '';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
      {imgUrl ? (
        <img
          src={imgUrl}
          alt=""
          style={{
            width: 34, height: 34, borderRadius: 5, objectFit: 'contain',
            background: '#1c2230', flexShrink: 0,
            border: `1px solid ${GRID_COLORS.border}`,
          }}
        />
      ) : (
        <div style={{
          width: 34, height: 34, borderRadius: 5,
          background: '#1c2230', flexShrink: 0,
          border: `1px solid ${GRID_COLORS.border}`,
        }} />
      )}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {display}
      </span>
    </div>
  );
}

function renderCell(ctx: CellCtx): React.ReactNode {
  const type = ctx.col.type ?? 'text';
  switch (type) {
    case 'stepper':    return <StepperCell {...ctx} />;
    case 'price':      return <PriceCell {...ctx} />;
    case 'checkbox':   return <CheckboxCell {...ctx} />;
    case 'badge':      return <BadgeCell {...ctx} />;
    case 'currency':   return <CurrencyCell {...ctx} />;
    case 'link':       return <LinkCell {...ctx} />;
    case 'image-text': return <ImageTextCell {...ctx} />;
    case 'custom':
      return ctx.col.render?.(ctx.row, ctx.value, ctx.rowIndex) ?? null;
    case 'text':
    default:
      return <TextCell {...ctx} />;
  }
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function GridTable({
  config,
  data,
  classPrefix = 'gt',
  disabled = false,
  loading = false,
  emptyMessage = 'No data.',
  onCellChange,
  onRowClick,
  selectable = false,
  selectedRows,
  onSelectionChange,
  expandRow,
  expandedRows,
  onExpandChange,
  multiExpand = true,
  hoverExpand = false,
  hoverCloseDelayMs = 180,
  height,
  stickyHeader = true,
  header,
  footer,
}: GridTableProps) {
  useSyncExternalStore(subscribeGridTheme, getGridThemeVersion, getGridThemeVersion);

  // Normalize columns
  const columns: GridTableColumn[] = useMemo(() => {
    const raw = normalizeColumns(config.headers);
    return raw.map(c => {
      const col = c as GridTableColumn;
      // Apply width from sidecar widths map if not set on the column directly
      if (col.width == null && config.widths?.[col.path]) {
        return { ...col, width: config.widths[col.path] };
      }
      return col;
    });
  }, [config]);

  const formatters = config.formatters;

  // Total width for colgroup %
  const totalWidth = useMemo(
    () => columns.reduce((s, c) => s + (c.width ?? 160), 0),
    [columns],
  );

  // Row click handler
  const handleRowClick = useCallback((rowIndex: number, row: any, e: React.MouseEvent) => {
    // Don't fire row click if user clicked an interactive element
    const target = e.target as HTMLElement;
    if (target.closest('input, button, a, select, textarea')) return;
    onRowClick?.(rowIndex, row);
  }, [onRowClick]);

  // Selection toggle
  const toggleSelection = useCallback((idx: number) => {
    const prev = selectedRows ?? new Set<number>();
    const next = new Set(prev);
    if (next.has(idx)) next.delete(idx);
    else next.add(idx);
    onSelectionChange?.(next);
  }, [selectedRows, onSelectionChange]);

  const allSelected = selectable && data.length > 0 && (selectedRows?.size ?? 0) === data.length;

  const toggleAll = useCallback(() => {
    if (allSelected) {
      onSelectionChange?.(new Set());
    } else {
      onSelectionChange?.(new Set(data.map((_, i) => i)));
    }
  }, [allSelected, data, onSelectionChange]);

  // ─── Expansion state ────────────────────────────────────────────────────────
  const [internalExpanded, setInternalExpanded] = useState<Set<number>>(new Set());
  const hover = useHoverExpand<number>({ closeDelayMs: hoverCloseDelayMs });

  const expandedSet: Set<number> = hoverExpand
    ? (hover.expandedId != null ? new Set([hover.expandedId]) : new Set())
    : (expandedRows ?? internalExpanded);

  const setExpanded = useCallback((next: Set<number>) => {
    if (!expandedRows) setInternalExpanded(next);
    onExpandChange?.(next);
  }, [expandedRows, onExpandChange]);

  const toggleExpand = useCallback((idx: number) => {
    const next = new Set(expandedSet);
    if (next.has(idx)) {
      next.delete(idx);
    } else {
      if (!multiExpand) next.clear();
      next.add(idx);
    }
    setExpanded(next);
  }, [expandedSet, multiExpand, setExpanded]);

  const hasExpand = !!expandRow;
  // Chevron column suppressed in hoverExpand mode — expansion is driven by hover.
  const showChevronCol = hasExpand && !hoverExpand;
  const totalColSpan = columns.length + (selectable ? 1 : 0) + (showChevronCol ? 1 : 0);

  // Wrapper style with optional height
  const wrapperStyle: React.CSSProperties = {
    ...TABLE_WRAPPER_STYLE,
    ...(height != null ? { maxHeight: height, overflowY: 'auto' } : {}),
    position: 'relative',
  };

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: stepperCSS(classPrefix) + `\n  .${classPrefix}-expand-btn:hover:not(:disabled) { color: ${GRID_COLORS.text}; background: rgba(255,255,255,0.06); }\n  .${classPrefix}-clickable-row { cursor: pointer; transition: background 0.12s; }\n  .${classPrefix}-clickable-row:hover { background: ${GRID_COLORS.rowHover} !important; }` }} />
      {header}
      <div style={wrapperStyle}>
        {/* Loading overlay */}
        {loading && (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(13,16,22,0.75)', zIndex: 10,
            color: GRID_COLORS.muted, fontFamily: GRID_COLORS.font, fontSize: 13,
          }}>
            Loading…
          </div>
        )}

        <table style={TABLE_STYLE}>
          <colgroup>{showChevronCol && <col style={{ width: 36 }} />}{selectable && <col style={{ width: 44 }} />}{columns.map(col => (<col key={col.path || '__spacer'} style={{ width: col.width ? `${(col.width / totalWidth * 100).toFixed(2)}%` : undefined }} />))}</colgroup>

          <thead>
            <tr>
              {showChevronCol && (
                <th style={{
                  ...TH_BASE,
                  maxWidth: 'none',
                  overflow: 'visible',
                  width: 36,
                  padding: 0,
                  ...(stickyHeader ? {} : { position: 'static' }),
                }} />
              )}
              {selectable && (
                <th style={{
                  ...TH_BASE,
                  textAlign: 'center',
                  maxWidth: 'none',
                  overflow: 'visible',
                  ...(stickyHeader ? {} : { position: 'static' }),
                }}>
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    style={CHECKBOX_STYLE}
                  />
                </th>
              )}
              {columns.map(col => {
                const type = col.type ?? 'text';
                const align = col.align ?? DEFAULT_ALIGN[type] ?? 'left';
                return (
                  <th
                    key={col.path || '__spacer'}
                    style={{
                      ...TH_BASE,
                      textAlign: align,
                      ...(stickyHeader ? {} : { position: 'static' }),
                    }}
                  >
                    {col.title ?? pathToTitle(col.path)}
                  </th>
                );
              })}
            </tr>
          </thead>

          <tbody>
            {data.length === 0 && !loading && (
              <tr>
                <td
                  colSpan={totalColSpan}
                  style={{
                    ...TD_BASE,
                    textAlign: 'center',
                    color: GRID_COLORS.muted,
                    padding: 32,
                    maxWidth: 'none',
                  }}
                >
                  {emptyMessage}
                </td>
              </tr>
            )}

            {data.map((row, i) => {
              const isSelected = selectable && (selectedRows?.has(i) ?? false);
              const bg = isSelected ? '#1a2540' : rowBg(i);
              const isExpanded = hasExpand && expandedSet.has(i);

              return (
                <React.Fragment key={i}>
                  <tr
                    onClick={onRowClick ? e => handleRowClick(i, row, e) : undefined}
                    className={onRowClick || hoverExpand ? `${classPrefix}-clickable-row` : undefined}
                    style={{
                      background: bg,
                    }}
                    onMouseEnter={hoverExpand && hasExpand ? () => hover.rowEnter(i) : undefined}
                    onMouseLeave={hoverExpand && hasExpand ? hover.rowLeave : undefined}
                    tabIndex={hoverExpand && hasExpand ? 0 : undefined}
                    onFocus={hoverExpand && hasExpand
                      ? (e) => { if (e.currentTarget === e.target) hover.rowFocus(i); }
                      : undefined}
                    onBlur={hoverExpand && hasExpand
                      ? (e) => {
                          const next = e.relatedTarget as Node | null;
                          const el = e.currentTarget;
                          if (next && el.contains(next)) return;
                          hover.rowBlur();
                        }
                      : undefined}
                    aria-expanded={hoverExpand && hasExpand ? isExpanded : undefined}
                  >
                    {showChevronCol && (
                      <td style={{
                        ...TD_BASE,
                        textAlign: 'center' as const,
                        background: bg,
                        maxWidth: 'none',
                        overflow: 'visible',
                        padding: '10px 6px',
                        width: 36,
                      }}>
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={e => { e.stopPropagation(); toggleExpand(i); }}
                          style={{
                            ...EXPAND_BTN_STYLE,
                            ...(disabled ? { opacity: 0.35, cursor: 'not-allowed' } : {}),
                          }}
                          className={`${classPrefix}-expand-btn`}
                        >
                          {isExpanded ? '\u25BC' : '\u25B6'}
                        </button>
                      </td>
                    )}

                    {selectable && (
                      <td style={{
                        ...TD_BASE, textAlign: 'center', background: bg,
                        maxWidth: 'none', overflow: 'visible',
                      }}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onClick={e => e.stopPropagation()}
                          onChange={() => toggleSelection(i)}
                          style={{ ...CHECKBOX_STYLE, cursor: 'pointer' }}
                        />
                      </td>
                    )}

                    {columns.map(col => {
                      const type = col.type ?? 'text';
                      const align = col.align ?? DEFAULT_ALIGN[type] ?? 'left';
                      const value = resolvePath(row, col.path);
                      const formatter: ColumnFormatter | undefined = formatters?.[col.path];
                      const cellStyle = evaluateFormatter(formatter, value, row);
                      const cellBg = cellStyle?.bg ? resolveColor(cellStyle.bg) : undefined;
                      const isEditable = col.editable && !disabled;
                      const isCheckbox = type === 'checkbox';

                      // Checkbox gets green tint when checked
                      const checkboxBg = isCheckbox && (typeof value === 'boolean' ? value : String(value) === 'true')
                        ? `${GRID_COLORS.green}22`
                        : undefined;

                      const needsOverflow = type === 'stepper' || type === 'price' || type === 'custom';

                      return (
                        <td
                          key={col.path || '__spacer'}
                          style={{
                            ...TD_BASE,
                            textAlign: align,
                            background: checkboxBg ?? cellBg ?? bg,
                            ...(needsOverflow ? { overflow: 'visible', maxWidth: 'none' } : {}),
                            ...(type === 'price' ? { borderLeft: `1px solid ${GRID_COLORS.editBorder}33` } : {}),
                          }}
                        >
                          {renderCell({
                            col,
                            value,
                            row,
                            rowIndex: i,
                            disabled: !isEditable,
                            cellStyle,
                            classPrefix,
                            onCellChange,
                          })}
                        </td>
                      );
                    })}
                  </tr>

                  {/* Expanded sub-row */}
                  {isExpanded && (
                    <tr
                      onMouseEnter={hoverExpand ? hover.panelEnter : undefined}
                      onMouseLeave={hoverExpand ? hover.panelLeave : undefined}
                    >
                      <td colSpan={totalColSpan} style={SUB_ROW_STYLE}>
                        {expandRow!(row, i)}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {footer}
    </>
  );
}


// ─── GridSubTable convenience wrapper ──────────────────────────────────────────────

/** Convenience wrapper for rendering a nested GridTable inside an expanded row. */
export function GridSubTable(props: Omit<GridTableProps, 'header' | 'footer'>) {
  return (
    <div style={{ padding: '8px 0 8px 36px' }}>
      <GridTable {...props} stickyHeader={false} />
    </div>
  );
}
