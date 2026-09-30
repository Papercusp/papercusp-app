/**
 * improvements:capture — file a captured papercusp improvement
 * (papercusp-self-improvement-loop-2026-06-04, Phase 1 / D-001;
 * close-the-self-improvement-loop-2026-06-05 D-002).
 *
 * The capture verb of the self-improvement loop: when an agent hits a papercusp
 * friction, this files it as a durable, claimable, topic-tagged work-unit (an
 * engineer_issue = work_item[kind ∈ bug|change]) instead of letting the insight
 * rot in chat. A THIN wrapper over the shared `captureImprovement` core
 * (capture-core.ts) — the watchdog's event-driven captures use the same core, so
 * the semantics (dedup verdict annotations, native kind column, payload paths,
 * auto-tagging) live in exactly one place.
 */
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity, deriveAgentRole, resolveSelfLiteral } from '../coordination/identity';
import { getPresence } from '../coordination/presence';
import { COORD_ROLES } from '../coordination/roles';
import { notifyAgents } from '../coordination/notify-agents';
import { unresolvedRefsInBody, unresolvedRefsWarning } from '../work_items/unresolved-refs';
import { issueRef, linkIssue, type IssueSeverity } from '../../issues-engineer';
import {
  captureImprovement,
  recordCaptureReviewFailure,
  setCaptureReviewState,
  type AgentReviewFailure,
} from '../../harness/improvements/capture-core';
import { enterAgentReview } from '../../harness/improvements/agent-review';
import { OBSERVATION_KINDS, ObservationEvidenceError } from '../../harness/improvements/observation-types';
import {
  CONDITION_KEY_RULE,
  OBSERVATION_EVIDENCE_RULE,
  OBSERVATION_TITLE_RULE,
} from '../../harness/improvements/observation-title-guidance';
import { setWorkItemCheckpoint } from '../../work-item-checkpoint';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { noveltyPriorArt } from '../../scout/novelty-precheck';
import { readRunningGeneration } from '../../scout/generation-watermark';
import { recordRoutedIdea } from '../../scout/routed-ledger';
import { SU_IDEATION_LENSES, type SuIdeationLens } from '../../scout/types';
import { resolveWorkItemRef } from '../../work-items';
import { pathsStalenessHint, toolFailureStalenessHint } from '../../tool-schema-staleness';
import { getBuildInfo } from '../../build-info';
import { readTrustedHarnessTestRunProvenance } from '../../testing-run-store';
import { clampText, hardText, softText, LIMITS } from '../limits';
import { resolveCaptureScope } from './capture-scope';
import { coerceCaptureArgs } from './capture-coerce';
import {
  normalizeSuspectedToolFailure,
  TOOL_FAILURE_DIRECT_EVIDENCE_KINDS,
  type SuspectedToolFailure,
} from '../../harness/improvements/tool-error-classifier';
import { getModes } from '../../modes/store';
import { withDrainBugAdmission } from '../work_items/drain-flow';
import { OrgTxnTimeoutError } from '../../pg-bounded-txn';
import { detectAbsencePremises } from '../../premises-claim-port';

const observationRatingsSchema = z.record(
  z.string().min(1),
  z.object({
    rating: z
      .string()
      .min(1)
      .describe(
        "a value from the criterion's ratingScale — default ['healthy','degraded','broken','unknown'] ('unknown' = not-assessable this wake)",
      ),
    evidence: z
      .string()
      .min(1)
      .describe(
        'MANDATORY concrete evidence backing the rating — a metric, a query result, a reference (a rating without evidence is rejected)',
      ),
    suggestion: z
      .string()
      .min(1)
      .max(2000)
      .optional()
      .describe('OPTIONAL: your concrete improvement idea for this criterion — the Blender ideators see it as a seed'),
    remediation: z
      .string()
      .min(2)
      .max(300)
      .optional()
      .describe(
        "REQUIRED (or `disregard`) on a POOR rating (fail/severe/broken/degraded/partial) of a standard rubric: the WI-/EI-/F- work-item this criterion's fix/investigation is tracked by, optionally with a short note (e.g. 'WI-1234 — watchdog class'). File/claim the item FIRST, then cite it — a poor grade that routes nowhere is rejected.",
      ),
    disregard: z
      .string()
      .min(10)
      .max(600)
      .optional()
      .describe(
        "the explicit alternative to `remediation` on a POOR rating: a reasoned, owned decision NOT to act (≥10 chars). Silence is rejected; 'n/a' is not a decision.",
      ),
  }),
);

const observedRuntimeSchema = z
  .object({
    sha: z.string().min(1).max(160).describe('runtime/source commit SHA explicitly observed by the caller'),
    version: z.string().max(160).optional().describe('runtime version reported by the observed target'),
    endpoint: z.string().max(500).optional().describe('endpoint used to exercise the observed target runtime'),
    evidenceRef: z.string().max(500).optional().describe('durable evidence reference for the observed runtime'),
    testRunIds: z
      .array(z.number().int().positive())
      .max(64)
      .optional()
      .describe(
        'OPTIONAL for caller-only runtime evidence; REQUIRED when any provenance query field is supplied. When supplied, all query fields must also be non-empty.',
      ),
    workspaceId: z.string().min(1).max(160).optional(),
    harnessSlug: z.string().min(1).max(120).optional(),
    runGroupId: z.string().min(1).max(200).optional(),
    root: z.string().min(1).max(1000).optional(),
    filePaths: z.array(z.string().min(1).max(300)).max(20).optional(),
  })
  .strict()
  .superRefine((runtime, ctx) => {
    const evidenceFields = ['workspaceId', 'harnessSlug', 'runGroupId', 'root', 'filePaths'] as const;
    const hasAnyEvidenceField = evidenceFields.some((field) => runtime[field] !== undefined);
    if (runtime.testRunIds !== undefined) {
      for (const field of evidenceFields) {
        const value = runtime[field];
        const missing = value === undefined || (Array.isArray(value) && value.length === 0);
        if (missing) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `observedRuntime.${field} is required when observedRuntime.testRunIds is supplied`,
          });
        }
      }
    } else if (hasAnyEvidenceField) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['testRunIds'],
        message: 'observedRuntime.testRunIds is required when test-run provenance query fields are supplied',
      });
    }
  });

type ObservedRuntime = z.infer<typeof observedRuntimeSchema>;

type RuntimeProvenance = {
  filingEndpointRuntime: {
    sha: string | null;
    version: string;
    transport: string | null;
    requestOrigin: unknown;
  };
  observedTargetRuntime: ObservedRuntime & {
    provenance: 'caller-supplied' | 'trusted-test-run' | 'unverified-test-run';
  };
};

function targetFreshnessEnvelope(args: {
  now: string;
  targetSha: string;
  targetVersion?: string;
  reporterSession: string;
  toolSchemaVersion?: string | null;
}) {
  return {
    observedAt: args.now,
    observedSourceSha: args.targetSha,
    observedRuntimeSha: args.targetSha,
    reporterSession: args.reporterSession,
    reporterRuntimeVersion: args.targetVersion ?? null,
    toolSchemaVersion: args.toolSchemaVersion ?? null,
    lastSuccessfulReproductionAt: args.now,
    deployBuildIdentity: args.targetVersion ? `${args.targetSha}@${args.targetVersion}` : args.targetSha,
    linkedFixRefs: [],
  };
}

const NOT_EXERCISED_RUBRIC_GUIDANCE =
  'CONDITIONAL: when observation.notExercised is non-empty, provide observation.rubricRef or the top-level rubricRef compatibility alias; omit it for a free-text observation.';

/**
 * The title/body shorthand is a cross-field contract that JSON Schema cannot
 * derive from the individual optional properties. Keep the condition beside
 * the validator so discovery can publish the same rule the refinement enforces.
 */
const CAPTURE_TEXT_CALL_CONSTRAINT =
  'at least one of title, body, or toolFailure is required; title is required when both body and toolFailure are omitted (body-only captures derive title from the first non-empty body line)';

/**
 * EI-19325151590626958 — the DEFAULT conditionKey for a rubric-graded scorecard observation.
 *
 * THE FLOOD: a rubric-graded observation is auto-titled from its rubricRef, so every emission
 * of the same scorecard produces a near-identical row. Measured 2026-08-02 over 45d:
 * `pot-coordination-health scorecard` 823 filings / 821 still open, `hive-coordination-health
 * scorecard` 490 / 341 — ~1,162 open rows from one condition, EVERY one with conditionKey NULL.
 * Keyless items are invisible to dedup, known-open aging AND auto-close (all three key off
 * payload.watchdogKey — see harness/improvements/keyless-ei-policy), so they only accrete;
 * improvements:keyless-digest can surface that pile but deliberately closes nothing. This
 * closes it at the SOURCE instead of triaging it afterwards.
 *
 * WHY A DEFAULT RATHER THAN FIXING CALL SITES: the two large populations are not the backstop
 * emitters (scorecard-emission-pulse / overwatch-scorecard-backstop already pass their own keys,
 * and correspondingly sit at n=1–4 with no accretion). They are AGENT-filed — any agent grading
 * a rubric mints a fresh row — so there is no call site to patch.
 *
 * THE KEY SHAPE follows the convention those existing emitters already established
 * (`scorecard-pulse:<hive>`, `scorecard-backstop:<hive>`): rubric AND hive, never rubric alone.
 * Keying on rubricRef only would collapse DIFFERENT pots' scorecards into a single row — a
 * worse defect than the flood, because a per-pot health signal would silently overwrite its
 * siblings. So this returns undefined (keyless, i.e. today's behaviour) unless BOTH are known;
 * a hive-less filing is left alone rather than guessed at.
 *
 * SAFE TO COLLAPSE: dedup updates in place and refreshes to the latest reading, which would
 * lose history if these rows were the only record — they are not. The authoritative per-reading
 * series lives in the scorecards store (scorecards:list / scorecards:freshness / rubrics:trend);
 * the observation lane is an explicitly pre-idea reflection lane feeding Blender's digest.
 * An explicit conditionKey always wins, so a caller can still opt out or override.
 */
export function defaultScorecardConditionKey(
  observation: { rubricRef?: string; sourceHive?: string } | undefined,
): string | undefined {
  const rubricRef = observation?.rubricRef;
  const sourceHive = observation?.sourceHive;
  if (!rubricRef || !sourceHive) return undefined;
  return `scorecard:${rubricRef}:${sourceHive}`;
}

export interface ShippedCodeSearchAdvisory {
  /** The exact absence premises already derived by the shared claim-time detector. */
  absencePremises: Array<{ claim: string; recheck: string }>;
  /** Report-only explanation of what the dedup result did and did not establish. */
  note: string;
}

/**
 * EI-19390763763662489: an empty improvement-dedup result searches prior work-item
 * text, not the shipped tree. Absence-shaped proposals are the dangerous case: the
 * caller naturally reads `possibleDuplicates: []` as corroboration that the named
 * capability does not exist, then builds a second implementation of code already in
 * production.
 *
 * Reuse the existing, corpus-calibrated absence-premise detector rather than adding a
 * second regex vocabulary. This remains a REPORT, never a gate: the capture/check-only
 * result is unchanged and the caller receives the concrete recheck that would falsify
 * each premise. A real work-item duplicate suppresses the advisory because the existing
 * dedup result already names what the caller should inspect.
 */
