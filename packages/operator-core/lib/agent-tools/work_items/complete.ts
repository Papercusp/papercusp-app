/**
 * work_items:complete — the STRUCTURED completion op
 * (coord-lifecycle-automation-2026-06-04 D-004, "stop narrating, emit structure").
 *
 * The single biggest token + signal win of the plan: instead of finishing a
 * unit of work and hand-writing a prose `coord:send`
 *   "F-12 BUILT+TESTED, migration 137, 40 tests, deferred X/Y…",
 * an agent calls `work_items:complete { id, completion: {…structured fields…} }`.
 * The completion event (D-002 `emits` on this tool) renders the coord
 * notification from the structured record via the pure render layer and fires
 * `coord:emit` — the agent spends zero tokens narrating, and NOTHING is lost
 * (the deferred-set especially is carried structurally, D-006).
 *
 * State transition is explicit (`state`) so this never silently steps on the
 * validator/reviewer pipeline's own status semantics. A record-only completion
 * must explicitly opt in with `recordOnly:true` when it omits `state`.
 *
 * The `emits` rule is registered separately (../../coord-lifecycle/lifecycle-rules)
 * so the render-layer import stays out of the hot tool dispatch path; it fires
 * on `work_items:complete` and reads `result.completion`.
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): complete ONE inline
 * ({ id, completion }) or MANY (items:[{ id, completion, state?, harness? }]) →
 * { ok, results:[{ ok, id, workItem, completion, reflect, stateError? } | { ok:false,
 * id, error }], counts }. Each completion record is per-item (there is no shared-
 * record homogeneous form). The completion emit + plan-item reflect fire per item
 * (D-007), so a bulk complete broadcasts N completion notifications, one per item.
 */

import { z } from 'zod';
import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as nodePath from 'node:path';
import { detectPapercupRoot } from '../../harness/register-papercusp';
import { HARVESTED_COORD_NOTES_RULE } from '../../harness/improvements/observation-title-guidance';
import { loadHarnessRegistry, resolveHarnessContentPath, type HarnessRegistry } from '../../harness-registry';
import {
  assumptionsArg,
  ASSUMPTIONS_REQUIRED_MESSAGE,
  normalizePersistedAssumptionDeclaration,
  resolveDeclaredAssumptions,
  TERMINAL_CLOSE_RECOVERY_HINT,
} from './_assumptions';
import { nonAssumptionKindAdvisory } from '../../agent-facts/assumptions';
import type { StoredAssumptionDeclaration } from '../../coord-lifecycle/records';
import { defineTool, type UnifiedToolContext } from '@papercusp/agent-mcp';
import { resolveAgentIdentity, deriveFleetMembership } from '../coordination/identity';
import { getPresence } from '../coordination/presence';
import { WORK_ITEM_LIFECYCLE_ROLES } from '../coordination/roles';
import { objectSelector } from '../coordination/audience';
// Imported from the LEAF module, not from '../../work-items': this file's unit tests
// mock that module wholesale, which would make the guard `undefined` exactly here.
import { harnessScopeMismatch } from '../../work-items-harness-scope';
import { potHomeSlugForHarness } from '../../hive-federation';
// Same LEAF-module rule as the line above (EI-21919769900781478): imported from the
// standalone module, not from '../../work-items', which this file's unit tests mock
// wholesale — the guard would be `undefined` exactly here.
import { lookupRemoteAuthorEndedAt } from '../../work-items-orphan-author';
// Same LEAF-module rule as the line above (EI-22189521072988065): imported from the
// standalone module, not from '../../work-items', which this file's unit tests mock
// wholesale — the guard would be `undefined` exactly here.
import { decideTerminalOwnerOriginHeal } from '../../work-items-terminal-owner-origin-heal';
import {
  getWorkItem,
  getWorkItemsByIds,
  setWorkItemStateWithAliasInfo,
  setWorkItemClaimHold,
  workItemObjectRef,
  mergeWorkItemOutputPayload,
  resolveWorkItemRef,
  linkWorkItem,
  subscribeWorkItem,
  SETTLED_WORK_ITEM_STATES,
  attachCompletionEvidenceToSettledItem,
  commentWorkItem,
  type TerminalCompletionConflict,
} from '../../work-items';
import {
  CompletionRecordSchema,
  COMPLETION_COVERAGE_CONTRACT,
  COMPLETION_SETTLEMENT_MANIFEST_CONTRACT,
  ROOT_CAUSE_VERIFICATION_CONTRACT_VERSION,
  ROOT_CAUSE_SUCCESSFUL_CLOSE_STATES,
  missingRootCauseVerificationV2Fields,
  hasEnumeratedVerificationCoverage,
  hasMalformedCoverageShape,
  residueCitations,
  unownedResidueRefs,
  stripNulBytesDeep,
  CHECKPOINT_PROSE_SNAPSHOT_MAX_CHARS,
  type CompletionCoverage,
  type CompletionRecord,
  type CompletionTreeStamp,
  type PersistedCompletionEvidence,
  type CompletionVerificationEvidence,
} from '../../coord-lifecycle/records';
import {
  committedCloseDowngradedForUnprovenContentIdentity,
  completionSettlementManifest,
  completionTreeStamp,
  completionTreeStampForEvidence,
  unresolvableContentIdentityPaths,
  unprovenContentIdentityPaths,
  describeUnprovenContentIdentity,
} from './completion-freshness';
export { completionSettlementManifest, completionTreeStamp, completionTreeStampForEvidence };
export type { CompletionTreeStampProbe, CompletionTreeStampForEvidenceProbe } from './completion-freshness';
import { claimsRemediation, evaluateCloseTerminalCriteria } from './terminal-criteria';
import { acquireWithContentionRetry } from '../locks/contention-retry';

// EI-22361433147291495: completion validation + convergence legitimately took
// 61.8s in the proxy continuation lane. Declare the established long-handler
// budget so the MCP transport uses 125s (timeout + its 5s buffer) instead of
// cutting the idempotent mutation off at the flat 55s boundary.
export const WORK_ITEMS_COMPLETE_TIMEOUT_SEC = 120;

/**
 * One versioned definition for the handler's completion-requirement set. The
 * validator below keys every result to these entries, and validation-only
 * responses return the same definition instead of maintaining a second prose
 * contract that can drift from runtime.
 */
export const WORK_ITEMS_COMPLETION_CONTRACT = {
  version: 'work-items-completion-v2',
  requirements: [
    { key: 'assumptions', description: 'Terminal closes declare assumptions or explicitly declare none.' },
    { key: 'root-cause-verification', description: 'Successful defect closes carry complete causal evidence v2.' },
    { key: 'spec-test-adequacy', description: 'Affected first-class specs have current independently audited proof.' },
    { key: 'design-evidence', description: 'Enforced ratified design cases have current passing evidence.' },
    {
      key: 'verification-coverage',
      description: 'Universal verification claims enumerate a complete population partition.',
    },
    { key: 'self-review', description: 'Pilot self-review evidence is present and ledger-visible when applicable.' },
    { key: 'gate-red-lineage', description: 'A claimed red-gate repair is admitted on the judged lineage.' },
  ],
} as const;
type CompletionContractRequirementKey = (typeof WORK_ITEMS_COMPLETION_CONTRACT.requirements)[number]['key'];

/**
 * EI-22166138797743784: completion settlement is local-only. A proposed close whose
 * content identity is merely waiting for this install's git-sync can converge without
 * another completion call; a remote-authored row must not receive that same advice because
 * its originating author/federation writer owns the commit and settlement authority.
 */
export function contentIdentityAdviceForOrigin(
  origin: string | null | undefined,
  createdBy: string | null | undefined,
  localAdvice: string | undefined,
): string | undefined {
  if (origin !== 'remote') return localAdvice;
  return (
    `This row is REMOTE-AUTHORED${createdBy ? ` by '${createdBy}'` : ''}; this install's ` +
    `git-sync completion-settlement reconciler cannot upgrade it. The originating authoring ` +
    `peer or federation writer owns the committed-content proof and must settle the close; ` +
    `do not re-call \`work_items:complete\` locally.`
  );
}
import { isBackedLiveDroveUiClaim, isBackedLiveServiceClaim, verifyLiveDroveUiArtifacts } from '../../completion-audit';
import {
  liveDriveAcceptanceGap,
  liveDriveAcceptanceMessage,
} from '../../turn-provenance/owner-visible-surface-acceptance';
import {
  authorityForCompletion,
  countsTowardBurnDown,
  insufficientEvidenceReason,
  reconcileStampedAuthority,
  type CompletionAuthorityFrom,
  type CompletionEvidenceFindings,
} from '../../work-item-completion-authority';
import { evaluateCompletionClaims, repoSourceReader, type CompletionClaimsReport } from '../../completion-claims';
import { completionClaimBaseline } from '../../completion-claim-recheck';
import { fabricatedPathsInCompletion } from './fabricated-paths';
import { untouchedPathsInCompletion } from './untouched-paths';
import { requirementDispositionShortfall } from './requirement-disposition';
import {
  MAX_TEST_BINDING_LOOKBACK_MS,
  testResultContradictedByRun,
  type TestRunLedgerRow,
  type TestingRunInvocation,
} from './test-result-binding';
import { gateRedCompletionClaimVerdict, gateRedCompletionClaimWarning } from '../../release/gate-red-completion-claim';
import { GATE_RED_STREAK_CONDITION_PREFIX } from '../../work-items-admission';
import { FROZEN_REPAIR_CONVERGENCE_CONDITION_PREFIX } from '../../coord/actionable-conditions';
import { renderCompletion } from '../../coord-lifecycle/render';
import { renderReflectStep } from '../../harness/improvements/friction-markers';
import { runBulk, bulkContent, type BulkItemResult } from '../_bulk';
import { shapeWorkItemWriteEcho } from './write-echo-shape';
import {
  COMPLETION_OBJECT_EXAMPLE,
  COMPLETION_STRING_REJECTION,
  coerceCompletionShape,
  gatherFlatCompletion,
  hoistMisplacedCompletionFields,
} from './completion-coerce';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { withBoundedTimeout } from '../../bounded-timeout';
import { getOrgPg } from '@papercusp/db-org';
import {
  itemIsArmB,
  judgeSelfReview,
  selfReviewAgentVisibilityQuery,
  selfReviewLedgerQuery,
  selfReviewRefusal,
  toPersistedSelfReviewJudgement,
  toSelfReviewLedgerRow,
  type SelfReviewJudgement,
  type SelfReviewLedgerRow,
} from '../../work-item-self-review.js';
import { activeWorkspaceId, resolveConcreteWorkspaceId, workspacesRoot } from '../../workspace-registry';
import { resolveAdoptedName } from '../../plan-items/agent-names';
import { itemTestGate } from '../../harness-test-gate';
import { independentSiblingRepos } from '../../plan-audits';
import { checkoutRootForPath, discoverKnownHiveCheckoutRoots } from '../testing/run';
import { hasValidGitEntry } from '../locks/valid-git-entry';
import { FEATURE_TERMINAL_STATES, normalizeFeatureStateInput } from '../../work-item-dispatch-states';
import { getWorkItemCheckpoint, setWorkItemCheckpoint } from '../../work-item-checkpoint';
import { splitCarryNoteChecks, splitCarryNoteWalls } from '../../carry-note';
import { unresolvedRefsInBody, unresolvedRefsWarning } from './unresolved-refs';
import { fireReactionInProcess } from '../../events';
import { detectEphemeralDeliverableReferences, renderEphemeralDeliverableWarning } from '../../turn-end-tracking';
import {
  discoverSiblingTypecheckGates,
  gateCoveringFile,
  lastCommitTimes,
} from '../../../../../scripts/lib/tsc-baseline-gate.mjs';
import {
  isPlaneGapItem,
  preflightPlaneCloseLive,
  renderPlaneClosePreflightWarning,
} from '../../agent-plane-close-preflight';
import { evidenceCurrentInputSchema } from '../plans/spec-evidence-store';
import { isNonCodeWorkItemKind, PLAN_CLASS_RUBRIC_REFS } from '../plans/spec-test-adequacy';
import { specTestAdequacyCompletionGate } from './spec-test-adequacy-gate';
import { dispatchPendingGradingAudits } from '../../grading-integrity';
import {
  designEvidenceCompletionGate,
  designFeatureCandidates,
  renderDesignEvidenceRefusal,
} from './design-evidence-gate';
import { evaluateFeatureDesignGate } from '../../design-compare/feature-gate';
import { designCompareDepsFor } from '../../design-compare/host-install';
import { typeEvidenceGapInCompletion } from '../type-evidence-gap';
export { typeEvidenceGapInCompletion } from '../type-evidence-gap';
import { claimSubjectBaselineMismatches } from '../../claim-subject-baseline';
import { holderIsCaller } from '../../work-item-holder-identity';

// EI-7031: coerce structured LLM mis-shapes (scalar↔array swaps, missing summary)
// to the CompletionRecord contract BEFORE validation. A bare string is intentionally
// refused: converting it to `{ summary }` loses the caller's evidence shape and can
// close an item with authority:'proposed' without the caller realising it. JSON-object
// strings remain supported by coerceCompletionShape.
function defaultCompletionStatus(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  // Zod 4 publishes defaulted fields as required in JSON Schema. Supply the same
  // runtime default at the preprocess boundary, so the public override below can
  // honestly advertise status as optional without changing parsed completions.
  //
  // EI-15711: STAMP the fact that we defaulted it. Injecting `'done'` here makes an
  // omitted status byte-identical to an explicitly-passed `status:'done'` by the time
  // the handler runs, and the close inference below then has to exclude `'done'`
  // wholesale — so the one status word a caller is most likely to write by hand is the
  // one that cannot close their item. The ambiguity is manufactured HERE, one function
  // before it is felt, so it is cheapest to resolve HERE: record which branch we took
  // and the handler can honour an explicit `'done'` while still ignoring the default.
  return record.status === undefined ? { ...record, status: 'done', __statusDefaulted: true } : value;
}

const completionSpec = z
  .preprocess(
    (raw, ctx) => {
      const coerced = defaultCompletionStatus(coerceCompletionShape(raw));
      // A JSON-object string (including a recoverable truncated object) becomes an
      // object and continues through normal coercion. A prose/string value remains a
      // string, so reject it with the exact object-form repair example before Zod's
      // generic "expected object, received string" message can obscure the fix.
      if (typeof raw === 'string' && typeof coerced === 'string') {
        ctx.addIssue({ code: 'custom', message: COMPLETION_STRING_REJECTION });
      }
      return coerced;
    },
    CompletionRecordSchema.extend({
      workItem: z.string().min(1).optional(),
      // The preprocess above owns the default so Zod 4 does not publish this
      // defaulted field as required to completion callers.
      status: z.string().min(1).optional(),
      // EI-20724228359175431: 'truncated-json' marks a
      // JSON-stringified completion whose tail was cut off and whose closers were
      // rebuilt, so the caller can be told the record may be missing a field that
      // never arrived.
      __shapeCoercedFrom: z.literal('truncated-json').optional(),
      // EI-15711: internal marker set by the preprocess above when it supplied the
      // `status` default, so the close inference can tell an omitted status from an
      // explicit `status:'done'`. Stripped before the record is stored or broadcast,
      // exactly like __shapeCoercedFrom. `z.literal(true)` means a caller can only ever
      // make this MORE conservative (suppressing their own inference), never less.
      __statusDefaulted: z.literal(true).optional(),
    }),
  )
  .describe(
    // EI-23379068490085254: this string is serialized TWICE (the single `completion`
    // shorthand and every `items[].completion`), so each byte here is paid twice on
    // every tools/list. It therefore carries ONLY rules the structure cannot express.
    // Deliberately NOT restated: the field/type enumeration (published in this schema's
    // own `properties` — and the hand-copy that stood here had already drifted 9 fields
    // behind), `verifiedHow`'s label list and the residue rule (each field's own
    // `.describe()` owns those), the rootCauseVerification key list (its own subschema),
    // and a second copy of the object example (COMPLETION_STRING_REJECTION ends with it).
    'Structured completion record; its fields and types are published in this schema. ' +
      // The three wrong-key literals are spelled in full ON PURPOSE: complete.test.ts
      // asserts each one, and they are what a caller greps for after a strict-key refusal.
      '`completion.verification` is strict: put test/typecheck/diff details in `testsRun`/`testResult`, ' +
      'not `verification.tests`, `verification.typecheck`, or `verification.diff`. Put structured evidence under ' +
      '`completion.verification`; the top-level evidence fields are legacy aliases. Keep `deferred` ' +
      'and `coordNotes` at the completion level, not inside `verification`. ' +
      // The two live-mode ARTIFACT requirements are enforced at close time and are stated
      // nowhere else; `verifiedHow`'s own describe defines the labels but not these floors.
      "For a terminal close, `verifiedHow:'live-drove-ui'` requires a real artifact citation in " +
      '`summary`, `testsRun`, `testResult`, or `filesChanged` — DESKTOP: a screenshot/capture image ' +
      'path retained outside session scratch, or a recorded `tauri-agent-tools` capture/screenshot/check invocation; WEB: the deployed ' +
      'URL with its HTTP status, or a recorded browser-driver run (playwright/puppeteer/verdict) naming ' +
      "the http(s) target it drove. `verifiedHow:'live-service'` requires `testsRun`/`testResult` to " +
      'jointly name the concrete service/unit/process and a falsifiable runtime observation (`MainPID`, ' +
      '`NRestarts`, `ActiveState`, or an HTTP status). Use ' +
      "'unit'/'manual'/'integration' when no live artifact or runtime process was inspected. " +
      // observation-and-recall-surface-honesty-2026-08-16 P-001: coordNotes is the second
      // input to checkpoint-harvest, so it carries the same first-line-is-the-title rule as
      // loop:checkpoint { insight }. Shared constant, never re-worded here — the guard test
      // asserts every harvest-fed surface still names it.
      `${HARVESTED_COORD_NOTES_RULE} ` +
      // EI-39573: publish the same repair shape that the schema-level string refusal returns.
      `A bare STRING is rejected because it cannot carry structured evidence. ${COMPLETION_STRING_REJECTION} ` +
      'Bug/capability-gap terminal closes also require `rootCauseVerification` (its own schema lists the keys).',
  )
  // EI-23318249512516833: the completion record is reused by both single-item
  // branches and each `items[]` entry. Register it once so tools/list emits one
  // `$defs` entry and refs rather than copying the full nested record per branch.
  .meta({ id: 'work-items-completion-record-v1' });

const SPEC_ADEQUACY_CURRENTNESS_GUIDANCE =
  '`specAdequacy.current` entries use `{ planSlug?, specId?, specRevision?, specFingerprint?, evidenceKind, evidenceRef, sourceFingerprint, testFingerprint?, fixtureFingerprint?, rubricFingerprint?, environmentFingerprint? }`; provide one entry for every selected bound evidence ref (`specAdequacy.evidenceRefs` narrows the selection; when omitted, use all bound refs) and every stored fingerprint dimension. `planSlug`, `specId`, `specRevision`, and `specFingerprint` are an all-or-none clause identity; omitted values remain unknown and cannot pass.';

const specAdequacyCompletionSpec = z
  .object({
    classRef: z
      .enum(PLAN_CLASS_RUBRIC_REFS)
      .describe('Existing plan-class standard that determines the required proof floor.'),
    evidenceRefs: z
      .array(z.string().trim().min(1).max(2000))
      .min(1)
      .max(500)
      .optional()
      .describe(
        'Exact immutable evidence identities to grade. Use this to exclude superseded run-specific bindings without deleting history; include every relied-on ref across the enforced clauses.',
      ),
    /** Immutable clause pin copied from a persisted evaluator rerun recipe. */
    specRevision: z.number().int().positive().optional(),
    specFingerprint: z.string().trim().min(1).max(256).optional(),
    /** Reuse the persisted evaluator snapshot instead of re-measuring repository files. */
    replaySnapshot: z.boolean().optional(),
    current: z
      .array(evidenceCurrentInputSchema.strict())
      .max(500)
      .optional()
      .describe(
        `Current fingerprints for the exact bound evidence refs. ${SPEC_ADEQUACY_CURRENTNESS_GUIDANCE}`,
      ),
  })
  .strict()
  .superRefine((attestation, ctx) => {
    if ((attestation.specRevision === undefined) !== (attestation.specFingerprint === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['specRevision'],
        message: 'specRevision and specFingerprint must be supplied together for an immutable clause pin',
      });
    }
    const currentWithClauseIdentity = (attestation.current ?? []).filter(
      (current) =>
        current.planSlug !== undefined &&
        current.specId !== undefined &&
        current.specRevision !== undefined &&
        current.specFingerprint !== undefined,
    );
    const allCurrentRowsHaveClauseIdentity =
      attestation.current !== undefined &&
      attestation.current.length > 0 &&
      currentWithClauseIdentity.length === attestation.current.length;
    const currentClauseVersions = new Set(
      currentWithClauseIdentity.map((current) => `${current.specRevision}:${current.specFingerprint}`),
    );
    const hasSingleClausePin =
      attestation.specRevision !== undefined && attestation.specFingerprint !== undefined;
    if (
      attestation.replaySnapshot === true &&
      !hasSingleClausePin &&
      !allCurrentRowsHaveClauseIdentity
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['replaySnapshot'],
        message:
          'replaySnapshot requires specRevision and specFingerprint, or full clause identity on every current[] row',
      });
    }
    if (attestation.replaySnapshot === true && hasSingleClausePin && currentClauseVersions.size > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['specFingerprint'],
        message:
          'a single replay clause pin cannot cover multiple current[] clause revisions; omit it and provide full clause identity on every current[] row',
      });
    }
    if (
      attestation.replaySnapshot === true &&
      hasSingleClausePin &&
      currentWithClauseIdentity.some(
        (current) =>
          current.specRevision !== attestation.specRevision ||
          current.specFingerprint !== attestation.specFingerprint,
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['specFingerprint'],
        message: 'the top-level replay clause pin must match every fully scoped current[] row',
      });
    }
  })
  .describe(
    'Required on a terminal close that covers active test-requiring spec clauses. The gate recomputes per-clause adequacy over the optional exact evidenceRefs selection and accepts only exact current terminal scorecards whose grading audit is settled. A single-clause replay supplies specRevision + specFingerprint; a multi-clause replay supplies full clause identity on every current[] row with replaySnapshot:true.',
  )
  // Same reuse as the completion record above, and the same fix: this attestation is
  // reached from both the single-item branch and each `items[]` entry, so without an id
  // tools/list copies the whole nested record per branch instead of emitting one `$defs`
  // entry and two refs. MEASURED 1,591 B off this tool's compact definition — which is
  // what puts the derived OMP/claude/codex seed back under D-009's 100,000 B budget
  // (it was 100,189 B, floors alone, with nothing discretionary left to defer).
  .meta({ id: 'work-items-spec-adequacy-attestation-v1' });

/**
 * ⚠ BOTH call sites MUST share THIS ONE instance — do not re-spell
 * `specAdequacyCompletionSpec.optional()` per site.
 *
 * `strictArgs`' `deepStrictifyInPlace` (define-tool.ts) returns a NEW `.strict()` clone for
 * every `object` node it visits and re-applies that node's registry metadata to the clone,
 * and it deliberately re-visits a shared reference once per PATH it is reached from. Two
 * separate `.optional()` spellings are two paths to this object, so it would be cloned
 * twice, both clones would carry the id above, and Zod aborts the conversion of the WHOLE
 * catalog with `Duplicate schema id … Two different schemas cannot share the same id`.
 *
 * Every non-object node (`optional` here) is instead mutated IN PLACE and returned as the
 * same instance, so sharing one `.optional()` wrapper collapses both paths onto a single
 * object instance — one `$defs` entry, two `$ref`s. (An id placed BEFORE `.strict()` does
 * not survive either: `.strict()` drops registry metadata.)
 */
const specAdequacyCompletionField = specAdequacyCompletionSpec.optional();

/**
 * EI-5269 / EI-18127483322976472: the canonical terminal states across BOTH families
 * (feature: passed/deprecated; issue: resolved/closed) — and, post work-item-status-full-unify
 * (2026-07-19), their UNIFIED representations (done/dropped) that the issue-family write path
 * (ISSUE_STATE_ALIASES) now actually persists (resolved→done, closed→dropped). A completion
 * that leaves the item in ANY other state has NOT closed it, so the row stays claimable +
 * reclaimable.
 *
 * MUST be sourced from work-items.ts's `SETTLED_WORK_ITEM_STATES` (the single source of
 * truth for "this work_item is done, one way or another") rather than a locally-duplicated
 * literal list: a stale local copy that omits 'done'/'dropped' is exactly what caused this
 * receipt to report "COMPLETION RECORDED, BUT ... DID NOT CLOSE" for a change/issue-family
 * completion that had, in fact, already landed terminal as 'done' — the pre-alias name list
 * disagreeing with the family's actual post-alias terminal representation.
 */
const TERMINAL_WORK_ITEM_STATES = new Set<string>(SETTLED_WORK_ITEM_STATES);

/**
 * WI-4529: states a caller passes MEANING "close this" — the true terminals PLUS the common
 * close-synonyms the alias layer silently downgrades for the issue family (which stores only
 * open|resolved|closed, so a `state:'done'` lands as 'open' — the caller said "done" and the
 * item stayed claimable).
 *
 * This set is what separates a FAILED CLOSE from an INTENTIONAL non-terminal park: passing
 * `needs_human` / `blocked` / `wip` and landing on 'open' is correct and stays ok:true (the
 * caller recorded a completion and deliberately left the item open). Passing a close-intent
 * state and NOT landing terminal is a failed close, and must report ok:false.
 */
const CLOSE_INTENT_STATES = new Set([...TERMINAL_WORK_ITEM_STATES, 'done', 'complete', 'completed', 'dropped']);

const COMPLETE_CLOSE_SHAPE_MESSAGE =
  'to CLOSE a work-item, pass { id, state, assumptions: "none"|[fact keys], completion: { summary } } ' +
  '(or items:[{ id, state, assumptions: "none"|[fact keys], completion: { summary } }] for many) — ' +
  '`state` is the terminal lifecycle (feature/chunk: "passed"|"deprecated"; issue: "resolved"|"closed"; ' +
  'the unified aliases "done"|"dropped" are also accepted and preserve success vs discard semantics) ' +
  'and is REQUIRED to actually close it: a completion with no `state` only records the note, ' +
  'the item stays claimable. `assumptions` is also REQUIRED; pass "none" when no recorded fact ' +
  'supports the close (see work_items:set_state to change state alone, without a completion record).';

/**
 * EI-21314040234920121 and its duplicate EI-21562711070130195 both asked for the treeStamp
 * SHA pattern to be LOOSENED to accept a 10-char abbreviation. Loosening it would have been
 * actively harmful — the stamp anchors content identity for the committed-vs-proposed
 * authority gate, and an abbreviated SHA is an ambiguous identity — but the filings were a
 * fair reading of what the refusal SAYS. A caller who sends `treeStamp` is refused for its
 * pattern, on a field the server derives from the observed checkout and overwrites anyway
 * (`{ ...base, treeStamp }`, under "The stamp describes evidence; it is never evidence").
 * So the refusal names a constraint on a value that would have been discarded, and reads as
 * "send me a longer SHA" when the real rule is "do not send this field at all".
 *
 * Same remedy as ASSUMPTIONS_REQUIRED_MESSAGE below it: do not move the constraint, just let
 * the FIRST refusal state the rule the caller actually needs.
 */
const SERVER_STAMPED_TREE_STAMP_MESSAGE =
  '`completion.verification.treeStamp` is SERVER-STAMPED — omit it. The server derives the stamp ' +
  'from the observed checkout and OVERWRITES whatever you send, so a caller-supplied stamp is ' +
  'validated and then discarded. Its 40/64-hex requirement is deliberate (the stamp anchors ' +
  'content identity for the committed-vs-proposed authority gate, and an abbreviated SHA is an ' +
  'ambiguous identity), so the fix is to DROP the field — not to lengthen the SHA. Put what you ' +
  'actually verified in `testsRun` / `testResult`, and the paths you changed in `filesChanged`.';

const SERVER_STAMPED_SETTLEMENT_MANIFEST_MESSAGE =
  '`completion.verification.settlementManifest` is SERVER-STAMPED — omit it. The server derives the ' +
  'settlement receipt from the observed checkout and overwrites any caller-supplied value. Do not ' +
  'translate it into intuitive artifact fields or retry with a guessed schema; send only the ' +
  'caller-owned completion evidence and let the server create the manifest.';

/**
 * A union's default error collapses every branch into "Invalid input", hiding
 * the actionable contract that the previous shared object emitted. Preserve
 * strict unknown-key diagnostics, and otherwise retain the full close shape.
 */
function firstUnrecognizedKeyMessage(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const nested of value) {
      const message = firstUnrecognizedKeyMessage(nested);
      if (message) return message;
    }
    return undefined;
  }
  const record = value as { code?: unknown; message?: unknown; errors?: unknown };
  if (record.code === 'unrecognized_keys' && typeof record.message === 'string') return record.message;
  if (!Array.isArray(record.errors)) return undefined;
  for (const nested of record.errors) {
    const message = firstUnrecognizedKeyMessage(nested);
    if (message) return message;
  }
  return undefined;
}

/**
 * WI-39573: the completion schema deliberately emits an actionable repair for a
 * bare-string `completion`. Zod wraps that issue inside the union branch errors;
 * if the union-level mapper ignores it, callers instead see the generic close
 * contract (or a sibling unknown-key error) and the promised repair is lost.
 * Give this narrow, value-specific issue priority while leaving every unrelated
 * strict-key and close-shape diagnostic unchanged.
 */
function firstCompletionStringRejection(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const nested of value) {
      const message = firstCompletionStringRejection(nested);
      if (message) return message;
    }
    return undefined;
  }
  const record = value as { message?: unknown; errors?: unknown };
  if (record.message === COMPLETION_STRING_REJECTION) return COMPLETION_STRING_REJECTION;
  if (!Array.isArray(record.errors)) return undefined;
  for (const nested of record.errors) {
    const message = firstCompletionStringRejection(nested);
    if (message) return message;
  }
  return undefined;
}

/**
 * WI-213058: the public single/bulk envelope is a union, so a nested coverage
 * issue otherwise gets collapsed into `invalid_union` at the root. Preflight
 * malformed bucket shapes at the envelope boundary and keep the actionable
 * field path. Empty residue is deliberately reported at `.residue` so the
 * existing field-level min-length contract remains visible.
 */
function reportMalformedCompletionCoverage(
  raw: unknown,
  addIssue: (issue: { code: 'custom'; message: string; path: Array<string | number> }) => void,
): void {
  const inspect = (container: unknown, prefix: Array<string | number>): void => {
    if (!container || typeof container !== 'object' || Array.isArray(container)) return;
    const record = container as Record<string, unknown>;
    const completion = record.completion;
    if (!completion || typeof completion !== 'object' || Array.isArray(completion)) return;
    const completionRecord = completion as Record<string, unknown>;
    const verification = completionRecord.verification;
    const candidates: Array<{ value: unknown; path: Array<string | number> }> = [];
    if (verification && typeof verification === 'object' && !Array.isArray(verification)) {
      const verificationRecord = verification as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(verificationRecord, 'coverage')) {
        candidates.push({
          value: verificationRecord.coverage,
          path: [...prefix, 'completion', 'verification', 'coverage'],
        });
      }
    }
    if (Object.prototype.hasOwnProperty.call(completionRecord, 'coverage')) {
      candidates.push({ value: completionRecord.coverage, path: [...prefix, 'completion', 'coverage'] });
    }
    for (const candidate of candidates) {
      if (hasMalformedCoverageShape(candidate.value)) {
        addIssue({ code: 'custom', message: COMPLETION_COVERAGE_CONTRACT, path: candidate.path });
      }
    }
  };

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const root = raw as Record<string, unknown>;
  inspect(root, []);
  if (Array.isArray(root.items)) {
    root.items.forEach((item, index) => inspect(item, ['items', index]));
  }
}

/**
 * EI-23704816812454172: the generic flat-completion rescue also hoists a
 * top-level rootCauseVerification beside an existing completion object. That
 * makes a misplaced parent look like a missing nested leaf at the Zod boundary.
 * Report the placement directly, and report missing required leaves in a
 * present nested record before the shared storage schema emits its generic error.
 */
function reportRootCauseVerificationInputShape(
  raw: unknown,
  addIssue: (issue: { code: 'custom'; message: string; path: Array<string | number> }) => void,
): void {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  if (!isRecord(raw)) return;

  const inspect = (entry: Record<string, unknown>, prefix: Array<string | number>): void => {
    if (entry.completion !== undefined && entry.rootCauseVerification !== undefined) {
      addIssue({
        code: 'custom',
        message:
          'REJECTED — rootCauseVerification was supplied beside completion. Move it inside completion.rootCauseVerification; the sibling placement is invalid.',
        path: [...prefix, 'rootCauseVerification'],
      });
      return;
    }

    const completionRecord =
      isRecord(entry.completion) ? entry.completion : entry.completion === undefined && typeof entry.id === 'string' ? entry : undefined;
    if (!completionRecord || !isRecord(completionRecord.rootCauseVerification)) return;

    const verification = completionRecord.rootCauseVerification;
    const required = ['hypothesis', 'alternativeHypothesis', 'distinguishingTest', 'testResult'] as const;
    const missing = required.filter(
      (field) => typeof verification[field] !== 'string' || !(verification[field] as string).trim(),
    );
    if (missing.length === 0) return;

    addIssue({
      code: 'custom',
      message:
        'REJECTED — rootCauseVerification is present but incomplete at completion.rootCauseVerification. Missing required fields: ' +
        missing.join(', ') +
        '. Supply them inside the nested record; a missing parent is reported separately.',
      path: [...prefix, 'completion', 'rootCauseVerification'],
    });
  };

  if (Array.isArray(raw.items)) {
    raw.items.forEach((entry, index) => {
      if (isRecord(entry)) inspect(entry, ['items', index]);
    });
    return;
  }
  inspect(raw, []);
}

type PreflightIssue = { code: 'custom'; message: string; path: Array<string | number> };

/**
 * RSR-P-008-A (review-system-rework-reduction-2026-09-23): an issue added inside a
 * `z.preprocess` ABORTS the schema stage behind it, so once the preflight above
 * reports (say) an incomplete rootCauseVerification, a second defect elsewhere —
 * a prose filesChanged entry — was never reported, and the caller learned about it
 * one round-trip later. The preprocess now runs that stage itself and forwards its
 * issues, minus the ones a preflight issue already explains (same path or
 * beneath it — the preflight exists to REPLACE the schema's generic message
 * there, not to sit beside it). Union branch issues are filtered the same way.
 */
function issuesNotCoveredByPreflight(issues: readonly z.core.$ZodIssue[], preflight: readonly PreflightIssue[]) {
  const covered = preflight.map((issue) => issue.path.join('.'));
  const isCovered = (path: PropertyKey[]) => {
    const joined = path.map(String).join('.');
    return covered.some((prefix) => joined === prefix || joined.startsWith(`${prefix}.`));
  };
  const filter = (list: readonly z.core.$ZodIssue[]): z.core.$ZodIssue[] =>
    list.flatMap((issue): z.core.$ZodIssue[] => {
      if (isCovered(issue.path)) return [];
      if (issue.code === 'invalid_union' && Array.isArray(issue.errors)) {
        return [{ ...issue, errors: issue.errors.map((branch) => filter(branch)) } as z.core.$ZodIssue];
      }
      return [issue];
    });
  return filter(issues);
}

function firstRootCauseVerificationInputError(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const nested of value) {
      const message = firstRootCauseVerificationInputError(nested);
      if (message) return message;
    }
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const record = value as { message?: unknown; errors?: unknown };
  if (
    typeof record.message === 'string' &&
    record.message.startsWith('REJECTED — rootCauseVerification ')
  ) {
    return record.message;
  }
  if (!Array.isArray(record.errors)) return undefined;
  for (const nested of record.errors) {
    const message = firstRootCauseVerificationInputError(nested);
    if (message) return message;
  }
  return undefined;
}

function firstCompletionCoverageContract(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const nested of value) {
      const message = firstCompletionCoverageContract(nested);
      if (message) return message;
    }
    return undefined;
  }
  const record = value as { message?: unknown; errors?: unknown };
  if (typeof record.message === 'string' && record.message.includes(COMPLETION_COVERAGE_CONTRACT)) {
    return record.message;
  }
  if (!Array.isArray(record.errors)) return undefined;
  for (const nested of record.errors) {
    const message = firstCompletionCoverageContract(nested);
    if (message) return message;
  }
  return undefined;
}

/**
 * EI-20190168400283197: setWorkItemState rejects a terminal transition when the
 * linked plan-item is still effectively blocked. The completion record is kept
 * for the record-and-warn contract, so this exact rejection must be recognized
 * and durably parked out of scheduler:get_next instead of left claimable.
 */
