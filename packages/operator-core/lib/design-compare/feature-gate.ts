/**
 * P-007: the feature-level design-evidence obligation.
 *
 * `gate.ts` decides ONE reference. This composes the decision across every
 * reference a feature has, which under D-019 is how a feature covers more than
 * one viewport or interaction state — a revision carries one image, so a second
 * breakpoint is a second reference rather than a second required case.
 *
 * The composition is deliberately storage-DRIVEN. The set of references is
 * discovered from the store, never taken from the caller, because a gate that
 * asks which references to check is satisfied by naming none — which is not a
 * gate, it is a form to fill in.
 */
import { evaluateDesignGate, type DesignGateVerdict, renderDesignGateRefusal } from './gate';
import { DESIGN_GATE_DOES_NOT_ESTABLISH } from './gate';
import {
  describeEnforceability,
  evaluateEnforceability,
  type EnforceabilityOutcome,
} from './enforceability';
import type { FeatureScope, ReferenceStorePort } from './reference-store';
import { getDesignEvidenceVerb, type GetDesignEvidenceResult, type VerbCaller, type VerbDeps } from './verbs';
import { designAcceptanceRoot, readDesignAcceptance, type DesignAcceptanceResult } from './acceptance';

export interface FeatureGateReference {
  readonly referenceId: string;
  /** Authoritative approval identity from the existing evidence read. */
  readonly reference?: GetDesignEvidenceResult['reference'];
  readonly acceptance?: DesignAcceptanceResult;
  readonly verdict: DesignGateVerdict;
  /**
   * Whether this reference's verdict may REFUSE a completion, as opposed to
   * report (P-011/D-023). Carried beside the verdict rather than folded into it
   * because they answer different questions — the verdict is about the work,
   * this is about whether the threshold was measured for the machine involved.
   */
  readonly enforceability: EnforceabilityOutcome;
}

export type FeatureDesignGateResult =
  | {
      /** No reference under this feature is currently ratified (P-007: exploration is unrestricted). */
      readonly applicable: false;
      readonly references: readonly FeatureGateReference[];
    }
  | {
      readonly applicable: true;
      readonly satisfied: boolean;
      readonly references: readonly FeatureGateReference[];
      /** Only the references that are ratified AND unsatisfied. */
      readonly blocking: readonly FeatureGateReference[];
      /**
       * The subset of `blocking` whose threshold was actually measured for the
       * machine involved, and which may therefore refuse rather than report.
       *
       * A separate list rather than a boolean because the two populations get
       * different treatment in the same completion: an enforceable reference
       * refuses, an unenforceable one is reported, and collapsing them would
       * either refuse on an uncalibrated host or let a calibrated failure
       * through on the strength of an unrelated reference.
       */
      readonly enforceableBlocking: readonly FeatureGateReference[];
      readonly doesNotEstablish: readonly string[];
    };

/**
 * Thrown when the obligation could not be established at all.
 *
 * Separate from an unsatisfied verdict on purpose: "this work owes evidence it
 * does not have" and "we could not find out what this work owes" are different
 * facts, and collapsing them is how an unavailable store becomes a silent pass.
 * The caller decides the policy; this module refuses to guess.
 */
export class DesignGateUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DesignGateUnavailableError';
  }
}

export interface FeatureGateDeps {
  readonly store: ReferenceStorePort;
  /** The verb deps used to READ evidence, so the gate sees exactly what an agent sees. */
  readonly verbDeps: VerbDeps;
  readonly caller: VerbCaller;
  /** Tests can supply their isolated harness tree; production resolves the registry. */
  readonly acceptanceRoot?: string;
  readonly readAcceptanceRun?: Parameters<typeof readDesignAcceptance>[0]['readRun'];
}

/**
 * Evaluate every ratified reference under a feature.
 *
 * Reads through `get_design_evidence` rather than the store directly. That is a
 * reuse decision with a correctness consequence: the verb is where staleness,
 * schema-version mismatch and coverage are computed, and a gate that recomputed
 * them from raw rows would be a second implementation of the same rules — free
 * to drift, and drifting silently toward "current" is the direction that passes
 * work it should have stopped.
 */
