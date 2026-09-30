/**
 * Frozen, writer-defined lifecycle baseline captured for
 * fleet-worker-lifecycle-convergence-2026-08-26 P-002.
 *
 * This is a replay fixture, not a live SLO and not another audit store. It names
 * the canonical writer and units for every requested lifecycle axis, preserves
 * the 2026-08-27 observation boundary, and represents an unavailable writer as
 * `status:'unknown', values:null` rather than a manufactured zero. Later fault
 * tests can replay this exact input while production readers continue to own the
 * live truth.
 */

export const FLEET_LIFECYCLE_BASELINE_SCHEMA_VERSION = 'fleet-lifecycle-baseline-v1' as const;

export const FLEET_LIFECYCLE_BASELINE_AXIS_IDS = [
  'bootStages',
  'wakeRegistration',
  'schedulerPull',
  'claimDisposition',
  'checkpointProgress',
  'completionAuthority',
  'directedBacklog',
  'eventDuplication',
  'proxyMutationOutcome',
  'compactionProof',
] as const;

export type FleetLifecycleBaselineAxisId = (typeof FLEET_LIFECYCLE_BASELINE_AXIS_IDS)[number];
export type FleetLifecycleBaselineCoverage = 'measured' | 'partial' | 'unknown';
export type FleetLifecycleBaselineValues = Readonly<Record<string, number | string | boolean | null>>;

export interface FleetLifecycleBaselineAxisContract {
  id: FleetLifecycleBaselineAxisId;
  writer: string;
  units: Readonly<Record<string, string>>;
  baselineCoverage: FleetLifecycleBaselineCoverage;
  residualOwner: string;
  limitation?: string;
}

/**
 * P-002's source-of-units manifest. Writer strings intentionally name the
 * source columns/functions, not friendly metric aliases: a reader must be able
 * to trace each number back to the code that writes it.
 */
