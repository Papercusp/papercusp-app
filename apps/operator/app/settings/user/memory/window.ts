/**
 * The Memory page's window arithmetic: given what is loaded and what exists,
 * is there more to fetch, and how much (WI-39540)?
 *
 * Pure and separate from page.tsx so it can be asserted directly. The page is
 * a large client component wired to live sync queries; the interesting logic
 * here is three booleans that are easy to get subtly wrong and impossible to
 * see going wrong — a window that reports "no more" one page early looks
 * exactly like a corpus that ended.
 */
export interface MemoryWindowInput {
  /** Rows actually returned for the current window. */
  loadedRows: number;
  /** Rows the current window ASKED for. */
  loadedLimit: number;
  /** Total across the same scopes, or null while not yet known. */
  total: number | null;
  /** "Show all" is on — the window is unbounded, so nothing is pending. */
  showAll: boolean;
}

export interface MemoryWindowState {
  /** Should the scroll sentinel render and the observer arm? */
  hasMore: boolean;
  /** How many rows remain unloaded, or null when the total is unknown. */
  remaining: number | null;
  /** Should the "N of M" denominator render? */
  showDenominator: boolean;
}

/**
 * ⚠ TWO conditions gate `hasMore`, and dropping either one breaks it in a way
 * that is hard to see:
 *
 *  - `loadedRows >= loadedLimit` — a SHORT page means the server ran out,
 *    whatever the total claims. Without this the observer keeps firing
 *    against a corpus that has already ended (the total can lag a delete by
 *    one invalidation round-trip), growing the limit forever.
 *  - `loadedRows < total` — the total is the authority once known.
 *
 * A null total is treated as "keep going", NOT as "stop": the count query
 * resolves independently of the list, so a window that refused to grow until
 * the denominator arrived would stall on exactly the first screen.
 */
export function memoryWindowState(input: MemoryWindowInput): MemoryWindowState {
  const { loadedRows, loadedLimit, total, showAll } = input;

  const hasMore =
    !showAll
    && loadedRows >= loadedLimit
    && (total === null || loadedRows < total);

  return {
    hasMore,
    remaining: total === null ? null : Math.max(0, total - loadedRows),
    // Only worth showing while the window is genuinely a subset — "Showing 12
    // of 12" is noise, and with an unknown total there is no denominator to
    // show rather than a zero to imply.
    showDenominator: total !== null && loadedRows < total,
  };
}
