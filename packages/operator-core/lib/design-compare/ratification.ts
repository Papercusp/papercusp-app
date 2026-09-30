/**
 * Mockup-to-implementation validation: the ratification lifecycle.
 *
 * Plan: ratified-mockup-implementation-validation-2026-08-24 (P-001).
 *
 * D-001 is the whole point of this module: exploration is unconstrained, and
 * enforcement begins ONLY at an explicit ratification transition. Nothing here
 * may reach backward into the exploratory phase — an exploring image has no
 * state in this machine at all, which is why `exploring` is modelled as the
 * absence of a ratification record rather than as a state we track.
 */

import { z } from 'zod';
import {
  type CaptureEnvironment,
  type ImplementationTarget,
  type ReferenceClass,
  type ReferenceIdentity,
  describeEnvironment,
  environmentsMatch,
} from './contract';

/**
 * The lifecycle of a ratified reference. `exploring` is deliberately NOT here:
 * a proposal that has never been ratified is not in this machine.
 */
export const RATIFICATION_STATES = [
  /** Ratified and in force. Exactly one revision of a reference may be active. */
  'active',
  /** Replaced by a newer revision. Its evidence can no longer satisfy a gate. */
  'superseded',
  /** Withdrawn without a replacement. The surface is unratified again. */
  'retracted',
] as const;
export type RatificationState = (typeof RATIFICATION_STATES)[number];

/** Explicit adoption of the UI approval contract; absent on historical references. */
export interface DesignApprovalScope {
  readonly schemaVersion: 1;
  readonly approvalRef: string;
  readonly planSlug: string;
  readonly planItemIds: readonly string[];
  readonly targetRoute: string;
  /** New adoption outside the desktop pilot requires an independently reviewed policy. */
  readonly rollout?: {
    readonly schemaVersion: 1;
    readonly policyPath: string;
    readonly policySha256: string;
    readonly reviewCardRef: string;
  };
  readonly adaptations?: readonly { readonly reason: string; readonly approvalRef: string }[];
  /** Adopt the journey/state gate by pinning its reviewed contract bytes. */
  readonly acceptance?: {
    readonly schemaVersion: 1;
    readonly contractPath: string;
    readonly contractSha256: string;
    readonly evidencePath: string;
  };
}

export const designApprovalScopeSchema = z.object({
  schemaVersion: z.literal(1),
  approvalRef: z.string().trim().min(1),
  planSlug: z.string().trim().min(1),
  planItemIds: z.array(z.string().regex(/^P-\d{3,}$/)).min(1).max(40)
    .refine(ids => new Set(ids).size === ids.length, 'implementing items must be unique'),
  targetRoute: z.string().regex(/^\/(?!\/)/, 'targetRoute must be an application route'),
  rollout: z.object({
    schemaVersion: z.literal(1), policyPath: z.string().trim().min(1),
    policySha256: z.string().regex(/^[0-9a-f]{64}$/),
    reviewCardRef: z.string().regex(/^EI-\d+$/),
  }).strict().optional(),
  adaptations: z.array(z.object({
    reason: z.string().trim().min(1), approvalRef: z.string().trim().min(1),
  }).strict()).max(32).optional(),
  acceptance: z.object({
    schemaVersion: z.literal(1),
    contractPath: z.string().trim().min(1),
    contractSha256: z.string().regex(/^[0-9a-f]{64}$/),
    evidencePath: z.string().trim().min(1),
  }).strict().optional(),
}).strict();

