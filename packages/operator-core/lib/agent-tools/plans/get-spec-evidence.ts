/** plans:get-spec-evidence — exact proof bindings with explicit currentness. */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { resolveEffectiveHarnessSlug } from './_ctx-opts';
import { listSpecEvidence, SPEC_EVIDENCE_KINDS, evidenceCurrentInputSchema } from './spec-evidence-store';
import { fullBodyRef, isFullDetail, reviewReadDetailArg } from '../_review-read-detail';

type EvidenceRow = Awaited<ReturnType<typeof listSpecEvidence>>[number];

/**
 * P-007 (RSR-P-007-A): the default per-binding currentness table. Identity plus the
 * overall verdict and its reasons — what an auditor scans; fingerprints, per-dimension
 * detail, binding details and the server-measurement body stay in detail:'full'.
 */
function summaryEvidenceRow(row: EvidenceRow) {
  return {
    id: row.id,
    workItemId: row.workItemId,
    specId: row.specId,
    specRevision: row.specRevision,
    evidenceKind: row.evidenceKind,
    evidenceRef: row.evidenceRef,
    testRunId: row.testRunId ?? null,
    currentness: {
      overall: row.currentness.overall,
      staleReasons: row.currentness.staleReasons,
      unknownReasons: row.currentness.unknownReasons,
    },
  };
}

/** One row per clause revision: how many bindings, and how many are current/stale/unknown. */
function byClause(evidence: EvidenceRow[]) {
  const clauses = new Map<string, { specId: string; specRevision: number; bindings: number; current: number; stale: number; unknown: number }>();
  for (const row of evidence) {
    const key = `${row.specId}@${row.specRevision}`;
    const entry = clauses.get(key) ?? { specId: row.specId, specRevision: row.specRevision, bindings: 0, current: 0, stale: 0, unknown: 0 };
    entry.bindings += 1;
    entry[row.currentness.overall] += 1;
    clauses.set(key, entry);
  }
  return [...clauses.values()];
}

const argsSchema = z.object({
  harness: harnessArg,
  slug: z.string().min(1),
  workItemIds: z.array(z.string().min(1)).min(1).max(500).optional(),
  specIds: z.array(z.string().min(1)).min(1).max(500).optional(),
  sourceValIds: z
    .array(z.string().regex(/^VAL-[A-Za-z0-9._-]+$/))
    .min(1)
    .max(500)
    .optional(),
  evidenceKinds: z.array(z.enum(SPEC_EVIDENCE_KINDS)).min(1).max(SPEC_EVIDENCE_KINDS.length).optional(),
  evidenceRefs: z.array(z.string().trim().min(1).max(2000)).min(1).max(500).optional(),
  current: z
    .array(evidenceCurrentInputSchema)
    .max(500)
    .optional()
    .describe(
      'Current fingerprints keyed by planSlug/specId/specRevision/specFingerprint/evidenceKind/evidenceRef when clause identity is supplied; legacy evidenceKind+evidenceRef tuples remain a fallback. Missing applicable values return unknown, never current.',
    ),
  currentness: z
    .array(z.enum(['current', 'stale', 'unknown']))
    .min(1)
    .max(3)
    .optional(),
  limit: z.number().int().min(1).max(1000).optional().describe('Maximum evidence rows returned; bounded.truncatedByLimit reports whether additional rows exist.'),
  detail: reviewReadDetailArg,
});

export default defineTool({
  name: 'plans:get-spec-evidence',
  description:
    'Read exact work-item/spec-revision evidence and compute per-dimension current|stale|unknown|not-applicable status. Spec currentness comes from the canonical revision pointer; source/test/fixture/rubric/environment values compare with explicit current fingerprints, and missing inputs remain unknown. The aggregate bounded field reports whether the requested row limit omitted evidence. Default detail:"summary" returns a per-binding currentness table, a byClause rollup and a fullBody ref; detail:"full" adds fingerprints, per-dimension status and binding details.',
  guidance: {
    when: 'Auditing whether each current plan spec has fresh evidence, including legacy VAL aliases and historical bindings.',
    notWhen: 'Writing evidence — plans:bind-spec-evidence. Reading behavior without proof — plans:get-specs.',
    chaining: 'plans:bind-spec-evidence → plans:get-spec-evidence { current:[…] } → completion/acceptance gate.',
    seeAlso: ['plans:bind-spec-evidence (append proof)', 'plans:get-specs (canonical behavior)'],
  },
  capability: 'plans:read',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  // EI-21841626363210048: the judge role's grading-integrity audit is mandated to
  // "execute each evidence probe exactly as written" for a spec-test-adequacy card —
  // this read-only tool IS that probe (named by spec-test-adequacy's own method text
  // and by its `freshness` method). Without it the auditor was structurally blocked
  // from the one re-run its own rubric prescribes and had to substitute weaker
  // corroboration with no signal in the emitted card.
  agentRoles: [...SU_ROLES, 'kettle', 'worker', 'cup', 'judge'],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const sctx = harnessScopedCtx(args.harness, ctx);
    const harnessSlug = resolveEffectiveHarnessSlug(sctx);
    const { detail, ...listArgs } = args;
    const limit = args.limit ?? 200;
    const evidenceWithLookahead = await listSpecEvidence({
      ...listArgs,
      limit: limit + 1,
      planSlugs: [args.slug],
      harnessSlug,
    });
    const truncatedByLimit = evidenceWithLookahead.length > limit;
    const evidence = truncatedByLimit ? evidenceWithLookahead.slice(0, limit) : evidenceWithLookahead;
    const counts = { current: 0, stale: 0, unknown: 0 };
    for (const row of evidence) counts[row.currentness.overall] += 1;
    return {
      data: {
        ok: true,
        slug: args.slug,
        harnessSlug,
        bounded: { limit, truncatedByLimit },
        ...(isFullDetail(detail)
          ? { detail: 'full' as const, evidence }
          : {
              detail: 'summary' as const,
              evidence: evidence.map(summaryEvidenceRow),
              byClause: byClause(evidence),
              fullBody: fullBodyRef('plans:get-spec-evidence', args, [
                'evidence[].fingerprints',
                'evidence[].currentness.dimensions',
                'evidence[].details',
                'evidence[].serverMeasurement',
              ]),
            }),
        count: evidence.length,
        currentness: counts,
      },
    };
  },
});
