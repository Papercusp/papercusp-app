/**
 * rubrics:propose — propose (idempotent upsert) a rubric → status "proposed"
 * (rubric-driven-observations-2026-06-20 P-002 / D-001). Any agent may propose; an
 * independent reviewer or owner/su ratifies it active (rubrics:ratify). Re-proposing the
 * same rubric_id updates its content.
 */
import { z } from 'zod';
import { refineEvenWithShapeIssues } from '../_refine-with-shape-issues';
import { defineTool } from '@papercusp/agent-mcp';
import { hardText, LIMITS } from '../limits';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { proposeRubric, rubricCompleteness } from '../../rubrics';
import { validateRubricReplicationSql } from '../../rubrics-replication-sql';
import {
  rubricCriterionWindowSchema,
  rubricCriterionCheckSchema,
  acceptanceCriterionRoleSchema,
  acceptanceBarProvenanceSchema,
  acceptancePassRatingsError,
  acceptancePassRatingsSchema,
  acceptanceEvidencePlaneSchema,
  requirementIntentSchema,
  requirementAcceptanceSchema,
  requirementVerificationSchema,
  RUBRIC_GRADING_AUTHORITIES,
} from '../plans/rubric-template';
import { normalizeRequirementSections } from '../../requirement-contract';
import { VALID_PLAN_SLUG } from '../plans/source';
import { resolveAgentWorkspaceRoot } from '../capability/base-dir';
import { trackDetached } from '../../detached-imports';
import { lintAcceptanceCriterionMethods } from '../../rubrics-method-lint';
import { runtimeVettingFindings } from '../../acceptance-runtime-citation';

const driftMarkers = z
  .string()
  .min(1)
  .describe(
    'what degraded / broken looks like — the concrete falsifier. REQUIRED and non-empty for every bespoke criterion of BOTH kinds (standard AND acceptance); an acceptance rubric may only omit criteria entirely, via classRef with an empty criteria array (plan D-009)',
  );

