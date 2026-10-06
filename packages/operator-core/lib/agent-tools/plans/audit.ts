/**
 * plans:audit — record either a completion/code-truth audit or the
 * conversation-completeness audit required before activation.
 *
 * The implementer traces every plan item to the code that implements it and CITES it,
 * before authoring the acceptance rubric (plan D-004). Citations of kind `code`/`test`
 * are resolved against the real tree HERE, at write time, so a fabricated path fails
 * immediately rather than at ship time — and a stored audit is therefore always
 * self-consistent. The completion gate re-resolves them again later, because the tree
 * moves between audit and ship.
 *
 * WHY VALIDATION IS COLLECTED, NOT SHORT-CIRCUITED: an audit of a 20-item plan is one
 * expensive pass of agent attention. Failing on the first bad citation would send the
 * agent round the loop once per problem. Every problem is collected and returned
 * together, so one fix-up pass clears them all.
 *
 * NOT BULK: the house contract is bulk-by-default, but an audit is inherently one
 * plan's worth of work and its payload is large. Auditing two plans in one call has no
 * real caller, so the single-plan shape is the honest one.
 */
import { z } from 'zod';
import { refineEvenWithShapeIssues } from '../_refine-with-shape-issues';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { execFileSync } from 'node:child_process';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx, resolveHarnessScope } from '../_harness-scope';
import { resolveAgentIdentity } from '../coordination/identity';
import { emitPlanEventForCaller } from '../coordination/plan-events';
import {
  AUDIT_VERDICTS,
  ACTIVATION_REAUDIT_COSMETIC_CHANGES,
  ACTIVATION_REAUDIT_MATERIAL_CHANGES,
  CITATION_KINDS,
  citationBlobSha,
  citationBlobShaAt,
  getEffectiveItemAudits,
  getLatestActivationAudit,
  getPlanItemStatuses,
  isVerifyingCitation,
  isCitationContextFailure,
  mergeActivationAuditCoverage,
  prepareAuditPassEntries,
  recordCurrentActivationAudit,
  recordPlanAudit,
  repoCitationContextForHarness,
  resolveCitation,
  resolvePlanItemHomeHarness,
  summarizeCoverage,
  validateActivationAuditPlanTargets,
  type AuditCitation,
  type AuditItemEntry,
  type ActivationAuditPayload,
} from '../../plan-audits';
import { activeWorkspaceId } from '../../workspace-registry';
import {
  parseSessionSelector,
  parseTurnRef,
  resolveSessionTurnRefs,
  SESSION_SOURCE_KINDS,
} from '../sessions/_shared';
import { ensureActivationAuditRepairFiling } from './activation-audit-repair';
import {
  currentPlanItemIds,
  dbRefOriginLookup,
  evaluateActivationItemProvenance,
  itemProvenanceMissingProblems,
} from '../../activation-item-provenance';
import { persistDerivedDraftClauses } from '../../derive-draft-spec-clauses';
import { detectUnderReadFromSource } from '../../activation-under-read';
import { restrictedTurnSql } from '../../personal-vault/transcript-exclusion';
import { assertSourceSpan } from '../../activation-source-span';
import { setSpecClause } from './spec-clauses-store';
import { getPlanRow } from './source';
import {
  MAX_BAR_PROJECTION_EDGES,
  acceptanceBarProjectionConflictDetail,
  unexpectedAcceptanceBarProjectionIds,
  validateAcceptanceBarSource,
  acceptanceBarSourceContractProblems,
} from '../../acceptance-bar-seed';
import { parsePlan } from './parser';
import { stagingFirstActivationProblems } from './staging-first-activation-guard';
import { PLAN_CLASS_RUBRIC_REFS } from './spec-test-adequacy';
import { previewPlanStartConsult } from './get-activation-readiness';
import {
  recoverHarnessFromSlugs,
  requireUnambiguousSlugScope,
  slugScopeErrorResult,
} from './slug-scope';

const citationPathSchema = z.string().min(1).describe(
  'Repo-relative path. No leading `/` or `~`, no `..` segments — a citation that needs one is not evidence.',
);
const citationOptionalFields = {
  line: z.number().int().positive().optional().describe('Optional line number; must exist in the cited file.'),
  symbol: z.string().min(1).optional().describe('Optional symbol that must literally appear in the cited file.'),
  ref: z.string().min(1).optional().describe('PG-canonical doc id for a `doc` citation; requires `reason`.'),
  reason: z.string().min(1).optional().describe('REQUIRED for kind `none`, and for a `doc` cited by `ref` alone: why this item has no code-resolvable artifact.'),
};
const citationSchema = z.union([
  z.object({
    kind: z.literal('code'),
    path: citationPathSchema,
    ...citationOptionalFields,
  }),
  z.object({
    kind: z.literal('test'),
    path: citationPathSchema,
    ...citationOptionalFields,
  }),
  z.object({
    kind: z.literal('doc').describe(
      '`doc` records where a non-source deliverable lives: give `path` if it is a tree file (resolved like any other path) or `ref` + `reason` if it is a PG-canonical doc — either way it never supports `implemented`.',
    ),
    path: citationPathSchema.optional(),
    ...citationOptionalFields,
  }),
  z.object({
    kind: z.literal('none').describe(
      '`none` is the escape hatch and REQUIRES `reason`. The unverified counts come back in the result and go in front of the independent grader, because a self-audit cannot police its own use of them.',
    ),
    path: citationPathSchema.optional(),
    ...citationOptionalFields,
  }),
]);

const itemSchema = z.object({
  itemId: z.string().regex(/^P-\d{3,}$/).describe('The plan item this entry audits.'),
  verdict: z.enum(AUDIT_VERDICTS).describe(
    'implemented (you READ the code that implements it — REQUIRES a resolving `code`/`test` citation; a `doc` citation cannot support this verdict) | not-code (a decision/doc/investigation — REQUIRES `note`, and is counted, because it exempts the item from code verification) | partial | missing | dropped (intentionally departed from — REQUIRES `note`). Per plan D-002 no verdict refuses a ship on its own; they RECORD. The ship-blocking question is the item\'s own status.',
  ),
  citations: z.array(citationSchema).max(20).optional(),
  note: z.string().min(1).max(2000).optional().describe('Free note. REQUIRED when verdict is `dropped` — the intentional-departure reason (D-002): going against the plan is fine, going against it silently is not. Also REQUIRED when verdict is `not-code`: what the deliverable actually is, and why no code implements it.'),
});

const findingSchema = z.object({
  summary: z.string().min(1).max(1000),
  severity: z.string().min(1).max(40).optional(),
  disposition: z.enum(['fixed', 'filed']).describe('`fixed` — you fixed it in this pass. `filed` — it is out of scope and REQUIRES `ref`, the work-item it now lives on.'),
  ref: z.string().min(1).optional(),
});

const sourceRangeSchema = z.object({
  sourceKind: z.enum(SESSION_SOURCE_KINDS),
  sessionId: z.string().min(1).max(300),
  fromTurn: z.number().int().min(0),
  toTurn: z.number().int().min(0),
}).refine((range) => range.fromTurn <= range.toTurn, {
  message: 'fromTurn must be <= toTurn',
  path: ['toTurn'],
});

const activationMappingSchema = z.object({
  id: z.string().regex(/^M-\d{3,}$/),
  sourceRefs: z.array(z.string().min(1).max(500)).min(1).max(100),
  requirement: z.string().min(1).max(4000),
  planTargets: z.array(z.string().min(1).max(500)).min(1).max(100).describe(
    'Plan destinations: use R-N for exact acceptance-bar records in Requirements, P-NNN for plan items, D-NNN for decisions, or section:<heading> for exact plan sections; the section: prefix is required.',
  ),
  disposition: z.enum(['covered', 'repaired', 'rejected', 'open']),
}).superRefine((mapping, ctx) => {
  if (new Set(mapping.sourceRefs).size !== mapping.sourceRefs.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sourceRefs'], message: 'sourceRefs must be unique within a mapping' });
  }
  if (new Set(mapping.planTargets).size !== mapping.planTargets.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['planTargets'], message: 'planTargets must be unique within a mapping' });
  }
});