export function describeShippedCodeSearchGap(
  args: { title: string; body?: string; lane?: string },
  possibleDuplicates: readonly unknown[] | undefined,
): ShippedCodeSearchAdvisory | undefined {
  if (args.lane === 'observation' || !Array.isArray(possibleDuplicates) || possibleDuplicates.length > 0) {
    return undefined;
  }

  const absencePremises = detectAbsencePremises(
    [args.title, args.body].filter((part): part is string => Boolean(part?.trim())).join('\n\n'),
    'work-item',
  ).flatMap(({ claim, recheck }) =>
    typeof recheck === 'string' ? [{ claim, recheck }] : [],
  );
  if (absencePremises.length === 0) return undefined;

  return {
    absencePremises,
    note:
      'Report only — the capture still succeeded. `possibleDuplicates: []` means the work-item-text ' +
      'dedup found no prior item; it is NOT evidence that this capability is absent from shipped code. ' +
      'Before building, run the premise recheck(s) above across the whole repository: use scoped `rg` ' +
      'for text/symbol spellings and `graph:query` for call topology. Reuse the existing surface if found.',
  };
}

/**
 * gym-real-fitness-signal P-007 / D-010: report the MISSING cheapExperiment on a
 * kind:'feature' capture — as a response field, NEVER as a gate.
 *
 * The idea-fitness loop's input is the `cheapExperiment` block: an idea without one
 * cannot be compiled into a probe, so it can never be judged on an observed outcome
 * (D-002) and is invisible to the fitness loop entirely. P-007's R-2 originally
 * proposed making the block REQUIRED at capture for kind:'feature'. Two measurements
 * killed that (both recorded on D-010, both re-runnable):
 *
 *  1. It contradicts `su-ideate-learning-substrate` D-005 — "Enrich, never gate …
 *     no idea is too speculative to file — no quality gate, no quota" — itself carried
 *     VERBATIM from an earlier parity decision, i.e. ratified twice. This very
 *     directory is the reason: capture-coerce.ts exists because a hard `kind` enum was
 *     rejecting ~17% of calls and "every rejected call is a captured insight LOST".
 *  2. R-2's premise was a DENOMINATOR ERROR. "21 of 33,770 = 0.07%" divided by every
 *     work item ever. Against the population the field actually applies to — su
 *     kind:'feature' captures since the schema shipped 2026-07-11 — it is 21 of 66,
 *     i.e. ~32%, and the rate is FLAT (24-25%) across the last 7d and the prior 23d
 *     rather than decayed to zero. A gate would therefore have rejected ~2 of every 3
 *     feature filings.
 *
 * So the gap is reported, not enforced. Measured 2026-08-08: of the 66 post-schema
 * captures, ZERO supplied a partial block — every filer sent all three fields or none.
 * There is nothing to "repair", which is why this names the gap instead of coercing it.
 *
 * Same eligibility as the ideation PERSISTENCE below (kind:'feature', improvement lane):
 * it fires exactly where a supplied block would have been stored, so it can never nag a
 * filer about a field the handler would have discarded anyway.
 */
export function describeExperimentGap(args: {
  kind?: string;
  lane?: string;
  ideation?: { cheapExperiment?: { hypothesis?: string; method?: string; falsifiableSignal?: string } };
}): { missing: string[]; note: string } | undefined {
  if (args.kind !== 'feature' || args.lane === 'observation') return undefined;
  const exp = args.ideation?.cheapExperiment;
  const missing = (['hypothesis', 'method', 'falsifiableSignal'] as const).filter((f) => !exp?.[f]);
  if (missing.length === 0) return undefined;
  return {
    missing: [...missing],
    note:
      'Filed — this is a report, not a rejection. This idea carries no complete `ideation.cheapExperiment`, ' +
      'so it cannot be compiled into a probe and stays invisible to the idea-fitness loop (it is also ranked ' +
      'below bettable ideas in triage). To make it bettable, re-file with `ideation.cheapExperiment`: ' +
      '{ hypothesis: what is true if this has merit, method: the cheap first test, falsifiableSignal: the ' +
      'observable that would prove it WRONG }. For an existing item, update its persisted payload with ' +
      '`work_items:update { id, payload: { ideation: { cheapExperiment: { hypothesis: ..., method: ..., ' +
      'falsifiableSignal: ... } } } }`.',
  };
}

/**
 * WI-38065: report-only LENS-ATTRIBUTION advisory for the su IDEATE-pass feature path.
 *
 * The su-ideate ledger bridge below stamps `lens: args.ideation?.lens ?? 'su-ideate'`, and
 * sentinel rows are excluded from EVERY per-lens statistic (outcome-feedback.ts:168,:315).
 * Measured 2026-08-12 over 30 days of origin='su-ideate' filings: the sentinel was 41 of 62
 * (66%). So the per-lens win-rates that steer sampling — and the diversity floor that keeps a
 * cold or losing lens alive — were being computed over a THIRD of the corpus. A floor cannot
 * protect a lens it cannot see.
 *
 * ── RE-MEASURED 2026-08-16 (plan system-notices-on-its-own-2026-08-16, P-005) ──────────
 *
 * THIS ADVISORY WORKED, and the 66% above is now a HISTORICAL reading — do not quote it as
 * current. Weekly sentinel rate since: 100 → 81 → 72 → 67 → 43. Over the trailing 30 days
 * (papercusp-workspace, n=74) the residual has a shape that changes what a fix should be:
 *
 *   by the caller's Nth filing   1st: 75.7% (n=37) · 2nd: 57.1% (n=14) · 3rd+: 26.1% (n=23)
 *   by caller cohort             ≤2 filings: 74.4% (31 callers) · 3+ filings: 37.1% (6 callers)
 *
 * The rate falls monotonically with EXPOSURE, which is this advisory teaching. But it teaches
 * AFTER the filing, and first filings are half the corpus (37 of 74) and carry two thirds of
 * the residual — a population of short-lived su sessions that file once and never see the
 * lesson. So making this note louder, or promoting it to a gate, structurally cannot move the
 * dominant cohort; the remaining lever is compose-time or retroactive attribution, which is a
 * design call and is filed rather than guessed at here.
 *
 * ⚠ AND NOTE WHAT WENT WRONG: the user-facing `note` below used to assert "Two thirds of su
 * filings currently land this way" — a measured number hardcoded into prose, which kept
 * asserting the PRE-FIX rate at every filer for as long as the advisory succeeded. A statistic
 * in a user-facing string cannot be re-measured, so it can only decay. The note now states the
 * MECHANISM (which does not go stale), and `capture.test.ts` fails if a hardcoded population
 * rate reappears there. Corpus-level numbers belong in this comment, dated, next to the query
 * that produced them.
 *
 * WHY A RESULT-SIDE ADVISORY RATHER THAN BETTER GUIDANCE: both filing doors ALREADY spell the
 * cost out in their arg guidance (here, and scout/route-idea.ts), and that guidance was losing
 * 2:1. An explanation is read while COMPOSING the call; the omission happens precisely when the
 * filer is not thinking about lens learning. This states the CONSEQUENCE afterwards, about the
 * filing just made — the same report-only channel as {@link describeExperimentGap}.
 *
 * DELIBERATELY NOT A GATE. The `ideation` block is documented below as "Never a gate: purely
 * additive", and that decision stands: a required subfield would not reach the dominant case
 * anyway (filings that omit `ideation` entirely), and nothing here blocks or declines. An agent
 * that genuinely wants no lens simply ignores it.
 *
 * Computed from the CALLER's args (like experimentGap), so a duplicate-annotated /
 * checkDuplicatesOnly response carries it too — the filer is told at file time.
 */
export function describeLensAttribution(
  args: { kind?: string; lane?: string; ideation?: { lens?: string } },
  source?: string,
): { sentinel: true; lenses: string[]; note: string } | undefined {
  // Same eligibility as the su-ideate ledger row below — no row, nothing to attribute.
  if (source !== 'su' || args.kind !== 'feature' || args.lane === 'observation') return undefined;
  if (args.ideation?.lens) return undefined;
  return {
    sentinel: true,
    lenses: [...SU_IDEATION_LENSES],
    note:
      'Filed — this is a report, not a rejection. You declared no `ideation.lens`, so this filing was ' +
      "recorded under the 'su-ideate' sentinel and earns NO per-lens learning: sentinel rows are excluded " +
      'from every per-lens statistic, so this idea will not inform the win-rates that steer which stance ' +
      'future passes sample, and it cannot be kept alive by the diversity floor. To attribute it, re-file ' +
      'with `ideation.lens` or update the existing item via `work_items:update { id, payload: { ideation: { ' +
      'lens: "<stance>" } } }` — you already know which stance produced it.',
  };
}

/**
 * P-006 (blender-loop-repair-and-opus5-xhigh-2026-08-16) / EI-10607: report-only GROUNDING
 * advisory for an su IDEATE-pass feature filing that declared no `ideation.addressesPatternRefs`.
 * The writer (the ledger bridge below) and the readers (observationsImpact) have been wired since
 * EI-10607, yet 0 of 217 su-ideate rows carried refs (measured live 2026-08-16) — because nothing
 * told the filer at the moment they forgot. Same never-a-gate stance and caller-args basis as
 * describeLensAttribution above, so a duplicate-annotated response carries it too.
 */
export function describeGroundingGap(
  args: { kind?: string; lane?: string; ideation?: { addressesPatternRefs?: string[] } },
  source?: string,
): { note: string } | undefined {
  // Same eligibility as the su-ideate ledger row below — no row, nothing to ground.
  if (source !== 'su' || args.kind !== 'feature' || args.lane === 'observation') return undefined;
  if (args.ideation?.addressesPatternRefs?.length) return undefined;
  return {
    note:
      'Filed — this is a report, not a rejection. You declared no `ideation.addressesPatternRefs`, so ' +
      'this idea is UNGROUNDED: it can never appear as grounded/shipped in any observationsImpact ' +
      "(the observation→pattern→idea→shipped arc joins on that field), and it won't feed the grounding " +
      'metrics that show which observations earn ideas. The refs come back from blender:ideation-feedback ' +
      "as observationsImpact.patterns[].ref (e.g. 'wi:EI-10587') — pass the pattern(s) the idea actually " +
      'builds on next time, or update the existing item via `work_items:update { id, payload: { ideation: { ' +
      'addressesPatternRefs: ["<ref>", ...] } } }`.',
  };
}

export interface ToolFailureCaptureTextInput {
  title?: string;
  body?: string;
  toolFailure?: SuspectedToolFailure;
}

/**
 * P-002 / EI-21085901530859364: make the documented `toolFailure` shorthand a
 * real accepted call shape. The structured report already carries enough
 * information to file a useful row, so requiring callers to duplicate it into
 * title/body only creates another invalid-input loop. Explicit prose still wins;
 * omitted prose is derived deterministically and bounded by the same storage
 * limits as authored prose. Ordinary body-only captures use the first non-empty
 * body line as their stable title, preserving the full body as narrative.
 *
 * WI-2146402: `title` and `body` are derived INDEPENDENTLY — a caller supplying
 * its own descriptive `title` alongside `toolFailure` still gets a body derived
 * from the structured report when it omits one. The prior form returned as soon
 * as `input.title` was truthy, discarding `toolFailure` entirely in that case;
 * every real caller that composes its own title (rather than accepting the
 * generic derived one) supplies a `toolFailure` for classification and expects
 * the shorthand to cover the body it didn't write, so that early return produced
 * a permanently empty, un-gradeable filing (24 of 651 ungraded rows, measured
 * 2026-09-05) instead of ever exercising the field-listing fallback below.
 */
