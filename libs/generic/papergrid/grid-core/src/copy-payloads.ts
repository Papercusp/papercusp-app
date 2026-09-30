/**
 * Pure helpers for building TSV + HTML clipboard payloads from a column set
 * and a row set. Extracted from RichGrid.tsx so they can be unit-tested
 * without React / jsdom — the same helpers can also be reused by future
 * grid variants (GridTable, DataGridShell) that want copy support.
 *
 * The HTML payload is a real `<table>` so Excel / Google Sheets paste it
 * as cells, not one long blob in a single cell. Plain text editors get
 * the TSV.
 */
import type { ColumnDef } from './RichGrid';

export function headerTextFor<TRow>(col: ColumnDef<TRow>): string {
  if (col.headerText !== undefined) return col.headerText;
  if (typeof col.header === 'string') return col.header;
  if (typeof col.header === 'number') return String(col.header);
  return col.key;
}

export function cellTextFor<TRow>(col: ColumnDef<TRow>, row: TRow): string {
  return col.toCopyText ? col.toCopyText(row) : '';
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function escapeTsvCell(s: string): string {
  // Tabs and newlines break TSV; replace with spaces. Spreadsheets accept
  // quoted multiline cells only with CSV, not TSV — TSV stays single-line.
  return s.replace(/[\t\r\n]+/g, ' ');
}

/**
 * Build TSV + HTML clipboard payloads. Both contain the header row + every
 * row in `rows`, in the order given. Pass a filtered subset if you only
 * want selected rows.
 */
export function buildCopyPayloads<TRow>(
  columns: ColumnDef<TRow>[],
  rows: readonly TRow[],
): { tsv: string; html: string } {
  const headerCells = columns.map(headerTextFor);
  const tsv = [
    headerCells.map(escapeTsvCell).join('\t'),
    ...rows.map((r) => columns.map((c) => escapeTsvCell(cellTextFor(c, r))).join('\t')),
  ].join('\n');
  const html =
    '<table>' +
    '<thead><tr>' +
    headerCells.map((h) => `<th>${escapeHtml(h)}</th>`).join('') +
    '</tr></thead>' +
    '<tbody>' +
    rows
      .map(
        (r) =>
          '<tr>' +
          columns.map((c) => `<td>${escapeHtml(cellTextFor(c, r))}</td>`).join('') +
          '</tr>',
      )
      .join('') +
    '</tbody>' +
    '</table>';
  return { tsv, html };
}
