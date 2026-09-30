/**
 * Test-only representative inputs for coordination-metadata-friction-reduction,
 * P-001. No runtime consumer, IO, stored identities, or policy overrides.
 * Keep these inputs stable when replacing the pre-change characterization tests.
 */
import type { PlanSchemaRef } from './plan-input-validation';
import { specClauseContentHash, type SpecClauseRevision, type SpecClauseWrite } from './spec-clauses-store';
import type { SuspectedToolFailure } from '../../harness/improvements/tool-error-classifier';

export const metadataPlanSlug = 'metadata-regression-fixture';
export const metadataHarness = 'metadata-test-harness';

/**
 * Frozen BEFORE product edits. Fixture populations only; these are not observed
 * MCP round trips, production rates, elapsed pickup time, or fleet-wide savings.
 * `maxAfter` is a comparison target, NOT a result. Zero-to-zero/three-to-three
 * entries explicitly preserve existing behavior instead of claiming improvement.
 * The corresponding tests call real oracles/compositions/renderers with injected
 * IO. Narrative-field counts inspect authored renderer inputs, not database
 * writes. Do not replace inputs merely to make a comparison pass.
 */
export const metadataWorkflowTargets = {
  readinessToolRequests: {
    before: 3, maxAfter: 2, unit: 'input-tool handler request/response pairs',
    writer: 'get-input-schema.ts:handler',
    population: 'the same missing/invalid/fixed states; excludes transport and repair writes',
  },
  readinessCalls: {
    before: 3, maxAfter: 2, unit: 'readiness oracle invocations',
    writer: 'plan-input-validation.ts:evaluatePlanStartReadiness',
    population: 'one missing harness plus invalid attempts, repaired in sequence',
  },
  callerClassSelections: {
    before: 1, maxAfter: 0, unit: 'caller-authored classRef fields',
    writer: 'evaluate-spec-quality.ts:args/handler',
    population: 'one caller-supplied class; target applies only to unambiguous persisted policy',
  },
  prematureDrafts: {
    before: 1, maxAfter: 0, unit: 'spec-quality drafts',
    writer: 'evaluate-spec-quality.ts:handler',
    population: 'one evaluation while required plan inputs are invalid',
  },
  formattingIdentityChanges: {
    before: 0, maxAfter: 0, unit: 'semantic fingerprint changes',
    writer: 'spec-clause-compiler.ts:computeSpecSetHash',
    population: 'one formatting/storage-revision-only edit, identical policy',
  },
  authoredProgressFields: {
    before: 2, maxAfter: 1, unit: 'authored progress narrative fields',
    writer: 'work-item-checkpoint.ts:setWorkItemCheckpointWithPrior;carry-note.ts:setCarryNote',
    measuredBy: 'count populated loop/item narrative inputs consumed by the real carry renderers',
    population: 'one operation copied into its item checkpoint and loop note',
  },
  successfulPickupDispatches: {
    before: 3, maxAfter: 3, unit: 'governed inner dispatches',
    writer: 'work_items/pickup.ts:composePickup',
    population: 'one successful get/claim/declare; not reviewer execution',
  },
  deniedPickupDispatches: {
    before: 2, maxAfter: 2, unit: 'governed inner dispatches',
    writer: 'work_items/pickup.ts:composePickup',
    population: 'one denied claim; no declaration or new work permitted',
  },
  knownReviewCreateRetries: {
    before: 2, maxAfter: 0, unit: 'create-core invocations',
    writer: 'work_items/_create-core.ts:createOneWorkItem',
    population: 'two retries against one already-known exact review identity',
  },
  reviewRecoveryRequests: {
    before: 4, maxAfter: 4, unit: 'assignment/wake composite invocations',
    writer: 'coordination/actionable-work-item-dispatch.ts:assignAndWakeActionableWorkItems',
    population: 'one existing review: scope refusal, screening pending, interrupted delivery, retained replay; policy/persistence IO injected',
  },
  revokedReviewWakes: {
    before: 1, maxAfter: 0, unit: 'wake IO attempts after admission revocation',
    writer: 'coordination/actionable-work-item-dispatch.ts:classifyOne',
    population: 'one already-held review with a fresh gated observation',
  },
  retryIncidentFields: {
    before: 14, maxAfter: 0, unit: 'caller-supplied toolFailure fields',
    writer: 'improvements/capture.ts:args/handler',
    measuredBy: 'sum the seven structured fields supplied on each of two explicit capture requests',
    population: 'two repeats of metadataToolFailure; excludes failing-tool arguments and optional first-report prose',
  },
  retryIncidentNarratives: {
    before: 0, maxAfter: 0, unit: 'caller-authored title/body fields',
    writer: 'improvements/capture.ts:deriveToolFailureCaptureText',
    population: 'the same two shorthand requests; generated prose is not caller-authored',
  },
  repeatedFrictionIdentities: {
    before: 1, maxAfter: 1, unit: 'distinct persisted observation ids',
    writer: 'harness/improvements/capture-core.ts:coalesceCapture',
    population: 'two same-reporter retries against one known probation observation; persistence IO injected',
  },
} as const;

