/**
 * fleet:status — one fleet's registry identity + its live roster (named-su-agent-fleets-
 * 2026-06-29 P-004).
 *
 * Combines the durable agent_fleets row (title/description/leader) with the unified
 * fleet roster (listFleetRoster, keyed on the fleet_slug presence label) — "who's in this
 * fleet and exactly what each is doing", the per-fleet analog of coord:presence.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES, readJsonResult, type SeeAlsoEntry } from '@papercusp/agent-mcp';
import {
  fleetSlugFromName,
  getFleet,
  getFleetHeadcountTarget,
  projectFleetHeadcountState,
} from '../../agent-fleets-store';
import { countedMemberSet, readFleetMemberSilence } from './silent-member';
import {
  listFleetRosterDiagnosed,
  splitFleetRosterCounts,
  countRunningFleetBees,
  countRunningWorkspaceBees,
  liveFleetMemberIds,
  type FleetRosterEntry,
  type FleetRosterDegradedLeg,
} from '../../fleet/fleet-roster';
import { applyPsuHostAuthority } from '../coordination/liveness-oracle';
import { getCompletionIntegrityStats, type CompletionIntegrityStats } from '../../work-items';
import { withBoundedTimeout } from '../../bounded-timeout';
import type { AdvSessionEndedBy } from '../../adv-sessions';
import { json, resolveFleetCaller, ROUTING_LADDER } from './_shared';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { crossCheckLaunchVerification, buildOwnerActivityReader } from '../../fleet/launch-verification-cross-check';
import { fleetEverMembers } from '../../fleet-membership-store';
import { buildFleetPopulationLifecycle } from '../fleet/fleet-population';
import { getLoopStatuses } from '../../harness/routines/loop';
import type { LifecycleBackoffInfo, LoopStatus } from '../../harness/routines/loop';
import { FLEET_LEADER_MISSING_GRACE_MS } from '../../scheduler/fleet-scope-admission';
import { isLeaderPresentSessionState } from '../../fleet/leader-presence';

/**
 * WI-3818: bound the two OPTIONAL legs — completionStats (harness-scoped
 * aggregate, only fetched when `harness` is passed) and the two bee-count
 * queries — so a slow one degrades to "omitted"/0 instead of hanging the
 * whole handler until the 55s MCP client timeout. The roster itself carries
 * the bulk of the fan-out and is bounded internally (fleet-roster.ts); these
 * are the "drop completionStats/queued detail first" fallback the ticket
 * asks for — completionStats is the first thing to go missing under load.
 */
const FLEET_STATUS_OPTIONAL_LEG_TIMEOUT_MS = 6_000;

/**
 * fleet:status payload tiers (context-trimming-tiers-2026-07-01 P-022).
 *
 * The registry roster is intentionally lossless for full-tier callers, but a
 * normal model-facing read must not send one unbounded row per historical/live
 * member through the result door. Keep the control/liveness decision core on
 * every row, cap the roster, and make the cut explicit so a leader can narrow
 * or request the full tier when it needs a particular member's resume detail.
 */
export const FLEET_STATUS_TIER_CAPS = {
  trimmed: { members: 8, label: 80, intent: 100, doing: 80, resumeHint: 180 },
  standard: { members: 12, label: 140, intent: 180, doing: 120, resumeHint: 300 },
} as const;

type FleetStatusTier = keyof typeof FLEET_STATUS_TIER_CAPS;

const clipFleetStatus = (value: unknown, max: number): string | null =>
  typeof value === 'string' ? (value.length > max ? `${value.slice(0, max - 1)}…` : value) : null;

const isNonRunnableFleetMember = (row: unknown): boolean => {
  const state = (row as { sessionState?: unknown } | null | undefined)?.sessionState;
  return state === 'ended' || state === 'suspect' || state === 'draining';
};

/**
 * Shape the status read after the handler has produced its complete roster.
 * Leader and non-runnable rows are selected before ordinary live rows when a
 * cap is needed: a truncated monitor read must retain the rows that determine
 * whether leadership is available and whether a member needs recovery.
 */
