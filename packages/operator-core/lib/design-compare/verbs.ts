/**
 * Mockup-to-implementation validation: the design-phase plugin verb bodies.
 *
 * Plan: ratified-mockup-implementation-validation-2026-08-24 (P-006).
 *
 * D-009 settled that no existing design-phase verb can carry a comparison
 * without being deformed, so the plugin gains verbs of its own. D-017 settled
 * that the CommonJS plugin must NOT reach into this package to run them: the
 * operator PUBLISHES these implementations into a pinned module slot
 * (`host-registry.ts`) and the plugin READS it. Everything below is therefore
 * ordinary dependency-injected TypeScript with no knowledge of plugins, MCP,
 * or CommonJS — which is what makes it testable without either.
 *
 * ─── WHAT THIS FILE IS ALLOWED TO DO ─────────────────────────────────────────
 *
 * Orchestration only. It resolves a reference, checks the preconditions that do
 * not need an engine, delegates to the P-005 provider seam, and persists what
 * comes back. It contains no pixel mathematics, no thresholds of its own, and
 * no verdict logic — `computeVerdict` (contract.ts) is the single place a pass
 * is decided (D-002, D-004, D-012).
 *
 * ─── THE TWO REFUSALS, AND WHY THEY ARE DIFFERENT SHAPES ─────────────────────
 *
 * A verb can fail in two genuinely different ways, and collapsing them is how a
 * gate ends up reading a misconfiguration as a measurement:
 *
 *   1. A REFUSAL (`ok: false`) — the comparison never happened and cannot be
 *      described as one: the reference was never ratified, the engine is not
 *      installed in this host, the caller has no identity. There is no
 *      `CompareResult` here, deliberately. `INVALID_REASONS` is a closed set
 *      describing comparisons that were ATTEMPTED, and minting one for a
 *      comparison that never started would put a host misconfiguration into the
 *      evidence table wearing the clothes of evidence.
 *
 *   2. An INVALID RESULT (`ok: true`, `verdict: 'invalid'`) — a real comparison
 *      attempt that could not yield pass/fail: dimensions disagreed, the
 *      environment was not the contracted one, the engine errored. This IS
 *      evidence, it is persisted, and it is never a silent pass.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { renderMatrixObservationSchema } from './render-matrix';
import {
  COMPARE_RESULT_SCHEMA_VERSION,
  type CaptureEnvironment,
  type CompareResult,
  type ImplementationTarget,
  type ReferenceIdentity,
  type ThresholdPolicy,
  describeEnvironment,
  environmentsMatch,
} from './contract';
import type { PngDimensions } from './png-header';
import { validateRatification } from './ratification';
import { readDesignRolloutAdmission, type RolloutScope, type RolloutAdmission } from './rollout';
import type {
  DesignApprovalScope,
  DesignReferenceBinding,
  RatifiedReference,
  ReferenceProvenance,
  RequiredCase,
  RequiredCaseTarget,
} from './ratification';
import {
  type ReferenceImageRef,
  type ReferenceScope,
  type ReferenceStorePort,
  ReferenceStoreError,
  type StoredEvidenceRow,
  type StoredReferenceRow,
  activeRevision,
  evidenceArtifactId,
  ratifyReference,
} from './reference-store';
import { type ComparisonDeps, type ComparisonRequest, compareAgainstReference } from './provider';

// ─── refusals ────────────────────────────────────────────────────────────────

/**
 * Why a verb declined to produce a result at all.
 *
 * Distinct from `InvalidReason` on purpose (see the header). These are the
 * conditions under which no comparison was attempted, so none can be described.
 */
export const VERB_REFUSAL_CODES = [
  /** No design-compare implementation is installed in this host (D-017). */
  'engine-unavailable',
  /** The caller carries no usable identity, so provenance could not be recorded. */
  'unauthenticated',
  /** The reference has never been ratified, or has no active revision. */
  'not-ratified',
  /** A concurrent writer took this revision first. Re-read and retry. */
  'revision-conflict',
  /** The submission is malformed. Retrying it unchanged is pointless. */
  'validation-failed',
  /** The reference image could not be turned into bytes an engine can read. */
  'reference-unreadable',
  /** The store itself failed. */
  'storage-error',
] as const;
export type VerbRefusalCode = (typeof VERB_REFUSAL_CODES)[number];

export interface VerbRefusal {
  readonly ok: false;
  readonly code: VerbRefusalCode;
  readonly detail: string;
  /** Present for 'validation-failed': every problem at once, not the first. */
  readonly errors?: readonly { readonly code: string; readonly message: string }[];
}

