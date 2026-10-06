/** plans:evaluate-spec-test-adequacy — compile exact clause/evidence rows into scorecard drafts. */
import { z } from 'zod';
import { refineEvenWithShapeIssues } from '../_refine-with-shape-issues';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { resolveEffectiveHarnessSlug } from './_ctx-opts';
import { listSpecClauses } from './spec-clauses-store';
import {
  evidenceCurrentInputKey,
  listSpecEvidence,
  evidenceCurrentInputSchema,
  type EvidenceCurrentInput,
} from './spec-evidence-store';
import { evaluateSpecTestAdequacy, latestLogicalEvidence, PLAN_CLASS_RUBRIC_REFS } from './spec-test-adequacy';
import { getBuildInfo, type BuildInfo } from '../../build-info';
import { fullBodyRef, isFullDetail, reviewReadDetailArg } from '../_review-read-detail';

type EvaluatedRow = ReturnType<typeof evaluateSpecTestAdequacy>;
const PASS_LIKE = new Set(['pass', 'not-applicable']);

/**
 * P-007 (RSR-P-007-A): the per-clause verdict table a summary read returns. It keeps every
 * field the scorecards:emit replay gate and the grading-integrity auditor compare
 * (specId / specRevision / specFingerprint / ratings[].rating / wouldBlock) so a replay
 * reads the SAME verdicts from either detail level; it drops only the prose — each
 * criterion's evidence text and the scorecardDraft — which is what made one evaluation
 * ~138 KB. A non-passing criterion keeps its short `suggestion`, the actionable part.
 */
function summaryRow(row: EvaluatedRow) {
  return {
    planSlug: row.planSlug,
    specId: row.specId,
    specRevision: row.specRevision,
    specFingerprint: row.specFingerprint,
    planItemId: row.planItemId,
    verdict: row.verdict,
    requiredProofFloor: row.requiredProofFloor,
    wouldBlock: row.wouldBlock,
    // P-019: the binding ids that drag each blocking criterion — ids only, so the compact
    // read stays compact while naming exactly which rows to retract or supersede.
    ...(Object.keys(row.draggingBindingIds).length > 0 ? { draggingBindingIds: row.draggingBindingIds } : {}),
    ratings: Object.fromEntries(
      Object.entries(row.ratings).map(([criterion, entry]) => [
        criterion,
        !PASS_LIKE.has(entry.rating) && entry.suggestion
          ? { rating: entry.rating, suggestion: entry.suggestion }
          : { rating: entry.rating },
      ]),
    ),
  };
}

const evaluatorBuildSchema = z
  .object({
    sha: z.string().trim().min(1).max(256).nullable(),
    version: z.string().trim().min(1).max(120),
  })
  .strict();

function evaluatorBuildDiff(recorded: BuildInfo, live: BuildInfo): boolean {
  return recorded.sha !== live.sha || recorded.version !== live.version;
}

/**
 * Exported so a scorecard's `rerunRecipe.args` can be validated against the REAL
 * schema rather than a hand-copied list of field names. A recipe that its own
 * evaluator rejects is not a rerun recipe, and a guard that restates the field
 * names here would pass through exactly the drift it is meant to catch.
 */