function isPlanGateRejection(error: string): boolean {
  return /linked plan-item .* is STILL effectively /i.test(error);
}

const itemSpec = z.object({
  id: z.string().min(1),
  harness: z.string().max(80).optional().describe('per-item harness (else the batch `harness` default)'),
  /** Optional terminal state to also set. Omit to record + emit without changing lifecycle. */
  state: z
    .string()
    .min(1)
    .max(40)
    .optional()
    .describe(
      "Terminal lifecycle intent. Feature/chunk success: 'passed'; issue success: 'resolved'. Unified 'done'/'dropped' aliases are accepted and preserve success vs discard semantics. Legacy 'deprecated'/'closed' are discard/wontfix. Never use 'closed' as a generic synonym for successful work. To omit state deliberately, pass recordOnly:true.",
    ),
  recordOnly: z.boolean().optional().describe('Explicitly record and emit a completion without changing lifecycle state.'),
  /** The structured completion record (D-004). `workItem` defaults to this item's `id`. */
  completion: completionSpec,
  /**
   * Optional kind-specific STRUCTURED OUTPUT the completion produced (domain-free).
   * Carried verbatim onto the completion result + the completion reaction event, so a
   * domain reaction rule can read the work's output WITHOUT a re-fetch. Example: an
   * analyst bee completing a `bet-analysis` item attaches its `Signal` here, and the
   * `oddsmith:bet-signal` reaction (decision-ledger/bet-signal-rule.ts) emits a
   * decision-ledger disposition from it. Stays out of the fixed `completion` record.
   */
  outputPayload: z.unknown().optional(),
  /** Current proof attestation for a terminal close covering first-class spec clauses. */
  specAdequacy: specAdequacyCompletionField,
  /** Evaluate the complete versioned close contract without recording evidence or changing lifecycle. */
  validateOnly: z.boolean().optional(),
  /**
   * P-017 (b) gate #2 / D-016 / D-050 — REQUIRED for close-intent items.
   *
   * A record-only completion deliberately omits `state` and only records/emits a
   * progress note (D-004), so it is not a terminal commitment and must remain callable
   * without an assumption declaration. The handler enforces the required declaration
   * once it knows the effective state, including the issue-family status inference.
  */
  assumptions: z.preprocess(normalizePersistedAssumptionDeclaration, assumptionsArg.optional()),
  /** Optional successor/boundary note, posted only after a terminal finish converges. */
  boundaryNote: z
    .string()
    .min(1)
    .max(2000)
    .optional()
    .describe(
      'Optional successor/boundary note to append after a terminal close and finish cleanup; ignored for record-only or non-terminal results.',
    ),
});

type CompleteItem = z.infer<typeof itemSpec>;

/**
 * EI-10949 — does this completion prose name ANOTHER WORK-ITEM as a duplicate?
 *
 * The nudge exists for the WI-3646 failure: an item dup-closed 3× with the survivor named
 * only in prose ("dup of WI-3543"), so no scanner could follow the link. But the old test
 * was `/dup(licate)? of/` alone, which fires on any English sentence containing the phrase.
 * It fired on a completion that said a duplicated *type interface* had been removed — the
 * word "duplicate" was about CODE, not a work-item, and there was no duplicate item to link.
 *
 * A false positive here is not free, which is the assumption the old comment got wrong: this
 * warning shares a channel with real ones, and a heuristic that misfires on ordinary prose
 * teaches agents to skim past the channel entirely — including the time it is right. (Same
 * class as EI-10951: a derived claim asserted with more confidence than its evidence carries.)
 *
 * So require what the WI-3646 case actually had and ordinary prose does not: a work-item ID
 * near the phrase. "dup of WI-3543" still warns; "removed a duplicate of the SelectEntry
 * interface" no longer does.
 *
 * PURE — unit-tested without PG.
 */
export function mentionsWorkItemDuplicate(text: string): boolean {
  // "dup/dupe/duplicate(s) of" … then a work-item id within a short window (same clause).
  return /\b(?:is\s+a\s+)?dup(?:e|licate)?s?\s+of\b[^.\n;]{0,40}?\b(?:WI|EI|F)-\d+\b/i.test(text);
}

/**
 * EI-19380332459719944 — "N passed, M skipped" reads as a pass. Observed live: an
 * agent skipped one failing case to unblock the gate; a second agent independently
 * fixed the real root cause, re-ran the same file, saw "8 passed | 1 skipped", and
 * closed a CRITICAL work-item citing that as verification — but the skip's own
 * signature is what made the count read clean, and the assertion their fix repairs
 * never actually executed. Vitest reports a skip as a non-failure inside an
 * otherwise-green summary line, and nothing about the text distinguishes "this
 * assertion ran and passed" from "this assertion never ran at all" — the skip count
 * is DATA nobody reads; "passed" is what registers.
 *
 * Cheap, narrow catch: when the caller's OWN testsRun/testResult contains a
 * NONZERO skip count in a recognizable test-runner summary, surface it loudly
 * instead of accepting it silently. The old bare `\d+ skipped` matcher treated
 * ordinary prose ("run 3 skipped it") as a parsed test count, which made the
 * warning itself unreliable. A skip is often legitimate (a pre-existing,
 * already-accounted-for quarantine) so this is WARN-ONLY (EI-24 record-and-warn
 * discipline, same as every other check in this file) — it must never
 * hard-reject evidence it cannot fully judge; it only makes sure the caller (and
 * any reviewer reading the completion record later) cannot miss that a skip is
 * in play. PURE — unit-tested without PG.
 */