const criterionFields = {
  key: z.string().min(1).describe('stable kebab id; an observation rating references this'),
  title: z.string().min(1),
  intent: requirementIntentSchema.optional(),
  acceptance: requirementAcceptanceSchema.optional(),
  verification: requirementVerificationSchema.optional(),
  requiredTestLayers: requirementAcceptanceSchema.shape.requiredTestLayers,
  model: z
    .string()
    .min(1)
    .optional()
    .describe(
      'how this criterion is supposed to work (the MODEL). REQUIRED for a standard-kind rubric; optional on an acceptance-kind criterion only when the title, non-empty driftMarkers, and concrete verification check/procedure carry the outcome semantics the meta-acceptance-rubric vets',
    ),
  bar: z
    .string()
    .min(1)
    .optional()
    .describe(
      'acceptance-kind only: clearer wire/UI alias for model. It is canonicalized into model and never stored as a second text field; if both are supplied they must match after trimming',
    ),
  barKey: z
    .string()
    .min(1)
    .optional()
    .describe('acceptance-kind only: stable BAR identity, normally the source R-N key'),
  barHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional()
    .describe(
      'read-back compatibility only: the server ignores this value and recomputes barHash from canonical meaning on every write',
    ),
  role: acceptanceCriterionRoleSchema
    .optional()
    .describe("acceptance-kind only: 'outcome' is gradeable truth; 'disclosure' can report but never satisfy it"),
  mandatory: z
    .boolean()
    .optional()
    .describe('acceptance-kind only: include this outcome in the non-waivable ship floor'),
  requiredScope: z
    .array(z.string().min(1))
    .min(1)
    .max(200)
    .optional()
    .describe('acceptance-kind only: stable surface/cohort/subject tokens the BAR must cover'),
  evidencePlane: acceptanceEvidencePlaneSchema
    .optional()
    .describe('acceptance BAR required proof plane: tree, deployed, or live; preserved through METHOD-only updates'),
  passRatings: acceptancePassRatingsSchema,
  coversBarKeys: z
    .array(z.string().min(1))
    .min(1)
    .max(200)
    .optional()
    .describe('acceptance disclosure only: outcome BAR keys this criterion reports on'),
  barProvenance: acceptanceBarProvenanceSchema
    .optional()
    .describe('acceptance-kind only: pre-implementation declaration or honest legacy-backfill provenance'),
  method: z
    .string()
    .min(1)
    .optional()
    .describe(
      'how to investigate it (signals / queries — the METHOD). REQUIRED for standard kind; optional on acceptance-kind criteria only when a concrete check/procedure makes the outcome independently falsifiable',
    ),
  ratingScale: z.array(z.string()).optional().describe('per-criterion override of the rubric default scale'),
  driftMarkers: driftMarkers.optional(),
  replication: z
    .string()
    .min(1)
    .optional()
    .describe(
      "this criterion's own REPLICATION DRILL: the full copy-runnable testing procedure (fixtures → verbatim subject prompt → spawn/measurement → grading queries → cleanup). Every criterion SHOULD carry one — rubrics:ratify reports the ones that don't",
    ),
  instrumentKey: z
    .string()
    .min(1)
    .optional()
    .describe("stable machine-readable instrument binding; use 'none' only for an explicitly manual criterion"),
  window: rubricCriterionWindowSchema.optional(),
  criterionClass: z
    .enum(['settle-once', 'violatable'])
    .optional()
    .describe(
      "grading class (P-008): 'violatable' = monotonic-downward, one violation falsifies permanently — mid-run ratings are stamped PROVISIONAL by scorecards:emit until the graded subject terminates. Omitted = settle-once",
    ),
  check: rubricCriterionCheckSchema
    .optional()
    .describe(
      "the criterion's STRUCTURED CHECK (P-011 / D-006), preferred wherever the outcome is objectively checkable: " +
        "kind:'tests' { files:[...] } = deterministic must-pass — paths must resolve against the live tree or " +
        'THIS PROPOSE IS REFUSED, and scorecards:emit actually RUNS the files at grading time (a contradicted ' +
        "pass-rating refuses the emit); kind:'instrument' { instrumentKey } = the generalized instrument binding. " +
        'Omitted = fuzzy judgment criterion; for an acceptance rubric with bespoke criteria, AT LEAST ONE criterion must carry a structured check (and every objectively checkable outcome should carry its own); ' +
        'when revising, intentionally removing a stored check requires allowMethodShrink:true plus shrinkReason',
    ),
};

// `superRefine` below enforces the kind-specific profile at runtime, but Zod
// cannot project a super-refinement into JSON Schema. Keep the wire contract
// honest at the generated schema boundary with a representable union: every
// criterion must carry either the canonical direct falsifier or the unified
// acceptance.falsifier alias. The acceptance branch is deliberately allowed to
// omit direct driftMarkers because normalizeRequirementSections canonicalizes
// that alias before proposeRubric persists the criterion.
const criterion = z
  .union([
    z.object({ ...criterionFields, driftMarkers }),
    z.object({ ...criterionFields, acceptance: requirementAcceptanceSchema }),
  ])
  .superRefine((input, ctx) => {
    try {
      const normalized = normalizeRequirementSections(input);
      const passRatingsError = acceptancePassRatingsError(normalized);
      if (passRatingsError) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['passRatings'], message: passRatingsError });
      }
    } catch (error) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: String(error) });
    }
  });

