/**
 * harness_docs:set_overlay — attach/replace/clear the human AUGMENTED overlay on a
 * doc (P-005 / D-003). The overlay (intent, caveats, the "why") rides on top of a
 * generated body and SURVIVES regeneration. Setting an overlay makes the doc
 * `augmented`; clearing it reverts to generated/manual.
 *
 * Bulk by default (the house keyed-array contract,
 * bulk-endpoint-standardization-2026-06-21): set ONE overlay inline
 * ({ docId, overlay }), or MANY heterogeneous
 * (items:[{ docId, overlay, harness? }]) → { ok, results:[{ ok, docId, source?,
 * hasOverlay? | error }], counts }. Each result self-describes its docId; one
 * failed item never fails the rest. Harness is a batch default with a per-item
 * override.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { harnessArg, resolveBulkHarnessScopes } from '../_harness-scope';
import { getDocRecord, setDocOverlay, upsertDocRecord } from '../../harness/docs/doc-record';
import { runBulk, bulkContent } from '../_bulk';

const itemSpec = z.object({
  docId: z.string().min(1).describe("The doc's path relative to the docs root."),
  overlay: z.string().describe('The human overlay markdown (intent / caveats / the "why"). Pass an empty string to CLEAR the overlay.'),
  harness: z.string().min(1).max(80).optional().describe('per-item harness (else the batch `harness` default)'),
});

const argsSchema = z
  .object({
    harness: harnessArg,
    docId: z.string().min(1).optional().describe("single-overlay shorthand: the doc's path relative to the docs root."),
    overlay: z.string().optional().describe('The human overlay markdown (intent / caveats / the "why"). Pass an empty string to CLEAR the overlay.'),
    items: z.array(itemSpec).min(1).max(200).optional().describe('set many overlays at once — each { docId, overlay, harness? }'),
  })
  .refine((a) => (a.items?.length ?? 0) > 0 || (Boolean(a.docId) && a.overlay !== undefined), {
    message: 'pass { docId, overlay } for one, or items:[{ docId, overlay }] for many',
  });

/** Set/clear one doc's overlay (preserved verbatim from the pre-bulk single tool). */
async function setOverlayOne(harnessSlug: string, rawDocId: string, rawOverlay: string) {
  const docId = rawDocId.trim().replace(/^\.?\//, '');
  const overlay = rawOverlay.trim() === '' ? null : rawOverlay;
  const existing = await getDocRecord(harnessSlug, docId);
  // Clearing an overlay that was never set is a no-op: don't materialize a
  // spurious manual/untracked tracking record just to "clear" a nonexistent
  // overlay (that would convert an untracked-FS doc into a tracked record with
  // no overlay, no subject, no purpose). Only when ADDING an overlay do we
  // ensure a record exists (overlaying a doc that was never recorded — e.g. an
  // unanchored manual file — creates a minimal manual record first).
  if (!existing) {
    if (overlay === null) {
      return { ok: true as const, docId, source: undefined, hasOverlay: false };
    }
    await upsertDocRecord({ harnessSlug, docId, source: 'manual', subjectRef: [], anchorPaths: [], status: 'untracked' });
  }
  await setDocOverlay(harnessSlug, docId, overlay);
  const updated = await getDocRecord(harnessSlug, docId);
  return { ok: true as const, docId, source: updated?.source, hasOverlay: !!(updated?.overlay && updated.overlay.trim()) };
}

export default defineTool({
  name: 'harness_docs:set_overlay',
  description:
    'Attach a human "augmented" overlay to one OR many docs — nuance that rides on top of the generated body and survives regeneration; empty string clears it. Single: { docId, overlay }. Many: items:[{ docId, overlay, harness? }]. Returns { ok, results:[{ ok, docId, source?, hasOverlay? | error }], counts } — correlate by docId not position; one failure never fails the rest.',
  guidance: {
    when: 'A generated doc is accurate but missing the human "why"/caveats you want preserved across regenerations. Add it as an overlay rather than hand-editing the generated body (which a regen would lose). Set several at once via items:[…].',
    notWhen: 'To change the generated body itself, fix the code/feature and regenerate. For a fully human doc, author it as a manual doc.',
    chaining: 'harness_docs:list → harness_docs:set_overlay { overlay } (or items:[…]).',
    seeAlso: [
      'harness_docs:regenerate (change the generated body via the code, not an overlay)',
      'harness_docs:list (see which docs carry overlays)',
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
      : [{ docId: args.docId as string, overlay: args.overlay as string, harness: undefined as string | undefined }];
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
        return setOverlayOne(scope.slug, it.docId, it.overlay);
      },
      { keyOf: (it) => ({ docId: it.docId.trim().replace(/^\.?\//, '') }) },
    );
    return bulkContent(env);
  },
});
