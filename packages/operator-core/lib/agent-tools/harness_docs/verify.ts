/**
 * harness_docs:verify — confirm a manual doc is current as of HEAD (P-006 / D-004
 * re-verify action). Sets last_verified_sha = HEAD → fresh, clearing the re-verify
 * flag. The human/agent is asserting the doc matches the code right now.
 *
 * Bulk by default (the house keyed-array contract,
 * bulk-endpoint-standardization-2026-06-21): verify ONE doc inline ({ docId }),
 * MANY in the same harness ({ docIds:[…] }), or MANY heterogeneous
 * (items:[{ docId, harness? }]) → { ok, results:[{ ok, docId, verifiedSha? |
 * error }], counts }. Each result self-describes its docId; one failed item never
 * fails the rest. Harness is a batch default with a per-item override.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { harnessArg, resolveBulkHarnessScopes } from '../_harness-scope';
import { verifyManualDoc } from '../../harness/docs/manual-anchor';
import { runBulk, bulkContent } from '../_bulk';

const itemSpec = z.object({
  docId: z.string().min(1).describe("The doc's path relative to the docs root."),
  harness: z.string().min(1).max(80).optional().describe('per-item harness (else the batch `harness` default)'),
});

const argsSchema = z
  .object({
    harness: harnessArg,
    docId: z.string().min(1).optional().describe("single-verify shorthand: the doc's path relative to the docs root."),
    docIds: z.array(z.string().min(1)).min(1).max(200).optional().describe('verify MANY docs in the same harness (homogeneous)'),
    items: z.array(itemSpec).min(1).max(200).optional().describe('verify many docs at once — each { docId, harness? }'),
  })
  .refine((a) => (a.items?.length ?? 0) > 0 || (a.docIds?.length ?? 0) > 0 || Boolean(a.docId), {
    message: 'pass { docId } for one, { docIds:[…] } for many in one harness, or items:[{ docId, harness? }] for many',
  });

export default defineTool({
  name: 'harness_docs:verify',
  description:
    "Re-verify one OR many manual docs: stamp the drift baseline to the current HEAD and mark fresh. Single: { docId }. Many same harness: { docIds:[…] }. Many heterogeneous: items:[{ docId, harness? }]. Returns { ok, results:[{ ok, docId, verifiedSha? | error }], counts } — correlate by docId not position; one failure never fails the rest. Use after reviewing a doc the freshness sweep flagged for re-verify.",
  guidance: {
    when: 'A manual doc was flagged for re-verify (its subject code changed) and you confirmed it\'s still accurate — or you just edited it to match. Verify several at once via docIds:[…] or items:[…].',
    notWhen: 'For a generated doc use harness_docs:regenerate. To set the anchor in the first place use harness_docs:anchor.',
    chaining: 'harness_docs:list (find review docs) → read → harness_docs:verify { docIds:[…] }.',
    seeAlso: [
      'harness_docs:regenerate (a GENERATED doc — verify is for manual ones)',
      'harness_docs:anchor (set the anchor in the first place)',
      'harness_docs:list (find docs flagged for review)',
    ],
  },
  capability: 'docs:write',
  requirePrincipal: false,
  agentRoles: ['documenter', 'doc-steward', 'operator', 'worker', 'architect', 'reviewer', 'cup'],
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
        const res = await verifyManualDoc(scope.slug, it.docId);
        return res.ok
          ? { ok: true as const, docId: it.docId, verifiedSha: res.verifiedSha }
          : { ok: false as const, docId: it.docId, error: res.error };
      },
      { keyOf: (it) => ({ docId: it.docId }) },
    );
    return bulkContent(env);
  },
});