export function deriveToolFailureCaptureText(input: ToolFailureCaptureTextInput): { title: string; body?: string } {
  const failure = input.toolFailure;
  if (!input.title && !failure && !input.body) {
    throw new Error('improvements:capture requires title, body, or toolFailure');
  }
  const qualifier = failure?.errorCode?.trim() || failure?.status?.trim();
  const title = input.title
    ? input.title
    : failure
      ? clampText(`${failure.toolName} tool-call failure${qualifier ? ` (${qualifier})` : ''}`, LIMITS.SHORT_TITLE)
      : clampText(
          (input.body ?? '').trim().split(/\r?\n/, 1)[0]?.replace(/\s+/g, ' ').trim() ||
            (input.body ?? '').replace(/\s+/g, ' ').trim(),
          LIMITS.SHORT_TITLE,
        );
  if (input.body) return { title, body: input.body };
  if (!failure) return { title, body: undefined };

  const fields: Array<[string, unknown]> = [
    ['Tool', failure.toolName],
    ['Error code', failure.errorCode],
    ['Status', failure.status],
    ['Message', failure.message],
    ['Schema revision', failure.schemaRevision],
    ['Field path', failure.fieldPath],
    ['Runtime version', failure.runtimeVersion],
    ['Reproduced', failure.reproduced],
    ['Clear server mismatch', failure.clearServerMismatch],
    ['Hard internal', failure.hardInternal],
    ['Direct evidence kind', failure.directEvidence?.kind],
    ['Direct evidence expected', failure.directEvidence?.expected],
    ['Direct evidence actual', failure.directEvidence?.actual],
  ];
  const body = clampText(
    [
      'Suspected tool-call failure reported through the canonical improvements:capture toolFailure shorthand.',
      '',
      ...fields.flatMap(([label, value]) => (value === undefined ? [] : [`${label}: ${String(value)}`])),
    ].join('\n'),
    LIMITS.CONTENT,
  );
  return { title, body };
}

const suspectedToolFailureSchema = z
  .object({
    toolName: z.string().min(1).max(160),
    errorCode: z.string().max(160).optional(),
    // Tool transports commonly expose HTTP-like status codes as numbers. Keep
    // the persisted classifier input textual while accepting that wire shape.
    status: z.preprocess((value) => (typeof value === 'number' ? String(value) : value), z.string().max(80).optional()),
    message: z.string().min(1).max(4000),
    schemaRevision: z.string().max(160).optional(),
    fieldPath: z.string().max(300).optional(),
    runtimeVersion: z.string().max(160).optional(),
    reproduced: z.boolean().optional(),
    clearServerMismatch: z.boolean().optional(),
    hardInternal: z.boolean().optional(),
    directEvidence: z
      .object({
        kind: z.enum(TOOL_FAILURE_DIRECT_EVIDENCE_KINDS),
        expected: z.string().trim().min(1).max(2000),
        actual: z.string().trim().min(1).max(2000),
      })
      .strict()
      .optional(),
  })
  .strict();