export type VerbOutcome<T> = ({ readonly ok: true } & T) | VerbRefusal;

function refuse(code: VerbRefusalCode, detail: string, errors?: VerbRefusal['errors']): VerbRefusal {
  return { ok: false, code, detail, ...(errors ? { errors } : {}) };
}

/**
 * Map a store refusal onto a verb refusal.
 *
 * `ReferenceStoreError.code` already distinguishes "the world moved under you,
 * retry" from "your submission is malformed, do not retry", and that
 * distinction is the whole point of the mapping — a caller that retries a
 * malformed submission loops forever, and one that does not retry a conflict
 * gives up on work that would have succeeded.
 */
function refuseFromStore(error: ReferenceStoreError): VerbRefusal {
  const code: VerbRefusalCode =
    error.code === 'revision-conflict'
      ? 'revision-conflict'
      : error.code === 'not-ratified' || error.code === 'already-retracted'
        ? 'not-ratified'
        : 'validation-failed';
  return refuse(
    code,
    error.message,
    error.errors.length > 0 ? error.errors.map((e) => ({ code: e.code, message: e.message })) : undefined,
  );
}

// ─── the caller ──────────────────────────────────────────────────────────────

/**
 * Who is calling, as established by the HOST — never by the caller's own input.
 *
 * This is the authorization seam. `ratifiedBy` on a stored reference is the
 * audit trail that says which principal approved which bytes, so it is read
 * from here and an input field claiming to be it is ignored (see
 * `ratifyReferenceVerb`). A provenance record a caller can write for itself is
 * not a provenance record.
 */
export interface VerbCaller {
  /** Stable principal id — the spawn/session identity the host attached. */
  readonly actorId: string;
  /** The calling agent's role, as the host resolved it. */
  readonly role: string;
}

function describeCaller(caller: VerbCaller): string {
  return `${caller.role}:${caller.actorId}`;
}

// ─── shared dependencies ─────────────────────────────────────────────────────

/**
 * A reference image, made readable by an engine.
 *
 * A `ReferenceImageRef.locator` is whatever the ratifier stored — a path, an
 * artifact URL, an inline `data:` URL — and the provider needs a filesystem
 * path. Injected rather than implemented here so a test never has to write a
 * PNG to disk, and so the materialisation strategy is the host's business.
 */
export type ReferenceImageMaterializer = (
  image: ReferenceImageRef,
) => Promise<{
  readonly path: string;
  readonly contentSha256?: string;
  readonly release?: () => Promise<void>;
} | { readonly error: string }>;

export interface VerbDeps {
  /** Host-owned admission seam; omitted in production uses the durable policy reader. */
  readonly rolloutAdmission?: (scope: RolloutScope) => Promise<RolloutAdmission>;
  /**
   * The harness these verbs are bound to.
   *
   * Bound at construction rather than taken per call, because it is the row
   * scope every store read and write is keyed by. A verb that accepted it as
   * input would let a caller address another harness's design artifacts.
   */
  readonly harnessSlug: string;
  readonly store: ReferenceStorePort;
  readonly now: () => number;
  /** ISO-8601 stamp for `capturedAt` / `ratifiedAt`. Injected for determinism. */
  readonly clock: () => string;
  readonly materializeReferenceImage: ReferenceImageMaterializer;
  readonly comparison: ComparisonDeps;
}

function scopeFor(deps: VerbDeps, featureId: string, referenceId: string): ReferenceScope {
  return { harnessSlug: deps.harnessSlug, featureId, referenceId };
}

/** Check the bytes behind a locator, not a second caller-supplied identity. */
async function verifyApprovedImage(image: ReferenceImageRef, expected: string, deps: VerbDeps): Promise<VerbRefusal | null> {
  try {
    const materialized = await deps.materializeReferenceImage(image);
    if ('error' in materialized) return refuse('reference-unreadable', materialized.error);
    try {
      return materialized.contentSha256 === expected ? null
        : refuse('validation-failed', 'approved-reference-bytes-mismatch: stored approval hash does not match the independently read image bytes');
    } finally {
      await materialized.release?.();
    }
  } catch (error) {
    return refuse('reference-unreadable', error instanceof Error ? error.message : String(error));
  }
}

// ─── verb 1: ratify_reference ────────────────────────────────────────────────

