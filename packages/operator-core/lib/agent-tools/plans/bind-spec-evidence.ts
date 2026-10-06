/** plans:bind-spec-evidence — append exact work-item/spec-revision proof bindings. */
import { z } from 'zod';
import { refineEvenWithShapeIssues } from '../_refine-with-shape-issues';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { resolveEffectiveHarnessSlug } from './_ctx-opts';
import { resolveAgentIdentity } from '../coordination/identity';
import { bulkContent, runBulk } from '../_bulk';
import { resolvePlanScope } from './source';
import {
  ADHOC_WORK_ITEM_SPEC_SCOPE,
  bindSpecEvidence,
  evidenceMeasurementSchema,
  MEASUREMENT_PIN_DETAILS_KEY,
  measureAndPinEvidenceForScope,
  retractSpecEvidence,
  SPEC_EVIDENCE_KINDS,
  supersedeSpecEvidenceAtRevision,
} from './spec-evidence-store';
import { isAcceptedMutationTarget, mutationTargetRequirement, supersedeEligibilityGaps } from './spec-test-adequacy';
import { listSpecClauses, SPEC_PROOF_OBLIGATION_ID_RE } from './spec-clauses-store';
import { getAcceptanceRubricVettingStatus } from '../../acceptance-rubric-vetting';
import { getAcceptanceRubricsForPlan } from '../../rubrics';
import { listScorecards } from '../../scorecards';
import { runWithWorkspaceIfConcrete } from '../../workspace-als';
import { unvettedRubricBindAdvisory, VET_BEFORE_PROOF_ORDER } from './bind-vetting-advisory';
import {
  rebindAttestationAdvisory,
  retractionAttestationAdvisory,
  type AttestationAdvisory,
} from './adequacy-attestation-gap';
import {
  expandTestRunBinding,
  testRunBindingSchema,
  type TestRunBindingError,
  type TestRunBindingInput,
} from './bind-from-test-run';

const fingerprint = z.string().trim().min(1).max(256);
const proofCoverageIds = z
  .array(z.string().trim().min(1).max(200).regex(SPEC_PROOF_OBLIGATION_ID_RE))
  .min(1)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length, 'proof coverage ids must be unique');
const coverageRungsSchema = z
  .object({
    l1: z.boolean().optional(),
    l2: z.boolean().optional(),
    l3: z.boolean().optional(),
    l4: z.boolean().optional(),
  })
  .strict();
