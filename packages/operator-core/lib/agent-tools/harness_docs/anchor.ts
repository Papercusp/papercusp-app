/**
 * harness_docs:anchor — declare/refresh a MANUAL doc's drift anchor (P-006). The
 * doc says what code it documents (subject_ref) via the `documents` arg, its
 * `documents:` frontmatter, or inference from the paths it references. Optionally
 * verify it against HEAD now. An unanchored manual doc stays allowed but visibly
 * "not drift-tracked".
 *
 * Bulk by default (the house keyed-array contract,
 * bulk-endpoint-standardization-2026-06-21): anchor ONE doc inline
 * ({ docId, documents?, verify?, title? }), or MANY heterogeneous
 * (items:[{ docId, documents?, verify?, title?, harness? }]) → { ok, results:[{ ok,
 * docId, source?, status?, anchored?, subjectRef? | error }], counts }. Each result
 * self-describes its docId; one failed item never fails the rest. Harness is a
 * batch default with a per-item override.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { harnessArg, resolveBulkHarnessScopes } from '../_harness-scope';
import { anchorManualDoc } from '../../harness/docs/manual-anchor';
import { runBulk, bulkContent } from '../_bulk';

const documentsArg = z
  .union([z.string(), z.array(z.string())])
  .describe('What this doc documents: feature ids (F-3), file globs (src/**), or symbols (src/a.ts :: fn). Omit to read the doc\'s `documents:` frontmatter / infer from the paths it references.');

const itemSpec = z.object({
  docId: z.string().min(1).describe("The manual doc's path relative to the docs root, e.g. 'guides/setup.md'."),
  documents: documentsArg.optional(),
  verify: z.boolean().optional().describe('Also stamp the verify baseline to the current HEAD (you confirm the doc is current now).'),
  title: z.string().optional(),
  harness: z.string().min(1).max(80).optional().describe('per-item harness (else the batch `harness` default)'),
});

const argsSchema = z
  .object({
    harness: harnessArg,
    docId: z.string().min(1).optional().describe("single-anchor shorthand: the manual doc's path relative to the docs root, e.g. 'guides/setup.md'."),
    documents: documentsArg.optional(),
    verify: z.boolean().optional().describe('Also stamp the verify baseline to the current HEAD (applies to the inline doc).'),
    title: z.string().optional(),
    items: z.array(itemSpec).min(1).max(200).optional().describe('anchor many docs at once — each { docId, documents?, verify?, title?, harness? }'),
  })
  .refine((a) => (a.items?.length ?? 0) > 0 || Boolean(a.docId), {
    message: 'pass { docId, documents? } for one, or items:[{ docId, documents? }] for many',
  });

export default defineTool({
  name: 'harness_docs:anchor',
  description:
    'Anchor one OR many manual docs to the code they document (their subject_ref) so drift is tracked; optionally verify against HEAD. Single: { docId, documents? }. Many: items:[{ docId, documents?, verify?, title?, harness? }]. Returns { ok, results:[{ ok, docId, source?, status?, anchored?, subjectRef? | error }], counts } — correlate by docId not position; one failure never fails the rest. Unanchored manual docs remain allowed but flagged "not drift-tracked".',
  guidance: {
    when: 'A human-authored doc should be drift-tracked: declare what code it covers. Run after writing/editing the doc, or to fix a wrong anchor. Anchor several at once via items:[…].',
    notWhen: 'For a generated doc use harness_docs:record (it sets a generated baseline). To only re-confirm currency use harness_docs:verify.',
    chaining: 'harness_docs:anchor { documents } → (later, on a drift nudge) harness_docs:verify.',
    seeAlso: [
      'harness_docs:record (set a GENERATED baseline instead of anchoring a human doc)',
      'harness_docs:verify (re-confirm currency later)',
      'harness_docs:list (see what is anchored + its freshness)',
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
      : [{ docId: args.docId as string, documents: args.documents, verify: args.verify, title: args.title, harness: undefined as string | undefined }];
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
        const res = await anchorManualDoc({
          harnessSlug: scope.slug,
          docId: it.docId,
          ...(it.documents !== undefined ? { documents: it.documents } : {}),
          ...(it.verify !== undefined ? { verify: it.verify } : {}),
          ...(it.title ? { title: it.title } : {}),
        });
        // EI-4889: a doc that resolved 0 subject refs comes back anchored:false /
        // status:'untracked' — but ok:true reads as success, so an agent following
        // the "omit documents → read frontmatter" guidance silently believes its doc
        // is drift-tracked when it is NOT. Surface the no-op as a `warning` so the
        // signal is loud. (The other half — wrong-dir reads — is prevented by writing
        // through docs:author, which writes to the same root anchor reads from.)
        const warning =
          res.ok && !res.anchored
            ? it.documents === undefined
              ? "anchored:false — no `documents` resolved from the doc's `documents:` frontmatter or path inference. Is the doc written to THIS harness's docs root, and does it have a `documents:` block? Pass `documents` explicitly. The doc is NOT drift-tracked."
              : 'anchored:false — the provided `documents` resolved to 0 subject refs (check the paths/feature-ids actually exist in the repo). The doc is NOT drift-tracked.'
            : undefined;
        return res.ok
          ? {
              ok: true as const,
              docId: res.record.docId,
              source: res.record.source,
              status: res.record.status,
              anchored: res.anchored,
              subjectRef: res.subjectRef,
              ...(warning ? { warning } : {}),
            }
          : { ok: false as const, docId: it.docId, error: res.error };
      },
      { keyOf: (it) => ({ docId: it.docId }) },
    );
    return bulkContent(env);
  },
});