export interface RatifyReferenceInput {
  readonly featureId: string;
  readonly referenceId: string;
  /**
   * The revision the caller believes it is creating.
   *
   * Required, never allocated for the caller: submitting `4` is a claim about
   * having read `3`, and checking that claim is how a lost update is caught.
   * Allocating silently would turn a stale read into a successful write.
   */
  readonly revision: number;
  readonly referenceClass: ReferenceIdentity['referenceClass'];
  readonly contentSha256: string;
  readonly image: ReferenceImageRef;
  readonly referenceEnvironment: CaptureEnvironment;
  readonly requiredCases: readonly RequiredCase[];
  readonly approval?: DesignApprovalScope;
  readonly provenance: {
    readonly source: string;
    readonly sourceRef: string;
    readonly derivedFrom?: string;
    /**
     * The rendering host the reference IMAGE was captured on (P-011/D-023),
     * from `capture.observed.renderHost`. Absent for an upload or a Figma
     * export, which no host rendered.
     *
     * Recorded at ratification and never again: it is what a later completion's
     * evidence has to match, so a value the completion could supply would be a
     * value the completion could choose.
     */
    readonly capturedOnRenderHost?: string;
  };
}

export interface RatifyReferenceResult {
  readonly artifactId: string;
  readonly referenceId: string;
  readonly revision: number;
  readonly ratifiedBy: string;
  readonly ratifiedAt: string;
  /** Copy into payload.designReferences; the stored reference owns its scope. */
  readonly binding?: DesignReferenceBinding;
  readonly supersededRevision?: number;
  /**
   * Evidence this ratification just made unusable. Reported, never rewritten —
   * the evidence is stale because the active revision moved, so there is
   * nothing to mark and no window in which the marking has not happened yet.
   */
  readonly invalidatedEvidence: readonly {
    readonly artifactId: string;
    readonly referenceRevision: number;
  }[];
}

export async function ratifyReferenceVerb(
  input: RatifyReferenceInput,
  caller: VerbCaller,
  deps: VerbDeps,
): Promise<VerbOutcome<RatifyReferenceResult>> {
  if (!caller.actorId) {
    return refuse(
      'unauthenticated',
      'ratification records who approved the reference bytes; the host supplied no caller identity, ' +
        'and a provenance record with no principal in it is not a provenance record',
    );
  }

  const ratifiedAt = deps.clock();
  const ratifiedBy = describeCaller(caller);
  // NOTE: `ratifiedBy` and `ratifiedAt` are built HERE, from the host-supplied
  // caller and clock. `RatifyReferenceInput` deliberately has no field for
  // either, so there is nothing for a caller to forge — the absence is the
  // guarantee, not a validation step that could be forgotten.
  const provenance: ReferenceProvenance = {
    source: input.provenance.source,
    sourceRef: input.provenance.sourceRef,
    ratifiedBy,
    ratifiedAt,
    ...(input.provenance.derivedFrom !== undefined
      ? { derivedFrom: input.provenance.derivedFrom }
      : {}),
    ...(input.provenance.capturedOnRenderHost
      ? { capturedOnRenderHost: input.provenance.capturedOnRenderHost }
      : {}),
  };

  const candidate: RatifiedReference = {
    identity: {
      referenceId: input.referenceId,
      revision: input.revision,
      referenceClass: input.referenceClass,
      contentSha256: input.contentSha256,
    },
    state: 'active',
    provenance,
    referenceEnvironment: input.referenceEnvironment,
    requiredCases: input.requiredCases,
    ...(input.approval !== undefined ? { approval: input.approval } : {}),
  };

  try {
    if (candidate.approval) {
      const errors = validateRatification(candidate);
      if (errors.length) return { ok: false, code: 'validation-failed', detail: errors.map(e => e.message).join('; '), errors };
      const mismatch = await verifyApprovedImage(input.image, input.contentSha256, deps);
      if (mismatch) return mismatch;
      const scope = { harnessSlug: deps.harnessSlug, featureId: input.featureId,
        referenceId: input.referenceId, contentSha256: input.contentSha256,
        approval: candidate.approval, actorId: caller.actorId };
      const rollout = await (deps.rolloutAdmission?.(scope) ?? readDesignRolloutAdmission(scope, { now: deps.now() }));
      if (!rollout.satisfied) return refuse('validation-failed', rollout.reason);
    }
    const outcome = await ratifyReference(deps.store, {
      scope: scopeFor(deps, input.featureId, input.referenceId),
      candidate,
      image: input.image,
      now: deps.now,
    });
    return {
      ok: true,
      artifactId: outcome.stored.artifactId,
      referenceId: input.referenceId,
      revision: input.revision,
      ratifiedBy,
      ratifiedAt,
      ...(candidate.approval ? { binding: {
        schemaVersion: 1 as const, featureId: input.featureId, referenceId: input.referenceId,
        revision: input.revision, contentSha256: input.contentSha256,
      } } : {}),
      ...(outcome.supersededRevision !== undefined
        ? { supersededRevision: outcome.supersededRevision }
        : {}),
      invalidatedEvidence: outcome.invalidatedEvidence.map((e) => ({
        artifactId: e.artifactId,
        referenceRevision: e.referenceRevision,
      })),
    };
  } catch (error) {
    if (error instanceof ReferenceStoreError) return refuseFromStore(error);
    throw error;
  }
}