const NON_TEST_VERIFICATION_MODE_RE = /^(?:manual|live-drove-ui|live-service|already-passing)(?:\b|[(:])/i;
const INTEGRATION_VERIFICATION_MODE_RE = /^integration(?:\b|[(:])/i;
const TEST_RUNNER_COMMAND_RE =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+\S*test\b|exec\s+\S*test\b)|\b(?:npx|pnpx|bunx)\s+(?:vitest|jest|mocha|ava|pytest)\b|\b(?:vitest|jest|mocha|ava|pytest)\s+(?:run|--run)\b|\b(?:testing:run|node\s+--test|go\s+test|cargo\s+test)\b/i;

/**
 * Return the skipped/todo count only for a recognizable runner summary.
 *
 * The count must either follow a passed/failed count with runner punctuation
 * (`8 passed | 1 skipped`) or be attached to an explicit `Tests`/`Test Files`
 * summary marker (`Tests: 1 skipped, 8 passed`). A bare `3 skipped` is
 * deliberately not enough: completion prose uses "skip" as an ordinary verb.
 */
function skippedTestSummaryCount(text: string): number | undefined {
  const passedOrFailed = text.match(
    /\b\d+\s+(?:passed|failed)\b\s*(?:[|,/;:]\s*|\band\b\s*)(\d+)\s+(?:skipped|todo)\b/i,
  );
  if (passedOrFailed) return Number(passedOrFailed[1]);

  const testsMarker = text.match(
    /(?:^|\n)\s*(?:tests?|test files?)\s*:?\s*(?:\d+\s+(?:passed|failed)\s*[|,/;:]\s*)*(\d+)\s+(?:skipped|todo)\b/im,
  );
  if (testsMarker) return Number(testsMarker[1]);

  const fileSummary = text.match(/\b\d+\s+tests?\s*[|,/;:]\s*(\d+)\s+(?:skipped|todo)\b/i);
  return fileSummary ? Number(fileSummary[1]) : undefined;
}

export function skippedTestsMentionedInEvidence(
  evidence: Pick<CompletionVerificationEvidence, 'testsRun' | 'testResult' | 'verifiedHow'> | undefined,
): { count: number; source: 'testsRun' | 'testResult' } | undefined {
  if (!evidence) return undefined;
  const verifiedHow = evidence.verifiedHow?.trim() ?? '';
  // Manual/live-service/UI evidence is not a test-runner report. Integration
  // evidence is eligible only when the evidence also names the runner command;
  // otherwise a sentence such as "run 3 skipped it" is just prose from a live
  // probe, not a measured test count.
  if (NON_TEST_VERIFICATION_MODE_RE.test(verifiedHow)) return undefined;
  if (INTEGRATION_VERIFICATION_MODE_RE.test(verifiedHow) && !TEST_RUNNER_COMMAND_RE.test(evidence.testsRun ?? '')) {
    return undefined;
  }
  // testResult first: when both fields are populated, testResult is more often the
  // literal vitest summary line (testsRun tends to be the COMMAND, e.g. "npm run
  // test:file -- foo.test.ts"), so it is the more likely source of a real count.
  for (const source of ['testResult', 'testsRun'] as const) {
    const text = evidence[source];
    if (!text) continue;
    if (source === 'testsRun' && !TEST_RUNNER_COMMAND_RE.test(text)) continue;
    const count = skippedTestSummaryCount(text);
    if (count !== undefined && Number.isFinite(count) && count > 0) return { count, source };
  }
  return undefined;
}

/**
 * EI-19454705610327667 — the repo's prescribed non-vacuity proof runs the same
 * file twice: once unfiltered, then once with Vitest's `-t` name filter so the
 * newly-added test is proven to execute. The filtered run reports every
 * non-matching test as SKIPPED, which is expected and is not the same signal as
 * a skipped assertion left in an otherwise unfiltered run.
 *
 * Keep this deliberately conservative. A name-filter token by itself is not
 * enough: the caller must also record an explicitly unfiltered/full run with
 * zero skips in the same evidence bundle. That preserves the warning for a
 * filter-only completion, where the skipped count could still hide a real
 * disabled test.
 *
 * PURE — unit-tested without PG.
 */
function hasIntentionalTestNameFilterProof(
  evidence: Pick<CompletionVerificationEvidence, 'testsRun' | 'testResult'> | undefined,
): boolean {
  if (!evidence) return false;
  const prose = `${evidence.testsRun ?? ''}\n${evidence.testResult ?? ''}`;

  // Vitest accepts both the short CLI spelling and the long spelling surfaced
  // by testing:run. The boundary prevents prose such as "-test" from counting
  // as a filter invocation.
  const hasNameFilter = /(?:^|[\s`'"(])(?:-t\b|--testNamePattern\b|--test-name-pattern\b)(?:\s+|=)/i.test(prose);
  if (!hasNameFilter) return false;

  // Require the clean count to be labelled as the unfiltered/full run and keep
  // the window bounded so a clean result from an unrelated command cannot
  // accidentally bless a filtered run's skipped count.
  const cleanRun =
    /\b(?:unfiltered|full(?:\s+(?:suite|file|run))?|without\s+(?:a\s+)?(?:test[- ]name\s+)?filter|no\s+(?:test[- ]name\s+)filter)\b[\s\S]{0,180}?\b0\s+(?:tests?\s+)?skip(?:ped|s)?\b|\b0\s+(?:tests?\s+)?skip(?:ped|s)?\b[\s\S]{0,180}?\b(?:unfiltered|full(?:\s+(?:suite|file|run))?|without\s+(?:a\s+)?(?:test[- ]name\s+)?filter|no\s+(?:test[- ]name\s+)filter)\b/i;
  return cleanRun.test(prose);
}

type TypecheckGate = { npmScript: string; prefixes: string[] };

/**
 * The sibling-gate roster is stable for the life of the process, and completion warnings can
 * fire on every unit in a busy drain. Cache the discovery per repo root so a warning does not
 * repeatedly import every lint:tsc CLI. A failed discovery is deliberately not cached: a
 * transient filesystem/import problem must not permanently downgrade later warnings to the
 * generic command.
 */
let siblingTypecheckGatesCache: { root: string; gates: TypecheckGate[] } | undefined;

async function siblingTypecheckGates(root: string): Promise<TypecheckGate[]> {
  if (siblingTypecheckGatesCache?.root === root) return siblingTypecheckGatesCache.gates;
  try {
    const discovered = await discoverSiblingTypecheckGates(root);
    siblingTypecheckGatesCache = { root, gates: discovered.gates };
    return discovered.gates;
  } catch {
    // This is an advisory warning on an already-recorded completion. Never make the completion
    // fail because gate discovery could not read/import one of the sibling CLIs.
    return [];
  }
}

/**
 * A basename-only completion is an underspecified path until the repository proves otherwise.
 * Keep the search bounded and fail closed: a unique match is useful evidence, while an
 * ambiguous, unreadable, or truncated scan must remain uncovered so the warning cannot suggest
 * a command for a file we did not actually identify.
 */
const MAX_TYPECHECK_BASENAME_SCAN_ENTRIES = 50_000;
const MAX_TYPECHECK_BASENAME_SCAN_DEPTH = 32;
const TYPECHECK_BASENAME_PRUNED_DIRS = new Set([
  '.git',
  '.next',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
]);

type TypecheckBasenameCache = Map<string, string[] | null>;

function uniqueTypecheckBasenameMatches(
  root: string,
  basename: string,
  gates: TypecheckGate[],
  cache: TypecheckBasenameCache,
): string[] | null {
  if (cache.has(basename)) return cache.get(basename) ?? null;

  const prefixes = [...new Set(gates.flatMap((gate) => gate.prefixes))].sort((a, b) => b.length - a.length);
  const matches = new Set<string>();
  const visitedDirectories = new Set<string>();
  let scannedEntries = 0;
  let complete = true;

  const walk = (directory: string, depth: number): void => {
    if (!complete || matches.size > 1) return;
    const resolvedDirectory = nodePath.resolve(directory);
    if (visitedDirectories.has(resolvedDirectory)) return;
    visitedDirectories.add(resolvedDirectory);
    if (depth > MAX_TYPECHECK_BASENAME_SCAN_DEPTH) {
      complete = false;
      return;
    }

    let entries: Dirent[];
    try {
      entries = readdirSync(resolvedDirectory, { withFileTypes: true });
    } catch {
      complete = false;
      return;
    }

    for (const entry of entries) {
      scannedEntries += 1;
      if (scannedEntries > MAX_TYPECHECK_BASENAME_SCAN_ENTRIES) {
        complete = false;
        return;
      }

      if (entry.isDirectory()) {
        if (!TYPECHECK_BASENAME_PRUNED_DIRS.has(entry.name)) {
          walk(nodePath.join(directory, entry.name), depth + 1);
        }
        continue;
      }
      if (!entry.isFile() || entry.name !== basename) continue;

      const candidate = nodePath.relative(root, nodePath.join(directory, entry.name)).split(nodePath.sep).join('/');
      if (gateCoveringFile(gates, candidate)) matches.add(candidate);
      if (matches.size > 1) return;
    }
  };

  for (const prefix of prefixes) {
    const directory = nodePath.resolve(root, prefix);
    const relativeDirectory = nodePath.relative(root, directory);
    if (relativeDirectory.startsWith('..') || nodePath.isAbsolute(relativeDirectory)) {
      complete = false;
      break;
    }
    walk(directory, 0);
    if (!complete || matches.size > 1) break;
  }

  const result = complete && matches.size === 1 ? [...matches] : matches.size > 1 ? [...matches] : null;
  cache.set(basename, result);
  return result;
}

/**
 * Completion evidence historically accepted both repo-relative paths and paths relative to the
 * operator-core package. Gate declarations are repo-relative, so resolve the latter against a
 * covered prefix when the caller did not include its package directory. Only use an existing
 * candidate: guessing a prefix for a fabricated path would make the warning look more certain
 * than the evidence allows.
 */
function repoRelativeTypecheckFile(
  root: string,
  file: string,
  gates: TypecheckGate[],
  basenameCache: TypecheckBasenameCache,
): string | null {
  const raw = String(file).replace(/^\.\//, '');
  const normalized = nodePath.isAbsolute(raw)
    ? nodePath.relative(root, raw).split(nodePath.sep).join('/')
    : raw.split(nodePath.sep).join('/');
  const basenameOnly = !normalized.includes('/');
  if (!basenameOnly && gateCoveringFile(gates, normalized)) return normalized;

  const prefixes = [...new Set(gates.flatMap((gate) => gate.prefixes))].sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    if (!prefix || normalized.startsWith(prefix)) continue;
    const candidate = `${prefix}${normalized}`;
    if (existsSync(nodePath.resolve(root, candidate)) && gateCoveringFile(gates, candidate)) return candidate;
  }

  if (basenameOnly) {
    const matches = uniqueTypecheckBasenameMatches(root, normalized, gates, basenameCache);
    return matches?.length === 1 ? matches[0]! : null;
  }
  return null;
}

/**
 * Return runnable per-file typecheck commands, routed through the gate that actually owns each
 * path. The old warning always printed operator-core's `lint:tsc` command; that command refuses
 * `apps/operator/*` as out of scope even though the sibling `lint:tsc:operator` gate covers it.
 * Keep the generic fallback for a packaged install or an uncovered workspace, where no honest
 * repository gate can be derived.
 */
async function typecheckCommandsForFiles(files: string[]): Promise<string> {
  const fallback =
    `npm run lint:tsc -- --files=${files.join(',')}  (files outside packages/operator-core need ` +
    `their own project: npx tsc --noEmit -p <workspace>/tsconfig.json)`;
  const root = completionRoot();
  if (!root) return fallback;

  const gates = await siblingTypecheckGates(root);
  const grouped = new Map<string, string[]>();
  const uncovered: string[] = [];
  const basenameCache: TypecheckBasenameCache = new Map();
  for (const file of files) {
    const repoFile = repoRelativeTypecheckFile(root, file, gates, basenameCache);
    const gate = repoFile ? gateCoveringFile(gates, repoFile) : null;
    if (!gate) {
      uncovered.push(file);
      continue;
    }
    const group = grouped.get(gate.npmScript) ?? [];
    group.push(repoFile!);
    grouped.set(gate.npmScript, group);
  }

  const commands = [...grouped].map(([npmScript, paths]) => `npm run ${npmScript} -- --files=${paths.join(',')}`);
  if (uncovered.length > 0) {
    commands.push(
      `npx tsc --noEmit -p <workspace>/tsconfig.json  (no repository lint:tsc gate was resolved for: ${uncovered.join(', ')})`,
    );
  }
  return commands.length > 0 ? commands.join('; ') : fallback;
}

/**
 * EI-19454554361062529 — a green suite is not weak evidence about types; it is
 * SILENT about them, and that is exactly why it misleads.
 *
 * Vitest transforms via esbuild/swc and never typechecks, so a file can be fully
 * green and fully broken at the same instant. CLAUDE.md already warns about this
 * for the EDIT loop ("a green run does NOT mean your CHANGE compiles"), and that
 * warning fires because an edit prompts you to check. This is the OTHER entrance,
 * which nothing warns about: you did not edit anything — you RAN a suite, it
 * passed, and you CLOSED a work-item on that evidence. There is no edit, so
 * nothing prompts a typecheck.
 *
 * Measured 2026-08-03: a peer closed a bug citing `testing:run → 8 passed / 0
 * failed`. The fix was correct and the evidence was honest, but the same file
 * carried 11 COMMITTED TS2345 errors that `lint:tsc` classified as "a standing red
 * that WILL red the fleet". Nothing in their run could have surfaced it; it was
 * found only as unrelated collateral by a third agent typechecking something else.
 *
 * Narrow on purpose — it fires ONLY when all three hold, so a close that already
 * mentions a typecheck, or that changed no TypeScript, stays silent:
 *   1. the verification claim rests on a TEST RUN (`unit` / `integration` /
 *      `already-passing`) — `manual` and `live-drove-ui` make no such claim;
 *   2. `filesChanged` names at least one TypeScript source; and
 *   3. the caller's own evidence prose mentions no typecheck at all.
 *
 * WARN-ONLY (EI-24 record-and-warn discipline, like every other check here). A
 * hard gate on a ~150s check would simply be routed around, and plenty of closes
 * are legitimately type-irrelevant. The entire failure mode is NOT KNOWING TO
 * LOOK, so a nudge at the moment of the claim is the whole fix. PURE — unit-tested
 * without PG.
 */
/** Injectable filesystem seam so the check below is unit-testable without a real tree. */
export interface CompletionPathProbe {
  repoRoot?: string | null;
  /**
   * Candidate checkout roots for workspace/fleet completions whose files can live outside the
   * Papercusp source tree. One root must account for the whole completion; paths are never
   * combined across repositories. `repoRoot` remains the single-root compatibility seam.
   */
  repoRoots?: Array<string | null>;
  exists?: (absPath: string) => boolean;
  siblings?: (absDir: string) => string[];
}

/** Injectable read seam for resolving a linked worktree's canonical checkout. */
export interface CanonicalCompletionRootProbe {
  readFile?: (absPath: string) => string | undefined;
}

/**
 * Resolve the canonical checkout behind a linked worktree without spawning Git.
 *
 * A staging operator may detect its linked `papercusp-staging` checkout, while the
 * completion probes must inspect the canonical `papercusp` tree. Git records that
 * relationship in the worktree's `.git` pointer and its gitdir `commondir` file:
 * `.git -> gitdir: <canonical>/.git/worktrees/<name>` and `commondir -> ../..`.
 * The common directory's parent is the canonical repository root.
 *
 * Malformed or unreadable metadata keeps the detected root. This advisory resolver is
 * deliberately fail-open, bounded to two small metadata reads, and spawn-free because
 * completion is a fleet-wide hot path.
 */
export function resolveCanonicalCompletionRoot(
  detectedRoot: string | null | undefined,
  probe: CanonicalCompletionRootProbe = {},
): string | null {
  if (!detectedRoot) return null;
  const root = nodePath.resolve(detectedRoot);
  const readFile =
    probe.readFile ??
    ((absPath: string) => {
      try {
        return readFileSync(absPath, 'utf8');
      } catch {
        return undefined;
      }
    });

  try {
    const dotGit = readFile(nodePath.join(root, '.git'))?.trim();
    if (!dotGit) return root;
    const gitdir = /^gitdir:\s*(.+)$/.exec(dotGit)?.[1]?.trim();
    if (!gitdir || /[\r\n]/.test(gitdir)) return root;

    const gitDir = nodePath.resolve(root, gitdir);
    const commondir = readFile(nodePath.join(gitDir, 'commondir'))?.trim();
    if (!commondir || /[\r\n]/.test(commondir)) return root;

    const commonDir = nodePath.resolve(gitDir, commondir);
    const worktreeRelative = nodePath.relative(commonDir, gitDir);
    if (
      nodePath.basename(commonDir) !== '.git' ||
      !worktreeRelative ||
      worktreeRelative.startsWith('..' + nodePath.sep) ||
      nodePath.isAbsolute(worktreeRelative) ||
      worktreeRelative.split(nodePath.sep)[0] !== 'worktrees'
    ) {
      return root;
    }
    return nodePath.dirname(commonDir);
  } catch {
    return root;
  }
}

/** Runtime completion root; linked worktrees resolve to their canonical checkout. */
function completionRoot(): string | null {
  return resolveCanonicalCompletionRoot(detectPapercupRoot());
}

/** Injectable filesystem seams for the workspace-qualified external-app repair hint. */
export interface WorkspaceQualifiedCompletionPathProbe {
  /** Absolute parent of per-workspace directories (`<root>/<workspaceId>`). */
  workspacesRoot?: string | null;
  exists?: (absPath: string) => boolean;
  /** Returns true only for a real checkout root, not an arbitrary directory. */
  isCheckoutRoot?: (absPath: string) => boolean;
}

/** Bounds the work: a pathological payload must never turn a completion into a tree walk. */
const MAX_PATHS_PROBED = 60;

/** Keep optional registry enrichment below the MCP transport deadline. */
export const COMPLETION_REGISTRY_ROOTS_TIMEOUT_MS = 2_000;

/**
 * Resolve a workspace-qualified app citation to the absolute path that
 * `work_items:complete` supports for an independent checkout.
 *
 * A path such as `.papercusp/apps/phone-app/src/fix.ts` is relative to the
 * workspace directory, not to the Papercusp repository. Treating it as
 * repo-relative produces a misleading "use bare repo-relative paths" warning,
 * even though the completion writer already accepts absolute paths and can
 * identify the app's own Git checkout. This helper only offers a repair when
 * the exact candidate exists under the requested workspace and an ancestor is
 * a valid checkout root; it never turns a guess into evidence.
 *
 * PURE via the injected probe and bounded to the declared path's own ancestor
 * chain. Filesystem failures are deliberately fail-open because this is an
 * advisory warning on an already-recorded completion.
 */
export function workspaceQualifiedCompletionPathHint(
  declaredPath: string,
  workspaceId: string | null | undefined,
  probe: WorkspaceQualifiedCompletionPathProbe = {},
): string | undefined {
  const normalized = declaredPath.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  const match = /^\.papercusp\/apps\/([^/]+)\/(.+)$/.exec(normalized);
  const workspace = workspaceId?.trim();
  if (!match || !workspace || workspace === '*' || workspace === '.' || workspace === '..') return undefined;

  // Workspace ids and app slugs are path components. Refuse traversal and
  // separators before resolving so the hint can never point outside the app.
  const appSlug = match[1]!;
  const appRelativePath = match[2]!;
  if (
    workspace.includes('/') ||
    workspace.includes('\\') ||
    appSlug === '.' ||
    appSlug === '..' ||
    appSlug.includes('\\') ||
    appRelativePath.split('/').some((segment) => segment === '..')
  ) {
    return undefined;
  }

  try {
    const rawWorkspacesRoot = 'workspacesRoot' in probe ? probe.workspacesRoot : workspacesRoot();
    if (typeof rawWorkspacesRoot !== 'string' || !rawWorkspacesRoot.trim()) return undefined;

    const root = nodePath.resolve(rawWorkspacesRoot);
    const workspaceDir = nodePath.resolve(root, workspace);
    const appsDir = nodePath.resolve(workspaceDir, '.papercusp', 'apps');
    const appDir = nodePath.resolve(appsDir, appSlug);
    const candidate = nodePath.resolve(workspaceDir, normalized);
    if (
      (workspaceDir !== root && !workspaceDir.startsWith(root + nodePath.sep)) ||
      (candidate !== appDir && !candidate.startsWith(appDir + nodePath.sep))
    ) {
      return undefined;
    }

    const exists = probe.exists ?? ((absPath: string) => existsSync(absPath));
    if (!exists(candidate)) return undefined;

    const isCheckoutRoot = probe.isCheckoutRoot ?? hasValidGitEntry;
    let dir = nodePath.dirname(candidate);
    for (let depth = 0; depth < 64 && dir !== appsDir; depth += 1) {
      if (isCheckoutRoot(dir)) return candidate;
      const parent = nodePath.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* fail-open: a repair hint must never make completion fail */
  }
  return undefined;
}

/**
 * EI-20093150500083378: `filesChanged` names paths that DO NOT EXIST, and nothing notices.
 *
 * Every OTHER evidence field on this call is challenged — a unit-only close over TypeScript draws
 * `typeEvidenceWarning`,
 * a terminal close without `assumptions` is refused outright. `filesChanged` alone was
 * taken verbatim, and it is the field most likely to be written from MEMORY rather than
 * observation, because it is filled in LAST — when the work is done and the details have
 * aged out of context (or out of a compaction).
 *
 * Measured 2026-08-10: one agent filed 12 paths across two completions and 8 did not
 * exist — an `agent-tools/` segment inserted because most tools in that package do live
 * under it, and a `__tests__/` directory invented because nearly every other repo has one.
 * Both completions still landed `authority:'committed'`. Note the DIRECTION of that error:
 * the fabricated paths were MORE conventional than the real ones, which is precisely what
 * lets them survive review by someone who knows the ecosystem but not this tree.
 *
 * WARN-ONLY, and fail-open at every step (EI-24 record-and-warn discipline, like every
 * sibling check here). A missing path has legitimate causes — the file was DELETED by this
 * very change, or lives in a submodule that is not checked out — so this can only ever be a
 * nudge. It is silent when it cannot judge: no repo root, a path that escapes the root, a
 * glob, or any fs error.
 *
 * `didYouMean` is what makes it actionable, and it is deliberately CHEAP rather than a
 * tree search: drop one path segment at a time (catches an inserted `agent-tools/` or
 * `__tests__/`), then, if the parent directory exists, look for a sibling sharing the
 * basename's leading token (catches a misremembered filename like `790-engineer-issues-…`
 * for `790-expose-goal-id-…`). Bounded by the path's own segment count plus one readdir.
 *
 * PURE via the injected probe — unit-tested without touching a real tree.
 */
export function unresolvedPathsInCompletion(
  evidence: CompletionVerificationEvidence | undefined,
  probe: CompletionPathProbe = {},
): { missing: Array<{ path: string; didYouMean?: string }> } | undefined {
  const declared = evidence?.filesChanged;
  if (!declared?.length) return undefined;

  // `in` rather than `??`: an EXPLICIT null/empty roots value means "I could not resolve a
  // root, do not guess", which is a different instruction from omitting the key. Collapsing
  // the two would silently fall back to detection and judge paths against the wrong tree —
  // the same absent-vs-explicitly-empty conflation this whole check exists to catch.
  const rawRoots = 'repoRoots' in probe ? probe.repoRoots : ['repoRoot' in probe ? probe.repoRoot : completionRoot()];
  const repoRoots = [
    ...new Set(
      (rawRoots ?? [])
        .filter((root): root is string => typeof root === 'string' && root.trim().length > 0)
        .map((root) => nodePath.resolve(root)),
    ),
  ];
  if (repoRoots.length === 0) return undefined; // cannot judge → say nothing

  const exists = probe.exists ?? ((abs: string) => existsSync(abs));
  const siblings =
    probe.siblings ??
    ((abs: string) => {
      try {
        return readdirSync(abs);
      } catch {
        return [];
      }
    });

  // A completion describes ONE checkout. Score each candidate as a unit and choose the root
  // that resolves the most paths (stable ties keep the primary root first). This fixes a fleet
  // member completing SideStage work through the Papercusp coordination harness without
  // letting two half-matching repositories combine into one false-green completion.
  let best: { found: number; missing: Array<{ path: string; didYouMean?: string }> } | undefined;
  for (const repoRoot of repoRoots) {
    let found = 0;
    const missing: Array<{ path: string; didYouMean?: string }> = [];
    for (const raw of declared.slice(0, MAX_PATHS_PROBED)) {
      const declaredPath = raw.trim();
      // A glob is a description of many files, not a claim that one path exists.
      if (!declaredPath || declaredPath.includes('*') || declaredPath.includes('?')) continue;

      let abs: string;
      try {
        abs = nodePath.resolve(repoRoot, declaredPath);
      } catch {
        continue;
      }
      // Outside the repo we have no standing to judge (and no business probing).
      if (abs !== repoRoot && !abs.startsWith(repoRoot + nodePath.sep)) continue;

      // EI-21850619651553189: ALSO try the declared path with a leading `<repoName>/`
      // segment stripped, when that segment names THIS candidate root by its own
      // directory basename — the conventional cross-repo form (`email/packages/...`,
      // matching how the file is named in prose, plan titles, and everywhere else)
      // rather than a path already relative to that repo's own root. Tried ALONGSIDE
      // the plain form above, never instead of it: a plain relative path always
      // resolves "inside" any root by construction (`resolve(root, 'a/b')` can never
      // escape `root`), so the plain form alone cannot distinguish a real hit from a
      // declared path that merely happens to share this root's name as its first
      // segment — only checking EXISTENCE of both candidates can.
      let strippedAbs: string | undefined;
      const prefix = `${nodePath.basename(repoRoot)}/`;
      if (declaredPath.startsWith(prefix)) {
        const stripped = declaredPath.slice(prefix.length);
        if (stripped) {
          try {
            const candidate = nodePath.resolve(repoRoot, stripped);
            if (candidate === repoRoot || candidate.startsWith(repoRoot + nodePath.sep)) {
              strippedAbs = candidate;
            }
          } catch {
            /* the plain form above still stands */
          }
        }
      }

      try {
        if (exists(abs) || (strippedAbs && exists(strippedAbs))) {
          found += 1;
          continue;
        }
        missing.push({
          path: declaredPath,
          didYouMean: suggestExistingPath(declaredPath, repoRoot, exists, siblings),
        });
      } catch {
        continue; // fs trouble is never the caller's problem
      }
    }

    if (missing.length === 0) return undefined;
    if (!best || found > best.found) best = { found, missing };
  }

  return best?.missing.length ? { missing: best.missing } : undefined;
}

/**
 * Reuse the canonical harness-content resolver to enumerate the code checkouts registered in
 * this workspace, then admit independent sibling repositories through the same bounded,
 * spawn-free rule used by plan citation resolution. The sibling leg is required for checkouts
 * such as SideStage that live beside Papercusp but are not registered as harness projects.
 *
 * The Papercusp tree stays first so legacy/single-repo completions retain their exact behavior;
 * registered roots stay ahead of discovered siblings, and duplicate paths are collapsed before
 * any filesystem work.
 */
export function completionRepoRootsFromRegistry(
  primaryRoot: string | null,
  registry: Pick<HarnessRegistry, 'projects'>,
  additionalRoots: readonly string[] = [],
  opts: { homeRoot?: string } = {},
): string[] {
  const roots = new Set<string>();
  const detectedRoot = primaryRoot ? nodePath.resolve(primaryRoot) : null;
  const canonicalRoot = resolveCanonicalCompletionRoot(detectedRoot);
  if (canonicalRoot) roots.add(nodePath.resolve(canonicalRoot));
  // Keep the detected worktree as a secondary candidate: its runtime checkout may still
  // own an independently declared path, while canonical-first ordering fixes completion
  // evidence that was observed through a linked staging service.
  if (detectedRoot && detectedRoot !== canonicalRoot) roots.add(detectedRoot);
  for (const project of registry.projects) {
    const contentPath = resolveHarnessContentPath(registry, project.slug);
    if (contentPath) roots.add(nodePath.resolve(contentPath));
  }
  if (primaryRoot) {
    // EI-22188958812917965: resolve each sibling against the PARENT DIRECTORY it was
    // actually found under, not a hardcoded workspaceRoot — a checkout directly under
    // $HOME (one tier further out than the conventional workspace directory) resolves
    // wrong otherwise, which is exactly the reported "absent-from-both" failure.
    // `opts.homeRoot` lets a test point this at an isolated fixture instead of the
    // real machine's home directory; production leaves it unset and gets the real one.
    for (const [siblingName, parentDir] of independentSiblingRepos(primaryRoot, {
      homeRoot: opts.homeRoot,
    })) {
      roots.add(nodePath.resolve(parentDir, siblingName));
    }
  }
  // Keep the registry/sibling resolver pure for its existing callers, while allowing the
  // completion path to append checkout roots discovered from absolute filesChanged paths or
  // the canonical external-Hive homes. These are already validated by their discoverers;
  // deduplication here preserves the primary Papercusp root's stable first position.
  for (const additionalRoot of additionalRoots) {
    if (typeof additionalRoot === 'string' && additionalRoot.trim()) {
      roots.add(nodePath.resolve(additionalRoot));
    }
  }
  return [...roots];
}

/**
 * Find the nearest valid Git checkout for an absolute completion path. Unlike the testing
 * runner's workspace resolver, completion identity must also recognize standalone submodules
 * such as papercusp-desktop, whose package.json intentionally has no npm workspaces field.
 */
export function completionCheckoutRootForPath(file: string): string | undefined {
  if (!nodePath.isAbsolute(file)) return undefined;
  let dir = nodePath.dirname(nodePath.resolve(file));
  for (let depth = 0; depth < 64; depth += 1) {
    if (hasValidGitEntry(dir)) return dir;
    const parent = nodePath.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export interface CompletionRepoRootsForWorkspaceOptions {
  /** Injectable primary root for focused tests; production detects the Papercusp checkout. */
  primaryRoot?: string | null;
  /** Injectable discovered roots; production derives these from known Hives and path owners. */
  additionalRoots?: readonly string[];
  /** Optional sibling scan parent override for deterministic focused tests. */
  homeRoot?: string;
  /** Injectable registry read for the bounded/fail-open enrichment seam. */
  loadRegistry?: (workspaceId?: string) => Promise<HarnessRegistry>;
}

export async function completionRepoRootsForWorkspace(
  workspaceId?: string,
  declaredPaths: readonly string[] = [],
  opts: CompletionRepoRootsForWorkspaceOptions = {},
): Promise<string[]> {
  const primaryRoot = 'primaryRoot' in opts ? (opts.primaryRoot ?? null) : detectPapercupRoot();
  const additionalRoots =
    'additionalRoots' in opts
      ? [...(opts.additionalRoots ?? [])]
      : [
          ...discoverKnownHiveCheckoutRoots(),
          ...declaredPaths
            .map((path) => completionCheckoutRootForPath(path) ?? checkoutRootForPath(path))
            .filter((root): root is string => Boolean(root)),
        ];
  const registryRead = await withBoundedTimeout(
    () => (opts.loadRegistry ?? loadHarnessRegistry)(resolveConcreteWorkspaceId(workspaceId)),
    {
      // Registry roots are advisory enrichment for an already-recorded completion. Keep this
      // below the MCP transport deadline: a wedged PG read must not turn the warn-only path
      // audit into a 300s completion hang. `withBoundedTimeout` also absorbs a late rejection.
      fallback: null,
      timeoutMs: COMPLETION_REGISTRY_ROOTS_TIMEOUT_MS,
      label: 'work_items:complete:registry-roots',
    },
  );
  if (!registryRead.degraded && registryRead.value) {
    try {
      return completionRepoRootsFromRegistry(primaryRoot, registryRead.value, additionalRoots, {
        homeRoot: opts.homeRoot,
      });
    } catch {
      // Fall through to the same fail-open root set used for registry timeout/error.
    }
  }

  // This is an advisory check on an already-recorded completion. Registry trouble must never
  // make the completion fail; preserve the primary root while retaining independently
  // discovered Hive/path roots so an external completion is not silently stamped as Papercus.
  const canonicalPrimaryRoot = resolveCanonicalCompletionRoot(primaryRoot);
  return [
    ...new Set(
      [canonicalPrimaryRoot, primaryRoot, ...additionalRoots]
        .filter((root): root is string => Boolean(root))
        .map((root) => nodePath.resolve(root)),
    ),
  ];
}

/** Injectable commit-history seam for the path-vintage detector below. */
export interface CompletionPathVintageProbe {
  repoRoot?: string | null;
  /** Epoch seconds, an ISO timestamp, or a Date; null/undefined means unobservable. */
  lastCommitAt?: (path: string) => number | string | Date | null | undefined;
  /** Injectable batch history read; production uses the argv-safe git helper. */
  lastCommitTimes?: (repoRoot: string, paths: Iterable<string>) => Map<string, number | null>;
}

export interface CompletionPathVintageHit {
  path: string;
  lastCommitAt: string;
}

const PATH_VINTAGE_MAX_PATHS = 60;
/**
 * WI-41246: this branch returns payload.paths WHOLESALE, so it must fire only on prose that
 * positively claims a CHANGE to those paths. Audit verbs ("verified", "covered", "correct")
 * describe INSPECTING a path, not changing it — and this tool's own schema asks callers for an
 * enumerated `verification.coverage` census, so counting them here made every well-evidenced
 * audit completion trip a false "verify each named path was actually remediated" advisory.
 * Measured carrier: "All 17 uncast sites pass STRING arrays — verified by DECLARED TYPE"
 * matched on `verified` alone, with no change claimed anywhere in the span.
 *
 * A completion that both audits AND changes still matches, because its change verb remains in
 * the set ("all files verified fixed" matches on "fixed"). Narrowing only the WHOLESALE branch
 * is safe: a path named explicitly in `filesChanged` or in the prose is still caught by the
 * per-path fallback in completionClaimsTargetPaths.
 *
 * `corrected` is listed because the previous `correct` alternative could only match the bare
 * adjective — \bcorrect\b does not match "corrected" — so a genuine "all files corrected"
 * claim was silently missed.
 */
const PATH_CLAIM_ALL_RE =
  /\b(?:all|every|each|both|named)\b[\s\S]{0,100}\b(?:path|paths|file|files|site|sites|target|targets)\b[\s\S]{0,100}\b(?:changed|fixed|corrected|updated|remediated|replaced|removed)\b/i;

/**
 * Resolve a completion path to the repository that owns its history. The superproject stores
 * only a gitlink for a submodule, so `git log -- <submodule>/<file>` from the superproject can
 * never observe the commit that changed the file. A missing/uninitialized submodule has no
 * nearer valid git entry and consequently falls back to the superproject, where git's normal
 * fail-soft `null` result preserves this advisory's fail-open behavior.
 */
function completionHistoryPath(repoRoot: string, relativePath: string): { repoRoot: string; path: string } | undefined {
  const primaryRoot = nodePath.resolve(repoRoot);
  const absolutePath = nodePath.resolve(primaryRoot, relativePath);
  if (absolutePath !== primaryRoot && !absolutePath.startsWith(primaryRoot + nodePath.sep)) return undefined;

  let owner = nodePath.dirname(absolutePath);
  for (let depth = 0; depth < 64; depth += 1) {
    if (hasValidGitEntry(owner)) {
      const path = nodePath.relative(owner, absolutePath).split(nodePath.sep).join('/');
      return path ? { repoRoot: owner, path } : undefined;
    }
    const parent = nodePath.dirname(owner);
    if (parent === owner) break;
    owner = parent;
  }
  return undefined;
}

function completionTextParts(completion: unknown): string[] {
  if (!completion || typeof completion !== 'object' || Array.isArray(completion)) return [];
  const rec = completion as Record<string, unknown>;
  const nested =
    rec.verification && typeof rec.verification === 'object' && !Array.isArray(rec.verification)
      ? (rec.verification as Record<string, unknown>)
      : {};
  const strings = (value: unknown): string[] =>
    typeof value === 'string'
      ? [value]
      : Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === 'string')
        : [];
  return [
    ...strings(rec.summary),
    ...strings(rec.tests),
    ...strings(rec.testsRun),
    ...strings(rec.testResult),
    ...strings(rec.verifiedHow),
    ...strings(rec.coordNotes),
    ...strings(rec.whatLanded),
    ...strings(rec.deferred),
    ...strings(rec.migrations),
    ...strings(nested.testsRun),
    ...strings(nested.testResult),
    ...strings(nested.verifiedHow),
  ];
}

/**
 * Path-vintage claims need a narrower prose population than the general completion
 * text used by the other advisory detectors. `testsRun`, `testResult`, `verifiedHow`,
 * and `coordNotes` routinely cite a script, command, or probe path as evidence without
 * claiming that path was changed. `deferred` and `migrations` likewise describe
 * surrounding work, not the changed-file census. Only the completion headline and
 * landed-change descriptions can supplement the structured `filesChanged` declaration.
 */
function completionTargetClaimTextParts(completion: unknown): string[] {
  if (!completion || typeof completion !== 'object' || Array.isArray(completion)) return [];
  const rec = completion as Record<string, unknown>;
  const strings = (value: unknown): string[] =>
    typeof value === 'string'
      ? [value]
      : Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === 'string')
        : [];
  return [...strings(rec.summary), ...strings(rec.whatLanded)];
}

/**
 * EI-20551121122206657: `addedTests` read from BOTH placements, mirroring
 * completionFilesChanged below. The tool's own description tells callers to put
 * structured evidence under `completion.verification`, so reading only the top level
 * silently ignored the flag for every caller who followed that advice.
 */
function completionAddedTests(completion: unknown): boolean {
  if (!completion || typeof completion !== 'object' || Array.isArray(completion)) return false;
  const rec = completion as Record<string, unknown>;
  const nested =
    rec.verification && typeof rec.verification === 'object' && !Array.isArray(rec.verification)
      ? (rec.verification as Record<string, unknown>)
      : {};
  return rec.addedTests === true || nested.addedTests === true;
}

function completionFilesChanged(completion: unknown): string[] {
  if (!completion || typeof completion !== 'object' || Array.isArray(completion)) return [];
  const rec = completion as Record<string, unknown>;
  const nested =
    rec.verification && typeof rec.verification === 'object' && !Array.isArray(rec.verification)
      ? (rec.verification as Record<string, unknown>)
      : {};
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
  return [...strings(rec.filesChanged), ...strings(nested.filesChanged)];
}

function completionFilesDeleted(completion: unknown): string[] {
  if (!completion || typeof completion !== 'object' || Array.isArray(completion)) return [];
  const rec = completion as Record<string, unknown>;
  const nested =
    rec.verification && typeof rec.verification === 'object' && !Array.isArray(rec.verification)
      ? (rec.verification as Record<string, unknown>)
      : {};
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
  return [...strings(rec.filesDeleted), ...strings(nested.filesDeleted)];
}

function completionHasFilesChanged(completion: unknown): boolean {
  if (!completion || typeof completion !== 'object' || Array.isArray(completion)) return false;
  const rec = completion as Record<string, unknown>;
  const nested =
    rec.verification && typeof rec.verification === 'object' && !Array.isArray(rec.verification)
      ? (rec.verification as Record<string, unknown>)
      : {};
  return (
    Object.prototype.hasOwnProperty.call(rec, 'filesChanged') ||
    Object.prototype.hasOwnProperty.call(nested, 'filesChanged')
  );
}

/**
 * Completion-specific Git trackedness seam for scratch-path references. `true` means Git
 * definitely tracks the repo-relative path, `false` means Git definitely does not (including
 * an ignored path), and `undefined`/`null` means ownership could not be determined. Only the
 * definite positive suppresses the generic scratch warning; every other result stays
 * fail-open and keeps the warning visible.
 */
export type CompletionTrackednessProbe = (
  repoRoot: string,
  repoRelativePath: string,
) => boolean | null | undefined;

export interface CompletionEphemeralDeliverableProbe {
  /** Compatibility seam for one candidate checkout. */
  repoRoot?: string | null;
  /** Candidate checkouts; an explicit empty list means "cannot judge", never guess. */
  repoRoots?: readonly (string | null)[];
  /** Injectable Git answer used by focused tests and alternate checkout owners. */
  isTracked?: CompletionTrackednessProbe;
  /** Server-observed evidence identity used to clear an artifact URL after durable remediation. */
  treeStamp?: CompletionTreeStamp | null;
  /** Completion/evidence filesChanged paths paired with the server identity stamp. */
  changedPaths?: readonly string[];
}

/**
 * Ask Git whether a path is in the index. `git ls-files --error-unmatch` returns status 1
 * for both an ordinary untracked path and an ignored path, which are intentionally the same
 * warning-bearing population here. Any other failure is ownership uncertainty and remains
 * `undefined` so a broken Git/package install cannot silently suppress a warning.
 */
function defaultCompletionTrackedness(repoRoot: string, repoRelativePath: string): boolean | undefined {
  try {
    execFileSync('git', ['-C', repoRoot, 'ls-files', '--error-unmatch', '--', repoRelativePath], {
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 5_000,
      killSignal: 'SIGKILL',
    });
    return true;
  } catch (error) {
    const status =
      typeof error === 'object' && error !== null && 'status' in error
        ? (error as { status?: unknown }).status
        : undefined;
    return status === 1 ? false : undefined;
  }
}

function completionScratchRepoRelativePath(reference: string, repoRoot: string): string | undefined {
  const value = reference.trim();
  if (!value || value.startsWith('~')) return undefined;

  // A leading parent traversal is an external/ambiguous ownership claim. Keep it warning-
  // bearing even if normalisation would happen to land under a candidate root.
  if (value === '..' || value.startsWith('../') || value.startsWith('..\\')) return undefined;

  const root = nodePath.resolve(repoRoot);
  const absolute = nodePath.isAbsolute(value) ? nodePath.resolve(value) : nodePath.resolve(root, value);
  const relative = nodePath.relative(root, absolute);
  if (!relative || relative === '..' || relative.startsWith('..' + nodePath.sep) || nodePath.isAbsolute(relative)) {
    return undefined;
  }
  return relative.split(nodePath.sep).join('/');
}

function completionCandidateRoots(probe: CompletionEphemeralDeliverableProbe): string[] {
  const rawRoots = 'repoRoots' in probe ? probe.repoRoots : ['repoRoot' in probe ? probe.repoRoot : completionRoot()];
  return [
    ...new Set(
      (rawRoots ?? [])
        .filter((root): root is string => typeof root === 'string' && root.trim().length > 0)
        .map((root) => nodePath.resolve(root)),
    ),
  ];
}

type CompletionTreeIdentity = NonNullable<CompletionTreeStamp['contentIdentity']>[number];

function completionIdentityMatchesChangedPath(
  identity: CompletionTreeIdentity,
  changedPaths: readonly string[],
  treeStamp: CompletionTreeStamp,
): boolean {
  const normalize = (path: string): string =>
    path
      .trim()
      .replaceAll('\\', '/')
      .replace(/^\.\/+/, '');
  const identityPath = normalize(identity.path);
  const roots = [identity.repositoryRoot, treeStamp.repositoryRoot]
    .filter((root): root is string => typeof root === 'string' && root.trim().length > 0)
    .map((root) => nodePath.resolve(root));

  return changedPaths.some((rawPath) => {
    const declaredPath = normalize(rawPath);
    if (declaredPath === identityPath) return true;
    return roots.some((root) => {
      const declaredAbsolute = nodePath.isAbsolute(rawPath)
        ? nodePath.resolve(rawPath)
        : nodePath.resolve(root, rawPath);
      const identityAbsolute = nodePath.resolve(root, identityPath);
      return declaredAbsolute === identityAbsolute || declaredPath === `${nodePath.basename(root)}/${identityPath}`;
    });
  });
}

function filterTrackedCompletionScratchReferences(
  references: ReturnType<typeof detectEphemeralDeliverableReferences>,
  probe: CompletionEphemeralDeliverableProbe = {},
): ReturnType<typeof detectEphemeralDeliverableReferences> {
  // An artifact URL is normally account/session-local, but it is a legitimate source
  // citation when the same completion also names a non-deleted repository path whose
  // server-observed working-tree and HEAD blobs match.  Do not infer this from
  // `filesChanged` alone: that field is caller testimony, while the tree stamp is the
  // server's durable identity proof.  Missing, mismatched, deleted, and out-of-repo
  // identities deliberately keep the warning visible (fail-open).
  const hasProvenDurableChangedPath = Boolean(
    probe.treeStamp?.contentIdentity?.some(
      (identity) =>
        completionIdentityMatchesChangedPath(identity, probe.changedPaths ?? [], probe.treeStamp!) &&
        identity.outOfRepoArtifact !== true &&
        identity.deletion !== true &&
        identity.workingTreeBlobSha !== null &&
        identity.headBlobSha !== null &&
        identity.workingTreeBlobSha === identity.headBlobSha,
    ),
  );
  const roots = completionCandidateRoots(probe);
  const isTracked = probe.isTracked ?? defaultCompletionTrackedness;

  return references.filter((reference) => {
    if (reference.kind === 'artifact-url') return !hasProvenDurableChangedPath;
    if (reference.kind !== 'scratch-path') return true;
    if (roots.length === 0) return true;
    // Suppress only a definite positive. A false result (untracked/ignored), an unknown
    // result, an exception, or a path that cannot be mapped to a candidate root all preserve
    // the original advisory warning.
    for (const root of roots) {
      const relativePath = completionScratchRepoRelativePath(reference.reference, root);
      if (!relativePath) continue;
      try {
        if (isTracked(root, relativePath) === true) return false;
      } catch {
        // Unknown ownership is deliberately fail-open: leave this reference in the warning.
      }
    }
    return true;
  });
}

/**
 * Completion evidence legitimately names loopback service/API origins while
 * explaining HOW a fix was verified. That is diagnostic provenance, not a
 * terminal deliverable. A loopback URL becomes durability-relevant only when
 * the completion presents it in deliverable-facing prose (`summary` or
 * `whatLanded`). Scratch paths and account-scoped artifact URLs are likewise
 * suspect only in deliverable-facing fields; verification and causal prose
 * routinely quote those references as forensic evidence.
 */
export function completionEphemeralDeliverableReferences(
  completion: unknown,
  evidence: unknown,
  probe: CompletionEphemeralDeliverableProbe = {},
) {
  const deliverableTextParts = (value: unknown): string[] => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const record = value as Record<string, unknown>;
    const verification =
      record.verification && typeof record.verification === 'object' && !Array.isArray(record.verification)
        ? (record.verification as Record<string, unknown>)
        : {};
    const strings = (entry: unknown): string[] =>
      typeof entry === 'string'
        ? [entry]
        : Array.isArray(entry)
          ? entry.filter((part): part is string => typeof part === 'string')
          : [];

    // These are the fields that can name the durable output itself. Do not scan
    // testsRun/testResult/verifiedHow, rootCauseVerification, deferred, coordNotes,
    // or server-generated evidence: those fields routinely quote ephemeral paths
    // while describing how the result was established.
    return [
      ...strings(record.summary),
      ...strings(record.whatLanded),
      ...strings(record.filesChanged),
      ...strings(record.filesDeleted),
      ...strings(record.migrations),
      ...strings(record.deploy),
      ...strings(verification.filesChanged),
      ...strings(verification.filesDeleted),
    ];
  };

  const references = detectEphemeralDeliverableReferences(
    [...deliverableTextParts(completion), ...deliverableTextParts(evidence)].join('\n'),
  );
  return filterTrackedCompletionScratchReferences(references, {
    ...probe,
    changedPaths: [...completionFilesChanged(completion), ...completionFilesChanged(evidence)],
  });
}

function completionStructuredEvidenceTexts(completion: unknown): {
  testsRun: string[];
  testResult: string[];
  verifiedHow: string[];
} {
  if (!completion || typeof completion !== 'object' || Array.isArray(completion)) {
    return { testsRun: [], testResult: [], verifiedHow: [] };
  }
  const rec = completion as Record<string, unknown>;
  const nested =
    rec.verification && typeof rec.verification === 'object' && !Array.isArray(rec.verification)
      ? (rec.verification as Record<string, unknown>)
      : {};
  const strings = (value: unknown): string[] =>
    typeof value === 'string'
      ? [value]
      : Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === 'string')
        : [];
  return {
    // `verification` is canonical; the top-level fields are legacy aliases. Keep the
    // same precedence as completionEvidenceFromRecord so a stale alias cannot make a
    // structured test citation disappear from this advisory.
    testsRun: strings(nested.testsRun ?? rec.testsRun ?? rec.tests),
    testResult: strings(nested.testResult ?? rec.testResult),
    verifiedHow: strings(nested.verifiedHow ?? rec.verifiedHow),
  };
}

const ITEM_REPO_PATH_RE = /\b(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+\b/g;

function prescribedItemPaths(item: { title?: unknown; summary?: unknown; payload?: unknown }): string[] {
  const payload =
    item.payload && typeof item.payload === 'object' && !Array.isArray(item.payload)
      ? (item.payload as Record<string, unknown>)
      : {};
  const pathValues = ['paths', 'testPaths', 'guardPaths'].flatMap((key) =>
    Array.isArray(payload[key]) ? payload[key] : [],
  );
  const prosePaths = [...prescribedItemText(item).matchAll(ITEM_REPO_PATH_RE)].map((match) => match[0]);
  return Array.from(
    new Set(
      [...pathValues, ...prosePaths].map(repoRelativePath).filter((path): path is string => Boolean(path)),
    ),
  );
}

function pathMentionedInEvidence(text: string, declaredPath: string): boolean {
  const normalizedPath = repoRelativePath(declaredPath);
  if (!normalizedPath) return false;
  const normalizedText = text.replaceAll('\\', '/');
  const segments = normalizedPath.split('/');
  const variants = [normalizedPath];
  // Commands run from a package workspace commonly omit the leading
  // `packages/<package>/` segments. Try path suffixes with at least two segments,
  // which recognizes `lib/__tests__/foo.test.ts` without reducing every basename
  // mention to evidence for an unrelated test.
  for (let start = 1; start < segments.length - 1; start += 1) {
    variants.push(segments.slice(start).join('/'));
  }
  return variants.some((variant) => normalizedText.includes(variant));
}

const TEST_PATH_RE = /(?:^|[/\\])(?:test|tests|__tests__)(?:[/\\]|$)|\.(?:test|spec)\.[^.]+$/i;
const TEST_EVIDENCE_PATH_RE =
  /\b(?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+\.(?:test|spec)\.[A-Za-z0-9_.-]+\b/gi;

function completionTestPathReferences(parts: readonly string[], filesChanged: readonly string[]): string[] {
  const prosePaths = parts.flatMap((part) => [...part.matchAll(TEST_EVIDENCE_PATH_RE)].map((match) => match[0]));
  return Array.from(
    new Set(
      [...filesChanged, ...prosePaths]
        .map(repoRelativePath)
        .filter((path): path is string => typeof path === 'string' && TEST_PATH_RE.test(path)),
    ),
  );
}

function passingTestResult(text: string): boolean {
  if (!/\b(?:pass(?:ed|es|ing)?|green|success(?:ful)?)\b/i.test(text)) return false;
  return !(
    /\b[1-9]\d*\s+(?:tests?\s+)?(?:fail(?:ed|ure|ures|ing)?|error(?:s)?)\b/i.test(text) ||
    /\b(?:fail(?:ed|ure|ures|ing)?|error(?:s)?)\s*[:=]\s*[1-9]\d*\b/i.test(text)
  );
}

function repoRelativePath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (
    !normalized ||
    normalized.includes('*') ||
    normalized.includes('?') ||
    normalized.startsWith('/') ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  ) {
    return undefined;
  }
  return normalized;
}

function sameRepoPath(left: string, right: string): boolean {
  return left === right || left.endsWith('/' + right) || right.endsWith('/' + left);
}

function completionClaimsTargetPaths(itemPaths: string[], completion: unknown): string[] {
  if (itemPaths.length === 0) return [];
  const filesChanged = completionFilesChanged(completion)
    .map(repoRelativePath)
    .filter((path): path is string => Boolean(path));
  const hasFilesChanged = completionHasFilesChanged(completion);
  const prose = completionTargetClaimTextParts(completion).join('\n');
  const explicitlyClaimed = itemPaths.filter(
    (target) => filesChanged.some((file) => sameRepoPath(file, target)) || prose.includes(target),
  );
  if (PATH_CLAIM_ALL_RE.test(prose)) {
    // A broad phrase can legitimately stand in for the item's target list when the
    // completion does not provide a file census. Once `filesChanged` is present,
    // however, it is the closer's explicit claim set. Do not widen that set back to
    // every item target: a generic evidence phrase such as "all 5 changed files"
    // otherwise makes an unrelated prescribed path look positively claimed.
    return hasFilesChanged ? explicitlyClaimed : itemPaths;
  }
  return explicitlyClaimed;
}

function epochSeconds(value: unknown): number | undefined {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms / 1000 : undefined;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    return value > 1_000_000_000_000 ? value / 1000 : value;
  }
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric > 1_000_000_000_000 ? numeric / 1000 : numeric;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms / 1000 : undefined;
}

/**
 * EI-20288629053504794: detect a completion that positively claims work on a named
 * target path whose last commit predates the work-item. This is deliberately a
 * WARN-ONLY, fail-open advisory: unknown roots, malformed dates, unresolvable git
 * history, and paths that cannot be tied to the completion all return no finding.
 *
 * The default history read reuses the existing argv-safe lastCommitTimes helper.
 * Tests inject the per-path read so the predicate remains pure and never touches git.
 */
export function preExistingChangedPathsInCompletion(
  item: { createdAt?: unknown; payload?: unknown },
  completion: unknown,
  probe: CompletionPathVintageProbe = {},
): { createdAt: string; paths: CompletionPathVintageHit[] } | undefined {
  const createdAtSec = epochSeconds(item.createdAt);
  if (createdAtSec === undefined) return undefined;
  const payload =
    item.payload && typeof item.payload === 'object' && !Array.isArray(item.payload)
      ? (item.payload as Record<string, unknown>)
      : {};
  const itemPaths = Array.isArray(payload.paths)
    ? Array.from(
        new Set(
          payload.paths
            .map(repoRelativePath)
            .filter((path): path is string => Boolean(path))
            .slice(0, PATH_VINTAGE_MAX_PATHS),
        ),
      )
    : [];
  const claimedPaths = completionClaimsTargetPaths(itemPaths, completion);
  if (claimedPaths.length === 0) return undefined;

  const repoRoot = 'repoRoot' in probe ? probe.repoRoot : completionRoot();
  if (!repoRoot) return undefined;
  let fallbackTimes: Map<string, number | null> | undefined;
  if (!probe.lastCommitAt) {
    fallbackTimes = new Map();
    const history = probe.lastCommitTimes ?? lastCommitTimes;
    const byRepository = new Map<string, Array<{ originalPath: string; repositoryPath: string }>>();
    for (const path of claimedPaths) {
      const resolved = completionHistoryPath(repoRoot, path);
      if (!resolved) continue;
      const paths = byRepository.get(resolved.repoRoot) ?? [];
      paths.push({ originalPath: path, repositoryPath: resolved.path });
      byRepository.set(resolved.repoRoot, paths);
    }
    for (const [historyRoot, paths] of byRepository) {
      try {
        const times = history(
          historyRoot,
          paths.map((entry) => entry.repositoryPath),
        );
        for (const entry of paths) {
          fallbackTimes.set(entry.originalPath, times.get(entry.repositoryPath) ?? null);
        }
      } catch {
        // History is advisory: an unavailable repository must not fail completion.
      }
    }
  }

  const hits: CompletionPathVintageHit[] = [];
  for (const path of claimedPaths) {
    let raw: number | string | Date | null | undefined;
    try {
      raw = probe.lastCommitAt ? probe.lastCommitAt(path) : fallbackTimes?.get(path);
    } catch {
      continue;
    }
    const commitSec = epochSeconds(raw);
    if (commitSec === undefined || commitSec >= createdAtSec) continue;
    hits.push({ path, lastCommitAt: new Date(commitSec * 1000).toISOString() });
  }
  return hits.length > 0 ? { createdAt: new Date(createdAtSec * 1000).toISOString(), paths: hits } : undefined;
}

const PRESCRIBED_GUARD_RE =
  /\b(?:recurrence\s+guard|regression\s+(?:guard|test)|falsifier|guard|assert(?:ion|ing|ed)?|sentinel)\b/i;
const PRESCRIBED_TEST_RE =
  /\b(?:add|added|create|created|write|written|include|included|provide|provided|require|required|must|should|prescrib(?:e|ed|es)|ensure|ensures|needed|needs|point(?:ed)?|cover(?:ed)?)\b[\s\S]{0,70}\b(?:test|coverage|assert(?:ion|ing)?)\b/i;
const COMPLETION_GUARD_RE = /\b(?:recurrence|regression|falsifier|guard|assert(?:ion|ing|ed)?|sentinel)\b/i;
// EI-21447362440754444: the SECOND alternative (guard-word THEN negation) must not fire on a
// contrastive "X, not Y" clause. In that construction the negation attaches to Y — what FOLLOWS
// `not` — so a guard-word sitting on the LEFT of the comma is the AFFIRMED side, not the denied
// one. Measured on the close of WI-41672, which added both a guard and a falsifiability control
// test and was still warned: "the red was in the guard, not the Rust" and "control test uses
// plain `it`, not `maybe`" both matched, and `negativeSomewhere` then cancelled a structured
// addedTests + real-test-path citation.
//
// The `(?<!,\s{0,10})` lookbehind removes ONLY that shape. A genuine disclaimer is untouched
// because its negation is not comma-led ("guard was not added", "test not written"), and one
// phrased contrastively ("I added a fix, not a test") still matches the FIRST alternative, where
// the guard-word correctly follows the negation. Same bias this function's EI-20551121122206657
// comment describes below — a longer, better-documented completion trips it more often — one
// level further in: that fix scoped matching per-part, this one scopes it within a part.
const COMPLETION_NEGATIVE_GUARD_RE =
  /(?:\b(?:no|not|without|missing|absent|defer(?:red)?|left\s+out|did\s+not|didn['’]?t)\b[\s\S]{0,45}\b(?:recurrence|regression|falsifier|guard|assert(?:ion|ing|ed)?|test|coverage)\b|\b(?:recurrence|regression|falsifier|guard|assert(?:ion|ing|ed)?|test|coverage)\b[\s\S]{0,45}(?<!,\s{0,10})\b(?:not|missing|absent|defer(?:red)?|left\s+out|did\s+not|didn['’]?)\b)/i;
const EXPLICIT_GUARD_WAIVER_RE =
  /\b(?:waiv(?:e|ed|er)|not\s+applicable)\b[\s\S]{0,160}\b(?:because|since|as|reason|already|existing|covered|present|exists|implemented|by|:|—|-)\b/i;
const HISTORICAL_NON_PRESCRIPTIVE_RE =
  /\b(?:quot(?:e|ed|ation)|historical|prior|previous|former|earlier|anecdote|motivating\s+incident)\b[\s\S]{0,240}\b(?:does\s+not|doesn['’]?t|did\s+not|didn['’]?t|not)\s+(?:explicitly\s+)?prescrib(?:e|es|ed|ing)\b/i;

function prescribedItemText(item: { title?: unknown; summary?: unknown; payload?: unknown }): string {
  const payload =
    item.payload && typeof item.payload === 'object' && !Array.isArray(item.payload)
      ? (item.payload as Record<string, unknown>)
      : {};
  return [
    typeof item.title === 'string' ? item.title : '',
    typeof item.summary === 'string' ? item.summary : '',
    ...['body', 'description', 'fix', 'proposedFix', 'acceptance'].flatMap((key) =>
      typeof payload[key] === 'string' ? [payload[key] as string] : [],
    ),
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * EI-20288629053504794: identify an item's explicitly prescribed recurrence guard /
 * regression-test obligation that the completion never points to. This is a lexical,
 * warn-only detector by design: it never asserts that a guard is correct, and it stays
 * silent when the prescription or the completion's coverage cannot be understood.
 */
export function prescribedRecurrenceGuardCoverageGap(
  item: { title?: unknown; summary?: unknown; payload?: unknown },
  completion: unknown,
): { prescriptions: string[] } | undefined {
  const prescriptions = prescribedItemText(item)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line || line.length > 500) return false;
      // A summary can quote a prior incident that contains imperative-looking
      // wording (for example, "a prior agent had 'added a recurrence-guard'")
      // while explicitly explaining that the anecdote is not an obligation for
      // this item. Treat that sentence as historical context, not a live
      // prescription; otherwise the detector turns its own explanatory prose
      // into the warning it is meant to avoid.
      if (HISTORICAL_NON_PRESCRIPTIVE_RE.test(line)) return false;
      const guardPrescription =
        PRESCRIBED_GUARD_RE.test(line) &&
        /\b(?:add|added|create|created|write|written|include|included|provide|provided|require|required|must|should|prescrib(?:e|ed|es)|ensure|ensures|needed|needs|assert(?:ing|ion)?|falsifier)\b/i.test(
          line,
        );
      return guardPrescription || PRESCRIBED_TEST_RE.test(line);
    })
    .slice(0, 5);
  if (prescriptions.length === 0) return undefined;

  const record =
    completion && typeof completion === 'object' && !Array.isArray(completion)
      ? (completion as Record<string, unknown>)
      : {};
  // EI-20551121122206657: match PER PART, never over the parts joined together.
  // These three regexes are sentence-scoped heuristics with windows of 45–160 chars,
  // and completionTextParts returns INDEPENDENT fields (summary, whatLanded[], deferred[],
  // verification.testsRun, …). Joining them first let the tail of one field and the head
  // of an unrelated one form a phantom match across the boundary. Measured on the close of
  // EI-20547482952043431: summary ended "…read before filing, not duplicated." and
  // whatLanded[0] began "ordering guard generalized from…", producing the negation
  // "not duplicated.\nordering guard" — which cancelled a correct guard citation and
  // emitted the warning against a completion that named its guard three times over.
  // Neither field is negative about a guard in isolation, so the false alarm was
  // unreproducible from reading any single field, and it grew MORE likely the longer and
  // better-documented the completion was.
  const parts = completionTextParts(record);
  const partNegative = (part: string): boolean => COMPLETION_NEGATIVE_GUARD_RE.test(part);
  const filesChanged = completionFilesChanged(record);
  const testPath = filesChanged.some((path) => TEST_PATH_RE.test(path));
  const structuredEvidence = completionStructuredEvidenceTexts(record);
  const structuredEvidenceParts = [
    ...structuredEvidence.testsRun,
    ...structuredEvidence.testResult,
    ...structuredEvidence.verifiedHow,
  ];
  const declaredTestPath = prescribedItemPaths(item).filter((path) => TEST_PATH_RE.test(path));
  // A completion may run the prescribed test from its package cwd, so its
  // `testsRun` path can omit the repository's `packages/<package>/` prefix. Credit
  // that structured citation only when it matches a test path declared by the item;
  // an arbitrary passing unit test is not proof of the prescribed recurrence guard.
  const pointsToDeclaredTest =
    declaredTestPath.some((path) => structuredEvidenceParts.some((part) => pathMentionedInEvidence(part, path))) &&
    !structuredEvidenceParts.some(partNegative);
  const filesDeleted = completionFilesDeleted(record)
    .map(repoRelativePath)
    .filter((path): path is string => Boolean(path));
  const deletedPrescribedTestPath = declaredTestPath.some((path) =>
    filesDeleted.some((deletedPath) => sameRepoPath(deletedPath, path)),
  );
  // A disclaimer anywhere still withholds credit from the bare addedTests+path pair (that
  // pair carries no prose of its own to disclaim); it is now evaluated per part, so only a
  // real disclaimer counts, not one manufactured at a field boundary.
  const negativeSomewhere = parts.some(partNegative);
  const pointsToGuard = parts.some((part) => COMPLETION_GUARD_RE.test(part) && !partNegative(part));
  const pointsToAddedTest = completionAddedTests(record) && testPath && !negativeSomewhere;
  // An obsolete prescribed test may be intentionally removed while its replacement test and
  // recurrence guard remain covered. Require all three pieces of evidence before crediting
  // that disposition: the deleted path must be one the item explicitly names, a distinct test
  // path must be changed or cited, and the structured test result must report a pass. A deleted
  // path by itself, a passing unrelated suite, or a disclaimer still leaves the warning visible.
  const replacementTestPaths = completionTestPathReferences(structuredEvidenceParts, filesChanged);
  const pointsToDeletedReplacement =
    deletedPrescribedTestPath &&
    replacementTestPaths.some(
      (replacementPath) => !filesDeleted.some((deletedPath) => sameRepoPath(deletedPath, replacementPath)),
    ) &&
    structuredEvidence.testResult.some(passingTestResult) &&
    !negativeSomewhere &&
    !structuredEvidenceParts.some(partNegative);
  const explicitWaiver = parts.some((part) => EXPLICIT_GUARD_WAIVER_RE.test(part));
  if (pointsToGuard || pointsToAddedTest || pointsToDeclaredTest || pointsToDeletedReplacement || explicitWaiver) {
    return undefined;
  }
  return { prescriptions };
}

/**
 * EI-19455334047866968 / EI-19411072468868467: gather EVERY prose field the caller
 * actually wrote into this completion, for the dangling-ref scan.
 *
 * Reads the RAW record, not `CompletionVerificationEvidence` — `deferred`, `coordNotes`,
 * `whatLanded` and `migrations` are NOT on that type, so scanning the evidence alone would
 * silently miss them. `deferred` is the highest-risk field in the whole record: it is where
 * a completion cites the follow-up item it just minted, which is precisely the moment an id
 * is written from a guess rather than from a returned value. EI-19411072468868467 measured
 * exactly that — the phantom sat in `summary` AND `deferred`.
 *
 * Falls back to the gate evidence per-field, because a bare-STRING completion is coerced
 * into `{ summary }` and the raw record's other fields are then genuinely absent.
 *
 * PURE — unit-tested without PG, like its path-shaped sibling above.
 */
export function completionRefBody(completion: unknown, evidence?: CompletionVerificationEvidence | undefined): string {
  const rec = (completion ?? {}) as {
    summary?: unknown;
    testsRun?: unknown;
    testResult?: unknown;
    coordNotes?: unknown;
    whatLanded?: unknown;
    deferred?: unknown;
    migrations?: unknown;
  };
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

  return [
    str(rec.summary) ?? evidence?.summary,
    str(rec.testsRun) ?? evidence?.testsRun,
    str(rec.testResult) ?? evidence?.testResult,
    str(rec.coordNotes),
    ...arr(rec.whatLanded),
    ...arr(rec.deferred),
    ...arr(rec.migrations),
  ]
    .filter(Boolean)
    .join('\n');
}

/** Cheap, bounded repair of a path that does not exist. Returns undefined when unsure. */
function suggestExistingPath(
  declaredPath: string,
  repoRoot: string,
  exists: (abs: string) => boolean,
  siblings: (abs: string) => string[],
): string | undefined {
  const segments = declaredPath.split('/').filter(Boolean);

  // 1. An INSERTED segment — the observed failure shape (`agent-tools/`, `__tests__/`).
  //    Never drop the basename: that would "repair" a path to its own directory.
  for (let i = 0; i < segments.length - 1; i++) {
    const candidate = [...segments.slice(0, i), ...segments.slice(i + 1)].join('/');
    try {
      if (exists(nodePath.resolve(repoRoot, candidate))) return candidate;
    } catch {
      /* keep trying the remaining repairs */
    }
  }

  // 2. A misremembered BASENAME in a directory that does exist.
  const dir = segments.slice(0, -1).join('/');
  const base = segments[segments.length - 1];
  if (!base) return undefined;
  try {
    const absDir = nodePath.resolve(repoRoot, dir);
    if (!exists(absDir)) return undefined;
    // Leading token: `790-expose-goal-id….sql` and `790-engineer-issues….sql` share `790`;
    // `create.test.ts` and `create.ts` share `create`. Two chars minimum so a stray
    // single letter cannot match half the directory.
    const token = base.split(/[-._]/)[0];
    if (!token || token.length < 2) return undefined;
    const hit = siblings(absDir).find((entry) => entry !== base && entry.split(/[-._]/)[0] === token);
    return hit ? (dir ? `${dir}/${hit}` : hit) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Exported for the wiring test only (EI-22175397357614106) — same reason
 * `isVerificationWorkItem` / `claimsUniversalVerification` below are exported. This is a
 * WHITELIST, and a field it forgets is dropped silently, so the mapping itself needs a
 * test that no amount of testing the downstream algorithm can substitute for.
 */
export function completionEvidenceFromRecord(
  rec: Omit<CompletionRecord, 'workItem' | 'status'> & { workItem?: string; status?: string },
): CompletionVerificationEvidence | undefined {
  const nested = rec.verification ?? {};
  // EI-20489220527537464: `verification` is the canonical evidence object and the
  // top-level siblings are legacy aliases (CompletionRecordSchema says exactly that),
  // so canonical values must win when a caller supplies both. The inverse precedence
  // discarded a real screenshot cited in `verification.testResult` whenever a terse
  // legacy `testResult: "pass"` was also present, causing the live-UI close guard to
  // reject the evidence until the caller duplicated the path into the alias.
  const filesChanged = nested.filesChanged ?? rec.filesChanged;
  const filesDeleted = nested.filesDeleted ?? rec.filesDeleted;
  const testsRun = nested.testsRun ?? rec.testsRun ?? rec.tests;
  const testResult = nested.testResult ?? rec.testResult;
  const verifiedHow = nested.verifiedHow ?? rec.verifiedHow;
  const workOutcome = nested.workOutcome;
  const addedTests = nested.addedTests ?? rec.addedTests;
  const coverage = nested.coverage ?? rec.coverage;
  // P-021 / D-014: canonical-nested ONLY, deliberately no top-level alias. The aliases
  // above are legacy carry-over that CompletionRecordSchema already documents as such;
  // minting a new one would widen the tool's arg surface for a field that has no legacy
  // callers to keep cheap.
  const requirementDisposition = nested.requirementDisposition;
  // EI-22175397357614106: canonical-nested ONLY, no top-level alias — same reasoning as
  // requirementDisposition above (a new field has no legacy callers to keep cheap).
  //
  // ⚠ This function is a WHITELIST: a field absent from it is silently dropped, so the
  // downstream claim evaluation reads `undefined` and every claim goes unchecked while
  // the close still reports success. That is the "checked zero, therefore green" shape,
  // and it is invisible to any test that exercises the evaluator directly — which is why
  // `complete.claims-wiring.test.ts` asserts the plumbing here rather than the algorithm.
  const claims = nested.claims;
  const evidence: CompletionVerificationEvidence = {};
  if (requirementDisposition?.length) evidence.requirementDisposition = requirementDisposition;
  if (claims?.length) evidence.claims = claims;
  if (filesChanged?.length) evidence.filesChanged = filesChanged;
  if (filesDeleted?.length) evidence.filesDeleted = filesDeleted;
  if (testsRun?.trim()) evidence.testsRun = testsRun;
  if (testResult?.trim()) evidence.testResult = testResult;
  if (verifiedHow) evidence.verifiedHow = verifiedHow;
  if (workOutcome) evidence.workOutcome = workOutcome;
  if (addedTests !== undefined) evidence.addedTests = addedTests;
  if (coverage) evidence.coverage = coverage;
  return Object.keys(evidence).length > 0 ? evidence : undefined;
}

const CHECKPOINT_PROSE_SNAPSHOT_TRUNCATION_MARKER = '…[truncated]';

/**
 * Preserve the narrative portion of a checkpoint before terminal cleanup clears
 * its replace-on-write note. Structured checks are carried separately, so this
 * snapshot is the prose surface an evidence citation can still resolve against.
 * Truncate explicitly rather than allowing a large checkpoint to inflate every
 * terminal completion read.
 */
function boundedCheckpointProseSnapshot(note: string | null | undefined): string | undefined {
  const prose = splitCarryNoteWalls(splitCarryNoteChecks(note).body).body.trim();
  if (!prose) return undefined;
  if (prose.length <= CHECKPOINT_PROSE_SNAPSHOT_MAX_CHARS) return prose;
  const contentLength = Math.max(
    0,
    CHECKPOINT_PROSE_SNAPSHOT_MAX_CHARS - CHECKPOINT_PROSE_SNAPSHOT_TRUNCATION_MARKER.length,
  );
  return `${prose.slice(0, contentLength)}${CHECKPOINT_PROSE_SNAPSHOT_TRUNCATION_MARKER}`;
}

/**
 * WI-2142447 — fold the CLOSE-TIME claim verdicts onto the record about to be persisted.
 *
 * The grade is already decided by the time this runs (the `claimsFalsified` finding); this
 * is the RECORD that finding leaves behind, and it is the only thing that later lets the
 * post-close sweep tell a claim that has GONE false from one that was already false when
 * written and was already graded for it. Narrative-side, like `selfReviewJudgement`: it
 * describes the close and never promotes one.
 *
 * EXPORTED, and applied through this function rather than inline at the persist site, for
 * the reason `complete.claims-wiring.test.ts` exists: the `claims` feature shipped complete
 * and correct on both sides of a mapping that never copied the field, and no test of either
 * side could see it. A fold that only lives inside a 3,000-line function has the same
 * shape — so it lives here, where a test can reach it.
 *
 * Deliberately preserves the persist site's invariant that a close carrying NO record at
 * all never gains an `_completionEvidence` object whose only key came from the server.
 */
export function withClaimBaseline(
  evidence: PersistedCompletionEvidence | undefined,
  claimVerdicts: CompletionClaimsReport | undefined,
  at: string,
): PersistedCompletionEvidence | undefined {
  if (!evidence || !claimVerdicts) return evidence;
  const baseline = completionClaimBaseline(claimVerdicts, at);
  return baseline ? { ...evidence, claimVerdicts: baseline } : evidence;
}

/** WI-37960: work whose title/metadata says it is a verification pass needs
 * population-aware completion evidence when it makes a universal claim. */
const VERIFICATION_ITEM_MARKER_RE =
  /\b(?:verification|verify|verified|audit|accuracy[- ]check|fact[- ]check|source[- ]check|traceab(?:le|ility))\b/i;

export function isVerificationWorkItem(item: {
  kind?: unknown;
  title?: unknown;
  summary?: unknown;
  payload?: unknown;
}): boolean {
  // `task` is a broad deliverable kind that also covers design exploration and other
  // non-verification work. Treating it as a marker made universal language in an
  // ordinary design summary demand a fabricated population partition. Verification
  // tasks still opt in through the same explicit title/summary/metadata markers as
  // every other work-item kind.
  const payload =
    item.payload && typeof item.payload === 'object' && !Array.isArray(item.payload)
      ? (item.payload as Record<string, unknown>)
      : {};
  const markers = [payload.verificationKind, payload.workType, payload.category]
    .filter((v): v is string => typeof v === 'string')
    .join(' ');
  return VERIFICATION_ITEM_MARKER_RE.test(`${item.title ?? ''}\n${item.summary ?? ''}\n${markers}`);
}

/** WI-37960: detect a totality claim about a verification surface, not ordinary
 * prose such as "all tests passed" on a normal code change. */
const UNIVERSAL_VERIFICATION_CLAIM_PATTERNS: readonly RegExp[] = [
  /\b(?:every|each|all|entire|whole|100\s*%|site[- ]wide|fully|completely|nothing|zero)\b[\s\S]{0,120}\b(?:page|field|fact|claim|source|record|species|entry|item|surface|content|statement|tagline|render|invent|un(?:sourced|checked|verified)|unsupported|omitted|miss(?:ed|ing))/i,
  /\b(?:all|every)\s+(?:pages?|fields?|facts?|claims?|sources?|records?|species|entries|taglines?|content)\b/i,
  /\b(?:no|zero)\s+(?:invented|unsupported|unsourced|unverified|unchecked|missing|omitted|gaps?|exceptions?)\b/i,
  /\b(?:site[- ]wide|complete(?:ly)?\s+(?:checked|verified|audited)|fully\s+(?:checked|verified|audited))\b/i,
];

export function claimsUniversalVerification(completion: {
  title?: unknown;
  summary?: unknown;
  tests?: unknown;
  testsRun?: unknown;
  testResult?: unknown;
  coordNotes?: unknown;
  whatLanded?: unknown;
  deferred?: unknown;
}): boolean {
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  const prose = [
    completion.title,
    completion.summary,
    completion.tests,
    completion.testsRun,
    completion.testResult,
    completion.coordNotes,
    ...list(completion.whatLanded),
    ...list(completion.deferred),
  ]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join('\n');
  return UNIVERSAL_VERIFICATION_CLAIM_PATTERNS.some((pattern) => pattern.test(prose));
}

/**
 * WI-213058: identify the most common malformed semantic partition — population entries
 * copied into `residue`. Residue is deliberately not a fourth status bucket, so naming the
 * misplaced entries is more useful than repeating the generic partition failure.
 */
function misplacedResiduePopulationEntries(coverage: CompletionCoverage | undefined): string[] {
  if (!coverage?.population?.length || !coverage.residue?.length) return [];
  const statusEntries = new Set([
    ...(coverage.checked ?? []),
    ...(coverage.notChecked ?? []),
    ...(coverage.notApplicable ?? []),
  ]);
  const residue = new Set(coverage.residue);
  return coverage.population.filter((entry) => !statusEntries.has(entry) && residue.has(entry));
}

interface FinishPlanStamp {
  plan_slug: string;
  item_id: string;
  harness_slug: string;
}

export interface FinishWorkReceipt {
  /** True when the finish replay did not change an existing completion authority. */
  idempotent: boolean;
  /** Finish-side effects remain safe to retry even when authority was re-evaluated. */
  retrySafe: true;
  /** Whether this close changed a previously judged authority. */
  authorityChanged: boolean;
  complete: boolean;
  workItemState: string;
  completionEvidenceStored: boolean;
  checkpointCleared: boolean;
  /** The linked plan item's actual committed stored status after reflection. */
  planItem: string;
  /** Present only when `planItem` did not reach the reflected status: what plans:set-status answered. */
  planItemReflection?: string;
  claimRelease: 'not-linked' | 'released-or-absent' | 'failed';
  errors?: string[];
}

function finishPlanStamp(workItem: Record<string, unknown>): FinishPlanStamp | null {
  const payload = workItem.payload as { plan_item?: Partial<FinishPlanStamp> } | null | undefined;
  const stamp = payload?.plan_item;
  if (!stamp?.plan_slug || !stamp.item_id || !stamp.harness_slug) return null;
  if (!/^P-\d{3,}$/.test(stamp.item_id)) return null;
  return stamp as FinishPlanStamp;
}

function reflectedTerminalStatus(state: string): 'done' | 'dropped' | null {
  if (state === 'passed' || state === 'resolved' || state === 'done') return 'done';
  if (state === 'deprecated' || state === 'closed' || state === 'dropped') return 'dropped';
  return null;
}

/**
 * Read back the canonical plan-item index after the reflected write settles.
 *
 * `fireReactionInProcess` intentionally reports dispatch success only; a guarded
 * `plans:set-status` no-op is therefore also `{ ok:true }`.  The post-write read is
 * the only truthful answer to what status actually committed, and it is safe here:
 * `plans:set-status` updates the canonical plan body and this derived index in the
 * same locked transaction before its dispatch promise resolves.
 */
async function readCommittedPlanItemStatus(stamp: FinishPlanStamp, ctx: UnifiedToolContext): Promise<string | null> {
  const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ status: string | null }>>`
    SELECT status
      FROM harness_shared.plan_items
     WHERE workspace_id = ${workspaceId}
       AND harness_slug = ${stamp.harness_slug}
       AND plan_slug = ${stamp.plan_slug}
       AND item_id = ${stamp.item_id}
     LIMIT 1`;
  const status = String(rows[0]?.status ?? '')
    .trim()
    .toLowerCase();
  return status || null;
}

/** Compact, bounded rendering of a reaction's tool result for a finish-leg error. */
/** Bounded retry for a plans:set-status reflection refused `busy` by the plan lock (WI-10003498). */
export const FINISH_SET_STATUS_BUSY_ATTEMPTS = 4;
export const FINISH_SET_STATUS_BUSY_BACKOFF_MS = 250;

/**
 * The dispatched tool's own result body as an object: either the handler's plain
 * return value, or an MCP-shaped `{ content:[{ text }] }` whose text is JSON.
 * Returns null when there is no parseable object body.
 */
export function reactionBody(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== 'object') return null;
  const content = (result as { content?: Array<{ text?: unknown }> }).content;
  if (Array.isArray(content)) {
    // WI-10003498: the dispatcher appends advisory text parts ("See also: …") after the
    // JSON body. Joining every part made JSON.parse fail, so a body-level `ok:false`
    // (e.g. a plan_items_pkey collision) read as "no body" and complete() reported the
    // stranded plan item as converged. Parse part-by-part; fall back to the join.
    const texts = content.map((part) => (typeof part?.text === 'string' ? part.text : ''));
    for (const text of [...texts, texts.join('')]) {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
      } catch {
        // not this part
      }
    }
    return null;
  }
  return result as Record<string, unknown>;
}

function isBusyReactionBody(statusResult: { result?: unknown }): boolean {
  const body = reactionBody(statusResult.result);
  if (!body) return false;
  if (body.error === 'busy') return true;
  const results = body.results;
  return Array.isArray(results) && results.some((r) => (r as { error?: unknown } | null)?.error === 'busy');
}

function describeReactionResult(result: unknown): string {
  if (result === undefined || result === null) return '(no result payload)';
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  const text = Array.isArray(content)
    ? content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join(' ')
    : (() => {
        try {
          return JSON.stringify(result);
        } catch {
          return String(result);
        }
      })();
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

/**
 * Synchronously converge every mechanical finish leg before reporting success.
 * The operation is retry-safe: terminal state writes, plan status flips, claim
 * release, and checkpoint clear are all idempotent. This is a small finish saga
 * rather than a cross-store SQL transaction (plan docs are filesystem-canonical),
 * but it has atomic CALLER semantics: `complete:false` means do not walk away;
 * re-call the same completion and it resumes/converges the missing legs.
 */
export async function synchronizeFinishWork(
  opts: {
    id: string;
    workItem: Record<string, unknown>;
    completionEvidenceStored: boolean;
    /** Authority on the row before this close/replay; omitted by direct finish callers. */
    completionAuthorityBefore?: CompletionAuthorityFrom;
    /** Authority read from the row after this close/replay; omitted by direct finish callers. */
    completionAuthorityAfter?: CompletionAuthorityFrom;
    ctx: UnifiedToolContext;
  },
  deps: {
    clearCheckpoint?: typeof setWorkItemCheckpoint;
    fire?: typeof fireReactionInProcess;
    readPlanItemStatus?: typeof readCommittedPlanItemStatus;
  } = {},
): Promise<FinishWorkReceipt> {
  const clearCheckpoint = deps.clearCheckpoint ?? setWorkItemCheckpoint;
  const fire = deps.fire ?? fireReactionInProcess;
  const readPlanItemStatus = deps.readPlanItemStatus ?? readCommittedPlanItemStatus;
  const state = String(opts.workItem.state ?? '').toLowerCase();
  const reflected = reflectedTerminalStatus(state);
  const stamp = finishPlanStamp(opts.workItem);
  const errors: string[] = [];
  // A first close stamps authority from the legacy/null baseline and remains an
  // idempotent finish operation. A replay that changes an existing judgement is
  // different: callers must not read `idempotent:true` as proof that the durable
  // completion was unchanged (EI-22421597152864352). Keep retry safety explicit
  // below so the finish legs remain safely repeatable without hiding this change.
  const authorityChanged =
    opts.completionAuthorityBefore !== undefined &&
    opts.completionAuthorityAfter !== undefined &&
    opts.completionAuthorityBefore !== null &&
    opts.completionAuthorityBefore !== opts.completionAuthorityAfter;

  let checkpointCleared = false;
  try {
    // Checkpoint cleanup is an idempotent finish leg, just like the terminal state
    // write above. Retry transient PG lock/statement timeouts here as well: a
    // committed close must not report incomplete convergence merely because the
    // cleanup transaction hit a short contention window (EI-23078501622912469).
    await acquireWithContentionRetry(() =>
      clearCheckpoint(
        {
          harness: (opts.workItem.harness as string | null | undefined) ?? null,
          workItemId: opts.id,
          workspaceId: opts.ctx.workspaceId,
        },
        null,
      ),
    );
    checkpointCleared = true;
  } catch (error) {
    errors.push(`checkpoint cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  let planItem: FinishWorkReceipt['planItem'] = 'not-linked';
  let planItemReflection: string | undefined;
  let claimRelease: FinishWorkReceipt['claimRelease'] = 'not-linked';
  if (stamp && reflected) {
    const fireSetStatus = () => fire({
      fire: 'plans:set-status',
      args: {
        harness: stamp.harness_slug,
        slug: stamp.plan_slug,
        item: stamp.item_id,
        status: reflected,
        note: `← ${opts.id} completed (${state})`,
        // WI-38908 / EI-19972048649686949 — the SAME guard reflect-rules.ts:141 passes.
        // It has to be HERE too, because this is the path that actually runs: the reflect
        // rule stands down whenever this leg succeeded (reflect-rules.ts:162 skips when
        // finishOf(e).planItem is already done/dropped). Guarding only the fallback left
        // the PRIMARY reflection unguarded, and the fallback then deferred to the path
        // carrying the bug — so the guard could essentially never fire on a successful
        // complete().
        //
        // Without it, completing ONE of N work-items stamped with the same plan item marks
        // that item terminal, and plan-item-reconcile then closes the siblings. Live:
        // release-build-vm-dev-parity-audit-2026-08-13#P-004 — WI-39352 (an OFFLINE artifact
        // sub-lane) completed 2026-08-16T02:19:54Z, flipped P-004 `done` 1.5s later, and the
        // reconciler closed WI-38600 — the Windows clean-install + live-drive verdict — at
        // 02:38:05Z with completionAuthority='proposed' and terminalCompletionRef=null, on a
        // guest that had no OS installed yet. A verdict item was marked satisfied by a
        // sub-lane that never claimed to satisfy it, and nothing failed loudly.
        //
        // When the LAST covering sibling goes terminal, coverage is empty and the flip
        // proceeds — 1:1 behaviour is unchanged.
        onlyIfNoOtherOpenCoverage: true,
        // EI-20129670928216719, drop-only: stop a `done` → `dropped` DOWNGRADE of an item
        // whose real completer is already terminal, and so invisible to the coverage scan.
        ...(reflected === 'dropped' ? { onlyIfNotCompleted: true } : {}),
      },
      parentCtx: opts.ctx,
      cause: {
        depth: 1,
        chain: ['work-items:finish'],
        ruleId: 'work-items:finish:plan-status',
        rootRunId: typeof opts.ctx.runId === 'string' ? opts.ctx.runId : null,
      },
    }).catch((error) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }));
    // WI-10003498: `fire` reports DISPATCH success only. plans:set-status answers a
    // contended plan lock with `{ ok:false, error:'busy' }` in its BODY, which used to
    // read as a successful reflection and strand the plan item at its old status.
    // Retry that transient refusal a bounded number of times before giving up.
    let statusResult = await fireSetStatus();
    for (
      let attempt = 1;
      attempt < FINISH_SET_STATUS_BUSY_ATTEMPTS && statusResult.ok && isBusyReactionBody(statusResult);
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, FINISH_SET_STATUS_BUSY_BACKOFF_MS * attempt));
      statusResult = await fireSetStatus();
    }
    if (statusResult.ok) {
      try {
        const committedStatus = await readPlanItemStatus(stamp, opts.ctx);
        if (committedStatus) {
          planItem = committedStatus;
          // A guard skip (`skipped:'coverage_guard'` etc.) is a legitimate no-op and stays
          // non-failing; a body-level refusal (`ok:false`, e.g. busy after every retry) is not.
          const body = reactionBody((statusResult as { result?: unknown }).result);
          // WI-10003498: a non-converged reflection must still say WHY, or a guard skip
          // computed from a stale read is indistinguishable from a lost write.
          if (committedStatus !== reflected) {
            planItemReflection = describeReactionResult((statusResult as { result?: unknown }).result);
          }
          if (committedStatus !== reflected && body && body.ok === false) {
            // `complete:false` tells the caller the saga did not converge (retry-safe).
            planItem = 'failed';
            errors.push(
              `plan-item reflection did not commit: ${stamp.plan_slug}#${stamp.item_id} is ` +
                `'${committedStatus}', not '${reflected}'; plans:set-status returned ` +
                describeReactionResult((statusResult as { result?: unknown }).result),
            );
          }
        } else {
          planItem = 'failed';
          errors.push(
            `plan-item status readback failed: ${stamp.plan_slug}#${stamp.item_id} was not found after reflection`,
          );
        }
      } catch (error) {
        planItem = 'failed';
        errors.push(`plan-item status readback failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      planItem = 'failed';
      errors.push(`plan-item status failed: ${statusResult.error ?? 'unknown error'}`);
    }

    const releaseResult = await fire({
      fire: 'plan_items:release',
      args: { harness: stamp.harness_slug, plan: stamp.plan_slug, item: stamp.item_id },
      parentCtx: opts.ctx,
      cause: {
        depth: 1,
        chain: ['work-items:finish'],
        ruleId: 'work-items:finish:claim-release',
        rootRunId: typeof opts.ctx.runId === 'string' ? opts.ctx.runId : null,
      },
    }).catch((error) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }));
    if (releaseResult.ok) claimRelease = 'released-or-absent';
    else {
      claimRelease = 'failed';
      errors.push(`claim release failed: ${releaseResult.error ?? 'unknown error'}`);
    }
  }

  const complete =
    Boolean(reflected) &&
    opts.completionEvidenceStored &&
    checkpointCleared &&
    planItem !== 'failed' &&
    claimRelease !== 'failed';
  return {
    idempotent: !authorityChanged,
    retrySafe: true,
    authorityChanged,
    complete,
    workItemState: state,
    completionEvidenceStored: opts.completionEvidenceStored,
    checkpointCleared,
    planItem,
    ...(planItemReflection ? { planItemReflection } : {}),
    claimRelease,
    ...(errors.length ? { errors } : {}),
  };
}

/** Complete ONE item — confirm it exists, optionally transition state (a failed
 *  state write NEVER loses the completion, EI-24), fill provenance defaults, and
 *  return the reflect step. Self-describes its id. */
/**
 * Ledger lookback for an arm-B item that was never claimed, so has no `takenAt` window.
 * Bounded deliberately: scanning the item's whole lifetime would let a review performed
 * weeks ago corroborate today's close, which is the corroboration gap the gate exists to
 * catch rather than to launder.
 */
const SELF_REVIEW_UNCLAIMED_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * P-002 / D-017: the closing agent's most recent `testing:run`, or `null` when there is
 * none in the lookback window.
 *
 * This is the ATTRIBUTION half of the ledger binding, and it is the only reason the
 * binding is safe. Neither `test_runs` nor `testing_run_snapshots` records which agent ran
 * a suite, so "the newest row for this file" is somebody else's result on a tree ~100
 * agents test against concurrently. `tool_invocations.coord_owner_id` is the column that
 * does say whose run it was; the partial index `(coord_owner_id, invoked_at DESC)` is what
 * makes asking cheap enough to do on every close.
 *
 * Fails soft to `undefined` ("cannot judge"), never to `null` ("looked, found none") — the
 * two are the same silence downstream, but conflating them here would let a database error
 * masquerade as a positive finding of no runs.
 */
async function latestTestingRunForOwner(
  ownerId: string,
  workspaceId: string | null,
  harnessSlug: string | null,
): Promise<TestingRunInvocation | null | undefined> {
  try {
    if (!ownerId) return null;
    const { sql } = getOrgPg();
    const cutoff = new Date(Date.now() - MAX_TEST_BINDING_LOOKBACK_MS);
    const rows = await sql<Array<{ invoked_at: Date; duration_ms: number | null; files: unknown }>>`
      SELECT invoked_at, duration_ms, args_json->'files' AS files
        FROM harness_shared.tool_invocations
       WHERE coord_owner_id = ${ownerId}
         AND invoked_at >= ${cutoff}
         AND tool_name = 'testing:run'
         AND (${workspaceId}::text IS NULL OR workspace_id = ${workspaceId})
         AND (${harnessSlug}::text IS NULL OR harness_slug = ${harnessSlug})
       ORDER BY invoked_at DESC
       LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    const files = Array.isArray(row.files) ? row.files.filter((f): f is string => typeof f === 'string') : [];
    return { invokedAt: new Date(row.invoked_at), durationMs: row.duration_ms ?? null, files };
  } catch {
    return undefined;
  }
}

/**
 * P-002 / D-017: `test_runs` rows for `paths` finishing inside the invocation window.
 *
 * Deliberately NOT scoped by workspace/harness: those columns are NULL on exactly the
 * high-volume vitest reporter path unless the run was harness-stamped, so predicating on
 * them would return zero rows for most real runs — silence that reads as "no ledger",
 * which is the failure mode that makes a detector quietly inert. The `(file_path,
 * finished_at DESC)` index carries the query, and the caller's single-run-group rule
 * supplies the attribution that scoping would not have added anyway.
 */
async function testRunLedgerRowsInWindow(
  paths: readonly string[],
  from: Date,
  to: Date,
): Promise<readonly TestRunLedgerRow[] | undefined> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<Array<{ file_path: string; status: string; run_group_id: string | null }>>`
      SELECT file_path, status, run_group_id
        FROM harness_shared.test_runs
       WHERE file_path = ANY(${paths as string[]})
         AND finished_at >= ${from}
         AND finished_at <= ${to}
       LIMIT 200
    `;
    return rows.map((r) => ({ filePath: r.file_path, status: r.status, runGroupId: r.run_group_id }));
  } catch {
    return undefined;
  }
}

