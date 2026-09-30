/**
 * work_items:export — materialize work-item rows as JSON files on disk.
 *
 * Plan: project-history-real-completion-evidence-2026-08-18 (P-001, D-003).
 * The deliberate sibling of `plans:export { toDir }`, and it exists for exactly
 * the reason that one does: a BULK consumer cannot read many ledger rows through
 * the result payload.
 *
 * The result payload is a bounded transport. Measured on this box 2026-08-18: a
 * single-row pick-projected `work_items:get` returns ~4.1KB intact, TWO rows
 * already truncate (8.5KB in, 3.2KB out), and one fat row can exceed the budget
 * on its own (WI-38610, 8.5KB). Past the ceiling the projector replaces the whole
 * `results` array with `{ summary, _projection }` — so a consumer that reads
 * `payload.results` gets `[]`. It does not throw. It does not warn. It is
 * indistinguishable from "this harness has no completed work".
 *
 * That is not hypothetical: it is precisely how `papercusp project-history
 * generate` came to publish 327 of 327 work items as evidence-free plan-ledger
 * stubs while 505 fully-evidenced completions sat in the ledger (WI-39831). The
 * plan leg of that same generator has always worked — because it goes through
 * `plans:export { toDir }`, i.e. files, and never crosses the projector.
 *
 * D-003 therefore REJECTS "use a smaller batch" as the fix: no fixed N is safe
 * when a single row can exceed the budget alone. Bulk ledger reads leave the tool
 * plane as FILES.
 *
 * Read-only over PG; the `toDir` write target is an arbitrary caller-chosen path.
 * One file per row (`<toDir>/<id>.json`), mirroring plans:export's file-per-plan
 * layout, so a consumer can read exactly the ids it wants. The RESULT stays small
 * by construction — counts and a directory, never the rows themselves, so this
 * tool can never reintroduce the failure it exists to remove.
 */

import { z } from 'zod';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import {
  getWorkItem,
  listWorkItems,
  listAllWorkItemsForFileExport,
  TERMINAL_WORK_ITEM_STATES,
  WORK_ITEMS_MAX_LIMIT,
  type WorkItem,
} from '../../work-items';

const argsSchema = z.object({
  harness: z
    .string()
    .max(80)
    .optional()
    .describe('Harness slug to export. Required unless `ids` names the rows explicitly.'),
  ids: z
    .array(z.string().min(1))
    .max(WORK_ITEMS_MAX_LIMIT)
    .optional()
    .describe(
      'Export exactly these work-item ids. Omit to export the harness set selected by `terminalOnly`. An id that does not resolve is reported in `missing`, never silently dropped.',
    ),
  toDir: z
    .string()
    .min(1)
    .describe('Directory to write `<id>.json` files into (created if absent). Absolute, or resolved against the operator cwd.'),
  terminalOnly: z
    .boolean()
    .optional()
    .describe('When enumerating by harness (no `ids`), restrict to terminal rows. Default true — the completed-work set a history/audit consumer wants.'),
  includeObservations: z
    .boolean()
    .optional()
    .describe("Include `payload.lane === 'observation'` rows (agents' turn-end reflections). Default false, matching work_items:list."),
  limit: z
    .number()
    .int()
    .positive()
    .max(WORK_ITEMS_MAX_LIMIT)
    .optional()
    .describe(`Optional row cap when enumerating by harness. Omit for a complete file export; an explicit value is capped at ${WORK_ITEMS_MAX_LIMIT} and reported via truncatedByLimit when filled.`),
});

/**
 * A row is written whole. Field selection is deliberately NOT applied: this is a
 * file, so there is no budget to serve, and every past attempt to hand-pick the
 * "fields the consumer needs" has drifted from what the consumer actually reads.
 */
function serializeRow(row: WorkItem): string {
  return `${JSON.stringify(row, null, 2)}\n`;
}

export const WORK_ITEM_EXPORT_WRITE_CONCURRENCY = 64;

type WriteFile = (file: string, body: string, encoding: 'utf8') => Promise<void>;

/**
 * Keep large harness exports under the MCP deadline without opening one file
 * descriptor per row. Each slice finishes before the next starts, so at most 64
 * writes are in flight while every row still lands as its own complete JSON file.
 */
