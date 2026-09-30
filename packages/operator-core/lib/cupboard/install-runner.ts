/**
 * Execute an install plan: authorize → retrieve → apply, rolling back on failure.
 *
 * `planInstall` / `planRollback` (entitled-delivery) decide WHAT to acquire and
 * with which intent; this module carries those steps out. It is deliberately
 * the only place where the three landed layers meet, and it composes each of
 * them wholesale rather than restating any of their rules:
 *
 * - AUTHORIZATION is `authorizeDelivery`, per step, with that step's intent —
 *   which is what carries yank semantics (D-007) into execution.
 * - DELIVERABILITY is never re-decided here (D-040 ruling 4). `authorizeDelivery`
 *   already delegates to `resolveDistributionSources`, and `retrieveArtifact`
 *   composes it again at fetch time; this module adds no third opinion.
 * - INTEGRITY is `retrieveArtifact`, which verifies the manifest root before any
 *   byte is fetched, verifies every chunk at the boundary, and returns `ok`
 *   only when the completed assembly commits to that root. There is no second
 *   verification door here — a second copy of those rules is what drifts.
 *
 * What this module DOES own is the part none of them can: the ordering, the
 * identity binding between the plan and the manifests actually resolved, and
 * the fact that a failed step must leave the machine where it started.
 */
import {
  beginRetrieval,
  retrieveArtifact,
  type ProviderRegistry,
  type RetrievalFailureCode,
  type RetrievalProgress,
} from '../p2p/artifact-package';
import type { ArtifactDistributionManifest, ArtifactDistributionState } from '../p2p/artifact-distribution';
import type { CupboardReleaseManifest } from './listing-manifest';
import {
  authorizeDelivery,
  releaseRef,
  type DeliveryIntent,
  type DeliveryRefusalCode,
  type EntitlementProjection,
  type InstallPlanResult,
  type InstalledRelease,
} from './entitled-delivery';

/** The successful half of a plan — the only thing that can be executed. */
export type InstallPlan = Extract<InstallPlanResult, { readonly ok: true }>;

export type StepFailureCode =
  | 'no-distribution-state'
  | 'no-distribution-manifest'
  | 'release-identity-mismatch'
  | DeliveryRefusalCode
  | RetrievalFailureCode
  | 'apply-failed';

export interface ApplyInput {
  readonly releaseRef: string;
  readonly intent: DeliveryIntent;
  /** The signed release manifest, taken from the distribution manifest that was verified. */
  readonly release: CupboardReleaseManifest;
  readonly distribution: ArtifactDistributionManifest;
  /** Verified progress: every declared chunk, each checked at the boundary. */
  readonly progress: RetrievalProgress;
  /**
   * True when these bytes are a YANKED release being served for an install that
   * already exists. The apply step should record it: the install works, but the
   * version is withdrawn and must not be offered to anyone new.
   */
  readonly servingYankedForExistingInstall: boolean;
}

export type StepOutcome =
  | { readonly releaseRef: string; readonly status: 'skipped'; readonly detail: string }
  | {
      readonly releaseRef: string;
      readonly status: 'applied';
      readonly intent: DeliveryIntent;
      readonly installed: InstalledRelease;
      readonly chunksFetched: number;
      readonly servingYankedForExistingInstall: boolean;
    }
  | {
      readonly releaseRef: string;
      readonly status: 'failed';
      readonly intent: DeliveryIntent;
      readonly code: StepFailureCode;
      readonly detail: string;
    };

