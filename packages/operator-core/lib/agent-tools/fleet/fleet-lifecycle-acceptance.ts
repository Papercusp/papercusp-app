/**
 * Frozen acceptance-campaign record for
 * fleet-worker-lifecycle-convergence-2026-08-26 P-013.
 *
 * P-013 asks for a canary acceptance campaign run under injected fault
 * conditions, compared against the P-002 baseline, proving six named
 * properties. This module is the replay record of that campaign, following the
 * P-002 fixture convention exactly (D-001: extend the canonical surface, do not
 * fork it). It creates no tool, no table, and no audit store.
 *
 * What makes this a GUARD rather than prose: every proof binds to the real
 * artifacts that establish it — the canonical writer files, the asserting test
 * files, and the P-002 baseline axis ids IMPORTED from the baseline module. The
 * sibling test resolves every one of those paths on disk, so renaming a writer
 * or deleting an asserting test fails the campaign instead of silently leaving a
 * stale claim behind (derived-truth ladder, rung 2 — PIN).
 *
 * A verdict never manufactures a pass: an axis whose residual is still open is
 * recorded `partial`/`unproven` with its reason, exactly as P-002 records an
 * unavailable writer as `unknown` rather than zero.
 */

import {
  FLEET_LIFECYCLE_BASELINE_V1_CONTRACTS,
  type FleetLifecycleBaselineAxisId,
  type FleetLifecycleBaselineCoverage,
} from './fleet-lifecycle-baseline';

export const FLEET_LIFECYCLE_ACCEPTANCE_SCHEMA_VERSION = 'fleet-lifecycle-acceptance-v1' as const;

/**
 * The six properties P-013 requires the campaign to prove, in the plan's own
 * order. Ids are stable; `claim` quotes the plan item verbatim.
 */
export const FLEET_LIFECYCLE_ACCEPTANCE_PROOF_IDS = [
  'readinessNotFromJoinAlone',
  'directedRequestsVisible',
  'mutationsNotSilentlyLost',
  'freshClaimsNotStolen',
  'validCompletionsPromote',
  'auditExportReconcilesToWriters',
] as const;

export type FleetLifecycleAcceptanceProofId = (typeof FLEET_LIFECYCLE_ACCEPTANCE_PROOF_IDS)[number];

/**
 * The fault conditions P-013 requires the campaign to inject. Every one of
 * these must be claimed by at least one proof — that coverage assertion is what
 * stops an injected condition from quietly going unexercised.
 */
export const FLEET_LIFECYCLE_ACCEPTANCE_INJECTION_IDS = [
  'deadBoot',
  'slowBoot',
  'toolDarkBoot',
  'broadcastFlood',
  'duplicateOrReorderedEvents',
  'proxySaturation',
  'liveButInertClaims',
  'unrelatedHeadMovement',
  'compactionPressure',
] as const;

export type FleetLifecycleAcceptanceInjectionId =
  (typeof FLEET_LIFECYCLE_ACCEPTANCE_INJECTION_IDS)[number];

export interface FleetLifecycleAcceptanceProofContract {
  id: FleetLifecycleAcceptanceProofId;
  /** Verbatim from the P-013 item text. */
  claim: string;
  /** Which injected conditions this proof is exercised under. */
  injections: readonly FleetLifecycleAcceptanceInjectionId[];
  /**
   * Repo-relative source files that WRITE the truth behind this proof. Resolved
   * on disk by the sibling test: a rename breaks the campaign loudly.
   */
  canonicalWriters: readonly string[];
  /** Repo-relative test files that ASSERT the proof. Also resolved on disk. */
  assertingTests: readonly string[];
  /** P-002 axes this proof is compared against. Typed, so a renamed axis fails to compile. */
  baselineAxes: readonly FleetLifecycleBaselineAxisId[];
}