export default defineTool({
  name: 'improvements:capture',
  profile: 'engineer',
  description:
    'Capture a papercusp bug, improvement, feature, or observation as a durable work-unit. kind=bug is auto-implement eligible; change/feature are agent-reviewed. Dedup matches are annotated on the created row; only checkDuplicatesOnly skips persistence. lane:"observation" stays outside the work queue.',
  guidance: {
    when:
      'The MOMENT you suspect ANY papercusp bug — broken OR SUB-OPTIMAL (a monitor false alarm, a self-recovered flap, load-correlated degradation): file it (kind:bug, evidence in the top-level body) even with no fix and even if it self-recovered. Only fix-now-vs-leave-filed is a judgment call; filing is not. DX/tooling/code friction counts too. Include `paths` — the auto-implement risk gate reads them. ' +
      OBSERVATION_EVIDENCE_RULE,
    notWhen:
      'A problem in a MANAGED harness/project (not papercusp itself) — that is work_items:create with that harness scope. Something needing real design — write a plan (plans:new) and capture with kind=feature linking it. A passing peer question — coord:send with expects:"answer"; an owner decision — coord:ask-owner. Never pass createdBy/source/sourceRole/filedByRole: server-derived, and the strict schema rejects them.',
    chaining:
      'improvements:capture { kind, title, paths? } → improvements:digest triages it → an agent claims + fixes it, or the auto-implement loop picks up bugs and improvements:resolve closes them.',
    // EI-21490971340666010: discovery renders observation's nested fields inline,
    // and callers repeatedly passed `linkTo` at the TOP level (three filings).
    // The strict schema correctly rejects it; this redirect turns that rejection
    // into the correction instead of a dead end.
    argRedirects: {
      linkTo: 'observation.linkTo',
      // EI-21119949290826530: `evidence` is the most natural name for the very thing
      // this tool asks for — the `when` guidance above literally says "evidence in the
      // top-level body" — but it is not a top-level ARG, and the bare rejection listed
      // 22 accepted keys without saying which of them carries it. The caller cannot
      // infer it from the list either, because two OTHER evidence homes genuinely
      // exist (`observation.ratings[].evidence` for a scorecard, `toolFailure.message`
      // for a tool-call failure), so the right answer looks like a guess between three.
      // Routes at zero prompt weight, exactly like `linkTo` above.
      evidence: 'body',
      // EI-20221816695899285: `description` is the same dead end as `evidence`, from a
      // second direction — every tool this caller reaches carries a tool-level
      // `description`, so passing one as an ARG is a natural conflation rather than a
      // guess. The strict schema rejects it correctly, but the bare rejection lists the
      // accepted keys without saying which one carries the prose, and `body` is not a
      // name the caller would land on unaided. Routes at zero prompt weight.
      description: 'body',
    },
    returns:
      'CREATE: { ok, created, issue, topics, possibleDuplicates, dedupCoverage, alreadyDecided? }. CHECK (checkDuplicatesOnly): { ok, created:false, reason:"check-only", possibleDuplicates, dedupCoverage, hint, alreadyDecided? }. The check-only `hint` states whether this was title-only or bound to the exact supplied body; changing the body can change semantic matches, so rerun with the final body before treating [] as clean.\n\n' +
      'UNKEYED OBSERVATION CREATE (`lane:"observation"`, no `conditionKey`): returns only `{ ok:true }`. Fresh storage and a server-side fold intentionally have the same response; the filing is complete and needs no caller-side duplicate investigation. Keyed machine-emitter observations retain their detailed coalesce response.\n\n' +
      'KEYED COALESCE (reason:"coalesced" — an observation matching an open conditionKey): also `coalescedOnto { id, repeatCount, bodyPersisted, bodyDiscarded?, priorAuthor, crossAuthor }`. Read `bodyPersisted` BEFORE asserting the row says what you wrote: on false your title/body was DISCARDED and the row still shows the previous reading. `crossAuthor:true` means you wrote onto a PEER\'s row (expected for a shared conditionKey; occurrences are all retained).\n\n' +
      'A filing with `paths` may also return `staleCodeWarning` — a REPORT-ONLY check for commits touching those paths after the running build. It names the serving sha and newer commits; it NEVER blocks the filing. Verify the deployed generation before treating a live observation as a current defect.\n\n' +
      'An su kind=feature filing also returns `priorArt[]` — a REPORT-ONLY novelty pre-check (including already-tried-and-failed priors) that NEVER blocks the filing. Absent field = not checked; [] = checked and nothing similar found.\n\n' +
      'possibleDuplicates[] carries THREE kinds of hit, and they do NOT mean the same thing:\n' +
      '  • no flag        — token-overlap (Jaccard) above threshold. The created row carries `payload.dedupVerdict:"likely-duplicate"`.\n' +
      '  • semantic:hard  — embedding match. The created row carries the same verdict annotation.\n' +
      '  • semantic:soft  — weaker embedding match. ADVISORY ONLY, never declines.\n' +
      '  • lexical:"containment" — your (shorter) title is almost fully covered by a much longer stored one. ADVISORY ONLY, never declines. This is the net that makes a SHORT symptom query work: Jaccard divides by the union, so a short query that is a perfect subset of a long stored title scores |query|/|title| and cannot clear the threshold on its own.\n\n' +
      'dedupCoverage { lexical, semantic, degraded } — WHAT COULD ACTUALLY BE CHECKED. Read it before treating an empty possibleDuplicates as "nothing similar exists". The embedding leg fails OPEN (semantic:"unavailable" when the embedder is down/over budget), so degraded:true means a differently-worded duplicate would NOT have been found and your empty result is "could not check", not "checked and clean".' +
      '\n\nAn absence-shaped filing/check with `possibleDuplicates: []` also returns `shippedCodeSearch { absencePremises, note }`: work-item dedup cannot prove shipped code is absent, so run the named whole-repo `rg` / `graph:query` recheck before building. Report-only; it never blocks the capture.',
    seeAlso: [
      'SYMPTOM-FIRST — improvements:capture { title, checkDuplicatesOnly:true } BEFORE you diagnose: "has anyone already hit this?" costs one call and a title, and creates nothing',
      'improvements:digest (triage the backlog this lands in — but NEVER shows lane:"observation" rows; see below)',
      // Moved out of `notWhen` (P-011 prompt-weight: seeAlso is not counted against
      // the 1500-char budget, notWhen is). Unchanged in substance — these are the
      // two args that DO carry what callers reach for the rejected provenance
      // fields to express, so the rule and its remedy have to travel together.
      'CLAIM + ATTRIBUTE: assign_to:"self" claims the filing, and observation.refs carries evidence attribution. ' +
        'Never pass createdBy / source / sourceRole / filedByRole — the server derives filer identity and role, and the strict schema rejects them.',
      'work_items:create (a problem in a MANAGED harness, not papercusp itself)',
      'plans:new (something needing real design — capture kind=feature linking it)',
      // EI-21862468579844520: reported as "no improvements:list to verify whether a
      // capture materialized" (e.g. after an ambiguous/timed-out call). There is no
      // separate list verb — and should not be, since one already exists for each
      // lane — so name the two real verification paths instead of leaving the
      // caller to guess a nonexistent tool name.
      'VERIFY A CAPTURE LANDED (no separate improvements:list — reuse the existing readers): ' +
        'kind:bug/change/feature → the CREATE response already returned `issue.id`; re-check it with work_items:get { id }. ' +
        'lane:"observation" → these are EXCLUDED from improvements:digest and the default work_items:list by design (D-005), ' +
        'so use work_items:list { includeObservations:true, q:"<title fragment>" } instead.',
    ],
  },
  capability: 'coord:write',
  // EI-20223628286146305: capture awaits dedup, persistence, tagging and optional
  // provenance work of its own. Holding the dispatcher's ambient workspace
  // transaction across those awaits pins an org-app pool slot and can starve the
  // very friction-capture path meant to report pool pressure.
  skipWorkspaceTx: true,
  requirePrincipal: false,
  // `scanner` (the scan launch blueprint's role, unify-agent-launches D-005):
  // capturing findings into the self-improvement backlog IS its output
  // contract — the P-009 live smoke proved the role allowlist (not the
  // capability gate) was what kept the spawned scanner from landing its
  // findings (it has coord:write via BLUEPRINT_ROLE_CAPS, but wasn't in
  // this list, so the tool never appeared in its projected surface).
  // A judge that discovers a broken acceptance check must be able to preserve that
  // defect instead of losing it in an ephemeral grader log.
  agentRoles: [...COORD_ROLES, 'scanner', 'judge'],
  // WI-1974: normalise a mis-used top-level `kind` (observation / null / an observation
  // sub-kind / a free-form label) to intent BEFORE validation, so a captured insight is
  // never rejected+lost on the enum. Only `kind` is touched; the .strict() observation
  // sub-object keeps failing loud on unknown keys (deliberate, anti-silent-data-loss).
  // EI-10424: also forces an IDEATE-pass proposal (structured `ideation` payload, or a
  // `foundDuring` naming an ideate pass) that left `kind` at its ambiguous 'change'
  // default into the reviewed 'feature' lane instead of landing as ordinary claimable
  // change-work — see capture-coerce.ts for the full contract.
  args: z.preprocess(
    coerceCaptureArgs,
    z
      .object({
        // observation-and-recall-surface-honesty-2026-08-16 P-001: the title is what
        // `dedupSignature()` matches on, so its SHAPE decides whether recurrence is
        // detectable at all — 99.3% of stored observation titles are singletons because
        // this field used to ask only for "a summary". The rule text is shared (never
        // re-worded per surface) so the guard test can assert every surface still names it.
        title: hardText(LIMITS.SHORT_TITLE)
          .optional()
          .describe(
            // EI-21906899166065181: `.optional()` here is a HALF-TRUTH — a superRefine below
            // rejects a call that omits title, body, and toolFailure. A caller reading the schema
            // saw `title?` and learned the real contract only from the runtime refusal. Say the
            // conditional requirement where it is read, not only where it is enforced.
            `one-line summary — REQUIRED unless body or toolFailure is supplied (body-only captures derive the title from the first non-empty body line; toolFailure derives bounded title/body server-side). ${OBSERVATION_TITLE_RULE} Do NOT include a [kind] prefix — pass kind separately.`,
          ),
        kind: z
          .enum(['bug', 'change', 'feature'])
          .optional()
          .describe(
            'bug = something broken (auto-eligible); change = a desired improvement; feature = net-new (both human-gated). Required for an improvement; ignored for lane:observation (always stored as a non-bug nit). Default change.',
          ),
        body: hardText(LIMITS.CONTENT).optional().describe('repro / context / the correct-state, especially for a bug'),
        severity: z.enum(['critical', 'major', 'minor', 'nit']).optional(),
        subTopic: z.string().min(1).max(40).optional().describe('optional sub-area topic, e.g. coord-dx, db-tooling'),
        scope: z
          .string()
          .max(80)
          .optional()
          .describe(
            "Pot scope. OMIT (recommended) → the item files under the workspace platform Pot; pass 'harness:<slug>' to scope it to a specific Pot. (An omitted/'operator'/workspace-global scope auto-homes to the platform Pot — you do NOT need to pass 'harness:papercusp' by hand.)",
          ),
        harness: z
          .string()
          .max(80)
          .optional()
          .describe(
            "Compatibility alias for the common per-call harness spelling. `harness:'foo'` is normalized to `scope:'harness:foo'`; prefer `scope:'harness:foo'` for new calls.",
          ),
        // EI-10943: was `z.string().max(120)` — a HARD reject. Overrunning it bounced the
        // WHOLE capture (the finding is lost, and the agent gets the entire args schema
        // dumped back at it) over a provenance LABEL the tool only stores and echoes, into
        // an unbounded `text` column. Soft-capped: truncate + warn, never reject. The clamp
        // is handler-side, NOT a zod .transform() — a transform is unrepresentable in JSON
        // Schema and crashes z.toJSONSchema for the whole catalog (see limits.ts).
        foundDuring: softText(LIMITS.LABEL)
          .optional()
          .describe(
            `what you were doing when you found this (a plan slug, a task, "the X audit"). ` +
              `Free text — truncated to ${LIMITS.LABEL} chars with a warning if longer, never rejected.`,
          ),
        paths: z
          .array(z.string().min(1).max(300))
          .max(20)
          .optional()
          .describe('repo-relative file paths the improvement touches, when known — feeds the protected-path gate'),
        observedRuntime: observedRuntimeSchema
          .optional()
          .describe(
            'explicit runtime provenance for the environment that produced the report. Caller-only form: provide sha plus optional version/endpoint/evidenceRef and omit testRunIds and query fields. Trusted test-run form: provide testRunIds plus every query field (workspaceId, harnessSlug, runGroupId, root, filePaths), all non-empty; only matching clean server-owned ledger rows can validate the target SHA. This is separate from the runtime that received this capture call.',
          ),
        notifyAgents: z
          .array(z.string().min(1))
          .max(8)
          .optional()
          .describe(
            '@-mention SPECIFIC agents: ownerId prefixes / handles (resolve via coord:presence). Each is SUBSCRIBED to the captured item (gets every future update) AND pinged now, pointing at it — a DIRECTED handoff to a known owner. Distinct from the auto-topic broadcast (which reaches whoever subscribed to the area) and from claiming. Ignored for lane:observation. Use when you know exactly who should see/own this.',
          ),
        force: z
          .boolean()
          .optional()
          .describe('suppress the duplicate verdict annotation when you have direct evidence this filing is distinct (default false)'),
        checkDuplicatesOnly: z
          .boolean()
          .optional()
          .describe(
            'SEARCH ONLY, creates nothing: "has anyone already hit this?" — run BEFORE you diagnose, with just a `title` (the symptom in your own words).',
          ),
        // WI-5950. Kept SHORT on purpose: the prompt-weight budget (≤1500 soft / ≤1600 hard
        // per tool) is shared across every field, and the first draft of this description
        // blew the hard cap on its own. The rationale lives here, not in the agent's context:
        // the persona tells every agent to file the moment it notices AND to hold a work-item
        // before editing — without an atomic claim those two conflict, so filing a bug you are
        // already fixing publishes it to the claimable pool and a peer duplicates the work
        // (observed 2026-07-26, cost su-63f9b336 a duplicate run at the same fix).
        // Same name + semantics as work_items:create's assign_to; 'self' resolves to the caller.
        assign_to: z
          .string()
          .max(120)
          .optional()
          .describe(
            'Atomically CLAIM the filed item in this same capture — an ownerId, or "self". Use when you are ALREADY working the thing you are filing: an unclaimed item goes to the claimable pool, where a peer may duplicate your in-progress fix. Omit ⇒ unclaimed. Ignored for observations.',
          ),
        origin: z
          .enum(['organic', 'drill', 'replay', 'shadow'])
          .optional()
          .describe(
            'signal provenance (frontier P-002) — default organic. ONLY a frontier loop passes non-organic (vaccination drill, replay counterfactual, shadow ablation); synthetic rows stay out of organic learners',
          ),
        signalOrigin: z
          .enum(['organic', 'drill', 'replay', 'shadow'])
          .optional()
          .describe(
            'compatibility alias for origin; the persisted/domain model calls this signalOrigin. Prefer origin for new calls. Do not pass both with different values.',
          ),
        lane: z
          .enum(['improvement', 'observation'])
          .optional()
          .describe(
            "'observation' files a PRE-IDEA turn-end reflection into the SEPARATE observation lane (D-005) — it never enters the work queue/triage/auto-implement; only Blender's corpus-digest + the Observations pane read it. Default 'improvement'.",
          ),
        conditionKey: z
          .string()
          .min(1)
          .max(160)
          .optional()
          .describe(
            `Stable recurring identity. ${CONDITION_KEY_RULE} For an observation, a still-OPEN prior observation carrying the SAME conditionKey has its repeatCount bumped and its title/body refreshed instead of minting a fresh row. For an ordinary improvement/bug capture, the key feeds the exact-key coalescer so repeated filings refresh one open row even when lexical or semantic search is unavailable. Where a key is ALREADY published — an OverwatchBrief anomaly line's \`[conditionKey: overwatch:escalation-aging]\` — copy that one verbatim rather than minting a variant that cannot join it. Omit for a genuinely novel/one-off reading, which re-files as before. A rubric-graded scorecard (observation.rubricRef) DEFAULTS to \`scorecard:<rubricRef>:<sourceHive>\` when you omit this (EI-19325151590626958) — pass it explicitly to override.`,
          ),
        toolFailure: suspectedToolFailureSchema
          .optional()
          .describe(
            'Suspected tool-call failure. A one-off is captured immediately in non-claimable probation and correlated by tool/error/schema/field/runtime; a second independent reporter or the invocation watchdog promotes the SAME row. Put legacy direct-evidence flags inside this object — toolFailure.reproduced, toolFailure.clearServerMismatch, or toolFailure.hardInternal — and do not pass them at the top level. For a caller-class refusal, those booleans alone stay in probation: pass toolFailure.directEvidence { kind, expected, actual } only when you can state the inspectable contract mismatch that makes it a tool defect.',
          ),
        // EI-12176 compatibility aliases. Older generated guidance advertised these at
        // top level. Declaring + normalising them prevents tools:invoke's permissive
        // envelope from silently stripping a scorecard while keeping observation.* as
        // the canonical shape shown to new callers.
        rubricRef: z
          .string()
          .max(120)
          .optional()
          .describe(
            `compatibility alias for observation.rubricRef; prefer observation:{ rubricRef, ratings }. ${NOT_EXERCISED_RUBRIC_GUIDANCE}`,
          ),
        ratings: observationRatingsSchema
          .optional()
          .describe('compatibility alias for observation.ratings; prefer observation:{ rubricRef, ratings }'),
        observation: z
          .object({
            kind: z.enum(OBSERVATION_KINDS).optional(),
            scope: z.enum(['self', 'role', 'harness', 'papercusp']).optional(),
            confidence: z.enum(['low', 'med', 'high']).optional(),
            refs: z
              .array(z.string().max(200))
              .max(12)
              .optional()
              .describe('attribution: tool:/file:/WI- refs grounding the observation'),
            // ── Structured-observation v2 (rubric-driven-observations-2026-06-20 P-001 / D-003).
            // Converges the source-hive tag (workspace-scoped-coordination P-001) + rubric
            // grading (this plan) into ONE coherent extension. All optional — free-text
            // observations stay first-class.
            sourceHive: z
              .string()
              .max(120)
              .optional()
              .describe(
                'the pot the observation came FROM — AUTO-DERIVED from ctx (the agent harness/pot) when omitted; explicit callers (Overwatch/Blender) may set it',
              ),
            targetHive: z
              .string()
              .max(120)
              .optional()
              .describe('optional: the pot the observation is ABOUT (a cross-pot observation)'),
            rubricRef: z
              .string()
              .max(120)
              .optional()
              .describe(
                `a rubrics.rubric_id this observation grades against (e.g. 'pot-coordination-health'). Present ⇒ a rubric-graded observation; ratings must accompany it. ${NOT_EXERCISED_RUBRIC_GUIDANCE.replace('provide observation.rubricRef or the top-level rubricRef compatibility alias', 'provide this field or the top-level rubricRef compatibility alias')}`,
              ),
            ratings: observationRatingsSchema
              .optional()
              .describe(
                'per-criterion ratings against rubricRef, KEYED by rubric criterion `key` (a scorecard: one rating per criterion). evidence is mandatory on every entry',
              ),
            // rubric-system-improvements-2026-07-12 P-002: the scoped-drill shorthand.
            // A targeted run exercises a handful of a rubric's criteria; the completeness
            // gate still (rightly) demands every key, which day-one produced ~13 hand-written
            // boilerplate unknowns per scorecard. Each listed key expands server-side to
            // { rating:'unknown', evidence:'idle: not exercised by this run.' } — the idle:
            // form the staleness calc excludes. Explicit ratings always win; the key is
            // stripped before storage so the persisted payload stays pure ratings.
            notExercised: z
              .array(z.string().min(1))
              .max(64)
              .optional()
              .describe(
                `criterion keys this run did NOT exercise — each expands to { rating:'unknown', evidence:'idle: not exercised by this run.' } so a scoped drill passes the completeness gate without hand-written boilerplate (explicit ratings win). ${NOT_EXERCISED_RUBRIC_GUIDANCE}`,
              ),
            // WI-3594 (scorecard→improvement flow): a GRADE filing (rubricRef+ratings) often
            // identifies a concrete follow-up — link it AT FILE TIME instead of a separate
            // work_items:link round-trip later (which is easy to forget, silently orphaning the
            // scorecard from the work it motivated). Surfaced in ScorecardDetail's UI (scorecards.list
            // linkedItems). Optional — a scorecard with nothing concrete to link stays unlinked.
            linkTo: z
              .array(
                z.object({
                  targetId: z
                    .string()
                    .min(1)
                    .max(120)
                    .describe('the work-item id (WI-/F-/EI-…) this scorecard relates to'),
                  rel: z
                    .enum(['relates', 'blocks', 'duplicates', 'fixes', 'revises'])
                    .optional()
                    .describe(
                      "default 'relates'; use 'revises' when this new filing incorporates feedback on the target",
                    ),
                  targetHarness: z
                    .string()
                    .max(80)
                    .optional()
                    .describe('harness for a feature targetId (disambiguation)'),
                }),
              )
              .max(5)
              .optional()
              .describe(
                "link this filing to one or more existing work-items at file time (e.g. a GRADE follow-up, or rel:'revises' for a feedback-driven revision) — best-effort, never fails the capture",
              ),
            // goal-mode-rubric-v2-2026-08-10 P-009: WHAT this scorecard grades.
            // sourceHive/targetHive answer which POT; for a PER-RUN rubric
            // (goal-mode-e2e grades ONE run of ONE agent) nothing said which RUN —
            // so five v1 scorecards were indistinguishable by field, none re-derivable.
            // The shape is the DRILL PARAMETER BINDING, measured across that rubric's
            // 25 criteria: `:subject` (20), `:run_start` (12), `:run_end` (11) and
            // nothing else. Recording exactly those makes a scorecard re-runnable
            // from its own record.
            subject: z
              .object({
                kind: z
                  .enum(['agent-run', 'session', 'work-item', 'plan', 'pot'])
                  .optional()
                  .describe('what `ref` names; omit if you did not classify it'),
                ref: z
                  .string()
                  .min(1)
                  .max(200)
                  .describe(
                    "the graded thing's id — the drills' `:subject` (an ownerId for an agent-run, a session id, a WI-/EI- id, a plan slug, a pot slug)",
                  ),
                windowStart: z
                  .string()
                  .max(40)
                  .optional()
                  .describe("ISO — start of the graded window; the drills' `:run_start`"),
                windowEnd: z
                  .string()
                  .max(40)
                  .optional()
                  .describe("ISO — end of the graded window; the drills' `:run_end`"),
              })
              .strict()
              .optional()
              .describe(
                'WHAT this scorecard grades (a per-RUN rubric needs this to be attributable/re-runnable): { ref, kind?, windowStart?, windowEnd? } — the replication-drill parameter binding. Omit for a pot-level or free-text observation.',
              ),
          })
          // plan-templates-and-rubric-v2 P-012 (strict/fail-loud): reject UNKNOWN observation keys
          // LOUDLY instead of silently STRIPPING them. A silent strip dropped data live (su-2a0b4: an
          // Overwatch scorecard emitted against the not-yet-deployed schema persisted scope-only with no
          // error, corrupting the trend). A schema-evolution / deploy-timing mismatch now surfaces as a
          // named-key validation error at arg-parse instead of vanishing.
          .strict()
          .optional()
          .describe(
            `structured fields for a lane:observation record. ${OBSERVATION_EVIDENCE_RULE} The IDENTIFYING "what" is the title (see its rule — an observation is found again only by its title) and the whole narrative "why" is the body, which is unbounded free prose and the right home for the story. Pass rubricRef+ratings (each {rating,evidence}) to file a RUBRIC-GRADED observation — check rubrics:list first to see if a rubric fits.`,
          ),
        // ── IDEATE-pass provenance (su-ideate-learning-substrate-2026-07-10 P-002 / D-004:
        // the ONE schema bump — the full shape is declared here so the tool contract never
        // churns again; P-002 stamps `lens` on the ledger row, P-007 persists the whole
        // declared object onto the created item's payload (payload.ideation) for the
        // triage/learning read). Enrichment only, never a gate (D-005): absence changes
        // nothing about the capture.
        ideation: z
          .object({
            lens: z
              .enum([...SU_IDEATION_LENSES] as [SuIdeationLens, ...SuIdeationLens[]])
              .optional()
              .describe(
                "the generative stance that produced this idea — Scout's four creative lenses (analogical / first-principles / reframing / constraint-removal) + the su stances (risk-first = de-risk the riskiest assumption; user-value = backward from felt owner/user value; cost-leverage = small change, big recurring cost). Declaring it earns per-lens outcome feedback on YOUR ideas (P-004); omitted = recorded under the 'su-ideate' sentinel (no per-lens learning)",
              ),
            bet: z
              .string()
              .max(2000)
              .optional()
              .describe(
                'the bet — the concrete upside if the idea pans out (persisted to the created item payload, payload.ideation)',
              ),
            // EI-10607: the GROUNDING leg. Without it the su-ideate rail could not write
            // addresses_pattern_refs at all (no su-reachable verb accepted them — only Scout's
            // internal router did), so observationsImpact.ideasGrounded/shipped were pinned at 0
            // by construction: 122 su ideas, 0 grounded, against Scout's 24/24. The reader and the
            // ledger column had been waiting for a writer since P-021 shipped.
            addressesPatternRefs: z
              .array(z.string().min(1).max(200))
              .max(10)
              .optional()
              .describe(
                "the digest meta-pattern refs this idea GROUNDS ON — the observation→pattern→idea→shipped arc is joined on this field, so an idea filed without it can never show up as grounded in anyone's observationsImpact. You already have the refs: they come back from blender:ideation-feedback as observationsImpact.patterns[].ref (e.g. 'wi:EI-10587'). Pass the pattern(s) your pass actually built on",
              ),
            cheapExperiment: z
              .object({
                hypothesis: z.string().min(1).max(2000).describe('what we believe will be true if the idea has merit'),
                method: z.string().min(1).max(2000).describe('the cheap first test (what to run / build / measure)'),
                falsifiableSignal: z
                  .string()
                  .min(1)
                  .max(2000)
                  .describe('the observable that would prove the hypothesis WRONG'),
              })
              .optional()
              .describe(
                'the cheap falsifiable first experiment (ScoutExperiment shape, D-006 bettable-not-clever; persisted to payload.ideation — a COMPLETE one makes the idea machine-checkably bettable and ranks it first in triage)',
              ),
          })
          .strict()
          .optional()
          .describe(
            "IDEATE-pass provenance for an su session's kind:'feature' origination — stamps the routed-idea ledger row (origin='su-ideate') with your declared lens so grade→outcome→feedback learning attributes back to it. Never a gate: purely additive, ignored for lane:observation / non-feature kinds.",
          ),
      })
      .strict()
      .superRefine((args, ctx) => {
        if (args.origin !== undefined && args.signalOrigin !== undefined && args.origin !== args.signalOrigin) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['signalOrigin'],
            message: 'conflicting origin values: pass origin or signalOrigin, not both with different values',
          });
        }
        if (!args.title && !args.body && !args.toolFailure) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['title'],
            message:
              'title is required unless body or toolFailure is supplied (body-only captures derive the title from the first non-empty body line)',
          });
        }
      })
      .meta({ 'x-papercusp-call-constraint': CAPTURE_TEXT_CALL_CONSTRAINT }),
  ),
  result: z
    .object({
      ok: z.boolean().optional(),
      created: z.boolean().optional(),
      issue: z.unknown().optional(),
      topics: z.array(z.unknown()).optional(),
      possibleDuplicates: z.array(z.unknown()).optional(),
      dedupCoverage: z.unknown().optional(),
      alreadyDecided: z.unknown().optional(),
      reason: z.string().optional(),
      hint: z.string().optional(),
      coalescedOnto: z.unknown().optional(),
      staleCodeWarning: z.unknown().optional(),
      priorArt: z.array(z.unknown()).optional(),
      shippedCodeSearch: z.unknown().optional(),
      experimentGap: z.unknown().optional(),
      lensAttribution: z.unknown().optional(),
      groundingGap: z.unknown().optional(),
      agentReview: z.unknown().optional(),
      agentReviewFailure: z.unknown().optional(),
      notified: z.unknown().optional(),
      linked: z.array(z.unknown()).optional(),
      possiblyStaleSchema: z.unknown().optional(),
      warnings: z.array(z.unknown()).optional(),
      error: z.string().optional(),
      retryable: z.boolean().optional(),
      pgCode: z.string().optional(),
      message: z.string().optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    const id = resolveAgentIdentity(ctx);
    // EI-21601117899178959: direct handler callers (including older in-process
    // dispatchers) may bypass the args preprocessor. Keep the same canonicalization
    // and conflict guard here so the core never receives a silently dropped alias.
    if (args.origin !== undefined && args.signalOrigin !== undefined && args.origin !== args.signalOrigin) {
      throw new ObservationEvidenceError(
        'conflicting origin values: pass origin or signalOrigin, not both with different values',
      );
    }
    const captureOrigin = args.origin ?? args.signalOrigin;
    const source = id.source === 'omp-hook-session' || id.source === 'static-client' ? 'su' : 'engineer';
    // Resolve the filer's ROLE for per-role observation attribution (close the
    // ~100%-'unknown' gap, 2026-06-21). The caller is LIVE while it files, so its
    // coord presence carries the FINE self-reported role (overwatch/queen/scout/
    // bee/worker/…) that the server-side deriveAgentRole cannot see (the agent's
    // PAPERCUSP_AGENT_ROLE env is not in THIS process). Fall back to the coarse
    // source-derived role; best-effort — a presence-read miss never blocks a capture.
    const filedByRole =
      (await getPresence(id.ownerId).catch(() => null))?.agentRole ?? deriveAgentRole(id) ?? undefined;
    // Auto-derive sourceHive (rubric-driven-observations D-003) from the caller's
    // hive/harness when omitted: signed-spawn bees carry ctx.harnessSlug; explicit
    // callers (Overwatch/Scout) set observation.sourceHive themselves. '*' (the
    // unscoped session) is not a hive → leave undefined.
    const ctxHarnessRaw = (ctx as { harnessSlug?: unknown }).harnessSlug;
    const ctxHarness =
      typeof ctxHarnessRaw === 'string' && ctxHarnessRaw && ctxHarnessRaw !== '*' ? ctxHarnessRaw : undefined;
    const ctxWorkspaceRaw = (ctx as { workspaceId?: unknown }).workspaceId;
    const ctxWorkspace = typeof ctxWorkspaceRaw === 'string' ? ctxWorkspaceRaw : undefined;
    // EI-20309391070582534: only a 'harness:<slug>' value names a Pot, so only two
    // DIFFERENT pot names are a real conflict. A scope that merely repeats the harness
    // (or that is a subject-area label) resolves and warns instead of bouncing the
    // whole capture — see capture-scope.ts for the four filings behind this.
    const scopeResolution = resolveCaptureScope({ scope: args.scope, harness: args.harness });
    if (scopeResolution.conflict) throw new Error(scopeResolution.conflict);
    const captureScope = scopeResolution.scope;
    if (args.observation?.rubricRef && args.rubricRef && args.observation.rubricRef !== args.rubricRef) {
      throw new ObservationEvidenceError(
        'conflicting rubricRef values: pass the scorecard once under observation.rubricRef (preferred) or top-level rubricRef (compatibility alias)',
      );
    }
    // Compatibility aliases may be emitted together by callers that combine an
    // older top-level schema with the current nested shape. Coalesce equivalent
    // values (the nested value remains canonical below), but reject an actual
    // disagreement so one spelling cannot silently overwrite the other.
    if (args.observation?.ratings && args.ratings && !isDeepStrictEqual(args.observation.ratings, args.ratings)) {
      throw new ObservationEvidenceError(
        'conflicting ratings values: pass matching ratings once under observation.ratings (preferred) or top-level ratings (compatibility alias)',
      );
    }
    // EI-20212184497318148: `notExercised` is scorecard shorthand, not a
    // free-text caveat. Expanding it without a rubric manufactures synthetic
    // ratings and then fails later with the technically-correct but misleading
    // "ratings must name the rubric" error — making the caller believe it never
    // supplied ratings at all. Fail at the shorthand boundary and name the
    // missing prerequisite directly. The legacy top-level rubricRef alias is a
    // valid prerequisite because it is normalized into the same observation.
    if (args.observation?.notExercised?.length && !(args.observation.rubricRef ?? args.rubricRef)?.trim()) {
      throw new ObservationEvidenceError(
        'observation.notExercised is scorecard shorthand and requires observation.rubricRef (or the top-level rubricRef compatibility alias)',
      );
    }
    const observationInput =
      args.observation || args.rubricRef || args.ratings
        ? {
            ...args.observation,
            rubricRef: args.observation?.rubricRef ?? args.rubricRef,
            ratings: args.observation?.ratings ?? args.ratings,
          }
        : undefined;
    const observationBase = observationInput
      ? (() => {
          // P-002 notExercised expansion (rubric-system-improvements-2026-07-12):
          // each listed key becomes an idle:-tagged unknown UNLESS explicitly rated;
          // the shorthand key itself is stripped so the stored payload is pure ratings.
          const { notExercised, ...rest } = observationInput;
          const expanded =
            notExercised && notExercised.length > 0
              ? Object.fromEntries(
                  notExercised
                    .filter((k) => !(rest.ratings && k in rest.ratings))
                    .map((k) => [k, { rating: 'unknown', evidence: 'idle: not exercised by this run.' }]),
                )
              : undefined;
          return {
            ...rest,
            ...(expanded && Object.keys(expanded).length > 0 ? { ratings: { ...expanded, ...rest.ratings } } : {}),
            sourceHive: rest.sourceHive ?? ctxHarness,
          };
        })()
      : undefined;
    // EI-12147: stamp the GRADED GENERATION on a rubric scorecard, SERVER-SIDE (no caller
    // change — the observation schema is .strict(), so only this stamp can write it). A
    // long-lived host executes whatever was on disk when it last STARTED, so a scorecard
    // without a generation identity is ambiguous evidence after any restart/deploy: the
    // 2026-07-14 GO stall was graders reconciling verdicts that had silently judged two
    // different generations. Best-effort by construction (both legs degrade to null) —
    // the stamp must never fail the capture it rides on.
    const gradedGeneration =
      observationBase?.rubricRef && observationBase.ratings ? await readRunningGeneration().catch(() => null) : null;
    const observation = observationBase
      ? { ...observationBase, ...(gradedGeneration ? { gradedGeneration } : {}) }
      : undefined;
    // P-007 (su-ideate-learning-substrate): persist the declared IDEATE-pass provenance
    // onto the created item's payload (payload.ideation) so the triage/learning read can
    // surface the bet + experiment and rank machine-checkably bettable ideas first.
    // Same eligibility the contract doc states: a kind:'feature' improvement-lane capture
    // only. Enrichment only (D-005) — absence changes nothing about the capture.
    const ideation =
      args.ideation && args.kind === 'feature' && args.lane !== 'observation'
        ? {
            ...(args.ideation.lens ? { lens: args.ideation.lens } : {}),
            ...(args.ideation.bet ? { bet: args.ideation.bet } : {}),
            ...(args.ideation.cheapExperiment ? { cheapExperiment: args.ideation.cheapExperiment } : {}),
          }
        : undefined;
    const hasIdeation = !!ideation && Object.keys(ideation).length > 0;
    // EI-10943: truncate-and-warn. The capture always lands; the agent is TOLD what
    // was trimmed rather than losing the finding to a validation bounce.
    const foundDuring = clampText(args.foundDuring, LIMITS.LABEL);
    const foundDuringTruncated = typeof args.foundDuring === 'string' && args.foundDuring.length > LIMITS.LABEL;
    const captureText = deriveToolFailureCaptureText(args);
    const normalizedToolFailure = args.toolFailure
      ? normalizeSuspectedToolFailure(args.toolFailure as SuspectedToolFailure)
      : undefined;
    // EI-22752568870730930: the process receiving this capture may not be the
    // runtime that produced the report (for example, a report exercised against
    // staging while the filing went through the green operator). Keep both
    // identities. A caller SHA is useful evidence, but exact clean test-run rows
    // are the only server-owned path that upgrades it to trusted provenance.
    let targetRuntimeSha: string | null = null;
    let runtimeProvenance: RuntimeProvenance | undefined;
    let targetRuntimeObservedAt: string | undefined;
    if (args.observedRuntime) {
      const observed = args.observedRuntime;
      let provenance: RuntimeProvenance['observedTargetRuntime']['provenance'] = 'caller-supplied';
      let observedTarget = { ...observed };
      if (observed.testRunIds !== undefined) {
        const trusted = await readTrustedHarnessTestRunProvenance({
          testRunIds: observed.testRunIds,
          workspaceId: observed.workspaceId!,
          harnessSlug: observed.harnessSlug!,
          runGroupId: observed.runGroupId!,
          root: observed.root!,
          filePaths: observed.filePaths!,
        }).catch(() => null);
        if (trusted) {
          targetRuntimeSha = trusted.commitSha;
          provenance = 'trusted-test-run';
          observedTarget = { ...observed, sha: trusted.commitSha };
        } else {
          // Never fall back to the caller SHA when it was accompanied by an
          // invalid/incomplete evidence query: doing so would make a failed
          // trust check look like validated target identity.
          provenance = 'unverified-test-run';
        }
      } else {
        targetRuntimeSha = observed.sha.trim();
      }
      targetRuntimeObservedAt = new Date().toISOString();
      const filingBuild = getBuildInfo();
      runtimeProvenance = {
        filingEndpointRuntime: {
          sha: filingBuild.sha,
          version: filingBuild.version,
          transport: ctx.transport ?? ctx.requestOrigin?.transport ?? null,
          requestOrigin: ctx.requestOrigin ?? null,
        },
        observedTargetRuntime: { ...observedTarget, provenance },
      };
    }
    // EI-21351815194031529: a tool's SCHEMA is rendered by the running operator, but
    // the tree runs ahead of it — so a constraint the reporter genuinely hit may
    // already be fixed and merely undeployed. That reads exactly like an open defect
    // from inside the failing session, and the cost lands on whoever triages this row
    // later. Resolve the failing verb to its defining file and say so at FILE time.
    // Null unless the file actually differs between the serving build and the tree,
    // so the common case adds nothing. Never throws; never blocks the filing.
    const stalenessHint = args.toolFailure ? await toolFailureStalenessHint(args.toolFailure.toolName) : null;
    // EI-19452091889263267: a report can be based on a live runtime observation
    // even when the failing call itself was not a schema/tool error.  Compare the
    // explicitly supplied subject paths against the serving build and carry a
    // non-blocking cue into the durable body so triage does not mistake an older
    // runtime for current tree behavior.
    const pathStalenessHint = args.paths?.length
      ? targetRuntimeSha
        ? await pathsStalenessHint(args.paths, { deployedSha: () => targetRuntimeSha! })
        : await pathsStalenessHint(args.paths)
      : null;
    // Reserve room for the hint rather than clamping the join: the body arrives
    // already clamped to LIMITS.CONTENT, so a naive append could overflow it, and
    // clamping afterwards would silently truncate the hint off the END — losing
    // exactly the line this exists to add, on the longest (most detailed) reports.
    // WI-2143658: this report matches a class already adjudicated as external
    // with no papercusp fix surface. Say so IN THE BODY — the row is still
    // filed (non-claimable), and whoever reads it next needs the citation, not
    // a fresh investigation. Without this line the filed row looks identical to
    // an undiagnosed defect, which is how the same class got investigated and
    // closed four separate times.
    const knownExternalHint = normalizedToolFailure?.knownExternal
      ? `⚠ KNOWN EXTERNAL CLASS — no papercusp fix surface. This report matches \`${normalizedToolFailure.knownExternal.id}\`, ` +
        `already adjudicated in /internal/docs/${normalizedToolFailure.knownExternal.docSlug}. ` +
        `${normalizedToolFailure.knownExternal.note} ` +
        `Filed non-claimable on purpose: do NOT re-investigate from scratch, and do not promote it by re-attesting reproduction — ` +
        `cite the doc. If it becomes RELIABLY reproducible (not merely intermittent) or starts blocking work at a meaningful rate, ` +
        `that is new evidence worth escalating upstream, and the invocation-ledger watchdog can still promote this row on sustained repetition.`
      : null;
    const stalenessHints = [stalenessHint, pathStalenessHint, knownExternalHint].filter((hint): hint is string =>
      Boolean(hint),
    );
    const stalenessHintText = stalenessHints.join('\n\n');
    const bodyWithStaleness = stalenessHintText
      ? [clampText(captureText.body, Math.max(0, LIMITS.CONTENT - stalenessHintText.length - 2)), stalenessHintText]
          .filter(Boolean)
          .join('\n\n')
      : captureText.body;
    const toolFailureKind: 'bug' | 'change' | undefined = normalizedToolFailure
      ? args.toolFailure?.directEvidence || args.toolFailure?.clearServerMismatch || args.toolFailure?.hardInternal
        ? 'bug'
        : normalizedToolFailure.class === 'caller' || normalizedToolFailure.class === 'rate-limit'
          ? 'change'
          : 'bug'
      : undefined;
    const effectiveKind = toolFailureKind ?? args.kind ?? 'change';
    const effectiveLane = normalizedToolFailure && !normalizedToolFailure.direct ? 'observation' : args.lane;
    // D-001 / WI-38403: mode is server-side standing state, never caller prose or
    // a public bypass flag. Read it only for a claimable bug admission; observations
    // and non-bugs retain their existing availability-first behavior.
    const drainMode =
      effectiveKind === 'bug' && effectiveLane !== 'observation'
        ? (await getModes(id.workspaceId ?? ctxWorkspace ?? 'default', id.ownerId)).find(
            (mode) => mode.mode === 'drain',
          )
        : undefined;
    const requireCompleteDedupCoverage = Boolean(drainMode);
    const resolvedAssignee = resolveSelfLiteral(args.assign_to, id.ownerId);
    const reviewRequired =
      !args.checkDuplicatesOnly &&
      effectiveLane !== 'observation' &&
      (effectiveKind === 'change' || effectiveKind === 'feature');
    // A caller-supplied conditionKey is the stable correlation identity. Keep it
    // ahead of the tool-failure message key: the latter intentionally includes a
    // message fingerprint, so changing only the error wording must not fork one
    // condition into multiple rows (EI-22722288208033107).
    const captureWatchdogKey =
      args.conditionKey ??
      (normalizedToolFailure
        ? normalizedToolFailure.watchdogKey
        : effectiveLane === 'observation'
          ? defaultScorecardConditionKey(observation)
          : undefined);
    // work-queue-admission-and-bulk-dedup P-008: a successful unkeyed
    // observation filing is DONE from the caller's perspective. Whether the
    // server minted a row, HARD-folded onto a survivor, or SOFT-linked a fresh
    // row is durable admission machinery, not follow-up work for the filing
    // agent. Keep check-only and conditionKey callers detailed: the former
    // explicitly asked to inspect candidates, while the latter includes machine
    // emitters whose coalesce metadata remains operationally load-bearing.
    const silenceUnkeyedObservationDisposition =
      effectiveLane === 'observation' && !args.checkDuplicatesOnly && !captureWatchdogKey;
    const reviewHarness =
      ctxHarness ?? (captureScope?.startsWith('harness:') ? captureScope.slice('harness:'.length) : 'papercusp');
    const toolFailureProbation = normalizedToolFailure
      ? {
          state: normalizedToolFailure.direct ? ('promoted' as const) : ('probation' as const),
          class: normalizedToolFailure.class,
          watchdogKey: normalizedToolFailure.watchdogKey,
          classKey: normalizedToolFailure.classKey,
          contractFingerprint: normalizedToolFailure.contractFingerprint,
          deployedRevision: normalizedToolFailure.deployedRevision,
          correlationFingerprint: normalizedToolFailure.correlationFingerprint,
          messageFingerprint: normalizedToolFailure.messageFingerprint,
          intendedKind: toolFailureKind,
          reporters: [id.ownerId],
          firstSeenAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
          report: args.toolFailure,
          ...(normalizedToolFailure.direct ? { directEvidence: true } : {}),
          // Recorded so a later audit can count every suppressed duplicate by
          // class id, and so the suppression is visible on the row itself
          // rather than being an invisible server-side decision.
          ...(normalizedToolFailure.knownExternal
            ? {
                knownExternal: {
                  id: normalizedToolFailure.knownExternal.id,
                  docSlug: normalizedToolFailure.knownExternal.docSlug,
                  // The reporter DID attest direct evidence; we declined to act
                  // on it. Keep that fact — it is the audit trail for the
                  // suppression, and the signal that would justify escalating.
                  attestedDirect:
                    args.toolFailure?.reproduced === true ||
                    args.toolFailure?.clearServerMismatch === true ||
                    args.toolFailure?.hardInternal === true ||
                    args.toolFailure?.directEvidence !== undefined,
                },
              }
            : {}),
        }
      : undefined;
    try {
      const persist = () =>
        captureImprovement({
          title: captureText.title,
          kind: effectiveKind,
          // Agent-facing door: poor scorecard ratings must carry a disposition
          // (remediation ref or explicit disregard) — owner-directed 2026-08-31.
          enforcePoorRatingDisposition: true,
          body: bodyWithStaleness,
          severity: args.severity as IssueSeverity | undefined,
          subTopic: args.subTopic,
          scope: captureScope,
          foundDuring,
          paths: args.paths,
          force: args.force,
          checkDuplicatesOnly: args.checkDuplicatesOnly,
          requireCompleteDedupCoverage,
          origin: captureOrigin,
          lane: effectiveLane,
          watchdogKey: captureWatchdogKey,
          payloadExtra:
            observation || hasIdeation || toolFailureProbation || runtimeProvenance || targetRuntimeSha
              ? {
                  ...(observation ? { observation } : {}),
                  ...(hasIdeation ? { ideation } : {}),
                  ...(toolFailureProbation ? { toolFailureProbation } : {}),
                  ...(runtimeProvenance ? { runtimeProvenance } : {}),
                  ...(targetRuntimeSha
                    ? {
                        freshnessEnvelope: targetFreshnessEnvelope({
                          now: targetRuntimeObservedAt ?? new Date().toISOString(),
                          targetSha: targetRuntimeSha,
                          targetVersion: runtimeProvenance?.observedTargetRuntime.version,
                          reporterSession: id.ownerId,
                          toolSchemaVersion: args.toolFailure?.schemaRevision ?? null,
                        }),
                      }
                    : {}),
                }
              : undefined,
          createdBy: id.ownerId,
          // WI-2140701 (b): the concrete workspace the goal-provenance stamp resolves
          // the creator's goal in — same resolution as every other workspace-keyed
          // side effect in this handler.
          workspaceId: resolveConcreteWorkspaceId(id.workspaceId, ctxWorkspace),
          // Fresh agent change/feature captures are born outside the claimable pool. The
          // core parks them blocked before this wrapper performs the post-create review
          // enrollment, closing the durable-create → review race.
          reviewRequired,
          reviewHarness,
          // WI-5950: resolve the 'self' literal here (same seam work_items:create uses) so the
          // core always receives a concrete ownerId and never has to know about caller identity.
          ...(resolvedAssignee
            ? {
                assignee: resolvedAssignee,
                setCheckpoint: async (workItemId: string, checkpoint: string) => {
                  const scopedHarness = captureScope?.startsWith('harness:')
                    ? captureScope.slice('harness:'.length)
                    : ctxHarness;
                  await setWorkItemCheckpoint(
                    {
                      harness: scopedHarness ?? null,
                      workItemId,
                      workspaceId: resolveConcreteWorkspaceId(ctxWorkspace),
                    },
                    checkpoint,
                  );
                },
              }
            : {}),
          filedByRole,
          source,
        });
      const drainHarness = captureScope?.startsWith('harness:') ? captureScope.slice('harness:'.length) : ctxHarness;
      if (drainMode && !args.checkDuplicatesOnly && !drainHarness) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                created: false,
                error: 'drain_flow_unavailable',
                message:
                  'DRAIN bug admission failed closed because no concrete harness was available for the exact flow oracle.',
              }),
            },
          ],
        };
      }
      // A checkDuplicatesOnly call cannot persist, so it remains available even
      // while the admission circuit is open. Every real DRAIN bug write is
      // serialized through the exact flow gate before capture-core may mutate.
      const gated =
        drainMode && !args.checkDuplicatesOnly
          ? await withDrainBugAdmission(
              {
                workspaceId: id.workspaceId ?? ctxWorkspace ?? 'default',
                harness: drainHarness!,
                ownerId: id.ownerId,
                drainStartedAt: drainMode.setAt,
              },
              () => persist(),
            )
          : null;
      if (gated && !gated.allowed) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                created: false,
                error: gated.code,
                message: gated.message,
                ...('flow' in gated ? { drainFlow: gated.flow } : {}),
              }),
            },
          ],
        };
      }
      const result = gated ? gated.value : await persist();
      // Directed @-mention — only when we actually CREATED a claimable item (not a
      // checkDuplicatesOnly probe / coalesced row / observation-lane reflection).
      const captured = result as { created?: boolean; issue?: { id: string; title?: string } };
      // su-loop-capability-parity P-005 (D-009): an SU session's IDEATE-pass FEATURE origination
      // earns a routed-ledger provenance row (origin='su-ideate') so it rides the SAME
      // grade/outcome/priming machinery Scout's ideas do — WITHOUT skewing Scout's per-lens
      // weight learning (the lens readers filter origin='scout'). Fires only for an su caller's
      // freshly-created kind:'feature' (not the watchdog, not an observation, not a
      // check-only probe or coalesced row).
      // Fully guarded + best-effort: a ledger hiccup must NEVER fail the capture the user asked for.
      if (
        source === 'su' &&
        args.kind === 'feature' &&
        args.lane !== 'observation' &&
        captured.created &&
        captured.issue?.id
      ) {
        const featureId = captured.issue.id;
        const ledgerHarness =
          ctxHarness ?? (captureScope?.startsWith('harness:') ? captureScope.slice('harness:'.length) : 'papercusp');
        try {
          await recordRoutedIdea({
            origin: 'su-ideate',
            createdBy: id.ownerId, // originator join key: grade→revise wakes + scope:'mine' reads (migration 558)
            ideaId: featureId,
            // P-002: the caller-declared su ideation lens, else the 'su-ideate' sentinel. Either
            // way the row is origin-partitioned OUT of Scout's lens learning (D-009 / D-002).
            lens: args.ideation?.lens ?? 'su-ideate',
            rail: 'improvement',
            routedRef: `wi:${featureId}`,
            harnessSlug: ledgerHarness,
            title: captured.issue.title ?? captureText.title,
            // EI-10607: the pattern refs this idea grounds on — the ONE field that lets an
            // su idea appear as `grounded` in observationsImpact. Omitted when the caller
            // declared none, so the row shape is unchanged for an ungrounded filing.
            ...(args.ideation?.addressesPatternRefs?.length
              ? { addressesPatternRefs: [...args.ideation.addressesPatternRefs] }
              : {}),
          });
        } catch {
          // best-effort provenance — never affects the capture the user requested
        }
      }
      // abolish-human-review D-003/P-004: every freshly-created local change/feature
      // enters the existing Blender-backed agent-review lifecycle. This deliberately
      // runs AFTER the su-ideate provenance bridge above: enterAgentReview records with
      // preserveExisting:true, so an su feature keeps its origin, lens, grounding refs,
      // and creator instead of being overwritten by the routing-only agent-review row.
      // Unlike optional ideation provenance, enrollment is required for queue safety:
      // letting this fail silently would leave the created item visible to ordinary
      // implementation selectors before any peer approved it.
      let agentReview: Awaited<ReturnType<typeof enterAgentReview>> | undefined;
      let agentReviewFailure: AgentReviewFailure | undefined;
      const reviewResult = result as {
        reviewRequired?: boolean;
        reviewState?: 'blocked';
        agentReviewFailure?: AgentReviewFailure;
      };
      const canEnrollReview = Boolean(
        reviewResult.reviewRequired &&
        reviewResult.reviewState === 'blocked' &&
        !reviewResult.agentReviewFailure &&
        captured.created &&
        captured.issue?.id,
      );
      if (canEnrollReview && captured.issue?.id) {
        let enrollmentSucceeded = false;
        const recordReviewFailure = async (phase: AgentReviewFailure['phase'], error: unknown) => {
          const failure: AgentReviewFailure = {
            phase,
            message: error instanceof Error ? error.message : String(error),
            at: new Date().toISOString(),
          };
          // The core already parks the row before enrollment. Re-assert the park on
          // every post-create failure because enterAgentReview may have partially
          // mutated the payload before throwing, and a failed reopen leaves state
          // uncertain. Both cleanup legs are best-effort: the committed capture and
          // the failure metadata must still be returned to the caller.
          await setCaptureReviewState(captured.issue!.id, 'blocked', {
            harness: reviewHarness,
            by: id.ownerId,
            reason: `agent-review-${phase}-failed`,
          }).catch(() => undefined);
          await recordCaptureReviewFailure(captured.issue!.id, failure, {
            submittedBy: id.ownerId,
            harness: reviewHarness,
          }).catch(() => undefined);
          agentReviewFailure = failure;
        };

        try {
          const enrolled = await enterAgentReview({
            id: captured.issue.id,
            submittedBy: id.ownerId,
            harnessSlug: reviewHarness,
            workspaceId: resolveConcreteWorkspaceId(id.workspaceId, ctxWorkspace),
          });
          if (!enrolled.entered) {
            throw new Error(`agent-review enrollment was not entered${enrolled.reason ? `: ${enrolled.reason}` : ''}`);
          }
          enrollmentSucceeded = true;
          const reopened = await setCaptureReviewState(captured.issue.id, 'open', {
            harness: reviewHarness,
            by: id.ownerId,
            reason: 'agent-review enrollment succeeded',
          });
          const appliedState = reopened?.appliedState ?? reopened?.workItem?.state;
          if (appliedState !== 'open') {
            throw new Error(`review reopen did not apply open state (appliedState=${appliedState ?? 'null'})`);
          }
          agentReview = enrolled;
        } catch (error) {
          const phase: AgentReviewFailure['phase'] = enrollmentSucceeded ? 'reopen' : 'enrollment';
          await recordReviewFailure(phase, error);
        }
      }
      // WI-3594 (scorecard→improvement flow): link a freshly-filed GRADE filing to
      // its named follow-up work-items AT FILE TIME, so a scorecard's motivating
      // improvement is never a separate round-trip someone forgets to make. Fires
      // only when the caller passed observation.linkTo AND an item was actually
      // created (not a coalesced/check-only result). Best-effort per target: one bad targetId
      // never fails the capture, and a partial failure is reported (not silent).
      let linked: { targetId: string; ok: boolean; error?: string }[] | undefined;
      if (observation?.linkTo?.length && captured.created && captured.issue?.id) {
        const sourceId = captured.issue.id;
        linked = await Promise.all(
          observation.linkTo.map(async (l) => {
            try {
              const dst = await resolveWorkItemRef(l.targetId, l.targetHarness);
              if (!dst) return { targetId: l.targetId, ok: false, error: `work_item '${l.targetId}' not found` };
              await linkIssue(sourceId, dst, l.rel ?? 'relates', id.ownerId);
              return { targetId: l.targetId, ok: true };
            } catch (e) {
              return { targetId: l.targetId, ok: false, error: e instanceof Error ? e.message : String(e) };
            }
          }),
        );
      }
      // P-008 (su-ideate-learning-substrate): REPORT-ONLY novelty pre-check on the su
      // IDEATE-pass feature path — the same eligibility as the ledger row, but independent
      // of creation (a duplicate-annotated / checkDuplicatesOnly response benefits too). Surfaces
      // the priors the title collides with (plans / decisions / routed-ledger ideas, incl.
      // already-decided "tried, failed" ones) as response.priorArt. NEVER a gate (D-005):
      // normal filings are accepted; checkDuplicatesOnly is the explicit non-persisting path,
      // and a failed check just omits the field (absent = not checked; [] = checked, nothing similar).
      const priorArtRaw =
        source === 'su' && args.kind === 'feature' && args.lane !== 'observation'
          ? await noveltyPriorArt(captureText.title).catch(() => undefined)
          : undefined;
      // The su-ideate ledger bridge above inserts THIS filing's own row (wi:<id>)
      // BEFORE this read, so the corpus contains the filing itself — a similarity-1.0
      // self-match is not prior art (it reads as a false "already tried"). Filter it
      // (audit find 2026-07-11, first surfaced on the EI-9694 filing). [] semantics
      // preserved: checked-nothing-similar.
      const selfId = captured.issue?.id;
      const priorArt = selfId ? priorArtRaw?.filter((p) => p.ref !== `wi:${selfId}` && p.ref !== selfId) : priorArtRaw;
      const notified =
        args.notifyAgents?.length && captured.created && captured.issue?.id && effectiveLane !== 'observation'
          ? await notifyAgents(id, {
              addressees: args.notifyAgents,
              objectRef: issueRef(captured.issue.id),
              summary: `🔖 ${id.ownerLabel} tagged you on ${captured.issue.id}: ${(captured.issue.title ?? captureText.title).slice(0, 80)}`,
              body:
                `${id.ownerLabel} tagged you on improvement ${captured.issue.id}: ${captured.issue.title ?? captureText.title}` +
                (captureText.body ? `\n\n${captureText.body.slice(0, 600)}` : '') +
                `\n\n— it's on your radar: work_items:get ${captured.issue.id} (comment / claim there).`,
              harnessSlug: captureScope?.startsWith('harness:') ? captureScope.slice('harness:'.length) : undefined,
            }).catch(() => null)
          : null;
      // P-007/D-010: report-only cheapExperiment gap (see describeExperimentGap above).
      // Computed from the CALLER's args, so a duplicate-annotated / checkDuplicatesOnly
      // response carries it too.
      const experimentGap = describeExperimentGap(args);
      // WI-38065: report-only lens-attribution advisory (see describeLensAttribution above).
      // Same caller-args basis as experimentGap, so a duplicate-annotated response carries it too.
      const lensAttribution = describeLensAttribution(args, source);
      // P-006/EI-10607: report-only grounding advisory (see describeGroundingGap above).
      const groundingGap = describeGroundingGap(args, source);
      // EI-19390763763662489: work-item dedup cannot establish absence from shipped code.
      // Reuse the claim-time detector and report the missing code-search leg exactly when an
      // absence-shaped filing received an explicit empty duplicate set. Tool-failure reports
      // have their own structured classifier/probation path and may quote error prose, so they
      // are deliberately excluded from this proposal-specific advisory.
      const shippedCodeSearch = normalizedToolFailure
        ? undefined
        : describeShippedCodeSearchGap(
            { title: captureText.title, body: bodyWithStaleness, lane: effectiveLane },
            result.possibleDuplicates,
          );
      const warnings = [
        ...(foundDuringTruncated
          ? [
              `foundDuring was ${args.foundDuring!.length} chars — truncated to ${LIMITS.LABEL}. ` +
                'It is a short provenance label, not a body; put the detail in `body`.',
            ]
          : []),
        ...(scopeResolution.warning ? [scopeResolution.warning] : []),
      ];
      // ── EI-19908952124502298: dangling-ref advisory, same helper `comment`/`complete`/
      // `update`/`checkpoint` carry. Scoped to a capture that actually CREATED a row:
      // on a coalesced row or checkDuplicatesOnly probe no new body is stored under an id,
      // so there is no new durable text for a later reader to be misled by. `known` carries
      // the freshly-minted id so a self-citation is never reported as phantom.
      const capturedRefSubject = captured.created ? captured.issue?.id : undefined;
      const capturedUnresolvedRefs = capturedRefSubject
        ? await unresolvedRefsInBody([captureText.title, bodyWithStaleness].filter(Boolean).join('\n'), {
            known: [capturedRefSubject],
          })
        : undefined;
      const capturedUnresolvedRefsWarning =
        capturedRefSubject && capturedUnresolvedRefs
          ? unresolvedRefsWarning(capturedRefSubject, capturedUnresolvedRefs.missing)
          : undefined;
      const publicResult = silenceUnkeyedObservationDisposition ? { ok: true as const } : result;
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ...publicResult,
              ...(!silenceUnkeyedObservationDisposition && priorArt ? { priorArt } : {}),
              ...(!silenceUnkeyedObservationDisposition && experimentGap ? { experimentGap } : {}),
              ...(!silenceUnkeyedObservationDisposition && lensAttribution ? { lensAttribution } : {}),
              ...(!silenceUnkeyedObservationDisposition && groundingGap ? { groundingGap } : {}),
              ...(!silenceUnkeyedObservationDisposition && shippedCodeSearch ? { shippedCodeSearch } : {}),
              ...(!silenceUnkeyedObservationDisposition && capturedUnresolvedRefsWarning
                ? { unresolvedRefsWarning: capturedUnresolvedRefsWarning }
                : {}),
              ...(!silenceUnkeyedObservationDisposition && agentReview ? { agentReview } : {}),
              ...(!silenceUnkeyedObservationDisposition && agentReviewFailure ? { agentReviewFailure } : {}),
              ...(!silenceUnkeyedObservationDisposition && notified ? { notified: notified.notified } : {}),
              ...(!silenceUnkeyedObservationDisposition && linked ? { linked } : {}),
              // The filer sees the skew warning too, not just the later triager —
              // they are the one still holding the repro and can settle it now.
              ...(!silenceUnkeyedObservationDisposition && stalenessHint ? { possiblyStaleSchema: stalenessHint } : {}),
              ...(!silenceUnkeyedObservationDisposition && pathStalenessHint
                ? { staleCodeWarning: pathStalenessHint }
                : {}),
              ...(warnings.length > 0 ? { warnings } : {}),
            }),
          },
        ],
      };
    } catch (err) {
      // A bounded admin-pool transaction that exhausts its contention budget is
      // retryable and should not degrade into a generic MCP handler_error.
      if (err instanceof OrgTxnTimeoutError) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: 'timeout',
                retryable: true,
                pgCode: err.pgCode,
                message:
                  `improvements:capture write hit transient database contention (${err.pgCode}): ${err.message}. ` +
                  'No improvement was captured; retry now.',
              }),
            },
          ],
        };
      }
      // Surface a rubric-rating contract violation (missing evidence / rubricRef)
      // as a clean tool error instead of an opaque throw (D-002 evidence gate).
      if (err instanceof ObservationEvidenceError) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: err.message }) }] };
      }
      throw err;
    }
  },
});