// ─── verb 2: compare_render ──────────────────────────────────────────────────

export interface CompareRenderInput {
  readonly featureId: string;
  readonly referenceId: string;
  readonly target: ImplementationTarget;
  readonly environment: CaptureEnvironment;
  readonly policy: ThresholdPolicy;
  readonly actualImagePath: string;
  readonly diffImagePath: string;
  readonly expectedDimensions?: PngDimensions;
  readonly timeoutMs?: number;
  /**
   * The rendering host the capture at `actualImagePath` was produced on
   * (P-011/D-023), as `render-host.ts`'s canonical string.
   *
   * Supplied by the caller rather than measured here for the same reason
   * `expectedDimensions` is: this verb receives an image PATH, not a browser,
   * so only the capture path has a page to measure. `capture.ts` returns it.
   *
   * Omitting it is not a way to avoid a refusal. For a reference that records
   * its own host, evidence without one fails the gate as `wrong-render-host`.
   */
  readonly renderHost?: string;
  /** Advisory prose. Recorded beside the evidence, never able to change it. */
  readonly advisoryNotes?: string;
  /** Optional structured browser evidence, persisted in the existing compare artifact. */
  readonly renderObservation?: CompareResult['renderObservation'];
}

export interface CompareRenderResult {
  readonly artifactId: string;
  readonly result: CompareResult;
}

