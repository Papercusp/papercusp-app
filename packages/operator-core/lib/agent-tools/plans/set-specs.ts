/** plans:set-specs — optimistic-CAS append of canonical plan spec revisions. */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { refineEvenWithShapeIssues } from '../_refine-with-shape-issues';
import { resolveEffectiveHarnessSlug } from './_ctx-opts';
import { resolveAgentIdentity } from '../coordination/identity';
import { bulkContent, runBulk } from '../_bulk';
import { ADHOC_WORK_ITEM_SPEC_SCOPE } from './adhoc-spec-scope';
import {
  SPEC_BEHAVIOR_CLASSES,
  SPEC_CAUSAL_PAIRING_MODES,
  SPEC_LIFECYCLE_STATUSES,
  SPEC_PROOF_OBLIGATION_ID_RE,
  listSpecClauses,
  setSpecClause,
} from './spec-clauses-store';

const proofObligationIds = z
  .array(z.string().trim().min(1).max(200).regex(SPEC_PROOF_OBLIGATION_ID_RE))
  .min(1)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length, 'proof obligation ids must be unique');

const specWriteSchema = z
  .object({
    specId: z.string().min(1).max(200).regex(/^\S+$/, 'specId may not contain whitespace'),
    expectedRevision: z.number().int().min(0),
    sourceValId: z
      .string()
      .regex(/^VAL-[A-Za-z0-9._-]+$/)
      .nullable()
      .optional(),
    planItemId: z.string().regex(/^P-\d{3,}$/),
    behavior: z.string().trim().min(1).max(12_000),
    behaviorClass: z.enum(SPEC_BEHAVIOR_CLASSES),
    requiredEvidence: z.array(z.string().trim().min(1).max(1000)).max(100).optional(),
    requiredTestLayers: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
    mutationRequired: z.boolean().optional(),
    lifecycleStatus: z.enum(SPEC_LIFECYCLE_STATUSES),
    supersedes: z
      .object({ specId: z.string().min(1).max(200), revision: z.number().int().positive() })
      .nullable()
      .optional(),
    exemption: z.record(z.string(), z.unknown()).nullable().optional(),
    falsifier: z
      .object({
        observation: z.string().trim().min(1).max(4000),
        probeMethod: z.string().trim().min(1).max(4000).nullable().optional(),
        requiredScenarios: proofObligationIds.nullable().optional(),
        causalPairing: z.enum(SPEC_CAUSAL_PAIRING_MODES).nullable().optional(),
      })
      .nullable()
      .optional()
      .describe(
        'What you would SEE if this clause were violated, how to produce it, and optional immutable scenario/pair completeness obligations for the adequacy evaluator.',
      ),
    acceptanceRef: z.string().trim().min(1).max(1000).nullable().optional(),
    sourceBar: z
      .object({
        barKey: z.string().trim().min(1).max(200),
        barHash: z.string().regex(/^[a-f0-9]{64}$/),
        barSetHash: z.string().regex(/^[a-f0-9]{64}$/),
        rubricSlug: z.string().trim().min(1).max(200),
        rubricRevision: z.number().int().positive(),
        evidencePlane: z.enum(['tree', 'deployed', 'live']),
      })
      .nullable()
      .optional()
      .describe(
        'Acceptance-BAR provenance pin. Preserve this object when promoting an AUTO-BAR draft so the current revision remains mapped to its rubric BAR.',
      ),
  })
  .superRefine((spec, ctx) => {
    if (spec.lifecycleStatus === 'exempt' && !spec.exemption) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['exemption'],
        message: 'lifecycleStatus=exempt requires structured exemption provenance',
      });
    }
    if (spec.lifecycleStatus !== 'exempt' && spec.exemption) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['exemption'],
        message: 'exemption is only valid when lifecycleStatus=exempt',
      });
    }
  });