const adequacyBindingDetailsSchema = z
  .object({
    fixtureCalibrated: z.boolean().optional(),
    falsifiable: z.boolean().optional(),
    testLayer: z.string().optional(),
    pathReachable: z.boolean().optional(),
    oracleIndependent: z.boolean().optional(),
    collected: z.boolean().optional(),
    skipped: z.boolean().optional(),
    executed: z.boolean().optional(),
    outcome: z.string().optional(),
    targeted: z
      .union([z.boolean(), z.string().trim().min(1).max(200).regex(SPEC_PROOF_OBLIGATION_ID_RE)])
      .optional(),
    coverageRungs: coverageRungsSchema.optional(),
    scenarioIds: proofCoverageIds.optional(),
    causalPairIds: proofCoverageIds.optional(),
    provisionalProofBase: z.boolean().optional(),
    disclosedGap: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .passthrough();
// Keep the evaluator's adequacy vocabulary out of the free-form details
// namespace. `spec-test-adequacy` reads these keys only below
// `details.adequacy`; accepting them at the top level creates a successful,
// persisted binding whose metadata is silently inert.
const ADEQUACY_DETAIL_KEYS = new Set([
  'fixtureCalibrated',
  'falsifiable',
  'testLayer',
  'pathReachable',
  'oracleIndependent',
  'collected',
  'skipped',
  'executed',
  'outcome',
  'targeted',
  'coverageRungs',
  'scenarioIds',
  'causalPairIds',
  'provisionalProofBase',
]);
const bindingDetailsSchema = z.record(z.string(), z.unknown()).superRefine((details, ctx) => {
  for (const key of Object.keys(details).filter((candidate) => ADEQUACY_DETAIL_KEYS.has(candidate))) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [key],
      message:
        `adequacy metadata must be nested under details.adequacy.${key}; ` +
        `flat details.${key} is ignored by spec-test-adequacy`,
    });
  }
  if (details.adequacy === undefined) return;
  const parsed = adequacyBindingDetailsSchema.safeParse(details.adequacy);
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['adequacy', ...issue.path],
      message: issue.message,
    });
  }
});
const CAUSAL_PAIR_EVIDENCE_KINDS = new Set([
  'test',
  'coverage-census',
  'mutation',
  'counterexample',
  'check',
  'operational',
]);
export const bindingSchema = z
  .object({
    workItemId: z.string().trim().min(1).max(200),
    specId: z.string().trim().min(1).max(200).optional(),
    sourceValId: z
      .string()
      .regex(/^VAL-[A-Za-z0-9._-]+$/)
      .optional(),
    specRevision: z.number().int().positive().optional(),
    evidenceKind: z.enum(SPEC_EVIDENCE_KINDS),
    evidenceRef: z.string().trim().min(1).max(2000),
    sourceFingerprint: fingerprint
      .optional()
      .describe('Caller-declared fingerprint for opaque evidence. Pass this OR measurement, never both.'),
    testFingerprint: fingerprint.nullable().optional(),
    fixtureFingerprint: fingerprint.nullable().optional(),
    rubricFingerprint: fingerprint.nullable().optional(),
    environmentFingerprint: fingerprint.nullable().optional(),
    coverageEvidenceRef: z.number().int().positive().nullable().optional(),
    testRunId: z.number().int().positive().nullable().optional(),
    measurement: evidenceMeasurementSchema
      .optional()
      .describe(
        "Server-measured basis, discriminated on `kind`: 'repo-files' hashes bounded source/test files; 'work-items' hashes a bounded work-item id set, which is how a NON-CODE outcome reaches source=current. Stores the recipe, so later reads recompute it and a reopened row goes stale.",
      ),
    details: bindingDetailsSchema.optional(),
    observedAt: z.string().datetime({ offset: true }).optional(),
  })
  .refine((b) => Boolean(b.specId) !== Boolean(b.sourceValId), {
    message: 'pass exactly one of specId or sourceValId (legacy coversVALs resolve through sourceValId)',
  })
  .refine((b) => Boolean(b.sourceFingerprint) !== Boolean(b.measurement), {
    message: 'pass exactly one of sourceFingerprint or measurement',
  })
  .refine((b) => !b.measurement || b.testFingerprint === undefined, {
    message: 'testFingerprint is server-computed when measurement is supplied',
  })
  .superRefine((binding, ctx) => {
    if (binding.measurement) {
      for (const field of ['fixtureFingerprint', 'rubricFingerprint', 'environmentFingerprint'] as const) {
        if (binding[field] == null) continue;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message:
            `repo-files measurement cannot independently refresh ${field}; omit it or pass null ` +
            '(record non-repository facts in details.observations without making them a freshness dimension)',
        });
      }
    }
    const adequacy = adequacyBindingDetailsSchema.safeParse(binding.details?.adequacy);
    if (
      adequacy.success &&
      adequacy.data.causalPairIds !== undefined &&
      !CAUSAL_PAIR_EVIDENCE_KINDS.has(binding.evidenceKind)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['details', 'adequacy', 'causalPairIds'],
        message:
          'causalPairIds require executable test/check/coverage/operational proof or mutation/counterexample proof',
      });
    }
  });

/**
 * Withdraw one already-bound piece of evidence (decision D-011).
 *
 * Lives on THIS verb rather than a new one deliberately: retraction is the inverse of
 * binding over the same rows, the same scope resolution and the same bulk envelope, so
 * forking `plans:retract-spec-evidence` would duplicate all of it to express one flag.
 */
