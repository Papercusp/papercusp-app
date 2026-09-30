/**
 * Canonical server-side scope resolver and matcher kernel for fleet metrics.
 *
 * Consumers bring work-item rows or lifecycle events; this module resolves the
 * one fleet/spec/window/membership context and applies the scheduler's own claim
 * matcher. No consumer may retype a lane regex or silently substitute today's
 * spec when an historical revision is missing.
 */
import type { AgentFleetRecord } from '../../agent-fleets-store';
import { getFleet } from '../../agent-fleets-store';
import type { WorkItem } from '../../work-items';
import type { ClaimSpec } from '../../scheduler/claim-spec';
import { validateClaimSpec } from '../../scheduler/claim-spec';
import { matchesWorkItemClaimSpec } from '../../scheduler/claim-spec-match';
import type { ResolvedFleetClaimSpec } from '../../scheduler/claim-spec-store';
import { resolveFleetClaimSpec, fleetSpecBeeKey } from '../../scheduler/claim-spec-store';
import type { ClaimSpecRevisionWindow } from '../../scheduler/claim-spec-revisions';
import { CLAIM_SPEC_HISTORY_MAX, readClaimSpecRevisions } from '../../scheduler/claim-spec-revisions';
import { fleetEverMembers } from '../../fleet-membership-store';
import type { ListFleetRosterResult } from '../../fleet/fleet-roster';
import { listFleetRosterDiagnosed } from '../../fleet/fleet-roster';
import {
  FLEET_METRIC_COMPARISON_RULE,
  FLEET_METRIC_POPULATIONS,
  FLEET_METRIC_WRITERS,
  FLEET_METRICS_SCHEMA_VERSION,
  fleetMetricScopeSchema,
  type FleetMetricQuality,
  type FleetMetricScope,
  type FleetMetricsResult,
} from './fleet-metrics-contract';
import {
  buildFleetPopulationLifecycle,
  type FleetPopulationLifecycleSnapshot,
} from './fleet-population';

export type FleetMetricFlowMode = 'current-spec' | 'at-event-spec';

export interface FleetMetricScopeRequest {
  workspaceId: string;
  harness: string;
  fleet: string;
  flowMode: FleetMetricFlowMode;
  staleAfterMs?: number;
  historyLimit?: number;
}

type FleetMetricUnavailable = Extract<FleetMetricsResult, { ok: false }>;

export interface FleetMetricSpecSegment {
  revision: number;
  spec: ClaimSpec;
  startAt: string | null;
  endAt: string;
  source: 'current' | 'history';
  cause: 'current' | 'update' | 'delete';
}

export interface ResolvedFleetMetricScope {
  ok: true;
  schemaVersion: typeof FLEET_METRICS_SCHEMA_VERSION;
  generatedAt: string;
  scope: FleetMetricScope;
  quality: FleetMetricQuality;
  claimSpec: {
    current: ClaimSpec;
    segments: FleetMetricSpecSegment[];
    historyReturned: number;
    historyMore: boolean;
  };
  currentRoster: {
    ownerIds: string[];
    writer: 'fleet-roster';
  };
  everMemberIds: string[];
  /** Canonical population/lifecycle view shared with fleet status and leader brief. */
  populationLifecycle: FleetPopulationLifecycleSnapshot;
}

export type FleetMetricScopeResolution = ResolvedFleetMetricScope | FleetMetricUnavailable;

export interface FleetMetricScopeDeps {
  getFleet(workspaceId: string, fleetSlug: string): Promise<AgentFleetRecord | null>;
  resolveFleetClaimSpec(args: { spec: string; workspaceId?: string }): Promise<ResolvedFleetClaimSpec | null>;
  readClaimSpecRevisions(args: {
    cupId: string;
    workspaceId?: string;
    limit?: number;
  }): Promise<ClaimSpecRevisionWindow>;
  listFleetRosterDiagnosed(args: { fleetSlug: string; workspaceId?: string | null }): Promise<ListFleetRosterResult>;
  fleetEverMembers(fleetSlug: string, opts: { workspaceId?: string }): Promise<Set<string>>;
  now(): number;
}