export const FLEET_LIFECYCLE_BASELINE_V1_CONTRACTS: readonly FleetLifecycleBaselineAxisContract[] = [
  {
    id: 'bootStages',
    writer: 'harness_shared.adv_sessions + harness_shared.tool_invocations; agent-launch-core.probeFreshLaunchSessions',
    units: {
      sessions: 'adv_sessions rows first-seen in the explicit boundary',
      attributedSessions: 'those rows carrying coord_owner_id',
      sessionsWithRealAgentCall:
        "distinct sessions whose owner emitted an ok, agent-origin call excluding activity:report and coord:glance",
    },
    baselineCoverage: 'partial',
    residualOwner: 'P-003',
    limitation: 'The current writer proves a real call but does not persist kickoff, wake, scheduler, and disposition stages.',
  },
  {
    id: 'wakeRegistration',
    writer: 'harness_shared.session_briefs.control_state.wakeSource; coordination/control-anchor',
    units: {
      controlRows: 'current session_briefs rows with a control_state',
      loopWake: "rows whose wakeSource is 'loop'",
      eventWake: "rows whose wakeSource is 'event'",
      ownerWake: "rows whose wakeSource is 'owner'",
      noWakeSource: 'rows whose wakeSource is absent/none',
    },
    baselineCoverage: 'measured',
    residualOwner: 'P-003',
  },
  {
    id: 'schedulerPull',
    writer: 'harness_shared.tool_invocations rows for scheduler:get_next',
    units: {
      pulls: 'tool invocation rows in the explicit boundary',
      okRows: "rows whose invocation status is 'ok'",
      nonOkRows: "rows whose invocation status is not 'ok'",
      distinctCallers: 'distinct coord_owner_id values on those rows',
    },
    baselineCoverage: 'measured',
    residualOwner: 'P-003',
  },
  {
    id: 'claimDisposition',
    writer: 'scheduler:get_next response envelope (not durably projected into a structured outcome writer)',
    units: {
      claimed: 'successful pull responses carrying a claimed item',
      noClaim: 'successful pull responses carrying a typed no-claim diagnosis',
    },
    baselineCoverage: 'unknown',
    residualOwner: 'P-003',
    limitation: 'tool_invocations records the call/status but not the structured claimed/no-claim result.',
  },
  {
    id: 'checkpointProgress',
    writer: 'harness_shared.work_items.last_progress_at + harness_shared.carry_notes workitem:* scopes',
    units: {
      heldNonterminal: 'claimed, non-terminal, non-observation work-item rows',
      withProgressAnchor: 'those rows with last_progress_at',
      withCheckpointBody: 'those rows with a non-empty work-item carry note',
    },
    baselineCoverage: 'partial',
    residualOwner: 'P-005',
    limitation: 'The stock does not yet classify authored/evidenced progress versus mechanical checkpoint activity.',
  },
  {
    id: 'completionAuthority',
    writer: 'harness_shared.work_items.authority + terminal_owner + terminal_completion_ref; work_items:completion_stats',
    units: {
      terminalTotal: 'terminal work-item rows',
      genuineCompletions: 'terminal rows carrying owner plus completion ref or authority judgement',
      dedupOrUnverified: 'terminalTotal minus genuineCompletions',
      gateJudged: 'terminal rows with an explicit authority judgement',
    },
    baselineCoverage: 'measured',
    residualOwner: 'P-010',
  },
  {
    id: 'directedBacklog',
    writer: 'coordination/unanswered-directed projected by fleet:assignments.summary.unanswered_directed',
    units: {
      inScopeAgents: 'full decorated assignment population before payload trimming',
      agentsWithUnansweredDirected: 'agents with one or more unresolved directed messages',
    },
    baselineCoverage: 'measured',
    residualOwner: 'P-009',
  },
  {
    id: 'eventDuplication',
    writer: 'harness_shared.event_key_fires.fire_count (emissions only; no duplicate-delivery writer)',
    units: {
      duplicateDeliveries: 'same generation/delivery applied more than once by one consumer',
    },
    baselineCoverage: 'unknown',
    residualOwner: 'P-007',
    limitation: 'fire_count is a lifetime emission count and cannot be compared to duplicate delivery/application.',
  },
  {
    id: 'proxyMutationOutcome',
    writer: 'MCP transport response (no durable not_forwarded/queued/applied/outcome_unknown ledger)',
    units: {
      notForwarded: 'mutations rejected before forwarding',
      queued: 'mutations durably queued for later forwarding',
      applied: 'mutations whose application is confirmed',
      outcomeUnknown: 'mutations whose transport ended without an application verdict',
    },
    baselineCoverage: 'unknown',
    residualOwner: 'P-008',
    limitation: 'The transport reports individual failures, but the four-way outcome is not persisted for baseline replay.',
  },
  {
    id: 'compactionProof',
    writer: 'carry_notes checks + continuity-probes wake/orient replay',
    units: {
      executableProbeFramework: 'whether schema-current read-only continuity probes can execute after wake',
      fullProofWriter: 'one durable row joining generation, pressure drop, checkpoint hash, identity, and claim continuity',
    },
    baselineCoverage: 'partial',
    residualOwner: 'P-011',
    limitation: 'Executable probes exist, but the complete five-leg compaction proof is not yet one canonical verdict.',
  },
] as const;

export type FleetLifecycleBaselineReading =
  | { status: 'measured'; values: FleetLifecycleBaselineValues }
  | { status: 'partial'; values: FleetLifecycleBaselineValues; reason: string }
  | { status: 'unknown'; reason: string };

export interface FleetLifecycleBaselineAxisSnapshot extends FleetLifecycleBaselineAxisContract {
  status: FleetLifecycleBaselineCoverage;
  values: FleetLifecycleBaselineValues | null;
  reason?: string;
}