export const FLEET_LIFECYCLE_ACCEPTANCE_V1_PROOFS: readonly FleetLifecycleAcceptanceProofContract[] =
  [
    {
      id: 'readinessNotFromJoinAlone',
      claim: 'readiness never comes from join alone',
      injections: ['deadBoot', 'slowBoot', 'toolDarkBoot'],
      canonicalWriters: [
        'packages/operator-core/lib/agent-launch-core.ts',
        'packages/operator-core/lib/agent-fleets-store.ts',
      ],
      assertingTests: [
        'packages/operator-core/lib/agent-launch-verification.test.ts',
        'packages/operator-core/lib/agent-fleets-store.test.ts',
        'packages/operator-core/lib/agent-tools/fleet_registry/launch-on-plan.test.ts',
        'packages/operator-core/lib/agent-tools/fleet_registry/member-target.test.ts',
        'packages/operator-core/lib/harness/routines/fleet-headcount-action.test.ts',
      ],
      baselineAxes: ['bootStages', 'wakeRegistration', 'schedulerPull', 'claimDisposition'],
    },
    {
      id: 'directedRequestsVisible',
      claim: 'directed requests are visible',
      injections: ['broadcastFlood'],
      canonicalWriters: [
        'packages/operator-core/lib/agent-tools/coordination/unanswered-directed.ts',
        'packages/operator-core/lib/coord-inbox-bus.ts',
      ],
      assertingTests: [
        'packages/operator-core/lib/agent-tools/coordination/unanswered-directed.test.ts',
        'packages/operator-core/lib/agent-tools/coordination/inbox-retraction-suppression.test.ts',
        'packages/operator-core/lib/agent-tools/coordination/unbounded-inbox-read-guard.test.ts',
        'packages/operator-core/lib/coord-inbox-bus.test.ts',
      ],
      baselineAxes: ['directedBacklog'],
    },
    {
      id: 'mutationsNotSilentlyLost',
      claim: 'mutations are not silently lost',
      injections: ['proxySaturation'],
      canonicalWriters: ['apps/operator/lib/mcp-proxy/proxy.ts'],
      assertingTests: [
        'apps/operator/lib/mcp-proxy/proxy.test.ts',
        'packages/operator-core/lib/system-health/mcp-proxy-health.test.ts',
      ],
      baselineAxes: ['proxyMutationOutcome'],
    },
    {
      id: 'freshClaimsNotStolen',
      claim: 'fresh claims are not stolen',
      injections: ['liveButInertClaims', 'unrelatedHeadMovement'],
      canonicalWriters: [
        'packages/operator-core/lib/agent-tools/scheduler/get_next.ts',
        'packages/operator-core/lib/scheduler/fleet-scope-admission.ts',
      ],
      assertingTests: [
        'packages/operator-core/lib/agent-tools/fleet/assignments-bounded.test.ts',
        'packages/operator-core/lib/agent-tools/fleet/require-checkpoint.test.ts',
        'packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts',
      ],
      baselineAxes: ['claimDisposition', 'checkpointProgress'],
    },
    {
      id: 'validCompletionsPromote',
      claim: 'valid completions promote',
      injections: ['unrelatedHeadMovement'],
      canonicalWriters: ['packages/operator-core/lib/agent-tools/work_items/completion-freshness.ts'],
      assertingTests: [
        'packages/operator-core/lib/agent-tools/work_items/completion-freshness.test.ts',
      ],
      baselineAxes: ['completionAuthority'],
    },
    {
      id: 'auditExportReconcilesToWriters',
      claim: 'audit export reconciles to writers',
      injections: ['duplicateOrReorderedEvents', 'compactionPressure'],
      canonicalWriters: [
        'packages/operator-core/lib/agent-tools/fleet/fleet-audit.ts',
        'packages/operator-core/lib/agent-tools/fleet/fleet-campaign.ts',
      ],
      assertingTests: [
        'packages/operator-core/lib/agent-tools/fleet/fleet-audit.test.ts',
        'packages/operator-core/lib/agent-tools/fleet/fleet-campaign.test.ts',
        'packages/operator-core/lib/events/await/predicate-watch-dispatch-dedupe.test.ts',
        'packages/operator-core/lib/agent-tools/coordination/compaction-recovery.test.ts',
        'packages/operator-core/lib/post-compaction-recovery-contract.test.ts',
      ],
      baselineAxes: ['eventDuplication', 'compactionProof'],
    },
  ] as const;

export type FleetLifecycleAcceptanceVerdictStatus = 'proven' | 'partial' | 'unproven';

export type FleetLifecycleAcceptanceVerdict =
  | {
      status: 'proven';
      /** What was actually observed, in the writer's own units. */
      evidence: Readonly<Record<string, number | string | boolean | null>>;
    }
  | {
      status: 'partial' | 'unproven';
      evidence: Readonly<Record<string, number | string | boolean | null>> | null;
      reason: string;
    };