// RSR-P-008-A: the clause-pin rules are reported alongside any shape defect.
export const argsSchema = refineEvenWithShapeIssues(z.object({
  harness: harnessArg,
  slug: z.string().min(1),
  classRef: z
    .enum(PLAN_CLASS_RUBRIC_REFS)
    .describe('Existing plan-class standard rubric referenced by the plan acceptance rubric.'),
  /** Build identity recorded by a rerun recipe; used to surface evaluator drift. */
  evaluatorBuild: evaluatorBuildSchema.optional(),
  workItemIds: z.array(z.string().min(1)).min(1).max(500).optional(),
  evidenceRefs: z.array(z.string().trim().min(1).max(2000)).min(1).max(500).optional(),
  /** Exact immutable evidence binding row ids; an empty array selects no rows. */
  bindingIds: z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).max(500).optional(),
  specIds: z.array(z.string().min(1)).min(1).max(500).optional(),
  /** Immutable clause revision/fingerprint selected by a persisted replay recipe. */
  specRevision: z.number().int().positive().optional().describe(
    'Immutable clause revision pin. Supply together with specFingerprint; both are required when replaySnapshot is true.',
  ),
  specFingerprint: z.string().trim().min(1).max(256).optional().describe(
    'Immutable clause fingerprint pin. Supply together with specRevision; both are required when replaySnapshot is true.',
  ),
  /** Replay a persisted recipe against its pinned immutable clause revision. */
  replaySnapshot: z.boolean().optional().describe(
    'When true, grade the pinned immutable clause revision instead of the live one. Requires both specRevision and specFingerprint from the same immutable clause revision. Bindings with a persisted measurement recipe are still re-measured by the server, so a replay reports stale once the proven code moves; caller-supplied current fingerprints alone remain replayed-snapshot evidence, never server-measured evidence.',
  ),
  planItemIds: z.array(z.string().regex(/^P-\d{3,}$/)).min(1).max(200).optional(),
  current: z
    .union([
      z.array(evidenceCurrentInputSchema).max(500),
      z
        .object({
          supplied: z.boolean(),
          fingerprints: z.array(evidenceCurrentInputSchema).max(500),
        })
        .strict(),
    ])
    .optional()
    .describe(
      'Caller-supplied fingerprints may be the canonical array or the persisted rerunRecipe.current wrapper; wrapper.supplied:false means current was omitted. Matching stored values remain unknown for freshness and cannot produce freshness:pass without an internal server-measured comparison.',
    ),
  includeDraft: z.boolean().optional(),
  now: z.string().datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  detail: reviewReadDetailArg,
}), (args, ctx) => {
  if ((args.specRevision === undefined) !== (args.specFingerprint === undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['specRevision'],
      message: 'specRevision and specFingerprint must be supplied together for an immutable clause pin',
    });
  }
  if (args.replaySnapshot === true && (args.specRevision === undefined || args.specFingerprint === undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['replaySnapshot'],
      message: 'replaySnapshot requires specRevision and specFingerprint',
    });
  }
});

type HistoricalAuditSelection = {
  planSlug: string;
  specId: string;
  specRevision: number;
  specFingerprint: string;
  evidence: Array<{ evidenceKind: string; evidenceRef: string }>;
  bindingIds?: number[];
};

/**
 * Internal-only replay for an already-issued legacy scorecard whose recipe predates
 * exact bindingIds. The normal tool deliberately stays current-only; this path is
 * called by the grading auditor only after that tool returns selection_empty.
 */