export function shapeFleetStatus(data: unknown, tier: FleetStatusTier): unknown {
  const d = data as ({ members?: unknown[]; leaderId?: unknown } & Record<string, unknown>) | null | undefined;
  if (!d || !Array.isArray(d.members)) return data;
  const caps = FLEET_STATUS_TIER_CAPS[tier];

  const projectMember = (row: unknown): Record<string, unknown> => {
    const r = (row ?? {}) as Record<string, unknown>;
    const sessionState = typeof r.sessionState === 'string' ? r.sessionState : null;
    const base = {
      agentId: r.agentId ?? null,
      label: clipFleetStatus(r.label, caps.label),
      fleetRole: r.fleetRole ?? null,
      intent: clipFleetStatus(r.intent, caps.intent),
      // Keep the liveness verdict and its raw heartbeat signal together. A
      // fresh heartbeat with an ended session is deliberately not runnable.
      heartbeatFresh: typeof r.heartbeatFresh === 'boolean' ? r.heartbeatFresh : null,
      sessionState,
      lastActiveSecAgo: typeof r.lastActiveSecAgo === 'number' ? r.lastActiveSecAgo : null,
      doing: clipFleetStatus(r.doing, caps.doing),
      load: typeof r.load === 'number' ? r.load : null,
      // WI-7286: the shaper is a WHITELIST, so a field the handler emits but this
      // projection omits is dropped silently at both non-full tiers — and `trimmed`
      // is the DEFAULT read, so omitting it here would leave the backoff signal
      // visible only to a caller who thought to ask for payloadTier:'full'. That is
      // the opposite of the point: a silenced member matters most on the cheap
      // monitor read. Kept in both tiers (three small scalars) and, like the
      // handler, spread only when present so healthy rows are unchanged.
      ...(r.lifecycleBackoff && typeof r.lifecycleBackoff === 'object'
        ? { lifecycleBackoff: r.lifecycleBackoff }
        : {}),
    };

    if (sessionState === 'ended' || sessionState === 'suspect') {
      return {
        ...base,
        resumable: r.resumable === true,
        endedAt: typeof r.endedAt === 'string' ? r.endedAt : null,
        endedBy: typeof r.endedBy === 'string' ? r.endedBy : null,
        ...(tier === 'standard'
          ? {
              resumeHint: clipFleetStatus(r.resumeHint, caps.resumeHint),
              endedAtCaveat: clipFleetStatus(r.endedAtCaveat, caps.resumeHint),
            }
          : {}),
      };
    }

    if (tier === 'standard') {
      return {
        ...base,
        ...(typeof r.lastToolCallAt === 'string' ? { lastToolCallAt: r.lastToolCallAt } : {}),
      };
    }
    return base;
  };

  const source = d.members;
  const selected =
    source.length <= caps.members
      ? source
      : (() => {
          const prioritized = [
            ...source.filter((row) => row && (row as { agentId?: unknown }).agentId === d.leaderId),
            ...source.filter(isNonRunnableFleetMember),
            ...source,
          ];
          const seen = new Set<unknown>();
          return prioritized.filter((row) => {
            if (seen.has(row)) return false;
            seen.add(row);
            return true;
          });
        })().slice(0, caps.members);

  const members = selected.map(projectMember);
  if (source.length > caps.members) {
    members.push({
      ...projectMember({}),
      agentId: '(truncated)',
      intent: `showing ${caps.members} of ${source.length} — narrow by member or use payloadTier:"full" for the complete roster`,
    });
  }

  const populationLifecycle = (() => {
    const source = d.populationLifecycle;
    if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined;
    const lifecycle = source as Record<string, unknown>;
    const compact: Record<string, unknown> = { ...lifecycle };
    for (const key of ['currentRunnableRoster', 'relevantRoster', 'everMembers']) {
      const population = lifecycle[key];
      if (!population || typeof population !== 'object' || Array.isArray(population)) continue;
      const row = population as Record<string, unknown>;
      const ids = Array.isArray(row.ownerIds)
        ? row.ownerIds.filter((id): id is string => typeof id === 'string')
        : [];
      const shown = ids.slice(0, caps.members);
      compact[key] = {
        ...row,
        ...(ids.length > 0 ? { ownerIds: shown } : {}),
        ...(ids.length > shown.length ? { ownerIdsTruncated: ids.length } : {}),
      };
    }
    return compact;
  })();

  return {
    ...d,
    ...(populationLifecycle ? { populationLifecycle } : {}),
    members,
    ...(source.length > caps.members
      ? {
          members_note: `roster capped at ${caps.members} of ${source.length}; leader and non-runnable rows prioritized`,
        }
      : {}),
  };
}

/**
 * Reconcile fleet:status's member census with the local psu host authority.
 *
 * `coord_presence` heartbeats can outlive a visible terminal session, leaving a
 * dead desktop member in the live roster. The liveness oracle already owns the
 * rule for ending a hostless known psu cohort; fleet:status opts into that rule
 * only for rows with a recorded tty. Headless su members intentionally have no
 * tty (and may have no local psu-pty host between wakes), so applying the rule to
 * every `agent_role:'su'` row would turn legitimate headless members into ghosts.
 */
export function reconcileFleetStatusLiveness(
  roster: FleetRosterEntry[],
  findHost?: (ownerId: string) => unknown | null,
): FleetRosterEntry[] {
  const visibleRoles = new Map<string, string>();
  for (const member of roster) {
    if (member.tty != null && member.agentRole != null && member.agentRole !== 'cup') {
      visibleRoles.set(member.agentId, member.agentRole);
    }
  }
  return applyPsuHostAuthority(roster, visibleRoles, findHost);
}

export type LaunchTransactionUnconfirmedPresence = 'present' | 'absent' | 'unknown';

