/**
 * harness_docs:retire — remove a harness_docs tracking row for a doc whose
 * underlying file is gone (moved/deleted), so the freshness sweep stops
 * flagging debris it can never heal (EI-6492 / EI-5921-adjacent: a
 * bodyMissing:true row for a file that was relocated to docs/archive/ sits in
 * status `review` forever — auto-heal gives up after its attempt cap, and
 * until now there was no delete/retire verb to clear the stale row).
 *
 * This ONLY removes the PG tracking record (harness_shared.harness_docs) —
 * it never touches any file on disk. The caller is responsible for having
 * confirmed the doc's file is genuinely gone (or intentionally untracked)
 * before retiring its row; retiring the row for a doc whose file still
 * exists just makes it `untracked` again (harmless, but pointless — prefer
 * harness_docs:anchor/regenerate for a live doc).
 *
 * Bulk by default (the house keyed-array contract,
 * bulk-endpoint-standardization-2026-06-21): retire ONE doc inline
 * ({ docId }), or MANY heterogeneous (items:[{ docId, harness? }]) →
 * { ok, results:[{ ok, docId, existed? | error }], counts }. Each result
 * self-describes its docId; one failure never fails the rest. Harness is a
 * batch default with a per-item override.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { harnessArg, resolveBulkHarnessScopes } from '../_harness-scope';
import { getDocRecord, deleteDocRecord } from '../../harness/docs/doc-record';
import { runBulk, bulkContent } from '../_bulk';

const itemSpec = z.object({
  docId: z.string().min(1).describe("The doc's path relative to the docs root (as shown in harness_docs:list)."),
  harness: z.string().min(1).max(80).optional().describe('per-item harness (else the batch `harness` default)'),
});

const argsSchema = z
  .object({
    harness: harnessArg,
    docId: z.string().min(1).optional().describe("single-retire shorthand: the doc's path relative to the docs root."),
    items: z.array(itemSpec).min(1).max(200).optional().describe('retire many docs at once — each { docId, harness? }'),
  })
  .refine((a) => (a.items?.length ?? 0) > 0 || Boolean(a.docId), {
    message: 'pass { docId } for one, or items:[{ docId }] for many',
  });

async function retireOne(harnessSlug: string, rawDocId: string) {
  const docId = rawDocId.trim().replace(/^\.?\//, '');
  const existing = await getDocRecord(harnessSlug, docId);
  if (!existing) {
    return { ok: true as const, docId, existed: false };
  }
  await deleteDocRecord(harnessSlug, docId);
  return { ok: true as const, docId, existed: true };
}

export default defineTool({
  name: 'harness_docs:retire',
  description:
    'Remove a stale harness_docs tracking row (a doc whose file was moved/deleted, e.g. into docs/archive/) so the freshness sweep stops perpetually flagging it as review/bodyMissing. Only deletes the PG tracking record, never a file. Single: { docId }. Many: items:[{ docId, harness? }]. Returns { ok, results:[{ ok, docId, existed? | error }], counts } — correlate by docId not position; one failure never fails the rest.',
  guidance: {
    when:
      "A harness_docs:list row shows status review/bodyMissing (or the freshness sweep gave up healing it) because its file was moved/deleted — confirm the file is genuinely gone (or relocated with a fresh tracked twin) before retiring.",
    notWhen:
      "The doc's file still exists and is just drifted/stale — use harness_docs:regenerate (generated) or edit + harness_docs:anchor (manual) instead of retiring a live doc's record.",
    chaining: 'harness_docs:list (spot bodyMissing/review debris) → confirm the file is gone → harness_docs:retire { docId } (or items:[…]).',
    seeAlso: [
      'harness_docs:list (see current status/freshness per doc)',
      'harness_docs:anchor (track a human-authored doc — the opposite of retiring)',
    ],
  },
  capability: 'docs:write',
  requirePrincipal: false,
  agentRoles: ['documenter', 'doc-steward', 'operator', 'worker', 'architect', 'cup'],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const list = args.items?.length
      ? args.items
      : [{ docId: args.docId as string, harness: undefined as string | undefined }];
    const { gate, scopes } = resolveBulkHarnessScopes(list, args.harness, ctx as { harnessSlug?: string });
    if (gate) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'harness_required' }) }], isError: true };
    }
    const env = await runBulk(
      list,
      async (it, i) => {
        const scope = scopes[i];
        if (scope.kind !== 'harness') {
          return { ok: false as const, docId: it.docId, error: 'harness_required' };
        }
        return retireOne(scope.slug, it.docId);
      },
      { keyOf: (it) => ({ docId: it.docId.trim().replace(/^\.?\//, '') }) },
    );
    return bulkContent(env);
  },
});
