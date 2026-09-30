/**
 * Fleet context for the shared conversation projection (cockpit P-025).
 *
 * The loader deliberately composes the canonical fleet/plan/event readers. The
 * renderers receive one typed context frame and never reconstruct fleet state
 * from App.roster or a second client-side query.
 */
import {
  groupByAgent,
  listFleetAssignments,
  type AgentAssignment,
  type FleetAssignmentRow,
} from './fleet/assignments';
import {
  decorateContextPressure,
  decorateMemberVerdicts,
  decorateParkedOn,
  reconcileWakeability,
  RECONCILE_WAKEABILITY_PRODUCTION_OPTIONS,
  type MemberVerdict,
} from './agent-tools/fleet/assignments';
import type { ContextPressureBucket } from './agent-tools/coordination/context-pressure';
import type { SessionState } from './agent-tools/coordination/presence-wakeability';
import { listActiveAnnouncements } from './events/await/store';
import type { AwaitRow } from './events/await/types';
import { announcementVisibleTo } from './events/await/announce-key';
import { planItemsForRow, readPlanBySlug } from './agent-tools/plans/source';
import { isTerminalItemStatus } from './fleet-drained-events';
import type { ConversationContextSectionFrame } from './conversation-context-projection';

export interface FleetContextAgent extends AgentAssignment {
  sessionState?: SessionState | null;
  parkedOn?: string[];
  contextPressure?: ContextPressureBucket | null;
  verdict?: MemberVerdict;
  lastToolCallAt?: string | null;
}

export interface FleetContextPlanItem {
  id: string;
  storedStatus: string;
  blockedBy: string[];
}

export interface BuildFleetContextFrameInput {
  ownerId: string;
  fleetSlug: string;
  planSlug: string | null;
  agents: FleetContextAgent[];
  announcements?: readonly AwaitRow[];
  planItems?: readonly FleetContextPlanItem[];
  nowMs?: number;
}

export interface LoadFleetContextFrameInput {
  workspaceId: string;
  harness: string | null;
  ownerId: string;
  fleetSlug: string | null;
  planSlug: string | null;
}

export interface FleetContextDependencies {
  listAssignments: (input: {
    workspaceId: string;
    harness?: string;
    fleet: string;
  }) => Promise<FleetAssignmentRow[]>;
  groupAssignments: (rows: FleetAssignmentRow[]) => AgentAssignment[];
  reconcileWakeability: (agents: FleetContextAgent[]) => Promise<FleetContextAgent[]>;
  decorateParkedOn: (agents: FleetContextAgent[]) => Promise<FleetContextAgent[]>;
  decorateContextPressure: (agents: FleetContextAgent[]) => Promise<FleetContextAgent[]>;
  decorateMemberVerdicts: (agents: FleetContextAgent[]) => Promise<FleetContextAgent[]>;
  listAnnouncements: (input: { unfiredOnly: false; limit: number }) => Promise<AwaitRow[]>;
  readPlan: typeof readPlanBySlug;
  now: () => number;
}

const DEFAULT_DEPS: FleetContextDependencies = {
  listAssignments: listFleetAssignments,
  groupAssignments: groupByAgent,
  reconcileWakeability: (agents) =>
    reconcileWakeability(
      agents,
      undefined,
      undefined,
      undefined,
      undefined,
      RECONCILE_WAKEABILITY_PRODUCTION_OPTIONS,
    ),
  decorateParkedOn,
  decorateContextPressure,
  decorateMemberVerdicts,
  listAnnouncements: listActiveAnnouncements,
  readPlan: readPlanBySlug,
  now: Date.now,
};

function rosterGlyph(agent: FleetContextAgent): string {
  if (agent.sessionState === 'ended' || agent.verdict === 'dead') return '○';
  if (
    agent.sessionState === 'suspect'
    || agent.sessionState === 'draining'
    || agent.verdict === 'stalled'
  ) return '◐';
  return agent.fleetRole === 'leader' ? '◆' : '●';
}

function rosterState(agent: FleetContextAgent): string {
  return agent.sessionState ?? agent.verdict ?? (agent.alive ? 'live' : 'unknown');
}