const retractionSchema = z.object({
  bindingId: z
    .number()
    .int()
    .positive()
    .describe(
      'The exact binding row id, from plans:get-spec-evidence — never a (workItemId, evidenceRef) pair, which routinely matches several history rows.',
    ),
  reason: z
    .string()
    .trim()
    .min(12)
    .max(2000)
    .describe(
      'Why this proof is withdrawn (e.g. the bound run was never executed). Stored on the row: an unexplained retraction is indistinguishable from the evidence-shedding D-011 forbids.',
    ),
});

/**
 * P-044: an item is EITHER a hand-built binding OR `{ fromTestRun }`, which derives the rest
 * from the recorded run (bind-from-test-run.ts). The run form is tried first because it is
 * strict and keyed on `fromTestRun`, so a hand-built binding never half-matches it.
 */
// The same item contract appears in both the single-binding shorthand and the bulk array.
// Give it an id so Zod publishes it once in $defs and both inputs reference that definition.
const bindingOrTestRunSchema = z
  .union([testRunBindingSchema, bindingSchema])
  .meta({ id: 'PlansBindSpecEvidenceBindingV1' });

function isTestRunBinding(item: object): item is TestRunBindingInput {
  return typeof (item as { fromTestRun?: unknown }).fromTestRun === 'number';
}

type ResolvedBinding =
  | { ok: true; binding: z.infer<typeof bindingSchema>; derived?: Record<string, unknown> }
  | { ok: false; error: TestRunBindingError | 'derived_binding_invalid'; testRunId: number; message: string };

const argsSchema = refineEvenWithShapeIssues(
  z.object({
    harness: harnessArg,
    slug: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Plan owning the referenced spec revisions. Omit for an ad-hoc work-item with no plan — its clauses use the harness-wide ad-hoc spec scope.',
      ),
    binding: bindingOrTestRunSchema.optional().describe('Single-binding shorthand (n=1 of items).'),
    items: z.array(bindingOrTestRunSchema).min(1).max(500).optional(),
    retract: z
      .array(retractionSchema)
      .min(1)
      .max(100)
      .optional()
      .describe('Withdraw already-bound evidence instead of appending it. Mutually exclusive with binding/items.'),
    supersedeAtRevision: z
      .boolean()
      .optional()
      .describe(
        'After binding, retract every OTHER live row of the same evidenceKind at the same clause revision, stamped "superseded by binding N". Only a successful ledger-backed executable binding may supersede; a weaker one is bound but supersedes nothing (reported in supersession).',
      ),
  }),
  // RSR-P-008-A: both combination rules are reported alongside any shape defect.
  (args, ctx) => {
    if ([args.binding, args.items, args.retract].filter(Boolean).length !== 1) {
      ctx.addIssue({ code: 'custom', path: [], message: 'pass exactly one of binding, items or retract' });
    }
    if (args.supersedeAtRevision && args.retract) {
      ctx.addIssue({ code: 'custom', path: [], message: 'supersedeAtRevision applies to binding/items, not retract' });
    }
  },
);

type SupersessionOutcome =
  | {
      bindingId: number;
      status: 'superseded';
      clause: string;
      evidenceKind: string;
      retracted: Array<{ bindingId: number; workItemId: string; evidenceRef: string }>;
    }
  | { bindingId: number; status: 'refused'; clause: string; reason: string };

/**
 * P-019 (review-system-rework-reduction-2026-09-23): `supersedeAtRevision:true`. The adequacy
 * evaluator grades EVERY live binding at a clause revision, so fresh sufficient proof could not
 * rescue a clause while an older weak/stale/failing row stood beside it (R-11: 13 rows retracted
 * by hand before a targeted mutation proof could pass). Each successfully bound row that is
 * itself sufficient retracts its same-kind siblings; rows bound in this call are never retracted
 * by each other. Runs after the binds commit, so a failure leaves old rows live, never lost.
 */