/** Stored in the existing work-item payload.designReferences array. */
export const designReferenceBindingSchema = z.object({
  schemaVersion: z.literal(1),
  featureId: z.string().trim().min(1),
  referenceId: z.string().trim().min(1),
  revision: z.number().int().positive(),
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export type DesignReferenceBinding = z.infer<typeof designReferenceBindingSchema>;

/** Where the reference image came from, recorded immutably at ratification. */
export interface ReferenceProvenance {
  /** 'upload' | 'artifact-capture' | 'figma-export' | 'derived-from'. */
  readonly source: string;
  /** Original filename, artifact URL, Figma node id, or source reference id. */
  readonly sourceRef: string;
  /** Who ratified it. */
  readonly ratifiedBy: string;
  readonly ratifiedAt: string;
  /**
   * For a 'derived-reference' (D-007): the incommensurable reference this was
   * derived from, so the audit trail back to the original mockup survives.
   */
  readonly derivedFrom?: string;
  /**
   * The rendering host this reference IMAGE was captured on (P-011, D-023), as
   * `render-host.ts`'s canonical string. Absent when the reference was not
   * captured at all — an upload or a Figma export — which is also why the
   * classes that carry one are exactly the classes that can gate.
   *
   * This field is what makes enforcement scopeable. The shipped threshold
   * (3.3816e-5, about 34 pixels of a 1280x800 render) was derived from
   * same-host noise only, and D-021 recorded that enforcing it across hosts
   * "fails correct work on the first runner whose fonts differ". A reference
   * with no recorded host is therefore never enforced — which also gives
   * P-011's "newly ratified design work only" for free, from a measured
   * property rather than a date comparison.
   */
  readonly capturedOnRenderHost?: string;
}

/**
 * Which implementation surface a required case is contracted against.
 *
 * No `implementationRevision`: that identifies the build a capture was taken
 * from and changes every commit, whereas this identifies WHAT must be captured
 * and changes only when the design's subject changes. Folding the two together
 * would make the contract expire on every deploy.
 */
export interface RequiredCaseTarget {
  readonly targetId: string;
  readonly targetKind: ImplementationTarget['targetKind'];
}

/**
 * One required comparison case: a surface, at an environment, that must
 * independently pass. Requirement 9 — a passing case never covers a different
 * one.
 *
 * `target` is required, and that is the whole enforcement of requirement 9.
 * D-019 contracts every case at the reference's OWN environment, so all cases
 * on a reference necessarily share one environment; a coverage matcher keyed on
 * environment therefore cannot distinguish them at all, and the first evidence
 * record answers every case at once. The surface is what actually differs.
 *
 * Making it optional would have been the smaller change and would have left the
 * hole open: an unbound case matches any capture, which is exactly the D-020
 * class-4 bypass — a reference ratified for one surface silently satisfied by a
 * different surface whose capture is identical, at diff ratio 0, with the
 * engine behaving perfectly.
 */
export interface RequiredCase {
  readonly caseId: string;
  readonly environment: CaptureEnvironment;
  /** The surface this case is contracted against. */
  readonly target: RequiredCaseTarget;
  /** Why this case is required (e.g. 'mobile breakpoint', 'error state'). */
  readonly rationale: string;
}

/**
 * Who lifted a ratified obligation, and why.
 *
 * Retraction is the ONE operation that turns a constrained surface back into an
 * unconstrained one, so it is the one operation an implementer could use to
 * make a failing gate go away. Recording it is what separates a withdrawal from
 * a silent universal bypass: without attribution, "the design no longer applies"
 * and "the comparison was inconvenient" leave identical traces.
 *
 * `at` is carried rather than inferred from a row timestamp because the store's
 * `created_ts` belongs to the RATIFICATION; a retraction that borrowed it would
 * report the wrong moment with total confidence.
 */
export interface ReferenceRetraction {
  readonly actor: string;
  readonly reason: string;
  /** ISO-8601 instant the retraction was recorded. */
  readonly at: string;
}

export interface RatifiedReference {
  readonly identity: ReferenceIdentity;
  readonly state: RatificationState;
  readonly provenance: ReferenceProvenance;
  /** Immutable alongside the image identity and required cases. */
  readonly approval?: DesignApprovalScope;
  /** The environment the reference image itself is contracted at. */
  readonly referenceEnvironment: CaptureEnvironment;
  /** Every case that must pass before dependent work may complete. */
  readonly requiredCases: readonly RequiredCase[];
  /** Set when state is 'superseded' — the revision that replaced this one. */
  readonly supersededByRevision?: number;
  /** Set when state is 'retracted' — who withdrew the obligation, and why. */
  readonly retraction?: ReferenceRetraction;
}

export interface RatificationError {
  readonly code:
    | 'not-active'
    | 'no-required-cases'
    | 'duplicate-case'
    | 'duplicate-case-target'
    | 'case-environment-mismatch'
    | 'revision-not-monotonic'
    | 'class-mismatch'
    | 'missing-derivation'
    | 'invalid-approval'
    | 'approval-downgrade';
  readonly message: string;
}

/**
 * Validate a proposed ratification before it is persisted.
 *
 * Returns every problem rather than the first, so a caller fixing a submission
 * is not led through them one round-trip at a time.
 */
export function validateRatification(
  candidate: RatifiedReference,
  previous?: RatifiedReference,
): readonly RatificationError[] {
  const errors: RatificationError[] = [];

  if (previous?.approval && !candidate.approval) {
    errors.push({ code: 'approval-downgrade', message: 'a new reference revision cannot remove its adopted approval contract' });
  }
  if (previous?.approval?.acceptance && !candidate.approval?.acceptance) {
    errors.push({ code: 'approval-downgrade', message: 'a replacement revision cannot remove its adopted journey/state acceptance contract' });
  }
  if (previous?.approval && candidate.approval?.approvalRef === previous.approval.approvalRef) {
    errors.push({ code: 'invalid-approval', message: 'a replacement reference revision requires a new approvalRef; the original approval cannot authorize replacement bytes or scope' });
  }
  if (candidate.approval !== undefined) {
    const approval = designApprovalScopeSchema.safeParse(candidate.approval);
    if (!approval.success) {
      return [{ code: 'invalid-approval', message: `invalid approval scope: ${approval.error.message}` }];
    }
    if (!/^[0-9a-f]{64}$/.test(candidate.identity.contentSha256)) {
      errors.push({ code: 'invalid-approval', message: 'an approved reference must pin a SHA-256 image digest' });
    }
    for (const c of candidate.requiredCases) {
      const env = c.environment;
      if (!env.state?.trim() || !env.theme?.trim() ||
          !Number.isSafeInteger(env.viewport.width) || env.viewport.width <= 0 ||
          !Number.isSafeInteger(env.viewport.height) || env.viewport.height <= 0 ||
          c.target?.targetKind !== 'page-route' || c.target.targetId !== approval.data.targetRoute) {
        errors.push({ code: 'invalid-approval', message: `approved case '${c.caseId}' must name its state, viewport, theme and exact target route` });
      }
    }
  }

  if (candidate.requiredCases.length === 0) {
    errors.push({
      code: 'no-required-cases',
      message:
        'a ratified reference must declare at least one required case; with none, the gate has nothing to verify and would pass vacuously',
    });
  }

  const seen = new Set<string>();
  const seenTargets = new Map<string, string>();
  for (const c of candidate.requiredCases) {
    if (seen.has(c.caseId)) {
      errors.push({
        code: 'duplicate-case',
        message: `required case id '${c.caseId}' is declared more than once`,
      });
    }
    seen.add(c.caseId);

    /**
     * Two cases on one reference must not name the same surface.
     *
     * D-019 already forces every case onto the reference's single environment,
     * so `target` is the ONLY thing distinguishing one case from another. Two
     * cases sharing a target are therefore indistinguishable to the coverage
     * matcher, and one capture would satisfy both — requirement 9's failure
     * restated with an extra step. Rejecting it here keeps the matcher's
     * one-evidence-one-case property true by construction rather than by
     * convention.
     */
    const targetKey = `${c.target.targetKind}::${c.target.targetId}`;
    const priorCaseId = seenTargets.get(targetKey);
    if (priorCaseId !== undefined) {
      errors.push({
        code: 'duplicate-case-target',
        message:
          `required cases '${priorCaseId}' and '${c.caseId}' are both contracted against ` +
          `${c.target.targetKind} '${c.target.targetId}' at the same environment, so no comparison ` +
          `could ever satisfy one without satisfying the other; give them distinct surfaces or ` +
          `declare a single case`,
      });
    }
    seenTargets.set(targetKey, c.caseId);

    /**
     * A required case must be contracted at the SAME environment as the
     * reference itself (D-019, surfaced by P-007).
     *
     * A revision carries exactly one reference IMAGE, and `compare_render`
     * refuses — before any engine — a capture whose environment does not match
     * `referenceEnvironment`, because comparing a 1280x800 reference against a
     * 390x844 render measures the viewport difference rather than fidelity. So
     * a required case at any other environment can never be satisfied by any
     * comparison: every attempt returns `invalid: environment-mismatch`.
     *
     * Left unchecked, that produced a reference which looked stricter than a
     * single-case one and was in fact permanently unsatisfiable — a gate nobody
     * could ever pass, discovered only when someone tried. Multi-viewport and
     * multi-state coverage is expressed as SEVERAL references (one image each),
     * which the feature-level evidence gate aggregates.
     */
    if (!environmentsMatch(c.environment, candidate.referenceEnvironment)) {
      errors.push({
        code: 'case-environment-mismatch',
        message:
          `required case '${c.caseId}' is contracted at ${describeEnvironment(c.environment)} but the ` +
          `reference image is contracted at ${describeEnvironment(candidate.referenceEnvironment)}. ` +
          'A revision carries one image, and a comparison across environments is refused as ' +
          'environment-mismatch, so this case could never pass. Ratify a separate reference (with its ' +
          'own image) for each viewport or state that must be covered.',
      });
    }
  }

  if (previous) {
    if (candidate.identity.revision <= previous.identity.revision) {
      errors.push({
        code: 'revision-not-monotonic',
        message: `revision must increase: got ${candidate.identity.revision}, previous is ${previous.identity.revision}`,
      });
    }
    if (candidate.identity.referenceClass !== previous.identity.referenceClass) {
      errors.push({
        code: 'class-mismatch',
        message:
          `reference class cannot change across revisions of the same reference ` +
          `(${previous.identity.referenceClass} -> ${candidate.identity.referenceClass}); ` +
          'ratify a new reference instead',
      });
    }
  }

  if (
    candidate.identity.referenceClass === 'derived-reference' &&
    !candidate.provenance.derivedFrom
  ) {
    errors.push({
      code: 'missing-derivation',
      message:
        "a 'derived-reference' must record provenance.derivedFrom — the incommensurable reference it was derived from (D-007); without it the audit trail back to the original mockup is lost",
    });
  }

  return errors;
}

/**
 * Does revising a reference invalidate evidence bound to the old revision?
 *
 * Requirement 2 says yes, unconditionally. This function exists so that rule is
 * stated in one place and tested, rather than being re-derived at each call site
 * where someone might decide a "small" change should not invalidate.
 */
export function revisionInvalidatesEvidence(
  evidenceRevision: number,
  currentRevision: number,
): boolean {
  return evidenceRevision !== currentRevision;
}

/** Apply a revision: the old reference is superseded, the new one is active. */
export function superseded(
  previous: RatifiedReference,
  byRevision: number,
): RatifiedReference {
  return { ...previous, state: 'superseded', supersededByRevision: byRevision };
}

/**
 * Is this reference class eligible to carry a deterministic gate by default?
 *
 * This is only the STARTING position; calibration (P-002/P-008) records the
 * measured answer in the versioned policy, which is what actually governs.
 * D-007's reasoning: a model-painted raster is not commensurable with a real
 * render, so it starts advisory-only and must earn a gate, not lose one.
 */
export function defaultEligibilityFor(
  referenceClass: ReferenceClass,
): 'gateable' | 'advisory-only' {
  switch (referenceClass) {
    case 'artifact-capture':
    case 'figma-export':
    case 'derived-reference':
      return 'gateable';
    case 'raster-mockup':
      return 'advisory-only';
  }
}
