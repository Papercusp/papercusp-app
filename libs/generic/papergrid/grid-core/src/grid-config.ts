/**
 * Generic grid configuration model.
 *
 * A grid config is just an ordered list of column "header paths" — each one
 * is a dot-separated path that's resolved against the row object at render
 * time. Numeric path segments are treated as array indices, so paths like
 * `option.liveLeadData.listItem.files.0` work without special-casing.
 *
 * Empty-string entries are intentionally allowed: they produce a blank
 * column in the visible position. Useful for keeping column indexes aligned
 * with downstream tooling that expects specific positions.
 *
 * Per-page configs live in `lib/grids/*.ts` and are imported by the
 * matching page in `app/<page>/page.tsx`.
 */

export type ColumnPath = string;

// ---------------------------------------------------------------------------
// Cell styling
// ---------------------------------------------------------------------------

/**
 * Symbolic color names map to palette entries defined in resolveColor.
 * Any literal CSS color string is also accepted.
 */
export type CellColor = 'good' | 'bad' | 'warn' | 'info' | 'dim';

export interface CellStyle {
  bg?: CellColor | string;
  fg?: CellColor | string;
  bold?: boolean;
  italic?: boolean;
}

/**
 * Palette for symbolic color names, tuned for the dark dashboard theme.
 * Used as cell-background colors; pass a literal CSS string for fg overrides.
 */
const NAMED_COLORS: Record<CellColor, string> = {
  good: '#14532d',
  bad:  '#7f1d1d',
  warn: '#78350f',
  info: '#1e3a5f',
  dim:  '#1c1f2a',
};

/**
 * Map a symbolic color name to a CSS color string, or pass through a
 * literal CSS string unchanged. Returns undefined for falsy input.
 */
export function resolveColor(color: CellColor | string | undefined): string | undefined {
  if (!color) return undefined;
  return (NAMED_COLORS as Record<string, string>)[color] ?? color;
}

// ---------------------------------------------------------------------------
// Column formatters
// ---------------------------------------------------------------------------

/**
 * Equality-lookup form: keys are stringified cell values; the special key
 * '*' acts as a catch-all default.
 */
export type FormatterMap = Record<string, CellStyle>;

/**
 * Function form: receives the cell value and the full row object, returns a
 * CellStyle or null (no override).
 */
export type FormatterFn = (value: unknown, row: unknown) => CellStyle | null;

export type ColumnFormatter = FormatterMap | FormatterFn;

/**
 * Evaluate a column formatter against a cell value and its row.
 *
 * - undefined formatter → null (no style)
 * - function form     → call and return result
 * - map form          → exact key match, then '*' fallback, then null
 */
export function evaluateFormatter(
  formatter: ColumnFormatter | undefined,
  value: unknown,
  row: unknown,
): CellStyle | null {
  if (!formatter) return null;
  if (typeof formatter === 'function') return formatter(value, row);
  const key = String(value ?? '');
  return formatter[key] ?? formatter['*'] ?? null;
}

// ---------------------------------------------------------------------------
// Grid column definitions
// ---------------------------------------------------------------------------

export interface GridColumnDef {
  /** Dot-path resolved against the row object. Empty string = spacer column. */
  path: ColumnPath;
  /** Optional display title. If omitted, derived from the last path segment. */
  title?: string;
  /** Optional pixel width. Defaults to 160 for normal columns, 40 for spacers. */
  width?: number;
}

export interface GridConfig {
  /**
   * Two equivalent forms supported:
   *  - `string[]` — a flat list of paths (titles auto-derived).
   *  - `GridColumnDef[]` — richer form for explicit titles or widths.
   */
  headers: ColumnPath[] | GridColumnDef[];
  /**
   * Sidecar pixel-width map keyed by column path. Columns absent from the
   * map fall back to 160 px (40 px for spacer columns).
   */
  widths?: Record<ColumnPath, number>;
  /**
   * Per-column conditional formatters keyed by column path. Each value is
   * either an equality-lookup map or a (value, row) => CellStyle | null fn.
   */
  formatters?: Record<ColumnPath, ColumnFormatter>;
}

