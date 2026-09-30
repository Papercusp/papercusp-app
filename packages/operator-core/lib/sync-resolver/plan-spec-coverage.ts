import { z } from 'zod';

/**
 * P-011 — the READ surface for a plan's spec-coverage census.
 *
 * P-008 shipped `evaluatePlanSpecCoverageGate`: a census of the plan's CURRENT clauses
 * (lifecycle partition, coverage, adequacy scorecards at the revision-pinned subject
 * ref, D-016 falsifier counts) wired into `evaluatePlanAcceptanceGate` as a CODE-TRUTH
 * check. But that verdict was reachable only by ATTEMPTING A SHIP: a human could see
 * THAT `plans:set-status` refused and never WHICH clauses are uncovered, at WHICH
 * revision, or that a report existed at all while the plan was still green.
 *
 * This runs the SAME `evaluatePlanSpecCoverageGate` the ship path calls, so the panel
 * cannot drift from what the gate enforces — the identical relationship slice 1
 * established between `workItems.behaviorContract` and the completion gate.
 *
 * ⚠ WHAT THE UI MUST NOT DO WITH THIS (D-018, restated at the read surface because this
 * is where a renderer will reach for it). The gate reports far more than it refuses, and
 * exactly ONE finding is a failure:
 *
 *   · `code:'spec_proof_stale'` — the ONLY refusal. A clause with evidence, but none at
 *     its current revision. Render as a failure.
 *   · `reports[]` — unproven clauses, ungraded adequacy, undeclared falsifiers. These
 *     are ADVISORY and never refuse. D-013/D-017 give the uncovered-clause refusal to
 *     P-013; rendering one as an error shows a human a blocking failure for a clause no
 *     gate is currently blocking on, and pre-empts a decision P-013 owns.
 *   · `code:'spec_coverage_unavailable'` — a read failure that DELIBERATELY fails open.
 *     It is a degradation notice, not a refusal.
 *
 * BOUNDEDNESS IS PART OF THE CONTRACT, not a detail (D-018). The census pins its own
 * limit independently of any caller, and a truncated census makes every count a FLOOR —
 * at which point the gate degrades the whole verdict to report-only rather than refuse
 * on a number that may simply have fallen off the end of the read. `bounded` rides on
 * the aggregate for exactly that reason, so a renderer that shows the counts is obliged
 * to show the truncation beside them. A floor displayed as a total is the defect.
 *
 * WHY `mode` IS CARRIED VERBATIM. 'enforced' vs 'report-only' is the gate's own
 * statement about whether it is currently able to refuse. Deriving that in the renderer
 * from `satisfied`/`code` would re-implement — and eventually contradict — the ruling in
 * D-018. The renderer reads it; it never recomputes it.
 *
 * DELIBERATELY LAZY, like workItems.behaviorContract and workItems.priorAttempts: this
 * is a multi-table census (clauses, then evidence, then scorecards), so the consumer
 * gates it with `useSyncQuery({ enabled })` and nothing runs until a human opens the
 * section.
 */
export const planSpecCoverageArgsSchema = z.object({
  // `.default('default')` matches every other workspace-scoped entry in this registry;
  // the client omits it and the single-tenant desktop build resolves to 'default'.
  // NOTE: the census itself resolves workspace through `resolvePlanScope(harnessSlug)`
  // rather than taking it as an argument, so this rides for registry consistency and to
  // key the subscription — it is not threaded into the read.
  workspaceId: z.string().default('default'),
  harnessSlug: z.string().min(1).optional(),
  planSlug: z.string().min(1),
});

export type PlanSpecCoverageArgs = z.infer<typeof planSpecCoverageArgsSchema>;

/** One clause whose only proof is against a promise the author already superseded. */
export interface PlanSpecCoverageStaleClauseView {
  specId: string;
  planItemId: string;
  currentRevision: number;
  provenRevisions: number[];
}