export interface FleetLifecycleBaselineSnapshot {
  schemaVersion: typeof FLEET_LIFECYCLE_BASELINE_SCHEMA_VERSION;
  capturedAt: string;
  boundary: { since: string; scope: string };
  axes: Record<FleetLifecycleBaselineAxisId, FleetLifecycleBaselineAxisSnapshot>;
}

export function replayFleetLifecycleBaseline(input: {
  capturedAt: string;
  boundary: { since: string; scope: string };
  readings: Partial<Record<FleetLifecycleBaselineAxisId, FleetLifecycleBaselineReading>>;
}): FleetLifecycleBaselineSnapshot {
  const axes = Object.fromEntries(
    FLEET_LIFECYCLE_BASELINE_V1_CONTRACTS.map((contract) => {
      const reading = input.readings[contract.id];
      if (!reading) {
        return [
          contract.id,
          { ...contract, status: 'unknown' as const, values: null, reason: 'fixture-reading-missing' },
        ];
      }
      if (reading.status === 'unknown') {
        return [contract.id, { ...contract, status: reading.status, values: null, reason: reading.reason }];
      }
      return [
        contract.id,
        {
          ...contract,
          status: reading.status,
          values: reading.values,
          ...(reading.status === 'partial' ? { reason: reading.reason } : {}),
        },
      ];
    }),
  ) as Record<FleetLifecycleBaselineAxisId, FleetLifecycleBaselineAxisSnapshot>;

  return {
    schemaVersion: FLEET_LIFECYCLE_BASELINE_SCHEMA_VERSION,
    capturedAt: input.capturedAt,
    boundary: input.boundary,
    axes,
  };
}

/**
 * Fresh 2026-08-27 writer snapshot. These values are historical fixture input,
 * never thresholds: D-003 requires every later comparison to take a new reading
 * from the same named writer and units.
 */
export const FLEET_LIFECYCLE_BASELINE_FIXTURE_V1 = replayFleetLifecycleBaseline({
  capturedAt: '2026-08-27T04:32:41.476Z',
  boundary: {
    since: '2026-08-27T00:00:00.000Z',
    scope: 'workspace=papercusp-workspace; harness=papercusp (or * where the writer is unscoped)',
  },
  readings: {
    bootStages: {
      status: 'partial',
      values: { sessions: 478, attributedSessions: 478, sessionsWithRealAgentCall: 418 },
      reason: 'real agent call is measurable; the full typed boot-stage chain is not persisted',
    },
    wakeRegistration: {
      status: 'measured',
      values: { controlRows: 5131, loopWake: 1942, eventWake: 266, ownerWake: 0, noWakeSource: 2923 },
    },
    schedulerPull: {
      status: 'measured',
      values: { pulls: 700, okRows: 687, nonOkRows: 13, distinctCallers: 289 },
    },
    claimDisposition: {
      status: 'unknown',
      reason: 'no durable structured claimed/no-claim outcome writer at the baseline boundary',
    },
    checkpointProgress: {
      status: 'partial',
      values: { heldNonterminal: 68, withProgressAnchor: 56, withCheckpointBody: 57 },
      reason: 'progress/checkpoint stock is measurable; authored-versus-mechanical classification is not',
    },
    completionAuthority: {
      status: 'measured',
      values: { terminalTotal: 49916, genuineCompletions: 25875, dedupOrUnverified: 24041, gateJudged: 13896 },
    },
    directedBacklog: {
      status: 'measured',
      values: { inScopeAgents: 57, agentsWithUnansweredDirected: 4 },
    },
    eventDuplication: {
      status: 'unknown',
      reason: 'event_key_fires counts emissions, not duplicate delivery/application',
    },
    proxyMutationOutcome: {
      status: 'unknown',
      reason: 'no durable four-way proxy mutation outcome writer at the baseline boundary',
    },
    compactionProof: {
      status: 'partial',
      values: { executableProbeFramework: true, fullProofWriter: false },
      reason: 'schema-current continuity probes exist; the joined five-leg verdict does not',
    },
  },
});
