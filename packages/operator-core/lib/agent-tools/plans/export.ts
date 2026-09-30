/**
 * plans:export — produce a plan's canonical markdown on demand.
 *
 * Plan: plans-pg-canonical-migration-2026-06-03 (D-001). Plans are PG-canonical;
 * the markdown is rendered on demand rather than stored as tracked files. This
 * tool is the explicit export surface (alongside plans:get's `raw` field and the
 * admin UI):
 *
 *   - `{ slug }`  → return that plan's markdown (the canonical `content` blob).
 *   - `{ toDir }` → re-materialize every plan for the harness as `.md` files
 *                   under `toDir` (live at the root, archived under `archive/`).
 *                   The inverse of the FS→PG backfill — for a one-off offline
 *                   copy / git export / debugging.
 *
 * Read-only over PG; the `toDir` write target is an arbitrary caller-chosen path
 * (never the retired docs/plans/ source location).
 */

import { z } from 'zod';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getPlanRow, listPlanRows } from './source';
import { ctxToPlanSourceOpts } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';

const argsSchema = z.object({
  harness: harnessArg,
  slug: z
    .string()
    .min(1)
    .optional()
    .describe('Export one plan by slug — returns its canonical markdown. Omit with `toDir` to export all.'),
  toDir: z
    .string()
    .min(1)
    .optional()
    .describe('Re-materialize every plan for the harness as .md files under this absolute directory (archived plans under archive/). Returns the count written.'),
});

export default defineTool({
  name: 'plans:export',
  description:
    "Produce a plan's canonical markdown on demand (plans are PG-canonical; markdown is rendered, not stored as tracked files). `{ slug }` returns one plan's markdown; `{ toDir }` re-materializes every plan as .md files under that directory.",
  guidance: {
    when: 'You need the raw markdown of a plan to pipe/share, or want a one-off offline dump of all plans as files.',
    notWhen:
      'You want the parsed structure (items/decisions/now) — use plans:get. You want to edit a plan — use a concrete write verb such as plans:set-content or plans:set-now (they write PG).',
    chaining: 'plans:list → plans:export { slug } for the markdown of any plan.',
  },
  capability: 'plans:read',
  // `{ toDir }` re-materializes every plan as .md files on disk — a real FS mutation, so it
  // must be dry-run/confirm-gated even though the capability is the shared read cap
  // `plans:read`. An explicit override (not WRITE_CAPABILITIES) so plans:read's many genuine
  // readers stay read. B-CX-EFFECT audit.
  effect: 'write',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...SU_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const sctx = harnessScopedCtx(args.harness, ctx);
    const opts = await ctxToPlanSourceOpts(sctx);

    if (args.slug) {
      const row = await getPlanRow(args.slug, opts);
      if (!row) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'not_found', slug: args.slug }) }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ slug: row.planSlug, markdown: row.content }) }],
      };
    }

    if (args.toDir) {
      const rows = await listPlanRows({ ...opts, includeArchived: true });
      let written = 0;
      for (const row of rows) {
        const dir = row.archived ? path.join(args.toDir, 'archive') : args.toDir;
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, `${row.planSlug}.md`), row.content, 'utf8');
        written++;
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, toDir: args.toDir, written }) }],
      };
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ error: 'specify_slug_or_toDir', message: 'Pass { slug } for one plan or { toDir } to export all.' }) }],
      isError: true,
    };
  },
});