async function supersedeSiblings(input: {
  bindings: ReadonlyArray<z.infer<typeof bindingSchema> | undefined>;
  results: ReadonlyArray<unknown>;
  harnessSlug: string | undefined;
  actorId: string;
}): Promise<SupersessionOutcome[]> {
  const bound = input.results.map((result) => {
    const row = result as { ok?: unknown; id?: unknown; planSlug?: unknown; specId?: unknown; specRevision?: unknown };
    return row.ok === true &&
      typeof row.id === 'number' &&
      typeof row.planSlug === 'string' &&
      typeof row.specId === 'string' &&
      typeof row.specRevision === 'number'
      ? { id: row.id, planSlug: row.planSlug, specId: row.specId, specRevision: row.specRevision }
      : null;
  });
  const keepBindingIds = bound.flatMap((row) => (row ? [row.id] : []));
  const outcomes: SupersessionOutcome[] = [];
  for (const [index, row] of bound.entries()) {
    const declared = input.bindings[index];
    if (!row || !declared) continue;
    const clause = `${row.specId}@${row.specRevision}`;
    const gaps = supersedeEligibilityGaps({
      evidenceKind: declared.evidenceKind,
      testRunId: declared.testRunId,
      coverageEvidenceRef: declared.coverageEvidenceRef,
      details: declared.details,
    });
    if (gaps.length > 0) {
      outcomes.push({
        bindingId: row.id,
        status: 'refused',
        clause,
        reason: `binding ${row.id} is bound but is not sufficient proof on its own, so it supersedes nothing: ${gaps.join(', ')}`,
      });
      continue;
    }
    const retracted = await supersedeSpecEvidenceAtRevision({
      harnessSlug: input.harnessSlug,
      planSlug: row.planSlug,
      specId: row.specId,
      specRevision: row.specRevision,
      evidenceKind: declared.evidenceKind,
      supersedingBindingId: row.id,
      keepBindingIds,
      actorId: input.actorId,
    });
    outcomes.push({
      bindingId: row.id,
      status: 'superseded',
      clause,
      evidenceKind: declared.evidenceKind,
      retracted: retracted.map((r) => ({
        bindingId: Number(r.id),
        workItemId: r.work_item_id,
        evidenceRef: r.evidence_ref,
      })),
    });
  }
  return outcomes;
}

export interface MutationTargetRefusal {
  clause: string;
  targeted: unknown;
  acceptedTargets: string[];
  reason: string;
  correctedCall: { tool: 'plans:bind-spec-evidence'; args: Record<string, unknown> };
}

/**
 * P-043 (review-system-rework-reduction-2026-09-23): judge falsifiability TARGETING at bind time
 * with the evaluator's own rule (`mutationTargetRequirement`), so a mutation/counterexample
 * binding the evaluator will reject is refused here instead of being accepted, proven, audited,
 * and only then refused at completion (the measured case: proof 11:54Z, audit 12:08Z, completion
 * refused 12:11Z, re-emitted and re-audited on unchanged evidence, closed 12:38Z). Every
 * mutation/counterexample binding feeds that criterion and falsifiability has no not-applicable
 * branch, so a mis-targeted one can never help it. The rule is moved earlier, never lowered.
 * Legacy `sourceValId` bindings and unknown specs fall through to the store, which owns those
 * refusals.
 */