// RSR-P-008-A: the spec/items rule is reported alongside any shape defect.
const argsSchema = refineEvenWithShapeIssues(
  z.object({
    harness: harnessArg,
    slug: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Plan slug owning every supplied clause. Omit for ad-hoc work-items that belong to no plan; ' +
          'their clauses are authored into the harness-wide ad-hoc spec scope instead.',
      ),
    spec: specWriteSchema.optional().describe('Single-clause shorthand (n=1 of the bulk call).'),
    // P-007's dual-arity seam, spelled the way every sibling bulk verb spells it
    // (plans:add-item / add-decision / audit / get-item …): the heterogeneous
    // "many" half is `items: z.array(…)`. It was `specs:` for the first hour of
    // this tool's life, which is a fourth spelling of a contract that already had
    // three, and bulk-contract-sync's seam detector — the guard that keeps
    // "one call is n=1 of the bulk call" true across ~60 verbs — correctly did
    // not recognise it. Conforming is the fix; widening the detector per tool is
    // how a contract stops being one.
    items: z
      .array(specWriteSchema)
      .min(1)
      .max(200)
      .optional()
      .describe('Append several clause revisions at once — each a full spec write.'),
  }),
  (args, ctx) => {
    if (Boolean(args.spec) !== Boolean(args.items)) return;
    ctx.addIssue({ code: 'custom', path: [], message: 'pass exactly one of `spec` or `items`' });
  },
);

const OK = new Set(['created', 'revised', 'unchanged']);

export default defineTool({
  name: 'plans:set-specs',
  description:
    'Create or append immutable first-class plan spec revisions under expectedRevision CAS. Preserves an optional source VAL alias, verifies plan/item ownership and supersession targets, and refreshes the legacy VAL projection without overwriting its test verdict. Behavior on a sourceBar-pinned acceptance projection is read-only; amend its canonical rubric criterion with rubrics:amend.',
  guidance: {
    when: 'Authoring or revising atomic observable behavior owned by a P-NNN plan item. Use expectedRevision:0 to create; otherwise pass the current revision returned by plans:get-specs.',
    notWhen:
      'Changing a plan-item outcome or dependency — plans:* item verbs. Recording test evidence — testing/coverage tools. Changing the behavior of a sourceBar-pinned AUTO-BAR projection — amend the canonical rubric with rubrics:amend.',
    chaining: 'plans:get-specs → plans:set-specs { expectedRevision } → plans:get-specs exact/history to verify.',
    seeAlso: ['plans:get-specs (current/exact/history read)', 'plans:get-item (owning outcome)'],
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
    const specs = args.items ?? [args.spec!];
    // P-022 / D-018: report the scope the clause ACTUALLY landed in. An omitted `slug`
    // resolves to the ad-hoc scope inside the store, and echoing `slug: undefined` would
    // hide which scope now owns the clause.
    const reportedSlug = args.slug ?? ADHOC_WORK_ITEM_SPEC_SCOPE;
    const currentClauses = args.slug
      ? await listSpecClauses({
          harnessSlug,
          planSlug: args.slug,
          specIds: specs.map((spec) => spec.specId),
        })
      : [];
    const currentById = new Map(currentClauses.map((clause) => [clause.specId, clause]));
    const env = await runBulk(
      specs,
      async (spec) => {
        const current = currentById.get(spec.specId);
        if (
          current &&
          current.currentRevision === spec.expectedRevision &&
          current.sourceBar &&
          current.behavior !== spec.behavior.trim() &&
          spec.lifecycleStatus !== 'superseded' &&
          spec.lifecycleStatus !== 'retired'
        ) {
          return {
            ok: false as const,
            slug: reportedSlug,
            error: 'projected_behavior_readonly',
            specId: spec.specId,
            reason:
              `${spec.specId} behavior is projected from rubric ${current.sourceBar.rubricSlug} BAR ${current.sourceBar.barKey}. ` +
              'Amend the canonical criterion.model/acceptance condition with rubrics:amend; plans:set-specs cannot persist edits to projected behavior.',
          };
        }
        const result = await setSpecClause({
          ...spec,
          ...(args.slug ? { planSlug: args.slug } : {}),
          harnessSlug,
          actorId,
        });
        return OK.has(result.status)
          ? { ok: true as const, slug: reportedSlug, ...result }
          : { ok: false as const, slug: reportedSlug, error: result.status, ...result };
      },
      { keyOf: (spec) => ({ slug: reportedSlug, specId: spec.specId }) },
    );
    return bulkContent(env);
  },
});