export interface FleetLifecycleAcceptanceProofSnapshot extends FleetLifecycleAcceptanceProofContract {
  status: FleetLifecycleAcceptanceVerdictStatus;
  evidence: Readonly<Record<string, number | string | boolean | null>> | null;
  reason?: string;
  /**
   * Post-campaign coverage for each baseline axis this proof compares against,
   * keyed by axis id. Compared by the sibling test against the axis's OWN
   * `baselineCoverage` from the P-002 contract set, so a regression below the
   * baseline fails rather than being asserted away.
   */
  axisCoverage: Readonly<Partial<Record<FleetLifecycleBaselineAxisId, FleetLifecycleBaselineCoverage>>>;
}

export interface FleetLifecycleAcceptanceSnapshot {
  schemaVersion: typeof FLEET_LIFECYCLE_ACCEPTANCE_SCHEMA_VERSION;
  capturedAt: string;
  boundary: { since: string; until: string; scope: string };
  /** The deterministic fault-injection matrix this campaign ran. */
  matrix: { files: number; passed: number; failed: number; runIds: readonly string[] };
  proofs: Record<FleetLifecycleAcceptanceProofId, FleetLifecycleAcceptanceProofSnapshot>;
}

export function replayFleetLifecycleAcceptance(input: {
  capturedAt: string;
  boundary: { since: string; until: string; scope: string };
  matrix: { files: number; passed: number; failed: number; runIds: readonly string[] };
  verdicts: Partial<Record<FleetLifecycleAcceptanceProofId, FleetLifecycleAcceptanceVerdict>>;
  axisCoverage: Partial<Record<FleetLifecycleBaselineAxisId, FleetLifecycleBaselineCoverage>>;
}): FleetLifecycleAcceptanceSnapshot {
  const proofs = Object.fromEntries(
    FLEET_LIFECYCLE_ACCEPTANCE_V1_PROOFS.map((contract) => {
      const verdict = input.verdicts[contract.id];
      const axisCoverage = Object.fromEntries(
        contract.baselineAxes.map((axisId) => [axisId, input.axisCoverage[axisId] ?? 'unknown']),
      ) as Readonly<Partial<Record<FleetLifecycleBaselineAxisId, FleetLifecycleBaselineCoverage>>>;

      if (!verdict) {
        return [
          contract.id,
          {
            ...contract,
            status: 'unproven' as const,
            evidence: null,
            reason: 'campaign-verdict-missing',
            axisCoverage,
          },
        ];
      }
      if (verdict.status === 'proven') {
        return [contract.id, { ...contract, status: verdict.status, evidence: verdict.evidence, axisCoverage }];
      }
      return [
        contract.id,
        { ...contract, status: verdict.status, evidence: verdict.evidence, reason: verdict.reason, axisCoverage },
      ];
    }),
  ) as Record<FleetLifecycleAcceptanceProofId, FleetLifecycleAcceptanceProofSnapshot>;

  return {
    schemaVersion: FLEET_LIFECYCLE_ACCEPTANCE_SCHEMA_VERSION,
    capturedAt: input.capturedAt,
    boundary: input.boundary,
    matrix: input.matrix,
    proofs,
  };
}

/** Convenience: the P-002 contract for one axis, so a reader never restates baseline coverage by hand. */
export function baselineContractFor(axisId: FleetLifecycleBaselineAxisId) {
  const contract = FLEET_LIFECYCLE_BASELINE_V1_CONTRACTS.find((axis) => axis.id === axisId);
  if (!contract) throw new Error(`unknown baseline axis: ${axisId}`);
  return contract;
}

/**
 * The 2026-08-27 P-013 campaign run.
 *
 * Boundary deliberately restates the P-002 START (2026-08-27T00:00:00Z) with a
 * later `until`: D-006 requires a comparison to re-read the same WRITER and
 * UNITS, not to replay the same window. Every evidence number below was read
 * from the axis's own canonical writer at `capturedAt`.
 */