// plan-item-provenance-2026-09-29 P-002: the REVERSE direction of the audit. Every
// current item must trace to an owner turn; items that do not are declared here.
const itemIdSchema = z.string().regex(/^P-\d{3,}$/);
const itemProvenanceSchema = z.discriminatedUnion('kind', [
  z.object({
    itemId: itemIdSchema,
    kind: z.literal('derived'),
    from: z.array(z.string().min(1).max(500)).min(1).max(50).describe('Owner-backed P-NNN/D-NNN/R-N/section:<heading> targets.'),
    note: z.string().min(1).max(2000).optional(),
  }),
  z.object({
    itemId: itemIdSchema,
    kind: z.literal('agent-added'),
    reason: z.string().min(1).max(2000).describe('Why the agent added it; shown to the owner.'),
  }),
]).meta({
  // The compact discovery projection merges array-item union fields. Preserve
  // this branch contract beside the schema so callers cannot combine fields
  // from the `derived` and `agent-added` variants.
  'x-papercusp-call-constraint':
    'when kind=derived => from required; when kind!=derived => from forbidden; when kind=agent-added => note forbidden; when kind=agent-added => reason required; when kind!=agent-added => reason forbidden',
});

// RSR-P-008-A: the activation rules are reported alongside any shape defect.
const argsSchema = refineEvenWithShapeIssues(z.object({
  slug: z.string().min(1).describe('The plan being audited.'),
  harness: harnessArg,
  phase: z.enum(['completion', 'activation']).default('completion').describe(
    '`completion` (default) audits implemented code. `activation` audits the source conversation before ready/active and records the exact current plan revision.',
  ),
  dryRun: z.boolean().default(false).describe(
    'Validate and preview the audit without recording an audit row, repair filing, derived spec clause, or plan event.',
  ),
  classRef: z.enum(PLAN_CLASS_RUBRIC_REFS).optional().describe(
    'Activation phase only: the exact PlanClassRubricRef used by plans:evaluate-spec-quality. Required; never infer it from plan prose.',
  ),
  items: z.array(itemSchema).min(1).max(200).optional().describe('Completion phase only: one entry per plan item audited.'),
  findings: z.array(findingSchema).max(50).optional().describe('Completion phase only: out-of-scope discoveries.'),
  auditedSha: z.string().min(7).max(64).optional().describe('Completion phase only: commit audited against; resolved from the local tree when omitted.'),
  sourceRanges: z.array(sourceRangeSchema).max(50).optional().describe(
    'Activation phase: bounded source conversations covered by this pass. Required and nonempty for the first audit; omitted or empty on a re-audit carries prior ranges forward.',
  ),
  mappings: z.array(activationMappingSchema).max(300).optional().describe(
    'Activation phase: every requirement/constraint/decision mapped from canonical session_turn refs to current R-N acceptance bars, P-NNN items, D-NNN decisions, or section:<heading> targets. Required and nonempty for the first audit; omitted or empty on a re-audit carries prior mappings forward.',
  ),
  itemProvenance: z.array(itemProvenanceSchema).max(200).optional().describe(
    'Activation: items no owner-turn mapping backs, as `derived` or `agent-added`. Carried across re-audits.',
  ),
  repairedOmissions: z.array(z.string().min(1).max(2000)).max(100).optional(),
  rejectedOrSuperseded: z.array(z.string().min(1).max(2000)).max(100).optional(),
  unresolvedBlockers: z.array(z.string().min(1).max(2000)).max(100).optional().describe(
    'Activation phase: blockers that are still unresolved. Any nonempty array blocks activation and means nothing is recorded; do not use it for a resolved or conditional live-environment limitation. Put resolved limitations in a covered mapping and explain the condition in summary.',
  ),
  summary: z.string().max(4000).optional().describe(
    'Optional audit context. For activation, use this to explain resolved conditional/live-environment limitations after mapping them to the plan; it does not make unresolvedBlockers acceptable.',
  ),
}), (args, ctx) => {
  if (args.phase === 'activation') {
    // Whether coverage is required depends on whether this is the first audit.
    // The prior-audit lookup is async and belongs in the handler, so the input
    // schema must admit omitted/empty arrays for carry-forward re-audits.
    if (args.classRef === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['classRef'],
        message: 'classRef is required for activation and must be the exact prior spec-quality evaluation class',
      });
    }
    if (args.mappings && new Set(args.mappings.map((mapping) => mapping.id)).size !== args.mappings.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mappings'], message: 'mapping ids must be unique within an activation audit' });
    }
    for (const field of ['items', 'findings', 'auditedSha'] as const) {
      if (args[field] !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} is completion-phase only` });
      }
    }
  } else {
    if (!args.items) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['items'], message: 'items is required for phase:completion' });
    }
    for (const field of ['sourceRanges', 'mappings', 'itemProvenance', 'repairedOmissions', 'rejectedOrSuperseded', 'unresolvedBlockers', 'classRef'] as const) {
      if (args[field] !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} is activation-phase only` });
      }
    }
  }
}).meta({
  'x-papercusp-call-constraint':
    'phase=activation => classRef required; items, findings, auditedSha forbidden. phase=completion (including omitted phase) => items required; classRef, sourceRanges, mappings, itemProvenance, repairedOmissions, rejectedOrSuperseded, unresolvedBlockers forbidden.',
});

interface Problem {
  itemId?: string;
  code: string;
  detail: string;
}

/**
 * Fresh items in one pass must agree on the blob provenance for a cited path.
 * Carried-forward items intentionally retain the blob provenance from the pass
 * that inspected them, so they are not comparable with this pass's fresh
 * snapshot and must be excluded from this consistency check.
 */
function divergentCitationBlobShaProblems(entries: AuditItemEntry[]): Problem[] {
  const byPath = new Map<string, Map<string, Set<string>>>();

  for (const entry of entries) {
    if (entry.carriedFrom !== undefined) continue;
    for (const citation of entry.citations) {
      if (!isVerifyingCitation(citation) || !citation.path || !citation.blobSha) continue;
      const path = citation.path.trim();
      if (!path) continue;
      const bySha = byPath.get(path) ?? new Map<string, Set<string>>();
      const itemIds = bySha.get(citation.blobSha) ?? new Set<string>();
      itemIds.add(entry.itemId);
      bySha.set(citation.blobSha, itemIds);
      byPath.set(path, bySha);
    }
  }

  return [...byPath.entries()]
    .filter(([, bySha]) => bySha.size > 1)
    .map(([path, bySha]) => ({
      code: 'citation_blob_sha_conflict',
      detail:
        `citation path '${path}' has divergent blobSha values in this audit pass: ` +
        `${[...bySha.entries()]
          .map(([blobSha, itemIds]) => `${blobSha} (${[...itemIds].join(', ')})`)
          .join('; ')}. Re-audit every listed item against one tree snapshot; nothing was recorded.`,
    }));
}

/** Best-effort local HEAD. An audit whose sha cannot be resolved is still a real
 *  audit, so this never throws — the column is nullable for exactly this case. */
function resolveHeadSha(repoRoot: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim() || null;
  } catch {
    return null;
  }
}