export async function replaySpecTestAdequacyForHistoricalAudit(input: {
  args: z.infer<typeof argsSchema>;
  selection: HistoricalAuditSelection;
  workspaceId: string;
  auditAsOf: Date;
}): Promise<Record<string, unknown>> {
  const { args, selection, workspaceId, auditAsOf } = input;
  const evidenceRefs = [...new Set(selection.evidence.map((entry) => entry.evidenceRef))].sort();
  const recipeEvidenceRefs = [...new Set(args.evidenceRefs ?? [])].sort();
  const selectedEvidence = selection.evidence.map((entry) => JSON.stringify([entry.evidenceKind, entry.evidenceRef]));
  const exactEvidence = new Set(selectedEvidence);
  const validCutoff = Number.isFinite(auditAsOf.getTime());
  if (
    !validCutoff ||
    !workspaceId ||
    args.bindingIds !== undefined ||
    selection.bindingIds !== undefined ||
    args.replaySnapshot !== true ||
    args.slug !== selection.planSlug ||
    args.specRevision !== selection.specRevision ||
    args.specFingerprint !== selection.specFingerprint ||
    !args.specIds?.includes(selection.specId) ||
    evidenceRefs.length === 0 ||
    JSON.stringify(evidenceRefs) !== JSON.stringify(recipeEvidenceRefs)
  ) {
    return { ok: false, error: 'historical_audit_recipe_not_exact' };
  }

  const current =
    args.current === undefined
      ? undefined
      : Array.isArray(args.current)
        ? args.current
        : args.current.supplied
          ? args.current.fingerprints
          : undefined;
  const evidenceLimit = args.limit ?? 1000;
  const loaded = await listSpecEvidence({
    harnessSlug: args.harness,
    workspaceId,
    planSlugs: [selection.planSlug],
    workItemIds: args.workItemIds,
    specIds: [selection.specId],
    specRevision: selection.specRevision,
    specFingerprint: selection.specFingerprint,
    replaySnapshot: true,
    ...(args.current !== undefined ? { currentProvenance: 'replayed-snapshot' as const } : {}),
    evidenceRefs,
    current,
    includeRetracted: true,
    auditAsOf,
    limit: evidenceLimit,
  });
  if (loaded.length >= evidenceLimit) {
    return { ok: false, error: 'historical_evidence_selection_hit_limit', count: loaded.length, limit: evidenceLimit };
  }
  const evidence = loaded.filter(
    (row) =>
      row.planSlug === selection.planSlug &&
      row.specId === selection.specId &&
      row.specRevision === selection.specRevision &&
      row.specFingerprint === selection.specFingerprint &&
      exactEvidence.has(JSON.stringify([row.evidenceKind, row.evidenceRef])),
  );
  if (evidence.length === 0) return { ok: false, error: 'historical_selection_empty', count: 0 };

  const clauses = await listSpecClauses({
    harnessSlug: args.harness,
    workspaceId,
    planSlug: selection.planSlug,
    specIds: [selection.specId],
    revision: selection.specRevision,
    limit: 1,
  });
  const clause = clauses.find(
    (candidate) =>
      candidate.specId === selection.specId &&
      candidate.revision === selection.specRevision &&
      candidate.contentHash === selection.specFingerprint,
  );
  if (!clause || (args.includeDraft !== true && clause.lifecycleStatus !== 'active' && clause.lifecycleStatus !== 'accepted')) {
    return { ok: false, error: 'historical_clause_snapshot_unavailable' };
  }

  const historicalEvidence = evidence.map((row) => ({
    ...row,
    currentness: {
      ...row.currentness,
      overall: 'unknown' as const,
      provenance: 'replayed-snapshot' as const,
      staleReasons: [],
      unknownReasons: [...new Set([...row.currentness.unknownReasons, 'historical-audit-only'])],
    },
  }));
  const evaluated = evaluateSpecTestAdequacy({
    clause,
    evidence: historicalEvidence,
    classRef: args.classRef,
    harness: args.harness,
    current,
    rerunSelection: {
      workItemIds: args.workItemIds,
      evidenceRefs,
      planItemIds: args.planItemIds,
    },
    now: auditAsOf,
  });
  const recordedEvaluatorBuild = args.evaluatorBuild;
  const liveEvaluatorBuild = getBuildInfo();
  const evaluatorBuildDrift =
    recordedEvaluatorBuild && evaluatorBuildDiff(recordedEvaluatorBuild, liveEvaluatorBuild)
      ? { recorded: recordedEvaluatorBuild, live: liveEvaluatorBuild }
      : undefined;

  return {
    ok: true,
    evaluatorBuild: liveEvaluatorBuild,
    ...(evaluatorBuildDrift ? { evaluatorBuildDrift } : {}),
    rows: [summaryRow(evaluated)],
    count: 1,
    historicalAuditOnly: {
      provenance: 'historical-audit-only',
      asOf: auditAsOf.toISOString(),
      freshness: 'audit-only',
      bindings: evidence.map((row) => ({
        id: row.id,
        evidenceKind: row.evidenceKind,
        evidenceRef: row.evidenceRef,
        createdAt: row.createdAt,
        withdrawal: row.withdrawal ?? null,
      })),
    },
  };
}

