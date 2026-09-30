'use client';

import type { CSSProperties, ReactNode } from 'react';

/**
 * One column of a `Table` — declares the header + how to render each row's
 * cell. Generic over the row shape so callers get full type-checking on
 * `render`/`cellStyle`/`cellTitle` without a cast.
 */
export interface TableColumn<Row> {
  /** Stable key for this column (used as the React key for header + cells). */
  key: string;
  /** Column header content (rendered inside a `<th scope="col">`). */
  header: ReactNode;
  /** Cell content for one row. */
  render: (row: Row) => ReactNode;
  /** Optional inline style applied to every cell in this column. */
  cellStyle?: CSSProperties;
  /** Optional per-row `title=` tooltip for this column's cells. */
  cellTitle?: (row: Row) => string | undefined;
  /** Optional inline style applied to this column's `<th>`. */
  headerStyle?: CSSProperties;
}

const TABLE_STYLE: CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 12,
  color: 'var(--fg)',
};

const CAPTION_STYLE: CSSProperties = {
  textAlign: 'left',
  padding: '0 0 6px',
  fontSize: 11,
  opacity: 0.65,
  captionSide: 'top',
};

const TH_STYLE: CSSProperties = {
  textAlign: 'left',
  padding: '4px 8px',
  borderBottom: '1px solid var(--border)',
  fontWeight: 600,
  fontSize: 11,
  color: 'var(--fg)',
  opacity: 0.75,
  whiteSpace: 'nowrap',
};

const TD_STYLE: CSSProperties = {
  padding: '4px 8px',
  borderBottom: '1px solid color-mix(in oklab, var(--border), transparent 55%)',
  verticalAlign: 'middle',
};

/**
 * Table — the shared design-primitives table (papercusp-workspace design
 * system). Wraps the native `<table>` element ONCE so app UI never hand-rolls
 * `<table>/<thead>/<tbody>` (the `design-primitives` lint blocks new native
 * `<table>` usage; this file is its allowlisted implementation, same pattern
 * as `Select.tsx` / `Checkbox.tsx`).
 *
 * Replaces:
 *   <table className="pc-rubrics">
 *     <thead><tr><th scope="col">Rubric</th>…</tr></thead>
 *     <tbody>{rows.map(row => <tr key={row.id}><td>{row.title}</td>…</tr>)}</tbody>
 *   </table>
 *
 * with:
 *   <Table
 *     className="pc-rubrics"
 *     caption={`${rows.length} rubrics`}
 *     columns={[{ key: 'rubric', header: 'Rubric', render: (row) => row.title }, …]}
 *     rows={rows}
 *     getRowKey={(row) => row.rubricId}
 *   />
 *
 * `className` is passed straight through to the `<table>` element (existing
 * `pc-*` panel classNames keep working unchanged); a default token-based style
 * (border, padding, sizing) applies unless a panel's own CSS overrides it.
 */
export function Table<Row>({
  className,
  style,
  caption,
  columns,
  rows,
  getRowKey,
  onRowClick,
  isRowSelected,
  rowStyle,
  rowClassName,
  rowTestId,
  emptyLabel,
}: {
  className?: string;
  style?: CSSProperties;
  caption?: ReactNode;
  columns: TableColumn<Row>[];
  rows: Row[];
  getRowKey: (row: Row) => string;
  onRowClick?: (row: Row) => void;
  isRowSelected?: (row: Row) => boolean;
  /** Optional per-row style (e.g. dimming a revoked row). Merged over the built-ins. */
  rowStyle?: (row: Row) => CSSProperties | undefined;
  /** Optional per-row `className` applied to the `<tr>` (e.g. a regression-row marker). */
  rowClassName?: (row: Row) => string | undefined;
  /** Optional per-row `data-testid` on the `<tr>` (for test hooks that target a specific row). */
  rowTestId?: (row: Row) => string | undefined;
  /** Rendered as a single caption-only row when `rows` is empty (default: nothing extra). */
  emptyLabel?: ReactNode;
}) {
  return (
    <table className={className} style={{ ...TABLE_STYLE, ...style }}>
      {caption != null && <caption style={CAPTION_STYLE}>{caption}</caption>}
      <thead>
        <tr>
          {columns.map((col) => (
            <th key={col.key} scope="col" style={{ ...TH_STYLE, ...col.headerStyle }}>
              {col.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && emptyLabel != null ? (
          <tr>
            <td colSpan={columns.length} style={{ ...TD_STYLE, opacity: 0.65 }}>
              {emptyLabel}
            </td>
          </tr>
        ) : (
          rows.map((row) => {
            const key = getRowKey(row);
            return (
              <tr
                key={key}
                className={rowClassName?.(row)}
                data-testid={rowTestId?.(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                style={{
                  cursor: onRowClick ? 'pointer' : undefined,
                  background: isRowSelected?.(row)
                    ? 'color-mix(in oklab, var(--accent), transparent 88%)'
                    : undefined,
                  ...rowStyle?.(row),
                }}
                aria-selected={isRowSelected ? isRowSelected(row) : undefined}
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    style={{ ...TD_STYLE, ...col.cellStyle }}
                    title={col.cellTitle?.(row)}
                  >
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            );
          })
        )}
      </tbody>
    </table>
  );
}
