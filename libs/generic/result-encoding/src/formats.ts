/**
 * Result-format vocabulary — the set of serializations a structured tool
 * result can be rendered in, plus the negotiation tokens a client may request.
 *
 * `json` is the lossless universal default and is ALWAYS available. The
 * `compact` formats trade structural overhead for tokens:
 *   - `toon`  — Token-Oriented Object Notation: a JSON-lossless superset that
 *               renders uniform arrays as CSV-style rows and nests otherwise.
 *               The default compact format (see eligibility).
 *   - `csv` / `tsv` — flat delimited tables. ~6% denser than TOON on purely
 *               flat data but lossy (no types/nulls/nesting). Opt-in only.
 *   - `md`    — a markdown table. Display-oriented (lossy); never round-tripped.
 */

export type ResultFormat = 'json' | 'toon' | 'csv' | 'tsv' | 'md';

/** Every supported format. */
export const RESULT_FORMATS: readonly ResultFormat[] = ['json', 'toon', 'csv', 'tsv', 'md'];

/** Formats other than `json` — the token-saving representations. */
export const COMPACT_FORMATS: readonly ResultFormat[] = ['toon', 'csv', 'tsv', 'md'];

export function isResultFormat(v: unknown): v is ResultFormat {
  return typeof v === 'string' && (RESULT_FORMATS as readonly string[]).includes(v);
}

/**
 * What a client/runtime asks for during negotiation. A concrete `ResultFormat`
 * names one serialization; `'compact'` means "server, pick the most compact
 * format this tool's data can be represented in" (the delivered-not-requested
 * default for agent-facing transports).
 */
export type FormatRequest = ResultFormat | 'compact';

const MIME_TO_FORMAT: Record<string, ResultFormat> = {
  'application/json': 'json',
  'application/toon': 'toon',
  'text/x-toon': 'toon',
  'text/csv': 'csv',
  'text/tab-separated-values': 'tsv',
  'text/tsv': 'tsv',
  'text/markdown': 'md',
};

const FORMAT_TO_MIME: Record<ResultFormat, string> = {
  json: 'application/json',
  toon: 'application/toon',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  md: 'text/markdown',
};

/** The canonical MIME type a given format serializes to (for HTTP `Content-Type`). */
export function mimeForFormat(format: ResultFormat): string {
  return FORMAT_TO_MIME[format];
}

/**
 * Parse a negotiation token from a `?format=` query value, an MCP `_meta.format`
 * value, or an HTTP `Accept` MIME type. Returns undefined when nothing
 * recognizable is requested (caller falls back to its transport default).
 *
 * Accepts: `json|toon|csv|tsv|md|compact` (case-insensitive), the MIME types
 * above, and the friendly aliases `full`→json (lossless) / `tabular`→csv.
 */
export function parseFormatRequest(raw: string | null | undefined): FormatRequest | undefined {
  if (!raw) return undefined;
  const v = raw.trim().toLowerCase();
  if (!v) return undefined;
  if (v === 'compact') return 'compact';
  if (v === 'full') return 'json';
  if (v === 'tabular') return 'csv';
  if (isResultFormat(v)) return v;
  if (v in MIME_TO_FORMAT) return MIME_TO_FORMAT[v];
  // Accept header may carry params (`text/csv; q=0.9`) — strip them.
  const base = v.split(';', 1)[0].trim();
  if (base in MIME_TO_FORMAT) return MIME_TO_FORMAT[base];
  return undefined;
}

/** Thrown when a value cannot be represented in the requested format. */
export class ResultEncodeError extends Error {
  override readonly name = 'ResultEncodeError';
}