export async function evaluateFeatureDesignGate(
  scope: FeatureScope,
  deps: FeatureGateDeps,
): Promise<FeatureDesignGateResult> {
  let referenceIds: readonly string[];
  try {
    referenceIds = await deps.store.listFeatureReferenceIds(scope);
  } catch (error) {
    throw new DesignGateUnavailableError(
      `could not list design references for '${scope.featureId}': ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const references: FeatureGateReference[] = [];
  for (const referenceId of referenceIds) {
    const read = await getDesignEvidenceVerb(
      { featureId: scope.featureId, referenceId },
      deps.caller,
      deps.verbDeps,
    );
    if (!read.ok) {
      // A reference we cannot read is not a reference we may ignore. Ignoring
      // it drops a real obligation on an infrastructure fault, which is exactly
      // the failure that looks like everything is fine.
      throw new DesignGateUnavailableError(
        `could not read design evidence for '${scope.featureId}'/'${referenceId}': ${read.code}${
          read.detail ? ` — ${read.detail}` : ''
        }`,
      );
    }
    const approval = read.reference?.approval;
    let acceptance: DesignAcceptanceResult | undefined;
    if (approval && read.reference) {
      if (!approval.acceptance) {
        acceptance = { satisfied: false, failures: [{ caseId: '*', reason: 'missing-acceptance-registration' }] };
      } else try {
        acceptance = await readDesignAcceptance({
          root: deps.acceptanceRoot ?? await designAcceptanceRoot(scope.harnessSlug),
          featureId: scope.featureId, referenceId,
          revision: read.reference.activeRevision, contentSha256: read.reference.contentSha256, approval,
          ...(deps.readAcceptanceRun ? { readRun: deps.readAcceptanceRun } : {}),
        });
      } catch {
        acceptance = { satisfied: false, failures: [{ caseId: '*', reason: 'current-identity-unavailable' }] };
      }
    }
    references.push({
      referenceId,
      reference: read.reference,
      ...(acceptance ? { acceptance } : {}),
      verdict: evaluateDesignGate(read),
      // Read from the reference's own ratification provenance, which the
      // completing agent cannot influence at completion time. Deriving it from
      // anything the completion supplies would make enforcement opt-out.
      enforceability: evaluateEnforceability(read.reference?.capturedOnRenderHost),
    });
  }

  return aggregateFeatureDesignGate(references);
}

/** Reused after work-item scope filtering; never invent a second aggregator. */
export function aggregateFeatureDesignGate(references: readonly FeatureGateReference[]): FeatureDesignGateResult {
  const applicable = references.filter((r) => r.verdict.applicable);
  if (applicable.length === 0) return { applicable: false, references };

  const blocking = applicable.filter((r) => {
    if (!r.verdict.applicable) return false;
    // An illustrative raster has no valid pixel threshold. Its explicitly
    // adopted structural/journey contract is the graded obligation instead.
    if (r.acceptance && r.reference?.referenceClass === 'raster-mockup') return !r.acceptance.satisfied;
    return !r.verdict.satisfied || r.acceptance?.satisfied === false;
  });
  return {
    applicable: true,
    satisfied: blocking.length === 0,
    references,
    blocking,
    enforceableBlocking: blocking.filter((r) => r.enforceability.enforceable || r.acceptance?.satisfied === false),
    doesNotEstablish: DESIGN_GATE_DOES_NOT_ESTABLISH,
  };
}

/**
 * Render the whole feature obligation as one message.
 *
 * One message rather than one per reference, for the same reason `gate.ts`
 * reports every failing case at once: an agent told about one unmet reference
 * fixes it, retries, and is refused again by the next.
 */
export function renderFeatureDesignGate(result: FeatureDesignGateResult): string | undefined {
  if (!result.applicable) return undefined;
  if (result.satisfied) {
    const n = result.references.filter((r) => r.verdict.applicable).length;
    if (result.references.some(row => row.acceptance)) {
      return `design evidence: ${n} ratified reference(s) satisfy their current proof obligations. ` +
        `Journey/state evidence includes the separate visual review; illustrative references do not establish pixel equivalence. ` +
        `This does NOT establish: ${DESIGN_GATE_DOES_NOT_ESTABLISH.join('; ')}.`;
    }
    return (
      `design evidence: ${n} ratified reference(s) have current passing evidence for every required case. ` +
      `This does NOT establish: ${DESIGN_GATE_DOES_NOT_ESTABLISH.join('; ')}.`
    );
  }
  const bodies = result.blocking
    .map((r) => {
      const acceptance = r.acceptance?.failures.map(f =>
        `design acceptance '${r.referenceId}' case '${f.caseId}': ${f.reason}`).join('\n');
      if (!(r.verdict.applicable && !r.verdict.satisfied)) return acceptance ?? '';
      const refusal = renderDesignGateRefusal(r.verdict);
      // A reference that failed but will NOT block has to say so in the same
      // breath. Otherwise the two outcomes an operator most needs to tell apart
      // — "this was checked and enforced" and "this was checked and could not
      // be enforced" — render identically, and a gate that quietly stopped
      // enforcing looks exactly like a gate that passed.
      const pixels = r.enforceability.enforceable
        ? refusal
        : `${refusal}\n${describeEnforceability(r.enforceability)}`;
      return [pixels, acceptance].filter(Boolean).join('\n');
    })
    .filter(Boolean);
  return bodies.join('\n\n');
}