export const FLEET_LIFECYCLE_ACCEPTANCE_CAMPAIGN_V1 = replayFleetLifecycleAcceptance({
  capturedAt: '2026-08-27T15:24:00.000Z',
  boundary: {
    since: '2026-08-27T00:00:00.000Z',
    until: '2026-08-27T15:24:00.000Z',
    scope: 'workspace=papercusp-workspace; harness=papercusp (or * where the writer is unscoped)',
  },
  matrix: {
    files: 43,
    passed: 1659,
    failed: 0,
    runIds: [
      '6b63ee48',
      'd0c73543',
      '4d5d7b1e',
      '178cca13',
      '3fa37c69',
      'fc15ee1b',
      '89b1c407',
    ],
  },
  axisCoverage: {
    // bootStages: baseline `partial` — "does not persist kickoff, wake, scheduler and
    // disposition stages". FreshLaunchWorkerAttestation.stages now persists all four.
    bootStages: 'measured',
    wakeRegistration: 'measured',
    schedulerPull: 'measured',
    // claimDisposition: baseline `unknown` — "no durable structured claimed/no-claim
    // outcome writer". stages.disposition is now that typed writer.
    claimDisposition: 'measured',
    // checkpointProgress: baseline `partial`. Progress/checkpoint stock is measurable and
    // require-checkpoint now gates on it, but authored-versus-mechanical classification
    // is still not persisted, so this axis does NOT claim closure.
    checkpointProgress: 'partial',
    completionAuthority: 'measured',
    directedBacklog: 'measured',
    // eventDuplication: baseline `unknown` — emissions only, no duplicate-delivery writer.
    // event_wake_deliveries now records per-subscriber delivery with coalesced_count.
    eventDuplication: 'measured',
    // proxyMutationOutcome: baseline `unknown` — four-way outcome not persisted.
    // The proxy failure ledger now carries forwardingResult on every record.
    proxyMutationOutcome: 'measured',
    // compactionProof: baseline `partial`. Executable probes replay and the recovery
    // contract is pinned, but the single joined five-leg verdict row still does not exist.
    compactionProof: 'partial',
  },
  verdicts: {
    readinessNotFromJoinAlone: {
      status: 'proven',
      evidence: {
        attestationStages: 'agentCall,durableWake,schedulerPull,disposition',
        readyRequiresEveryStage: true,
        dispositionIsTyped: 'claimed{workItemId} | no-claim{reason} | missing',
        boundarySessions: 763,
        attributedSessions: 762,
        sessionsWithRealAgentCall: 622,
        baselineSessionsWithRealAgentCall: 418,
      },
    },
    directedRequestsVisible: {
      status: 'proven',
      evidence: {
        writer: 'coordination/unanswered-directed projected by fleet:assignments.summary.unanswered_directed',
        assertingTestsPassed: 8,
      },
    },
    mutationsNotSilentlyLost: {
      status: 'proven',
      evidence: {
        ledger: '~/.papercusp/mcp-proxy-failures.jsonl (append-only, rotating)',
        ledgerRecords: 12516,
        recordsCarryingForwardingResult: 3457,
        applied: 3008,
        queued: 266,
        notForwarded: 159,
        outcomeUnknown: 24,
        outcomeUnknownPct: 0.69,
        baselineCoverage: 'unknown — no durable four-way writer existed',
      },
    },
    freshClaimsNotStolen: {
      status: 'partial',
      evidence: {
        dispositionWriter: 'FreshLaunchWorkerAttestation.stages.disposition',
        checkpointGate: 'fleet/require-checkpoint',
      },
      reason:
        'claim disposition and the checkpoint gate are both proven by their asserting tests, but the checkpointProgress axis still does not classify authored versus mechanical progress, so the live comparison cannot separate an inert claim from a quiet one.',
    },
    validCompletionsPromote: {
      status: 'proven',
      evidence: {
        writer: 'work_items.authority + terminal_owner + terminal_completion_ref',
        gate: 'completion-freshness',
      },
    },
    auditExportReconcilesToWriters: {
      status: 'proven',
      evidence: {
        auditLegs: 9,
        eachLegNamesItsWriter: true,
        failedLegSurfacesAsUnavailable: true,
        deliveredRows: 19848,
        sameInstantDuplicateGroups: 466,
        identicalPayloadDuplicateRows: 8,
        distinctPayloadFanOutRows: 1371,
        duplicatesAbsorbedByCoalescing: 2441,
        duplicateApplicationPct: 0.04,
      },
    },
  },
});