export async function compareRenderVerb(
  input: CompareRenderInput,
  caller: VerbCaller,
  deps: VerbDeps,
): Promise<VerbOutcome<CompareRenderResult>> {
  void caller;

  // EI-21414614584540571: `ignoredRegions` used to be accepted here and
  // persisted onto stored evidence while nothing ever applied it — a mask that
  // appeared applied and was not. The field is gone from the contract
  // (contract.ts explains why); this runtime check exists because the TS type
  // constrains no one arriving across the plugin's JSON boundary. A caller
  // still supplying it is refused LOUDLY rather than silently
  // unmasked-compared, because both silent options misrepresent: recording the
  // mask asserts an exclusion that never happened, and dropping it leaves the
  // caller believing pixels were excluded that were fully compared.
  const strayRegions = (input as { readonly ignoredRegions?: unknown }).ignoredRegions;
  if (strayRegions !== undefined) {
    return refuse(
      'validation-failed',
      'region masking is not implemented: `ignoredRegions` is not part of the compare contract, ' +
        'and every declared region would still be fully compared. Recording the mask would put a ' +
        'false exclusion claim on stored evidence, so the request is refused instead. Remove the ' +
        'field; if masking is genuinely needed it must be implemented end-to-end — engine ' +
        'support, non-empty justification/authority validation, and a mask-area cap — as a ' +
        'deliberate design change, not inherited from a field that was never wired.',
      [
        {
          code: 'unsupported-field',
          message: '`ignoredRegions` is not supported by compare_render',
        },
      ],
    );
  }

  const scope = scopeFor(deps, input.featureId, input.referenceId);

  let rows: readonly StoredReferenceRow[];
  try {
    rows = await deps.store.listRevisions(scope);
  } catch (error) {
    return refuse('storage-error', error instanceof Error ? error.message : String(error));
  }

  const active = activeRevision(rows);
  if (!active) {
    // No CompareResult is minted here, and that is deliberate: without an active
    // revision there is no `ReferenceIdentity` to stamp one with, and a result
    // that cannot say which reference revision it is about is not evidence.
    return refuse(
      'not-ratified',
      rows.length === 0
        ? `'${input.referenceId}' has never been ratified for feature ${input.featureId}; ` +
          `exploration is unconstrained until an explicit ratification (D-001), so there is nothing to compare against`
        : `'${input.referenceId}' has no active revision (its highest is ` +
          `${Math.max(...rows.map((r) => r.reference.identity.revision))}); it is retracted or superseded, ` +
          `and a withdrawn design must not keep gating work`,
    );
  }

  const identity = active.reference.identity;
  const capturedAt = deps.clock();

  if (input.renderObservation !== undefined) {
    const parsed = renderMatrixObservationSchema.safeParse(input.renderObservation);
    if (!parsed.success) return refuse('validation-failed', 'malformed-render-observation');
    const observation = parsed.data;
    if (!environmentsMatch(observation.environment, input.environment) ||
        observation.target.targetId !== input.target.targetId ||
        observation.target.targetKind !== input.target.targetKind ||
        observation.target.implementationRevision !== input.target.implementationRevision) {
      return refuse('validation-failed', 'render-observation-target-or-environment-mismatch');
    }
    if (observation.evidenceKind === 'fixture' && observation.connectivity !== 'not-exercised') {
      return refuse('validation-failed', 'fixture-connectivity-claim');
    }
    if (observation.review && (observation.review.referenceSha256 !== identity.contentSha256 ||
        observation.review.captureSha256 !== observation.capture.sha256)) {
      return refuse('validation-failed', 'stale-render-observation-review');
    }
    try {
      const bytes = await readFile(input.actualImagePath);
      if (resolve(observation.capture.path) !== resolve(input.actualImagePath) ||
          createHash('sha256').update(bytes).digest('hex') !== observation.capture.sha256) {
        return refuse('validation-failed', 'render-observation-capture-bytes-mismatch');
      }
    } catch {
      return refuse('validation-failed', 'render-observation-capture-unreadable');
    }
  }

  /** Build the request once, so every exit below stamps identical identity. */
  const requestFor = (referenceImagePath: string): ComparisonRequest => ({
    reference: identity,
    target: input.target,
    environment: input.environment,
    policy: input.policy,
    referenceImagePath,
    actualImagePath: input.actualImagePath,
    diffImagePath: input.diffImagePath,
    ...(input.expectedDimensions ? { expectedDimensions: input.expectedDimensions } : {}),
    capturedAt,
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.advisoryNotes ? { advisoryNotes: input.advisoryNotes } : {}),
  });

  // PRECONDITION, BEFORE ANY ENGINE: the capture must have been taken at the
  // environment the reference image itself is contracted at. `environmentsMatch`
  // is deliberately exact — a near-match is a different render, and comparing a
  // different render against these pixels produces a number that looks like
  // evidence and is not. This runs first for the same reason the provider's own
  // geometry guard does: an engine that resizes would normalise the error away.
  if (!environmentsMatch(input.environment, active.reference.referenceEnvironment)) {
    const invalid = invalidResult({
      identity,
      input,
      capturedAt,
      reason: 'environment-mismatch',
      detail:
        `the capture was taken at ${describeEnvironment(input.environment)} but reference ` +
        `${identity.referenceId}@${identity.revision} is contracted at ` +
        `${describeEnvironment(active.reference.referenceEnvironment)}. These are different renders, ` +
        `so a pixel comparison between them measures the environment difference, not implementation fidelity.`,
    });
    return persist(invalid, input, deps);
  }

  // PRECONDITION, BEFORE ANY ENGINE: the capture must be OF a surface this
  // reference actually requires (D-020 class 4).
  //
  // Symmetric with the environment check above and refused for the same reason,
  // one step further out: that one rejects the right surface rendered wrongly,
  // this one rejects the wrong surface entirely. The engine cannot catch it,
  // because there is nothing for it to catch — D-020 measured semantically
  // different Storybook stories producing BYTE-IDENTICAL captures when their
  // distinguishing content arrives after settle. The comparison then returns a
  // diff ratio of 0: a perfect score, for the wrong thing. No threshold detects
  // that, so the contract has to.
  const requiredTargets = active.reference.requiredCases;
  const targetIsRequired = requiredTargets.some(
    (c) => c.target.targetId === input.target.targetId && c.target.targetKind === input.target.targetKind,
  );
  if (!targetIsRequired) {
    const declared = requiredTargets
      .map((c) => `'${c.target.targetId}' (${c.target.targetKind}, case '${c.caseId}')`)
      .join(', ');
    const invalid = invalidResult({
      identity,
      input,
      capturedAt,
      reason: 'target-mismatch',
      detail:
        `the capture is of ${input.target.targetKind} '${input.target.targetId}', which reference ` +
        `${identity.referenceId}@${identity.revision} does not require. It requires ${declared}. ` +
        `A comparison against an unrequired surface can still return a passing diff ratio — captures ` +
        `of different surfaces are sometimes byte-identical — so the number it produces would look ` +
        `like evidence of fidelity while measuring nothing that was asked for.`,
    });
    return persist(invalid, input, deps);
  }

  const materialized = await deps.materializeReferenceImage(active.image);
  if ('error' in materialized) {
    // A reference that cannot be read is a storage/host problem, not a
    // comparison outcome — the reference is ratified and valid, we simply
    // cannot get at its bytes. Refusing keeps that out of the evidence table.
    return refuse(
      'reference-unreadable',
      `reference ${identity.referenceId}@${identity.revision} could not be materialised from ` +
        `locator '${active.image.locator}': ${materialized.error}`,
    );
  }

  try {
    if (active.reference.approval && materialized.contentSha256 !== identity.contentSha256) {
      return refuse('validation-failed', 'approved-reference-bytes-mismatch: the reference image changed after approval');
    }
    const result = await compareAgainstReference(requestFor(materialized.path), deps.comparison);
    // A decoded data URL is temporary. Evidence must retain the original stored
    // locator so releasing that decode cannot leave a dangling reference image.
    const durable = materialized.release && result.artifacts
      ? { ...result, artifacts: { ...result.artifacts, referenceImage: active.image.locator } }
      : result;
    return await persist(durable, input, deps);
  } finally {
    await materialized.release?.();
  }
}