async function completeOne(
  it: CompleteItem,
  ident: { ownerId: string; ownerLabel?: string; adoptedName?: string | null },
  ctx: UnifiedToolContext,
): Promise<BulkItemResult> {
  // EI-20724228359175431: pull the truncation marker off BEFORE anything downstream
  // sees it (rendering, evidence extraction, the broadcast record). It is purely an
  // internal signal for the caller-facing warning below.
  const shapeCoercedFrom = (it.completion as { __shapeCoercedFrom?: string }).__shapeCoercedFrom;
  // The tail-truncated JSON case has structured fields that survived, so the
  // verification warning below stays silent; the caller still needs to learn their
  // input was cut off because whatever was cut is simply MISSING from the record.
  const shapeCoercedFromTruncatedJson = shapeCoercedFrom === 'truncated-json';
  if (shapeCoercedFrom) delete (it.completion as { __shapeCoercedFrom?: string }).__shapeCoercedFrom;
  // EI-15711: same discipline for the status-default marker — read it, then strip it so
  // it never reaches the stored record, the rendering, or the broadcast.
  const statusWasDefaulted = (it.completion as { __statusDefaulted?: true }).__statusDefaulted === true;
  if ('__statusDefaulted' in (it.completion as object))
    delete (it.completion as { __statusDefaulted?: true }).__statusDefaulted;

  // EI-18764241942332131: Postgres' jsonb text-input parser rejects a literal NUL
  // byte with the opaque "unsupported Unicode escape sequence" — a caller who quotes
  // raw source (e.g. evidence ABOUT a NUL byte, as the reporter did) into testResult/
  // testsRun/summary/etc previously got a completion record that was RECORDED, then a
  // terminal STATE WRITE that silently failed downstream in setWorkItemState's evidence
  // merge, well after this tool had already accepted the call. Sanitize HERE, at the
  // tool boundary, before evidence extraction / coord:emit rendering / anything else
  // touches the record — so the state write and the completion record can never
  // disagree about whether a NUL-bearing close landed (terminalPayloadMergeJson in
  // coord-lifecycle/records.ts also sanitizes defensively, for callers other than this
  // tool). The caller is told via `nulBytesStrippedWarning` below — this silently
  // rewrites their evidence, which is worth surfacing even though it never blocks
  // (EI-24 record-and-warn discipline).
  const { value: sanitizedCompletion, stripped: nulBytesStripped } = stripNulBytesDeep(it.completion);
  if (nulBytesStripped) it.completion = sanitizedCompletion;

  const existing = await getWorkItem(it.id, it.harness);
  if (!existing) return { ok: false, id: it.id, error: `work_item '${it.id}' not found` };
  // EI-19313515375179600 (WI-6822 follow-up): `origin` can flip local→remote well after
  // creation (still-under-investigation federation/replay-provenance defect). Trusting it
  // ALONE strands the true author — check IDENTITY first: createdBy === the caller means
  // they genuinely ARE the authoring peer regardless of what `origin` currently reads. This
  // is only the early-exit guard; the actual base-table origin self-heal (required before the
  // trigger-guarded write below can succeed — see selfHealAuthorOriginIfStranded in
  // work-items.ts) happens inside setWorkItemStateWithAliasInfo → setWorkItemState, which this
  // function calls further down when `it.state` is set.
  const callerIsAuthor = !!existing.createdBy && existing.createdBy === ident.ownerId;
  // EI-22189521072988065: the sibling stranding to the orphaned-author case just below —
  // the caller is not the row's original creator but IS its recorded `terminal_owner`,
  // re-affirming/upgrading completion evidence on a row that was ALREADY terminal before
  // this call. `existing.state` (read above, before this call) is what decides
  // "already settled" — never the requested `it.state` — so this can never widen into a
  // fresh-completion bypass. Uses the SAME policy function the deeper write path's
  // self-heal (selfHealTerminalOwnerOriginIfStranded, work-items.ts) runs, so the two
  // can never disagree about which rows qualify.
  const callerIsTerminalOwnerOfAlreadySettledRow = decideTerminalOwnerOriginHeal({
    origin: existing.origin,
    wasAlreadySettled: TERMINAL_WORK_ITEM_STATES.has((existing.state ?? '').toLowerCase()),
    terminalOwner: existing.terminalOwner,
    callerOwnerId: ident.ownerId,
  }).permit;
  if (
    it.state &&
    existing.family === 'issue' &&
    existing.origin === 'remote' &&
    !callerIsAuthor &&
    !callerIsTerminalOwnerOfAlreadySettledRow
  ) {
    // EI-21919769900781478: this fast-fail must not refuse a row the real write path
    // would legitimately heal. When the recorded authoring peer's session has provably
    // ENDED, the remedy this error names ("its authoring peer must claim/resolve it")
    // points at an authority that no longer exists, and the item is undrainable
    // forever. Defer those to setWorkItemStateWithAliasInfo → setWorkItemState, which
    // owns the origin self-heal + audit stamp and independently re-checks that the
    // transition is TERMINAL — so deferring here cannot widen the bypass beyond a
    // terminal close. Fail-closed: a live author, an unrecorded author, or a lookup
    // outage all return null here and the refusal below stands unchanged.
    const orphanedAuthorEndedAt = await lookupRemoteAuthorEndedAt(existing.createdBy);
    if (!orphanedAuthorEndedAt) {
      return {
        ok: false,
        id: it.id,
        error:
          `work_item '${it.id}' is remote-authored and cannot be completed locally; ` +
          `its authoring peer must claim/resolve it, and this node will receive the terminal state through federation.`,
      };
    }
  }

  // EI-7264: a fast multi-wake self-sustaining loop creates+completes its own tracking
  // task each wake, while PEER fleet members' work-item ids flow through the exact same
  // coord broadcast stream — nothing visually distinguishes "an id I just created" from
  // "an id a peer just mentioned". A near-miss: an agent skipped its own create step and
  // called complete on a peer's actively-held item, briefly flipping its state. Record-only
  // completions still WARN (this tool's record-and-warn contract, EI-24), but a terminal close
  // refuses before any completion/state write when the caller is not the current assignee — a
  // warning alone is too late once it clears the peer's claim.
  // EI-23701433507513915: a short-form holder stored before assignments were canonicalized
  // (`su-851c1a7a`) that resolves UNIQUELY to the caller IS the caller. Exact equality
  // refused the real holder's own close; an ambiguous or unknown prefix still matches no one.
  const callerOwnsAssignee =
    !existing.assignee ||
    existing.assignee === ident.ownerId ||
    existing.assignee === ident.adoptedName ||
    (await holderIsCaller(existing.assignee, ident.ownerId, {
      workspaceId: ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId(),
    }));
  const assigneeMismatchWarning =
    existing.assignee && !callerOwnsAssignee
      ? `completing ${it.id} but it is currently assigned to '${existing.assignee}', not you ('${ident.ownerId}') — ` +
        `if you grabbed this id from a peer's coord broadcast instead of your own claimed/created item, stop and ` +
        `re-check before this lands on someone else's active work.`
      : undefined;

  // EI-19393623437103599: the SIBLING of the assignee warning above, for the case that
  // slips past it. `getWorkItem` does NOT apply `harness` to the issue-family branch, so
  // naming a harness does not scope the lookup — a caller can ask for an item in one pot
  // and be handed a DIFFERENT pot's row of the same id, silently. `WI-<n>` ids make that
  // reachable in practice rather than theoretically: D-008 (migration 142) mints them from
  // a PER-DATABASE sequence starting at 1, so WI-1/WI-2/WI-3 exist in every long-lived
  // store and a fresh or recovered one mints exactly those first.
  //
  // Why the assignee warning above does not already cover it: that one keys on the item
  // being held by SOMEONE ELSE. The row this lands on is typically UNASSIGNED (a stale
  // plan-item task nobody holds), so it fires on neither leg. Observed 2026-08-03: an id
  // reported by `work_items:create` against a recovered store resolved to an unrelated
  // 2026-07-18 plan item here, and a terminal completion with `authority: committed` was
  // recorded onto it — forging evidence in a live two-machine federation experiment. The
  // ONLY thing that surfaced it was the echoed `title` happening to look unfamiliar.
  //
  // WARN rather than refuse, deliberately, on this tool's record-and-warn contract (EI-24,
  // as the assignee warning above): a cross-harness complete is not always wrong, and the
  // failure here was the ABSENCE of any signal, not the absence of a block. Naming both
  // harnesses plus the row's title and age is what makes a wrong-id grab self-evident.
  let harnessMismatch = harnessScopeMismatch(existing, it.harness);
  if (harnessMismatch) {
    // `work_items:create` resolves member harnesses to their Pot home before the
    // row is stored. Use the same resolver here before warning about the raw
    // caller slug, otherwise a caller that passed `oddsmith` to both sibling
    // verbs is falsely told that its own create result belongs to a different
    // harness (`oddsmith-hive`). Fail open: an unavailable registry/PG read must
    // keep the existing safety warning rather than silently suppressing it.
    const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    try {
      const canonicalRequestedHarness = await potHomeSlugForHarness(workspaceId, harnessMismatch.requested.trim());
      if (canonicalRequestedHarness === harnessMismatch.resolved) harnessMismatch = null;
    } catch {
      // Preserve the warning when canonicalization cannot be established.
    }
  }
  const harnessMismatchWarning = harnessMismatch
    ? `completing '${it.id}' under harness '${harnessMismatch.requested}', but the row that ` +
      `resolved belongs to harness '${harnessMismatch.resolved}' — titled "${existing.title}"` +
      (existing.createdAt ? `, created ${new Date(existing.createdAt).toISOString()}` : '') +
      (existing.createdBy ? ` by '${existing.createdBy}'` : '') +
      `. A bare WI-<n> id is NOT globally unique (it comes from a per-database sequence that ` +
      `starts at 1), so an id minted in one store can resolve to a completely different item ` +
      `in another. If that title is not the work you meant to complete, STOP — you are about ` +
      `to record a completion on someone else's item.`
    : undefined;

  // TEST-COMPLETION GATE (enforce-system-on-generic-work-2026-06-29 P-006). A feature
  // work-item being moved to a TERMINAL state must have every plan-derived test-requiring
  // VAL passing. Flag-gated (FLAGS.TEST_COMPLETION_GATE, default OFF → inert) and FAIL-OPEN
  // (itemTestGate returns ok:true on any error, never blocking a completion on a gate bug).
  // On refusal we return the SAME shape as the not-found case (ok:false + error, NO completion
  // record) so the completion emit rule — which keys on result.completion — fires no false
  // completion notification.
  if (it.state && existing.family === 'feature' && existing.harness) {
    const norm = normalizeFeatureStateInput(it.state);
    const isTerminal = norm.ok && FEATURE_TERMINAL_STATES.includes(norm.state);
    if (isTerminal && (await getFlag(FLAGS.TEST_COMPLETION_GATE, activeWorkspaceId()).catch(() => false))) {
      const gate = await itemTestGate(existing.harness, it.id);
      if (!gate.ok) return { ok: false, id: it.id, error: `refusing to complete ${it.id}: ${gate.reason}` };
    }
  }

  // EI-12027: `completion.status` (defaults to 'done') is NOT the same field as the
  // top-level `state` transition — an agent that sets `completion: { status: 'resolved' }`
  // and omits `state` reads, to a human, exactly like "resolve this item", but the row
  // stayed open (record-only by design, D-004) with only a POST-HOC `stateWarning` to
  // catch it. That warning is easy to miss (it isn't `ok:false`), and the reporter had
  // to make a second `work_items:complete`/`set_state` call to actually close.
  //
  // We do NOT blanket-auto-close (that would reopen the exact landmine D-004 avoided:
  // `completion.status` DEFAULTS to 'done', so treating every default as "close it"
  // would auto-close every bare completion ever made). Instead we infer ONLY when the
  // caller's `completion.status` is an EXPLICIT, unambiguous issue-lifecycle word that
  // can never arise from the schema default — the issue family's own native terminal
  // vocabulary, 'resolved' | 'closed' (never 'done', which collides with the default;
  // never feature-only 'passed'/'deprecated', which would risk stepping on the
  // scoper→…→curator pipeline's own status semantics for feature-family items, exactly
  // what D-004 was written to avoid). Scoped to `family === 'issue'` for the same reason.
  const rawCompletionStatus =
    typeof it.completion.status === 'string' ? it.completion.status.trim().toLowerCase() : undefined;
  const inferredCloseState =
    // work-item-status-full-unify: `dropped` (the unified drop-terminal) is equally unambiguous —
    // it can never arise from the schema default — so it also infers a close.
    //
    // EI-15711: `done` now infers TOO, but ONLY when the caller actually wrote it. The
    // reason `done` was excluded was never that it is a weaker close signal — it is the
    // top-level `state` field's own documented terminal alias, and the single most
    // natural word to reach for — but that the preprocess default made an explicit
    // `status:'done'` indistinguishable from an omitted one. That marker now survives
    // (`statusWasDefaulted`), so the two cases are separable and only the DEFAULT is
    // ignored. D-004's landmine is untouched: a bare completion still never auto-closes.
    !it.state &&
    !it.recordOnly &&
    existing.family === 'issue' &&
    // EI-19362441037986499: an ALREADY-TERMINAL item has nothing to close, and a
    // record-only completion against one must ATTACH its evidence rather than write
    // state — a terminal→same-terminal re-assert re-fires `work-item:done:<id>`, whose
    // emit carries no state-changed guard, waking everything parked on the item. This
    // guard is deliberately applied to EVERY inferred word, not just 'done': the hazard
    // is a property of the item's state, not of which verb the caller wrote, so
    // 'resolved'/'closed'/'dropped' carried the same latent bug and simply had no test
    // that aimed one at a settled item.
    !TERMINAL_WORK_ITEM_STATES.has((existing.state ?? '').toLowerCase()) &&
    (rawCompletionStatus === 'resolved' ||
      rawCompletionStatus === 'closed' ||
      rawCompletionStatus === 'dropped' ||
      (rawCompletionStatus === 'done' && !statusWasDefaulted))
      ? rawCompletionStatus
      : undefined;
  const effectiveState = it.state ?? inferredCloseState;

  // D-050 applies to the commitment made by a terminal close, not to D-004's
  // record-only progress note. Keep this check at handler time because the close
  // intent can be inferred from completion.status after the schema has parsed.
  const closeIntentRequested =
    Boolean(effectiveState) && CLOSE_INTENT_STATES.has(String(effectiveState).trim().toLowerCase());
  // EI-23476131268587322: issue coalescing may refresh an open row's title/body
  // and watchdog identity after a worker claimed it. The claim path stamps the
  // subject baseline atomically and refreshes it only when an explicit same-holder
  // re-claim accepts the current subject; compare it before any completion/state
  // write so stale proof cannot close a newly coalesced subject. Rows without the
  // private stamp are legacy claims and remain compatible, while a mismatch is a
  // hard close refusal with no partial completion record.
  const claimSubjectMismatches =
    closeIntentRequested && existing.family === 'issue'
      ? claimSubjectBaselineMismatches(existing)
      : [];
  if (claimSubjectMismatches.length > 0) {
    const changedFields = claimSubjectMismatches.map((mismatch) => mismatch.field).join(', ');
    return {
      ok: false,
      id: it.id,
      error:
        `refusing terminal completion for '${it.id}': claimed subject changed after claim ` +
        `(mismatched ${changedFields}). The current issue no longer matches the private ` +
        `claim-subject baseline, so stale completion evidence cannot be applied. Re-claim ` +
        `the current subject and re-run verification before closing. No completion record ` +
        `or state transition was written.`,
      claimSubjectMismatch: {
        fields: claimSubjectMismatches.map((mismatch) => ({
          field: mismatch.field,
          claimed: mismatch.claimed,
          current: mismatch.current,
        })),
      },
    };
  }
  const successfulClose =
    Boolean(effectiveState) &&
    ROOT_CAUSE_SUCCESSFUL_CLOSE_STATES.some((state) => state === String(effectiveState).trim().toLowerCase());

  // EI-22410970761779199: the behavior-contract resolver correctly classifies a
  // `kind:'change'` item, but a completion close also knows whether this particular
  // disposition actually claims remediation. Discard/duplicate closes and closes with
  // no changed or deleted path are administrative/no-op outcomes, so passing them into
  // the behavior gate creates a false D-012 impact report (and would become a false hard
  // refusal if that report is enforced). Keep the resolver unchanged and gate only the
  // completion boundary; ordinary remediating done/resolved closes still receive the
  // exact gate and report behavior.
  const completionEvidenceForGate = completionEvidenceFromRecord(it.completion);
  const duplicateCloseCoverageException =
    typeof it.completion.duplicateOf === 'string' &&
    it.completion.duplicateOf.trim().length > 0 &&
    it.completion.duplicateOf.trim() !== it.id;
  // Duplicate and discard closes are administrative settlements, not claims that
  // remediation evidence made the item authoritative. They still leave the item
  // settled in the queue, so the caller-facing burn-down result must use the shared
  // abandoned/drop exception even when completion authority remains `proposed`.
  const isAbandonedClose =
    duplicateCloseCoverageException ||
    ['closed', 'deprecated', 'dropped'].includes(String(effectiveState ?? '').trim().toLowerCase());
  const completionHasChangedOrDeletedPaths =
    (completionEvidenceForGate?.filesChanged?.length ?? 0) > 0 ||
    (completionEvidenceForGate?.filesDeleted?.length ?? 0) > 0;
  const completionClaimsRemediation =
    closeIntentRequested &&
    claimsRemediation({
      itemKind: existing.kind,
      status: String(effectiveState ?? ''),
      terminalReason: duplicateCloseCoverageException ? 'duplicate' : String(effectiveState ?? ''),
    });
  // Plan-promoted implementation items are feature-family rows, while the generic
  // remediation classifier deliberately covers only bug/change. The spec-evidence gate
  // is broader than that classifier: a successful feature close that names changed paths
  // must prove its active clauses too, or a pending/legacy grading audit can never reach
  // the reopen dispatcher. Preserve the administrative exemptions for deprecated/dropped
  // and duplicate closes.
  const successfulFeatureClose = existing.family === 'feature' && successfulClose && !duplicateCloseCoverageException;
  // Convert-at-pickup defaults to `task`; that label alone cannot establish that
  // a completion is non-code. Let the existing gate compare the actual claim to
  // the kind, including an explicit attestation with no changed-path declaration.
  // It preserves genuine non-code deliverables and refuses contradictory typing.
  const successfulTaskClose =
    isNonCodeWorkItemKind(existing.kind) && successfulClose && !duplicateCloseCoverageException;
  // An explicit specAdequacy attestation is itself a request to run the gate.
  // Verification-only feature items can legitimately change no files; ignoring
  // their attestation would let a pending grading audit disappear at completion.
  const explicitSpecAdequacyClose = successfulClose && !duplicateCloseCoverageException && Boolean(it.specAdequacy);
  const shouldEvaluateSpecAdequacyAtCompletion =
    closeIntentRequested &&
    (((completionClaimsRemediation || successfulFeatureClose || successfulTaskClose) &&
      completionHasChangedOrDeletedPaths) ||
      explicitSpecAdequacyClose);

  // ---- CONTRACT-GATE ACCUMULATION (EI-20286699547467039) ---------------------------
  // Every gate from here to the self-review gate below answers the SAME question — "is
  // this completion record complete enough to close on?" — and each is computed from
  // `existing` + `it` + `ident` alone, never from an earlier gate having passed. They
  // used to be sequential early-returns, so a caller violating three of them learned
  // about them across THREE round-trips, each costing a full model turn. (Five agents
  // filed that friction on 2026-08-12 alone; the coverage gate's own comment below
  // records the same pattern from the other side.) They now ACCUMULATE: every gate is
  // evaluated, and ONE refusal names all of them.
  //
  // Why this is nearly free — the argument that decides the design: every gate must
  // PASS for the call to succeed, so the SUCCESS path already evaluates all of them.
  // Accumulation therefore costs NOTHING on the happy path; it adds work only on the
  // refusal path, where it trades a few local gate evaluations for N-1 model
  // round-trips. That is why this beats adding a separate read-only preview verb: a
  // preview only helps callers who already know the contract well enough to look for
  // it, while fixing the refusal shape reaches every caller with zero discovery burden.
  //
  // The tiers ABOVE this block deliberately still short-circuit, and must stay that way:
  //   - existence (`!existing`) — nothing below is computable without the row.
  //   - authority (remote-authored, assignee-mismatch close) — when the caller may not
  //     complete this item AT ALL, appending evidence defects is worse than noise: it
  //     coaches them toward landing a close on someone else's work.
  //
  // INVARIANT this block preserves: when exactly ONE gate fails, the returned `error` is
  // BYTE-IDENTICAL to what that gate returned before and its typed side-field is set
  // exactly as before. Only a 2+-gate refusal changes shape, and that message still
  // CONTAINS each gate's verbatim text. That is what keeps the existing
  // complete.*.test.ts assertions — and any agent that learned a message by heart —
  // valid. Keep each gate's message verbatim when editing one.
  const gateRefusals: Array<{ error: string; fields?: Record<string, unknown> }> = [];
  const completionContractRequirements = WORK_ITEMS_COMPLETION_CONTRACT.requirements.map((requirement) => ({
    ...requirement,
    applicable: false,
    satisfied: null as boolean | null,
  }));
  const setContractRequirement = (key: CompletionContractRequirementKey, applicable: boolean, error?: string): void => {
    const requirement = completionContractRequirements.find((candidate) => candidate.key === key);
    if (!requirement) return;
    requirement.applicable = applicable;
    requirement.satisfied = applicable ? !error : null;
  };
  const completionContract = () => ({
    version: WORK_ITEMS_COMPLETION_CONTRACT.version,
    requirements: completionContractRequirements,
  });
  const refuseGate = (error: string, fields?: Record<string, unknown>): void => {
    gateRefusals.push(fields ? { error, fields } : { error });
  };

  const assumptionsContractError =
    closeIntentRequested && it.assumptions === undefined ? ASSUMPTIONS_REQUIRED_MESSAGE : undefined;
  setContractRequirement('assumptions', closeIntentRequested, assumptionsContractError);
  if (assumptionsContractError) refuseGate(assumptionsContractError);

  // EI-18793465701838962: successful defect closes need a falsifiable causal
  // record, not a plausible post-hoc explanation. `capability-gap` is not a
  // built-in work-item kind in the unified vocabulary, so recognize only an
  // explicit structured marker (tag / payload classification), never prose in
  // the title or summary. Discard/wontfix states stay exempt: no fix ships.
  const payloadRecords = (() => {
    if (!existing.payload || typeof existing.payload !== 'object' || Array.isArray(existing.payload)) return [];
    const payload = existing.payload as Record<string, unknown>;
    return [payload, payload.metaPattern, payload.improvement, payload.source].filter(
      (value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value),
    );
  })();
  const capabilityGapMarker = (value: unknown): boolean =>
    typeof value === 'string' && value.trim().toLowerCase().replaceAll('_', '-') === 'capability-gap';
  const capabilityGapItem =
    existing.tags?.some(capabilityGapMarker) === true ||
    payloadRecords.some((record) =>
      ['kind', 'type', 'category', 'workItemType', 'itemType', 'sourceCategory'].some((key) =>
        capabilityGapMarker(record[key]),
      ),
    );
  const rootCauseVerificationRequired =
    closeIntentRequested && successfulClose && (existing.kind === 'bug' || capabilityGapItem);
  const missingRootCauseFields = rootCauseVerificationRequired
    ? missingRootCauseVerificationV2Fields(it.completion.rootCauseVerification)
    : [];
  let rootCauseVerificationError: string | undefined;
  if (rootCauseVerificationRequired && !it.completion.rootCauseVerification) {
    rootCauseVerificationError =
      `REJECTED — ${it.id} is a successful ${existing.kind === 'bug' ? 'bug' : 'capability-gap'} close, but ` +
      'completion.rootCauseVerification is missing. Add { hypothesis, alternativeHypothesis, ' +
      'distinguishingTest: "the procedure used to distinguish them", testResult, testProcedure, ' +
      'predictedObservations:{hypothesis,alternativeHypothesis}, actualObservation, evidenceRefs } so the ' +
      'record preserves what would have looked different if the claimed cause were wrong. No completion ' +
      'record or state transition was written.';
  } else if (rootCauseVerificationRequired && missingRootCauseFields.length > 0) {
    rootCauseVerificationError =
      `REJECTED — ${it.id} completion.rootCauseVerification is incomplete for causal-evidence contract ` +
      `v${ROOT_CAUSE_VERIFICATION_CONTRACT_VERSION}. Missing: ${missingRootCauseFields.join(', ')}. ` +
      'Supply the exact test procedure, the predicted observation under each hypothesis, the actual observation, ' +
      'and durable evidenceRefs. No completion record or state transition was written.';
  }
  setContractRequirement('root-cause-verification', rootCauseVerificationRequired, rootCauseVerificationError);
  if (rootCauseVerificationError)
    refuseGate(rootCauseVerificationError, {
      rootCauseVerificationError,
      missingRootCauseVerificationFields: missingRootCauseFields,
    });

  // EI-20245220770262027: assigneeMismatchWarning used to be advisory even when this call
  // requested a terminal transition. That let a wrong-id completion apply the state and clear
  // the live assignee's claim. Refuse the close before the completion record is persisted; the
  // current assignee can close it, or the caller can re-claim/reassign it through the normal
  // handoff path first. Record-only completions remain available for observations.
  const assigneeMismatchCloseRefusal =
    Boolean(existing.assignee) &&
    !callerOwnsAssignee &&
    Boolean(effectiveState) &&
    CLOSE_INTENT_STATES.has(String(effectiveState).trim().toLowerCase());
  if (assigneeMismatchCloseRefusal) {
    return {
      ok: false,
      id: it.id,
      error:
        `refusing terminal completion for '${it.id}': it is currently assigned to '${existing.assignee}', not you ('${ident.ownerId}'). ` +
        'No completion record or state transition was written; have the current assignee complete it or re-claim/reassign it before closing.',
    };
  }

  // first-class-spec-clauses-and-prior-attempt-briefs-2026-08-20 P-007 /
  // D-003..D-006: terminal completion is the hard per-clause adequacy gate. Recompute
  // against the exact CURRENT clause/evidence revisions and require the corresponding
  // terminal, audited scorecard before any completion/state write. A missing plan stamp
  // or a plan item with no test-requiring clauses is explicitly non-applicable, keeping
  // legacy and non-behavioral work items compatible. Infrastructure/read failures fail
  // CLOSED and are retryable: an unavailable gate must never silently become a pass.
  let specAdequacyChecked: string[] | undefined;
  // P-016 / D-013: the gate's ADVISORY impact report. Surfaced on both the refusal and
  // the success path because it is not a verdict — it names behavior obligations the
  // universal resolver made visible (standalone work with no resolved clause, clauses
  // reached only through a cross-namespace edge, edges pinned to superseded revisions)
  // that P-013, not P-016, will turn into a refusal. Reporting it here is what makes it
  // a report at all: a report no caller receives is indistinguishable from none.
  let specAdequacyImpactReport: string | undefined;
  if (shouldEvaluateSpecAdequacyAtCompletion) {
    try {
      const gate = await specTestAdequacyCompletionGate({
        workItem: existing,
        attestation: it.specAdequacy,
        ...(successfulTaskClose
          ? {
              changedPaths: [
                ...(completionEvidenceForGate?.filesChanged ?? []),
                ...(completionEvidenceForGate?.filesDeleted ?? []),
              ],
            }
          : {}),
      });
      if (!gate.ok) {
        const pendingGradingAuditTargetIds = gate.pendingGradingAuditTargetIds;
        const failedGradingAuditTargetIds = gate.failedGradingAuditTargetIds;
        // WI-10002063: the graded-card ids above do not resolve to WHY an audit failed;
        // only the audit card (auditIssueId) does. Thread the resolvable handles through
        // to the caller, or the refusal stays a closed loop.
        const failedGradingAudits = gate.failedGradingAudits;
        const failedAuditReadRefs = (failedGradingAudits ?? [])
          .map((entry) => entry.auditIssueId)
          .filter((id): id is string => Boolean(id));
        const gradingAuditDispatch =
          pendingGradingAuditTargetIds?.length && !it.validateOnly
            ? await dispatchPendingGradingAudits({
                targetIds: pendingGradingAuditTargetIds,
                ctx,
                harness: existing.harness,
              }).catch((error) => ({
                requestedTargetIds: [...pendingGradingAuditTargetIds],
                receipts: pendingGradingAuditTargetIds.map((issueId) => ({
                  issueId,
                  state: 'failed' as const,
                  reason: error instanceof Error ? error.message : String(error),
                })),
              }))
            : undefined;
        const gradingAuditRetryGuidance =
          pendingGradingAuditTargetIds?.length && failedGradingAuditTargetIds?.length
            ? 'Retry after binding current proof, emitting terminal scorecards, settling any pending grading audits, and repairing the failed grading-integrity findings before emitting fresh terminal scorecards.'
            : pendingGradingAuditTargetIds?.length
              ? // WI-10002404: same closed-loop defect as WI-10002063 one branch down. This
                // branch told the caller to "settle" the audit without naming ANY lever to
                // settle it with, so the only recovery an agent could infer was re-emitting —
                // which files a DUPLICATE card that takes its own reservation. scorecards:repair
                // is the callable path behind this very dispatcher and was named nowhere a
                // caller could see it (only an internal comment in agent-tools/index.ts).
                'Retry after binding current proof, emitting terminal scorecards, and settling any pending grading audits. The existing router selects independent auditors automatically; the returned gradingAuditDispatch receipts identify routed conversations or bounded launch fallback. A decline or expiry only advances the cascade while a dispatcher actually RUNS: dispatch from scorecards:emit and from this completion path is ONE-SHOT, and the sole periodic re-dispatcher (the acceptance-grading-sweep routine) may be paused, in which case nothing re-dispatches on its own. A receipt of state:"skipped" reading "another dispatcher already reserved this scorecard" means a live dispatch already owns this card: WAIT for it (audits that settle take ~450s at p50) and do NOT re-emit — re-emitting files a DUPLICATE card that takes its own reservation and is never the retry path. If the audit is STILL pending once its 15-minute reservation lease has expired, re-dispatch it yourself with scorecards:repair { targetIds: [<the pendingGradingAuditTargetIds above>] }, the callable path behind this same dispatcher.'
              : failedGradingAuditTargetIds?.length
                ? `Retry after repairing the failed grading-integrity findings for scorecard(s) ${failedGradingAuditTargetIds.join(', ')}, then emit fresh terminal scorecards through scorecards:emit.${
                    failedAuditReadRefs.length
                      ? ` The findings are NOT on the graded card — read the audit scorecard(s) ${failedAuditReadRefs.join(', ')} for them.`
                      : ' No audit scorecard id was recorded for those cards, so the findings are not addressable from this refusal; inspect the graded card(s) gradingAudit subtree directly.'
                  }`
                : 'Retry after binding current proof and emitting terminal scorecards when required.';
        refuseGate(
          `refusing terminal completion for '${it.id}': spec-test-adequacy gate is not current: ${gate.reason}. ` +
            `${gradingAuditRetryGuidance} ${SPEC_ADEQUACY_CURRENTNESS_GUIDANCE} No completion record or state transition was written.`,
          {
            specAdequacy: {
              applicable: true,
              retryable: true,
              checked: gate.checked,
              ...(gate.impactReport ? { impactReport: gate.impactReport } : {}),
              ...(pendingGradingAuditTargetIds?.length
                ? { pendingGradingAuditTargetIds: [...pendingGradingAuditTargetIds] }
                : {}),
              ...(failedGradingAuditTargetIds?.length
                ? { failedGradingAuditTargetIds: [...failedGradingAuditTargetIds] }
                : {}),
              ...(failedGradingAudits?.length ? { failedGradingAudits: [...failedGradingAudits] } : {}),
              ...(gradingAuditDispatch ? { gradingAuditDispatch } : {}),
            },
          },
        );
        setContractRequirement('spec-test-adequacy', true, gate.reason);
      } else {
        // Only reachable when the gate PASSED, so these success-path values can never be
        // populated from a failed verdict now that the refusal above no longer returns.
        specAdequacyImpactReport = gate.impactReport;
        if (gate.applicable) specAdequacyChecked = gate.checked;
        setContractRequirement('spec-test-adequacy', true);
      }
    } catch (error) {
      const specAdequacyError =
        `refusing terminal completion for '${it.id}': spec-test-adequacy gate could not establish a current verdict (${error instanceof Error ? error.message : String(error)}). ` +
        'This is retryable; no completion record or state transition was written.';
      refuseGate(specAdequacyError, { specAdequacy: { applicable: true, retryable: true, checked: [] } });
      setContractRequirement('spec-test-adequacy', true, specAdequacyError);
    }
  }

  // DESIGN-EVIDENCE GATE (ratified-mockup-implementation-validation-2026-08-24 P-007).
  // When this work-item's feature has a ratified design reference, every required case
  // must have CURRENT PASSING deterministic evidence (D-004 — advisory prose is never
  // consulted). Unratified surfaces impose nothing, so exploration stays unrestricted.
  //
  // D-006 makes this REPORT-ONLY by default: the obligation is measured and surfaced on
  // the completion, and only refuses once DESIGN_EVIDENCE_GATE_ENFORCING is flipped by
  // P-011 after calibration (P-008) and independent verification (P-009). While
  // report-only, ANY failure of the gate itself is swallowed into the report — a
  // completion must not be lost to a gate that is not yet entitled to block.
  let designEvidenceReport: string | undefined;
  if (closeIntentRequested && existing.harness) {
    const harnessSlug = existing.harness;
    // The adapter owns fault classification because it has already read the
    // enforcement flag. In particular, callers must not replace an unexpected
    // fault with a hardcoded `enforced` value: that would make the rollout flag
    // incapable of turning the same unavailable outcome into a refusal.
    const outcome = await designEvidenceCompletionGate(
      designFeatureCandidates({ id: it.id, sourcePlanSlug: existing.sourcePlanSlug }),
      {
        requiredReferences:
          existing.payload && typeof existing.payload === 'object'
            ? (existing.payload as Record<string, unknown>).designReferences
            : undefined,
        workScope: { planSlug: existing.sourcePlanSlug, planItemIds: existing.sourcePlanItemIds },
        evaluate: async (featureId) => {
          const verbDeps = await designCompareDepsFor(harnessSlug);
          return evaluateFeatureDesignGate(
            { harnessSlug, featureId },
            {
              store: verbDeps.store,
              verbDeps,
              // The gate READS evidence; it never ratifies or records. The role
              // is carried for provenance only, so it names what this caller
              // actually is rather than borrowing an authoring role.
              caller: { actorId: ident.ownerId, role: 'completion-gate' },
            },
          );
        },
      },
    );

    const designEvidenceEnforced = 'enforced' in outcome && outcome.enforced;
    const designEvidenceError =
      outcome.status === 'unsatisfied' && designEvidenceEnforced
        ? renderDesignEvidenceRefusal(it.id, outcome)
        : outcome.status === 'unavailable' && designEvidenceEnforced
          ? `refusing terminal completion for '${it.id}': ${outcome.report}. This is retryable; no completion record or state transition was written.`
          : undefined;
    const designEvidenceApplicable = designEvidenceEnforced;
    setContractRequirement('design-evidence', designEvidenceApplicable, designEvidenceError);
    if (designEvidenceError) refuseGate(designEvidenceError);
    if (outcome.status !== 'not-applicable') designEvidenceReport = outcome.report;
  }

  // Optional explicit terminal transition. A failed state write must NEVER lose the
  // completion record (EI-24): catch, report it as `stateError`, still record + emit.
  //
  // agent-protocol-authority-semantics-2026-07-26 P-004 REPLACED what satisfies the
  // completion-integrity gate here. It used to pass `completionRef: it.completion.summary`
  // — and because `completion.summary` is a required non-empty field, that made the gate's
  // "a terminal transition requires a completionRef" check unfailable BY CONSTRUCTION for
  // every caller of this tool. A gate that cannot reject is not a gate; it is ceremony that
  // reads like one, which is worse, because it made 65.6% of terminal rows (P-002, of
  // 14,663) look gate-approved while carrying no verification evidence at all.
  //
  // What it passes instead is a JUDGEMENT about the evidence: `authorityForCompletion`
  // returns `committed` only for verifiedHow PLUS one of testsRun/testResult, and
  // `proposed` otherwise. Both are accepted by the gate — the close is always RECORDED —
  // but only `committed` counts toward burn-down. That is D-003's restructure: an
  // unverified assertion no longer reaches the authoritative state and gets corrected by a
  // later audit; it never reaches it at all.
  let workItem = existing;
  let stateError: string | undefined;
  let planGateParked = false;
  let planGateParkWarning: string | undefined;
  let aliasNote: string | undefined;
  // EI-18736669939338784: set when this close met an item ALREADY completed by someone
  // else, so the write was reshaped to preserve the stronger record. Surfaced as a loud
  // warning below — the caller being told `ok:true` while their evidence was destroyed IS
  // the bug this closes.
  let terminalConflict: TerminalCompletionConflict | undefined;
  // EI-19362441037986499: set when this completion arrived for a row that was ALREADY
  // terminal and therefore took the evidence-attach path instead of a state write. The
  // `stateWarning` below is suppressed for any terminal final state — which is exactly why
  // that discard was silent — so this carries the outcome into it.
  let evidenceAttachWarning: string | undefined;
  // EI-7712: same shared discriminator as work_items:set_state — compares the
  // ACTUALLY-persisted state against what the caller asked for, not just whether the
  // normalize-layer onAlias fired. Only meaningful when a terminal `state` was passed;
  // a bare completion (no state transition) has nothing to compare, so both stay unset.
  let aliased: boolean | undefined;
  let requestedState: string | undefined;
  let appliedState: string | null | undefined;

  // WI-5891 (leader audit follow-up to WI-5874/P-001): a completion that intends to
  // CLOSE the item while claiming `verifiedHow: 'live-drove-ui'` must cite a real
  // artifact (a screenshot/capture path, or a recorded tauri-agent-tools capture/
  // screenshot/check invocation) — the exact gap that let P-001 close on this label
  // citing only two vitest runs, with no screenshot anywhere on the host. Checked
  // BEFORE the state write is attempted, so an unbacked claim never partially
  // transitions the item (nothing to roll back) — the completion record itself is
  // still built + returned below (EI-24: the narrative is never lost), it just
  // cannot land the CLOSE. This is a deliberate, narrow exception to this file's
  // usual record-and-warn discipline — see isBackedLiveDroveUiClaim's doc comment.
  // A structured duplicate close is an administrative disposition: its claim is that
  // this item is superseded by the named survivor, not that the verifier covered every
  // member of a population. Keep the universal-verification gate for ordinary closes,
  // and for malformed self-duplicate claims, but do not make a valid non-self
  // `completion.duplicateOf` carry an unrelated population partition.
  const verificationCoverageApplicable =
    closeIntentRequested &&
    !duplicateCloseCoverageException &&
    isVerificationWorkItem(existing) &&
    claimsUniversalVerification(it.completion);
  const verificationCoverageGap =
    verificationCoverageApplicable && !hasEnumeratedVerificationCoverage(completionEvidenceForGate?.coverage);
  const misplacedResidueEntries = misplacedResiduePopulationEntries(completionEvidenceForGate?.coverage);
  const verificationCoverageError = verificationCoverageGap
    ? // EI-20223460482316333 / EI-20224260070669261 / EI-20225113964896785 /
      // EI-20225202699515538 / EI-20222447336206097 — five agents filed the SAME
      // friction on 2026-08-12 alone: the refusal named the *concept* ("enumerated
      // coverage") but never the FIELD PATH or the shape, so a caller who agreed with
      // it still could not comply without reading this file. A refusal that cannot be
      // acted on is a wall, not a gate. The exact path + the two rules that actually
      // fail (total partition, explicit residue field) are now in the message itself.
      misplacedResidueEntries.length > 0
      ? `REJECTED — ${it.id} is a verification-shaped item making a universal coverage claim, but population entries ${misplacedResidueEntries.map((entry) => JSON.stringify(entry)).join(', ')} are in residue at completion.verification.coverage (or the equivalent top-level completion.coverage alias). Residue is not a partition bucket; move those entries to checked, notChecked, or notApplicable. ${COMPLETION_COVERAGE_CONTRACT}`
      : `REJECTED — ${it.id} is a verification-shaped item making a universal coverage claim, but its completion has no valid enumerated coverage. Add it at completion.verification.coverage (or the equivalent top-level completion.coverage alias). ${COMPLETION_COVERAGE_CONTRACT} Re-open/keep the item open and re-send the completion with that coverage record; do not claim "every/all/nothing" from a partial pass.`
    : undefined;
  // EI-20962416980274656: this gate is deterministic from the submitted record,
  // so reject at the completion boundary BEFORE constructing/persisting/emitting a
  // completion. The former path converted it into `stateError` later, after enough
  // of the completion pipeline had run for the caller to observe a recorded
  // completion plus an open item — a non-atomic half-write requiring a second call.
  // Match every other preflight refusal above: no `completion`/`workItem` fields means
  // the intrinsic completion emit predicate also remains false.
  if (verificationCoverageError) {
    refuseGate(verificationCoverageError, { verificationCoverageError });
  }
  setContractRequirement('verification-coverage', verificationCoverageApplicable, verificationCoverageError);

  // ---- Arm-B pilot self-review gate (D-020 / D-021) --------------------------------
  // INERT unless this specific item is assigned to pilot arm B. The default-false in
  // `itemIsArmB` is load-bearing twice over: a gate that fired by default would make arms
  // A and B identical, so the pilot could no longer say what the gate is worth (D-020);
  // and it would turn every in-flight close in the fleet into a refusal, on the one verb
  // no agent can route around.
  //
  // Placed here, beside the coverage gate and BEFORE any state write, for the reason
  // EI-20962416980274656 records: a late rejection produced a recorded completion plus a
  // still-open item — a non-atomic half-write needing a second call to repair.
  let selfReviewError: string | undefined;
  // WI-41769: BOUND, not passed inline. The judgement carries the arm-B pilot's only
  // measurements (rubberStampRisk / yieldedChange / ledgerVisible); discarding it here left
  // D-022's per-arm comparison with nothing to read, and the gap was invisible because the
  // REFUSAL path is observable while the PASSING path — which generates the data — was not.
  let selfReviewJudgement: SelfReviewJudgement | undefined;
  if (closeIntentRequested && itemIsArmB(existing)) {
    // Scope the ledger to this item's work window. `takenAt` is null only when the item
    // was never claimed, in which case there is no window to read; fall back to a bounded
    // lookback rather than scanning the item's whole lifetime, which would let a review
    // performed weeks ago corroborate today's close.
    const takenAtMs = existing?.takenAt ? Date.parse(existing.takenAt) : NaN;
    const sinceMs = Number.isFinite(takenAtMs) ? takenAtMs : Date.now() - SELF_REVIEW_UNCLAIMED_LOOKBACK_MS;

    const { sql } = getOrgPg();
    const query = selfReviewLedgerQuery({
      workspaceId: ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId(),
      coordOwnerId: ident.ownerId,
      sinceMs,
    });
    const rawRows = await sql.unsafe(query.text, query.values as never[]);
    const ledger = (rawRows as Array<Record<string, unknown>>)
      .map((r) => toSelfReviewLedgerRow(r))
      .filter((r): r is SelfReviewLedgerRow => r !== undefined);

    // WI-134439: an EMPTY `ledger` is ambiguous, and its two causes need opposite answers.
    // Ask the one question that separates them — can the instrument see this agent AT ALL?
    // ⚠ This probe was built when the ledger query was goal-scoped, so the two differed by
    // that predicate AND by `tool_name IS NOT NULL`. The goal scoping is now gone (it bought
    // latency, not attribution — see `selfReviewLedgerQuery`), leaving only the `tool_name`
    // predicate between them, which selects nothing today (0 of 1,054,876 rows). So the probe
    // now almost always agrees with `ledgerVisible`, and `ledger-behind` is correspondingly
    // rare on THIS branch. It is kept rather than deleted because it is the only thing
    // standing between a future null-`tool_name` population and a silent fail-open, and it
    // costs one indexed query on an already-empty ledger. Only worth a query when empty;
    // when it has rows, the instrument is self-evidently not blind. A probe failure leaves
    // this `undefined`, which preserves the historical non-refusing behaviour: this guard
    // must never convert an infrastructure fault into a wall on the fleet's one unroutable
    // verb, which is the very failure `unobservable` exists to prevent.
    let agentVisibleInWindow: boolean | undefined;
    if (ledger.length === 0) {
      try {
        const visibility = selfReviewAgentVisibilityQuery({
          workspaceId: ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId(),
          coordOwnerId: ident.ownerId,
          sinceMs,
        });
        const seen = await sql.unsafe(visibility.text, visibility.values as never[]);
        agentVisibleInWindow = (seen as unknown[]).length > 0;
      } catch {
        agentVisibleInWindow = undefined;
      }
    }

    // Refuses ONLY on the verdicts meaning the review did not happen against the state
    // being closed. `rubberStampRisk` and `yieldedChange` are pilot MEASUREMENTS and never
    // block (D-020) — that rule lives in `selfReviewRefusal` so it is unit-testable rather
    // than reachable only through a live ledger query.
    selfReviewJudgement = judgeSelfReview({
      evidence: it.completion.selfReview,
      ledger,
      agentVisibleInWindow,
      // WI-134439 defect 1: lets the judge tell a stale NATIVE-tool leg from a genuine
      // absence of review. The two ledgers record disjoint tool families and ingest ~2min
      // apart, so without the window and a clock the judge would keep convicting agents
      // whose review simply has not been ingested yet.
      sinceMs,
      nowMs: Date.now(),
    });
    selfReviewError = selfReviewRefusal(selfReviewJudgement, it.id);
  }
  if (selfReviewError) {
    refuseGate(selfReviewError, { selfReviewError });
  }
  setContractRequirement('self-review', closeIntentRequested && itemIsArmB(existing), selfReviewError);

  // ---- P-022 (frozen-candidate-stays-frozen-through-all-fixes-2026-09-03, D-007 #3) ----
  // A completion that claims a gate red fixed — by its prose, or because the item IS the
  // gate-red condition singleton — is refused unless the admission ledger holds the claimed
  // paths on the judged lineage and the leg reads admitted or green. The Aug-30 P-006 check
  // below the write stays as the WARNING for the containment nuance; this is the gate that
  // keeps the false claim out of the record in the first place. The identity read is
  // best-effort: when it cannot be answered the prose matcher still applies.
  {
    let gateRedConditionItem = false;
    try {
      const rows = (await getOrgPg().sql.unsafe(
        `SELECT condition_key
           FROM harness_shared.work_items
          WHERE feature_id = $1 AND harness_slug = $2 AND workspace_id = $3
          LIMIT 1`,
        [it.id, existing.harness ?? '', activeWorkspaceId()],
      )) as unknown;
      const key = Array.isArray(rows) ? (rows[0] as { condition_key?: unknown } | undefined)?.condition_key : null;
      gateRedConditionItem =
        typeof key === 'string' &&
        (key.startsWith(GATE_RED_STREAK_CONDITION_PREFIX) ||
          key.startsWith(FROZEN_REPAIR_CONVERGENCE_CONDITION_PREFIX));
    } catch {
      /* identity read is advisory — the prose matcher below still decides */
    }
    const gateRedVerdict = gateRedCompletionClaimVerdict(completionEvidenceForGate, {
      gateRedConditionItem,
      // A duplicate or explicit drop/discard settles an administrative condition item; it
      // does not assert that the frozen gate is green. The helper still checks any explicit
      // gate-progress prose claim carried by the same completion.
      administrativeSettlement: isAbandonedClose,
    });
    if (gateRedVerdict.refuse) {
      refuseGate(`refusing to complete ${it.id}: ${gateRedVerdict.detail}`, {
        gateRedClaimRefusal: {
          reason: gateRedVerdict.reason,
          candidate: gateRedVerdict.candidate,
          judgedSha: gateRedVerdict.judgedSha,
          unadmittedPaths: gateRedVerdict.unadmittedPaths,
          redLegs: gateRedVerdict.redLegs.map((l) => l.legId),
          admitCommand: gateRedVerdict.admitCommand,
        },
      });
    }
    setContractRequirement(
      'gate-red-lineage',
      gateRedConditionItem || gateRedVerdict.refuse,
      gateRedVerdict.refuse ? gateRedVerdict.detail : undefined,
    );
  }

  // ---- ONE refusal naming every unmet gate (EI-20286699547467039) -------------------
  // The last contract gate is above; emit the accumulated verdict here, still BEFORE any
  // completion record or state write. That preserves the atomicity each individual gate
  // guaranteed on its own (EI-20962416980274656: a late rejection produced a recorded
  // completion plus a still-open item — a non-atomic half-write needing a second call),
  // and it keeps the completion-emit predicate false, since no `completion`/`workItem`
  // field is set on this result.
  if (gateRefusals.length > 0) {
    const mergedFields: Record<string, unknown> = Object.assign({}, ...gateRefusals.map((r) => r.fields ?? {}));
    // A SINGLE unmet gate returns exactly what it returned before accumulation — same
    // `error` bytes, same typed side-field, same absent extras — so every existing
    // caller, test, and memorised message is untouched. Only a 2+-gate refusal takes the
    // combined shape, and it still carries each gate's verbatim text (numbered, so the
    // caller can see the set is complete rather than guessing whether an N+1 is waiting).
    if (gateRefusals.length === 1) {
      return {
        ok: false,
        id: it.id,
        error: gateRefusals[0]!.error,
        ...mergedFields,
        completionContract: completionContract(),
      };
    }
    const error =
      `REJECTED — ${gateRefusals.length} completion requirements for ${it.id} are unmet. This is the ` +
      'COMPLETE set as evaluated on this call, not just the first failure: fix all of them and re-send ' +
      'once. No completion record or state transition was written.\n\n' +
      gateRefusals.map((r, i) => `(${i + 1}/${gateRefusals.length}) ${r.error}`).join('\n\n');
    return {
      ok: false,
      id: it.id,
      error,
      ...mergedFields,
      unmetGateCount: gateRefusals.length,
      completionContract: completionContract(),
    };
  }

  if (rootCauseVerificationRequired && it.completion.rootCauseVerification) {
    it.completion.rootCauseVerification = {
      ...it.completion.rootCauseVerification,
      contractVersion: ROOT_CAUSE_VERIFICATION_CONTRACT_VERSION,
    };
  }
  // P-004: the whole decision, in one call. `completionEvidenceFromRecord` returning
  // `undefined` (no evidence fields supplied at all) and returning a PARTIAL object
  // (P-002 measured 4.2% of evidence-bearing rows carry no `verifiedHow`) both land
  // `proposed` — the partial case is rejected explicitly rather than assumed away,
  // because an "is the object present?" test passes every one of them.
  const authorityByEvidence = authorityForCompletion(completionEvidenceForGate);

  // EI-19319623239777505: the object actually PERSISTED to the row additionally carries
  // the caller's free-text `completion.summary`. This is deliberately a SEPARATE object
  // from `completionEvidenceForGate` above — that one stays exactly as before (scoped to
  // the load-bearing structured fields) because `hasTests` below, `authorityForCompletion`,
  // and `isBackedLiveDroveUiClaim` all key off whether STRUCTURED evidence was supplied;
  // folding `summary` into `completionEvidenceForGate` itself would make a bare-summary,
  // no-verification completion silently read as "evidence supplied" to every one of those
  // checks. Before this, `summary` was written nowhere durable: work_items:complete never
  // passes a `completionRef` (see the P-004 comment above), and the second-terminal-close
  // attestation path in work-items.ts falls back to that same absent `opts.completionRef`
  // — so a caller's whole narrative lived only in this call's RETURN value, gone the
  // moment the response was read. Persisting it under `evidence.summary` (both on a normal
  // close AND inside a second-close attestation, since that path reads `opts.completionEvidence`)
  // fixes both cases from one write, without touching the authority/warning semantics above.
  // EI-21462047954123123: the finish saga below CLEARS this item's checkpoint, while
  // completion evidence routinely cites it. Read the live note NOW — before that
  // clear — and carry any checks rows into the persisted narrative so the citation
  // lands on `_completionEvidence` instead of a location guaranteed empty. Best-
  // effort: a read failure must never cost the completion. The prose body is carried
  // alongside the structured rows because arbitrary named sections are not parseable
  // as checks and would otherwise disappear with the cleared note.
  let checkpointChecksCarried: PersistedCompletionEvidence['checkpointChecksCarried'];
  let checkpointProseSnapshot: PersistedCompletionEvidence['checkpointProseSnapshot'];
  try {
    const priorCheckpoint = await getWorkItemCheckpoint({
      harness: (it.harness as string | null | undefined) ?? null,
      workItemId: it.id,
      workspaceId: ctx.workspaceId,
    });
    if (priorCheckpoint) {
      const { checks } = splitCarryNoteChecks(priorCheckpoint);
      checkpointProseSnapshot = boundedCheckpointProseSnapshot(priorCheckpoint);
      if (checks.length > 0) {
        checkpointChecksCarried = checks.map((c) => ({
          claim: c.claim,
          ...(c.recheck ? { recheck: c.recheck } : {}),
          ...(c.verified ? { verified: c.verified } : {}),
          ...(c.observed ? { observed: c.observed } : {}),
          ...(c.contested ? { contested: c.contested } : {}),
        }));
      }
    }
  } catch {
    /* fail-open: the clear below proceeds regardless */
  }

  const summaryText = it.completion.summary?.trim();
  // EI-21478999218933285: `deferred`, `whatLanded`, and `coordNotes` used to survive
  // only in the transient completion event. A later work_items:get therefore gave a
  // confident but false "none recorded" answer even for a known-positive close.
  // Persist them beside `summary` on the EXISTING `_completionEvidence` surface.
  // Keep this object separate from `completionEvidenceForGate`: narrative fields
  // describe the close, but must never promote an evidence-free close to `committed`.
  const completionNarrative: PersistedCompletionEvidence = {};
  if (it.completion.rootCauseVerification) {
    completionNarrative.rootCauseVerification = it.completion.rootCauseVerification;
  }
  if (it.completion.whatLanded?.length) completionNarrative.whatLanded = it.completion.whatLanded;
  if (it.completion.deferred?.length) completionNarrative.deferred = it.completion.deferred;
  if (it.completion.coordNotes) completionNarrative.coordNotes = it.completion.coordNotes;
  if (checkpointChecksCarried?.length) {
    completionNarrative.checkpointChecksCarried = checkpointChecksCarried;
  }
  if (checkpointProseSnapshot) {
    completionNarrative.checkpointProseSnapshot = checkpointProseSnapshot;
  }
  // WI-41769. Only reachable on the PASSING path: a refusing verdict returned above, before
  // any persistence — which is correct, since a refused close records no completion at all.
  // So what lands here is exactly the population D-022 needs: the arm-B closes that passed.
  if (selfReviewJudgement) {
    completionNarrative.selfReviewJudgement = toPersistedSelfReviewJudgement(selfReviewJudgement);
  }
  const hasCompletionNarrative = Object.keys(completionNarrative).length > 0;
  const completionEvidenceBeforeStamp: PersistedCompletionEvidence | undefined =
    summaryText || hasCompletionNarrative
      ? {
          ...(completionEvidenceForGate ?? {}),
          ...(summaryText ? { summary: summaryText } : {}),
          ...completionNarrative,
        }
      : completionEvidenceForGate;

  // Cross-repository completions are common: an su can coordinate through Papercusp while
  // verifying SideStage. Reuse the same registered-root fallback as the filesChanged audit,
  // and pay for the registry lookup when the primary checkout cannot resolve the paths OR a
  // declared absolute path identifies another supported checkout. The latter is important:
  // unresolvedPathsInCompletion intentionally stays silent for paths outside its candidate
  // root, so an absolute Hive path would otherwise skip this lookup and get Papercusp-stamped.
  const initialUnresolvedPaths = unresolvedPathsInCompletion(completionEvidenceForGate);
  const declaredCompletionPaths = [
    ...(completionEvidenceForGate?.filesChanged ?? []),
    ...(completionEvidenceForGate?.filesDeleted ?? []),
  ];
  const hasAbsoluteCheckoutPath = declaredCompletionPaths.some((path) =>
    Boolean(completionCheckoutRootForPath(path) ?? checkoutRootForPath(path)),
  );
  const registeredRepoRoots =
    initialUnresolvedPaths || hasAbsoluteCheckoutPath
      ? await completionRepoRootsForWorkspace(ctx.workspaceId, declaredCompletionPaths)
      : undefined;

  // P-001 / D-016 (design-to-code-coverage-seam-2026-09-02): make `filesChanged` FALSIFIABLE.
  //
  // `unresolvedPathsInCompletion` above is warn-only BY DESIGN and stays that way — an absent
  // path may have been DELETED by this very change or live in an unchecked-out submodule, so
  // grading on bare absence would down-grade exactly the honest refactor closes. Git history is
  // the discriminator: absent-but-known-to-git is a plausible deletion, absent AND unknown to
  // git never existed in this tree. Only the second may lower a grade.
  //
  // Gated on `initialUnresolvedPaths` so the git work is paid ONLY on a close that already has
  // missing paths — the overwhelming majority of closes never reach it. `?? []` preserves the
  // explicit-empty-means-cannot-judge contract, so a registry failure yields silence, never a
  // downgrade.
  const fabricatedPaths = initialUnresolvedPaths
    ? fabricatedPathsInCompletion(completionEvidenceForGate, { repoRoots: registeredRepoRoots ?? [] })
    : undefined;

  // P-005 / D-016: the next rung of the same ladder. Once a fabricated path costs a grade,
  // the cheapest way to satisfy that check is to name a REAL file you did not touch — the
  // gaming surface P-001 moved rather than removed. This probe judges the complementary
  // population (paths that DO resolve) and clears a path on either proof of work: a dirty
  // working tree, or a commit inside the work window.
  //
  // The window opens at the EARLIEST of created/claimed, because a wider window can only
  // ever clear a path. `registeredRepoRoots` is only computed on the unresolved-path branch
  // above, so fall back to the primary checkout the way `requirementDispositionShortfall`
  // does — otherwise this would sit permanently unjudgeable on the closes whose paths all
  // resolve, which is exactly its population.
  //
  // Gated on `authorityByEvidence === 'committed'` like the probes below: a close already
  // landing `proposed` cannot be lowered further, so the git work buys nothing there.
  const untouchedPaths =
    authorityByEvidence === 'committed'
      ? await untouchedPathsInCompletion(
          completionEvidenceForGate,
          [existing.createdAt, existing.takenAt]
            .map((value) => (value ? Date.parse(String(value)) : NaN))
            .filter((ms) => Number.isFinite(ms))
            .reduce<number | undefined>(
              (earliest, ms) => (earliest === undefined ? ms : Math.min(earliest, ms)),
              undefined,
            ),
          { repoRoots: registeredRepoRoots ?? [completionRoot()].filter((r): r is string => r !== null) },
        )
      : undefined;

  // P-002 / D-017: make `testResult` FALSIFIABLE against the run ledger.
  //
  // Gated on `authorityByEvidence === 'committed'` so the two queries are paid ONLY on a
  // close that would otherwise EARN the top grade — a close already landing `proposed`
  // cannot be lowered further, so spending a database round-trip on it buys nothing. Same
  // gating discipline as the fabricated-path probe above.
  const testRunContradiction =
    authorityByEvidence === 'committed'
      ? await testResultContradictedByRun(completionEvidenceForGate, {
          latestTestingRun: () =>
            latestTestingRunForOwner(ident.ownerId, ctx.workspaceId ?? null, it.harness ?? existing.harness ?? null),
          ledgerRowsInWindow: (paths, from, to) => testRunLedgerRowsInWindow(paths, from, to),
        })
      : undefined;

  // P-021 / D-014: make the close's account of THE ASK falsifiable, not just its account
  // of the files and the tests. The source is the originating item's own body — the text
  // a quote must be a literal span of — and `deferred` is what makes an absent disposition
  // self-contradictory rather than merely missing (see D-019 for why the demand is scoped
  // to that population and not to every code-shaped close).
  //
  // Gated on `authorityByEvidence === 'committed'` for the same reason as the ledger probe
  // above: a close already landing `proposed` cannot be lowered further, so the fs probes
  // buy nothing there.
  const requirementShortfall =
    authorityByEvidence === 'committed'
      ? requirementDispositionShortfall(completionEvidenceForGate, {
          sourceText: `${existing.title ?? ''}\n${existing.summary ?? ''}`,
          declaresDeferredWork: Boolean(it.completion.deferred?.some((d) => d.trim())),
          // `registeredRepoRoots` is only computed on the unresolved-path branch above, so
          // fall back to the primary checkout the way `unresolvedPathsInCompletion` does —
          // otherwise the citation check would sit permanently unjudgeable on the closes
          // that resolve cleanly, which is most of them.
          probe: { repoRoots: registeredRepoRoots ?? [completionRoot()] },
        })
      : undefined;

  // EI-22175397357614106: re-evaluate every DECLARED claim against the source. Unlike the
  // probes above this is pure fs + AST with no ledger and no network, so it is not gated on
  // `authorityByEvidence === 'committed'`: a `proposed` close cannot be lowered further, but
  // the verdicts are still recorded and returned so the closer is told which of their own
  // claims is false. Self-catching — any throw yields no finding, i.e. today's grade.
  const claimVerdicts = (() => {
    const declared = completionEvidenceForGate?.claims;
    if (!declared?.length) return undefined;
    try {
      const root = registeredRepoRoots?.[0] ?? completionRoot();
      if (!root) return undefined;
      return evaluateCompletionClaims(declared, repoSourceReader(root));
    } catch {
      return undefined;
    }
  })();
  const claimsFalsified = claimVerdicts?.results
    .filter((r) => r.verdict === 'falsified')
    .map((r) => ({ claim: JSON.stringify(r.claim), reason: r.reason }));

  // D-041 (goal-agent-behavior-feedback-2026-09-06, R-18): filing is not disposing. A close
  // that files its residue without `assign_to` and cites the id has handed the work to nobody.
  // Measured 6/6 in S35: the id sat in `summary` or `deferred` beside `coverage.residue: []`,
  // so this reads every field that names a follow-up, not `residue` alone. Only terminal closes
  // are judged, and it is not gated on `committed`: the warning is the point, so a `proposed`
  // close hears it too. One set-based read; any throw is silence, never an accusation.
  const residueUnowned = await (async () => {
    if (!effectiveState || !TERMINAL_WORK_ITEM_STATES.has(String(effectiveState).toLowerCase())) return undefined;
    try {
      const cited = residueCitations(
        {
          residue: completionEvidenceForGate?.coverage?.residue,
          deferred: it.completion.deferred,
          requirementDisposition: completionEvidenceForGate?.requirementDisposition,
          summary: it.completion.summary,
        },
        [it.id],
      );
      if (!cited.followUps.length && !cited.summaryRefs.length) return undefined;
      const cutoff = Date.parse(String(existing.takenAt ?? existing.createdAt ?? ''));
      const found = await getWorkItemsByIds([...cited.followUps, ...cited.summaryRefs]);
      const refs = unownedResidueRefs(
        cited,
        found.map((w) => {
          const createdAtMs = Date.parse(String(w.createdAt ?? ''));
          return {
            id: w.id,
            settled: TERMINAL_WORK_ITEM_STATES.has(String(w.state ?? '').toLowerCase()),
            assignee: w.assignee,
            createdBy: w.createdBy,
            ...(Number.isFinite(createdAtMs) ? { createdAtMs } : {}),
          };
        }),
        { ownerId: ident.ownerId, ...(Number.isFinite(cutoff) ? { sinceMs: cutoff } : {}) },
      );
      return refs.length ? refs : undefined;
    } catch {
      return undefined;
    }
  })();

  const completionEvidenceFindings: CompletionEvidenceFindings | undefined =
    fabricatedPaths || untouchedPaths || testRunContradiction || requirementShortfall || claimsFalsified?.length || residueUnowned
      ? {
          ...(fabricatedPaths ? { filesChangedNeverExisted: fabricatedPaths.neverExisted } : {}),
          ...(untouchedPaths ? { filesChangedUntouched: untouchedPaths.untouched } : {}),
          ...(testRunContradiction ? { testRunContradictedByLedger: testRunContradiction } : {}),
          ...(requirementShortfall ? { requirementDispositionShortfall: requirementShortfall } : {}),
          ...(claimsFalsified?.length ? { claimsFalsified } : {}),
          ...(residueUnowned ? { residueUnowned } : {}),
        }
      : undefined;
  // Re-run the SAME single decision point with the findings folded in, rather than overriding
  // its verdict afterwards — so the grade and its explanation stay computed once and cannot
  // disagree, which is the property work-item-completion-authority.ts exists to guarantee.
  const authorityWithFindings = authorityForCompletion(completionEvidenceForGate, completionEvidenceFindings);
  // A downgrade nobody is told about is the refusal-loop failure this module warns against:
  // the agent sees `proposed`, cannot tell which of several gates produced it, and re-submits
  // the fields it already sent. Name the exact paths and the exact discriminator, and say
  // plainly what does NOT trigger it — deletion is legitimate and must not read as an accusation.
  // Same anti-refusal-loop obligation as the fabricated-path message below: name the exact
  // paths, name the discriminator, and say plainly what does NOT trigger it — an agent told
  // only "your evidence was insufficient" re-sends the fields it already sent. Naming the
  // last-commit time makes the verdict checkable by hand rather than taken on trust.
  const untouchedPathsWarning =
    untouchedPaths && authorityByEvidence === 'committed'
      ? `completion for ${it.id} landed authority:'proposed' rather than 'committed': ` +
        `${untouchedPaths.untouched.length} \`filesChanged\` path(s) exist in the tree but show no sign ` +
        `this work changed them — the working tree is clean at each, and each was last committed before ` +
        `this item began (${untouchedPaths.since}): ` +
        `${untouchedPaths.untouched.map((u) => `${u.path} (last committed ${u.lastCommitAt})`).join(', ')}. ` +
        `A path is CLEARED by either proof of work, so this does NOT fire on an edit git-sync has not ` +
        `swept yet (an uncommitted change makes the tree dirty and is accepted), nor on one it already ` +
        `swept (any commit inside the window is accepted); nor on a submodule path, a glob, an absolute ` +
        `path, or unknown git history, all of which are silent. This is the successor to the ` +
        `fabricated-path check: once a named path must exist, naming a real file you did not touch is the ` +
        `cheapest way to satisfy it, which is the gaming surface that check moved rather than removed. ` +
        `To fix: re-call work_items:complete with \`filesChanged\` naming the files this work actually ` +
        `changed, and drop the ones it did not — an accurate short list grades better than a long one.`
      : undefined;

  const fabricatedPathsWarning =
    fabricatedPaths && authorityByEvidence === 'committed'
      ? `completion for ${it.id} landed authority:'proposed' rather than 'committed': ` +
        `${fabricatedPaths.neverExisted.length} \`filesChanged\` path(s) are absent from the tree AND ` +
        `unknown to git history, so they have never existed in this checkout: ` +
        `${fabricatedPaths.neverExisted.join(', ')}. This is NOT triggered by deleting a file — a path ` +
        `git has any record of, on any branch, is treated as a legitimate deletion and does not affect ` +
        `the grade; nor by a glob, an absolute path outside all managed checkouts (recorded as ` +
        `outOfRepoArtifact and excluded from Git identity checks; external contents are not hashed), a ` +
        `submodule path, or any case the probe cannot judge. For an out-of-tree deliverable, use its ` +
        `absolute path instead of a repo-relative alias; do not use this exception for a missing repo file. ` +
        `Measured 2026-08-10 (EI-20093150500083378): an agent filed 12 ` +
        `paths across two closes and 8 were fabricated — an \`agent-tools/\` segment and a \`__tests__/\` ` +
        `dir this repo does not use — and both closes still landed 'committed'. The fabricated paths ` +
        `were MORE conventional than the real ones, which is why review does not catch them. To fix: ` +
        `verify the paths on disk and re-call work_items:complete with an ARRAY of bare repo-relative ` +
        `paths that actually exist, for example \`filesChanged: ["path/to/file.ts"]\`.`
      : undefined;

  // Same anti-refusal-loop obligation as above, and the reason this message CITES the run
  // group: an agent told only "your evidence was insufficient" cannot tell which gate fired
  // and re-sends the fields it already sent. Naming the run id and the failing files makes
  // the verdict checkable — the agent can re-read that exact run rather than take the
  // server's word — and naming what is silent stops it reading as a general accusation.
  const testRunContradictionWarning = testRunContradiction
    ? `completion for ${it.id} landed authority:'proposed' rather than 'committed': your most recent ` +
      `\`testing:run\` (run group ${testRunContradiction.runGroupId}) is recorded in the test_runs ledger ` +
      `with ${testRunContradiction.failingFiles.length} of ${testRunContradiction.filesInRun} file(s) ` +
      `FAILING: ${testRunContradiction.failingFiles.join(', ')}. The declared \`testResult\` is therefore ` +
      `contradicted by a real run — before this check, any non-empty string satisfied the gate, so the ` +
      `literal "3 failed" earned 'committed'. This is NOT triggered by an earlier red you already fixed ` +
      `(only your LATEST run is read), by a run another agent made (a window resolving to more than one ` +
      `run group is refused outright), or by \`skip\`/\`cancelled\`/\`running\` rows, all of which are ` +
      `silent. To fix: make those files pass, re-run them with testing:run, and re-call ` +
      `work_items:complete — the newer green run then supersedes this one.`
    : undefined;

  // Same anti-refusal-loop obligation as the two warnings above: name the exact entries and
  // the exact test each failed, and say plainly what is SILENT, so the message cannot read
  // as a general accusation. The two kinds have genuinely different remedies, so they get
  // genuinely different messages rather than one hedged paragraph covering both.
  const requirementShortfallWarning = requirementShortfall
    ? requirementShortfall.kind === 'absent'
      ? `completion for ${it.id} landed authority:'proposed' rather than 'committed': this close ` +
        `DECLARES deferred work but supplies no \`verification.requirementDisposition\`, so it says ` +
        `it did not deliver everything asked without saying which part of the ask was left. That is ` +
        `the gap D-014 exists to close: under-delivery is mostly an ENUMERATION failure, and ` +
        `enumeration is mechanically checkable (a citation resolves or it does not), unlike a ` +
        `self-grade. This is NOT asked of every close — a close declaring no deferred work, one ` +
        `naming no files, or one whose originating item has no substantive body to quote is silent. ` +
        `To fix: re-read the originating item body and pass ` +
        `\`verification.requirementDisposition: [{ requirement: "<VERBATIM quote from that body>", ` +
        `disposition: "deferred", followUp: "EI-123" }, …]\` — one entry per distinct requirement, ` +
        `each quote a literal span of the body, \`implemented\` entries citing a path that exists.`
      : `completion for ${it.id} landed authority:'proposed' rather than 'committed': its ` +
        `\`verification.requirementDisposition\` does not hold up. ` +
        (requirementShortfall.notQuotedFromSource.length
          ? `${requirementShortfall.notQuotedFromSource.length} entr(ies) are NOT a verbatim span of ` +
            `the originating item body (or are too short to be a distinct requirement): ` +
            `${requirementShortfall.notQuotedFromSource.join(' | ')}. Paraphrase is exactly where ` +
            `silent narrowing hides — "make the retry robust" becomes "added a retry" — which is why ` +
            `the quote is substring-checked rather than read. Whitespace is normalised, so a quote ` +
            `spanning a line wrap is fine; copy the words exactly. `
          : '') +
        (requirementShortfall.implementedWithoutResolvingCitation.length
          ? `${requirementShortfall.implementedWithoutResolvingCitation.length} entr(ies) are marked ` +
            `\`implemented\` with no citation that resolves against the tree: ` +
            `${requirementShortfall.implementedWithoutResolvingCitation.join(' | ')}. Pass ` +
            `\`citations: ["repo/relative/path.ts"]\` naming a file that exists. A glob, an absolute ` +
            `path, or any path outside the checkout is NOT judged and never triggers this. `
          : '') +
        (requirementShortfall.deferredWithoutFollowUp.length
          ? `${requirementShortfall.deferredWithoutFollowUp.length} entr(ies) are marked \`deferred\` ` +
            `with no filed follow-up ref: ${requirementShortfall.deferredWithoutFollowUp.join(' | ')}. ` +
            `File the follow-up and pass its id as \`followUp: "EI-123"\` — a deferral nobody filed is ` +
            `indistinguishable from work silently dropped. `
          : '') +
        `Re-call work_items:complete with the corrected list.`
    : undefined;

  // Same anti-refusal-loop obligation as the warnings above. This one can afford to be the
  // most concrete of the four, because the claim was DECLARED in a structured form: the
  // message can quote the exact assertion and the exact reason the source contradicts it,
  // so the closer never has to guess which field to change. Naming what is SILENT matters
  // as much here as elsewhere — an `unevaluatable` claim never affects the grade, so a
  // renamed container or an unreadable path must not read as an accusation of falsity.
  const claimsFalsifiedWarning = claimsFalsified?.length
    ? `completion for ${it.id} landed authority:'proposed' rather than 'committed': ` +
      `${claimsFalsified.length} declared \`verification.claims\` entr(ies) were re-evaluated against ` +
      `the source and found FALSE: ` +
      `${claimsFalsified.map((c) => `${c.claim} → ${c.reason}`).join(' | ')}. Every other evidence ` +
      `check is a PRESENCE test, so before this one a close whose evidence was present, well-formed ` +
      `and wrong still earned 'committed' (EI-22175397357614106: WI-37365 closed 'committed' asserting ` +
      `a verb had reached the live seeded tool surface when it had not, and that false close became ` +
      `the premise for a downstream falsifier armed against a verb no session could call). This is ` +
      `NOT triggered by a claim the server could not decide — an unreadable path, a renamed or ` +
      `missing container, or membership hidden behind a spread all yield 'unevaluatable' and are ` +
      `silent, because absence of judgement is never judged-clean. To fix: correct the claim to match ` +
      `the source (or drop it) and re-call work_items:complete. You are not required to declare claims ` +
      `at all — but a declared one is re-derived from the tree, never believed.`
    : undefined;

  // D-041: the same anti-refusal-loop obligation — name each ref, the one repair, and what is
  // SILENT, so an agent that filed and assigned its residue never reads this as an accusation.
  const residueUnownedWarning = residueUnowned
    ? `completion for ${it.id} grades at most authority:'proposed': it cites ${residueUnowned.length} ` +
      `follow-up(s) that are OPEN with NO assignee: ${residueUnowned.join(', ')}. Filing is not ` +
      `disposing — work_items:create without assign_to leaves an item unclaimed, so nobody owns this ` +
      `residue. This is NOT triggered by a settled or assigned follow-up, nor by an id the summary ` +
      `only mentions that you did not file during this work. To fix: give each an owner with ` +
      `work_items:claim { id, assignee: '<owner id>' } (omit assignee to take it yourself) and list it ` +
      `in coverage.residue; next time pass assign_to on work_items:create.`
    : undefined;

  // EI-18682004530991057 (proposal 3): stamp WHAT TREE this evidence was observed
  // against. Applied to the PERSISTED object only — never to `completionEvidenceForGate`
  // — for the same reason `summary` is kept out of it above: `hasTests`,
  // `authorityForCompletion` and `isBackedLiveDroveUiClaim` all key off whether
  // STRUCTURED evidence was supplied, so folding a server-generated field into the gate
  // evidence would let an evidence-free close silently read as "evidence supplied" and
  // promote itself to `committed`. The stamp describes evidence; it is never evidence.
  //
  // Deliberately stamps ONLY a record that already exists: a close carrying nothing at
  // all stays `undefined` rather than gaining an `_completionEvidence` object whose one
  // key came from the server, which a later reader could mistake for caller-supplied proof.
  const treeStamp = completionEvidenceBeforeStamp
    ? registeredRepoRoots
      ? await completionTreeStampForEvidence(completionEvidenceBeforeStamp, registeredRepoRoots)
      : await completionTreeStamp({
          repoRoot: completionRoot(),
          filesChanged: completionEvidenceBeforeStamp.filesChanged,
          filesDeleted: completionEvidenceBeforeStamp.filesDeleted,
        })
    : undefined;
  const completionEvidenceToPersist: PersistedCompletionEvidence | undefined = (() => {
    const base = withClaimBaseline(completionEvidenceBeforeStamp, claimVerdicts, new Date().toISOString());
    if (!base || !treeStamp) return base;
    const stamped = { ...base, treeStamp };
    const settlementManifest = completionSettlementManifest(stamped);
    return settlementManifest ? { ...stamped, settlementManifest } : stamped;
  })();
  // P-001: `authorityWithFindings` supersedes `authorityByEvidence` from here on — it is the
  // same judgement with the tree-resolution finding folded in. `authorityByEvidence` remains
  // the PRE-findings verdict and is still what the caller-facing explanation below reports on,
  // so a downgrade can be attributed to its actual cause rather than to the evidence fields.
  const committedContentIdentityMissing = committedCloseDowngradedForUnprovenContentIdentity(
    authorityWithFindings,
    completionEvidenceForGate?.filesChanged,
    treeStamp,
    completionEvidenceForGate?.filesDeleted,
  );
  // P-007: the THIRD downgrade stage, beside `committedContentIdentityMissing`. Those two
  // ask different questions and neither subsumes the other: content identity asks whether
  // the DECLARED paths resolve to real blobs, while terminal criteria ask whether a close
  // CLAIMING remediation landed anything at all and whether its only stated verification can
  // distinguish a fix from no fix. D-006 measured the discriminating case — a close that
  // names a genuine mechanism, declares nothing, and attributes the fix to commits that had
  // already landed — which declares no paths and so never reaches the content-identity stage.
  //
  // Fail-open, and never throwing, per D-003: an unmet criterion downgrades a close to
  // `proposed` while the completion stays RECORDED. A bug in this evaluator must cost a
  // downgrade at worst, never a lost completion record.
  let terminalCriteria: ReturnType<typeof evaluateCloseTerminalCriteria> | undefined;
  try {
    terminalCriteria = evaluateCloseTerminalCriteria({
      itemKind: existing.kind,
      // Ordinary closes use the requested terminal state as their disposition. A valid
      // non-self duplicate is different: it is an administrative "superseded by survivor"
      // disposition, not a claim that this item was remediated. Feed the evaluator its
      // non-remediating reason so `verifiedHow: 'already-passing'` can describe the existing
      // survivor without downgrading an otherwise evidenced duplicate close. The persisted
      // `terminal_reason` column still comes from the requested state in work-items.ts.
      status: String(effectiveState ?? ''),
      terminalReason: duplicateCloseCoverageException ? 'duplicate' : effectiveState ? String(effectiveState) : null,
      filesChanged: completionEvidenceForGate?.filesChanged,
      filesDeleted: completionEvidenceForGate?.filesDeleted,
      treeStamp,
      verifiedHow: completionEvidenceForGate?.verifiedHow,
      payload: existing.payload,
      itemRef: it.id,
      sourcePlanSlug: existing.sourcePlanSlug,
    });
  } catch {
    /* fail-open: the completion record must never be lost to a criteria evaluation fault */
  }
  // D-018: the ENFORCEMENT kill-switch. This gate changes close outcomes for ~6.1% of
  // committed bug/change closes fleet-wide the moment it deploys, so it needs a rollback
  // that is not a revert. OFF suppresses ONLY the downgrade — the evaluator above has
  // already run and its verdict is still reported, so the gate stays MEASURABLE while
  // disabled rather than becoming a blind spot.
  //
  // The read fails SAFE-ON, not safe-off: the flag's own default is ON, so a transient
  // flag-store fault resolves to the shipped behaviour instead of silently disabling the
  // gate for every agent at once. This is the opposite direction from D-003's fail-open,
  // and deliberately so — D-003 protects the completion RECORD from an evaluator fault,
  // whereas this protects ENFORCEMENT from a flag-read fault. Neither can lose a record.
  const terminalCriteriaEnforced = terminalCriteria?.downgrade
    ? await getFlag(FLAGS.TERMINAL_CRITERIA_ENFORCEMENT, activeWorkspaceId()).catch(() => true)
    : true;
  const terminalCriteriaUnmet =
    terminalCriteriaEnforced && authorityWithFindings === 'committed' && terminalCriteria?.downgrade === true;
  const terminalCriteriaWarning = terminalCriteria?.downgrade
    ? `completion for ${it.id}: ${terminalCriteria.warning}` +
      (terminalCriteriaUnmet
        ? ` Authority landed 'proposed' rather than 'committed' as a result.`
        : !terminalCriteriaEnforced
          ? ` Enforcement is DISABLED (flag ${FLAGS.TERMINAL_CRITERIA_ENFORCEMENT} is off), so authority stayed '${authorityWithFindings}'; this verdict is recorded but not applied.`
          : ` Authority was already '${authorityWithFindings}', so this did not change it.`) +
      (terminalCriteria.refusedDeclaration ? ` Note: ${terminalCriteria.refusedDeclaration}` : '')
    : undefined;
  // A screenshot in session scratch can exist at close time and vanish before an
  // independent reviewer opens it. The existing ephemeral-reference detector
  // already distinguishes Git-tracked paths from scratch-only deliverables;
  // apply its result to live-UI terminal authority as well as the advisory.
  let ephemeralDeliverableWarning: string | undefined;
  let unretainedLiveUiPaths: string[] = [];
  try {
    const references = completionEphemeralDeliverableReferences(it.completion, completionEvidenceToPersist, {
      repoRoots: registeredRepoRoots ?? [completionRoot()],
      treeStamp: completionEvidenceToPersist?.treeStamp,
    });
    ephemeralDeliverableWarning = renderEphemeralDeliverableWarning(`completion for ${it.id}`, references);
    if (closeIntentRequested && completionEvidenceToPersist?.verifiedHow === 'live-drove-ui') {
      unretainedLiveUiPaths = references
        .filter((reference) => reference.kind === 'scratch-path')
        .map((reference) => reference.reference);
    }
  } catch {
    /* fail-open: an evidence-detector fault must never lose the completion record */
  }
  const completionAuthority =
    committedContentIdentityMissing || terminalCriteriaUnmet || unretainedLiveUiPaths.length > 0
      ? 'proposed'
      : authorityWithFindings;
  // EI-23241378625604548: validateOnly must use the same read-only settlement verdict as
  // the real close. Returning above this point exposed only the contract requirements and
  // skipped the findings that can downgrade an otherwise complete evidence record (for
  // example, a deferred code-shaped close with no requirement disposition). Keep this
  // boundary before every persistence/finish leg, and expose the finding that explains any
  // downgrade so callers can repair the exact input before submitting the real close.
  if (it.validateOnly) {
    return {
      ok: true,
      id: it.id,
      validationOnly: true,
      completionAuthority,
      countsTowardBurnDown: countsTowardBurnDown(completionAuthority, true, isAbandonedClose),
      ...(completionEvidenceFindings ? { completionEvidenceFindings } : {}),
      ...(ephemeralDeliverableWarning ? { ephemeralDeliverableWarning } : {}),
      completionContract: completionContract(),
    };
  }
  // EI-20008560598714546: summary is also a natural place to cite the live
  // artifact. Scan the persisted evidence shape for that citation, while the
  // authority judgement above remains scoped to structured verification fields.
  const unbackedLiveDroveUiClose = closeIntentRequested && !isBackedLiveDroveUiClaim(completionEvidenceToPersist);
  const unbackedLiveServiceClose = closeIntentRequested && !isBackedLiveServiceClaim(completionEvidenceToPersist);

  // EI-18797014705631713: citing an artifact is not the same as HAVING one. The text
  // check above proves a path was written down; this reads the file. A screenshot of a
  // window that never painted is a valid PNG at a valid path proving nothing, and it is
  // produced by the same command as a real one — so the strongest-looking evidence type
  // was the easiest to fake by accident. Deliberately fail-open: it refuses only when
  // every cited artifact is confidently bad (see verifyLiveDroveUiArtifacts).
  const artifactVerdict = closeIntentRequested ? await verifyLiveDroveUiArtifacts(completionEvidenceToPersist) : null;
  const falseLiveDroveUiClose = !unbackedLiveDroveUiClose && artifactVerdict?.ok === false;

  // EI-18850142725126359 fix #4 — PRE-FLIGHT THE PLANE RATCHET.
  //
  // Closing a METRIC_KNOWN_GAPS item is a fleet-gate mutation: `lint:plane-ratchet`
  // reads live work-item status, so the exemption is withdrawn the instant the row
  // goes terminal and the very next green-checkpoint reds — candidate-independently,
  // three minutes later, on a release-fixer who is handed a causally-irrelevant SHA.
  // Say it HERE instead, to the agent who is about to cause it.
  //
  // Computed BEFORE the state write for two reasons: the warning is the caller's
  // last cheap moment to reconsider, and it must still be reported when the write
  // itself fails. Warn-only, and deliberately so — see the provenance argument in
  // agent-plane-close-preflight.ts's header (this process holds the DEPLOYED gap
  // map, the gate judges the candidate's, so a refusal could block a correct close
  // on data known to be stale). Fully fail-open: a guard fault must never cost a
  // completion (EI-24).
  let planeRatchetWarning: string | undefined;
  if (closeIntentRequested && isPlaneGapItem(it.id)) {
    try {
      const verdict = await preflightPlaneCloseLive({ closingIds: [it.id], workspaceId: ctx.workspaceId });
      if (verdict) planeRatchetWarning = renderPlaneClosePreflightWarning(verdict);
    } catch {
      /* fail-open: never turn a ratchet-check fault into a failed completion */
    }
  }

  // P-008 (d) / D-050 / D-079: resolve the declared assumptions BEFORE the state
  // write, so a dangling reference cannot land a close.
  //
  // ⚠ Deliberately NOT a throw, unlike work_items:set_state. A throw here would
  // discard the completion narrative the caller wrote, which is exactly what this
  // file's record-and-warn discipline (EI-24: "the narrative is never lost")
  // forbids. The precedent is `unbackedLiveDroveUiClose` immediately below — the
  // same shape of failure, an unbacked claim — which blocks the CLOSE via
  // `stateError` and still returns the record. So a dangling assumption refuses
  // the commitment (the item stays claimable) without costing the caller the
  // write-up. `set_state` has no narrative to lose, so it throws.
  let resolvedAssumptions: StoredAssumptionDeclaration | undefined;
  let assumptionsError: string | undefined;
  if (it.assumptions !== undefined) {
    try {
      resolvedAssumptions = await resolveDeclaredAssumptions({
        declared: it.assumptions,
        workItemId: it.id,
        ownerId: ident.ownerId,
        // EI-18806393166489384: `it.harness` is the caller's OPTIONAL arg, so a
        // close that did not redundantly name the harness resolved no harness
        // scope at all. The resolver now derives it when absent, but pass the row
        // we already fetched above so the common path costs no extra read.
        harnessSlug: it.harness ?? existing.harness,
      });
    } catch (e) {
      assumptionsError = e instanceof Error ? e.message : String(e);
    }
  }
  // EI-19298742806956600: WARN-ONLY — a cited key that resolves fine but was never
  // asserted as an assumption (kind:'assumption' or legacy confidence:'suspected').
  // Never refuses (see nonAssumptionKindAdvisory's own header for why); surfaced the
  // same way planeRatchetWarning is, below.
  const assumptionKindWarning =
    resolvedAssumptions && Array.isArray(resolvedAssumptions.declared)
      ? nonAssumptionKindAdvisory(resolvedAssumptions.declared)
      : undefined;

  if (assumptionsError) {
    stateError = `REJECTED — ${assumptionsError}`;
  } else if (unretainedLiveUiPaths.length > 0) {
    stateError =
      `REJECTED — ${it.id} claims retained live-UI evidence under session scratch: ` +
      `${unretainedLiveUiPaths.join(', ')}. Copy the capture to a retained artifact path, ` +
      'verify that copy exists, and cite the retained path in the completion.';
  } else if (unbackedLiveServiceClose) {
    stateError =
      `REJECTED — this completion claims verifiedHow:'live-service' to close ${it.id}, but ` +
      '`testsRun`/`testResult` do not jointly cite both a concrete service/unit/process and a ' +
      'falsifiable runtime observation (`MainPID`, `NRestarts`, `ActiveState`, or an HTTP status). ' +
      "Cite the live command and observation, or honestly set verifiedHow to 'unit'/'manual'/'integration' and re-send.";
  } else if (unbackedLiveDroveUiClose) {
    stateError =
      `REJECTED — this completion claims verifiedHow:'live-drove-ui' to close ${it.id} but cites no real ` +
      'artifact in summary/testsRun/testResult/filesChanged. This is exactly the gap that shipped WI-5874/P-001 past ' +
      'its own author: unit tests verify structure, not pixels. Cite whichever of these matches what you ' +
      'actually drove — DESKTOP: a screenshot/capture image path, or a recorded tauri-agent-tools ' +
      'capture/screenshot/check invocation. WEB: the deployed URL with its HTTP status (e.g. ' +
      '`https://example.com/x -> 200`), or a recorded browser-driver run naming the http(s) target it drove ' +
      '(e.g. `npx playwright test e2e/x.spec.ts` against https://example.com). ' +
      // EI-20411096292493737: the fallback list is named LAST and conditioned, because
      // offering it first made it the cheapest way out of a rejection an agent disagreed
      // with. For a real web live-drive all three of these labels are FALSE, so an agent
      // with no truthful option picks whichever passes — putting a wrong verifiedHow into
      // the very ledger this gate protects. A mislabel is silent; a rejection is not.
      "Only if you did NOT drive live UI, set verifiedHow to 'unit'/'manual'/'integration' and re-send.";
  } else if (falseLiveDroveUiClose) {
    stateError =
      `REJECTED — this completion claims verifiedHow:'live-drove-ui' to close ${it.id}, but its cited evidence ` +
      `does not hold up: ${artifactVerdict?.reason}. A capture of a window that never painted ` +
      'exits 0 and writes a normal-looking file, so citing it proves a command ran, not that any UI was seen ' +
      '(scripts/verify-tauri-headless.sh warns about exactly this when the box has no real GPU GL). ' +
      'Strongest fix, and cheaper than another screenshot: cite a `tauri-agent-tools check --pid <pid> --eval ' +
      '"<assertion>" --json` run — it exits non-zero when the assertion is false, so it is falsifiable and ' +
      'records WHAT you asserted. Otherwise re-capture, OPEN the image to confirm it rendered, and cite that ' +
      "path — or honestly set verifiedHow to 'unit'/'manual'/'integration' and re-send.";
  } else if (effectiveState) {
    try {
      // EI-22726666602239861: bounded state writes map transient PG 55P03/57014
      // contention to a typed error. Retry the whole idempotent lifecycle write so a
      // brief lock-timeout dip does not record completion evidence while leaving the
      // item claimable. Non-contention errors still propagate immediately through the
      // shared helper and land in stateError below.
      const res = await acquireWithContentionRetry(() =>
        setWorkItemStateWithAliasInfo(it.id, effectiveState, {
          harness: it.harness,
          by: ident.ownerId,
          // NO `completionRef` — see the block comment above. The narrative is not
          // lost: `completionEvidenceToPersist` (EI-19319623239777505) carries the
          // caller's free-text `summary` alongside whatever structured fields exist,
          // so it lands durably on the row's `_completionEvidence`, not just in this
          // call's return value.
          completionEvidence: completionEvidenceToPersist,
          outputPayload: it.outputPayload,
          // P-008 (d): the resolved declaration, persisted under
          // TERMINAL_ASSUMPTIONS_KEY beside the evidence it rests on.
          assumptions: resolvedAssumptions,
          completionAuthority,
          onTerminalConflict: (info) => {
            terminalConflict = info;
          },
        }),
      );
      workItem = res.workItem ?? existing;
      aliasNote = res.aliasNote;
      aliased = res.aliased;
      requestedState = res.requestedState;
      appliedState = res.appliedState;
    } catch (e) {
      stateError = e instanceof Error ? e.message : String(e);
      if (closeIntentRequested && isPlanGateRejection(stateError)) {
        try {
          const parked = await setWorkItemClaimHold(it.id, true, {
            // The inline shorthand commonly omits `harness`; the fetched work-item is
            // still the authoritative scope for this durable hold (as it is for
            // assumption resolution below). Never write an unscoped hold in that case.
            harness: it.harness ?? existing.harness ?? undefined,
            parkedBy: ident.ownerId,
            parkedReason: 'terminal completion refused by the linked plan-item gate',
          });
          if (parked?.applicable) {
            planGateParked = true;
            planGateParkWarning =
              `the plan-gated close for ${it.id} was DURABLY PARKED out of scheduler:get_next until the ` +
              'linked plan-item gate is cleared; clear the park deliberately with ' +
              `work_items:release { id: '${it.id}', claimHold: false }.`;
          } else {
            planGateParkWarning =
              `the plan-gated close for ${it.id} could not be durably parked (the claim hold was not applicable); ` +
              'it remains claimable and must not be treated as isolated from the scheduler.';
          }
        } catch (parkError) {
          planGateParkWarning =
            `the plan-gated close for ${it.id} could not be durably parked: ` +
            `${parkError instanceof Error ? parkError.message : String(parkError)}; ` +
            'it remains claimable and must not be treated as isolated from the scheduler.';
        }
      }
    }
  } else if (TERMINAL_WORK_ITEM_STATES.has((existing.state ?? '').toLowerCase())) {
    // EI-19362441037986499 — THE RECORD-ONLY COMPLETION OF AN ALREADY-CLOSED ITEM. Reaching
    // here means no state was passed and none could be inferred (`completion.status:'done'`
    // is the schema default, so it deliberately never infers a close), and the row is
    // already terminal. Before this arm existed, that combination took NO persistence
    // branch: the arm above is the only writer, so the caller's evidence was echoed back
    // and dropped, `ok:true`, with `stateWarning` suppressed because the final state IS
    // terminal. That is the whole defect — a watchdog auto-resolve landing first turned a
    // fully-evidenced agent close into a row reading as an unevidenced one.
    //
    // Routed through a writer that performs NO state write and emits NO events, because a
    // terminal→same-terminal re-assert would re-fire `work-item:done:<id>` (that emit has no
    // state-changed guard) on every record-only completion. Deliberately NOT routed through
    // `closeIntentRequested` either: that would newly demand `assumptions` from a caller who
    // is closing nothing, converting a silent no-op into a hard refusal. And it never
    // hard-rejects — this file's contract is that a finished completion is normalised, never
    // rejected-and-lost.
    try {
      const attached = await attachCompletionEvidenceToSettledItem(it.id, {
        harness: it.harness ?? existing.harness ?? undefined,
        by: ident.ownerId,
        // Same asymmetry as the state write above: no `completionRef`. The narrative rides
        // in `completionEvidenceToPersist`, which carries the caller's free-text summary
        // alongside whatever structured fields exist.
        completionEvidence: completionEvidenceToPersist,
        assumptions: resolvedAssumptions,
        completionAuthority,
        // Reuse the one result field, so an attested/upgraded outcome surfaces through the
        // same loud warning the state-write path already produces.
        onTerminalConflict: (info) => {
          terminalConflict = info;
        },
      });
      workItem = attached.workItem ?? existing;
      if (attached.outcome === 'recorded' || attached.outcome === 'upgraded') {
        evidenceAttachWarning =
          `${it.id} was ALREADY terminal ('${existing.state}') and this completion requested no state change, ` +
          `so no transition was applied — your completion record was ` +
          `${attached.outcome === 'upgraded' ? 'installed as the AUTHORITATIVE record (the weaker stored record was archived as an attestation)' : 'STORED as the item’s completion record'}. ` +
          'Nothing further is needed; the item stays closed.';
      } else if (attached.outcome === 'attested') {
        // terminalConflict already carries the full explanation; keep this short so the two
        // do not restate each other at the caller.
        evidenceAttachWarning =
          `${it.id} was ALREADY terminal ('${existing.state}') and completed by someone else, so your record was ` +
          'filed as a second attestation rather than replacing theirs — see the terminal-completion conflict note.';
      } else if (attached.outcome === 'nothing-to-record') {
        evidenceAttachWarning =
          `${it.id} is ALREADY terminal ('${existing.state}') and this completion carried no evidence to store ` +
          '(no verifiedHow/testsRun/testResult and no authority judgement), so nothing was written to the row. ' +
          'Re-send with structured evidence if you meant to record how it was verified.';
      }
    } catch (e) {
      // Mirrors the state-write catch: the completion record + emit still happen, and the
      // failure is reported rather than swallowed.
      stateError = e instanceof Error ? e.message : String(e);
      evidenceAttachWarning =
        `${it.id} is ALREADY terminal ('${existing.state}') and your completion evidence could NOT be attached ` +
        `to the row: ${stateError}. The completion was recorded in this call's result only — re-check the row ` +
        'before treating its stored completion record as yours.';
    }
  }

  // EI-5269: `completion.status` (defaults to 'done') is NOT the state transition — only the
  // top-level `state` arg moves the row terminal. Completing WITHOUT a terminal `state` records
  // the completion (so it READS as done) but leaves the item non-terminal → still claimable, and
  // the stale-reclaim sweep re-places work on it (real duplicate bee spawns the reporter hit). We
  // deliberately do NOT auto-close (that would step on the validator/reviewer pipeline's own status
  // semantics — state is optional BY DESIGN, D-004). Instead we make the silent footgun LOUD: warn
  // whenever the item is non-terminal after this completion, so the caller re-calls with a terminal
  // `state` (exactly the fix the reporter applied). Also fires when an explicit `state` write failed
  // (stateError) or landed on a non-terminal state — in every case the item is still claimable.
  const finalState = (workItem?.state ?? existing.state ?? '').toLowerCase();
  // EI-18661904412177717: the warning MUST distinguish "you passed no state" from "your state
  // was not applied". The single wording ("Pass top-level `state` …") told a caller who HAD
  // passed one to do the exact thing they just did — so the natural next move is to re-send the
  // identical call and get the identical result (the reporter did, twice). A warning that
  // prescribes an action the caller already took is worse than no warning: it actively routes
  // them into a loop instead of at the real cause.
  const nonTerminalHint = `so it stays claimable and the auto-loop may re-place work on it`;
  const claimabilityHint = planGateParked
    ? `it is durably parked out of scheduler:get_next until the linked plan-item gate is cleared`
    : nonTerminalHint;
  const terminalVocab = `(feature: 'passed'|'deprecated'; issue: 'resolved'|'closed')`;
  //
  // EI-19362441037986499: the terminal arm of that first condition is what made the
  // record-only-on-a-closed-item discard SILENT — "the item is closed" was read as "there is
  // nothing to warn about", when the thing worth saying is what became of the evidence. The
  // evidence-attach outcome therefore takes precedence: it is the only case where a TERMINAL
  // final state still has something the caller must be told.
  const stateWarning =
    evidenceAttachWarning ??
    (!finalState || TERMINAL_WORK_ITEM_STATES.has(finalState)
      ? undefined
      : stateError
        ? `recorded a completion for ${it.id} but it is NOT closed — still '${workItem?.state ?? existing.state}', ${claimabilityHint}. Your state '${effectiveState}' was REJECTED by the state write: ${stateError}. Re-sending the same state will fail the same way — fix the cause, or pass a valid TERMINAL state ${terminalVocab}.`
        : effectiveState
          ? `recorded a completion for ${it.id} but it is NOT closed — still '${workItem?.state ?? existing.state}', ${nonTerminalHint}. Your state '${requestedState ?? effectiveState}' WAS received and applied as '${appliedState ?? workItem?.state ?? existing.state}', which is NOT terminal${aliasNote ? ` (${aliasNote})` : ''}. Do NOT re-send the same value — pass a TERMINAL state ${terminalVocab}.`
          : `recorded a completion for ${it.id} but it is NOT closed — still '${workItem?.state ?? existing.state}', ${nonTerminalHint}. No top-level \`state\` was passed. Pass top-level \`state\` ${terminalVocab} to close it.`);

  // flush-to-proceed-stretch-discipline-2026-07-04 P-006: verification linting. A settled
  // unit is either VERIFIED (`tests`) or CONSCIOUSLY DEFERRED (`deferred`) — never silent. A
  // completion carrying NEITHER is exactly the "settled a unit without saying whether it was
  // checked" gap the discipline closes. SOFT warning, not a hard reject (D-005): this file's
  // whole contract is EI-24 "a finished completion is normalised, never hard-rejected+lost"
  // — the coerce layer, the state-write catch, and stateWarning all record-and-warn rather
  // than drop, so hard-rejecting HERE would be the one place that violates it. Mirrors
  // stateWarning: attached to the result + surfaced to the caller; the completion is still
  // recorded + emitted. Rides the write-echo passthrough (write-echo-shape.ts).
  //
  // EI-7316: the schema carries verification evidence across SEVEN sibling fields
  // (tests / testsRun / testResult / verifiedHow, each also duplicated under the
  // nested `verification.*` alias) — completionEvidenceFromRecord (above) already
  // treats all of them as equally valid evidence when filling completionEvidence for
  // the state write. This check used to inspect ONLY the bare `tests` field, so a
  // caller who documented verification via `testsRun`/`testResult`/`verifiedHow` (or
  // the nested `verification.*` aliases) — every one a legitimate, schema-blessed
  // way to record it — got a FALSE "neither tests nor deferred populated" warning
  // even though they HAD stated how it was verified. Reuse the SAME evidence
  // extraction as the state write (completionEvidenceFromRecord) as the one source
  // of truth, so "did this completion record verification" can never disagree
  // between the two call sites.
  const hasTests = completionEvidenceForGate !== undefined;
  const hasDeferred = Array.isArray(it.completion.deferred) && it.completion.deferred.length > 0;
  // Bare strings never reach this handler: completionSpec rejects them before
  // completeOne runs, with the exact structured-object example in its issue message.
  const verificationWarning =
    !hasTests && !hasDeferred
      ? `recorded a completion for ${it.id} with neither \`tests\` nor \`deferred\` populated — a settled unit should state whether it was VERIFIED (fill \`tests\`: what you ran / how you checked it, e.g. "18 vitest green" or "n/a — docs only") or CONSCIOUSLY DEFERRED (fill \`deferred\`: what you left undone + why). Add one so the unit isn't silently unverified (flush-to-proceed: a unit settles only live-verified or explicitly deferred-with-reason).`
      : undefined;

  // EI-19380332459719944: a skip hiding inside an otherwise-green testsRun/testResult
  // summary ("8 passed | 1 skipped") reads as a pass and is exactly what let a real
  // near-miss reach a critical work-item's completion evidence unnoticed. Computed off
  // the SAME evidence extraction as everything else above (completionEvidenceForGate)
  // so it can never disagree with what the caller actually supplied.
  const skippedTestsMention = skippedTestsMentionedInEvidence(completionEvidenceForGate);
  const skippedTestsWarning =
    skippedTestsMention && !hasIntentionalTestNameFilterProof(completionEvidenceForGate)
      ? `completion for ${it.id} reports ${skippedTestsMention.count} test(s) SKIPPED in \`${skippedTestsMention.source}\` — a skip reads as part of a green summary ("N passed | M skipped") but the skipped assertion(s) never actually ran (EI-19380332459719944: this exact shape — "8 passed | 1 skipped" — read as a clean pass and nearly shipped a false verification on a critical item). If the skip PRE-DATES this change and is unrelated to what this completion verifies, no action needed. If it's a skip left over from unblocking the gate (yours or a peer's), un-skip it and re-run before trusting this as evidence that the skipped assertion(s) pass.`
      : undefined;

  // EI-19454554361062529: a test result is evidence about BEHAVIOUR and silent about
  // TYPES. Same evidence extraction as every other check above, so it can never
  // disagree with what the caller actually supplied.
  const typeEvidenceGap = typeEvidenceGapInCompletion(completionEvidenceForGate);
  const typecheckCommands = typeEvidenceGap ? await typecheckCommandsForFiles(typeEvidenceGap.tsFiles) : undefined;
  const typeEvidenceWarning = typeEvidenceGap
    ? `completion for ${it.id} rests on a TEST RUN (\`verifiedHow: '${completionEvidenceForGate?.verifiedHow}'\`) and ` +
      `changed ${typeEvidenceGap.tsFiles.length} TypeScript file(s), but cites no typecheck. Vitest transforms via ` +
      `esbuild and NEVER typechecks — a green suite is not weak evidence about types, it is SILENT about them, so a ` +
      `file can be fully green and fully broken at once. Measured 2026-08-03: a bug was correctly fixed and closed on ` +
      `"8 passed / 0 failed" while that same file carried 11 COMMITTED type errors that lint:tsc called "a standing red ` +
      `that WILL red the fleet" — nothing in the run could have shown it. If this close asserts the code COMPILES, run: ` +
      `${typecheckCommands}. If it only asserts BEHAVIOUR, ignore this.`
    : undefined;

  // P-007 (owner-visibility-provenance-2026-08-11): on the OWNER-VISIBILITY SURFACE a green
  // unit suite is close to zero evidence, because the fixture asserts the predicate against
  // text the AUTHOR invented — so code and fixture share the author's blind spot and the test
  // cannot surprise them. SOFT warning, not a hard reject: complete.ts records-and-warns by
  // contract (D-005/EI-24 above); the tier that genuinely REFUSES is setWorkItemState's
  // completion-integrity gate. Same evidence extraction as every check above, so it can never
  // disagree with what the caller actually supplied.
  const liveDriveGap = liveDriveAcceptanceGap(completionEvidenceForGate);
  const liveDriveEvidenceWarning = liveDriveGap ? liveDriveAcceptanceMessage(it.id, liveDriveGap) : undefined;

  // EI-20093150500083378: `filesChanged` is the one evidence field nothing challenged, and
  // it is the one most often written from memory rather than observation. Same evidence
  // extraction as every check above, so it can never disagree with what the caller supplied.
  // EI-20341749505351776: fleet work can be coordinated from the Papercusp harness while the
  // edited checkout is a registered sibling Hive (SideStage in the measured incident). Only pay
  // the registry lookup on the warning path; then re-evaluate the entire filesChanged set against
  // one candidate checkout root. Any registry failure preserves the original Papercusp verdict.
  const completionWorkspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
  const unresolvedPaths = initialUnresolvedPaths
    ? unresolvedPathsInCompletion(completionEvidenceForGate, {
        repoRoots: registeredRepoRoots ?? [],
      })
    : undefined;
  const unresolvedPathDetails = unresolvedPaths?.missing.map((m) => {
    const pathDescription = m.didYouMean ? `${m.path} (did you mean ${m.didYouMean}?)` : m.path;
    let workspaceQualifiedPath: string | undefined;
    try {
      workspaceQualifiedPath = workspaceQualifiedCompletionPathHint(m.path, completionWorkspaceId);
    } catch {
      /* fail-open: this is an advisory repair hint on an already-recorded completion */
    }
    return workspaceQualifiedPath
      ? `${pathDescription} (the exact file exists in an independent app checkout; use absolute path \`${workspaceQualifiedPath}\` when re-calling)`
      : pathDescription;
  });
  const unresolvedPathsWarning = unresolvedPaths
    ? `completion for ${it.id} names ${unresolvedPaths.missing.length} \`filesChanged\` path(s) that do NOT ` +
      `exist in the repo: ${unresolvedPathDetails?.join(', ')}. ` +
      `The completion is RECORDED and this changes nothing about it — but a completion record is what a later ` +
      `agent or audit trusts WITHOUT re-checking, so a path that cannot be resolved quietly degrades the durable ` +
      `record. Measured 2026-08-10: an agent filed 12 paths across two closes and 8 were fabricated — an ` +
      `\`agent-tools/\` segment and a \`__tests__/\` dir that this repo does not use — and both closes still ` +
      `landed authority:'committed'. The fabricated paths were MORE conventional than the real ones, which is ` +
      `exactly why review does not catch them. If you DELETED these files, or they live in a submodule that is ` +
      `not checked out, ignore this. For an out-of-tree deliverable, use its absolute path instead of a ` +
      `repo-relative alias; it is recorded as outOfRepoArtifact and excluded from Git identity checks, so ` +
      `external contents are not hashed. For repo-backed files, if \`filesChanged\` was a scalar/comma-separated ` +
      `string or any entry contains a prose annotation, re-call work_items:complete with an ARRAY of bare ` +
      `repo-relative paths, ` +
      `for example \`filesChanged: ["path/to/file.ts", "path/to/test.ts"]\`. Otherwise verify the paths on disk ` +
      `before re-calling. For a workspace-qualified \`.papercusp/apps/<app>/...\` entry with an absolute repair ` +
      `shown above, re-call with an ARRAY containing that absolute filesChanged path instead.`
    : undefined;

  // P-006 (frozen-candidate-compliance-enforcement-2026-08-30): this close asserts gate-red
  // progress, but names failing paths the JUDGED sha does not carry. Sibling of the check
  // above and warn-only for the same reason — the fix is real, it just landed above the
  // frozen candidate, so the gate cannot see it and the claim would enter the record as fact.
  const gateRedClaim = gateRedCompletionClaimWarning(completionEvidenceForGate);
  const gateRedClaimWarning = gateRedClaim ? `completion for ${it.id}: ${gateRedClaim.detail}` : undefined;

  // EI-20288629053504794: a positive path claim is not evidence that this item touched
  // the path. Surface target files whose last commit predates the item, but never block
  // or accuse when git history cannot be observed.
  const preExistingPaths = preExistingChangedPathsInCompletion(existing, it.completion);
  const preExistingPathsWarning = preExistingPaths
    ? 'completion for ' +
      it.id +
      ' positively claims work on target path(s) whose last commit predates this work-item: ' +
      preExistingPaths.paths
        .map(
          (entry) =>
            entry.path +
            ' (last committed ' +
            entry.lastCommitAt +
            '; item created ' +
            preExistingPaths.createdAt +
            ')',
        )
        .join(', ') +
      '. The completion is RECORDED and this advisory does not block the close, but verify that each named path was actually remediated by this item.'
    : undefined;

  // EI-20288629053504794: the item may prescribe its own recurrence guard or regression
  // test. A completion must point to that guard/test (or explicitly waive it with a
  // reason); this remains warn-only so the completion record is never lost.
  const prescribedGuardGap = prescribedRecurrenceGuardCoverageGap(existing, it.completion);
  const prescribedGuardWarning = prescribedGuardGap
    ? 'completion for ' +
      it.id +
      ' does not point to the recurrence guard/test obligation prescribed by the item: ' +
      prescribedGuardGap.prescriptions.join(' | ') +
      '. The completion is RECORDED and close is not blocked; cite the guard/test path or explicitly waive it with a reason.'
    : undefined;

  // EI-19455334047866968: the REF-shaped sibling of the path check above — a work-item id
  // cited in this completion's prose is never checked for existence, so a phantom reads
  // identically to a real one. Measured on this very surface: a completion said "Filed
  // separately as EI-19455206485565591" when the real filing was EI-19455262557905604.
  //
  // Scans EVERY prose field the caller actually wrote, off the raw record rather than the
  // gate evidence — `deferred` and `coordNotes` are NOT part of CompletionVerificationEvidence,
  // and scanning only the evidence would miss them. That is not hypothetical: the independently
  // filed EI-19411072468868467 measured this exact defect with the phantom id in `summary` AND
  // `deferred` ("wrote EI-19408968252646575, the real one was EI-19411045952024591"), and
  // prescribed precisely this warn-not-refuse remedy over `summary`/`deferred`/`coordNotes`.
  // `deferred` is the highest-risk field of all: it is where a completion cites the follow-up
  // item it just minted, which is the exact moment the id is written from a guess.
  //
  // Best-effort + fail-open: the completion is already recorded, so a check that cannot
  // answer stays silent rather than manufacturing an accusation.
  let unresolvedRefsWarningText: string | undefined;
  try {
    const refBody = completionRefBody(it.completion, completionEvidenceForGate);
    const unresolvedRefs = await unresolvedRefsInBody(refBody, { known: [it.id] });
    if (unresolvedRefs) unresolvedRefsWarningText = unresolvedRefsWarning(it.id, unresolvedRefs.missing);
  } catch {
    /* the completion already landed — never let an advisory fail it */
  }

  // P-004: the authority actually STAMPED on the row, or null when this call stamped
  // none (no terminal `state`, or the state write was rejected). Reporting the computed
  // judgement in either of those cases would tell the caller their close was graded when
  // no close happened — the same class of lie the deleted auto-fill told.
  //
  // EI-21574559473613348: report the PERSISTED authority, not the one this process
  // computed — they can disagree. Migration 972 installs a BEFORE trigger,
  // `harness_shared.downgrade_unproven_committed_close()`, that re-applies the
  // content-identity floor in SQL. That is deliberate: it holds the floor BELOW the
  // deploy boundary, so a frozen release build serving older code cannot mint stronger
  // authority than this source permits. When it fires it rewrites 'committed' to
  // 'proposed' and RAISEs a WARNING — which reaches the Postgres log and nobody else.
  //
  // Both write paths above re-read the row through the issue view AFTER the base write
  // (the same reason `finalState` reads from `workItem`), so the post-trigger truth is
  // already in hand here. Reporting the computed value instead told callers their close
  // landed 'committed' while the durable row said 'proposed'; agents then truthfully
  // relayed a false status, which is how this was found. Fall back to the computed value
  // only when the row carries none, so a writer that stamps no authority is unchanged.
  const { stampedAuthority, contentIdentityDowngrade } = reconcileStampedAuthority({
    stamped: !stateError && Boolean(finalState) && TERMINAL_WORK_ITEM_STATES.has(finalState),
    persisted: workItem?.completionAuthority ?? null,
    computed: completionAuthority,
    authorityByEvidence,
    declaredFilesCount:
      (completionEvidenceForGate?.filesChanged?.length ?? 0) + (completionEvidenceForGate?.filesDeleted?.length ?? 0),
    inProcessContentIdentityMissing: committedContentIdentityMissing,
  });
  // The change is worthless if it is silent. An agent whose close just landed `proposed`
  // must be TOLD, in the response to the call that did it, what it costs and what would
  // have avoided it — otherwise the first they learn of it is a leader asking why their
  // burn-down did not move. Names the two fields that flip it, because "supply evidence"
  // is exactly the vague instruction the old gate got away with.
  // The remedy is reason-specific on purpose. A close refused for `added-tests-without-path`
  // ALREADY carries verifiedHow + testsRun, so handing it the generic advice below would tell
  // it to re-send the exact fields it just sent — a refusal loop whose own instructions can
  // never clear it (EI-18685043434033870).
  // EI-21970667079827352: name the FACT, not only the rule. The old text described the
  // gate ("could not prove that every declared path...") and left the caller to discover
  // WHICH path and, far more importantly, whether waiting could ever settle it. The
  // per-path identities behind that verdict are already computed; this only surfaces them.
  const contentIdentityDetail = describeUnprovenContentIdentity(
    unprovenContentIdentityPaths(treeStamp),
    (completionEvidenceForGate?.filesChanged?.length ?? 0) + (completionEvidenceForGate?.filesDeleted?.length ?? 0),
  );
  const originAwareContentIdentityDetail = contentIdentityAdviceForOrigin(
    existing.origin,
    existing.createdBy,
    contentIdentityDetail,
  );
  const authorityWarning =
    stampedAuthority === 'proposed'
      ? `${it.id} is CLOSED but its completion landed authority:'proposed' — recorded and out of the ` +
        `claimable pool, but NOT counted toward burn-down, and it stays owned by you until it is settled. ` +
        (contentIdentityDowngrade
          ? originAwareContentIdentityDetail
            ? originAwareContentIdentityDetail
            : unresolvableContentIdentityPaths(treeStamp).length > 0
              ? // WI-42441: this is the SERVER's resolution failure, not the closer's tree
                // hygiene. The generic advice below is unfollowable here — re-running from a
                // perfectly committed tree reproduces it exactly — so say what actually
                // happened and do not send them to re-verify work that is already correct.
                `The server could NOT RESOLVE the committed content for ${unresolvableContentIdentityPaths(treeStamp)
                  .map((entry) => `\`${entry.path}\` (${entry.headBlobUnresolvable})`)
                  .join('; ')}. This is a resolution failure on the server side, NOT a problem with your tree: ` +
                `re-closing from a committed tree will reproduce it identically. Your other evidence was accepted. ` +
                `Settlement will upgrade this close automatically once the path resolves; if it persists, file it ` +
                `against the completion content-identity resolver rather than re-verifying.`
              : // No per-path identity was recorded at all, so there is no fact to name here.
                // Keep the rule-level text rather than inventing a per-path story we do not have.
                (contentIdentityDetail ??
                `The server could not prove that every declared \`filesChanged\` path has the same Git blob content in the working tree and committed HEAD. Missing, mismatched, or unavailable content identity never qualifies as \`committed\`; re-run verification from a committed tree and settle this close.`)
          : insufficientEvidenceReason(completionEvidenceForGate) === 'added-tests-without-path'
            ? `Its evidence says \`addedTests: true\` but names no file in \`filesChanged\`. Those cannot both ` +
              `be true: if this close added or changed tests, it changed at least one file, and a completion ` +
              `nobody can locate is the exact claim this gate exists to refuse. To settle it, re-call ` +
              `work_items:complete for this id with \`filesChanged\` listing the test file(s) you touched — ` +
              `real paths only, never a plausible-looking guess. If it did NOT add tests, pass ` +
              `\`addedTests: false\` instead; that is not a workaround, it is the accurate record.`
            : insufficientEvidenceReason(completionEvidenceForGate) === undefined && completionEvidenceFindings
              ? // The evidence fields are complete and a FINDING lowered the grade, so the generic
                // "supply verifiedHow plus testsRun" advice below would send the closer to re-send
                // fields it already sent. Name the finding; its own warning carries the repair.
                `Its evidence fields are complete; the grade was lowered by a finding ` +
                `(${insufficientEvidenceReason(completionEvidenceForGate, completionEvidenceFindings)}) whose ` +
                `repair is in this reply's matching \`*Warning\` field. Fix that, not verifiedHow/testsRun.`
            : `\`committed\` requires \`verifiedHow\` ('unit'|'integration'|'live-drove-ui'|'manual'|'already-passing') ` +
              `PLUS at least one of \`testsRun\` / \`testResult\`. \`filesChanged\` and \`addedTests\` do NOT qualify — ` +
              `both say what changed, neither says anything was checked. To settle it, re-call ` +
              `work_items:complete for this id with those fields filled; if the work genuinely cannot be verified, ` +
              `say so in \`deferred\` and leave it proposed.`)
      : undefined;

  // Fill provenance defaults so the rendered notification is complete (D-006).
  const completion = {
    ...it.completion,
    workItem: it.completion.workItem || it.id,
    agent: it.completion.agent || ident.ownerLabel || ident.ownerId,
    planSlug: it.completion.planSlug,
  };

  // P-020 (su-ideate-learning-substrate): checkpoint-HARVEST. A completion's
  // `coordNotes` — the design-note residual the structured fields can't hold — is
  // the insight-bearing free-text agents ALREADY write at this boundary; auto-file
  // it as a lane:observation with ZERO new workflow (D-016/D-017). Fire-and-forget +
  // fully fail-open: harvest must NEVER affect the completion (EI-24 record-and-warn
  // discipline). The leg coalesces a repeated note against the agent's own recent harvest.
  const harvestNote = it.completion.coordNotes;
  if (harvestNote && harvestNote.trim()) {
    const ownerId = ident.ownerId;
    const harvestHarness = it.harness && it.harness !== '*' ? it.harness : undefined;
    void (async () => {
      try {
        const filedByRole = (await getPresence(ownerId).catch(() => null))?.agentRole ?? undefined;
        const { harvestInsight } = await import('../../harness/improvements/checkpoint-harvest');
        await harvestInsight({
          insight: harvestNote,
          createdBy: ownerId,
          source: 'work-item-completion',
          ref: `wi:${it.id}`,
          ...(filedByRole ? { filedByRole } : {}),
          ...(harvestHarness ? { harness: harvestHarness, sourceHive: harvestHarness } : {}),
        });
      } catch {
        /* fail-open: harvest never affects the completion the agent recorded */
      }
    })();
  }

  // EI-8993 (dup-close accountability): a completion that names `duplicateOf`
  // auto-creates the structured `duplicates` coord_links edge (so dup-scanners
  // and future readers see the graph, not just free-text prose) and
  // auto-subscribes the item's PRIOR assignee (the WI-3646 gap — a leader who
  // force-reopened + re-claimed it wasn't watching, so the wrong dup-close
  // reached no one who could catch it) so the existing per-completion watcher
  // fan-out (the `emits` block below, `@object:<kind>:<ref>`) reaches them even
  // if they never explicitly subscribed. Best-effort + record-and-warn (EI-24,
  // same discipline as every other check in this file) — a bad/missing target
  // must never lose an otherwise-good completion.
  let duplicateOfWarning: string | undefined;
  const duplicateOf = it.completion.duplicateOf;
  if (duplicateOf) {
    if (duplicateOf === it.id) {
      duplicateOfWarning = `completion.duplicateOf ('${duplicateOf}') is the same id as the item being closed — ignored; a duplicate must name a DIFFERENT surviving item.`;
    } else {
      const dst = await resolveWorkItemRef(duplicateOf, it.harness).catch(() => null);
      if (!dst) {
        duplicateOfWarning = `completion.duplicateOf ('${duplicateOf}') was not found — no \`duplicates\` link was created. Double-check the surviving id.`;
      } else {
        const linkRes = await linkWorkItem(it.id, dst, 'duplicates', { harness: it.harness, by: ident.ownerId }).catch(
          (e) => ({ error: e instanceof Error ? e.message : String(e) }),
        );
        if ('error' in linkRes)
          duplicateOfWarning = `failed to record the \`duplicates\` link to '${duplicateOf}': ${linkRes.error}`;
      }
    }
  } else if (mentionsWorkItemDuplicate(`${it.completion.summary} ${it.completion.status ?? ''}`)) {
    // The exact free-text pattern that let WI-3646 get dup-closed 3× with no structured
    // trace ("dup of WI-3543" in prose, nothing a scanner could follow). Nudge toward the
    // structured field without blocking.
    duplicateOfWarning = `this completion's summary/status names another work-item as a duplicate but \`completion.duplicateOf\` was not set — pass the SURVIVING item's id there so a \`duplicates\` link + assignee notification are recorded, not just free text.`;
  }
  if (duplicateOf && duplicateOf !== it.id && existing.assignee && !callerOwnsAssignee) {
    await subscribeWorkItem(existing.assignee, it.id, 'full', { harness: it.harness }).catch(() => {});
  }

  // EI-7214: persist outputPayload onto the item row (payload.out) so it's a
  // self-serve, queryable read surface for a harness sidecar pulling completed
  // outputs over HTTP — not just a transient field on this call's own result /
  // the emitted reaction event. Best-effort (mergeWorkItemOutputPayload never
  // throws): a payload-persist failure must never turn an already-recorded
  // completion into a failed one.
  if (it.outputPayload !== undefined) {
    await mergeWorkItemOutputPayload(it.id, it.outputPayload, { harness: it.harness });
  }

  // Reflect-and-capture STEP at the completion boundary (self-learning-central P-001/B).
  const reflect = renderReflectStep({ harnessActive: Boolean(workItem?.harness) });

  // WI-4529 — `ok` MUST reflect the state transition the caller asked for, not merely that the
  // completion record got written.
  //
  // THE BUG: a `state` that did not land (held-open refusal, completion-integrity gate, or an
  // alias that silently downgraded a terminal request to a NON-terminal state — e.g. issue-family
  // 'done' → 'open') still returned ok:true, with the real failure buried in a sibling `stateError`
  // / `stateWarning` STRING. Every caller checks `ok` — so every caller read it as success and
  // walked away leaving the item OPEN and re-claimable, believing it closed. That is precisely the
  // silent-success class (a write that reports success while doing half the thing).
  //
  // EI-24 IS PRESERVED — this does NOT hard-reject or drop anything. The completion record is
  // still built, still returned on the result, and still BROADCAST: the `emits` rule keys on
  // `result.completion`, which is present on the ok:false result too (BulkItemResult carries an
  // index signature). A failed state write still never loses the completion. We only stop lying
  // about whether the item actually closed.
  //
  // Scoped deliberately, in TWO cases — and NOT a blanket "state didn't land terminal":
  //   (1) the state write THREW (stateError) — the caller asked for a transition and got none.
  //       This is the reported bug (a peer's HOLD-OPEN refusal came back ok:true, item still open).
  //   (2) the caller used a CLOSE-INTENT state but the item did not land terminal — the
  //       issue-family alias trap (`state:'done'` silently lands as 'open').
  // A deliberate `recordOnly:true` call or non-terminal park (`needs_human`,
  // `blocked`) stays ok:true. An omitted state without that explicit intent is
  // ambiguous and must not report success while leaving the item open.
  const landedState = workItem?.state ?? existing.state;
  const closeLanded = TERMINAL_WORK_ITEM_STATES.has(finalState);
  const closeIntended = Boolean(effectiveState) && CLOSE_INTENT_STATES.has(String(effectiveState).trim().toLowerCase());
  const stateWriteFailed = Boolean(effectiveState) && Boolean(stateError);
  const closeFailed = closeIntended && !closeLanded && !stateError;
  // EI-24375004625460447: `assumptions` is required only for a terminal close.
  // When a caller supplies it but omits `state`, the completion record may land
  // while the item remains open. That is a failed close intent, not a successful
  // record-only call. Preserve the record and make the missing transition loud.
  const ambiguousOmittedState = !effectiveState && !it.recordOnly && !closeLanded;
  const stateNotApplied = stateWriteFailed || closeFailed || ambiguousOmittedState;
  const stateFailure = !stateNotApplied
    ? undefined
    : stateError
      ? `COMPLETION RECORDED, BUT ${it.id} DID NOT CLOSE — it is still '${landedState}' and ${claimabilityHint}. The state write failed: ${stateError}`
      : ambiguousOmittedState
        ? `COMPLETION RECORDED, BUT ${it.id} DID NOT CLOSE — no top-level state was passed and recordOnly:true was not requested; the item is still '${landedState}'. Re-call the SAME completion with a terminal state (issue: 'resolved'|'closed'; feature: 'passed'|'deprecated'), or pass recordOnly:true for a deliberate progress record.`
      : `COMPLETION RECORDED, BUT ${it.id} DID NOT CLOSE — you requested state '${requestedState ?? effectiveState}' and it applied as '${appliedState ?? landedState}'${aliasNote ? ` (${aliasNote})` : ''}, which is NOT terminal, so the item stays claimable and the auto-loop may re-place work on it. Pass a TERMINAL state (issue: 'resolved'|'closed'; feature: 'passed'|'deprecated').`;

  const finish = closeLanded
    ? await synchronizeFinishWork({
        id: it.id,
        workItem: workItem as unknown as Record<string, unknown>,
        completionEvidenceStored: true,
        completionAuthorityBefore: existing.completionAuthority ?? null,
        completionAuthorityAfter: workItem?.completionAuthority ?? completionAuthority ?? null,
        ctx,
      })
    : undefined;
  const finishFailed = Boolean(finish && !finish.complete);
  const finishFailure = finishFailed
    ? `COMPLETION RECORDED AND ITEM CLOSED, BUT FINISH DID NOT FULLY CONVERGE — ${finish!.errors?.join('; ') ?? 'a finish leg failed'}. Re-call the SAME completion; finish legs are retry-safe and resume the missing legs.`
    : undefined;

  // EI-22701142802555885: a successor/boundary note is intentionally a THREAD post,
  // not a terminal checkpoint write. Post it only after the close and every finish leg
  // converge, so it cannot be stranded behind checkpoint cleanup or cause a terminal
  // lifecycle re-assertion. A comment failure is reported independently: the terminal
  // close remains successful and callers must not retry the close just to recover a note.
  let boundaryNotePosted = false;
  let boundaryNoteError: string | undefined;
  const boundaryNoteEligible =
    Boolean(it.boundaryNote) && Boolean(effectiveState) && closeLanded && !stateError && finish?.complete;
  if (boundaryNoteEligible) {
    try {
      const post = await commentWorkItem(it.id, it.boundaryNote!, ident.ownerId, {
        workspaceId: ctx.workspaceId,
        harness: it.harness ?? existing.harness ?? undefined,
      });
      if (post) boundaryNotePosted = true;
      else boundaryNoteError = `boundaryNote for ${it.id} could not be persisted: work-item comment returned no post`;
    } catch (error) {
      boundaryNoteError =
        `boundaryNote for ${it.id} could not be persisted after the terminal close: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  // EI-19312103118112942: a fleet drain member's confirmed failure mode is treating
  // *completing* an item as the end of the wake instead of its midpoint — it closes
  // the item, holds nothing, and settles, even though its own claim spec still has
  // hundreds of claimable rows (measured: half of a 10-member fleet idle simultaneously
  // against 436 claimable). Fire this INLINE on every real close for a fleet member —
  // no extra query needed: `deriveFleetMembership()` is a pure env read
  // (PAPERCUSP_FLEET_SLUG), and a fleet member always drains one item at a time, so
  // "just closed" reliably means "likely holds nothing else right now". False positives
  // (the rare member juggling >1 claim) cost nothing — scheduler:get_next is a cheap,
  // idempotent no-op when the caller already holds enough work.
  // The same resolved membership drives BOTH the caller nudge and the intrinsic
  // completion emit's fleet-leader audience. Keeping one value on the result means
  // the pure emits renderer never has to re-derive mutable coordination state, and
  // a successful completion becomes the fleet report instead of requiring a second
  // hand-authored coord:send (EI-20194762143976862).
  const completionFleetSlug = closeLanded && !stateError && !finishFailed ? deriveFleetMembership().fleetSlug : null;
  const fleetRepullNudge =
    completionFleetSlug != null
      ? `${it.id} is CLOSED. If you hold no other claim right now, do NOT settle — call scheduler:get_next immediately to pull the next unit before ending this turn (EI-19312103118112942: completing is the midpoint of a wake, not the end).`
      : undefined;

  // EI-15982: every LOUD signal (anything the caller must not miss — a hard failure
  // OR a soft "recorded but not closed"/"evidence dropped"/etc warning) is placed
  // BEFORE the bulky echoed data (`workItem`, `completion`, `reflect`, `finish`).
  // The per-result context door (result-door.ts) truncates an oversized tool
  // result's serialized text FROM THE FRONT of the budget — i.e. it keeps a
  // PREFIX of the JSON and cuts the tail — so a warning key that serializes
  // AFTER the two large echoed objects is exactly the content most likely to be
  // silently sliced off (the reported failure: `stateWarning` on a completion
  // whose `workItem`+`completion` echo alone pushed the response past the
  // ~1500-token door, so the one field telling the caller "this did NOT close"
  // never reached them). Warnings are cheap (short strings); ordering them first
  // costs nothing and makes them survive truncation whenever ANYTHING fits.
  return {
    ok: !stateNotApplied && !finishFailed,
    id: it.id,
    ...(stateFailure || finishFailure ? { error: stateFailure ?? finishFailure } : {}),
    ...(stateError ? { stateError } : {}),
    ...(boundaryNoteEligible ? { boundaryNotePosted, ...(boundaryNoteError ? { boundaryNoteError } : {}) } : {}),
    ...(stateWarning ? { stateWarning } : {}),
    ...(planGateParkWarning ? { planGateParkWarning } : {}),
    // EI-18850142725126359 fix #4 — reported ONLY when the close actually LANDED.
    // The text is written in the future tense ("will red the next checkpoint"),
    // which is true of a terminal row and false of a close that was rejected — and
    // a fleet-gate alarm that cries wolf on a no-op close is exactly how this
    // channel would earn the skim it must not get. Ordered with the other LOUD
    // signals, ahead of the bulky echo, for the EI-15982 reason above.
    ...(planeRatchetWarning && closeLanded && !stateError ? { planeRatchetWarning } : {}),
    ...(assumptionKindWarning && closeLanded && !stateError ? { assumptionKindWarning } : {}),
    ...(nulBytesStripped
      ? {
          nulBytesStrippedWarning: `completion for ${it.id} contained one or more raw NUL bytes (invisible in most editors/terminals — renders as nothing or a plain space) — they were silently removed before recording, because Postgres cannot store a NUL in a text/jsonb column ("unsupported Unicode escape sequence") and an unremoved one would have failed the state write while leaving the completion recorded (EI-18764241942332131). If the NUL was meaningful (e.g. you were quoting a literal NUL byte as evidence), describe it in prose instead (e.g. "a raw NUL / 0x00 byte") rather than embedding the literal character.`,
        }
      : {}),
    ...(aliased !== undefined ? { aliased, requestedState, appliedState } : {}),
    ...(aliasNote ? { aliasNote } : {}),
    ...(inferredCloseState
      ? {
          stateInferredFromCompletionStatus: `no top-level \`state\` was passed, but completion.status ('${inferredCloseState}') is this issue's own terminal vocabulary — inferred state:'${inferredCloseState}' and closed it (EI-12027). Pass top-level \`state\` explicitly to avoid relying on this inference.`,
        }
      : {}),
    // EI-18736669939338784 — ordered with the other LOUD signals, ahead of the bulky echoed
    // data, for the reason documented above: the result door truncates from the tail, and
    // this is precisely the field a caller must not lose. `completionEvidenceStored` stays
    // true and is NOT repurposed to report this: the evidence WAS durably recorded (as an
    // attestation), and that flag feeds `finish.complete`, whose `false` means "re-call the
    // same completion to converge" — advice that cannot help here and would send the caller
    // into a retry loop against a guard that will make the same decision every time.
    ...(terminalConflict
      ? {
          terminalConflictWarning:
            terminalConflict.outcome === 'attested'
              ? `COMPLETION RECORDED AS A SECOND ATTESTATION, NOT AS THIS ITEM'S RECORD — ${terminalConflict.note}`
              : `YOUR COMPLETION REPLACED AN EARLIER, THINNER ONE — ${terminalConflict.note}`,
          terminalConflict,
        }
      : {}),
    ...(authorityWarning ? { authorityWarning } : {}),
    ...(verificationWarning ? { verificationWarning } : {}),
    ...(skippedTestsWarning ? { skippedTestsWarning } : {}),
    ...(typeEvidenceWarning ? { typeEvidenceWarning } : {}),
    ...(liveDriveEvidenceWarning ? { liveDriveEvidenceWarning } : {}),
    ...(unresolvedPathsWarning ? { unresolvedPathsWarning } : {}),
    ...(fabricatedPathsWarning ? { fabricatedPathsWarning } : {}),
    ...(untouchedPathsWarning ? { untouchedPathsWarning } : {}),
    ...(testRunContradictionWarning ? { testRunContradictionWarning } : {}),
    ...(requirementShortfallWarning ? { requirementShortfallWarning } : {}),
    ...(claimsFalsifiedWarning ? { claimsFalsifiedWarning } : {}),
    ...(residueUnownedWarning ? { residueUnownedWarning } : {}),
    ...(terminalCriteriaWarning ? { terminalCriteriaWarning } : {}),
    // The full per-claim verdict set, including the ones that HELD and the ones that could
    // not be decided — returned even when nothing was falsified, so a closer can see that
    // their claims were actually evaluated rather than silently skipped. A check whose
    // success is invisible is one nobody trusts.
    ...(claimVerdicts
      ? {
          claimVerdicts: {
            held: claimVerdicts.held,
            falsified: claimVerdicts.falsified,
            unevaluatable: claimVerdicts.unevaluatable,
            results: claimVerdicts.results.map((r) => ({ verdict: r.verdict, reason: r.reason })),
          },
        }
      : {}),
    ...(gateRedClaimWarning
      ? {
          gateRedClaimWarning,
          gateRedClaimUncontainedPaths: gateRedClaim?.uncontainedPaths,
          gateRedClaimJudgedSha: gateRedClaim?.judgedSha,
        }
      : {}),
    ...(preExistingPathsWarning ? { preExistingPathsWarning } : {}),
    ...(prescribedGuardWarning ? { prescribedGuardWarning } : {}),
    ...(unresolvedRefsWarningText ? { unresolvedRefsWarning: unresolvedRefsWarningText } : {}),
    ...(ephemeralDeliverableWarning ? { ephemeralDeliverableWarning } : {}),
    ...(assigneeMismatchWarning ? { assigneeMismatchWarning } : {}),
    ...(harnessMismatchWarning ? { harnessMismatchWarning } : {}),
    // Reported unconditionally on a real close (including `committed`) so the caller can
    // see the judgement rather than infer it from the absence of a warning.
    ...(stampedAuthority
      ? {
          completionAuthority: stampedAuthority,
          countsTowardBurnDown: countsTowardBurnDown(stampedAuthority, true, isAbandonedClose),
        }
      : {}),
    ...(completionFleetSlug ? { fleetSlug: completionFleetSlug } : {}),
    ...(duplicateOfWarning ? { duplicateOfWarning } : {}),
    completionContractVersion: WORK_ITEMS_COMPLETION_CONTRACT.version,
    ...(fleetRepullNudge ? { fleetRepullNudge } : {}),
    workItem,
    completion,
    reflect,
    ...(it.outputPayload !== undefined ? { outputPayload: it.outputPayload } : {}),
    ...(specAdequacyChecked || specAdequacyImpactReport
      ? {
          specAdequacy: {
            applicable: Boolean(specAdequacyChecked),
            checked: specAdequacyChecked ?? [],
            ...(specAdequacyImpactReport ? { impactReport: specAdequacyImpactReport } : {}),
          },
        }
      : {}),
    // P-007: the design-evidence obligation. Present on a satisfied close too —
    // a report nobody receives is indistinguishable from no report, and during
    // the D-006 report-only rollout this string IS the entire mechanism.
    ...(designEvidenceReport ? { designEvidence: designEvidenceReport } : {}),
    ...(finish ? { finish } : {}),
  };
}

