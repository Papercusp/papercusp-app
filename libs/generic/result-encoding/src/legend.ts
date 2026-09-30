/**
 * The "## Wire schemas" prompt legend (plan `token-efficient-agent-io-2026-06-06`,
 * P-003/D-001). One generated section, spliced into the agent prompt, that
 * declares — once per session — the column schema for every registry tool. It is
 * the OTHER end of the positional protocol: because the read encoder and the
 * write shim both derive their columns from the same `ColumnSpec[]` this renders,
 * the legend the model reads is guaranteed to match the bytes on the wire (the
 * anti-desync equality test asserts it).
 *
 * Domain-free: the host passes the registry entries + a `columnsFor(name, dir)`
 * lookup (which projects each tool's own schema). This module only formats.
 */

import type { ColumnSpec, ColumnType } from './positional';
import type { PrePromptEntry } from './registry';

/** What the host must supply per tool: its read/write column projections (from the tool's own schema). */
export interface ToolColumnSource {
  /** Columns of the tool's list RESULT, or undefined if not read-pre-prompted / no flat-array schema. */
  read?: ColumnSpec[];
  /** Columns of the tool's ARGS for the positional shim, or undefined if not write-positional / unfit. */
  write?: ColumnSpec[];
}

export type ColumnsLookup = (entry: PrePromptEntry) => ToolColumnSource;

function typeTag(c: ColumnSpec): string {
  const base: Record<ColumnType, string> = {
    string: 'str',
    number: 'num',
    integer: 'int',
    boolean: 'bool',
    enum: 'enum',
    id: 'id',
    text: 'text',
  };
  let tag = base[c.type];
  if (c.type === 'enum' && c.enumValues) tag = c.enumValues.join('|');
  const flags = `${c.optional ? '?' : ''}${c.nullable ? '∅' : ''}`;
  return `${c.name}:${tag}${flags}`;
}

function columnLine(prefix: string, cols: ColumnSpec[]): string {
  return `${prefix} ${cols.map(typeTag).join(', ')}`;
}

/**
 * Render the "## Wire schemas" section. Returns '' when no registry tool has
 * derivable columns (so the marker collapses to nothing rather than an empty
 * heading). The body explains the read/write contract once, then lists each
 * tool's columns.
 */
export function renderWireSchemas(entries: ReadonlyArray<PrePromptEntry>, lookup: ColumnsLookup): string {
  const blocks: string[] = [];
  for (const entry of entries) {
    const src = lookup(entry);
    const parts: string[] = [];
    if (src.read && src.read.length > 0) parts.push(columnLine('  read →', src.read));
    if (src.write && src.write.length > 0) parts.push(columnLine('  write ←', src.write));
    if (parts.length === 0) continue;
    blocks.push([`- \`${entry.name}\``, ...parts].join('\n'));
  }
  if (blocks.length === 0) return '';

  const preamble = [
    '## Wire schemas',
    '',
    'These high-frequency tools use **prompt-declared column schemas** — the columns',
    'live here, not on the wire, so only values travel. Column tags: `str`/`num`/`int`/',
    '`bool` scalar, `id` identifier, `enum` shows its members, `text` = free-text; `?` =',
    'optional, `∅` = nullable.',
    '',
    '- **read →** Results arrive as **headerless CSV**: a `[N]` row-count line (so you can',
    "  tell if it was truncated) then N rows of comma-separated VALUES in the column order",
    '  listed below. No header row — map positions to the columns here.',
    '- **write ←** Call these tools with a JSON object containing one `row` argument; the',
    '  row value is the VALUES in the column order below, comma-separated. The sanctioned',
    '  `ptool --json -` fallback therefore wraps the row as `{ "row": "value1,value2" }`.',
    '  Omit trailing optional columns. A `text` column is always last and may contain commas',
    '  — do not quote or escape it inside the row value.',
    '',
  ].join('\n');
  return `${preamble}${blocks.join('\n')}`;
}