export interface PlanSpecCoverageRow {
  planSlug: string;
  /** False ⇒ the plan adopted no first-class clauses, so the gate has nothing to say. */
  applicable: boolean;
  /** The gate's OWN statement of whether it can currently refuse. Never re-derived. */
  mode: 'report-only' | 'enforced';
  satisfied: boolean;
  /**
   * The census's own code. ⚠ Do NOT read this to decide whether the panel shows a
   * blocker — read `satisfied`/`mode`. P-013 added a second refusing code
   * (`spec_clause_unproven`), and any consumer that had enumerated the failing codes by
   * hand silently kept rendering the new refusal as advisory.
   */
  code: 'spec_proof_stale' | 'spec_clause_unproven' | 'spec_coverage_unavailable' | null;
  message: string | null;
  /** Conditions that DID refuse, or WOULD were the gate enforcing. */
  wouldBlock: string[];
  /** ADVISORY findings. Never render as failures (D-018). */
  reports: string[];
  clauses: {
    total: number;
    enforceable: number;
    exempt: number;
    draft: number;
    inactive: number;
    /** D-016: how many enforceable clauses declare what would falsify them. */
    falsifierDeclared: number;
  } | null;
  coverage: {
    proven: number;
    staleProof: number;
    unproven: number;
    staleProofClauses: PlanSpecCoverageStaleClauseView[];
    unprovenSpecIds: string[];
  } | null;
  adequacy: { graded: number; ungraded: number; ungradedSpecIds: string[] } | null;
  /** Truncation rides beside the counts so a floor cannot be read as a total. */
  bounded: {
    evidenceCensusLimit: number;
    evidenceRowsRead: number;
    truncatedByLimit: boolean;
    adequacyClauseLimit: number;
    adequacyTruncatedByLimit: boolean;
  } | null;
  /** Distinguishes "the census could not run" from "the census found nothing". */
  unavailableReason: 'resolver-unavailable' | null;
}

export async function resolvePlanSpecCoverage(args: PlanSpecCoverageArgs): Promise<unknown[]> {
  const { harnessSlug, planSlug } = args;

  const unavailable = (message: string): PlanSpecCoverageRow[] => [
    {
      planSlug,
      applicable: false,
      mode: 'report-only',
      satisfied: true,
      code: 'spec_coverage_unavailable',
      message,
      wouldBlock: [],
      reports: ['spec-coverage-read-unavailable'],
      clauses: null,
      coverage: null,
      adequacy: null,
      bounded: null,
      unavailableReason: 'resolver-unavailable',
    },
  ];

  let verdict;
  try {
    const mod = await import('../agent-tools/plans/plan-spec-coverage-gate');
    verdict = await mod.evaluatePlanSpecCoverageGate({ harnessSlug, planSlug });
  } catch (error) {
    // The gate already fails open on a READ error and returns a verdict. Reaching here
    // means the gate module itself could not be loaded/run — a different fact, and one
    // that must stay distinguishable from "censused, found nothing".
    return unavailable(
      `Spec-coverage census unavailable for plan '${planSlug}' ` +
        `(${error instanceof Error ? error.message : String(error)}).`,
    );
  }

  const aggregate = verdict.aggregate;

  return [
    {
      planSlug: verdict.planSlug,
      applicable: verdict.applicable,
      mode: verdict.mode,
      satisfied: verdict.satisfied,
      code: verdict.code ?? null,
      message: verdict.message ?? null,
      wouldBlock: verdict.wouldBlock,
      reports: verdict.reports,
      clauses: aggregate
        ? {
            total: aggregate.clauses.total,
            enforceable: aggregate.clauses.enforceable,
            exempt: aggregate.clauses.exempt,
            draft: aggregate.clauses.draft,
            inactive: aggregate.clauses.inactive,
            falsifierDeclared: aggregate.clauses.falsifierDeclared,
          }
        : null,
      coverage: aggregate
        ? {
            proven: aggregate.coverage.proven,
            staleProof: aggregate.coverage.staleProof,
            unproven: aggregate.coverage.unproven,
            staleProofClauses: aggregate.coverage.staleProofClauses.map((c) => ({
              specId: c.specId,
              planItemId: c.planItemId,
              currentRevision: c.currentRevision,
              provenRevisions: c.provenRevisions,
            })),
            unprovenSpecIds: aggregate.coverage.unprovenSpecIds,
          }
        : null,
      adequacy: aggregate
        ? {
            graded: aggregate.adequacy.graded,
            ungraded: aggregate.adequacy.ungraded,
            ungradedSpecIds: aggregate.adequacy.ungradedSpecIds,
          }
        : null,
      bounded: aggregate ? { ...aggregate.bounded } : null,
      unavailableReason: null,
    } satisfies PlanSpecCoverageRow,
  ];
}