export interface LaunchTransactionUnconfirmedMemberStatus {
  ownerId: string;
  /** `present` means the id has a fleet presence row; `absent` is a clean no-row result. */
  presence: LaunchTransactionUnconfirmedPresence;
  /** The roster's liveness verdict, kept separate from presence. */
  sessionState: string | null;
  heartbeatFresh: boolean | null;
  lastActiveSecAgo: number | null;
  /** Why this row is unknown; absent/present rows are directly classified. */
  reason?: string;
}

/**
 * Join launch-time `unconfirmedMemberIds` against the same presence-primary roster used by status.
 *
 * An absent row is actionable only when the presence leg answered. If that leg degraded, returning
 * `absent` would recreate the defect this field is meant to expose, so the result is explicitly unknown.
 */
export function classifyLaunchTransactionUnconfirmedMembers(
  ids: readonly string[] | null | undefined,
  roster: ReadonlyArray<
    Pick<FleetRosterEntry, 'agentId' | 'sessionState' | 'heartbeatFresh' | 'alive' | 'lastActiveSecAgo'>
  >,
  degradedLegs: readonly FleetRosterDegradedLeg[] = [],
): LaunchTransactionUnconfirmedMemberStatus[] {
  const uniqueIds = [
    ...new Set((ids ?? []).filter((id): id is string => typeof id === 'string' && id.length > 0)),
  ];
  if (uniqueIds.length === 0) return [];

  const byOwner = new Map(roster.map((member) => [member.agentId, member] as const));
  const presenceDegraded = degradedLegs.includes('presence');

  return uniqueIds.map((ownerId) => {
    const member = byOwner.get(ownerId);
    if (member) {
      return {
        ownerId,
        presence: 'present',
        sessionState: member.sessionState ?? null,
        heartbeatFresh: member.heartbeatFresh ?? member.alive ?? null,
        lastActiveSecAgo: member.lastActiveSecAgo ?? null,
      };
    }

    if (presenceDegraded) {
      return {
        ownerId,
        presence: 'unknown',
        sessionState: null,
        heartbeatFresh: null,
        lastActiveSecAgo: null,
        reason: 'fleet roster presence read degraded; absence is unverified',
      };
    }

    return {
      ownerId,
      presence: 'absent',
      sessionState: null,
      heartbeatFresh: null,
      lastActiveSecAgo: null,
    };
  });
}

