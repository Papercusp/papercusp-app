/**
 * capability:notebook_edit — replace, insert, or delete ONE cell of a Jupyter
 * notebook (.ipynb) under managed authority and the file lock.
 *
 * Closes the notebook half of the `patch-notebook-adapters` gap inventoried by P-001
 * (`libs/papercusp/packages/orchestrator/src/managed-capability-contract.ts`, family
 * `edit-write-patch-notebook`). Its falsifier: "Hermetic and real-client tests prove
 * atomic multi-file patch and notebook semantics through managed authority and locks."
 *
 * Why a notebook cannot be edited with capability:edit or capability:patch. An .ipynb
 * is a JSON document, not a text file: a cell's `source` is a JSON array of
 * newline-terminated string LITERALS, so the text a reader sees ("def f():") never
 * appears in the file in that form — every character is JSON-escaped and split across
 * array elements. A literal-splice door therefore either misses entirely or, worse,
 * matches a fragment and writes JSON that no longer parses. This adapter parses,
 * mutates the addressed cell, and re-serializes.
 *
 * NOTEBOOK SEMANTICS this door owns, none of which a text splice can honor:
 *   - `source` is written back in the representation the file already uses (array of
 *     lines vs single string), and the file's JSON indentation and trailing newline
 *     are preserved — otherwise a one-cell edit reformats every line of the notebook
 *     and produces a diff nobody can review.
 *   - Replacing a CODE cell's source CLEARS its `outputs` and `execution_count`.
 *     Stale outputs are not merely untidy: they assert a result the new source never
 *     produced, and both Jupyter and nbconvert will render them as if it had.
 *   - A `cell_type` change fixes the cell's schema-required fields — markdown cells
 *     must NOT carry `outputs`/`execution_count`, code cells MUST.
 *   - Cell `id` exists only at nbformat 4.5+. An inserted cell gets a fresh unique id
 *     there and NO id below it, because an id in a 4.4 notebook is schema-invalid.
 *     Below 4.5 there are no ids to address, so `cell_id` also accepts an index.
 *
 * Honest failure contract (plan D-005 — never claim a property the mechanism lacks):
 * every rejection (not a notebook, unparseable JSON, unknown cell, missing source)
 * is decided BEFORE the single write, so a rejected call leaves the file
 * byte-unchanged. One `writeFileSync` of the whole document is the only mutation.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { fileLockedResult, guardFileLock } from '../locks/file-lock-guard';
import { resolveCapabilityBaseDir } from './base-dir';

type Cell = Record<string, unknown> & { cell_type?: unknown; id?: unknown; source?: unknown };
type Notebook = Record<string, unknown> & { cells?: unknown; nbformat?: unknown; nbformat_minor?: unknown };

export default defineTool({
  name: 'capability:notebook_edit',
  description:
    'Replace, insert, or delete ONE cell of a Jupyter notebook (.ipynb) under the managed file lock. Parses the notebook, so it honors cell addressing, source-array representation, stale-output clearing and cell-type schema rules that a text splice cannot — never edit an .ipynb with capability:edit or capability:patch.',
  guidance: {
    when: 'Any change to a .ipynb cell: rewriting a cell body, adding a cell, or removing one.',
    notWhen: 'A plain text file (capability:edit), several files at once (capability:patch), or a whole-file rewrite (capability:write).',
    chaining:
      'capability:read the notebook to get each cell id → capability:notebook_edit. Replacing a code cell clears its outputs; re-run the notebook to regenerate them. On file_locked, nothing was written.',
    seeAlso: ['capability:read (cell ids)', 'capability:edit (text files)', 'capability:patch (many files at once)'],
  },
  capability: 'capability:fs-write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    notebook_path: z.string().min(1).describe('Absolute path to the .ipynb, or relative to the project dir.'),
    edit_mode: z
      .enum(['replace', 'insert', 'delete'])
      .optional()
      .describe("Default 'replace'. 'insert' adds a new cell AFTER cell_id (or first, if omitted); 'delete' removes it."),
    cell_id: z
      .string()
      .optional()
      .describe("The cell's id. Required for replace/delete. Below nbformat 4.5 cells have no ids, so a 0-based index is also accepted."),
    cell_type: z.enum(['code', 'markdown']).optional().describe('Required for insert. On replace, converts the cell.'),
    new_source: z.string().optional().describe('The cell body. Required for replace and insert; ignored by delete.'),
  }),
  async handler(args, ctx) {
    const baseDir = resolveCapabilityBaseDir(ctx);
    const abs = isAbsolute(args.notebook_path) ? args.notebook_path : resolve(baseDir, args.notebook_path);
    const mode = args.edit_mode ?? 'replace';

    // Argument-only rejections, before the lock: nothing to coordinate if the call
    // can never be valid.
    if (mode !== 'delete' && args.new_source === undefined) {
      return err('missing_new_source', `edit_mode '${mode}' requires new_source.`);
    }
    if (mode === 'insert' && args.cell_type === undefined) {
      return err('missing_cell_type', "edit_mode 'insert' requires cell_type ('code' or 'markdown').");
    }
    if (mode !== 'insert' && args.cell_id === undefined) {
      return err('missing_cell_id', `edit_mode '${mode}' requires cell_id. Read the notebook to get the cell's id.`);
    }

    const outcome = await guardFileLock(ctx, [abs], { intent: `capability:notebook_edit (${mode} ${abs})` }, async () => {
      let raw: string;
      try {
        raw = readFileSync(abs, 'utf8');
      } catch (e: unknown) {
        return err('read_failed', `${abs}: ${e instanceof Error ? e.message : String(e)}`);
      }

      let nb: Notebook;
      try {
        nb = JSON.parse(raw) as Notebook;
      } catch (e: unknown) {
        return err(
          'not_a_notebook',
          `${abs} is not valid JSON, so it cannot be a notebook: ${e instanceof Error ? e.message : String(e)}. No file was written.`,
        );
      }
      if (nb === null || typeof nb !== 'object' || Array.isArray(nb) || !Array.isArray(nb.cells)) {
        return err('not_a_notebook', `${abs} parses as JSON but has no 'cells' array, so it is not an .ipynb. No file was written.`);
      }

      const cells = nb.cells as Cell[];
      // Preserve how this file already writes itself, so the diff stays reviewable.
      const style = sourceStyle(cells);
      const indent = detectIndent(raw);
      const trailingNewline = raw.endsWith('\n');
      const minor = typeof nb.nbformat_minor === 'number' ? nb.nbformat_minor : 0;
      const major = typeof nb.nbformat === 'number' ? nb.nbformat : 4;
      const idsSupported = major > 4 || (major === 4 && minor >= 5);

      let index: number;
      if (args.cell_id === undefined) {
        index = -1; // insert-at-start only; the mode checks above guarantee this.
      } else {
        index = findCell(cells, args.cell_id);
        if (index === -1) {
          return err(
            'cell_not_found',
            `No cell '${args.cell_id}' in ${abs} (${cells.length} cell(s)). ${describeAddresses(cells, idsSupported)} No file was written.`,
          );
        }
      }

      let action: Record<string, unknown>;
      if (mode === 'delete') {
        const removed = cells[index]!;
        cells.splice(index, 1);
        action = { deletedIndex: index, deletedType: removed.cell_type ?? null, cellsRemaining: cells.length };
      } else if (mode === 'insert') {
        const at = index + 1; // after the addressed cell; 0 when cell_id was omitted
        const fresh: Cell = { cell_type: args.cell_type! };
        if (idsSupported) fresh.id = freshId(cells);
        fresh.metadata = {};
        fresh.source = render(args.new_source!, style);
        if (args.cell_type === 'code') {
          fresh.execution_count = null;
          fresh.outputs = [];
        }
        cells.splice(at, 0, fresh);
        action = { insertedIndex: at, insertedId: fresh.id ?? null, cellType: args.cell_type, cellsTotal: cells.length };
      } else {
        const cell = cells[index]!;
        const wasType = typeof cell.cell_type === 'string' ? cell.cell_type : 'code';
        const nextType = args.cell_type ?? wasType;
        cell.cell_type = nextType;
        cell.source = render(args.new_source!, style);

        // The source changed, so any recorded output is now a claim about code that no
        // longer exists. Clear it rather than leave it asserting a stale result.
        let clearedOutputs = false;
        if (nextType === 'code') {
          const had = Array.isArray(cell.outputs) && (cell.outputs as unknown[]).length > 0;
          cell.outputs = [];
          cell.execution_count = null;
          clearedOutputs = had;
        } else {
          // Markdown cells must not carry these at all (nbformat schema).
          if ('outputs' in cell) delete cell.outputs;
          if ('execution_count' in cell) delete cell.execution_count;
        }
        action = {
          replacedIndex: index,
          replacedId: typeof cell.id === 'string' ? cell.id : null,
          cellType: nextType,
          cellTypeChangedFrom: nextType === wasType ? null : wasType,
          clearedOutputs,
        };
      }

      const serialized = JSON.stringify(nb, null, indent) + (trailingNewline ? '\n' : '');
      try {
        writeFileSync(abs, serialized, 'utf8');
      } catch (e: unknown) {
        return err('write_failed', `${abs}: ${e instanceof Error ? e.message : String(e)}. The notebook is unchanged.`);
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              path: abs,
              edit_mode: mode,
              ...action,
              // Named, not implied: this door preserved the file's own formatting rather
              // than imposing its own.
              preserved: { sourceStyle: style, jsonIndent: indent, trailingNewline, cellIds: idsSupported },
            }),
          },
        ],
      };
    });

    return outcome.acquired ? outcome.result : await fileLockedResult(outcome.busy, outcome.reader);
  },
});

/**
 * Resolve `cell_id` to an index. An exact `id` match wins; a bare integer then falls
 * back to a 0-based index, which is the ONLY way to address a cell below nbformat 4.5
 * (where the `id` field is schema-invalid and therefore absent).
 */