function invalidResult(args: {
  readonly identity: ReferenceIdentity;
  readonly input: CompareRenderInput;
  readonly capturedAt: string;
  readonly reason: NonNullable<CompareResult['invalidReason']>;
  readonly detail: string;
}): CompareResult {
  const { identity, input, capturedAt, reason, detail } = args;
  return {
    schemaVersion: COMPARE_RESULT_SCHEMA_VERSION,
    verdict: 'invalid',
    invalidReason: reason,
    detail,
    reference: identity,
    target: input.target,
    environment: input.environment,
    // Engine identity is stamped even though no engine ran: consequence 7 makes
    // it mandatory on EVERY result, and the refusal paths are exactly where it
    // is easiest to omit. A refusal that cannot say whose contract it was
    // refusing on behalf of is not interpretable.
    engine: { engine: 'papercusp/precondition', engineVersion: String(COMPARE_RESULT_SCHEMA_VERSION) },
    policy: input.policy,
    capturedAt,
    ...(input.advisoryNotes ? { advisoryNotes: input.advisoryNotes } : {}),
  };
}

async function persist(
  incoming: CompareResult,
  input: CompareRenderInput,
  deps: VerbDeps,
): Promise<VerbOutcome<CompareRenderResult>> {
  // The rendering host is stamped HERE rather than at each construction site
  // because this is the one funnel every result passes through — engine results
  // and precondition refusals alike. Stamping it per-site is how the refusal
  // paths end up as the ones missing it, which are exactly the paths where a
  // reader most needs to know which machine produced the capture.
  const result: CompareResult = {
    ...incoming,
    ...(input.renderHost ? { renderHost: input.renderHost } : {}),
    ...(input.renderObservation ? { renderObservation: input.renderObservation } : {}),
  };
  const artifactId = evidenceArtifactId(result);
  try {
    await deps.store.insertEvidence({
      artifactId,
      result,
      featureId: input.featureId,
      harnessSlug: deps.harnessSlug,
    });
  } catch (error) {
    if (error instanceof ReferenceStoreError) return refuseFromStore(error);
    return refuse('storage-error', error instanceof Error ? error.message : String(error));
  }
  return { ok: true, artifactId, result };
}

// ─── verb 3: get_design_evidence ─────────────────────────────────────────────

export interface GetDesignEvidenceInput {
  readonly featureId: string;
  readonly referenceId: string;
}

/**
 * One stored comparison, split into the two halves that must never be confused.
 *
 * `deterministic` is what the gate may read. `advisory` is prose a human or a
 * model wrote to explain a failure, and D-004 forbids it from establishing
 * anything. They are separate OBJECTS rather than sibling fields so a reader
 * cannot slide from one to the other by accident: there is no shape of this
 * record in which prose sits next to a verdict looking equally load-bearing.
 */