/**
 * Normalize whichever headers form was supplied into the rich GridColumnDef[].
 */
export function normalizeColumns(headers: ColumnPath[] | GridColumnDef[]): GridColumnDef[] {
  return headers.map((h) => (typeof h === 'string' ? { path: h } : h));
}

/**
 * Resolve a dot-path against a nested object. Numeric segments index into
 * arrays; missing or null intermediate values short-circuit to undefined
 * rather than throwing.
 *
 *   resolvePath({ a: { b: 1 } }, 'a.b')                  -> 1
 *   resolvePath({ files: ['x', 'y'] }, 'files.0')        -> 'x'
 *   resolvePath({ a: null }, 'a.b.c')                    -> undefined
 *   resolvePath(anything, '')                            -> undefined
 */
export function resolvePath(obj: unknown, path: ColumnPath): unknown {
  if (!path) return undefined;
  const parts = path.split('.');
  let current: any = obj;
  for (const p of parts) {
    if (current == null) return undefined;
    current = current[p];
  }
  return current;
}

/**
 * Derive a human-readable title from the last segment of a dot-path.
 *   'orderDetails.alternateOrderId' -> 'Alternate Order Id'
 *   'option.liveLeadData.listItem.resellerPrice' -> 'Reseller Price'
 *   '' -> ''
 */
export function pathToTitle(path: ColumnPath): string {
  if (!path) return '';
  const last = path.split('.').pop() ?? '';
  if (/^\d+$/.test(last)) {
    // Numeric tail — combine with the previous segment for context.
    const parts = path.split('.');
    const prev = parts[parts.length - 2] ?? '';
    return `${pathToTitle(prev)} #${last}`;
  }
  return last
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

/**
 * For display: format any cell value as a string.
 */
export function formatCellValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}


// ---------------------------------------------------------------------------
// GridTable column types
// ---------------------------------------------------------------------------

/**
 * Built-in cell renderer types for GridTable.
 *
 *  - text        Read-only text cell (default)
 *  - stepper     −/input/+ pill integer stepper
 *  - price       Editable decimal input (cents ↔ dollars)
 *  - checkbox    Boolean toggle
 *  - badge       Colored pill styled by formatter
 *  - currency    Read-only formatted cents → "$1,234.56"
 *  - link        Clickable text
 *  - image-text  Thumbnail + text label
 *  - custom      Escape hatch — uses column.render()
 */
export type ColumnType =
  | 'text'
  | 'stepper'
  | 'price'
  | 'checkbox'
  | 'badge'
  | 'currency'
  | 'link'
  | 'image-text'
  | 'custom';

/**
 * Rich column definition for GridTable. Extends GridColumnDef with
 * rendering-type metadata, edit flags, and custom renderer support.
 */
export interface GridTableColumn extends GridColumnDef {
  /** Cell type — determines built-in renderer. Default: 'text' */
  type?: ColumnType;
  /** Text alignment override. Default: 'left' for text, 'center' for most others */
  align?: 'left' | 'center' | 'right';
  /** Whether this column is editable (stepper/price/checkbox). Default: false */
  editable?: boolean;
  /** Min value for stepper. Default: 0 */
  min?: number;
  /** Max value for stepper. Undefined = no cap */
  max?: number;
  /** Step size for stepper. Default: 1 */
  step?: number;
  /** For 'link': dot-path to resolve href from the row */
  hrefPath?: string;
  /** For 'image-text': dot-path to the image URL */
  imagePath?: string;
  /** For 'currency'/'price': value is in cents (divide by 100). Default: true */
  cents?: boolean;
  /** Custom cell renderer — escape hatch. Return ReactNode. */
  render?: (row: any, value: unknown, rowIndex: number) => React.ReactNode;
}

/**
 * GridTable-aware config. Accepts the same shape as GridConfig so existing
 * configs work without modification, but headers may contain rich
 * GridTableColumn objects when interactive cell types are needed.
 */
export interface GridTableConfig {
  headers: GridTableColumn[] | ColumnPath[];
  widths?: Record<ColumnPath, number>;
  formatters?: Record<ColumnPath, ColumnFormatter>;
}