export default defineTool({
  name: 'plans:audit',
  description:
    "Record a plan audit. Activation: any nonempty `unresolvedBlockers` list refuses the audit and records nothing; map resolved conditions in `mappings`/`summary` instead. `completion` re-resolves code/test citations; `activation` resolves mapped `session_turn` refs and previews readiness. BAR seeding requires `## Requirements` entries in `**R-N — Title.** outcome` form or fenced `requirement` JSON plus Design map.",
  guidance: {
    when: "Before ready/active, read the COMPLETE source conversation; map every requirement, boundary, constraint, correction, rejection, decision, dependency, sequence, acceptance condition, open question, and follow-up; repair omissions. Author `## Requirements` with exact `**R-N — Title.** outcome` records (or a fenced `requirement` JSON block), map each R-N in Design's Bar-to-work table (`tree|deployed|live`); ordinary bullet lists do not satisfy the BAR parser. Use `activation`; before shipped use `completion` against ACTUAL CODE.",
    returns:
      "Activation returns { auditSeq, auditedPlanRevision, mappings, sourceRefsResolved, itemProvenance { enforced, counts, unresolved }, barSeed, activationReadiness }. An item no owner-typed turn backs, and not declared in itemProvenance, refuses item_provenance_missing; a bad declaration refuses item_provenance_invalid; both name each item and record nothing. A plan whose earlier audits predate provenance records enforced:false instead, until every item resolves. Pending amendment/repair preserves the audit and requires rubrics:amend. Completion returns auditSeq, counts, coverage, and uncoveredItems; mixed errors return partial/problems/rejectedItemIds; batch-wide errors record nothing.",
    notWhen: "Not mid-implementation; grade rubrics with scorecards:emit, decisions with plans:add-decision, and repair open activation mappings first.",
    chaining:
      `Activation: sessions:search/read → repair omissions → audit → ready. Later edits preserve audit and return audited/current revision id/seq/contentHash. Re-audit after ${ACTIVATION_REAUDIT_MATERIAL_CHANGES.join(', ')}; ${ACTIVATION_REAUDIT_COSMETIC_CHANGES.join(', ')} need no re-audit. Completion: audit → rubric/scorecard → shipped.`,
    seeAlso: [
      'plans:set-status (drop an item you intentionally departed from, with a reason)',
      'plans:set-plan-status (the completion gate that reads this audit)',
    ],
  },
  capability: 'plans:write',
  skipWorkspaceTx: true,
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: argsSchema,
  // Activation and completion are two envelopes from one audited write path.
  // Publish their shared load-bearing fields plus the completion diagnostics;
  // passthrough preserves the phase-specific additions without making prose a
  // second source of response types.
  result: z
    .object({
      ok: z.boolean().optional(),
      phase: z.enum(['activation', 'completion']).optional(),
      dryRun: z.boolean().optional(),
      preview: z.boolean().optional(),
      auditSeq: z.number().int().nonnegative().optional(),
      auditedPlanRevision: z.unknown().optional(),
      mappings: z.unknown().optional(),
      // `returns` promises barSeed on the activation envelope (the active rubric
      // revision, barSetHash, BAR count, projection-edge count). Declare it here so
      // that promise is backed by the registered schema rather than by prose —
      // guidance-output-schema-live-guard fails a promised-but-undeclared field.
      barSeed: z.unknown().optional(),
      barSeedPendingAmendment: z.unknown().optional(),
      barSeedPendingRepair: z.unknown().optional(),
      activationReadiness: z.object({ consult: z.unknown() }).optional(),
      // Activation's owner-provenance check (itemProvenanceResult below); null
      // when no current plan was read. `returns` names this nested shape.
      itemProvenance: z
        .object({ enforced: z.boolean(), counts: z.unknown(), unresolved: z.array(z.string()) })
        .passthrough()
        .nullable()
        .optional(),
      sourceRefsResolved: z.number().int().nonnegative().optional(),
      slug: z.string().optional(),
      itemsAuditedThisPass: z.number().int().nonnegative().optional(),
      itemsCarriedForward: z.number().int().nonnegative().optional(),
      coverage: z.unknown().optional(),
      uncoveredItems: z.array(z.string()).optional(),
      partial: z.boolean().optional(),
      problems: z.array(z.unknown()).optional(),
      rejectedItemIds: z.array(z.string()).optional(),
      error: z.string().optional(),
      message: z.string().optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    // EI-22078133656298536: an audit already names an exact plan slug, so a
    // workspace-scoped operator call can recover its owning harness from the
    // canonical plan index instead of failing with an undiscoverable
    // `harness_required`. This is a write, so an ambiguous slug remains
    // fail-loud rather than choosing the most-recently-updated copy.
    const scope = resolveHarnessScope(args.harness, ctx);
    let sctx: typeof ctx & { harnessSlug: string };
    if (scope.kind === 'none') {
      const recovered = await recoverHarnessFromSlugs(ctx, [args.slug]);
      const decision = requireUnambiguousSlugScope(
        recovered,
        ((ctx as { workspaceId?: string }).workspaceId ?? '').trim(),
      );
      if (decision.status !== 'resolved') return slugScopeErrorResult('plans:audit', decision);
      sctx = { ...ctx, harnessSlug: decision.harnessSlug };
      (ctx as { metadata?: (d: Record<string, unknown>) => void }).metadata?.({
        harnessAutoResolved: decision.bySlug,
      });
    } else {
      sctx = harnessScopedCtx(args.harness, ctx);
    }
    const harnessSlug = resolveCtxHarnessSlug(sctx);
    const dryRun = args.dryRun === true;

    if (args.phase === 'activation') {
      const workspaceId = sctx.workspaceId ?? activeWorkspaceId();
      if (!args.classRef) {
        return { data: {
          ok: false as const,
          slug: args.slug,
          phase: 'activation' as const,
          error: 'activation_audit_invalid',
          problems: [{
            code: 'class_ref_required',
            detail: 'classRef must be the exact PlanClassRubricRef used by plans:evaluate-spec-quality; do not infer it from plan prose',
          }],
          message: 'Activation audits require the exact evaluated PlanClassRubricRef so the acceptance BAR seed preserves plan-class provenance.',
        } };
      }
      const submittedActivation: ActivationAuditPayload = {
        sourceRanges: (args.sourceRanges ?? []).map((range) => {
          // `sessions:list` exposes both the raw session id and the convenient
          // `<sourceKind>:<sessionId>` selector. Store the canonical id so a
          // selector range covers the public `session_turn:` refs it names and
          // re-audits do not accumulate equivalent raw/prefixed ranges.
          const selector = parseSessionSelector(range.sessionId);
          return {
            ...range,
            sessionId:
              selector.sourceKind === undefined || selector.sourceKind === range.sourceKind
                ? selector.sessionId
                : range.sessionId,
          };
        }),
        mappings: args.mappings ?? [],
        repairedOmissions: args.repairedOmissions ?? [],
        rejectedOrSuperseded: args.rejectedOrSuperseded ?? [],
        unresolvedBlockers: args.unresolvedBlockers ?? [],
        ...(args.itemProvenance?.length ? { itemProvenance: args.itemProvenance } : {}),
      };

      if (
        submittedActivation.unresolvedBlockers.length > 0 ||
        submittedActivation.mappings.some((mapping) => mapping.disposition === 'open')
      ) {
        const repairFiling = dryRun
          ? null
          : await ensureActivationAuditRepairFiling({
              workspaceId,
              harnessSlug: harnessSlug ?? '',
              planSlug: args.slug,
              activation: submittedActivation,
            });
        return { data: {
          ok: false as const,
          slug: args.slug,
          phase: 'activation' as const,
          ...(dryRun ? { dryRun: true as const, preview: true as const } : {}),
          error: 'activation_blocked',
          message:
            'Activation audit has unresolved blockers or open mappings. Any nonempty unresolvedBlockers list blocks and records nothing; repair/map them before ready/active. Put resolved conditional limitations in covered mappings/summary.',
          unresolvedBlockers: submittedActivation.unresolvedBlockers,
          openMappingIds: submittedActivation.mappings
            .filter((mapping) => mapping.disposition === 'open')
            .map((mapping) => mapping.id),
          ...(repairFiling ? { repairWorkItem: repairFiling.id, repairFiling } : {}),
        } };
      }

      const previousAudit = await getLatestActivationAudit(args.slug, { workspaceId });
      if (!previousAudit) {
        const missingCoverage: Problem[] = [];
        if (submittedActivation.sourceRanges.length === 0) {
          missingCoverage.push({
            code: 'source_ranges_required',
            detail: 'sourceRanges must contain at least one conversation range on the first activation audit',
          });
        }
        if (submittedActivation.mappings.length === 0) {
          missingCoverage.push({
            code: 'mappings_required',
            detail: 'mappings must contain at least one requirement mapping on the first activation audit',
          });
        }
        if (missingCoverage.length > 0) {
          return { data: {
            ok: false as const,
            slug: args.slug,
            phase: 'activation' as const,
            error: 'activation_audit_invalid',
            problems: missingCoverage,
            message: 'The first activation audit requires nonempty sourceRanges and mappings; nothing was recorded.',
          } };
        }
      }
      const currentPlan = await getPlanRow(args.slug, {
        workspaceId,
        harnessSlug: harnessSlug ?? '',
      });
      // A prior target whose destination the current plan no longer contains (an R-N removed
      // by a rubric amendment, a deleted item/decision/section) is dead: it may be retired,
      // because keeping it could never pass the plan-target validation below. A malformed
      // target is not "dead" — it never named a destination, so it stays a conflict.
      const deadTargets = previousAudit?.activation && currentPlan
        ? validateActivationAuditPlanTargets(previousAudit.activation, currentPlan.content)
          .filter((problem) => problem.code !== 'invalid_plan_target')
          .map(({ mappingId, target }) => ({ mappingId, target }))
        : [];
      const merged = mergeActivationAuditCoverage(previousAudit?.activation, submittedActivation, {
        deadTargets,
        // WI-10006324: retire carried provenance for items the plan has since dropped.
        ...(currentPlan ? { liveItemIds: currentPlanItemIds(currentPlan.content) } : {}),
      });
      if (!merged.ok) {
        return { data: {
          ok: false as const,
          slug: args.slug,
          phase: 'activation' as const,
          error: 'activation_coverage_regression' as const,
          previousAuditSeq: previousAudit?.auditSeq ?? null,
          conflicts: merged.conflicts,
          message:
            'This re-audit would replace or shrink prior source-conversation coverage. ' +
            'Keep existing M-NNN ids stable and additive; allocate new ids for new requirements. Nothing was recorded.',
        } };
      }
      const activation = merged.activation;
      const sourceRanges = activation.sourceRanges;
      const mappings = activation.mappings;

      if (dryRun && !currentPlan) {
        return { data: {
          ok: false as const,
          slug: args.slug,
          phase: 'activation' as const,
          dryRun: true as const,
          preview: true as const,
          error: 'plan_not_found',
          message: `Plan '${args.slug}' could not be read for a side-effect-free activation preview.`,
        } };
      }
      if (currentPlan) {
        const stagingProblems = stagingFirstActivationProblems(
          parsePlan(currentPlan.content, { filePath: `${args.slug}.md` }),
        );
        if (stagingProblems.length > 0) {
          return { data: {
            ok: false as const,
            slug: args.slug,
            phase: 'activation' as const,
            error: 'staging_first_guard_failed' as const,
            problems: stagingProblems,
            message:
              `${stagingProblems.length} non-final item(s) gate implementation on the release plane. ` +
              'Rewrite them for staging/current-build acceptance or add the narrow deployed-only exception described per item; nothing was recorded.',
          } };
        }
      }

      const sourceProblems: Problem[] = [];
      const sourceRefs: string[] = [];
      for (const mapping of mappings) {
        for (const ref of mapping.sourceRefs) {
          sourceRefs.push(ref);
          const parsed = parseTurnRef(ref);
          if (!parsed || !ref.startsWith('session_turn:')) {
            sourceProblems.push({
              itemId: mapping.id,
              code: 'invalid_session_turn_ref',
              detail: `${mapping.id} source ref '${ref}' is not a canonical session_turn:<kind>:<session>:<turn> reference`,
            });
            continue;
          }
          const covered = sourceRanges.some(
            (range) =>
              range.sourceKind === parsed.sourceKind &&
              range.sessionId === parsed.sessionId &&
              parsed.turnIdx >= range.fromTurn &&
              parsed.turnIdx <= range.toTurn,
          );
          if (!covered) {
            sourceProblems.push({
              itemId: mapping.id,
              code: 'source_ref_outside_range',
              detail: `${mapping.id} source ref '${ref}' is outside every declared sourceRange`,
            });
          }
        }
      }
      if (sourceProblems.length > 0) {
        return { data: {
          ok: false as const,
          slug: args.slug,
          phase: 'activation' as const,
          error: 'activation_audit_invalid',
          problems: sourceProblems,
          message: `${sourceProblems.length} source mapping problem(s) — nothing was recorded.`,
        } };
      }

      // This tool opts out of the ambient workspace transaction because the
      // activation writer takes its own advisory-locked transaction below.
      // Consequently ctx.tx is intentionally absent at runtime; resolve the
      // canonical session refs through the same org SQL surface as the writer.
      const { sql } = getOrgPg();
      const resolutions = await resolveSessionTurnRefs(
        sql as Parameters<typeof resolveSessionTurnRefs>[0],
        workspaceId,
        sourceRefs,
      );
      const unresolved = resolutions.filter((resolution) => !resolution.ok);
      if (unresolved.length > 0) {
        return { data: {
          ok: false as const,
          slug: args.slug,
          phase: 'activation' as const,
          error: 'source_refs_unresolved',
          problems: unresolved.map((resolution) => ({
            code: resolution.reason === 'invalid_ref' ? 'invalid_session_turn_ref' : 'session_turn_not_found',
            detail: `'${resolution.ref}' could not be resolved through sessions:read's index/archive stores`,
          })),
          message:
            `${unresolved.length} source ref(s) are not directly readable. Refresh/repair the transcript source; no audit was recorded.`,
        } };
      }

      // plan-item-provenance-2026-09-29 P-002: the reverse check. Every current item
      // must trace to an OWNER turn (not an assistant or machine-injected one), a valid
      // derivation, or an explicit agent-added declaration.
      const provenance = currentPlan
        ? await evaluateActivationItemProvenance({
            planContent: currentPlan.content,
            mappings,
            declarations: activation.itemProvenance ?? [],
            previous: {
              exists: previousAudit != null,
              check: previousAudit?.activation?.itemProvenanceCheck ?? null,
            },
            lookupOrigins: dbRefOriginLookup(sql as Parameters<typeof dbRefOriginLookup>[0], workspaceId),
          })
        : null;
      if (provenance && provenance.problems.length > 0) {
        return { data: {
          ok: false as const,
          slug: args.slug,
          phase: 'activation' as const,
          ...(dryRun ? { dryRun: true as const, preview: true as const } : {}),
          error: 'item_provenance_invalid' as const,
          problems: provenance.problems,
          message: `${provenance.problems.length} itemProvenance declaration problem(s); nothing was recorded.`,
        } };
      }
      if (provenance?.refuse) {
        return { data: {
          ok: false as const,
          slug: args.slug,
          phase: 'activation' as const,
          ...(dryRun ? { dryRun: true as const, preview: true as const } : {}),
          error: 'item_provenance_missing' as const,
          unresolvedItems: provenance.check.unresolved,
          problems: itemProvenanceMissingProblems(provenance.summary),
          message:
            `${provenance.check.unresolved.length} plan item(s) do not trace to anything the owner said: ` +
            `${provenance.check.unresolved.join(', ')}. Cite the owner turn in a mapping targeting the item, or declare it ` +
            'in itemProvenance as derived (from an owner-backed target) or agent-added (with a reason). Nothing was recorded.',
        } };
      }
      if (provenance) activation.itemProvenanceCheck = provenance.check;
      const itemProvenanceResult = provenance
        ? {
            enforced: provenance.check.enforced,
            counts: provenance.summary.counts,
            unresolved: provenance.check.unresolved,
            ...(provenance.warning ? { warning: provenance.warning } : {}),
          }
        : null;

      if (dryRun) {
        const targetProblems = validateActivationAuditPlanTargets(activation, currentPlan!.content);
        if (targetProblems.length > 0) {
          return { data: {
            ok: false as const,
            slug: args.slug,
            phase: 'activation' as const,
            dryRun: true as const,
            preview: true as const,
            error: 'plan_targets_invalid' as const,
            problems: targetProblems,
            message: `${targetProblems.length} mapping target(s) do not exist in the current plan revision; no writes were performed.`,
          } };
        }
        // BAR seeding is a precondition on the PLAN, not on this payload, so the
        // preview used to pass while the identical dryRun:false call refused
        // `bar_mapping_missing` — an ok:true scoped to the payload but read as a
        // verdict on the call. Mirror the writer's own gate EXACTLY: plan-audits
        // wraps every BAR branch in `if (current.acceptance_bar_epoch != null)`,
        // so a plan outside the contract requires no Bar-to-work map. Checking
        // unconditionally would refuse the ~94% of plans whose epoch is NULL
        // (measured 2026-09-20: 1916 of 2044) — the mirror-image false verdict.
        const barGateRows = await sql<Array<{
          acceptance_bar_epoch: string | null;
          acceptance_bar_cohort: string | null;
          acceptance_bar_rubric_slug: string | null;
        }>>`
          SELECT acceptance_bar_epoch, acceptance_bar_cohort, acceptance_bar_rubric_slug
            FROM harness_shared.harness_plans
           WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug ?? ''}
             AND plan_slug = ${args.slug}
        `;
        if (barGateRows?.[0]?.acceptance_bar_epoch != null) {
          const barSource = validateAcceptanceBarSource(currentPlan!.content);
          if (!barSource.ok) {
            return { data: {
              ok: false as const,
              slug: args.slug,
              phase: 'activation' as const,
              dryRun: true as const,
              preview: true as const,
              error: barSource.problems[0]!.code,
              problems: barSource.problems,
              message:
                `${barSource.problems.length} BAR seed problem(s): ` +
                `${barSource.problems.map((problem) => problem.detail).join('; ')}`,
            } };
          }
          const projectionIdentities = await sql<Array<{
            spec_id: string;
            source_bar_key: string | null;
            lifecycle_status: 'draft' | 'active' | 'accepted' | 'superseded';
          }>>`
            SELECT c.spec_id, r.source_bar_key, r.lifecycle_status
              FROM harness_shared.plan_spec_clauses c
              JOIN harness_shared.plan_spec_clause_revisions r
                ON r.workspace_id = c.workspace_id AND r.harness_slug = c.harness_slug
               AND r.plan_slug = c.plan_slug AND r.spec_id = c.spec_id
               AND r.revision = c.current_revision
             WHERE c.workspace_id = ${workspaceId}
               AND c.harness_slug = ${harnessSlug ?? ''}
               AND c.plan_slug = ${args.slug}
               AND c.spec_id ~ '^AUTO-BAR-R-[0-9]+-P-[0-9]{3,}$'
             ORDER BY c.spec_id
             LIMIT ${MAX_BAR_PROJECTION_EDGES + 1}`;
          if (projectionIdentities.length > MAX_BAR_PROJECTION_EDGES) {
            return { data: {
              ok: false as const,
              slug: args.slug,
              phase: 'activation' as const,
              dryRun: true as const,
              preview: true as const,
              error: 'bar_projection_set_too_large' as const,
              problems: [{
                code: 'bar_projection_set_too_large' as const,
                detail: `existing projection identity read exceeded ${MAX_BAR_PROJECTION_EDGES}; refusing a truncated comparison`,
              }],
              message: `1 BAR seed problem(s): existing projection identity read exceeded ${MAX_BAR_PROJECTION_EDGES}; refusing a truncated comparison`,
            } };
          }
          const expectedProjectionIds = new Set(
            barSource.mappings.flatMap((mapping) =>
              mapping.planItemIds.map((planItemId) => `AUTO-BAR-${mapping.barKey}-${planItemId}`),
            ),
          );
          const unexpected = unexpectedAcceptanceBarProjectionIds(
            expectedProjectionIds,
            projectionIdentities,
          );
          if (unexpected.length > 0) {
            const detail = acceptanceBarProjectionConflictDetail(unexpected);
            return { data: {
              ok: false as const,
              slug: args.slug,
              phase: 'activation' as const,
              dryRun: true as const,
              preview: true as const,
              error: 'bar_projection_conflict' as const,
              problems: [{
                code: 'bar_projection_conflict' as const,
                detail,
              }],
              message: `1 BAR seed problem(s): ${detail}`,
            } };
          }
          // P-003/P-029: mirror the writer's activation contract-completeness refusal.
          // The writer judges only FRESH BARs; on a never-seeded post-epoch plan every
          // BAR is fresh, so the parsed source is exactly what it judges. A seeded plan
          // re-derives nothing fresh on re-audit (a meaning change routes to amendment),
          // so the preview stays silent there exactly as the writer does.
          const barGate = barGateRows[0]!;
          if (barGate.acceptance_bar_rubric_slug == null &&
              (barGate.acceptance_bar_cohort ?? 'post-epoch') === 'post-epoch') {
            const contractProblems = acceptanceBarSourceContractProblems(barSource.bars, barSource.mappings);
            if (contractProblems.length > 0) {
              return { data: {
                ok: false as const,
                slug: args.slug,
                phase: 'activation' as const,
                dryRun: true as const,
                preview: true as const,
                error: contractProblems[0]!.code,
                problems: contractProblems,
                message:
                  `${contractProblems.length} BAR seed problem(s): ` +
                  `${contractProblems.map((problem) => problem.detail).join('; ')}`,
              } };
            }
          }
        }
        return { data: {
          ok: true as const,
          slug: args.slug,
          phase: 'activation' as const,
          dryRun: true as const,
          preview: true as const,
          sourceRanges: sourceRanges.length,
          mappings: mappings.length,
          carriedMappings: merged.carriedMappingIds.length,
          carriedMappingIds: merged.carriedMappingIds,
          ...(merged.retiredTargets.length ? { retiredTargets: merged.retiredTargets } : {}),
          coverageBaseAuditSeq: previousAudit?.auditSeq ?? null,
          sourceRefsResolved: resolutions.length,
          itemProvenance: itemProvenanceResult,
          planSnapshot: {
            version: currentPlan!.version,
            contentHash: currentPlan!.contentHash,
          },
          message: 'Activation audit validation passed; no audit, repair, clause, or event writes were performed.',
        } };
      }

      const recorded = await recordCurrentActivationAudit({
        workspaceId,
        planSlug: args.slug,
        harnessSlug: harnessSlug ?? '',
        createdBy: resolveAgentIdentity(ctx as Parameters<typeof resolveAgentIdentity>[0]).ownerId,
        classRef: args.classRef,
        activation,
        summary: args.summary ?? null,
      });
      if (!recorded.ok) {
        return { data: {
          slug: args.slug,
          phase: 'activation' as const,
          ...recorded,
        } };
      }

      // plan-item-provenance P-004: plan_audits has no change trigger, so this — the sole
      // activation-audit writer — pushes the provenance view itself after the commit.
      try {
        const { notifySyncInvalidate } = await import('../../sync-sse');
        await notifySyncInvalidate('plans.provenance', undefined);
      } catch {
        /* best-effort — the panel refreshes on its next mount */
      }

      // EI-22638466916646751: surface the same side-effect-free checkpoint
      // consult preview that plans:start would evaluate. The audit is already
      // durable at this point, so an unavailable advisory preview must remain
      // visible without changing the successful audit outcome.
      const activationReadiness = {
        consult: currentPlan?.content
          ? await previewPlanStartConsult({
              workspaceId,
              requesterId: resolveAgentIdentity(ctx as Parameters<typeof resolveAgentIdentity>[0]).ownerId,
              planSlug: args.slug,
              planContent: currentPlan.content,
            })
          : {
              outcome: 'unavailable' as const,
              error: 'consult_preview_unavailable' as const,
              message: 'Consult candidate preview could not be evaluated because the canonical plan content was unavailable.',
            },
      };

      // P-019 / D-047: derive DRAFT spec clauses from the realizing mappings this audit
      // just recorded, so the design→code contract exists BY DEFAULT rather than by
      // opt-in. Safe to run unconditionally: a `draft` clause is outside the coverage
      // gate's ENFORCEABLE_LIFECYCLE, and the DB constraint
      // plan_spec_clause_revisions_acceptance_exact makes promotion impossible without a
      // named accepter — so this can never refuse anyone's ship.
      //
      // NON-FATAL BY CONSTRUCTION. The audit is already durably recorded at this point.
      // A derivation failure must therefore be REPORTED, never propagated: throwing here
      // would turn a successful audit into a caller-visible failure and invite a retry
      // that re-records nothing, which is strictly worse than deriving no clauses.
      let derivedSpecClauses: Awaited<ReturnType<typeof persistDerivedDraftClauses>> | {
        error: string;
      } | null = null;
      // Post-epoch plans already persisted their BAR-derived clause projections in
      // recordCurrentActivationAudit's SAME transaction. Running the legacy mapper
      // again would create a competing projection family from source-conversation
      // M-NNN rows. Historical plans retain the old non-fatal behavior until P-010
      // gives them an explicit cohort.
      if (!recorded.barSeed && !recorded.barSeedPendingAmendment && !recorded.barSeedPendingRepair) {
        try {
          derivedSpecClauses = await persistDerivedDraftClauses(
            {
              planSlug: args.slug,
              ...(harnessSlug ? { harnessSlug } : {}),
              mappings,
              // Liveness: an empty read is UNKNOWN, and the deriver fails open on it
              // (D-040's rule) — `setSpecClause` is the backstop that refuses a target the
              // plan does not actually have.
              // WI-10005174: `harnessSlug` is only a candidate here; read the items
              // of the harness that actually owns the plan.
              planItems: await getPlanItemStatuses(args.slug, {
                harnessSlug: await resolvePlanItemHomeHarness(args.slug, harnessSlug),
              }),
              actorId: resolveAgentIdentity(ctx as Parameters<typeof resolveAgentIdentity>[0]).ownerId,
            },
            setSpecClause,
          );
        } catch (error) {
          derivedSpecClauses = { error: error instanceof Error ? error.message : String(error) };
        }
      }

      // P-017: the UNDER-READ detector. Independently re-extracts requirement-shaped
      // turns from the ranges this audit DECLARED and reports the ones no mapping cited.
      // ADVISORY by construction (see the module header): it is lexical, so it can see
      // that a turn sounds like a requirement but never that its content went unabsorbed.
      // Refusing an audit on that basis would block correct work on a guess.
      //
      // The verdict carries its own coverage (`unsuppliedTurns`), so a bounded read
      // degrades it to inconclusive rather than silently shrinking the denominator —
      // which would be the very self-chosen-denominator failure P-017 exists to close.
      let underRead:
        | Awaited<ReturnType<typeof detectUnderReadFromSource>>
        | { error: string };
      try {
        underRead = await detectUnderReadFromSource(
          { sourceRanges, mappings },
          async (ranges, cap) => {
            if (ranges.length === 0) return [];
            const sourceKinds = ranges.map((range) => range.sourceKind);
            const sessionIds = ranges.map((range) => range.sessionId);
            const rows = await sql<
              Array<{ source_kind: string; session_id: string; turn_idx: number; speaker: string; text: string }>
            >`
              SELECT turns.source_kind, turns.session_id, turns.turn_idx, turns.speaker, turns.text
                FROM harness_shared.session_turns AS turns
               WHERE (turns.workspace_id = ${workspaceId} OR turns.workspace_id = 'default')
                 -- Keep the two columns paired with one unnest. sql.array() is
                 -- required here: binding a JS array directly expands it as a
                 -- comma-separated SQL fragment, which is invalid as one unnest
                 -- argument on getOrgPg.
                 AND EXISTS (
                   SELECT 1
                     FROM unnest(
                       ${sql.array(sourceKinds)}::text[],
                       ${sql.array(sessionIds)}::text[]
                     ) AS wanted(source_kind, session_id)
                    WHERE wanted.source_kind = turns.source_kind
                      AND wanted.session_id = turns.session_id
                 )
                 AND turns.turn_idx BETWEEN ${Math.min(...ranges.map((r) => r.fromTurn))}
                                        AND ${Math.max(...ranges.map((r) => r.toTurn))}
                 -- D-006: the detector echoes uncited turn text back to the auditor, so a
                 -- turn another agent recorded inside its disclosure window never enters it.
                 AND NOT ${restrictedTurnSql(sql, 'turns', [resolveAgentIdentity(ctx as Parameters<typeof resolveAgentIdentity>[0]).ownerId])}
               ORDER BY turns.source_kind, turns.session_id, turns.turn_idx
               LIMIT ${cap}`;
            // Over-fetches across gaps between ranges of the SAME session; detectUnderRead
            // filters to the declared set, so the extra rows change no count.
            return rows.map((row) => ({
              sourceKind: row.source_kind,
              sessionId: row.session_id,
              turnIdx: row.turn_idx,
              speaker: row.speaker,
              text: row.text,
            }));
          },
        );
      } catch (error) {
        underRead = { error: error instanceof Error ? error.message : String(error) };
      }

      // P-018: the SOURCE-SPAN assertion — the complement of P-017 above. P-017 asks
      // "within the ranges you declared, what did you skip"; this asks the prior question
      // that decides the denominator: "were the ranges you declared the whole
      // conversation". An auditor who declares turns 60-120 of a 200-turn session has
      // excluded 140 turns before any mapping is written, and every other check operates
      // inside that choice and cannot see past it.
      //
      // Advisory for the same reason as P-017, and inconclusive rather than clean when a
      // declared session's extent cannot be measured — concluding "fully spanned" from a
      // failed measurement would be the very hole this closes, moved into the detector.
      let sourceSpan: ReturnType<typeof assertSourceSpan> | { error: string };
      try {
        const sessionKeys = [
          ...new Map(
            sourceRanges.map((range) => [
              `${range.sourceKind}::${range.sessionId}`,
              [range.sourceKind, range.sessionId] as const,
            ]),
          ).values(),
        ];
        const sourceKinds = sessionKeys.map(([sourceKind]) => sourceKind);
        const sessionIds = sessionKeys.map(([, sessionId]) => sessionId);
        const extents = sessionKeys.length === 0
          ? []
          : (
              await sql<Array<{ source_kind: string; session_id: string; min_turn: number; max_turn: number }>>`
                SELECT turns.source_kind, turns.session_id,
                       MIN(turns.turn_idx) AS min_turn, MAX(turns.turn_idx) AS max_turn
                  FROM harness_shared.session_turns AS turns
                 WHERE (turns.workspace_id = ${workspaceId} OR turns.workspace_id = 'default')
                   -- Keep the two key columns paired; a pair of independent ANY
                   -- predicates would admit cross-session combinations. Use
                   -- sql.array() so each array remains one SQL argument.
                   AND EXISTS (
                     SELECT 1
                       FROM unnest(
                         ${sql.array(sourceKinds)}::text[],
                         ${sql.array(sessionIds)}::text[]
                       ) AS wanted(source_kind, session_id)
                      WHERE wanted.source_kind = turns.source_kind
                        AND wanted.session_id = turns.session_id
                   )
                 GROUP BY turns.source_kind, turns.session_id`
            ).map((row) => ({
              sourceKind: row.source_kind,
              sessionId: row.session_id,
              minTurn: Number(row.min_turn),
              maxTurn: Number(row.max_turn),
            }));
        sourceSpan = assertSourceSpan({ sourceRanges, extents });
      } catch (error) {
        sourceSpan = { error: error instanceof Error ? error.message : String(error) };
      }

      await emitPlanEventForCaller(ctx as Parameters<typeof emitPlanEventForCaller>[0], {
        planSlug: args.slug,
        event: 'plan_audited',
        detail: `activation audit #${recorded.audit.auditSeq}`,
        after:
          `${mappings.length} mapping(s), ${resolutions.length} canonical source ref(s), ` +
          `revision ${recorded.auditedPlanRevision.seq}`,
      });

      return { data: {
        ok: true as const,
        slug: args.slug,
        phase: 'activation' as const,
        auditSeq: recorded.audit.auditSeq,
        auditedPlanRevision: recorded.auditedPlanRevision,
        sourceRanges: sourceRanges.length,
        mappings: mappings.length,
        carriedMappings: merged.carriedMappingIds.length,
        carriedMappingIds: merged.carriedMappingIds,
        ...(merged.retiredTargets.length ? { retiredTargets: merged.retiredTargets } : {}),
        coverageBaseAuditSeq: previousAudit?.auditSeq ?? null,
        sourceRefsResolved: resolutions.length,
        sourceRefsFromArchive: resolutions.filter((resolution) => resolution.source === 'archive').length,
        repairedOmissions: activation.repairedOmissions.length,
        rejectedOrSuperseded: activation.rejectedOrSuperseded.length,
        itemProvenance: itemProvenanceResult,
        derivedSpecClauses,
        activationReadiness,
        ...(recorded.barSeed ? { barSeed: recorded.barSeed } : {}),
        ...(recorded.barSeedPendingAmendment
          ? { barSeedPendingAmendment: recorded.barSeedPendingAmendment }
          : {}),
        ...(recorded.barSeedPendingRepair
          ? { barSeedPendingRepair: recorded.barSeedPendingRepair }
          : {}),
        underRead,
        sourceSpan,
      } };
    }

    // The plan's real items. An empty read is ambiguous between "no such plan" and "the
    // index read failed", and BOTH must refuse: validating against an empty list would
    // accept every itemId, which is the opposite of this tool's job.
    // WI-10005174: scope to the plan's own harness; a same-slug plan in another harness
    // would otherwise lend its item ids to this validation.
    const planItems = await getPlanItemStatuses(args.slug, {
      harnessSlug: await resolvePlanItemHomeHarness(args.slug, harnessSlug),
    });
    if (planItems.length === 0) {
      return { data: {
        ok: false as const,
        slug: args.slug,
        error: 'plan_items_unreadable',
        message:
          `No items could be read for plan '${args.slug}'. Either the plan does not exist, or it has no ` +
          `parsed items (item lines must be \`- **P-001** \\\`todo\\\` text\`). An audit cannot be validated ` +
          `against an unknown item set, so this is refused rather than recorded.`,
      } };
    }
    const known = new Set(planItems.map((i) => i.itemId));

    const submittedCitations = (args.items ?? []).flatMap((item) => item.citations ?? []) as AuditCitation[];
    // Root selection is deliberately still a WHOLE-PLAN decision: mixing evidence from
    // two equally-valid Hive checkouts would make the audit impossible to revalidate at
    // ship time. But a single bad citation must not discard every other item in the same
    // call. When the all-citations selection reports paths absent everywhere, retry root
    // selection after removing only those known-global misses; the per-item resolver below
    // then records the good entries and returns the bad ones as a partial result.
    let citationContext = await repoCitationContextForHarness(
      harnessSlug,
      submittedCitations,
    );
    const initialCitationFailure = isCitationContextFailure(citationContext) ? citationContext : null;
    if (initialCitationFailure) {
      const globallyUnresolvable = initialCitationFailure.citations;
      const mayResolve = submittedCitations.filter(
        (citation) =>
          !globallyUnresolvable.some(
            (failure) =>
              failure.path === citation.path &&
              failure.line === citation.line &&
              failure.symbol === citation.symbol,
          ),
      );
      const partialContext = await repoCitationContextForHarness(harnessSlug, mayResolve);
      // A null/failed retry means this was not a simple item-local citation miss (for
      // example, the available roots are ambiguous). Keep the original fail-closed
      // response rather than guessing a tree.
      if (partialContext && !isCitationContextFailure(partialContext)) citationContext = partialContext;
    }
    if (isCitationContextFailure(citationContext)) {
      const rendered = citationContext.citations
        .map((citation) =>
          `${citation.path ?? '(missing path)'}${citation.symbol ? `#${citation.symbol}` : ''} (${citation.reason})`,
        )
        .join('; ');
      return { data: {
        ok: false as const,
        slug: args.slug,
        error: 'citation_unresolvable',
        citations: citationContext.citations,
        message:
          `One or more code/test citations could not be resolved in any available checkout: ${rendered}. ` +
          `Fix the cited path, line, or symbol; the harness source root is not the cause.`,
      } };
    }
    if (!citationContext) {
      return { data: {
        ok: false as const,
        slug: args.slug,
        error: 'harness_repo_unresolved',
        message:
          `The canonical source root for harness '${harnessSlug ?? '(none)'}' could not be resolved. ` +
          `No audit was recorded. The resolver tried the registry root, every discovered hive ` +
          `checkout, and (for a repo-less hive with zero resolving checkouts) the canonical repo — ` +
          `so either the citations resolve nowhere, or more than one hive checkout resolves them ` +
          `(an ambiguous tie is refused). Register/fix the harness path rather than validating ` +
          `citations against a different checkout.`,
      } };
    }
    const deps = citationContext.deps;
    const auditedSha = args.auditedSha ?? resolveHeadSha(citationContext.repoRoot);
    const problems: Problem[] = [];
    const entries: AuditItemEntry[] = [];
    const seenItems = new Set<string>();
    let citationsChecked = 0;

    for (const it of args.items ?? []) {
      const itemProblemStart = problems.length;
      if (seenItems.has(it.itemId)) {
        problems.push({
          itemId: it.itemId,
          code: 'duplicate_item',
          detail: `'${it.itemId}' appears more than once in this audit pass`,
        });
        continue;
      }
      seenItems.add(it.itemId);
      if (!known.has(it.itemId)) {
        problems.push({
          itemId: it.itemId,
          code: 'unknown_item',
          detail: `'${it.itemId}' is not an item of plan '${args.slug}'`,
        });
        continue;
      }

      const citations = (it.citations ?? []) as AuditCitation[];

      if (it.verdict === 'implemented' && citations.length === 0) {
        problems.push({
          itemId: it.itemId,
          code: 'uncited_verdict',
          detail: `verdict 'implemented' needs at least one citation — that claim is the whole point of the audit`,
        });
      } else if (it.verdict === 'implemented' && !citations.some(isVerifyingCitation)) {
        // D-008. Requiring "at least one citation" was not enough: `doc` satisfied it, so
        // `implemented` — whose documented meaning is "traced to as-built code the auditor
        // READ" — could be claimed on a document asserting completion. Only code/test are
        // evidence; a doc says where a non-source deliverable lives, never that code exists.
        problems.push({
          itemId: it.itemId,
          code: 'implemented_without_code',
          detail:
            `verdict 'implemented' requires at least one \`code\` or \`test\` citation resolving against the ` +
            `tree — a \`doc\` citation cannot support it. Read the CODE and cite the file that implements ` +
            `'${it.itemId}'; do not rely on a doc, a work-item, or your memory of writing it. If the item's ` +
            `deliverable genuinely is not source, the verdict is 'not-code' (with \`note\`), not 'implemented'.`,
        });
      }
      if (it.verdict === 'not-code' && !it.note) {
        // The widest escape hatch in the design — wider than `none`, and unmetered until
        // D-008. A reason is the minimum bar, and summarizeCoverage now counts these.
        problems.push({
          itemId: it.itemId,
          code: 'not_code_without_reason',
          detail:
            `verdict 'not-code' requires \`note\` saying what the deliverable IS and why no code implements ` +
            `it. This verdict exempts an item from code verification, so it is recorded and counted, never ` +
            `assumed (D-008).`,
        });
      }
      if (it.verdict === 'dropped' && !it.note) {
        problems.push({
          itemId: it.itemId,
          code: 'drop_without_reason',
          detail: `verdict 'dropped' requires \`note\` — departing from the plan is fine, departing silently is not (D-002)`,
        });
      }

      const storedCitations: AuditCitation[] = [];
      for (const c of citations) {
        citationsChecked += 1;
        const res = resolveCitation(c, deps);
        if (!res.ok) {
          problems.push({
            itemId: it.itemId,
            code: `citation_${res.reason}`,
            detail: res.detail ?? `${c.kind} citation did not resolve (${res.reason})`,
          });
          storedCitations.push(c);
          continue;
        }
        if (isVerifyingCitation(c)) {
          const blobSha = citationBlobSha(c, deps);
          if (!blobSha) {
            problems.push({
              itemId: it.itemId,
              code: 'citation_blob_unreadable',
              detail: `${c.kind} citation '${c.path ?? ''}' resolved but its bytes could not be fingerprinted`,
            });
            storedCitations.push(c);
            continue;
          }
          if (auditedSha) {
            if (!deps.blobShaAt) {
              problems.push({
                itemId: it.itemId,
                code: 'citation_audited_sha_unverifiable',
                detail:
                  `${c.kind} citation '${c.path ?? ''}' cannot be checked against auditedSha '${auditedSha}' ` +
                  `because the citation context does not provide a commit-scoped blob resolver`,
              });
              storedCitations.push(c);
              continue;
            }
            const auditedBlobSha = citationBlobShaAt(c, auditedSha, deps);
            if (!auditedBlobSha) {
              problems.push({
                itemId: it.itemId,
                code: 'citation_audited_sha_unresolvable',
                detail:
                  `${c.kind} citation '${c.path ?? ''}' resolves in the current tree but not at auditedSha ` +
                  `'${auditedSha}' (the commit may not contain the cited path or may be unavailable)`,
              });
              storedCitations.push(c);
              continue;
            }
            if (auditedBlobSha !== blobSha) {
              problems.push({
                itemId: it.itemId,
                code: 'citation_audited_sha_mismatch',
                detail:
                  `${c.kind} citation '${c.path ?? ''}' has current blobSha '${blobSha}' but auditedSha ` +
                  `'${auditedSha}' carries '${auditedBlobSha}'; re-audit against a commit containing the ` +
                  `cited bytes`,
              });
              storedCitations.push(c);
              continue;
            }
          }
          storedCitations.push({ ...c, blobSha });
        } else {
          storedCitations.push(c);
        }
      }

      // An item with any problem is not an auditable entry. Keep it out of the
      // persisted pass so a partial result can never look like that item passed.
      if (problems.length === itemProblemStart) {
        entries.push({
          itemId: it.itemId,
          verdict: it.verdict,
          citations: storedCitations,
          ...(it.note ? { note: it.note } : {}),
        });
      }
    }

    for (const f of args.findings ?? []) {
      if (f.disposition === 'filed' && !f.ref) {
        problems.push({
          code: 'finding_undisposed',
          detail: `finding "${f.summary.slice(0, 60)}" is marked 'filed' but carries no work-item ref — file it, then cite it`,
        });
      }
    }

    // A mixed batch is useful when its valid items can be committed independently:
    // persist those entries, surface the item-scoped problems, and let the caller retry
    // only the rejected items. Batch-wide problems (for example an invalid finding)
    // remain atomic because they are not attributable to one persisted item.
    const canRecordPartial =
      entries.length > 0 &&
      problems.length > 0 &&
      problems.every((problem) => problem.itemId !== undefined);
    if (problems.length > 0 && !canRecordPartial) {
      // Preserve the original, more actionable error for an all-invalid batch. A
      // retry against an empty citation subset is useful for mixed batches, but if
      // it produced no valid entry there is still no audit to record.
      if (
        initialCitationFailure &&
        entries.length === 0 &&
        problems.every((problem) => problem.code.startsWith('citation_'))
      ) {
        const rendered = initialCitationFailure.citations
          .map((citation) =>
            `${citation.path ?? '(missing path)'}${citation.symbol ? `#${citation.symbol}` : ''} (${citation.reason})`,
          )
          .join('; ');
        return { data: {
          ok: false as const,
          slug: args.slug,
          error: 'citation_unresolvable',
          citations: initialCitationFailure.citations,
          message:
            `One or more code/test citations could not be resolved in any available checkout: ${rendered}. ` +
            `Fix the cited path, line, or symbol; the harness source root is not the cause.`,
        } };
      }
      return { data: {
        ok: false as const,
        slug: args.slug,
        error: 'audit_invalid',
        problems,
        message:
          `${problems.length} problem(s) — nothing was recorded. Every problem is listed above so one fix-up ` +
          `pass clears them all. A citation that will not resolve is usually a real finding about the work, ` +
          `not a typo: if the file you expected is not there, the item may not actually be implemented.`,
      } };
    }

    const auditedAt = new Date().toISOString();
    const previous = await getEffectiveItemAudits(args.slug);
    const effectiveEntries = prepareAuditPassEntries({
      planItems,
      submitted: entries,
      previous,
      auditedSha,
      auditedAt,
    });
    const submittedIds = new Set(entries.map((entry) => entry.itemId));
    const carriedItemIds = effectiveEntries
      .filter((entry) => !submittedIds.has(entry.itemId))
      .map((entry) => entry.itemId);

    const provenanceProblems = divergentCitationBlobShaProblems(effectiveEntries);
    if (provenanceProblems.length > 0) {
      return { data: {
        ok: false as const,
        slug: args.slug,
        error: 'audit_invalid',
        problems: [...problems, ...provenanceProblems],
        message:
          'The audit pass is internally inconsistent: one or more cited paths carry multiple blobSha values. ' +
          'Nothing was recorded; re-audit every listed item against one tree snapshot.',
      } };
    }

    const coverage = summarizeCoverage(effectiveEntries);
    const audited = new Set(effectiveEntries.map((e) => e.itemId));
    // Items with no current OR historical audit entry. Unlisted prior entries were
    // carried by the verb with their original provenance, so callers never have to
    // copy them forward and accidentally re-stamp them at this pass's sha (D-006).
    const uncoveredItems = planItems
      .filter((i) => !audited.has(i.itemId) && i.status !== 'dropped')
      .map((i) => i.itemId);

    const rejectedItemIds = [...new Set(problems.flatMap((problem) => (problem.itemId ? [problem.itemId] : [])))];
    const partialNote = problems.length > 0
      ? `${dryRun ? 'Would record' : 'Recorded'} ${entries.length} valid item(s); ${rejectedItemIds.length} item(s) were not recorded. ` +
        `Retry only the rejected item ids after fixing their listed problems.`
      : null;
    const uncoveredNote = uncoveredItems.length > 0
      ? `${uncoveredItems.length} non-dropped item(s) have no audit entry. Audit ONLY those listed ` +
        `items (or drop them with a reason); every other unlisted item already carried forward with ` +
        `its original provenance.`
      : null;
    const resultNote = [partialNote, uncoveredNote].filter((note): note is string => Boolean(note)).join(' ');

    if (dryRun) {
      return { data: {
        ok: true as const,
        slug: args.slug,
        phase: 'completion' as const,
        dryRun: true as const,
        preview: true as const,
        auditedSha,
        auditedAt,
        citationRepoRoot: citationContext.repoRoot,
        citationRootSource: citationContext.rootSource,
        citationsChecked,
        itemsAuditedThisPass: entries.length,
        itemsCarriedForward: carriedItemIds.length,
        carriedItemIds,
        coverage,
        uncoveredItems,
        ...(problems.length > 0
          ? {
              partial: true as const,
              problems,
              rejectedItemIds,
            }
          : {}),
        ...(resultNote ? { note: resultNote } : {}),
        message: 'Completion audit validation passed; no audit or plan-event writes were performed.',
      } };
    }

    const audit = await recordPlanAudit({
      planSlug: args.slug,
      harnessSlug: harnessSlug ?? '',
      // Cast at the call, exactly as the sibling set-plan-status.ts does. Passing `ctx`
      // raw makes TS infer the handler's ctx parameter as ResolveIdentityCtx, which no
      // defineTool overload supplies — the whole call then fails overload resolution with
      // a TS2769 that points at `handler` and says nothing about identity.
      createdBy: resolveAgentIdentity(ctx as Parameters<typeof resolveAgentIdentity>[0]).ownerId,
      auditedSha,
      items: effectiveEntries,
      findings: args.findings ?? [],
      summary: args.summary ?? null,
    });

    await emitPlanEventForCaller(ctx as Parameters<typeof emitPlanEventForCaller>[0], {
      planSlug: args.slug,
      event: 'plan_audited',
      detail: `audit #${audit.auditSeq}`,
      after: `${coverage.auditedItems} item(s), ${citationsChecked} citation(s) resolved`,
    });

    return { data: {
      ok: true as const,
      slug: args.slug,
      auditSeq: audit.auditSeq,
      auditedSha: audit.auditedSha,
      auditedAt,
      // WI-41365: which tree the citations were verified against, and why. Derivable
      // later by re-running the same selection, so it is disclosed here rather than
      // stored as a second copy the tree could drift from.
      citationRepoRoot: citationContext.repoRoot,
      citationRootSource: citationContext.rootSource,
      citationsChecked,
      itemsAuditedThisPass: entries.length,
      itemsCarriedForward: carriedItemIds.length,
      carriedItemIds,
      coverage,
      uncoveredItems,
      ...(problems.length > 0
        ? {
            partial: true as const,
            problems,
            rejectedItemIds,
          }
        : {}),
      ...(resultNote ? { note: resultNote } : {}),
    } };
  },
});