export interface EvidenceView {
  /** Kept outside the pixel verdict: this includes a separate human visual review. */
  readonly renderObservation?: CompareResult['renderObservation'];
  readonly artifactId: string;
  /** Whether this evidence is bound to the CURRENTLY active reference revision. */
  readonly current: boolean;
  /**
   * True when the stored record's schema version is not the one this build
   * understands. Such a record is reported, never silently trusted: reading an
   * unknown shape as current is how a gate passes on evidence it cannot parse.
   */
  readonly schemaVersionMismatch: boolean;
  readonly deterministic: {
    readonly schemaVersion: number;
    readonly verdict: CompareResult['verdict'];
    readonly invalidReason?: CompareResult['invalidReason'];
    readonly detail?: string;
    readonly reference: ReferenceIdentity;
    readonly target: ImplementationTarget;
    readonly environment: CaptureEnvironment;
    readonly engine: CompareResult['engine'];
    readonly policy: ThresholdPolicy;
    readonly counts?: CompareResult['counts'];
    readonly diffRatio?: number;
    readonly diffRegions?: CompareResult['diffRegions'];
    readonly artifacts?: CompareResult['artifacts'];
    /** The rendering host this capture was produced on (P-011/D-023), when it reported one. */
    readonly renderHost?: string;
    readonly capturedAt: string;
  };
  readonly advisory: {
    /** Never consulted for a verdict (D-004). Null when none was recorded. */
    readonly notes: string | null;
  };
}

/** One required case and whether current evidence exists for it. */
export interface CoverageView {
  readonly caseId: string;
  readonly environment: CaptureEnvironment;
  /** The surface this case is contracted against; half of what coverage matches on. */
  readonly target: RequiredCaseTarget;
  readonly rationale: string;
  /** The current evidence for this case, or null when none has been produced. */
  readonly evidenceArtifactId: string | null;
  readonly verdict: CompareResult['verdict'] | null;
}

export interface GetDesignEvidenceResult {
  readonly reference: {
    readonly referenceId: string;
    readonly activeRevision: number;
    readonly referenceClass: ReferenceIdentity['referenceClass'];
    readonly contentSha256: string;
    readonly state: RatifiedReference['state'];
    readonly referenceEnvironment: CaptureEnvironment;
    readonly ratifiedBy: string;
    readonly ratifiedAt: string;
    readonly approval?: DesignApprovalScope;
    /**
     * The rendering host the reference IMAGE was captured on (P-011/D-023).
     * Absent for uploads, Figma exports, and anything ratified before the field
     * existed — and that absence is what makes such a reference report-only.
     */
    readonly capturedOnRenderHost?: string;
  } | null;
  /** Every revision ever recorded, newest last — the audit trail. */
  readonly revisions: readonly {
    readonly revision: number;
    readonly state: RatifiedReference['state'];
    readonly supersededByRevision: number | null;
  }[];
  readonly evidence: readonly EvidenceView[];
  readonly coverage: readonly CoverageView[];
  /** How many stored results are NOT current. Named so a zero is legible. */
  readonly staleCount: number;
}