export interface RevertOutcome {
  readonly releaseRef: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface RollbackReport {
  /** Steps reverted, newest-applied first. */
  readonly reverted: readonly RevertOutcome[];
  /**
   * Every applied step was successfully reverted. FALSE means the machine is in
   * a mixed state and a human or a repair pass must resolve it — which is why a
   * failing revert is reported rather than swallowed.
   */
  readonly complete: boolean;
  /** The version the plan named as the restore point, if any. */
  readonly restoreTo: InstalledRelease | null;
}

export type RunInstallResult =
  | {
      readonly ok: true;
      readonly operation: InstallPlan['operation'];
      readonly steps: readonly StepOutcome[];
      readonly installed: readonly InstalledRelease[];
    }
  | {
      readonly ok: false;
      readonly operation: InstallPlan['operation'];
      readonly steps: readonly StepOutcome[];
      readonly failure: { readonly releaseRef: string; readonly code: StepFailureCode; readonly detail: string };
      readonly rollback: RollbackReport;
    };

export interface InstallRunnerDeps {
  /** The distribution state for a release ref — the reduced event log for its stream. */
  readonly resolveDistribution: (
    ref: string,
  ) => ArtifactDistributionState | null | Promise<ArtifactDistributionState | null>;
  readonly registry: ProviderRegistry;
  /** Write the verified bytes into place. Throwing is the failure path. */
  readonly apply: (input: ApplyInput) => InstalledRelease | Promise<InstalledRelease>;
  /** Undo one applied step. Throwing marks the rollback incomplete; it is never swallowed. */
  readonly revert: (input: {
    readonly releaseRef: string;
    readonly restoreTo: InstalledRelease | null;
  }) => void | Promise<void>;
  /**
   * Resume a partial download. Returning existing progress is what makes a
   * large install restartable rather than refetched from zero.
   */
  readonly progressFor?: (
    ref: string,
    manifest: ArtifactDistributionManifest,
  ) => RetrievalProgress | null | Promise<RetrievalProgress | null>;
}

export interface RunInstallInput {
  readonly plan: InstallPlan;
  readonly subject: string;
  readonly entitlements: EntitlementProjection;
  readonly installed: ReadonlyMap<string, InstalledRelease>;
  readonly nowMs: number;
  readonly offline?: boolean;
  /**
   * Refs that need no entitlement. Named explicitly rather than inferred, and
   * empty by default, so a caller who forgets stays fail-closed: an unnamed
   * release is treated as paid and refused, never given away.
   */
  readonly freeReleaseRefs?: ReadonlySet<string>;
  readonly maxSourcesPerChunk?: number;
}

/**
 * Run an install plan to completion, or leave nothing behind.
 *
 * Steps execute in dependency order, and the first failure stops the run — a
 * dependency that could not be acquired must not be followed by an apply of the
 * thing that depends on it. Everything already applied is then reverted in
 * REVERSE order, so a dependent is always removed before the dependency it
 * needed.
 */
export async function runInstallPlan(
  deps: InstallRunnerDeps,
  input: RunInstallInput,
): Promise<RunInstallResult> {
  const { plan, subject, entitlements, nowMs } = input;
  const offline = input.offline ?? false;
  const freeRefs = input.freeReleaseRefs ?? new Set<string>();
  const steps: StepOutcome[] = [];
  const appliedOrder: string[] = [];
  const installed: InstalledRelease[] = [];

  const fail = async (
    ref: string,
    intent: DeliveryIntent,
    code: StepFailureCode,
    detail: string,
  ): Promise<RunInstallResult> => {
    steps.push({ releaseRef: ref, status: 'failed', intent, code, detail });
    const rollback = await revertApplied(deps, appliedOrder, plan.rollbackTo);
    return { ok: false, operation: plan.operation, steps, failure: { releaseRef: ref, code, detail }, rollback };
  };

  for (const step of plan.steps) {
    if (step.alreadySatisfied) {
      steps.push({
        releaseRef: step.releaseRef,
        status: 'skipped',
        detail: 'already installed at the wanted bytes — nothing to fetch or apply',
      });
      continue;
    }

    const state = await deps.resolveDistribution(step.releaseRef);
    if (!state) {
      return fail(step.releaseRef, step.intent, 'no-distribution-state', `no distribution stream for ${step.releaseRef}`);
    }
    const distribution = state.manifest;
    if (!distribution) {
      return fail(
        step.releaseRef,
        step.intent,
        'no-distribution-manifest',
        `distribution stream ${state.streamId} carries no manifest`,
      );
    }

    // Identity binding. The plan names a release; the stream hands back a
    // manifest. A correctly signed manifest for a DIFFERENT release is exactly
    // what a substitution attack delivers, so the two are checked against each
    // other before any authorization or byte is considered.
    const resolvedRef = releaseRef(distribution.release);
    if (resolvedRef !== step.releaseRef) {
      return fail(
        step.releaseRef,
        step.intent,
        'release-identity-mismatch',
        `plan step names ${step.releaseRef}, stream ${state.streamId} describes ${resolvedRef}`,
      );
    }

    const authorization = authorizeDelivery({
      subject,
      manifest: distribution.release,
      distribution: state,
      entitlements,
      intent: step.intent,
      nowMs,
      offline,
      freeRelease: freeRefs.has(step.releaseRef),
    });
    if (!authorization.deliverable) {
      const code = authorization.code === 'ok' ? 'no-sources' : authorization.code;
      return fail(step.releaseRef, step.intent, code, authorization.detail);
    }

    const resumed = (await deps.progressFor?.(step.releaseRef, distribution)) ?? null;
    const progress = resumed ?? beginRetrieval(distribution);

    const outcome = await retrieveArtifact(state, progress, {
      registry: deps.registry,
      nowMs,
      offline,
      // The SAME intent the authorization was granted under. Retrieval resolves
      // deliverability again (correctly — it is the one decision point);
      // without the intent it would resolve a repair as a fresh acquisition and
      // refuse bytes this caller was just authorized for.
      intent: step.intent,
      ...(authorization.keyVersion !== null ? { keyVersion: authorization.keyVersion } : {}),
      ...(input.maxSourcesPerChunk !== undefined ? { maxSourcesPerChunk: input.maxSourcesPerChunk } : {}),
    });
    if (!outcome.ok) {
      const first = outcome.failures[0];
      return fail(
        step.releaseRef,
        step.intent,
        outcome.reason === 'ok' ? 'chunk-unavailable' : outcome.reason,
        first ? `${outcome.reason}: ${first.code} from ${first.sourceId || 'no source'} — ${first.detail}` : outcome.reason,
      );
    }

    // No second verification pass. `retrieveArtifact` returns ok only after the
    // manifest root was checked, every chunk verified at the boundary, and the
    // completed assembly re-committed to that root; re-deriving that verdict
    // here would be the second door this module exists to avoid.
    let record: InstalledRelease;
    try {
      record = await deps.apply({
        releaseRef: step.releaseRef,
        intent: step.intent,
        release: distribution.release,
        distribution,
        progress: outcome.progress,
        servingYankedForExistingInstall: authorization.servingYankedForExistingInstall,
      });
    } catch (error) {
      return fail(
        step.releaseRef,
        step.intent,
        'apply-failed',
        error instanceof Error ? error.message : String(error),
      );
    }

    appliedOrder.push(step.releaseRef);
    installed.push(record);
    steps.push({
      releaseRef: step.releaseRef,
      status: 'applied',
      intent: step.intent,
      installed: record,
      chunksFetched: outcome.fetched.length,
      servingYankedForExistingInstall: authorization.servingYankedForExistingInstall,
    });
  }

  return { ok: true, operation: plan.operation, steps, installed };
}

/**
 * Revert applied steps in reverse order.
 *
 * Reverse order matters: a dependent must be removed before the dependency it
 * was installed against, or the intermediate state is one where something is
 * present but its requirement is already gone. Every revert is attempted even
 * after one fails — stopping early would strand strictly more than continuing —
 * and each result is reported.
 */
async function revertApplied(
  deps: InstallRunnerDeps,
  appliedOrder: readonly string[],
  restoreTo: InstalledRelease | null,
): Promise<RollbackReport> {
  const reverted: RevertOutcome[] = [];
  for (const ref of [...appliedOrder].reverse()) {
    try {
      await deps.revert({ releaseRef: ref, restoreTo });
      reverted.push({ releaseRef: ref, ok: true, detail: 'reverted' });
    } catch (error) {
      reverted.push({
        releaseRef: ref,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { reverted, complete: reverted.every((entry) => entry.ok), restoreTo };
}
