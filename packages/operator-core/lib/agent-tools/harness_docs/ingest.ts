/**
 * harness_docs:ingest — backfill a harness's existing FS docs into the typed model
 * (P-010). Anchors docs that declare a `documents:` frontmatter (or reference repo
 * paths we can infer) as source=manual records, baselined to HEAD; record-less docs
 * keep showing as "not drift-tracked". Idempotent.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveHarnessScope, harnessArg } from '../_harness-scope';
import { ingestHarnessDocs } from '../../harness/docs/migrate-fs-docs';

const argsSchema = z.object({
  harness: harnessArg,
  verifyAtHead: z.boolean().optional().describe('Baseline ingested docs to the current HEAD so drift-tracking starts now (default true). Set false to leave anchored docs needing first verification.'),
});

export default defineTool({
  name: 'harness_docs:ingest',
  description: "Backfill a harness's existing FS docs into the typed drift-tracked model: anchor docs that declare/imply a subject as manual records (baselined to HEAD). One-time per harness; idempotent.",
  guidance: {
    when: 'After this harness has existing docs/*.md that predate the typed model, to make the ones with a declared/inferable subject drift-tracked.',
    notWhen: 'Record-less docs already show as "not drift-tracked" via the merged read — ingest is only needed to anchor docs that declare a subject. No need to run repeatedly.',
    chaining: 'harness_docs:ingest → harness_docs:list (review which anchored) → harness_docs:anchor (fix any wrong/missing anchors).',
    seeAlso: [
      'harness_docs:list (review which docs got anchored)',
      'harness_docs:anchor (fix a wrong/missing anchor)',
    ],
  },
  capability: 'docs:write',
  requirePrincipal: false,
  agentRoles: ['operator', 'documenter', 'doc-steward', 'cup'],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const scope = resolveHarnessScope(args.harness, ctx as { harnessSlug?: string });
    if (scope.kind !== 'harness') {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'harness_required' }) }], isError: true };
    }
    const res = await ingestHarnessDocs(scope.slug, args.verifyAtHead !== undefined ? { verifyAtHead: args.verifyAtHead } : {});
    if (res.ok) {
      // P-009: freshly ingested docs → queue the harness surface into the
      // doc-section embedding store (coalesced, fire-and-forget, VITEST-inert).
      try {
        const { queueHarnessDocSectionSync } = await import('../../search/doc-embed-sync');
        queueHarnessDocSectionSync(scope.slug);
      } catch {
        // fail-open
      }
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(res) }], ...(res.ok ? {} : { isError: true }) };
  },
});