export async function mutationTargetingRefusal(
  binding: z.infer<typeof bindingSchema>,
  scope: { planSlug: string; harnessSlug: string | undefined; slugArg?: string; harnessArg?: string },
  loadClauses: typeof listSpecClauses = listSpecClauses,
): Promise<MutationTargetRefusal | null> {
  if ((binding.evidenceKind !== 'mutation' && binding.evidenceKind !== 'counterexample') || !binding.specId) return null;
  const [clause] = await loadClauses({
    harnessSlug: scope.harnessSlug,
    planSlug: scope.planSlug,
    specIds: [binding.specId],
    ...(binding.specRevision !== undefined ? { revision: binding.specRevision } : {}),
    limit: 1,
  });
  if (!clause) return null;
  const adequacy =
    binding.details?.adequacy && typeof binding.details.adequacy === 'object' && !Array.isArray(binding.details.adequacy)
      ? (binding.details.adequacy as Record<string, unknown>)
      : {};
  if (isAcceptedMutationTarget(clause, adequacy.targeted)) return null;
  const { acceptedTargets, requirement } = mutationTargetRequirement(clause);
  const label = `${clause.specId}@${clause.revision}`;
  const given =
    adequacy.targeted === undefined ? 'no adequacy.targeted' : `adequacy.targeted = ${JSON.stringify(adequacy.targeted)}`;
  return {
    clause: label,
    targeted: adequacy.targeted ?? null,
    acceptedTargets,
    reason:
      `${label}: this ${binding.evidenceKind} binding carries ${given}, which plans:evaluate-spec-test-adequacy ` +
      `would reject for falsifiability — it requires ${requirement}; a boolean or sibling-case target never ` +
      `qualifies. Accepted: ${acceptedTargets.join(', ')}.`,
    correctedCall: {
      tool: 'plans:bind-spec-evidence',
      args: {
        ...(scope.harnessArg ? { harness: scope.harnessArg } : {}),
        ...(scope.slugArg ? { slug: scope.slugArg } : {}),
        binding: {
          ...binding,
          details: { ...(binding.details ?? {}), adequacy: { ...adequacy, targeted: acceptedTargets[0] } },
        },
      },
    },
  };
}

const OK = new Set(['created', 'unchanged']);

/**
 * The attestation advisories are a READ after the write has committed; a failure to compute
 * one must never turn a successful bind/retract into an error. It degrades to a visible
 * "could not check" advisory instead of silence, so an absent warning still means "checked".
 */