export async function getDesignEvidenceVerb(
  input: GetDesignEvidenceInput,
  caller: VerbCaller,
  deps: VerbDeps,
): Promise<VerbOutcome<GetDesignEvidenceResult>> {
  void caller;
  const scope = scopeFor(deps, input.featureId, input.referenceId);

  let rows: readonly StoredReferenceRow[];
  let stored: readonly StoredEvidenceRow[];
  try {
    rows = await deps.store.listRevisions(scope);
    stored = await deps.store.listEvidenceResults(scope);
  } catch (error) {
    return refuse('storage-error', error instanceof Error ? error.message : String(error));
  }

  const active = activeRevision(rows);
  const activeRevisionNumber = active?.reference.identity.revision;

  if (active?.reference.approval) {
    const mismatch = await verifyApprovedImage(active.image, active.reference.identity.contentSha256, deps);
    if (mismatch) return mismatch;
  }

  const evidence: EvidenceView[] = stored.map((row) => {
    const r = row.result;
    const schemaVersionMismatch = r.schemaVersion !== COMPARE_RESULT_SCHEMA_VERSION;
    return {
      artifactId: row.artifactId,
      // A record we cannot parse is never current. Combining the two conditions
      // here rather than leaving them to the reader means there is no path on
      // which an unreadable record is reported current.
      current:
        !schemaVersionMismatch &&
        activeRevisionNumber !== undefined &&
        r.reference.revision === activeRevisionNumber,
      schemaVersionMismatch,
      ...(r.renderObservation ? { renderObservation: r.renderObservation } : {}),
      deterministic: {
        schemaVersion: r.schemaVersion,
        verdict: r.verdict,
        ...(r.invalidReason ? { invalidReason: r.invalidReason } : {}),
        ...(r.detail ? { detail: r.detail } : {}),
        reference: r.reference,
        target: r.target,
        environment: r.environment,
        engine: r.engine,
        policy: r.policy,
        ...(r.counts ? { counts: r.counts } : {}),
        ...(r.diffRatio !== undefined ? { diffRatio: r.diffRatio } : {}),
        ...(r.diffRegions ? { diffRegions: r.diffRegions } : {}),
        ...(r.artifacts ? { artifacts: r.artifacts } : {}),
        ...(r.renderHost ? { renderHost: r.renderHost } : {}),
        capturedAt: r.capturedAt,
      },
      advisory: { notes: r.advisoryNotes ?? null },
    };
  });

  const coverage: CoverageView[] = (active?.reference.requiredCases ?? []).map((c: RequiredCase) => {
    // Matched on environment AND surface. Environment alone was the D-020
    // class-4 bypass: because D-019 contracts every case at the reference's own
    // environment, an environment-keyed match cannot tell two cases apart, so
    // the first evidence record silently answered all of them — including
    // evidence captured from a surface the case was never about.
    const hit = evidence.find(
      (e) =>
        e.current &&
        environmentsMatch(e.deterministic.environment, c.environment) &&
        e.deterministic.target.targetId === c.target.targetId &&
        e.deterministic.target.targetKind === c.target.targetKind,
    );
    return {
      caseId: c.caseId,
      environment: c.environment,
      target: c.target,
      rationale: c.rationale,
      evidenceArtifactId: hit?.artifactId ?? null,
      verdict: hit?.deterministic.verdict ?? null,
    };
  });

  return {
    ok: true,
    reference: active
      ? {
          referenceId: active.reference.identity.referenceId,
          activeRevision: active.reference.identity.revision,
          referenceClass: active.reference.identity.referenceClass,
          contentSha256: active.reference.identity.contentSha256,
          state: active.reference.state,
          referenceEnvironment: active.reference.referenceEnvironment,
          ratifiedBy: active.reference.provenance.ratifiedBy,
          ratifiedAt: active.reference.provenance.ratifiedAt,
          ...(active.reference.approval ? { approval: active.reference.approval } : {}),
          ...(active.reference.provenance.capturedOnRenderHost
            ? { capturedOnRenderHost: active.reference.provenance.capturedOnRenderHost }
            : {}),
        }
      : null,
    revisions: rows.map((r) => ({
      revision: r.reference.identity.revision,
      state: r.reference.state,
      supersededByRevision: r.reference.supersededByRevision ?? null,
    })),
    evidence,
    coverage,
    staleCount: evidence.filter((e) => !e.current).length,
  };
}

// ─── the published surface ───────────────────────────────────────────────────

/**
 * What the host publishes and the plugin calls. One object, so a plugin that
 * finds the slot populated has found ALL of it — a partially-installed surface
 * would fail per-verb at call time instead of at install time.
 */
export interface DesignCompareVerbs {
  readonly ratifyReference: (
    input: RatifyReferenceInput,
    caller: VerbCaller,
  ) => Promise<VerbOutcome<RatifyReferenceResult>>;
  readonly compareRender: (
    input: CompareRenderInput,
    caller: VerbCaller,
  ) => Promise<VerbOutcome<CompareRenderResult>>;
  readonly getDesignEvidence: (
    input: GetDesignEvidenceInput,
    caller: VerbCaller,
  ) => Promise<VerbOutcome<GetDesignEvidenceResult>>;
}

/**
 * Bind the verbs to one set of dependencies.
 *
 * `deps` are resolved per harness by the host, so this is what turns
 * host-agnostic functions into the surface the plugin reads out of the pinned
 * slot. The plugin never sees `VerbDeps`, which is what keeps Postgres, the
 * engine and the filesystem out of the CommonJS layer entirely.
 */
export function createDesignCompareVerbs(deps: VerbDeps): DesignCompareVerbs {
  return {
    ratifyReference: (input, caller) => ratifyReferenceVerb(input, caller, deps),
    compareRender: (input, caller) => compareRenderVerb(input, caller, deps),
    getDesignEvidence: (input, caller) => getDesignEvidenceVerb(input, caller, deps),
  };
}
