/**
 * Delimited (CSV/TSV) + markdown-table encoders for arrays of flat objects.
 *
 * CSV/TSV are RFC 4180-quoted: a field is quoted when it contains the
 * delimiter, a double-quote, CR, or LF; embedded quotes are doubled. These
 * formats are LOSSY — every cell becomes a string, so `decodeDelimited` round-
 * trips to string-coerced rows, not the original typed values. That is exactly
 * why CSV is opt-in-only and never the auto-selected default (see eligibility).
 */

import { ResultEncodeError } from './formats';

type Row = Record<string, unknown>;

function asObjectArray(rows: unknown): Row[] {
  if (!Array.isArray(rows)) {
    throw new ResultEncodeError('delimited/markdown encoding requires an array');
  }
  for (const r of rows) {
    if (r === null || typeof r !== 'object' || Array.isArray(r)) {
      throw new ResultEncodeError('delimited/markdown encoding requires an array of objects');
    }
  }
  return rows as Row[];
}

/** Column order = first-seen union of keys across all rows. */
function collectColumns(rows: Row[]): string[] {
  const cols: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!seen.has(k)) {
        seen.add(k);
        cols.push(k);
      }
    }
  }
  return cols;
}

/** Stringify a cell value the way CSV/positional encoders do (objects → JSON, null/undefined → ''). */
export function cellToString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function needsQuote(s: string, delimiter: string): boolean {
  return s.includes(delimiter) || s.includes('"') || s.includes('\n') || s.includes('\r');
}

/** RFC-4180 quote a single field for the given delimiter (doubles embedded quotes). Shared with the positional encoder. */
export function quoteField(s: string, delimiter: string): string {
  return needsQuote(s, delimiter) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** Encode an array of flat objects as CSV (`,`) or TSV (`\t`). */
export function encodeDelimited(rows: unknown, delimiter: ',' | '\t'): string {
  const arr = asObjectArray(rows);
  const cols = collectColumns(arr);
  const lines: string[] = [cols.map((c) => quoteField(c, delimiter)).join(delimiter)];
  for (const row of arr) {
    lines.push(cols.map((c) => quoteField(cellToString(row[c]), delimiter)).join(delimiter));
  }
  return lines.join('\n');
}

/** Encode an array of flat objects as a GitHub-flavored markdown table. Lossy display format. */
export function encodeMarkdownTable(rows: unknown): string {
  const arr = asObjectArray(rows);
  const cols = collectColumns(arr);
  const esc = (s: string): string =>
    s.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll('\r', '').replaceAll('\n', ' ');
  const header = `| ${cols.map(esc).join(' | ')} |`;
  const sep = `| ${cols.map(() => '---').join(' | ')} |`;
  const body = arr.map((row) => `| ${cols.map((c) => esc(cellToString(row[c]))).join(' | ')} |`);
  return [header, sep, ...body].join('\n');
}

/** RFC 4180 row parser — respects quoted fields containing the delimiter / CR / LF / `""`. */
export function parseRows(text: string, delimiter: string): string[][] {
  if (text === '') return [];
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let dirty = false; // have we consumed any char toward the current row?
  const pushField = (): void => {
    row.push(field);
    field = '';
  };
  const pushRow = (): void => {
    pushField();
    rows.push(row);
    row = [];
    dirty = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    dirty = true;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === delimiter) {
      pushField();
    } else if (c === '\n') {
      pushRow();
    } else if (c === '\r') {
      if (text[i + 1] === '\n') i++;
      pushRow();
    } else {
      field += c;
    }
  }
  if (dirty || field !== '' || row.length > 0) pushRow();
  return rows;
}

/**
 * Decode CSV/TSV back to rows. LOSSY: every value is a string (CSV carries no
 * types). Used by the round-trip property tests + any consumer that asked for
 * the delimited form and needs to re-read it.
 */
export function decodeDelimited(text: string, delimiter: ',' | '\t'): Array<Record<string, string>> {
  const records = parseRows(text, delimiter);
  if (records.length === 0) return [];
  const header = records[0];
  const cols = header.length === 1 && header[0] === '' ? [] : header;
  const out: Array<Record<string, string>> = [];
  for (let i = 1; i < records.length; i++) {
    const rec = records[i];
    const obj: Record<string, string> = {};
    cols.forEach((c, idx) => {
      obj[c] = rec[idx] ?? '';
    });
    out.push(obj);
  }
  return out;
}
