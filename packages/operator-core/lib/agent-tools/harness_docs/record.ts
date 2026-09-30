/**
 * harness_docs:record — the documenter stamps a generated doc's provenance
 * (P-004 / D-001). After writing docs/features/F-<id>.md the documenter calls this
 * with the feature + files/symbols it read; the server resolves the harness repo's
 * HEAD as generated_from_sha, resolves the anchor paths, and upserts the typed doc
 * record. Provenance is a byproduct of generation, not reverse-engineered.
 *
 * Idempotent + overlay-safe: re-recording (a regeneration) advances the baseline
 * and preserves any human augmented overlay (D-003/P-005).
 *
 * Bulk by default (the house keyed-array contract,
 * bulk-endpoint-standardization-2026-06-21): record ONE doc inline
 * ({ docId, documents?, title? }), or MANY heterogeneous
 * (items:[{ docId, documents?, title?, harness? }]) → { ok, results:[{ ok, docId,
 * source?, status?, generatedFromSha?, subjectRef?, anchorPaths? | error }],
 * counts }. Each result self-describes its docId; one failed item never fails the
 * rest. Harness is a batch default with a per-item override.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { harnessArg, resolveBulkHarnessScopes } from '../_harness-scope';
import { recordGeneratedDoc } from '../../harness/docs/provenance';
import { runBulk, bulkContent } from '../_bulk';

const documentsArg = z
  .union([z.string(), z.array(z.string())])
  .describe(
    'What this doc documents (its drift anchor). A list (or comma-form string) of: feature ids (F-3 / WI-12), file globs (src/foo.ts, packages/x/**), or symbols (src/foo.ts :: myFn). Capture exactly the files/symbols you read to write the doc. Omit only for a features/F-NNN.md doc (the feature is inferred from the filename).',
  );

const itemSpec = z.object({
  docId: z
    .string()
    .min(1)
    .describe(
      "The generated doc's path RELATIVE TO THE DOCS ROOT, e.g. 'features/F-3.md' — the same path it appears under in the docs tab.",
    ),
  documents: documentsArg.optional(),
  title: z.string().optional().describe('Optional human title for list rendering.'),
  harness: z.string().min(1).max(80).optional().describe('per-item harness (else the batch `harness` default)'),
});

const argsSchema = z
  .object({
    harness: harnessArg,
    docId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "single-record shorthand: the generated doc's path RELATIVE TO THE DOCS ROOT, e.g. 'features/F-3.md'.",
      ),
    documents: documentsArg.optional(),
    title: z.string().optional().describe('Optional human title for list rendering.'),
    items: z.array(itemSpec).min(1).max(200).optional().describe('record many docs at once — each { docId, documents?, title?, harness? }'),
  })
  .refine((a) => (a.items?.length ?? 0) > 0 || Boolean(a.docId), {
    message: 'pass { docId, documents? } for one, or items:[{ docId, documents? }] for many',
  });

export default defineTool({
  name: 'harness_docs:record',
  description:
    "Record one OR many generated docs' provenance + drift anchor (subject_ref) and stamp each generated-from the harness repo's current HEAD. Single: { docId, documents? }. Many: items:[{ docId, documents?, title?, harness? }]. Call immediately after writing the file(s), passing what you read. Returns { ok, results:[{ ok, docId, source?, status?, generatedFromSha?, subjectRef?, anchorPaths? | error }], counts } — correlate by docId not position; one failure never fails the rest.",
  guidance: {
    when: 'You (the documenter) just wrote or refreshed generated doc file(s) (docs/features/F-<id>.md, a guide). Call once per doc with the feature + the exact files/symbols you read; record several at once via items:[…].',
    notWhen:
      'For a human-authored manual doc, use harness_docs:anchor instead (it sets a verify baseline, not a generated baseline). Do not call for docs you only read.',
    chaining: 'Write the .md file(s) → harness_docs:record { docId, documents } (or items:[…]). The freshness sweep then tracks them against future commits.',
    seeAlso: [
      'harness_docs:anchor (drift-track a HUMAN-authored doc — a verify baseline, not generated)',
      'harness_docs:list (review provenance + freshness)',
    ],
  },
  capability: 'docs:write',
  requirePrincipal: false,
  agentRoles: ['documenter', 'operator', 'doc-steward', 'cup'],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const list = args.items?.length
      ? args.items
      : [{ docId: args.docId as string, documents: args.documents, title: args.title, harness: undefined as string | undefined }];
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
        const result = await recordGeneratedDoc({
          harnessSlug: scope.slug,
          docId: it.docId,
          documents: it.documents,
          ...(it.title ? { title: it.title } : {}),
        });
        return result.ok
          ? {
              ok: true as const,
              docId: result.record.docId,
              source: result.record.source,
              status: result.record.status,
              generatedFromSha: result.generatedFromSha,
              subjectRef: result.subjectRef,
              anchorPaths: result.anchorPaths,
            }
          : { ok: false as const, docId: it.docId, error: result.error };
      },
      { keyOf: (it) => ({ docId: it.docId }) },
    );
    return bulkContent(env);
  },
});
