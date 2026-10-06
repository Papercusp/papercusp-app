/**
 * The `teardown.resource-census` release receipt (R-6 "eight-kind residue", WI-10002510), recorded by
 * the destroy that OBSERVES it. A destroy reports success only once every owned resource carries a
 * provider-read absence receipt AND an independent all-kind provider census settled clean
 * (provisioning-runner.ts). The receipt is the release-level claim "bundle B's host tore down leaving
 * no residue across these resource kinds", so its identity names the kinds, and a census whose
 * inventory did not cover every one of them cannot commit it — clean over fewer kinds is not clean.
 */
import type { ReleaseTaskLedger } from '../../../../scripts/lib/release-task-journal.mjs';
import { workspaceHostBillingClosureStage, type WorkspaceHostBillingSubject } from './billing-closure-release-receipt';
import { workspaceHostCensusProfile } from './census-profiles';
import type { WorkspaceHostResourceCensus } from './gcp-safety';
import {
  openWorkspaceHostReleaseRecorder,
  type WorkspaceHostReleaseRecorder,
  type WorkspaceHostReleaseStage,
} from './release-stage-receipt';

export const WORKSPACE_HOST_RESOURCE_CENSUS_STAGE = 'teardown.resource-census';

/**
 * `billing-closure` is only OPENED here: the destroy cannot measure final spend, so the deferred-spend
 * reconciler settles it later (billing-closure-release-receipt.ts, D-395).
 */
export type WorkspaceHostTeardownReleaseRecorder = WorkspaceHostReleaseRecorder<'resource-census' | 'billing-closure'>;

/**
 * The census stage is bound to the provider whose population it judges: its identity names the
 * provider and that provider's full kind set, so a release journal opened for a GCP host can never be
 * closed by an AWS census (or the reverse).
 */
export function workspaceHostResourceCensusStage(provider: string): WorkspaceHostReleaseStage {
  const profile = workspaceHostCensusProfile(provider);
  return {
    stage: WORKSPACE_HOST_RESOURCE_CENSUS_STAGE,
    identity: { provider: profile.target, kinds: [...profile.kinds].sort() },
  };
}

/** Judge the census stage from the terminal census itself: clean, complete, and covering every kind. */
export function workspaceHostResourceCensusOutcome(input: {
  subject: { workspaceId: string; hostId: string };
  disposition: string;
  /** The provider whose kind set the census must cover ('gcp', 'aws'). */
  provider: string;
  census: WorkspaceHostResourceCensus;
}): { outcome: 'committed' | 'refused'; evidenceRefs: string[] } {
  const { census } = input;
  const covered = new Set(census.inventoryEvidence.map((evidence) => evidence.kind));
  const uncovered = workspaceHostCensusProfile(input.provider).kinds.filter((kind) => !covered.has(kind));
  const evidenceRefs = [
    `census-host:${input.subject.workspaceId}/${input.subject.hostId}`,
    `census-disposition:${input.disposition}`,
    `census-evaluated-at:${census.evaluatedAt}`,
    ...census.inventoryEvidence.map(
      (evidence) => `census-kind:${evidence.kind}:${evidence.strategy}:${evidence.providerEvidenceRef.slice(0, 300)}`,
    ),
    `census-managed:${census.managed.length}`,
    `census-untracked:${census.untracked.length}`,
    `census-missing:${census.missing.length}`,
    `census-label-mismatches:${census.labelMismatches.length}`,
    ...uncovered.map((kind) => `census-uncovered:${kind}`),
  ];
  const clean = census.clean && census.controllerIndependent && census.inventoryComplete && uncovered.length === 0;
  return { outcome: clean ? 'committed' : 'refused', evidenceRefs };
}

/** The census and billing stages, checked read-only before the destroy mutates anything. */
export function openWorkspaceHostTeardownRelease(input: {
  releaseTaskId: string;
  workspaceId: string;
  hostId: string;
  operationId: string;
  /** The provider whose resource population the census stage judges ('gcp', 'aws'). */
  provider: string;
  /** The canary run whose spend the reconciler will settle; a release-bound destroy always has one. */
  billing: WorkspaceHostBillingSubject;
  ledger?: ReleaseTaskLedger;
  readHostRuntimeRelease?: (workspaceId: string, hostId: string) => Promise<unknown>;
}): Promise<WorkspaceHostTeardownReleaseRecorder> {
  const { operationId, billing, provider, ...rest } = input;
  return openWorkspaceHostReleaseRecorder({
    ...rest,
    stages: {
      'resource-census': workspaceHostResourceCensusStage(provider),
      'billing-closure': workspaceHostBillingClosureStage(billing),
    },
    runRef: `destroy-operation:${operationId}`,
  });
}

/**
 * Why a release-bound destroy is refused before anything else, or null when it may proceed. Billing
 * closes only from the reconciler's reading of a deferred canary settlement (D-395), so a destroy
 * without one would leave the release's billing milestone pending forever.
 */
export function workspaceHostTeardownReleaseRefusal(canary: {
  runId: string;
  maxSpendCents?: number;
  spendSettlement?: { status: 'deferred' };
} | null | undefined): string | null {
  if (!canary) {
    return 'a release-bound destroy must carry canary cost evidence: billing.closure is judged only from the provider billing export (D-395)';
  }
  if (canary.spendSettlement?.status !== 'deferred') {
    return 'a release-bound destroy must defer spend settlement: billing.closure is judged only from the provider billing export, never from cited cost evidence (D-395)';
  }
  return null;
}

export function workspaceHostTeardownBillingSubject(canary: { runId: string; maxSpendCents?: number }): WorkspaceHostBillingSubject {
  return { runId: canary.runId, maxSpendCents: canary.maxSpendCents ?? null };
}