function findCell(cells: readonly Cell[], cellId: string): number {
  const byId = cells.findIndex((c) => typeof c.id === 'string' && c.id === cellId);
  if (byId !== -1) return byId;
  if (/^\d+$/.test(cellId)) {
    const i = Number(cellId);
    if (i >= 0 && i < cells.length) return i;
  }
  return -1;
}

/** Failure-path only, so it costs no prompt weight: tell the caller HOW to address cells here. */
function describeAddresses(cells: readonly Cell[], idsSupported: boolean): string {
  const ids = cells.map((c) => (typeof c.id === 'string' ? c.id : null)).filter((x): x is string => x !== null);
  if (ids.length > 0) {
    const shown = ids.slice(0, 12);
    return `Known ids: ${shown.join(', ')}${ids.length > shown.length ? `, … (+${ids.length - shown.length})` : ''}.`;
  }
  return idsSupported
    ? 'This notebook declares nbformat 4.5+ but no cell carries an id; address cells by 0-based index instead.'
    : 'This notebook predates nbformat 4.5, so cells have no ids — address them by 0-based index (0 … ' + String(Math.max(cells.length - 1, 0)) + ').';
}

/** A fresh nbformat-legal cell id (`^[a-zA-Z0-9-_]+$`, 1–64 chars) unique within the notebook. */
function freshId(cells: readonly Cell[]): string {
  const taken = new Set(cells.map((c) => (typeof c.id === 'string' ? c.id : '')));
  for (let attempt = 0; attempt < 64; attempt++) {
    const id = randomUUID().replace(/-/g, '').slice(0, 8);
    if (!taken.has(id)) return id;
  }
  return randomUUID();
}