// RSR-P-008-A: the kind-profile rules are reported alongside any shape defect.
export const rubricsProposeArgs = refineEvenWithShapeIssues(
  z.object({
    rubricRef: z
      .string()
      .min(1)
      .max(120)
      .regex(VALID_PLAN_SLUG, 'must be a valid plan slug (letters, numbers, ., _, -; optional @run-N suffix)')
      .describe('rubric ref/slug stored as a plan slug, e.g. "pot-coordination-health"'),
    kind: z
      .enum(['standard', 'acceptance'])
      .optional()
      .describe(
        "default 'standard' (a reusable shared-standards library rubric — proposed, then Queen-ratified). 'acceptance' = a one-shot definition-of-done linked by subjectPlan (plan mode) or subjectGoal (goal mode), activates IMMEDIATELY (no ratification), is hidden from default library reads, and is authored AFTER the work's implementation, before it may be marked done — the matching completion gate reads it",
      ),
    subjectHarnessSlug: z.string().trim().min(1).optional().describe(
      'Harness of subjectPlan. Omit when its slug resolves uniquely; required when the slug exists in several harnesses.',
    ),
    subjectPlan: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        'acceptance kind only (required there): the slug of the plan this rubric is the definition-of-done FOR. Validated to exist — a dangling link is refused',
      ),
    subjectGoal: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        'acceptance kind only: the id of the goal this rubric is the definition-of-done FOR. Validated to exist — a dangling link is refused',
      ),
    classRef: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe(
        'acceptance kind only: rubricId of the standard-kind CLASS rubric this builds on (feature-ship / bugfix / migration / investigation). With classRef, criteria may be empty (the class alone may stand for e.g. investigation-only plans)',
      ),
    composes: z
      .array(z.string().trim().min(1))
      .min(1)
      .max(16)
      .optional()
      .describe(
        'unpinned composition refs: reusable standard-kind rubrics this rubric composes; each ref is resolved at write time and each rubric evolves independently (omit revision pins)',
      ),
    characteristic: z.string().min(1).max(120).describe('umbrella domain, e.g. "hive-coordination"'),
    title: hardText(LIMITS.SHORT_TITLE),
    description: hardText(8000).optional(),
    criteria: z
      .array(criterion)
      .describe(
        "the gradeable items. Standard kind: >=1 required, each with full model/method/driftMarkers. Acceptance kind: 3–7 outcome criteria tracing to the plan's goal + Decisions (may be empty with classRef)",
      ),
    ratingScale: z
      .array(z.string())
      .optional()
      .describe(
        'optional default scale shared by criteria. When omitted, the server uses the existing rubric/class scale when revising or composing, otherwise ["healthy","degraded","broken","unknown"]. For acceptance rubrics, the effective scale is normalized before authoring: if it lacks an unknown-equivalent label, the server appends "unknown" so every persisted acceptance rubric can represent an honest no-verdict outcome; callers may omit this field or supply only domain-specific ratings.',
      ),
    methodRef: z
      .string()
      .max(200)
      .nullable()
      .optional()
      .describe('agent-insights runbook slug for the long-form method; null is accepted from rubrics:get when unset'),
    gradingAuthority: z
      .enum(RUBRIC_GRADING_AUTHORITIES)
      .optional()
      .describe(
        "who may grade the plan this rubric governs. 'independent' (the DEFAULT when omitted, and the fail-closed one) requires a lineage-independent non-implementer to file the grading; 'owner-authorized' ALSO admits an owner-filed grading, for a plan the owner drove themselves and that an independence-only gate could therefore never satisfy. It never removes the independent route",
      ),
    releaseGating: z
      .boolean()
      .optional()
      .describe(
        'mark this standard-kind rubric as a release gate; acceptance-kind rubrics are one-shot and cannot set releaseGating; every standard criterion then requires a unique machine-readable instrument binding',
      ),
    stalenessWatched: z
      .boolean()
      .optional()
      .describe(
        'mark this standard-kind rubric as staleness-watched without gating a release; acceptance-kind rubrics are one-shot and watchdog-exempt',
      ),
    dropKeys: z
      .array(z.string().min(1))
      .max(100)
      .optional()
      .describe(
        'loss-guard ack: stored criterion keys this proposal INTENTIONALLY drops. Propose is a whole-document replace — omitting a stored key without acking it here is rejected (it would silently delete the criterion)',
      ),
    allowMethodShrink: z
      .boolean()
      .optional()
      .describe(
        "loss-guard ack: allow a criterion's method+replication procedure text to shrink >40%, lose its REPLICATION DRILL marker, or intentionally remove its stored structured check (reverting deterministic enforcement to fuzzy judgment). Requires shrinkReason",
      ),
    shrinkReason: z
      .string()
      .min(1)
      .max(2000)
      .optional()
      .describe(
        'why the procedure shrink or structured-check removal is intentional (required with allowMethodShrink)',
      ),
    classDowngradeReason: z
      .string()
      .min(1)
      .max(2000)
      .optional()
      .describe(
        "loss-guard ack (P-008): why a stored 'violatable' criterion is intentionally being downgraded to settle-once (removing its provisional-until-terminal protection)",
      ),
  }),
  (args, ctx) => {
    // Keep the published dispatch schema aligned with rubricTemplateDataSchema and
    // proposeRubric: acceptance rubrics are one-shot definitions of done, so they
    // cannot participate in the reusable standard rubric release gate. Without this
    // check, callers pass schema validation and only discover the invalid combination
    // after the whole-document proposal reaches the handler.
    if (args.kind === 'acceptance' && args.releaseGating === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['releaseGating'],
        message:
          "releaseGating is standard-kind only — an acceptance rubric is one-shot and watchdog-exempt; set kind:'standard' for a reusable release bar",
      });
    }
    if (args.kind === 'acceptance' && args.stalenessWatched === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['stalenessWatched'],
        message:
          'stalenessWatched is standard-kind only — an acceptance rubric is one-shot and watchdog-exempt, so it cannot be staleness-watched',
      });
    }

    args.criteria.forEach((criterion, index) => {
      const barFields = [
        criterion.intent,
        criterion.acceptance,
        criterion.verification,
        criterion.requiredTestLayers,
        criterion.evidencePlane,
        criterion.bar,
        criterion.barKey,
        criterion.barHash,
        criterion.role,
        criterion.mandatory,
        criterion.requiredScope,
        criterion.passRatings,
        criterion.coversBarKeys,
        criterion.barProvenance,
      ];
      if (args.kind !== 'acceptance' && barFields.some((value) => value !== undefined)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['criteria', index, 'barKey'],
          message: 'BAR metadata is acceptance-kind only; standard criteria keep their existing model/method contract',
        });
      }
      if (
        criterion.model?.trim() &&
        criterion.bar?.trim() &&
        criterion.model.trim().replace(/\r\n?/g, '\n') !== criterion.bar.trim().replace(/\r\n?/g, '\n')
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['criteria', index, 'bar'],
          message: '`model` is the canonical BAR text; a supplied bar alias must match it after trimming',
        });
      }
    });

    // Keep dispatch validation aligned with the stricter acceptance authoring
    // profile enforced by proposeRubric. Model/method intentionally remain
    // optional for the light acceptance profile, but each bespoke criterion
    // still needs a concrete falsifier and the rubric needs a machine- or
    // explicitly-manual verification binding before meta-rubric vetting.
    if (args.kind === 'acceptance' && args.criteria.length > 0) {
      args.criteria.forEach((criterion, index) => {
        if (!(criterion.acceptance?.falsifier ?? criterion.driftMarkers)?.trim()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['criteria', index, 'driftMarkers'],
            message:
              `acceptance-kind criterion '${criterion.key}' requires non-empty driftMarkers ` +
              '(the concrete degraded/broken state that falsifies the outcome)',
          });
        }
      });
      if (!args.criteria.some((criterion) => (criterion.verification?.check ?? criterion.check) != null)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['criteria'],
          message:
            'acceptance-kind rubrics with bespoke criteria require at least one structured check ' +
            "(for example check:{kind:'tests'|'cargo'|'instrument'|'coverage'|'requirements'}); " +
            'model/method may remain light only when the outcome is still concrete and independently falsifiable',
        });
      }
    }
  },
);