/**
 * R-7 frozen retry input. The zero-field comparison target above requires the
 * invocation-ledger path to replace per-retry manual capture in P-006/P-007;
 * these baseline tests do NOT claim that automatic delivery already happened.
 * Correlation fingerprint, watchdog key and lifecycle class key have DIFFERENT
 * scopes: changing schema/field/runtime changes class identity, not necessarily
 * the message-shaped watchdog key. Tests pin those distinctions explicitly.
 */
export const metadataToolFailure = {
  toolName: 'coord:send',
  errorCode: 'invalid_args',
  status: 'error',
  message: 'invalid_args: body must be an array',
  schemaRevision: 'metadata-schema-v1',
  fieldPath: 'body',
  runtimeVersion: 'metadata-runtime-v1',
} as const satisfies SuspectedToolFailure;

// No fake zero, percentile, or guessed latency target for an unobserved metric.
// P-001/P-007 must obtain a matching trace before claiming those comparisons.
export const metadataUnmeasured = [
  'MCP/network round trips for the complete request-to-pickup workflow',
  'elapsed request-to-actual-reviewer-pickup milliseconds',
  'production metadata-only reevaluations and duplicate-attempt rates',
] as const;

export const metadataInputSchema: PlanSchemaRef = {
  template: null,
  inputSchema: {
    type: 'object',
    properties: { harness: { type: 'string', minLength: 1 }, attempts: { type: 'integer', minimum: 1 } },
    required: ['harness', 'attempts'],
    additionalProperties: false,
  },
};

export function metadataClauseWrite(overrides: Partial<SpecClauseWrite> = {}): SpecClauseWrite {
  return {
    planSlug: metadataPlanSlug,
    harnessSlug: metadataHarness,
    specId: 'SPEC-001-01',
    sourceValId: 'VAL-001-01',
    expectedRevision: 0,
    planItemId: 'P-001',
    behavior: 'POST /events returns 202 for a valid request',
    behaviorClass: 'happy-path',
    requiredEvidence: [],
    requiredTestLayers: ['integration'],
    mutationRequired: false,
    lifecycleStatus: 'active',
    acceptanceRef: `${metadataPlanSlug}#D-001`,
    actorId: 'fixture-author',
    ...overrides,
  };
}

export function metadataClause(overrides: Partial<SpecClauseRevision> = {}): SpecClauseRevision {
  const write = metadataClauseWrite();
  return {
    planSlug: metadataPlanSlug,
    specId: write.specId,
    sourceValId: write.sourceValId ?? null,
    revision: 1,
    currentRevision: 1,
    planItemId: write.planItemId,
    behavior: write.behavior,
    behaviorClass: write.behaviorClass,
    requiredEvidence: [],
    requiredTestLayers: ['integration'],
    mutationRequired: false,
    lifecycleStatus: 'active',
    supersedes: null,
    exemption: null,
    falsifier: null,
    contentHash: specClauseContentHash(write),
    createdBy: 'fixture-author',
    createdAt: '2026-09-07T00:00:00.000Z',
    acceptedBy: 'fixture-reviewer',
    acceptedAt: '2026-09-07T00:01:00.000Z',
    acceptanceRef: write.acceptanceRef ?? null,
    ...overrides,
  };
}
