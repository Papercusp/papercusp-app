/**
 * features:history — the rendered feature-history block for one OR many features.
 *
 * Same data path as the prompt-injected version (orchestrator's
 * `feature-history.ts`): notes + debugger findings + recent audit
 * transitions, read PG-only. Useful when:
 *   - The agent's prompt-injected version was capped (long history).
 *   - The agent is exploring a non-current feature.
 *
 * Returns the rendered markdown string verbatim. Caller can re-format.
 *
 * Bulk by default (the house keyed-array contract,
 * bulk-endpoint-standardization-2026-06-21): the feature key is the COMPOUND
 * `(slug, feature_id)`, and the per-section caps ride per item. Pass a single
 * `{ slug, feature_id, notes_max_chars?, debug_max_chars?, audit_rows? }` for
 * n=1, or `items:[{ … }]` for many → { ok, results:[{ ok, slug, feature_id,
 * history? | error }], counts }. Each result self-describes its (slug,
 * feature_id); a degraded / invalid-slug item fails only itself.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/tooldef';
import type { PapercuspToolContext } from '@papercusp/operator-core/lib/agent-tools/_tool-context';
// The bulk helpers' LEAF module — relative, NOT the '@papercusp/agent-mcp'
// barrel (see features/get.ts for why: ESM circular-init + node-moduleResolution).
import { runBulk, bulkContent } from '../../_bulk';

const SLUG_RE = /^[a-z0-9._-]+$/i;

interface AuditRow {
  ts: number;
  field: string;
  old_value: string | null;
  new_value: string | null;
  actor: string;
}

/** Per-section caps — defaults match the orchestrator's prompt injection. */
const CapsShape = {
  notes_max_chars: z.number().int().positive().max(20000).default(4000),
  debug_max_chars: z.number().int().positive().max(20000).default(4000),
  audit_rows: z.number().int().positive().max(100).default(10),
};

const HistoryItem = z.object({
  slug: z.string().min(1),
  feature_id: z.string().min(1),
  ...CapsShape,
});
type HistoryItem = z.infer<typeof HistoryItem>;

export default defineTool({
  name: 'features:history',
  needsWorkspaceTx: true,
  profile: 'engineer',
  capability: 'features:read',
  description:
    'Render the history block (notes + debugger findings + recent audit transitions) for one OR many features. Pass a single `{ slug, feature_id, notes_max_chars?, debug_max_chars?, audit_rows? }` or `items:[{ … }]` for several. Returns { ok, results:[{ ok, slug, feature_id, history? | error }], counts } — correlate by (slug, feature_id), not by position; a no-history / invalid-slug item fails only itself.',
  guidance: {
    when: 'User asks "what changed on feature X?", "who edited the spec?", or you need a timeline of edits. Pass every (slug, feature_id) at once via `items`.',
    notWhen: 'For the CURRENT body, use `features:get`. For cross-feature audit, use `audit:list`.',
    chaining: 'Bulk: single { slug, feature_id, … } | items[] → { ok, results, counts }; correlate by (slug, feature_id) not position; one failure never fails the rest.',
  },
  args: z
    .object({
      slug: z.string().min(1).optional().describe('a single feature\'s harness slug (n=1 shorthand, paired with feature_id)'),
      feature_id: z.string().min(1).optional().describe('a single feature id (n=1 shorthand, paired with slug)'),
      ...CapsShape,
      items: z
        .array(HistoryItem)
        .min(1)
        .max(100)
        .optional()
        .describe('feature keys + per-item caps (1–100), each { slug, feature_id, notes_max_chars?, debug_max_chars?, audit_rows? }'),
    })
    .refine((a) => Boolean(a.items?.length) || (Boolean(a.slug) && Boolean(a.feature_id)), {
      message: 'pass `{ slug, feature_id }` (one) or `items:[{ slug, feature_id }]` (many)',
    }),
  async handler(args, ctx: PapercuspToolContext) {
    const tx = ctx.tx!;
    const items: HistoryItem[] =
      args.items?.length
        ? args.items
        : [
            {
              slug: args.slug!,
              feature_id: args.feature_id!,
              notes_max_chars: args.notes_max_chars,
              debug_max_chars: args.debug_max_chars,
              audit_rows: args.audit_rows,
            },
          ];
    // harness_shared tables have no RLS policies, so we filter explicitly by
    // workspace_id (sourced from the principal). Other tools that target
    // per-harness schemas can rely on the tx's app.workspace_id GUC + RLS.
    const ws = ctx.principal.workspaceId;
    const env = await runBulk(
      items,
      async (item) => {
        const { slug, feature_id, notes_max_chars, debug_max_chars, audit_rows } = item;
        if (!SLUG_RE.test(slug)) {
          return { ok: false as const, slug, feature_id, error: `invalid slug ${JSON.stringify(slug)}` };
        }
        const [notesRows, debugRows, auditList] = await Promise.all([
          tx<Array<{ content: string }>>`
            SELECT content
              FROM harness_shared.harness_feature_notes
             WHERE workspace_id = ${ws} AND harness_slug = ${slug} AND feature_id = ${feature_id}
             LIMIT 1
          `.catch(() => [] as Array<{ content: string }>),
          tx<Array<{ content: string }>>`
            SELECT content
              FROM harness_shared.harness_feature_debug_notes
             WHERE workspace_id = ${ws} AND harness_slug = ${slug} AND feature_id = ${feature_id}
             LIMIT 1
          `.catch(() => [] as Array<{ content: string }>),
          tx<AuditRow[]>`
            SELECT ts, field, old_value, new_value, actor
              FROM harness_shared.feature_audit_consolidated
             WHERE workspace_id = ${ws} AND harness_slug = ${slug} AND feature_id = ${feature_id}
             ORDER BY ts DESC
             LIMIT ${audit_rows}
          `.catch(() => [] as AuditRow[]),
        ]);

        const sections: string[] = [];
        if (notesRows.length && notesRows[0].content?.trim()) {
          sections.push('### Notes', truncate(notesRows[0].content, notes_max_chars));
        }
        if (debugRows.length && debugRows[0].content?.trim()) {
          sections.push('### Debugger findings', truncate(debugRows[0].content, debug_max_chars));
        }
        if (auditList.length) {
          sections.push('### Recent activity');
          for (const row of auditList) {
            sections.push(formatAuditRow(row));
          }
        }
        if (!sections.length) {
          return { ok: false as const, slug, feature_id, error: `no history yet for ${feature_id} in ${slug}` };
        }
        const rendered = [`## This feature's history (${feature_id})`, ...sections].join('\n');
        return { ok: true as const, slug, feature_id, history: rendered };
      },
      { keyOf: ({ slug, feature_id }) => ({ slug, feature_id }) },
    );
    return bulkContent(env);
  },
});

function truncate(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + '\n\n[…truncated, exceeded ' + maxChars + ' chars]';
}

function formatAuditRow(row: AuditRow): string {
  const iso = new Date(Number(row.ts)).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const oldS = renderAuditValue(row.old_value);
  const newS = renderAuditValue(row.new_value);
  const arrow = oldS === '' ? `→ ${newS}` : `${oldS} → ${newS}`;
  return `- ${iso} \`${row.field}\` ${arrow} (${row.actor})`;
}

function renderAuditValue(v: string | null): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string' && v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1);
  }
  return v;
}