/**
 * Which representation this notebook uses for `source`. nbformat permits either a
 * single string or an array of lines; Jupyter itself writes the array form, but a
 * hand-written or tool-generated notebook may use strings throughout. Matching the
 * file keeps the edit's diff to the cell that changed.
 */
function sourceStyle(cells: readonly Cell[]): 'array' | 'string' {
  let arrays = 0;
  let strings = 0;
  for (const c of cells) {
    if (Array.isArray(c.source)) arrays++;
    else if (typeof c.source === 'string') strings++;
  }
  return strings > arrays ? 'string' : 'array';
}

function render(source: string, style: 'array' | 'string'): string | string[] {
  return style === 'string' ? source : toSourceLines(source);
}

/**
 * Split into nbformat's line form: every element keeps its own trailing newline and
 * the last has one only if the source ended with one. That is what Jupyter writes, and
 * `''.join(source)` must reproduce the body exactly.
 */
function toSourceLines(source: string): string[] {
  if (source === '') return [];
  const parts = source.split('\n');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    if (isLast) {
      if (parts[i] !== '') out.push(parts[i]!);
    } else {
      out.push(parts[i]! + '\n');
    }
  }
  return out;
}

/**
 * The file's own JSON indentation, so re-serializing does not rewrite every line.
 * Jupyter writes `indent=1`; 0 means the notebook is minified and stays minified.
 */
function detectIndent(raw: string): number {
  const m = /\n([ \t]*)"/.exec(raw);
  if (m === null) return 0;
  return m[1]!.length;
}

function err(reason: string, message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, reason, message }) }],
    isError: true,
  };
}