// Named so the args preprocess can reach its own inner schema at parse time (RSR-P-008-A).
const workItemsCompleteTool = defineTool({
  name: 'work_items:complete',
  profile: 'engineer',
  description:
    'Complete work-items with evidence. For terminal closes use `passed`/`deprecated` (feature/chunk) or `resolved`/`closed` (issue); `done`/`dropped` aliases are accepted. `closed`/`deprecated` discard work. Pass terminal `state` plus `assumptions` (`"none"` or fact keys); deliberate record-only calls pass `recordOnly:true`. Check `finish.complete`/`stateWarning`.',
  guidance: {
    when: 'After verification, pass `completion`, terminal `state` (`passed`/`deprecated` for feature/chunk; `resolved`/`closed` for issue; `done`/`dropped` aliases), and required `assumptions` (`\"none\"` or fact keys). Use discard states only for discard/wontfix. `specAdequacy`/`outputPayload` are top-level siblings of `completion` (nested placement is auto-hoisted); read `outputPayload` back at `work_items:get` → `results[].workItem.payload.out` with `payloadTier:"full"`, not inside `completion`. Universal claims require `completion.verification.coverage` to partition each entry exactly once across checked/notChecked/notApplicable; residue is separate (`[]` or `["none"]` means zero). Keep `deferred`/`coordNotes` outside verification; put test/typecheck/diff details in top-level aliases; use `filesDeleted` for removals, not `filesChanged`; use `completion.duplicateOf` for duplicates.',
    notWhen: 'Use coord:send for notes; use work_items:set_state only with completion evidence; do not summarize.',
    chaining:
      'work_items:claim → work_items:complete { id, state, assumptions, completion }; `finish.complete:true` confirms convergence and emits.',
    seeAlso: [
      COMPLETION_SETTLEMENT_MANIFEST_CONTRACT,
      'work_items:set_state (change state without recording a completion)',
      'coord:send (a note/question that is not a completion)',
      'improvements:capture (file the friction the reflect step surfaced)',
      `Finish is idempotent: after a timeout, re-check with work_items:get or retry the same completion. ${TERMINAL_CLOSE_RECOVERY_HINT}`,
      'For batches, top-level ok is FALSE if any item failed (it is derived from results[].ok); inspect counts.failed and each result to see which.',
    ],
  },
  capability: 'work_items:write',
  // Idempotent-completion (backend-reliability-100pct-2026-07-03 W6/P-007; EI-11507): a completion
  // whose wall-clock beat the 55s transport deadline under load STILL COMMITTED — the handler ran
  // to completion, and every finish leg is documented-idempotent (synchronizeFinishWork: terminal
  // state re-apply, plan-status flip, claim release, checkpoint clear are all no-ops on re-apply;
  // see the seeAlso "a blind retry of the SAME items+state is safe"). Surfacing the TRUTHFUL success
  // instead of a spurious `timeout` stops the mandatory *:get verify-read + partial-batch
  // reconciliation the reporter hit every time (EI-11507). Same opt-in already shipped for
  // plans:set-status. Inert except in the dispatch abort-race branch (dispatch-stack.ts).
  idempotent: true,
  requirePrincipal: false,
  timeoutSec: WORK_ITEMS_COMPLETE_TIMEOUT_SEC,
  // EI-20194230704550984: completion owns its workspace-scoped reads/writes and
  // does not use ctx.tx. Keeping the dispatcher's ambient transaction open while
  // the completion ledger and finish legs await can exhaust the org-app pool and
  // strand an otherwise verified completion behind the 45s acquisition deadline.
  skipWorkspaceTx: true,
  agentRoles: [...WORK_ITEM_LIFECYCLE_ROLES],
  // INTRINSIC emission (D-002/D-004): a completion always auto-broadcasts its
  // structured record as a coord notification. The desugar registers this as an
  // event-reaction rule (`emits:work_items:complete#completion`); the render
  // stays PURE — the engine owns dispatch/durability/loop-protection. With the
  // bulk envelope it fires PER completed item via the D-007 event-layer fan-out.
  emits: [
    {
      fire: 'coord:emit',
      // Only when the handler returned a real completion record (i.e. the item
      // existed). A not-found returns { ok:false } with no completion. The D-007
      // fan-out hands this rule one per-item event whose result.data IS the item.
      when: (e) => Boolean((e.result?.data as { completion?: unknown } | undefined)?.completion),
      render: (e) => {
        const data = e.result.data as {
          completion: CompletionRecord;
          workItem?: { family?: 'feature' | 'issue'; harness?: string | null; id?: string };
          fleetSlug?: string | null;
        };
        const rec = data.completion;
        const { summary, body } = renderCompletion(rec);
        // Scope to watchers (coord-emit-subscription-scoping-2026-06-05): the
        // completing member's CURRENT fleet leader, peers on the completed item's
        // plan, and the item's own object subscribers. The leader selector is the
        // missing member-reporting seam: work_items:complete already renders the
        // whole structured record, so a second manual coord:send is duplication.
        const to: string[] = [];
        if (data.fleetSlug) to.push(`@fleet-leader:${data.fleetSlug}`);
        if (rec.planSlug) to.push(`@plan:${rec.planSlug}`);
        const wi = data.workItem;
        if (wi?.family && wi.id) {
          to.push(objectSelector(workItemObjectRef({ family: wi.family, harness: wi.harness ?? null, id: wi.id })));
        }
        return {
          category: 'completion',
          summary,
          ...(body ? { body } : {}),
          ...(rec.planSlug ? { plan_slug: rec.planSlug } : {}),
          to,
        };
      },
    },
  ],
  // EI-7031: rescue a FLAT single-complete (completion fields passed directly on
  // args, no `completion` wrapper — the 22× "pass { id, completion } …" reject) by
  // gathering them into `completion` BEFORE the object parse strips unknown keys.
  // A well-formed { id, completion } / items:[…] call is returned unchanged.
  //
  // P-017 (b) / EI-20224758239853458: keep the single and bulk envelopes as
  // separate schema branches. The old shared object made `assumptions` optional
  // in the published JSON schema so the bulk form could omit the top-level field,
  // even though the single-item runtime refine required it. The union exposes the
  // requirement structurally while retaining per-item assumptions for bulk calls.
  //
  // ⚠ "Structurally" means PER-BRANCH DOCUMENTATION, not a JSON-Schema `required`
  // entry. `assumptions` is deliberately `.optional()` in BOTH branches and must
  // stay that way: it is required only for a TERMINAL CLOSE, while a D-004
  // record-only completion must be able to omit it. That conditionality is not
  // expressible here, so it is carried by each branch's `assumptions` description
  // and ENFORCED at handler time by the close-intent gate (`closeIntentRequested`
  // → ASSUMPTIONS_REQUIRED_MESSAGE), which refuses before any state is written.
  //
  // Do NOT "fix" this by making `assumptions` unconditionally required — that
  // breaks every record-only completion fleet-wide. Reading the bare `.optional()`
  // as a missing requirement is a documented misread (EI-21326741744953358,
  // EI-21352286372840963 filed exactly that, twelve days after this branch landed).
  // The intended contract is pinned by 'conditional assumptions gate (D-004
  // record-only vs terminal close)' and 'published JSON schema (tools/list
  // projection) preserves conditional assumptions' in complete.test.ts.
  // EI-19486111655110215: the conditional gate documented directly above is enforced at
  // HANDLER time, one phase after the schema. So a call that is BOTH schema-invalid and
  // missing `assumptions` was refused twice — once per phase — and the second refusal
  // reads like "my completion object is still malformed", because that is what a silent
  // coercion looks like. This does not move the gate (see the ⚠ above: it must stay
  // conditional); it only lets the FIRST refusal also name what the second one will say.
  //
  // Pure and total by contract — it sees raw, unvalidated input of any shape.
  argPreconditions: (rawInput: unknown): readonly string[] => {
    if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) return [];
    const root = rawInput as Record<string, unknown>;
    const hasCloseIntent = (entry: Record<string, unknown>, fallbackState: unknown): boolean => {
      const state = entry.state ?? fallbackState;
      if (typeof state === 'string' && CLOSE_INTENT_STATES.has(state.trim().toLowerCase())) return true;
      // Mirrors the handler's `inferredCloseState`: an issue-family close can be carried by
      // completion.status alone. Family is unknowable from raw input, so this over-includes
      // rather than under-warns — the cost of a spurious line is one sentence, the cost of a
      // missing one is the round-trip this whole hook exists to remove.
      const completion = entry.completion;
      if (!completion || typeof completion !== 'object' || Array.isArray(completion)) return false;
      const status = (completion as Record<string, unknown>).status;
      return typeof status === 'string' && CLOSE_INTENT_STATES.has(status.trim().toLowerCase());
    };
    const entries: Record<string, unknown>[] = Array.isArray(root.items)
      ? root.items.filter(
          (it): it is Record<string, unknown> => Boolean(it) && typeof it === 'object' && !Array.isArray(it),
        )
      : [root];
    const needsAssumptions = entries.some(
      (entry) => hasCloseIntent(entry, root.state) && (entry.assumptions ?? root.assumptions) === undefined,
    );
    // See SERVER_STAMPED_TREE_STAMP_MESSAGE: fires on PRESENCE, never on shape. A caller who
    // sends a well-formed 40-hex stamp is silently overwritten rather than refused, so the
    // presence itself is the misunderstanding worth naming — waiting for a pattern failure
    // would say nothing to the caller whose stamp happens to parse.
    const sendsTreeStamp = entries.some((entry) => {
      const completion = entry.completion ?? root.completion;
      if (!completion || typeof completion !== 'object' || Array.isArray(completion)) return false;
      const fields = completion as Record<string, unknown>;
      if (fields.treeStamp !== undefined) return true;
      const verification = fields.verification;
      if (!verification || typeof verification !== 'object' || Array.isArray(verification)) return false;
      return (verification as Record<string, unknown>).treeStamp !== undefined;
    });
    const sendsSettlementManifest = entries.some((entry) => {
      const completion = entry.completion ?? root.completion;
      if (!completion || typeof completion !== 'object' || Array.isArray(completion)) return false;
      const fields = completion as Record<string, unknown>;
      if (fields.settlementManifest !== undefined) return true;
      const verification = fields.verification;
      if (!verification || typeof verification !== 'object' || Array.isArray(verification)) return false;
      return (verification as Record<string, unknown>).settlementManifest !== undefined;
    });
    return [
      ...(needsAssumptions ? [ASSUMPTIONS_REQUIRED_MESSAGE] : []),
      ...(sendsTreeStamp ? [SERVER_STAMPED_TREE_STAMP_MESSAGE] : []),
      ...(sendsSettlementManifest ? [SERVER_STAMPED_SETTLEMENT_MANIFEST_MESSAGE] : []),
    ];
  },
  args: z.preprocess(
    (raw, ctx) => {
      const preflight: PreflightIssue[] = [];
      reportRootCauseVerificationInputShape(raw, (issue) => preflight.push(issue));
      const hoisted = hoistMisplacedCompletionFields(raw);
      const gathered = gatherFlatCompletion(hoisted);
      reportMalformedCompletionCoverage(gathered, (issue) => preflight.push(issue));
      for (const issue of preflight) ctx.addIssue(issue);
      if (preflight.length > 0) {
        // RSR-P-008-A: this preprocess's issues abort the stage below, so report
        // that stage's OTHER issues now (see issuesNotCoveredByPreflight).
        const rest = (workItemsCompleteTool.args as unknown as { out: z.ZodType }).out.safeParse(gathered);
        if (!rest.success) {
          for (const issue of issuesNotCoveredByPreflight(rest.error.issues, preflight)) ctx.addIssue(issue as never);
        }
      }
      return gathered;
    },
    z.union(
      [
        z
          .object({
            id: z
              .string()
              .min(1)
              .optional()
              .describe('single-complete shorthand: the work-item id (use with `completion`)'),
            harness: z.string().max(80).optional().describe('default harness for the inline id / items that omit one'),
            /** Optional terminal state to also set. */
            state: z
              .string()
              .min(1)
              .max(40)
              .optional()
            .describe(
                "Terminal intent: feature/chunk uses 'passed'|'deprecated' and issue uses 'resolved'|'closed'; unified 'done'|'dropped' aliases are also accepted. 'dropped'/'closed'/'deprecated' mean discard or wontfix; never use them for successful work.",
              ),
            recordOnly: z.boolean().optional().describe('Explicitly record and emit without changing lifecycle state.'),
            /** Optional successor/boundary note for a successful terminal finish. */
            boundaryNote: z
              .string()
              .min(1)
              .max(2000)
              .optional()
              .describe(
                'Optional successor/boundary note to append after a terminal close and finish cleanup; ignored for record-only or non-terminal results.',
              ),
            /** The structured completion record (single-complete shorthand). */
            completion: completionSpec.optional(),
            /** Optional kind-specific structured output (single-complete shorthand). */
            outputPayload: z.unknown().optional(),
            /** Current per-clause proof attestation for spec-covered terminal closes. */
            specAdequacy: specAdequacyCompletionField,
            /** Read-only preflight: evaluate every applicable completion requirement without writing. */
            validateOnly: z.boolean().optional(),
            /** Required only when this single item requests a terminal close. */
            assumptions: z
              .preprocess(normalizePersistedAssumptionDeclaration, assumptionsArg.optional())
              .describe('Required for a terminal close; omit for record-only completions. Pass "none" or fact keys.'),
            // Keep the union's handler type uniform while ensuring a bulk payload
            // cannot accidentally parse through this branch and have `items` stripped.
            items: z.never().optional(),
          })
          .strict()
          .refine((a) => Boolean(a.id) && Boolean(a.completion), {
            // EI-6999: the first shape error a caller hits should state the FULL
            // minimal shape needed to actually CLOSE an item, not just "you're
            // missing `completion`" — a caller who fixes that alone still hits a
            // SECOND round-trip discovering `completion.summary` is required, then
            // a THIRD discovering `completion` alone never changes lifecycle state
            // (a bare `completion` records the note but leaves the item claimable
            // — pass `state` too to actually close it). Say all of it up front.
            message: COMPLETE_CLOSE_SHAPE_MESSAGE,
          }),
        z
          .object({
            id: z.string().min(1).optional(),
            harness: z.string().max(80).optional().describe('default harness for the inline id / items that omit one'),
            /** Optional terminal state to apply to items that omit their own. */
            state: z
              .string()
              .min(1)
              .max(40)
              .optional()
            .describe(
                "Default terminal intent for items that omit one. Feature/chunk success: 'passed'; issue success: 'resolved'. Legacy discard/wontfix: 'deprecated' or 'closed'; unified aliases 'done'|'dropped' are also accepted.",
              ),
            recordOnly: z.boolean().optional().describe('Default record-only intent for items that omit their own state.'),
            /** Optional default successor/boundary note for items that omit their own. */
            boundaryNote: z
              .string()
              .min(1)
              .max(2000)
              .optional()
              .describe(
                "Default successor/boundary note for items that omit one; posted only after that item's terminal finish cleanup converges.",
              ),
            /** Optional single-item fields are retained for backwards-compatible bulk envelopes. */
            completion: completionSpec.optional(),
            outputPayload: z.unknown().optional(),
            /** Read-only preflight for every item in this envelope unless an item overrides it. */
            validateOnly: z.boolean().optional(),
            assumptions: z
              .preprocess(normalizePersistedAssumptionDeclaration, assumptionsArg.optional())
              .describe('Required for a terminal close; omit for record-only completions. Pass "none" or fact keys.'),
            items: z
              .array(itemSpec)
              .min(1)
              .max(100)
              .describe(
                'complete many work-items at once — each { id, completion, assumptions, state?, harness? }; ' +
                  'an omitted per-item state/harness falls back to the top-level one',
              ),
          })
          .strict(),
      ],
      {
        error: (issue) => ({
          message:
            firstCompletionCoverageContract(issue) ??
            firstCompletionStringRejection(issue) ??
            firstRootCauseVerificationInputError(issue) ??
            firstUnrecognizedKeyMessage(issue) ??
            COMPLETE_CLOSE_SHAPE_MESSAGE,
        }),
      },
    ),
  ),
  // context-trimming-tiers P-025 (write-echo diet): trimmed/standard sessions
  // get a compact workItem ref per result instead of the full echoed row;
  // outcome fields (ok/error/holder/hint/reflect) pass through verbatim —
  // see write-echo-shape.ts.
  shape: {
    standard: (data) => shapeWorkItemWriteEcho(data, 'standard'),
    trimmed: (data) => shapeWorkItemWriteEcho(data, 'trimmed'),
  },
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const adoptedName = ident.workspaceId
      ? await resolveAdoptedName(ident.workspaceId, ident.ownerId).catch(() => null)
      : null;
    const completionIdent = { ...ident, adoptedName };
    const isBulkForm = Boolean(args.items?.length);
    // EI-18661904412177717: the batch path defaulted `harness` from the top level but SILENTLY
    // DROPPED the top-level `state` — so `{ state:'resolved', items:[…] }` recorded every
    // completion, returned ok:true, and left every item `wip`/claimable, while the stateWarning
    // instructed the caller to "pass top-level `state`" — exactly what they had just passed.
    // An agent that trusts ok:true walks away believing a batch is closed when it is all still
    // claimable, and the auto-loop re-places finished work: a silent correctness failure in the
    // completion-integrity path. `state` now defaults per-item exactly like `harness` (a
    // per-item `state` still wins), so the two forms cannot disagree. Defaulted HERE, at the
    // single list-construction site, so every downstream `it.state` reader (the remote-authored
    // refusal, the test-completion gate, the inference/close-intent logic) sees the same value.
    const list: CompleteItem[] = isBulkForm
      ? args.items!.map((it) => ({
          ...it,
          harness: it.harness ?? args.harness,
          state: it.state ?? args.state,
          recordOnly: it.recordOnly ?? args.recordOnly,
          boundaryNote: it.boundaryNote ?? args.boundaryNote,
          validateOnly: it.validateOnly ?? args.validateOnly,
        }))
      : [
          {
            id: args.id as string,
            harness: args.harness,
            state: args.state,
            recordOnly: args.recordOnly,
            completion: args.completion!,
            outputPayload: args.outputPayload,
            specAdequacy: 'specAdequacy' in args ? args.specAdequacy : undefined,
            assumptions: args.assumptions,
            boundaryNote: args.boundaryNote,
            validateOnly: args.validateOnly,
          },
        ];
    const env = await runBulk(list, (it) => completeOne(it, completionIdent, ctx), { keyOf: (it) => ({ id: it.id }) });
    // EI-14676 asked that a non-convergent completion be "impossible to miss": the
    // caller-visible `ok` must be false at the TOP level, not just buried per-item, so an
    // agent cannot read `ok:true` and write a "TERMINAL — do not re-open" checkpoint off a
    // call that never closed the item (WI-5218 stayed state:'open'/terminalOwner:null while
    // the completing agent believed, and recorded, that it had converged).
    //
    // That used to need a LOCAL override here, because the shared bulk envelope hard-coded
    // `ok:true` ("the batch ran") — so this tool could only rescue its single-item form and
    // had to leave the explicit `items:[…]` batch reporting a truthy envelope over a failed
    // item. EI-23737206446729041 fixed that at the contract instead: `runBulk` now DERIVES
    // the envelope's `ok` from `results[].ok` for every bulk tool. The single-item form is
    // just the n=1 case of that conjunction, so the override is redundant and removing it
    // keeps ONE definition of the rule rather than a general one plus a local restatement
    // that could drift from it.
    return bulkContent(env);
  },
});

export default workItemsCompleteTool;