async function attestationAdvisorySafely(
  compute: () => Promise<AttestationAdvisory | null>,
): Promise<AttestationAdvisory | { code: 'adequacy_attestation_unchecked'; message: string } | null> {
  try {
    return await compute();
  } catch (error) {
    return {
      code: 'adequacy_attestation_unchecked',
      message: `Could not check whether this call dropped design attestations (EI-24903278232142036): ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export default defineTool({
  name: 'plans:bind-spec-evidence',
  description:
    'Bind tests, fixtures, coverage-census rows, mutations/counterexamples, checks, manual proof, or operational evidence to an exact immutable spec revision and work item. Repository-backed evidence may pass measurement so the server hashes and later re-measures bounded source/test file sets; opaque evidence passes sourceFingerprint and remains caller-attested. Legacy coversVALs are accepted as sourceValId aliases. Exact replays are idempotent; changed fingerprints append history. The retract op withdraws a bound row by id with a required reason — stamped, never deleted, and excluded from default reads.',
  guidance: {
    when: `Recording execution proof for one or more plan specs before work-item completion or plan acceptance. AUTO-BAR proof: vet first (${VET_BEFORE_PROOF_ORDER}).`,
    notWhen: 'Authoring behavior — plans:set-specs. Running a test — testing:run.',
    chaining: 'plans:get-specs → plans:bind-spec-evidence → plans:get-spec-evidence with current fingerprints.',
    seeAlso: ['plans:get-spec-evidence (inspect proof/currentness)', 'plans:get-specs (resolve exact revisions)'],
  },
  capability: 'plans:write',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const sctx = harnessScopedCtx(args.harness, ctx);
    const harnessSlug = resolveEffectiveHarnessSlug(sctx);
    const actorId = resolveAgentIdentity(ctx).ownerId;
    if (args.retract) {
      const retractions = await runBulk(
        args.retract,
        async (item) => {
          const result = await retractSpecEvidence({
            harnessSlug,
            bindingId: item.bindingId,
            reason: item.reason,
            actorId,
          });
          // already_retracted is a SUCCESS: the repair is idempotent, so replaying it
          // must not read as a failure. Only a binding that does not exist in this
          // scope is an error — that means the caller targeted the wrong row.
          return result.status === 'not_found'
            ? { ok: false as const, error: 'not_found' as const, ...result }
            : { ok: true as const, ...result };
        },
        { keyOf: (item) => ({ bindingId: item.bindingId }) },
      );
      // EI-24903278232142036: name any design attestation this retraction removed from its
      // clause's LAST live carrier — the silent pass→unknown flip a freshness repair causes.
      const lost = await attestationAdvisorySafely(() =>
        retractionAttestationAdvisory(
          harnessSlug,
          retractions.results.flatMap((result) =>
            result.ok && result.status === 'retracted' && result.binding
              ? [
                  {
                    id: Number(result.binding.id),
                    planSlug: result.binding.plan_slug,
                    specId: result.binding.spec_id,
                    specRevision: Number(result.binding.spec_revision),
                  },
                ]
              : [],
          ),
        ),
      );
      return bulkContent({ ...retractions, ...(lost ? { advisories: [lost] } : {}) });
    }
    const requested = args.items ?? [args.binding!];
    // P-044: expand every `{ fromTestRun }` item into an ordinary binding FIRST, then re-validate
    // it through bindingSchema, so a derived binding meets exactly the contract a hand-built one
    // does (including the P-043 targeting check below). A failed expansion stays index-aligned
    // and is reported in the bulk envelope like any other refused item.
    const runScope = requested.some(isTestRunBinding) ? await resolvePlanScope({ harnessSlug }) : null;
    const resolved: ResolvedBinding[] = await Promise.all(
      requested.map(async (item): Promise<ResolvedBinding> => {
        if (!isTestRunBinding(item)) return { ok: true, binding: item };
        const expansion = await expandTestRunBinding(item, runScope!);
        if (!expansion.ok) return expansion;
        const parsed = bindingSchema.safeParse(expansion.binding);
        if (!parsed.success) {
          return {
            ok: false,
            error: 'derived_binding_invalid',
            testRunId: item.fromTestRun,
            message: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
          };
        }
        return {
          ok: true,
          binding: parsed.data,
          derived: {
            testRunId: expansion.binding.testRunId,
            evidenceKind: expansion.binding.evidenceKind,
            evidenceRef: expansion.binding.evidenceRef,
            measurement: expansion.binding.measurement,
            harnessAttribution: expansion.attribution,
          },
        };
      }),
    );
    const bindings = resolved.map((entry) => (entry.ok ? entry.binding : undefined));
    const measurementScope = bindings.some((binding) => binding?.measurement)
      ? await resolvePlanScope({ harnessSlug })
      : null;
    // P-022 / D-018: report the scope the binding ACTUALLY landed in, not the argument the
    // caller passed. An omitted `slug` resolves to the ad-hoc scope inside the store, and a
    // result echoing `slug: undefined` would hide which scope now owns the evidence.
    const reportedSlug = args.slug ?? ADHOC_WORK_ITEM_SPEC_SCOPE;
    const env = await runBulk(
      resolved,
      async (entry) => {
        if (!entry.ok) {
          const { error, testRunId, message } = entry;
          return { ok: false as const, slug: reportedSlug, error, fromTestRun: testRunId, message };
        }
        const { binding } = entry;
        const derived = entry.derived ? { derivedFromTestRun: entry.derived } : {};
        const targetingRefusal = await mutationTargetingRefusal(binding, {
          planSlug: args.slug ?? ADHOC_WORK_ITEM_SPEC_SCOPE,
          harnessSlug,
          ...(args.slug ? { slugArg: args.slug } : {}),
          ...(args.harness ? { harnessArg: args.harness } : {}),
        });
        if (targetingRefusal) {
          return {
            ok: false as const,
            slug: reportedSlug,
            error: 'mutation_target_rejected' as const,
            ...derived,
            ...targetingRefusal,
          };
        }
        const measured = binding.measurement
          ? await measureAndPinEvidenceForScope(measurementScope!.workspaceId, harnessSlug, binding.measurement)
          : null;
        const { measurement, ...declared } = binding;
        const result = await bindSpecEvidence({
          ...declared,
          sourceFingerprint: measured?.sourceFingerprint ?? binding.sourceFingerprint!,
          ...(measured ? { testFingerprint: measured.testFingerprint } : {}),
          ...(measurement
            ? {
                details: {
                  ...(binding.details ?? {}),
                  currentMeasurement: measurement,
                  // P-018: the commit this proof was measured against, so a later stale
                  // verdict names the moved paths. Excluded from the binding fingerprint.
                  ...(measured?.pin ? { [MEASUREMENT_PIN_DETAILS_KEY]: measured.pin } : {}),
                },
              }
            : {}),
          ...(args.slug ? { planSlug: args.slug } : {}),
          harnessSlug,
          actorId,
        });
        return OK.has(result.status)
          ? { ok: true as const, slug: reportedSlug, ...derived, ...result }
          : { ok: false as const, slug: reportedSlug, error: result.status, ...derived, ...result };
      },
      {
        keyOf: (entry) =>
          entry.ok
            ? { slug: reportedSlug, workItemId: entry.binding.workItemId, evidenceRef: entry.binding.evidenceRef }
            : { slug: reportedSlug, fromTestRun: entry.testRunId },
      },
    );
    // P-004 (review-system-rework-reduction-2026-09-23): vet before proof. Advisory only —
    // the bindings above are already written; this names the cheaper order when BAR proof
    // lands on a rubric revision nobody has vetted yet. Computed only for bindings that
    // actually succeeded, so a refused binding never triggers it.
    const boundSpecIds = env.results.flatMap((result, index) => (result.ok ? [bindings[index]?.specId] : []));
    const workspaceId = resolveAgentIdentity(ctx).workspaceId ?? undefined;
    const advisory = await runWithWorkspaceIfConcrete(workspaceId, () =>
      unvettedRubricBindAdvisory(
        { planSlug: args.slug, harnessSlug, specIds: boundSpecIds },
        {
          getAcceptanceRubricsForPlan: (planSlug, options) => getAcceptanceRubricsForPlan(planSlug, options),
          readVettingStatus: (rubric) => getAcceptanceRubricVettingStatus(rubric, { listScorecards }),
        },
      ),
    );
    // EI-24903278232142036: computed BEFORE supersession, while the siblings that still carry
    // the attestations are live — supersession would retract them and hide the gap.
    const gap = await attestationAdvisorySafely(() =>
      rebindAttestationAdvisory(
        harnessSlug,
        env.results.flatMap((result, index) => {
          const binding = bindings[index];
          if (!result.ok || !binding || typeof (result as { id?: unknown }).id !== 'number') return [];
          const stored = result as unknown as { id: number; planSlug: string; specId: string; specRevision: number };
          return [
            {
              id: stored.id,
              planSlug: stored.planSlug,
              specId: stored.specId,
              specRevision: stored.specRevision,
              evidenceKind: binding.evidenceKind,
              evidenceRef: binding.evidenceRef,
              adequacy: (binding.details as { adequacy?: unknown } | undefined)?.adequacy,
            },
          ];
        }),
      ),
    );
    const supersession = args.supersedeAtRevision
      ? await supersedeSiblings({ bindings, results: env.results, harnessSlug, actorId })
      : undefined;
    const advisories = [advisory, gap].filter(Boolean);
    return bulkContent({
      ...env,
      ...(advisories.length > 0 ? { advisories } : {}),
      ...(supersession ? { supersession } : {}),
    });
  },
});
