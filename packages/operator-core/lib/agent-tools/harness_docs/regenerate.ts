/**
 * harness_docs:regenerate — request a documenter regeneration of a stale generated
 * doc (P-007 action / D-004). Enqueues the regeneration (the documenter refreshes
 * the body + re-records provenance); the badge stays stale until that lands.
 *
 * Bulk by default (the house keyed-array contract,
 * bulk-endpoint-standardization-2026-06-21): regenerate ONE doc inline
 * ({ docId }), MANY in the same harness ({ docIds:[…] }), or MANY heterogeneous
 * (items:[{ docId, harness? }]) → { ok, results:[{ ok, docId, enqueued? |
 * error }], counts }. Each result self-describes its docId; one failed item never
 * fails the rest. Harness is a batch default with a per-item override.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { harnessArg, resolveBulkHarnessScopes } from '../_harness-scope';
import { requestRegeneration } from '../../harness/docs/regenerate';
import { runBulk, bulkContent } from '../_bulk';

const itemSpec = z.object({
  docId: z.string().min(1).describe("The generated doc's path relative to the docs root."),
  harness: z.string().min(1).max(80).optional().describe('per-item harness (else the batch `harness` default)'),
});

const argsSchema = z
  .object({
    harness: harnessArg,
    docId: z.string().min(1).optional().describe("single-regenerate shorthand: the generated doc's path relative to the docs root."),
    docIds: z.array(z.string().min(1)).min(1).max(200).optional().describe('regenerate MANY docs in the same harness (homogeneous)'),
    items: z.array(itemSpec).min(1).max(200).optional().describe('regenerate many docs at once — each { docId, harness? }'),
  })
  .refine((a) => (a.items?.length ?? 0) > 0 || (a.docIds?.length ?? 0) > 0 || Boolean(a.docId), {
    message: 'pass { docId } for one, { docIds:[…] } for many in one harness, or items:[{ docId, harness? }] for many',
  });

export default defineTool({
  name: 'harness_docs:regenerate',
  description:
    "Request a documenter regeneration of one OR many stale generated/augmented docs (preserving any human overlay). Single: { docId }. Many same harness: { docIds:[…] }. Many heterogeneous: items:[{ docId, harness? }]. Each enqueues; the doc refreshes when the documenter re-records it. Returns { ok, results:[{ ok, docId, enqueued? | error }], counts } — correlate by docId not position; one failure never fails the rest.",
  guidance: {
    when: 'A generated doc is stale (its subject code changed) and you want it refreshed. Regenerate several at once via docIds:[…] or items:[…].',
    notWhen: 'For a manual doc use harness_docs:verify. To preserve human nuance across the regen, add it via harness_docs:set_overlay first.',
    chaining: 'harness_docs:list (find stale generated) → harness_docs:regenerate { docIds:[…] }.',
    seeAlso: [
      'harness_docs:verify (a MANUAL doc — regenerate is for generated ones)',
      'harness_docs:set_overlay (preserve human nuance across the regen first)',
      'harness_docs:list (find stale generated docs)',
    ],
  },
  capability: 'docs:write',
  requirePrincipal: false,
  agentRoles: ['documenter', 'doc-steward', 'operator', 'reviewer', 'cup'],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const list = args.items?.length
      ? args.items
      : args.docIds?.length
        ? args.docIds.map((docId) => ({ docId, harness: undefined as string | undefined }))
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
        const res = await requestRegeneration(scope.slug, it.docId);
        return res.ok
          ? { ok: true as const, docId: res.docId, enqueued: res.enqueued }
          : { ok: false as const, docId: it.docId, error: res.error };
      },
      { keyOf: (it) => ({ docId: it.docId }) },
    );
    return bulkContent(env);
  },
});