export default defineTool({
  name: 'fleet:status',
  description:
    'Show one fleet\'s identity, leader liveness/vacancy, and live roster. Counts split visible desktop su members (`memberCount`) from background autonomous-loop bees (`beeCount`); `runningBees` is workspace-wide, so 0 members with runningBees>0 does not mean this fleet has desktop members. Use fleet:launch-on-plan to add desktop members. Optional harness-scoped completion-integrity stats separate genuine completions from dedup churn. `launchTransactionUnconfirmedMembers` resolves `unconfirmedMemberIds` against the same presence read as present/absent/unknown; degraded reads never become false absence. Slow presence, assignments, completion-stats, or bee-count legs fail soft and return `degraded:true` plus `degradedLegs`. Fleet-scoped analog of coord:presence.',
  guidance: {
    when: 'Inspecting a specific fleet — its leader and live members — before joining it or handing it a plan.',
    notWhen: 'For the catalog of ALL fleets with availability, use fleet:list.',
    chaining: ROUTING_LADDER,
    // Result-aware (D-003): fill the CONCRETE `@fleet:<slug>` history selector from
    // the result — the "coord:catch-up @fleet:X for who-was-ever-here" pointer WI-1348
    // asks for — carrying the real ended-member count when the fleet has dead sessions.
    // The adjacent-lens pointers are always relevant, so they stay static.
    seeAlso: (result) => {
      const j = readJsonResult<{
        ok?: boolean;
        slug?: string;
        members?: Array<{ sessionState?: string }>;
      }>(result);
      const out: SeeAlsoEntry[] = [
        'fleet:list (the catalog of ALL fleets with availability)',
        'fleet:assignments (what this fleet\'s members are working on)',
        'coord:roster { view:"members" } (membership across hive + fleet)',
      ];
      if (j?.ok && j.slug) {
        const ended = (j.members ?? []).filter((m) => ['ended', 'suspect', 'draining'].includes(m.sessionState ?? '')).length;
        out.push({
          tool: 'coord:catch-up',
          selector: `@fleet:${j.slug}`,
          reason: ended > 0 ? `${ended} ended — who-was-ever-here` : 'who-was-ever-here',
        });
      }
      return out;
    },
  },
  capability: 'fleet:status',
  requirePrincipal: false,
  // EI-20228676874653267: this supervision read owns its DB accessors and
  // never reads ctx.tx. Do not retain the dispatcher's ambient transaction
  // across the roster/optional-leg fan-out; it pins an org-app slot and can
  // starve subsequent control-plane calls under fleet load.
  skipWorkspaceTx: true,
  // The explicit full tier is a deliberate lossless roster read. If its JSON
  // exceeds the generic result door, that door appends a spill pointer/footer
  // into the body and makes machine consumers (for example `ptool --raw`)
  // unable to parse it. Trimmed and standard calls remain bounded by the
  // shapers above; full callers own the larger response they requested.
  skipResultDoor: 'oversize-by-design',
  agentRoles: [...SU_ROLES, 'cup'],
  args: z.object({
    fleet: z.string().min(1).describe('The fleet slug (from fleet:list).'),
    harness: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe(
        'Optional harness slug for progress reporting. When provided, the result includes `completionStats` so genuine completions are separated from dedup/unverified terminal rows.',
      ),
    workspace: z
      .string()
      .max(120)
      .optional()
      .describe(
        'Workspace holding the fleet. Defaults to the caller\'s own workspace, which is right for nearly every call. Pass it only to read a fleet in a DIFFERENT workspace — fleet slugs are unique per workspace, not globally, so the default cannot reach one filed elsewhere.',
      ),
  }),
  // Context-trimming tiers keep the supervision decision core while bounding
  // the roster. Full-tier callers retain the lossless handler response.
  shape: {
    // WI-2145871: the ROW axis only, and deliberately so. `projectMember`
    // rebuilds each row FROM LITERALS (`base`, plus per-path additions), so a
    // field added to the handler's members[] mapping and not to that literal is
    // dropped silently at both non-full tiers — and `trimmed` is the DEFAULT
    // read. That is the drop this pin exists to catch, and it is a real one:
    // WI-7286 lost `lifecycleBackoff` exactly that way.
    //
    // `fields` is the INTERSECTION of every return path's UNCONDITIONAL keys —
    // the nine `base` keys. Everything else is conditional and must stay out:
    // `lifecycleBackoff` (only when the row carries it), `resumable`/`endedAt`/
    // `endedBy` (ended|suspect only), `lastToolCallAt` (standard + present),
    // `resumeHint`/`endedAtCaveat` (standard + ended). Pinning a conditional key
    // would fail on the ordinary live row, which is most of the roster.
    //
    // No top-level `preserve`: the envelope returns `{ ...d, … }`, a SPREAD that
    // passes every key through, so a `preserve` pin here would be TRIVIALLY
    // SATISFIED — green while asserting nothing, and worse than no pin because
    // the next reader counts the envelope as guarded and stops looking.
    contract: {
      rows: 'members',
      fields: [
        'agentId',
        'label',
        'fleetRole',
        'intent',
        'heartbeatFresh',
        'sessionState',
        'lastActiveSecAgo',
        'doing',
        'load',
      ],
    },
    standard: (data) => shapeFleetStatus(data, 'standard'),
    trimmed: (data) => shapeFleetStatus(data, 'trimmed'),
  },
  async handler(args, ctx) {
    // EI-21934696112365508: a fleet slug is unique PER WORKSPACE, not globally
    // (`getFleet` is a `workspace_id = $1 AND fleet_slug = $2` equality read), so a
    // caller whose workspace differs from the fleet's had no way to name the one it
    // meant — every sibling `fleet/`-family read already takes this override. An
    // explicit `workspace` wins; otherwise the caller's own workspace is used, with
    // `resolveConcreteWorkspaceId` absorbing the unscoped-su '*' sentinel (EI-13820).
    const { workspaceId: callerWorkspaceId } = resolveFleetCaller(ctx);
    const workspaceId = resolveConcreteWorkspaceId(args.workspace, callerWorkspaceId);
    const requestedFleetSlug = fleetSlugFromName(args.fleet);
    const fleet = await getFleet(workspaceId, requestedFleetSlug);
    if (!fleet) {
      // Name the workspace actually searched: "not in this workspace" is unactionable
      // when the caller cannot see which workspace "this" resolved to.
      return json(
        {
          ok: false,
          error: 'unknown_fleet',
          fleet: args.fleet,
          normalizedFleetSlug: requestedFleetSlug,
          message:
            `No fleet '${args.fleet}' (resolved as '${requestedFleetSlug}') in workspace '${workspaceId}' — see fleet:list. ` +
            `If it belongs to a different workspace, pass { workspace } to read it there.`,
          workspaceSearched: workspaceId,
        },
        true,
      );
    }
    const fleetSlug = fleet.fleetSlug;
    // WI-3818: each leg is independently bounded so a slow/hanging one degrades
    // to its fallback instead of hanging the whole handler — completionStats
    // (an optional harness-scoped aggregate) and the bee counts are the
    // droppable-first detail; the roster itself reports its OWN per-sub-read
    // degradation (fleet-roster.ts) rather than degrading as a single unit.
    const [
      rosterResult,
      completionStatsResult,
      runningBeesResult,
      beeCountResult,
      headcountTargetResult,
      headcountCurrentResult,
      everMembersResult,
    ] = await Promise.all([
      listFleetRosterDiagnosed({
        fleetSlug,
        workspaceId,
        leaderOwnerId: fleet.leaderOwnerId,
      }),
      args.harness
        ? withBoundedTimeout<CompletionIntegrityStats | null>(getCompletionIntegrityStats(args.harness), {
            fallback: null,
            timeoutMs: FLEET_STATUS_OPTIONAL_LEG_TIMEOUT_MS,
            label: 'fleet:status:completionStats',
          })
        : Promise.resolve({ value: null, degraded: false, elapsedMs: 0 } as const),
      withBoundedTimeout(countRunningWorkspaceBees(workspaceId), {
        fallback: 0,
        timeoutMs: FLEET_STATUS_OPTIONAL_LEG_TIMEOUT_MS,
        label: 'fleet:status:runningBees',
      }),
      withBoundedTimeout(countRunningFleetBees(fleetSlug, workspaceId), {
        fallback: 0,
        timeoutMs: FLEET_STATUS_OPTIONAL_LEG_TIMEOUT_MS,
        label: 'fleet:status:beeCount',
      }),
      withBoundedTimeout(getFleetHeadcountTarget(workspaceId, fleetSlug), {
        fallback: undefined,
        timeoutMs: FLEET_STATUS_OPTIONAL_LEG_TIMEOUT_MS,
        label: 'fleet:status:headcountTarget',
      }),
      withBoundedTimeout(
        liveFleetMemberIds(fleetSlug, workspaceId, 'launch'),
        {
          fallback: null,
          timeoutMs: FLEET_STATUS_OPTIONAL_LEG_TIMEOUT_MS,
          label: 'fleet:status:headcountCurrent',
        },
      ),
      withBoundedTimeout(fleetEverMembers(fleetSlug, { workspaceId }), {
        fallback: new Set<string>(),
        timeoutMs: FLEET_STATUS_OPTIONAL_LEG_TIMEOUT_MS,
        label: 'fleet:status:everMembers',
      }),
    ]);
    // A leader can be present in another fleet's labelled roster when it leads
    // multiple fleets. Reconcile the liveness-only enrichment alongside the
    // queried roster, then project the queried ids back out before calculating
    // members/counts so cross-fleet leadership never changes this fleet's census.
    const queriedRosterIds = new Set(rosterResult.entries.map((member) => member.agentId));
    const rosterForLiveness =
      fleet.leaderOwnerId &&
      rosterResult.leaderEntry &&
      !queriedRosterIds.has(fleet.leaderOwnerId)
        ? [...rosterResult.entries, rosterResult.leaderEntry]
        : rosterResult.entries;
    const reconciledRoster = reconcileFleetStatusLiveness(rosterForLiveness);
    const roster = reconciledRoster.filter((member) => queriedRosterIds.has(member.agentId));
    const completionStats = completionStatsResult.value;
    const runningBees = runningBeesResult.value;
    const beeCount = beeCountResult.value;
    // Aggregate every degraded leg (roster sub-reads prefixed `roster.<leg>` +
    // the three top-level optional legs) into one flat, order-stable list —
    // absent entirely when nothing degraded, so a healthy call's payload is
    // byte-identical to pre-WI-3818 behavior.
    // WI-2034624: `current` is attested from recent agent-origin execution over
    // the canonical live roster, so it depends on the roster leg above and runs
    // after it. A degraded/failed read stays `null` — measurement resolves that
    // to UNKNOWN rather than to a transaction-scoped undercount.
    const headcountExecutingResult = await withBoundedTimeout(
      headcountCurrentResult.value == null
        ? Promise.resolve(null)
        : // P-007 / R-17: the same silence rule the headcount governor applies, so
          // this read cannot count a seat the writer has decided to refill.
          readFleetMemberSilence(headcountCurrentResult.value, {
            fleetPaused: fleet.controlState === 'winding-down',
          }).then(countedMemberSet),
      {
        fallback: null,
        timeoutMs: FLEET_STATUS_OPTIONAL_LEG_TIMEOUT_MS,
        label: 'fleet:status:headcountExecuting',
      },
    );
    // EI-19381528967421062 / WI-7286: a member whose engine loop backed off from a
    // provider wall (rate-limit / usage-cap) reads as an ordinary live row here —
    // `sessionState:'live'` with a stale `lastActiveSecAgo` — and NOTHING on this
    // surface distinguishes "healthy, next tick in 60s" from "silenced for the next
    // 100 minutes". fleet:assignments and fleet:leader-brief already carry the
    // derivation (decorateLoopMonitorStates → loop.lifecycleBackoff), but both build
    // their rows from the assignments path; fleet:status builds its roster from
    // fleet-roster.ts's sessionState/wakeability oracle and had no per-member loop
    // read at all. This is that batch read — the SAME computeLifecycleBackoff output,
    // not a second derivation.
    //
    // It depends on the roster (it needs the owner ids), so it cannot join the
    // Promise.all above; it runs after, bounded like every other optional leg.
    // `null` is the honest degraded value: an unread loop table must never render as
    // "no member is backed off", which is the false all-clear this exists to prevent.
    const loopStatusesResult = await withBoundedTimeout<Map<string, LoopStatus> | null>(
      roster.length === 0
        ? Promise.resolve(new Map<string, LoopStatus>())
        : getLoopStatuses(roster.map((m) => m.agentId)),
      {
        fallback: null,
        timeoutMs: FLEET_STATUS_OPTIONAL_LEG_TIMEOUT_MS,
        label: 'fleet:status:loopStatuses',
      },
    );
    const loopStatuses = loopStatusesResult.value;
    const degradedLegs: string[] = [
      ...rosterResult.degradedLegs.map((leg: FleetRosterDegradedLeg) => `roster.${leg}`),
      ...(loopStatusesResult.degraded || loopStatuses == null ? ['loopStatuses'] : []),
      ...(completionStatsResult.degraded ? ['completionStats'] : []),
      ...(runningBeesResult.degraded ? ['runningBees'] : []),
      ...(beeCountResult.degraded ? ['beeCount'] : []),
      ...(headcountTargetResult.degraded ? ['headcountTarget'] : []),
      ...(headcountCurrentResult.degraded ? ['headcountCurrent'] : []),
      ...(everMembersResult.degraded ? ['everMembers'] : []),
      // Only a genuinely-failed attestation is its own degraded leg: when the
      // roster leg already failed, this one was never attempted and reporting it
      // would name the wrong cause.
      ...(headcountCurrentResult.value != null &&
      (headcountExecutingResult.degraded || headcountExecutingResult.value == null)
        ? ['headcountExecuting']
        : []),
    ];
    const headcount = projectFleetHeadcountState(
      headcountTargetResult.value,
      fleet.lastLaunchTransaction,
      headcountCurrentResult.value,
      headcountExecutingResult.value,
      {
        measuredAt: new Date().toISOString(),
        scope: {
          workspace: workspaceId,
          fleet: fleetSlug,
          ...(args.harness ? { harness: args.harness } : {}),
        },
      },
    );
    const populationLifecycle = buildFleetPopulationLifecycle({
      fleet: fleetSlug,
      candidates: roster,
      everMemberIds: [...everMembersResult.value],
      everMembersAvailable: !everMembersResult.degraded,
      everMembersReason: everMembersResult.degraded ? 'fleet membership read timed out or failed' : undefined,
      fleetStartedAtMs: fleet.createdAt,
      observedAtMs: Date.now(),
      target: headcount,
    }).snapshot;
    // WI-1764 #4 / WI-1813: `memberCount` = VISIBLE desktop su members from the roster
    // (presence — members-only, was roster.length). `beeCount` = BACKGROUND bees spawned
    // INTO this fleet, from the nursery (countRunningFleetBees — reliable + presence-
    // independent) rather than the roster's presence-labeled split, which under-counted a
    // bee that had not yet written its presence fleet label.
    // EI-7137: splitFleetRosterCounts's own contract is "a set of LIVE fleet-roster
    // entries" — but `roster` here is the FULL roster (every presence row tagged with
    // this fleet_slug, including ones EI-5858's wakeability reconciliation has already
    // marked sessionState:'ended'/'suspect'/'draining'). Passing it in unfiltered let memberCount count dead
    // former members forever (observed live: memberCount=19 for a 10-live fleet after a
    // wave died). non-runnable `sessionState` values are the authoritative dead signal (a stale-but-
    // still-heartbeating row can otherwise mask a dead session — see EI-5858) — filter
    // those out before counting, but keep them in the full `members[]` list below (still
    // wants full visibility, including who died or is still bootstrapping, for the
    // leader/owner reading this). A `recorded` row is not counted as a runnable roster
    // member; the separate recorded-session liveness leg still decides whether the
    // durable leader is positively live.
    const liveRoster = roster.filter(
      (m) => !['ended', 'suspect', 'draining', 'recorded'].includes(m.sessionState ?? ''),
    );
    const { members: memberCount } = splitFleetRosterCounts(liveRoster);
    const launchTransactionUnconfirmedMembers = classifyLaunchTransactionUnconfirmedMembers(
      fleet.lastLaunchTransaction?.unconfirmedMemberIds,
      roster,
      rosterResult.degradedLegs,
    );

    // The registry's leader is durable, while its liveness belongs to the roster.
    // Do not return that durable id as an unannotated `leader`: callers naturally read
    // the same bare shape as "this is the active authority". `leaderId` preserves the
    // identity for callers that need it; `leader` carries the joined liveness verdict.
    // A missing roster row is UNKNOWN (not vacancy); only an explicit ended/recorded
    // verdict is positive evidence that the slot is gone. A null registry leader is an
    // explicit vacancy.
    const leaderMember = fleet.leaderOwnerId
      ? reconciledRoster.find((member) => member.agentId === fleet.leaderOwnerId)
      : undefined;
    const leaderRecordedLive = rosterResult.leaderLiveness?.recordedLive === true;
    const leaderSessionState = leaderMember?.sessionState ?? (leaderRecordedLive ? 'recorded' : null);
    const leaderEvidenceComplete =
      fleet.leaderOwnerId == null || rosterResult.leaderLiveness?.complete === true;
    const leaderLive =
      isLeaderPresentSessionState(leaderSessionState) ||
      (leaderEvidenceComplete && (leaderSessionState === 'recorded' || leaderRecordedLive));
    const leaderVacant = fleet.leaderOwnerId == null || (leaderEvidenceComplete && !leaderLive);
    const leaderMissingSinceMs = leaderVacant ? fleet.leaderMissingSinceMs ?? null : null;
    const leaderMissingGraceRemainingMs = leaderMissingSinceMs == null
      ? null
      : Math.max(0, leaderMissingSinceMs + FLEET_LEADER_MISSING_GRACE_MS - Date.now());
    const leaderVacancy = {
      state: fleet.leaderOwnerId == null
        ? 'unassigned'
        : !leaderEvidenceComplete
          ? 'unknown'
          : leaderLive
            ? 'leader-live'
            : 'complete-absence',
      vacant: leaderVacant,
      livenessComplete: leaderEvidenceComplete,
      recordedLive: fleet.leaderOwnerId == null
        ? null
        : rosterResult.leaderLiveness?.recordedLive ?? null,
      missingSinceMs: leaderMissingSinceMs,
      graceMs: FLEET_LEADER_MISSING_GRACE_MS,
      graceRemainingMs: leaderMissingGraceRemainingMs,
    };
    const leaderLiveness = fleet.leaderOwnerId
      ? {
          agentId: fleet.leaderOwnerId,
          // An absent oracle row is not evidence of a live session. Keep the
          // distinction from an explicit ended row in `presenceRow`.
          sessionState: leaderMember?.sessionState ?? 'unknown',
          heartbeatFresh: leaderMember
            ? (leaderMember.heartbeatFresh ?? leaderMember.alive ?? false)
            : false,
          lastActiveSecAgo: leaderMember?.lastActiveSecAgo ?? null,
          presenceRow: leaderMember != null,
        }
      : null;
    const blockedLiveMemberCount = fleet.leaderOwnerId != null && leaderVacant
      ? liveRoster.filter((member) => member.fleetRole === 'member' && member.sessionState === 'live').length
      : 0;
    const leadershipBlockage = blockedLiveMemberCount > 0
      ? {
          reason: leaderSessionState === 'ended'
            ? 'registered-leader-ended' as const
            : 'registered-leader-missing' as const,
          leaderOwnerId: fleet.leaderOwnerId!,
          liveMemberCount: blockedLiveMemberCount,
        }
      : null;

    // agent-launch-resume-primitives P-006 / D-006: there is deliberately NO
    // "resume the fleet" verb — any single verb has to GUESS which dead members to
    // revive (all of them? only the ones that died this hour? not the one killed two
    // days ago you never want back), and every guess is wrong for someone. So give
    // the leader the FACTS instead: for each ENDED member, when it died and whether a
    // session is actually resumable — and let it compose the revival per member
    // (capability:launch-agent { resume: { agentId } }, or fresh, or a fork).
    const endedIds = roster
      .filter((m) => ['ended', 'suspect'].includes(m.sessionState ?? ''))
      .map((m) => m.agentId);
    let resumableByOwner = new Map<
      string,
      { sessionId: string | null; endedAt: string | null; endedBy: AdvSessionEndedBy | null }
    >();
    if (endedIds.length) {
      try {
        const { advSessionsByCoordOwner } = await import('../../adv-sessions');
        const advByOwner = await advSessionsByCoordOwner();
        resumableByOwner = new Map(
          endedIds
            .map((id) => [id, advByOwner.get(id)] as const)
            .filter((e): e is [string, NonNullable<(typeof e)[1]>] => !!e[1])
            .map(([id, row]) => [
              id,
              { sessionId: row.sessionId, endedAt: row.endedAt, endedBy: row.endedBy },
            ]),
        );
      } catch {
        // Best-effort enrichment — a lookup failure must never fail the status read.
        resumableByOwner = new Map();
      }
    }

    // LAUNCH-PROBE FALSE-NEGATIVE CROSS-CHECK. `launchTransaction.failed` records what a ~25s probe saw at
    // spawn time; it is not an observation of whether the member worked. Two members stamped "AGENT DID NOT
    // START" on 2026-08-16 went on to close 15 evidenced items over 15-19h while this surface reported an
    // empty fleet. The registry holds both halves — the launch record and the work ledger — so it runs the
    // falsifier itself rather than leaving it to a reader who will forget.
    const failedOwnerIds = (fleet.lastLaunchTransaction?.failed ?? [])
      .map((f) => f?.ownerId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    let launchVerification: Awaited<ReturnType<typeof crossCheckLaunchVerification>> = {
      launchVerificationFalseNegative: [],
    };
    if (failedOwnerIds.length > 0) {
      try {
        const { getOrgPg } = await import('@papercusp/db-org');
        const { sql } = getOrgPg();
        launchVerification = await crossCheckLaunchVerification(
          failedOwnerIds,
          buildOwnerActivityReader(
            sql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<Record<string, unknown>[]>,
            fleet.workspaceId,
          ),
        );
      } catch (e) {
        // UNKNOWN, not clean. A cross-check that could not run must never render as "checked, nothing found".
        launchVerification = {
          launchVerificationFalseNegative: null,
          note: `launch-verification cross-check unavailable (${e instanceof Error ? e.message : String(e)}); the failed[] list is UNVERIFIED.`,
        };
      }
    }

    return {
      data: {
      ok: true,
      slug: fleet.fleetSlug,
      title: fleet.title,
      description: fleet.description,
      leader: leaderLiveness,
      leaderId: fleet.leaderOwnerId,
      leaderLive,
      leaderSessionState,
      leaderVacant,
      leaderVacancy,
      ...(leadershipBlockage ? { leadershipBlockage } : {}),
      // P-009 (H4): the typed control state — 'winding-down' means members must
      // checkpoint + release and pull no new work until fleet:resume.
      controlState: fleet.controlState,
      launchTransaction: fleet.lastLaunchTransaction,
      ...(launchTransactionUnconfirmedMembers.length > 0
        ? { launchTransactionUnconfirmedMembers }
        : {}),
      ...launchVerification,
      ...(fleet.controlState !== 'active'
        ? { controlReason: fleet.controlReason, controlBy: fleet.controlBy, controlAt: fleet.controlAt }
        : {}),
      memberCount,
      beeCount,
      runningBees,
      headcount,
      populationLifecycle,
      members: roster.map((m) => ({
        agentId: m.agentId,
        label: m.ownerLabel ?? m.label,
        fleetRole: m.fleetRole,
        intent: m.intent,
        // P-008 (presence-derivation-unification-2026-07-17): the ambiguous
        // `alive` boolean is RETIRED from this payload. `sessionState` is the
        // verdict (live | parked | draining | suspect | ended | recorded);
        // `heartbeatFresh` is the RAW keepalive-freshness signal under its
        // honest name (a warm-dead session reads heartbeatFresh:true +
        // sessionState:'ended'). Read sessionState for "is X working".
        heartbeatFresh: m.heartbeatFresh ?? m.alive,
        sessionState: m.sessionState,
        lastActiveSecAgo: m.lastActiveSecAgo,
        doing: m.doing,
        load: m.load,
        // WI-7286: present ONLY when this member's loop is actually backed off, so a
        // healthy fleet's payload stays byte-identical (the same convention degraded/
        // degradedLegs follows). Absent therefore means one of two things, and
        // `degradedLegs` is what tells them apart: no backoff (leg read fine), or the
        // loop read degraded (leg named there). Mirrors decorateLoopMonitorStates:
        // an INACTIVE loop reports no backoff, because a disarmed loop is not silenced.
        ...(() => {
          const loop = loopStatuses?.get(m.agentId);
          const backoff: LifecycleBackoffInfo | null = loop?.active
            ? (loop.lifecycleBackoff ?? null)
            : null;
          return backoff ? { lifecycleBackoff: backoff } : {};
        })(),
        // P-006: only on the dead — what a leader needs to decide whether (and how) to
        // bring this one back. `resumable:true` ⇒ `capability:launch-agent { resume:
        // { agentId }, fleet, brief }` restores it mid-thread with its context intact.
        ...(['ended', 'suspect'].includes(m.sessionState ?? '')
          ? (() => {
              const r = resumableByOwner.get(m.agentId);
              // P-015: `endedAt` is only an observation when the session reported its OWN
              // exit. Otherwise a sweeper stamped now() on noticing a process that was
              // already gone, and a leader reading these as death times sees an artificial
              // cluster — the WI-7126 misdiagnosis. Say so inline, on the row.
              const endedAtIsNotice = r != null && r.endedAt != null && r.endedBy !== 'self';
              return {
                endedAt: r?.endedAt ?? null,
                endedBy: r?.endedBy ?? null,
                ...(endedAtIsNotice
                  ? {
                      endedAtIsNoticeTime: true,
                      endedAtCaveat: `endedAt here is when ${r.endedBy ?? 'an unrecorded writer'} NOTICED this session was gone, not when it ended — the true end time is unknown. Read coord_presence.last_active_at for this owner instead. Do not read a cluster of these as a simultaneous event (WI-7126).`,
                    }
                  : {}),
                resumable: !!r?.sessionId,
                resumableSessionId: r?.sessionId ?? null,
                ...(r?.sessionId
                  ? {}
                  : {
                      resumeHint:
                        'no native session id recorded (an omp thread, or a row predating native-id tracking) — launch this lane fresh instead',
                    }),
              };
            })()
          : {}),
      })),
      ...(completionStats ? { completionStats } : {}),
      // WI-3818: present ONLY when something degraded — a healthy call's shape
      // stays byte-identical to pre-WI-3818 behavior. `degraded:true` means the
      // roster/counts above may be incomplete (a slow leg fell back rather than
      // hanging); `degradedLegs` names exactly which ones.
      ...(degradedLegs.length > 0 ? { degraded: true, degradedLegs } : {}),
      },
    };
  },
});