export default defineTool({
  name: 'rubrics:propose',
  profile: 'engineer',
  description:
    'Propose/replace a rubric → status "proposed". ⚠ Whole-document replace: rubrics:get first and resubmit every criterion/check; omissions need dropKeys. Standard criteria require model/method/driftMarkers; acceptance criteria may omit model/method only with a concrete outcome, a non-empty driftMarkers falsifier, and ≥1 structured check. Removing a stored check, shrinking method+replication >40%, or dropping a replication drill requires allowMethodShrink + shrinkReason.',
  guidance: {
    when: 'Use for a new or revised rubric. Acceptance criteria are a light profile: outcome-shaped titles, a driftMarkers falsifier, traceability to the plan goal/Decisions, regression coverage, peer non-overlap; bind objective outcomes where possible and give each criterion a replication drill (methodRef names the runbook). Judges cannot run a shell, so acceptance methods prescribing native shell steps get a non-blocking methodLint advisory — use testing:run, plans:audit, or state:read instead. Full profile: /internal/docs/agent-insights/acceptance-rubrics-on-every-plan-runbook.',
    notWhen:
      'One-off finding → free-text observation; activating a proposed rubric → rubrics:ratify. Search first to avoid duplicates.',
    chaining:
      'rubrics:search → rubrics:get → rubrics:propose → independent rubrics:ratify. Review completeness and replicationSqlCheck; fix gaps before ratifying.',
    returns:
      "{ ok, rubric, completeness, replicationSqlCheck, statusOverride }. statusOverride is non-null ONLY for kind:'acceptance' when the requested activation was silently discarded because that rubricRef is already retired against its shipped plan — content still lands (ok:true, statusOverride.contentApplied:true) but the rubric stays retired; your submitted criteria/description/title DID overwrite the retired document (recoverable via plans:revision-diff, not rubrics:get). A retired-with-the-ship rubric IS the shipped plan's validation record — a NEW acceptance rubric for a shipped subjectPlan is REFUSED (subject_plan_shipped); only a goal subject takes a new rubricRef.",
    seeAlso: [
      'rubrics:search (dedup before proposing)',
      'rubrics:get (fetch before revising — propose REPLACES the stored doc)',
      'rubrics:ratify (an independent reviewer or owner/su activates the proposed rubric)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: rubricsProposeArgs,
  result: z
    .object({
      ok: z.boolean().optional(),
      rubric: z.unknown().optional(),
      completeness: z.unknown().optional(),
      replicationSqlCheck: z.unknown().optional(),
      methodLint: z.unknown().optional(),
      statusOverride: z.unknown().nullable().optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    const id = resolveAgentIdentity(ctx);
    const rubric = await proposeRubric({
      rubricId: args.rubricRef,
      ...(args.kind ? { kind: args.kind } : {}),
      ...(args.subjectPlan ? { subjectPlan: args.subjectPlan } : {}),
      ...(args.subjectHarnessSlug ? { subjectHarnessSlug: args.subjectHarnessSlug } : {}),
      ...(args.subjectGoal ? { subjectGoal: args.subjectGoal } : {}),
      ...(args.classRef ? { classRef: args.classRef } : {}),
      ...(args.composes !== undefined ? { composes: args.composes } : {}),
      characteristic: args.characteristic,
      title: args.title,
      description: args.description,
      criteria: args.criteria,
      ratingScale: args.ratingScale,
      // rubrics:get projects an unset methodRef as null. Treat that read-back value
      // as omitted so a get → edit → propose round trip reaches the same validated
      // template-data shape instead of failing dispatch validation.
      ...(args.methodRef != null ? { methodRef: args.methodRef } : {}),
      releaseGating: args.releaseGating,
      gradingAuthority: args.gradingAuthority,
      stalenessWatched: args.stalenessWatched,
      dropKeys: args.dropKeys,
      allowMethodShrink: args.allowMethodShrink,
      shrinkReason: args.shrinkReason,
      ...(args.classDowngradeReason ? { classDowngradeReason: args.classDowngradeReason } : {}),
      // P-011 (D-006): tests-check paths validate against the tree the AGENT edits.
      checkPathRoot: resolveAgentWorkspaceRoot(ctx),
      by: id.ownerId,
      // Acceptance rubrics activate on propose (plan D-008: no ratification step) — the
      // lib defaults their status to 'active'; standard proposals stay Queen-gated.
      ...(args.kind === 'acceptance' ? {} : { status: 'proposed' as const }),
    });
    // WI-4287: surface testing-procedure completeness on every revision (non-blocking).
    const completeness = rubricCompleteness(rubric);
    // EI-10514: schema-validate embedded replication-drill SQL against live PG
    // (non-blocking — see rubrics-replication-sql.ts for why this warns, never rejects).
    const replicationSqlCheck = await validateRubricReplicationSql(rubric.criteria);
    const methodLint =
      rubric.kind === 'acceptance' ? lintAcceptanceCriterionMethods(rubric.criteria) : [];
    // acceptance-runtime-plane P-004: a live/deployed BAR with no evidenceRuntime is a
    // vetting finding (non-blocking) — undeclared, graders default to :3070 and wait on main.
    const runtimeFindings = rubric.kind === 'acceptance' ? runtimeVettingFindings(rubric.criteria) : [];
    // EI-21909559308315843 / EI-21909563388028590: an acceptance rubric always activates
    // on propose — the ONE case it doesn't is the deliberate EI-21296891484659125 guard
    // (rubrics.ts) refusing to resurrect an already-retired acceptance rubric via
    // whole-document upsert. That guard is correct; what it lacked was any signal to the
    // caller that their requested activation was silently discarded (the content upsert
    // still lands and returns ok:true). Surface it as a discriminated, non-blocking
    // advisory — never a refusal, so a deliberate content-only edit of a retired rubric
    // still succeeds.
    //
    // `contentApplied` is deliberately always `true` on this branch, not a diff-derived
    // value: proposeRubric() (rubrics.ts) writes `newBody`/`templateData` unconditionally
    // inside its withPlanLock transaction — the retired-status guard only freezes the
    // STATUS field, never the content write, and any earlier refusal (loss-guard,
    // citation-path check, dangling link) throws before this handler ever reaches
    // `rubric.status === 'retired'`. So reaching this branch at all already proves the
    // content write landed; EI-21909563388028590 confirmed this live (a scratch acceptance
    // rubric's title changed on re-propose while its status stayed 'retired'). Without this
    // flag a caller reading only `reason`/`remedy` can reasonably conclude nothing happened
    // beyond the refused reactivation, when in fact their submitted criteria/description/
    // title just overwrote the terminal historical record (recoverable only via
    // plans:revision-diff on the rubricRef, never via rubrics:get).
    const statusOverride =
      args.kind === 'acceptance' && rubric.status === 'retired'
        ? {
            requested: 'active' as const,
            applied: 'retired' as const,
            contentApplied: true as const,
            reason: 'stored-acceptance-retired',
            remedy:
              'this acceptance rubric is retired and cannot be reactivated by re-proposing the same rubricRef — your submitted content WAS written over the retired document anyway (contentApplied:true; recoverable via plans:revision-diff, not rubrics:get). If it retired because its subject plan SHIPPED, there is nothing to reconcile: the retired rubric IS the validation record, and a NEW acceptance rubric for a shipped plan is refused (subject_plan_shipped, EI-22078741539479611). For a goal subject, propose a NEW rubricRef instead of re-proposing this one if you did not intend to overwrite it',
          }
        : null;
    // Push-on-write (push-audit 2026-07-26): the Rubrics pane + trend read these.
    void trackDetached(import('../../sync-sse'))
      .then((m) => {
        m.notifySyncInvalidate('rubrics.list');
        m.notifySyncInvalidate('rubrics.trend');
      })
      .catch(() => {});
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            rubric,
            completeness,
            replicationSqlCheck,
            methodLint,
            ...(runtimeFindings.length ? { runtimeFindings } : {}),
            statusOverride,
          }),
        },
      ],
    };
  },
});