export async function writeWorkItemFiles(
  toDir: string,
  rows: readonly WorkItem[],
  writeFile: WriteFile = fs.writeFile,
): Promise<number> {
  for (let offset = 0; offset < rows.length; offset += WORK_ITEM_EXPORT_WRITE_CONCURRENCY) {
    await Promise.all(rows.slice(offset, offset + WORK_ITEM_EXPORT_WRITE_CONCURRENCY).map((row) =>
      writeFile(path.join(toDir, `${row.id}.json`), serializeRow(row), 'utf8')));
  }
  return rows.length;
}

export default defineTool({
  name: 'work_items:export',
  profile: 'engineer',
  description:
    'Materialize work-item rows as `<id>.json` files under `toDir` (the sibling of plans:export). For a BULK consumer — an exporter, an audit, a history projection — that must read many rows WITH their completion evidence, which the bounded result payload silently truncates to nothing. Returns counts and the directory, never the rows.',
  guidance: {
    when:
      'You are reading many work-item rows programmatically and need their full payload/terminalCompletionEvidence — e.g. a project-history export, a completion-integrity audit, an offline dump.',
    notWhen:
      'You want to READ a few items in-context → work_items:get (1–100 ids). You want to browse/filter the queue → work_items:list. This tool writes files and returns no rows, so it is useless for an in-context read.',
    chaining:
      'work_items:export { harness, toDir } → read the files → correlate with plans:export { toDir } for the plan side.',
    returns:
      '{ ok, toDir, written, missing[], truncatedByLimit } — `written` is a count, and the rows are on disk. `missing` names every requested id that did not resolve (an unreadable id is reported, never silently omitted). `truncatedByLimit` is true when a harness enumeration hit `limit`, so a partial export is never read as a complete one.',
    seeAlso: [
      'plans:export (the plan-side sibling: canonical markdown to a directory)',
      'work_items:get (in-context read of 1–100 ids)',
    ],
  },
  capability: 'work_items:read',
  // Writes files to a caller-chosen path — a real FS mutation — so it is
  // dry-run/confirm-gated despite riding the shared read capability. Same explicit
  // override, for the same reason, as plans:export. B-CX-EFFECT audit.
  effect: 'write',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...COORD_ROLES],
  modality: ['text'],
  args: argsSchema,
  result: z
    .object({
      ok: z.boolean().optional(),
      toDir: z.string().optional(),
      written: z.number().int().nonnegative().optional(),
      missing: z.array(z.unknown()).optional(),
      truncatedByLimit: z.boolean().optional(),
      error: z.string().optional(),
      message: z.string().optional(),
    })
    .passthrough(),
  async handler(args) {
    if (!args.ids && !args.harness) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: 'specify_ids_or_harness',
              message: 'Pass { ids } to export named rows, or { harness } to enumerate a harness.',
            }),
          },
        ],
        isError: true,
      };
    }

    const missing: string[] = [];
    let rows: WorkItem[];
    let truncatedByLimit = false;

    if (args.ids) {
      // Deduplicate but preserve the caller's order, so a diffable export does not
      // reshuffle when the caller passes the same set twice.
      const wanted = [...new Set(args.ids)];
      const resolved = await Promise.all(
        wanted.map(async (id) => ({ id, row: await getWorkItem(id, args.harness) })),
      );
      rows = [];
      for (const { id, row } of resolved) {
        if (row) rows.push(row);
        else missing.push(id);
      }
    } else {
      const filter = {
        harness: args.harness,
        ...(args.terminalOnly === false ? {} : { states: TERMINAL_WORK_ITEM_STATES }),
        ...(args.includeObservations ? { includeObservations: true } : {}),
      };
      rows = args.limit === undefined
        ? await listAllWorkItemsForFileExport(filter)
        : await listWorkItems({ ...filter, limit: args.limit });
      // An explicitly capped enumeration that exactly fills `limit` may have more
      // behind it. Omitted limit uses the exporter-only complete path instead.
      truncatedByLimit = args.limit !== undefined && rows.length >= args.limit;
    }

    await fs.mkdir(args.toDir, { recursive: true });
    const written = await writeWorkItemFiles(args.toDir, rows);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            toDir: args.toDir,
            written,
            missing,
            truncatedByLimit,
          }),
        },
      ],
    };
  },
});