export default defineTool({
  name: 'plans:evaluate-spec-test-adequacy',
  description:
    'Grade each affected current spec revision as one row against the reusable spec-test-adequacy rubric. Resolves exact P-005 evidence bindings and returns a per-clause verdict table with every would-block reason; detail:"full" adds criterion evidence and scorecards:emit-compatible drafts. Read-only; it never files a verdict. evidenceRefs selects immutable evidence references; bindingIds pins a replay to the exact persisted binding rows, including when references repeat. When replaySnapshot is true, include both specRevision and specFingerprint from the same immutable clause revision. Always check ok and rows.length before indexing rows[0].',
  guidance: {
    returns:
      'On success { ok, rows, count, verdicts, wouldBlock, includeDraft, excludedDraftCount, excludedDraftSpecIds, excludedClauses } with ok:true. Every successful result reports the lifecycle-filtered clauses and an explicit draft-exclusion count, including zero, so row counts do not imply that excluded drafts were evaluated. No call succeeds vacuously: when the plan has clauses but none is eligible — selector or not — the reply is ok:false with error:"selection_empty" rather than ok:true with zero rows. On evidence_selection_hit_limit the reply is ok:false with error, count, limit and remedy and NO rows field at all. The default detail:"summary" rows carry specId, specRevision, specFingerprint, verdict, wouldBlock and ratings[criterion].rating, plus a top-level fullBody ref (the exact re-call with detail:"full"); rows[].scorecardDraft and criterion evidence text exist only under detail:"full".',
    when: 'During implementation feedback or immediately before attempting work-item completion for spec-covered behavior.',
    notWhen: 'Authoring clauses — plans:set-specs. Binding proof — plans:bind-spec-evidence. Filing a returned draft — scorecards:emit. Indexing rows[0] without checking ok/rows.length first — an empty or error-shaped reply has no rows[0] to read.',
    chaining:
      'plans:get-specs → plans:bind-spec-evidence → plans:evaluate-spec-test-adequacy → plans:certify-spec-clauses files each passing card. P-007 consumes current emitted rows at work_items:complete.',
    seeAlso: ['plans:get-spec-evidence', 'scorecards:emit', 'rubrics:get spec-test-adequacy'],
  },
  capability: 'plans:read',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...AGENT_ROLES],
  ignoreSessionPayloadTier: true,
  modality: ['text'],
  args: argsSchema,
  // Structural shape behind `guidance.returns` (guidance-output-schema-live-guard). Kept
  // deliberately OPEN: the three reply arms (success, selection_empty, hit-limit) carry
  // different optional fields, and MCP clients validate structuredContent against this,
  // so only fields every arm types identically are declared.
  result: z
    .object({
      ok: z.boolean(),
      error: z.string().optional(),
      rows: z.array(z.record(z.string(), z.unknown())).optional(),
      count: z.number().int().nonnegative(),
      includeDraft: z.boolean().optional(),
      excludedDraftCount: z.number().int().nonnegative().optional(),
      excludedDraftSpecIds: z.array(z.string()).optional(),
      excludedClauses: z.array(z.object({
        specId: z.string(),
        revision: z.number().int(),
        lifecycleStatus: z.string(),
      })).optional(),
      verdicts: z.record(z.string(), z.number()).optional(),
      wouldBlock: z.array(z.record(z.string(), z.unknown())).optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    const sctx = harnessScopedCtx(args.harness, ctx);
    const harnessSlug = resolveEffectiveHarnessSlug(sctx);
    const liveEvaluatorBuild = getBuildInfo();
    const recordedEvaluatorBuild = args.evaluatorBuild;
    const evaluatorBuildDrift =
      recordedEvaluatorBuild && evaluatorBuildDiff(recordedEvaluatorBuild, liveEvaluatorBuild)
        ? { recorded: recordedEvaluatorBuild, live: liveEvaluatorBuild }
        : undefined;
    const current =
      args.current === undefined
        ? undefined
        : Array.isArray(args.current)
          ? args.current
          : args.current.supplied
            ? args.current.fingerprints
            : undefined;
    const evidenceLimit = args.limit ?? 1000;
    const allEvidence = await listSpecEvidence({
      harnessSlug,
      planSlugs: [args.slug],
      workItemIds: args.workItemIds,
      specIds: args.specIds,
      specRevision: args.specRevision,
      specFingerprint: args.specFingerprint,
      replaySnapshot: args.replaySnapshot === true,
      // `current` here is caller-supplied. Label it a replayed snapshot rather than
      // claiming the server measured it — otherwise any caller passing
      // replaySnapshot:true plus self-authored fingerprints mints a 'server-measured'
      // freshness verdict. The store still re-measures every binding that carries a
      // measurement recipe and prefers that result; this label applies only where it
      // cannot (WI-10002320; round trip pinned by scorecards/emit.evaluator-round-trip.test.ts).
      ...(args.replaySnapshot === true && current !== undefined
        ? { currentProvenance: 'replayed-snapshot' as const }
        : {}),
      evidenceRefs: args.evidenceRefs,
      current,
      bindingIds: args.bindingIds,
      limit: evidenceLimit,
    });
    if (allEvidence.length >= evidenceLimit) {
      return {
        data: {
          ok: false,
          error: 'evidence_selection_hit_limit',
          evaluatorBuild: liveEvaluatorBuild,
          ...(evaluatorBuildDrift ? { evaluatorBuildDrift } : {}),
          count: allEvidence.length,
          limit: evidenceLimit,
          remedy: 'Narrow workItemIds/specIds/evidenceRefs/bindingIds or raise limit; a capped evidence set cannot produce an adequacy verdict.',
        },
      };
    }
    const explicitSelection =
      args.specIds !== undefined ||
      args.workItemIds !== undefined ||
      args.evidenceRefs !== undefined ||
      args.bindingIds !== undefined ||
      args.planItemIds !== undefined;
    const bindingSelection =
      args.workItemIds !== undefined || args.evidenceRefs !== undefined || args.bindingIds !== undefined;
    if (bindingSelection && allEvidence.length === 0) {
      return {
        data: {
          ok: false,
          error: 'selection_empty',
          evaluatorBuild: liveEvaluatorBuild,
          ...(evaluatorBuildDrift ? { evaluatorBuildDrift } : {}),
          slug: args.slug,
          harnessSlug,
          classRef: args.classRef,
          count: 0,
          selectedEvidenceCount: 0,
          matchedClauseCount: 0,
          eligibleClauseCount: 0,
          selection: {
            specIds: args.specIds ?? null,
            workItemIds: args.workItemIds ?? null,
            evidenceRefs: args.evidenceRefs ?? null,
            bindingIds: args.bindingIds ?? null,
            planItemIds: args.planItemIds ?? null,
          },
          remedy:
            args.bindingIds !== undefined
              ? 'No current evidence binding matches the selected bindingIds. The row may be absent, retracted, or outside the pinned clause; inspect the target history before changing the selector.'
              : args.evidenceRefs !== undefined
                ? 'No current evidence binding matches the selected workItemIds/evidenceRefs. The binding may be absent, retracted, or superseded, or the selectors may not identify a bound proof. Check the target evidence history before changing them; pass specIds without a binding selector to evaluate intended uncovered clauses.'
                : 'No current evidence edge exists for the selected work item(s). The work item may lack a binding, or its proof may have been retracted or superseded. Check the target history; pass specIds to evaluate intended uncovered clauses.',
        },
      };
    }
    const evidenceSpecIds = new Set(allEvidence.map((row) => row.specId));
    const requestedSpecIds = args.specIds ?? (bindingSelection ? [...evidenceSpecIds] : undefined);
    const clauses = await listSpecClauses({
      harnessSlug,
      planSlug: args.slug,
      specIds: requestedSpecIds,
      planItemIds: args.planItemIds,
      revision: args.specRevision,
    });
    const pinnedClauses = args.specFingerprint
      ? clauses.filter((clause) => clause.contentHash === args.specFingerprint)
      : clauses;
    const isEligibleClause = (clause: (typeof pinnedClauses)[number]) =>
      args.includeDraft === true || clause.lifecycleStatus === 'active' || clause.lifecycleStatus === 'accepted';
    const eligible = pinnedClauses.filter(isEligibleClause);
    const excludedClauses = pinnedClauses
      .filter((clause) => !isEligibleClause(clause))
      .map((clause) => ({
        specId: clause.specId,
        revision: clause.revision,
        lifecycleStatus: clause.lifecycleStatus,
      }));
    const excludedDraftClauses = excludedClauses.filter((clause) => clause.lifecycleStatus === 'draft');
    // EI-23420771213407749: this vacuous-success guard must fire on an UNSELECTED call too.
    // Keyed on `explicitSelection` alone, a no-selector call whose clauses all get filtered
    // out (draft, or pinned away by specFingerprint) fell through to ok:true/rows:[]/count:0 —
    // a zero-work false green returned by the very tool the ship gate's own remedy text tells
    // an agent to run FIRST, so the false clean lands exactly where it is most trusted.
    // `clauses.length > 0` is the honest discriminator: clauses EXISTED and none survived
    // filtering, so nothing was measured. A plan with genuinely no clauses still returns
    // ok:true with zero rows — that is a true statement about an empty set, not a false green.
    if (eligible.length === 0 && (explicitSelection || clauses.length > 0)) {
      return {
        data: {
          ok: false,
          error: 'selection_empty',
          evaluatorBuild: liveEvaluatorBuild,
          ...(evaluatorBuildDrift ? { evaluatorBuildDrift } : {}),
          slug: args.slug,
          harnessSlug,
          classRef: args.classRef,
          count: 0,
          selectedEvidenceCount: allEvidence.length,
          matchedClauseCount: clauses.length,
          eligibleClauseCount: 0,
          selection: {
            specIds: args.specIds ?? null,
            workItemIds: args.workItemIds ?? null,
            evidenceRefs: args.evidenceRefs ?? null,
            bindingIds: args.bindingIds ?? null,
            planItemIds: args.planItemIds ?? null,
          },
          excludedClauses,
          remedy:
            clauses.length > 0 && args.includeDraft !== true
              ? `${explicitSelection ? 'The selection matched' : 'This plan has'} ${clauses.length} clause(s), but none is eligible — pass includeDraft:true to evaluate draft clauses, or select active/accepted clauses. Nothing was graded, so this is NOT a clean adequacy result.`
              : 'Verify the exact slug and specIds/workItemIds/evidenceRefs/bindingIds/planItemIds selection; no eligible clause matched. Nothing was graded, so this is NOT a clean adequacy result.',
        },
      };
    }
    const now = args.now ? new Date(args.now) : new Date();
    const rows = eligible.map((clause) =>
      evaluateSpecTestAdequacy({
        clause,
        evidence: allEvidence,
        classRef: args.classRef,
        harness: harnessSlug,
        current: (() => {
          const merged = new Map<string, EvidenceCurrentInput>();
          for (const input of current ?? []) merged.set(evidenceCurrentInputKey(input), input);
          // The grade selects the newest append of each exact-clause binding.
          // Its replay must use that SAME measurement, not an older recipe that
          // happens to appear later in the newest-first evidence history.
          const selected = new Set(latestLogicalEvidence(allEvidence.filter((row) =>
            row.planSlug === clause.planSlug &&
            row.specId === clause.specId &&
            row.specRevision === clause.revision &&
            row.specFingerprint === clause.contentHash,
          )));
          for (const row of allEvidence) {
            if (!selected.has(row) || row.serverMeasurement?.status !== 'measured') continue;
            merged.set(evidenceCurrentInputKey(row.serverMeasurement.current), row.serverMeasurement.current);
          }
          return merged.size > 0 ? [...merged.values()] : undefined;
        })(),
        rerunSelection: {
          workItemIds: args.workItemIds,
          evidenceRefs: args.evidenceRefs,
          bindingIds: args.bindingIds,
          planItemIds: args.planItemIds,
        },
        now,
      }),
    );
    // acceptance-machinery-seam-fixes-2026-09-16 P-001 (R-1): a read whose EVIDENCE COHORT is
    // pinned (workItemIds / evidenceRefs / bindingIds) is a DIAGNOSTIC, not the ship verdict — the ship gate
    // (acceptance-bar-contract-snapshot) grades every binding of a clause unscoped, so a pinned
    // pass 7/0/0 and an unscoped gate 1/7 are BOTH correct readings of different questions.
    // Measured 2026-09-16 on green-gate-zero-wait-convergence-2026-09-08 (WI-10001661 ledger 2).
    // The label rides on the result so the number can never be quoted without its scope.
    const governing = !bindingSelection;
    const governingNote = governing
      ? null
      : 'DIAGNOSTIC READ — the evidence cohort is PINNED (workItemIds/evidenceRefs/bindingIds). The ship gate evaluates every binding of each clause UNSCOPED, so a pass here is not the ship verdict; read plans:get { slug, shipReadiness:true } for the governing per-bar state.';
    const evaluatorBuildDriftNote = evaluatorBuildDrift
      ? 'EVALUATOR BUILD DRIFT — request recorded evaluator ' +
        String(evaluatorBuildDrift.recorded.sha ?? 'unknown') +
        '@' +
        evaluatorBuildDrift.recorded.version +
        '; this draft was computed by live evaluator ' +
        String(evaluatorBuildDrift.live.sha ?? 'unknown') +
        '@' +
        evaluatorBuildDrift.live.version +
        ', not replayed under the recorded build. Compare ratings as cross-build results.'
      : null;
    const scorecardEvidenceNotes = [
      ...(governingNote ? [governingNote] : []),
      ...(evaluatorBuildDriftNote ? [evaluatorBuildDriftNote] : []),
    ];
    const scorecardRows =
      scorecardEvidenceNotes.length > 0
        ? rows.map((row) => ({
            ...row,
            scorecardDraft: {
              ...row.scorecardDraft,
              ratings: Object.fromEntries(
                Object.entries(row.scorecardDraft.ratings).map(([criterion, rating]) => [
                  criterion,
                  {
                    ...rating,
                    evidence: [rating.evidence, ...scorecardEvidenceNotes].join('\n\n'),
                  },
                ]),
              ),
            },
          }))
        : rows;
    return {
      data: {
        ok: true,
        evaluatorBuild: liveEvaluatorBuild,
        ...(evaluatorBuildDrift ? { evaluatorBuildDrift } : {}),
        slug: args.slug,
        harnessSlug,
        classRef: args.classRef,
        rubricRef: 'spec-test-adequacy',
        governing,
        includeDraft: args.includeDraft === true,
        excludedDraftCount: excludedDraftClauses.length,
        excludedDraftSpecIds: excludedDraftClauses.map((clause) => clause.specId),
        excludedClauses,
        ...(governingNote ? { governingNote } : {}),
        ...(isFullDetail(args.detail)
          ? { detail: 'full' as const, rows: scorecardRows }
          : {
              detail: 'summary' as const,
              rows: rows.map(summaryRow),
              fullBody: fullBodyRef('plans:evaluate-spec-test-adequacy', args, [
                'rows[].ratings[].evidence',
                'rows[].evidenceRefs',
                'rows[].scorecardDraft',
              ]),
            }),
        count: rows.length,
        verdicts: {
          pass: rows.filter((row) => row.verdict === 'pass').length,
          fail: rows.filter((row) => row.verdict === 'fail').length,
          unknown: rows.filter((row) => row.verdict === 'unknown').length,
        },
        wouldBlock: rows
          .filter((row) => row.wouldBlock.length > 0)
          .map((row) => ({ specId: row.specId, revision: row.specRevision, criteria: row.wouldBlock })),
        uncoveredWorkItemSelection:
          args.workItemIds && evidenceSpecIds.size === 0
            ? {
                workItemIds: args.workItemIds,
                reason: 'No exact evidence edge exists for the selected work item(s); pass specIds to evaluate intended uncovered clauses.',
              }
            : null,
      },
    };
  },
});