const DEFAULT_DEPS: FleetMetricScopeDeps = {
  getFleet: (workspaceId, fleetSlug) => getFleet(workspaceId, fleetSlug),
  resolveFleetClaimSpec: (args) => resolveFleetClaimSpec(args),
  readClaimSpecRevisions: (args) => readClaimSpecRevisions(args),
  listFleetRosterDiagnosed: (args) => listFleetRosterDiagnosed(args),
  fleetEverMembers: (fleetSlug, opts) => fleetEverMembers(fleetSlug, opts),
  now: () => Date.now(),
};

function unavailable(request: FleetMetricScopeRequest, reason: string, recoverVia: string): FleetMetricUnavailable {
  return {
    ok: false,
    schemaVersion: FLEET_METRICS_SCHEMA_VERSION,
    error: 'fleet_metrics_unavailable',
    reason,
    recoverVia,
    requested: {
      fleet: request.fleet,
      harness: request.harness,
      flowMode: request.flowMode,
      window: 'fleet-lifetime',
    },
  };
}

function iso(value: string | number): string | null {
  const time = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function historicalSpec(value: unknown, revision: number): ClaimSpec | null {
  const parsed = validateClaimSpec(value);
  return parsed.ok && parsed.spec ? { ...parsed.spec, revision } : null;
}

function buildSegments(args: {
  current: ResolvedFleetClaimSpec;
  history: ClaimSpecRevisionWindow;
  windowStart: string;
  windowEnd: string;
}): FleetMetricSpecSegment[] | null {
  const currentAt = iso(args.current.record.updatedAt ?? '');
  const currentRevision = args.current.record.revision;
  if (!currentAt || currentRevision == null) return null;

  const history = [...args.history.revisions].sort((a, b) => Date.parse(b.supersededAt) - Date.parse(a.supersededAt));
  const segments: FleetMetricSpecSegment[] = [];
  const currentStart =
    history.length === 0 && currentRevision <= 1 && !args.history.more ? args.windowStart : currentAt;
  if (Date.parse(currentStart) < Date.parse(args.windowEnd)) {
    segments.push({
      revision: currentRevision,
      spec: args.current.record.spec,
      startAt: currentStart,
      endAt: args.windowEnd,
      source: 'current',
      cause: 'current',
    });
  }

  for (let index = 0; index < history.length; index += 1) {
    const row = history[index]!;
    const spec = historicalSpec(row.spec, row.revision);
    const endAt = iso(row.supersededAt);
    if (!spec || !endAt) return null;
    const older = history[index + 1];
    const startAt = older ? iso(older.supersededAt) : args.history.more ? null : args.windowStart;
    if (startAt && Date.parse(startAt) >= Date.parse(endAt)) continue;
    segments.push({
      revision: row.revision,
      spec,
      startAt,
      endAt,
      source: 'history',
      cause: row.cause,
    });
  }
  return segments;
}

async function resolveFleetMetricScopeUnsafe(
  request: FleetMetricScopeRequest,
  deps: FleetMetricScopeDeps = DEFAULT_DEPS,
): Promise<FleetMetricScopeResolution> {
  const fleet = await deps.getFleet(request.workspaceId, request.fleet);
  if (!fleet) return unavailable(request, 'fleet identity was not found', 'fleet:status { fleet }');

  const generatedAtMs = deps.now();
  if (!Number.isFinite(generatedAtMs) || generatedAtMs <= fleet.createdAt) {
    return unavailable(request, 'fleet-lifetime window is not yet measurable', 'fleet:status { fleet }');
  }
  const generatedAt = new Date(generatedAtMs).toISOString();
  const windowStart = new Date(fleet.createdAt).toISOString();

  const [resolved, roster, everMembers] = await Promise.all([
    deps.resolveFleetClaimSpec({ spec: request.fleet, workspaceId: request.workspaceId }),
    deps.listFleetRosterDiagnosed({ fleetSlug: request.fleet, workspaceId: request.workspaceId }),
    deps.fleetEverMembers(request.fleet, { workspaceId: request.workspaceId }),
  ]);
  if (!resolved || resolved.record.source !== 'fleet' || resolved.record.revision == null) {
    return unavailable(
      request,
      'fleet claim spec could not be resolved without a default-spec fallback',
      'scheduler:get_claim_spec { fleet }',
    );
  }
  if (roster.degradedLegs.length > 0) {
    return unavailable(
      request,
      `current roster read degraded: ${roster.degradedLegs.join(', ')}`,
      'fleet:status { fleet }',
    );
  }

  const historyLimit = Math.max(
    1,
    Math.min(CLAIM_SPEC_HISTORY_MAX, Math.trunc(request.historyLimit ?? CLAIM_SPEC_HISTORY_MAX)),
  );
  const history =
    request.flowMode === 'at-event-spec'
      ? await deps.readClaimSpecRevisions({
          cupId: fleetSpecBeeKey(resolved.fleetSlug),
          workspaceId: request.workspaceId,
          limit: historyLimit,
        })
      : { subject: fleetSpecBeeKey(resolved.fleetSlug), revisions: [], returned: 0, more: false };

  if (request.flowMode === 'at-event-spec' && history.revisions.length === 0 && resolved.record.revision > 1) {
    return unavailable(
      request,
      'current claim-spec revision has no recoverable historical revisions',
      'scheduler:get_claim_spec { fleet, history }',
    );
  }
  const segments = buildSegments({ current: resolved, history, windowStart, windowEnd: generatedAt });
  if (!segments) {
    return unavailable(
      request,
      'claim-spec history contains an invalid or unparseable revision',
      'scheduler:get_claim_spec { fleet, history }',
    );
  }

  const scope = fleetMetricScopeSchema.parse({
    fleet: resolved.fleetSlug,
    harness: request.harness,
    window: {
      kind: 'fleet-lifetime',
      startAt: windowStart,
      endAt: generatedAt,
      startInclusive: true,
      endExclusive: true,
      startSource: 'fleet-created-at',
      endSource: 'snapshot-generated-at',
    },
    stock: {
      mode: 'current-spec',
      specId: resolved.record.spec.specId,
      revision: resolved.record.revision,
      source: resolved.record.source,
      appliedTo: 'all-counted-items',
    },
    flow:
      request.flowMode === 'current-spec'
        ? {
            mode: 'current-spec',
            specId: resolved.record.spec.specId,
            revision: resolved.record.revision,
            source: resolved.record.source,
            appliedTo: 'all-counted-items',
          }
        : {
            mode: 'at-event-spec',
            specId: resolved.record.spec.specId,
            currentRevision: resolved.record.revision,
            revision: 'effective-at-event',
            historyWriter: FLEET_METRIC_WRITERS.claimSpecHistory,
            appliedTo: 'each-event-at-its-event-time',
            missingRevision: 'unavailable-never-current-fallback',
          },
    attribution: {
      membership: FLEET_METRIC_POPULATIONS.everMembers,
      writer: FLEET_METRIC_WRITERS.membership,
      memberCount: everMembers.size,
      rule: 'actor owner id is in the fleet append-only ever-member cohort',
    },
    population: {
      currentRunnableRoster: FLEET_METRIC_POPULATIONS.currentRunnableRoster,
      relevantRoster: FLEET_METRIC_POPULATIONS.relevantRoster,
      attribution: FLEET_METRIC_POPULATIONS.everMembers,
      stock: FLEET_METRIC_POPULATIONS.currentSpecWorkItems,
      flow:
        request.flowMode === 'current-spec'
          ? FLEET_METRIC_POPULATIONS.currentSpecWorkItems
          : FLEET_METRIC_POPULATIONS.atEventSpecWorkItemEvents,
      canonicalBugs: FLEET_METRIC_POPULATIONS.canonicalBugs,
      observations: FLEET_METRIC_POPULATIONS.observations,
      occurrences: FLEET_METRIC_POPULATIONS.occurrences,
      terminalAuthority: FLEET_METRIC_POPULATIONS.terminalAuthority,
      comparisonRule: FLEET_METRIC_COMPARISON_RULE,
    },
  });

  const populationLifecycle = buildFleetPopulationLifecycle({
    fleet: resolved.fleetSlug,
    candidates: roster.entries,
    everMemberIds: [...everMembers],
    fleetStartedAtMs: fleet.createdAt,
    observedAtMs: generatedAtMs,
  }).snapshot;

  const staleAfterMs = Math.max(1, Math.trunc(request.staleAfterMs ?? 60_000));
  return {
    ok: true,
    schemaVersion: FLEET_METRICS_SCHEMA_VERSION,
    generatedAt,
    scope,
    quality: {
      exactness: history.more
        ? {
            status: 'truncated',
            sourceCap: historyLimit,
            fetched: history.returned,
            reason: 'older claim-spec revisions exist beyond the retained read window',
            recoverVia: 'scheduler:get_claim_spec { fleet, history }',
          }
        : { status: 'exact', sourceCap: null },
      freshness: { status: 'fresh', measuredAt: generatedAt, staleAfterMs },
    },
    claimSpec: {
      current: resolved.record.spec,
      segments,
      historyReturned: history.returned,
      historyMore: history.more,
    },
    currentRoster: {
      // Backward-compatible raw roster identity list. The shared snapshot's
      // `currentRunnableRoster.ownerIds` is the lifecycle-safe headcount cohort.
      ownerIds: roster.entries.map((entry) => entry.agentId),
      writer: 'fleet-roster',
    },
    everMemberIds: [...everMembers].sort(),
    populationLifecycle,
  };
}

export async function resolveFleetMetricScope(
  request: FleetMetricScopeRequest,
  deps: FleetMetricScopeDeps = DEFAULT_DEPS,
): Promise<FleetMetricScopeResolution> {
  try {
    return await resolveFleetMetricScopeUnsafe(request, deps);
  } catch (error) {
    const detail = error instanceof Error && error.message ? `: ${error.message}` : '';
    return unavailable(
      request,
      `fleet metric scope read failed${detail}`,
      'retry the canonical fleet/spec/membership readers',
    );
  }
}

export function selectFleetMetricCurrentItems(scope: ResolvedFleetMetricScope, items: readonly WorkItem[]): WorkItem[] {
  return items.filter((item) => matchesWorkItemClaimSpec(item, scope.claimSpec.current));
}

export interface FleetMetricWorkItemEvent<T = unknown> {
  item: WorkItem;
  at: string;
  value: T;
}

export type FleetMetricFlowSelection<T> =
  | { ok: true; events: Array<FleetMetricWorkItemEvent<T>> }
  | FleetMetricUnavailable;

export function selectFleetMetricFlowEvents<T>(
  scope: ResolvedFleetMetricScope,
  events: readonly FleetMetricWorkItemEvent<T>[],
): FleetMetricFlowSelection<T> {
  const windowStart = Date.parse(scope.scope.window.startAt);
  const windowEnd = Date.parse(scope.scope.window.endAt);
  const matched: Array<FleetMetricWorkItemEvent<T>> = [];
  for (const event of events) {
    const eventAt = Date.parse(event.at);
    if (!Number.isFinite(eventAt) || eventAt < windowStart || eventAt >= windowEnd) {
      return unavailable(
        {
          workspaceId: '',
          harness: scope.scope.harness,
          fleet: scope.scope.fleet,
          flowMode: scope.scope.flow.mode,
        },
        `event ${event.item.id} is outside the fleet-lifetime window or has an invalid timestamp`,
        're-read the event with its canonical lifecycle timestamp',
      );
    }
    const segment =
      scope.scope.flow.mode === 'current-spec'
        ? scope.claimSpec.segments.find((candidate) => candidate.source === 'current')
        : scope.claimSpec.segments.find((candidate) => {
            if (candidate.startAt == null) return false;
            const start = Date.parse(candidate.startAt);
            return eventAt >= start && eventAt < Date.parse(candidate.endAt);
          });
    if (!segment) {
      return unavailable(
        {
          workspaceId: '',
          harness: scope.scope.harness,
          fleet: scope.scope.fleet,
          flowMode: scope.scope.flow.mode,
        },
        `claim-spec revision effective at ${event.at} is unavailable`,
        'scheduler:get_claim_spec { fleet, history }',
      );
    }
    if (matchesWorkItemClaimSpec(event.item, segment.spec)) matched.push(event);
  }
  return { ok: true, events: matched };
}