function elapsedLabel(timestamp: string | null | undefined, nowMs: number): string | null {
  if (!timestamp) return null;
  const then = Date.parse(timestamp);
  if (!Number.isFinite(then)) return null;
  const seconds = Math.max(0, Math.floor((nowMs - then) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function holderForBlocker(
  agents: readonly FleetContextAgent[],
  planSlug: string,
  blockerId: string,
): FleetContextAgent | null {
  return agents.find((agent) => agent.claims.some((claim) =>
    claim.active
    && claim.planSlug === planSlug
    && claim.id === blockerId
    && (claim.type === 'plan-item' || claim.type === 'assignment'),
  )) ?? null;
}

/** Build the compact, renderer-neutral Fleet section from already-settled data. */
export function buildFleetContextFrame(
  input: BuildFleetContextFrameInput,
): ConversationContextSectionFrame | null {
  const self = input.agents.find((agent) => agent.agentId === input.ownerId);
  if (!self) return null;
  const leader = input.agents.find((agent) => agent.fleetRole === 'leader') ?? null;
  const ordered = [...input.agents].sort((a, b) => {
    const roleDelta = Number(b.fleetRole === 'leader') - Number(a.fleetRole === 'leader');
    return roleDelta || (a.label ?? a.agentId).localeCompare(b.label ?? b.agentId);
  });
  const entries: ConversationContextSectionFrame['entries'] = [
    { label: 'Fleet', value: input.fleetSlug },
    { label: 'Leader', value: leader?.label ?? leader?.agentId ?? 'Unassigned' },
    { label: 'Your role', value: self.fleetRole ?? 'member', state: rosterState(self) },
    {
      label: 'Roster',
      value: `${ordered.length} ${ordered.length === 1 ? 'member' : 'members'}`,
      badges: ordered.map((agent) => ({
        label: rosterGlyph(agent),
        state: rosterState(agent),
        title: `${agent.label ?? agent.agentId} · ${rosterState(agent)}`,
      })),
    },
  ];

  const visibleAnnouncements = (input.announcements ?? []).filter((announcement) =>
    announcementVisibleTo(announcement, {
      fleetSlug: input.fleetSlug,
      planSlug: input.planSlug,
    }),
  );
  const parkedAnnouncement = self.parkedOn
    ?.map((eventKey) => visibleAnnouncements.find((row) => row.eventKey === eventKey))
    .find((row): row is AwaitRow => Boolean(row));
  if (parkedAnnouncement) {
    entries.push({
      label: 'Parked gate',
      value: parkedAnnouncement.eventKey,
      state: parkedAnnouncement.firedAt ? 'fired' : 'waiting',
    });
  }

  if (input.planSlug && input.planItems?.length) {
    const heldItemIds = new Set(self.claims.flatMap((claim) =>
      claim.active && claim.planSlug === input.planSlug && claim.type === 'plan-item' && claim.id
        ? [claim.id]
        : [],
    ));
    const heldBlockedItem = input.planItems.find((item) =>
      heldItemIds.has(item.id)
      && item.blockedBy.some((blockerId) => {
        const blocker = input.planItems?.find((candidate) => candidate.id === blockerId);
        return !blocker || !isTerminalItemStatus(blocker.storedStatus);
      }),
    );
    const blockerId = heldBlockedItem?.blockedBy.find((candidateId) => {
      const blocker = input.planItems?.find((candidate) => candidate.id === candidateId);
      return !blocker || !isTerminalItemStatus(blocker.storedStatus);
    });
    if (blockerId) {
      const holder = holderForBlocker(input.agents, input.planSlug, blockerId);
      const pressure = holder?.contextPressure ?? null;
      const age = elapsedLabel(holder?.lastToolCallAt, input.nowMs ?? Date.now());
      entries.push({
        label: 'Blocked by',
        value: [
          `${input.planSlug}#${blockerId}`,
          holder ? holder.label ?? holder.agentId : null,
          pressure ? `pressure ${pressure}` : null,
          age ? `spoke ${age} ago` : null,
        ].filter(Boolean).join(' · '),
        state: pressure ?? holder?.sessionState ?? holder?.verdict,
      });
    }
  }

  return {
    id: 'context:fleet',
    kind: 'context',
    section: 'fleet',
    title: 'Fleet',
    entries,
  };
}

/** One canonical assignment read; all optional enrichments fail soft. */
export async function loadFleetContextFrame(
  input: LoadFleetContextFrameInput,
  deps: FleetContextDependencies = DEFAULT_DEPS,
): Promise<ConversationContextSectionFrame | null> {
  if (!input.fleetSlug) return null;
  try {
    const rows = await deps.listAssignments({
      workspaceId: input.workspaceId,
      ...(input.harness ? { harness: input.harness } : {}),
      fleet: input.fleetSlug,
    });
    const agents = deps.groupAssignments(rows) as FleetContextAgent[];
    await Promise.all([
      deps.reconcileWakeability(agents).catch(() => agents),
      deps.decorateParkedOn(agents).catch(() => agents),
      deps.decorateContextPressure(agents).catch(() => agents),
    ]);
    await deps.decorateMemberVerdicts(agents).catch(() => agents);

    const [announcements, plan] = await Promise.all([
      deps.listAnnouncements({ unfiredOnly: false, limit: 100 }).catch(() => []),
      input.planSlug
        ? deps.readPlan(input.planSlug, {
            workspaceId: input.workspaceId,
            ...(input.harness ? { harnessSlug: input.harness } : {}),
          }).catch(() => null)
        : Promise.resolve(null),
    ]);
    return buildFleetContextFrame({
      ownerId: input.ownerId,
      fleetSlug: input.fleetSlug,
      planSlug: input.planSlug,
      agents,
      announcements,
      planItems: plan ? planItemsForRow(plan.row) : [],
      nowMs: deps.now(),
    });
  } catch {
    return null;
  }
}
