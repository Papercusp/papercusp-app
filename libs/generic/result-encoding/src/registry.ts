/**
 * The central pre-prompt registry (plan `token-efficient-agent-io-2026-06-06`,
 * D-002/D-008).
 *
 * Whether a tool's column schema is injected into the agent prompt is a
 * cross-cutting BUDGET POLICY — "does this tool earn prompt space?" — not a
 * property of the tool. It depends on call-frequency and the whole list's total
 * size, which no single `defineTool` knows. So the decision lives here, OUTSIDE
 * `defineTool`: one governed, telemetry-derived (D-008) list of tool names, with
 * an optional per-tool read/write override. The per-tool SCHEMA still lives on
 * the tool (`defineTool({ args, result })`); this registry only references it.
 *
 * Domain-free: the list itself (Papercusp tool names) is injected by the host via
 * `configurePrePromptRegistry`, mirroring the projected-tool registry pattern —
 * a configured singleton shared across the workspace (read path, write shim, and
 * prompt generator all consult the same instance). Nothing here names a tool.
 */

import type { ResultFormat } from './formats';
import type { ColumnOverride } from './positional';

/** Read-side compact format for a registry tool, or `'off'` to leave it on the default (TOON-auto) path. */
export type ReadEncoding = Extract<ResultFormat, 'csv' | 'tsv' | 'toon'> | 'off';
/** Write-side encoding: `'positional'` accepts a positional row + reconstructs; `'off'` stays typed-JSON. */
export type WriteEncoding = 'positional' | 'off';

export interface PrePromptEntry {
  /** Full tool name, e.g. `coord:inbox`, `work_items:set_state`. */
  name: string;
  /**
   * Read override. Default `'csv'` — Tier-3 headerless CSV + `[N]` guard, columns
   * in the prompt. Only takes effect when the tool's output `data` schema is a
   * flat scalar array (columns derivable); otherwise the tool stays on TOON-auto.
   */
  read?: ReadEncoding;
  /** Write override. Default `'off'`. `'positional'` opts the tool into the positional-arg shim. */
  write?: WriteEncoding;
  /** Pins which arg is the trailing free-text column for the positional shim (overrides the name heuristic). */
  freeTextArg?: string;
  /**
   * Explicit write-row columns when a bulk-capable tool's full args schema
   * contains non-row fields (ids/items/decision/...) alongside the common
   * single-item shorthand. The row projection is derived from ONLY these
   * top-level properties, in this order; missing names make the tool
   * ineligible. Omit for the normal "project the whole flat args object" path.
   */
  writeColumnNames?: readonly string[];
  /**
   * Columns that are required in the positional row even when the full keyed
   * schema marks them optional because another keyed shape (`ids`, `items`) may
   * be supplied instead. Must be a subset of `writeColumnNames`.
   */
  writeRequiredColumnNames?: readonly string[];
  /**
   * Advertise BOTH row-string and full keyed args (`oneOf`) for write-positional
   * tools whose keyed bulk shape remains a first-class API. Runtime dispatch
   * already falls through to keyed args when `row` is absent; this only exposes
   * both shapes in tools/list.
   */
  writeKeyedFallback?: boolean;
  /**
   * Per-column sanity overrides the tool's own Zod schema can't express — e.g.
   * an `id` arg that accepts several id-family prefixes, or a `state` arg typed
   * as a loose string so it can carry cross-family aliases. Merged onto the
   * schema-projected columns by `projectWriteColumns` (D-007 residual —
   * EI-7927); only tightens the misalignment guard, never loosens a
   * schema-derived check. Keyed by arg/column name.
   */
  columnOverrides?: Record<string, ColumnOverride>;
  /** One-line note (why it's here / its call-frequency) — surfaced in audits, not on the wire. */
  note?: string;
}

interface NormalizedEntry extends PrePromptEntry {
  read: ReadEncoding;
  write: WriteEncoding;
}

let REGISTRY: Map<string, NormalizedEntry> = new Map();

function normalize(e: PrePromptEntry): NormalizedEntry {
  return { ...e, read: e.read ?? 'csv', write: e.write ?? 'off' };
}

/**
 * Install the curated list (replaces any prior list). Called once by the host at
 * startup with the telemetry-derived, breakeven-gated set (D-008). Idempotent —
 * safe to call again to re-configure.
 */
export function configurePrePromptRegistry(entries: ReadonlyArray<PrePromptEntry>): void {
  const next = new Map<string, NormalizedEntry>();
  for (const e of entries) next.set(e.name, normalize(e));
  REGISTRY = next;
}

/** Clear the registry (test isolation). */
export function clearPrePromptRegistry(): void {
  REGISTRY = new Map();
}

/** The full normalized entry for a tool, or `undefined` if it isn't pre-prompted. */
export function getPrePromptEntry(name: string): NormalizedEntry | undefined {
  return REGISTRY.get(name);
}

/** Every configured entry, in insertion (curation) order. */
export function listPrePromptEntries(): NormalizedEntry[] {
  return [...REGISTRY.values()];
}

/** Is this tool's list RESULT served as a Tier-3 prompt-declared compact format (read)? */
export function readPrePromptFormat(name: string): Exclude<ReadEncoding, 'off'> | undefined {
  const e = REGISTRY.get(name);
  if (!e || e.read === 'off') return undefined;
  return e.read;
}

/**
 * Is this read encoding POSITIONAL — i.e. does the payload omit its column
 * names, making the prompt's "## Wire schemas" legend load-bearing for reading
 * it? True for the headerless `csv`/`tsv` bodies; false for `toon` (which
 * carries `fields[N]:` inline) and `off`.
 *
 * The single predicate behind BOTH ends of the positional protocol: the read
 * encoder (`tryTier3Read`) and the legend generator (`renderWireSchemasSection`)
 * must agree exactly, or the model is handed column declarations for a payload
 * that doesn't need them (dead weight, and it instructs a position→column
 * mapping the wire no longer uses) — or worse, positional bytes with no legend.
 * Deriving both from here is the same anti-desync discipline as the shared
 * `projectReadColumns`/`projectWriteColumns` projection.
 */
export function isPositionalReadEncoding(fmt: ReadEncoding | undefined): fmt is 'csv' | 'tsv' {
  return fmt === 'csv' || fmt === 'tsv';
}

/** Does this tool accept a positional row for its ARGS (write)? */
export function isWritePositional(name: string): boolean {
  return REGISTRY.get(name)?.write === 'positional';
}
