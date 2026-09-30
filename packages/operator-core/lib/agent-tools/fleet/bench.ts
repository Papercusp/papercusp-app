/**
 * fleet:bench — bench a fleet member as TRACKED STATE
 * (fleet-reliability-verification-2026-07-10 P-006, EI-9000).
 *
 * Night-shift lesson this replaces (P-005's own repro, quoted on the plan
 * item): "leader could not trust emit alone for the phase3-open bench — one
 * member parked unregistered, one polled." The hand-written workaround was
 * per-member and easy to get half-right: the leader would ask a member to
 * "go events:await this key", trust they actually did, then ALSO
 * directed-wake each one as a belt-and-suspenders fallback because there was
 * no way to confirm the await landed. This tool makes benching something the
 * LEADER does centrally and can immediately verify, instead of something
 * each member does silently on their own:
 *
 *   fleet:bench { member, wakeEvent, stagedAssignment }
 *     → captures member's wake handle THIS moment (captureWakeHandleForOwner,
 *       the same D-003 capture events:await itself uses — just aimed at
 *       `member` instead of the caller) and registers the await FOR them,
 *       tagging the row's `note` with the staged assignment so it reads back
 *       as "why they're benched", not just a bare event key.
 *     → returns `registered: false` IMMEDIATELY when no resumable session was
 *       found for `member` — a bench miss caught at STAGE TIME, before the
 *       leader ever emits and finds out the hard way. Combined with
 *       events:emit's `waiters`/`woken` counts (P-005, already landed), the
 *       leader has miss-visibility at BOTH ends of a bench: whether it
 *       registered, and whether it actually fired.
 *   fleet:bench { list: true, fleet? }
 *     → the query half: who's benched on my fleet, on what key, with what
 *       staged leg. DERIVED, no new table (reuse-first) — this is exactly
 *       `listParkedAwaitsForSubscribers` (the same read fleet:assignments'
 *       `parkedOn` decoration already uses) filtered to bench-tagged rows and
 *       reshaped with the staged-assignment text restored from the note.
 *
 * A resolved bench (fired or cancelled) simply stops appearing in `list` —
 * the underlying event_awaits row is one-shot by construction (D-002), so
 * there is nothing to separately clean up.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { resolveAgentIdentity, deriveFleetMembership } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { listFleetsLedBy } from '../../agent-fleets-store';
import { groupByAgent, listFleetAssignments } from '../../fleet/assignments';
import { captureWakeHandleForOwner } from '../../events/await/handle';
import {
  registerAwait,
  listParkedAwaitsForSubscribers,
  FLEET_BENCH_NOTE_PREFIX,
} from '../../events/await/store';
import { registerBenchPark } from '../../fleet/bench-park';
import { isPattern, expandPatternMacro, assertUsablePattern } from '../../events/await/pattern';
import { AWAIT_MAX_TIMEOUT_SEC } from '../../events/await/types';
import { withBoundedTimeout } from '../../bounded-timeout';
import { getClaimSpecRecord, resolveClaimSpecWorkspace } from '../../scheduler/claim-spec-store';
import { claimSpecFilterToClaimablePayloadFilter } from '../../scheduler/claim-spec-payload-filter';
import { hardText, softText, clampText, LIMITS } from '../limits';
import { readFleetLaneHealth } from '../../fleet/lane-health';
import { resolvePresenceFleet } from '../coordination/presence-fleet';

/** Tags a bench-staged await's `note` so `list` can pick it out from every
 *  OTHER reason an agent might hold an active await (a plain events:await, a
 *  lock wake_on_grant, …) sharing the same table. */
const BENCH_NOTE_PREFIX = FLEET_BENCH_NOTE_PREFIX;

/**
 * EI-21334781727749359 — THE STAGE PATH'S READ LEGS ARE BOUNDED.
 *
 * The incident: a leader renewed a bench for sixteen members at once. Every one of
 * those sixteen calls exceeded the MCP client deadline, and every one of them
 * warned that the mutation MAY have executed — so the leader had to hand-verify
 * sixteen rows before it could safely retry. The invocation ledger shows what
 * actually happened: all sixteen ran genuinely concurrently, each took ~34-36.5s
 * SERVER-side, and each returned `status: ok`. The server was succeeding; the
 * client had simply stopped waiting. Nothing was broken — it was too slow to be
 * reachable, which is indistinguishable from broken at the call site.
 *
 * WHY it is slow, measured rather than assumed: the claim-candidate aggregate
 * behind `readFleetLaneHealth` is the most expensive query family in this system
 * (pg_stat_statements: mean 3.5-12s, max ~15s, ~50,000s of cumulative DB time
 * across ~7,900 calls). Benching is inherently PER MEMBER, so renewing a bench for
 * N members fires N of these AT ONCE. In the same 55s window the cheap tools were
 * completely healthy — 296 `coord:glance`/`activity:report` calls averaged ~280ms —
 * while every tool that runs this aggregate went slow together (`scheduler:get_next`
 * 25s, `fleet:leader-brief` 24s, `coord:orient` 15.5s). So this is not general host
 * load and not pool starvation: it is a specific expensive read, fanned out N-wide
 * by this tool's own per-member shape, with no budget on it.
 *
 * The two legs fail in DELIBERATELY OPPOSITE directions, because they guard
 * opposite things:
 *
 *  - LANE HEALTH FAILS OPEN. Design note (1) above already requires this: an
 *    unreadable count must never refuse, or one slow read wedges every bench on the
 *    fleet and a read failure becomes a coordination outage. A read that cannot
 *    finish in budget IS an unreadable count, so it takes the EXISTING
 *    `verdict:'unknown'` path rather than a new one. All that is added is honesty
 *    about WHICH kind of unknown it was — a timeout is reported as a timeout
 *    instead of being silently indistinguishable from a spec-read error.
 *  - THE ROSTER FAILS CLOSED. It is the EI-21277320983534020 membership check, so
 *    degrading it to "assume the member exists" would re-open exactly that hole and
 *    allocate a bench row that can never wake anyone. An unreadable roster refuses
 *    fast instead, BEFORE any state is allocated — a retryable answer in seconds,
 *    with no mutation and therefore no ambiguity about whether one happened.
 *
 * Bounding is the fix rather than a mitigation because the caller-visible defect is
 * the UNBOUNDEDNESS: a tool whose worst case is "silently past the client deadline,
 * mutation state unknown" has no safe way to be called. Making the aggregate itself
 * cheaper is a separate, system-wide concern shared with get_next/leader-brief/orient
 * (recorded on this item's completion evidence); it would not make an unbounded call
 * safe, and this bound holds even if that cost regresses again.
 */
const BENCH_ROSTER_READ_BUDGET_MS = 5_000;
const BENCH_LANE_READ_BUDGET_MS = 6_000;
const BENCH_FLEET_RESOLUTION_BUDGET_MS = 1_500;

export type BenchFleetTarget =
  | { kind: 'explicit' | 'led' | 'presence'; fleet: string }
  | { kind: 'ambiguous'; fleets: string[] }
  | { kind: 'none' };

/**
 * Resolve the omitted-fleet target with the same precedence as fleet:leader-brief:
 * explicit input wins, then one durable leadership relation, then current
 * presence. Multiple durable led fleets are never guessed from the single
 * presence label. The launch environment is supplied to resolvePresenceFleet as
 * its failure-only fallback, so a successful presence read that returns no row
 * does not resurrect stale launch-time membership.
 */
export function resolveBenchFleetTarget(input: {
  explicitFleet?: string;
  presenceFleet: string | null;
  ledFleets: readonly string[];
}): BenchFleetTarget {
  if (input.explicitFleet !== undefined) {
    return input.explicitFleet ? { kind: 'explicit', fleet: input.explicitFleet } : { kind: 'none' };
  }

  const ledFleets = [...new Set(input.ledFleets.map((fleet) => fleet.trim()).filter(Boolean))];
  if (ledFleets.length === 1) return { kind: 'led', fleet: ledFleets[0] };
  if (ledFleets.length > 1) return { kind: 'ambiguous', fleets: ledFleets };
  return input.presenceFleet ? { kind: 'presence', fleet: input.presenceFleet } : { kind: 'none' };
}

async function resolveBenchFleet(input: {
  explicitFleet?: string;
  ownerId?: string;
  workspaceId: string;
}): Promise<BenchFleetTarget> {
  if (input.explicitFleet !== undefined) {
    return resolveBenchFleetTarget({
      explicitFleet: input.explicitFleet,
      presenceFleet: null,
      ledFleets: [],
    });
  }

  const launchFallback = deriveFleetMembership();
  const [presenceRead, ledRead] = await Promise.all([
    withBoundedTimeout(resolvePresenceFleet(input.ownerId, launchFallback), {
      fallback: { fleetSlug: null, fleetRole: null },
      timeoutMs: BENCH_FLEET_RESOLUTION_BUDGET_MS,
      label: 'fleet-bench:presenceFleet',
    }),
    input.ownerId
      ? withBoundedTimeout(listFleetsLedBy(input.workspaceId, input.ownerId), {
          fallback: [],
          timeoutMs: BENCH_FLEET_RESOLUTION_BUDGET_MS,
          label: 'fleet-bench:ledFleets',
        })
      : Promise.resolve({ value: [], degraded: false, reason: null }),
  ]);

  return resolveBenchFleetTarget({
    presenceFleet: presenceRead.value.fleetSlug,
    ledFleets: ledRead.value.map((record) => record.fleetSlug),
  });
}

/**
 * WI-5938 — PARK/PULL IS DERIVED STATE, NOT PROSE.
 *
 * The incident: a leader sent ONE message that both asserted the lane was live AND told
 * members to park. Park is correct only for a DRAINED lane; pull is correct for a live
 * one. The directive was self-contradictory, five members obeyed the park half, and they
 * idled beside a nonempty queue. `fleet:leader-brief` already knew better — it emits the
 * literal advice "DO NOT fleet:bench it either — the lane is not drained" — but that
 * advice was PROSE the leader had to read, remember and re-derive, while `fleet:bench`
 * itself would happily park anyone.
 *
 * So the invariant moves out of the leader's memory and into the tool: benching is for a
 * drained or blocked lane BY DEFINITION, and a bench against a member with claimable work
 * is not a judgement call the leader gets to make loosely — it is a contradiction. This
 * makes an incorrect bench IMPOSSIBLE by default rather than merely discouraged.
 *
 * Two deliberate design choices, both about failure direction:
 *
 *  1. UNKNOWN FAILS OPEN. `readFleetLaneHealth` returns `null` (never 0) when the count
 *     could not be read. A null must NOT refuse: that would let a transient spec/PG read
 *     error wedge every bench on the fleet, converting a read failure into a coordination
 *     outage. Refuse only on a number we actually have, and say so in the reply.
 *  2. GATED IS NOT DRAINED — BUT IT IS STILL BENCHABLE. `claimable === 0` with
 *     `matchedByFilter > 0` means the backlog exists but every row is behind a claim floor
 *     (EI-18689489507862177). That is precisely a BLOCKED lane, which is a legitimate
 *     reason to bench. The refusal therefore keys on `claimable > 0` — work the member
 *     could take RIGHT NOW — not on the mere existence of matching rows.
 *
 * `force: true` is the escape hatch, mirroring `work_items:claim`'s claim-hold bypass: a
 * leader with a genuine cross-lane reason (bench everyone until a migration lands) is not
 * wedged, but must ask for it deliberately, and the refusal detail is echoed back on the
 * response so the override is visible rather than silent.
 */
export interface BenchQueueVerdict {
  refuse: boolean;
  claimable: number | null;
  matchedByFilter: number | null;
  specRef: string | null;
  /** Why we did NOT refuse, when we did not — so a caller never reads silence as "drained". */
  reason: 'queue-nonempty' | 'drained' | 'gated' | 'unknown';
}

/** PURE: the whole park/pull decision, exported for direct unit-testing (no PG/DI). */
export function benchQueueVerdict(
  lane: {
    claimable: number | null;
    matchedByFilter: number | null;
    spec?: { ref?: string | null };
    effective?: {
      claimable: number | null;
      matchedByFilter: number | null;
    };
  } | null,
): BenchQueueVerdict {
  const counts = lane?.effective ?? lane;
  if (!lane || !counts || counts.claimable == null) {
    // Fails OPEN — see (1) above. An unreadable count is not a drained lane, and it is
    // also not grounds to block the leader.
    return { refuse: false, claimable: null, matchedByFilter: null, specRef: null, reason: 'unknown' };
  }
  const specRef = lane.spec?.ref ?? null;
  if (counts.claimable > 0) {
    return {
      refuse: true,
      claimable: counts.claimable,
      matchedByFilter: counts.matchedByFilter,
      specRef,
      reason: 'queue-nonempty',
    };
  }
  return {
    refuse: false,
    claimable: counts.claimable,
    matchedByFilter: counts.matchedByFilter,
    specRef,
    // See (2) above: 0 claimable with rows still matching the filter is a GATED lane,
    // which is a blocked lane, which is a benchable lane — but the caller is told which
    // of the two it was, because the remedies are completely different.
    reason: counts.matchedByFilter == null ? 'unknown' : counts.matchedByFilter > 0 ? 'gated' : 'drained',
  };
}

export interface BenchedMember {
  member: string;
  event: string;
  stagedAssignment: string | null;
  benchedAt: string;
  expiresTs: string | null;
}

/** PURE: exported for direct unit-testing (no PG/DI ceremony needed). */
export function projectBenchRows(
  rows: ReadonlyArray<{ subscriberId: string; eventKey: string; note: string | null; expiresTs: string | null; createdAt: string }>,
): BenchedMember[] {
  return rows
    .filter((r) => typeof r.note === 'string' && r.note.startsWith(BENCH_NOTE_PREFIX))
    .map((r) => ({
      member: r.subscriberId,
      event: r.eventKey,
      stagedAssignment: (r.note as string).slice(BENCH_NOTE_PREFIX.length) || null,
      benchedAt: r.createdAt,
      expiresTs: r.expiresTs,
    }));
}

interface BenchPayloadFilterScope {
  filter: unknown | null;
  source: { source: 'cup' | 'fleet'; specId: string; revision: number | null } | null;
}

/**
 * Resolve the same claim-spec-derived wake filter used by events:await, but for
 * the member the leader is staging. A bench is centrally registered by the
 * leader, so the caller's own spec is the wrong identity here. Keep the probe
 * bounded and fail-soft: an unavailable spec read must not prevent a member
 * from being parked, but the response must disclose when it stayed unscoped.
 */
async function resolveBenchPayloadFilter(member: string, workspaceId: string | null): Promise<BenchPayloadFilterScope> {
  const probe = await withBoundedTimeout(
    getClaimSpecRecord({
      cupId: member,
      workspaceId: resolveClaimSpecWorkspace(workspaceId ?? undefined),
    }),
    { fallback: null, timeoutMs: 1_500, label: 'fleet-bench:claimSpecFilter' },
  );
  const record = probe.value;
  if (!record || record.source === 'default') return { filter: null, source: null };

  const derived = claimSpecFilterToClaimablePayloadFilter(record.spec.view.filter) ?? null;
  const harnessLeaf = record.harnessSlug ? { harness: { equals: record.harnessSlug } } : null;
  const filter = derived && harnessLeaf ? { all: [derived, harnessLeaf] } : (harnessLeaf ?? derived);
  return {
    filter,
    source: filter
      ? { source: record.source, specId: record.spec.specId, revision: record.revision }
      : null,
  };
}

type FleetRosterRows = Awaited<ReturnType<typeof listFleetAssignments>>;

/**
 * Bounded fleet-roster read (EI-21334781727749359). `null` means the read did NOT
 * finish inside its budget, or threw — which this tool treats as REFUSE, never as
 * "the roster came back empty" and therefore never as "that member is absent".
 * Collapsing an unreadable roster into an absent member is precisely the confusion
 * an absence claim without a positive control produces.
 */
async function readFleetRosterBounded(
  args: Parameters<typeof listFleetAssignments>[0],
): Promise<{ rows: FleetRosterRows | null; reason: 'timeout' | 'aborted' | 'error' | null }> {
  const read = await withBoundedTimeout<FleetRosterRows | null>(
    () => listFleetAssignments(args),
    { fallback: null, timeoutMs: BENCH_ROSTER_READ_BUDGET_MS, label: 'fleet-bench:roster' },
  );
  // withBoundedTimeout absorbs a THROW as well as a deadline, so carry which one it
  // was. Reporting a failed read as "timed out" would be a small lie that sends the
  // reader to look at load when the real answer is in an exception.
  return { rows: read.value, reason: read.value === null ? (read.reason ?? 'error') : null };
}

/** The one refusal shape for an unreadable roster, shared by both modes so they
 *  cannot drift into disagreeing about what an unreadable roster means. */
function rosterUnavailable(fleet: string, reason: 'timeout' | 'aborted' | 'error' | null, member?: string) {
  const timedOut = reason === 'timeout';
  return {
    data: {
      ok: false as const,
      error: 'roster_read_timeout' as const,
      reason: reason ?? 'error',
      fleet,
      ...(member ? { member } : {}),
      ...(timedOut ? { budget_ms: BENCH_ROSTER_READ_BUDGET_MS } : {}),
      hint:
        (timedOut
          ? `The fleet roster for '${fleet}' did not come back within ${BENCH_ROSTER_READ_BUDGET_MS}ms, `
          : `The fleet roster read for '${fleet}' FAILED (not a timeout — it threw), `) +
        'so membership could not be verified. NOTHING was staged and no state was allocated — this is a ' +
        'clean, retryable refusal, not an ambiguous partial write. Retry; if it persists, read ' +
        'fleet:assignments directly to see whether the roster read itself is unhealthy.',
    },
  };
}

export default defineTool({
  name: 'fleet:bench',
  profile: 'engineer',
  description:
    "Bench a fleet member as TRACKED, queryable state instead of a hand-written per-member " +
    "convention. STAGE: fleet:bench { member, wakeEvent, stagedAssignment } captures the " +
    "member's wake handle and registers the events:await FOR them (note carries the staged " +
    "assignment) — returns `registered:false` immediately if no resumable session " +
    "was found for that member. LIST: " +
    "fleet:bench { list: true } (optionally { fleet }) returns who is benched on YOUR fleet, " +
    "on what key, with what staged leg. Pairs with events:emit's `waiters`/`woken` counts " +
    "(P-005) for miss-visibility at both stage time and emit time. An exact " +
    "`work-item:claimable` bench auto-narrows to the staged member's claim spec.",
  guidance: {
    when:
      "A leader staging a member's NEXT assignment while they wait on something (a watermark, " +
      "a peer's fix, a bench key) — instead of asking the member to events:await it themselves " +
      "and hoping it landed. Also the query surface for 'who is benched on what right now'.",
    notWhen:
      "The member is awaiting something on their OWN initiative (they call events:await " +
      "directly). A one-off nudge — use coord:send / coord:wake. Fleet-wide health at a " +
      "glance — fleet:leader-brief already surfaces `parkedOn` per member.",
    chaining:
      "fleet:bench { member, wakeEvent, stagedAssignment } → (later) events:emit { event: " +
      "wakeEvent } wakes them, staged leg rides the wake note → fleet:bench { list: true } " +
      "any time to check current bench state.",
    returns:
      "STAGE mode REFUSES with { ok:false, error:'bench_refused_queue_nonempty' } when the " +
      "member's own lane still has claimable work (WI-5938): park is correct only for a " +
      'DRAINED or BLOCKED lane, pull is correct for a live one, and a leader message that ' +
      'asserts both is self-contradictory — five members once obeyed the park half and idled ' +
      'beside a nonempty queue. The refusal carries `claimable`, `matched_by_filter` and ' +
      '`spec_ref` so you can see the count and the exact scoping that produced it. Wake them ' +
      'to pull instead; pass { force: true } only for a genuine cross-lane hold (the override ' +
      'is echoed back as `forced` + `force_note`, never silent). Every successful bench also ' +
      "carries `lane.verdict`: 'drained' (0 claimable, 0 matching) | 'gated' (0 claimable but " +
      "rows matched — blocked, still benchable) | 'unknown' (the count could not be read, so " +
      'the guard failed OPEN rather than wedging the fleet on a read error) — never a ' +
      'zero-ish reading dressed up as a verified-empty queue. Both read legs are BUDGETED ' +
      'so N concurrent per-member renewals cannot run past the client deadline with the ' +
      "write's fate unknown: an unreadable roster refuses fast with `roster_read_timeout` " +
      '(nothing staged, safe to retry), while a lane read that misses its budget benches ' +
      "anyway and reports `lane.unavailable_reason:'timeout'` — the guard was SKIPPED, " +
      'which is not evidence the lane was drained.',
    seeAlso: [
      'events:await (a member self-registering, instead of the leader staging it for them)',
      'events:emit (fires the key — reports waiters/woken)',
      'fleet:leader-brief (whole-fleet health glance, including parkedOn)',
      'work_items:claimable (the excludedBreakdown behind a gated lane — read it before forcing)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    list: z
      .boolean()
      .optional()
      .describe('Query mode: return the current bench roster instead of staging a new one.'),
    fleet: z
      .string()
      .max(120)
      .optional()
      .describe("(list mode) Fleet slug to query. Defaults to the caller's own launch-env fleet."),
    harness: z.string().max(80).optional(),
    workspace: z.string().max(120).optional(),
    member: hardText(LIMITS.IDENT)
      .optional()
      .describe('(stage mode) ownerId of the member being benched.'),
    wakeEvent: hardText(LIMITS.IDENT)
      .optional()
      .describe('(stage mode) Event key (or pattern — see events:await) that wakes this member.'),
    stagedAssignment: softText(LIMITS.ANNOTATION)
      .optional()
      .describe("(stage mode) What the member should pick up once woken — echoed on the wake and readable via { list: true }."),
    force: z
      .boolean()
      .optional()
      .describe(
        '(stage mode) Bench ANYWAY when the member\'s lane still has claimable work — the ' +
          'bench_refused_queue_nonempty override. For a genuine cross-lane hold (bench everyone ' +
          'until a migration lands), not for routine benching: the refused count is echoed back ' +
          'on the response so the override is visible rather than silent.',
      ),
    timeout_sec: z
      .number()
      .int()
      .positive()
      .max(AWAIT_MAX_TIMEOUT_SEC)
      .optional()
      .describe('(stage mode) Optional deadline in seconds — omitted means the bench remains registered until the wake event fires.'),
  }),
  // Stage and list modes intentionally share one extensible envelope. The
  // documented refusal fields (`ok`, `error`) are explicit; passthrough keeps
  // nested lane/bench diagnostics lossless as the coordination surface evolves.
  result: z
    .object({
      ok: z.boolean().optional(),
      error: z.string().optional(),
      fleet: z.string().nullable().optional(),
      member: z.string().optional(),
      fleets: z.array(z.string()).optional(),
      hint: z.string().optional(),
      reason: z.string().optional(),
      budget_ms: z.number().int().nonnegative().optional(),
      bench_id: z.string().optional(),
      event: z.string().optional(),
      pattern: z.boolean().optional(),
      stagedAssignment: z.string().nullable().optional(),
      expires_ts: z.string().nullable().optional(),
      registered: z.boolean().optional(),
      wake_handle_note: z.string().optional(),
      benched_by: z.string().nullable().optional(),
      benched_count: z.number().int().nonnegative().optional(),
      benched: z.array(z.unknown()).optional(),
      lane: z.unknown().optional(),
      forced: z.boolean().optional(),
      force_note: z.string().optional(),
      advice: z.string().optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    // Resolved defensively (mirrors fleet:leader-brief): a read-mostly fleet
    // tool should still work for `list` even if identity resolution fails —
    // only stage mode's `benched_by` stamp genuinely needs `ownerId`.
    let actorWorkspace: string | null = null;
    let ownerId: string | undefined;
    try {
      const identity = resolveAgentIdentity(ctx);
      actorWorkspace = identity.workspaceId ?? null;
      ownerId = identity.ownerId;
    } catch {
      actorWorkspace = null;
    }

    if (args.list) {
      const workspaceId = resolveConcreteWorkspaceId(args.workspace, actorWorkspace);
      const target = await resolveBenchFleet({
        explicitFleet: args.fleet,
        ownerId,
        workspaceId,
      });
      if (target.kind === 'ambiguous') {
        return {
          data: {
            ok: false,
            error: 'ambiguous_fleet',
            fleets: target.fleets,
            hint:
              'Multiple fleets are led by this agent, so the omitted fleet is ambiguous. ' +
              'Pass { fleet: "<slug>" } explicitly to query one bench roster.',
          },
        };
      }
      const fleet = target.kind === 'none' ? null : target.fleet;
      if (!fleet) {
        return {
          data: {
            ok: false,
            error: 'no_fleet',
            hint: "No fleet resolvable — pass { fleet: '<slug>' } explicitly.",
          },
        };
      }
      // Fleet membership is carried by presence rows, which are intentionally
      // harness-agnostic (`harness_slug IS NULL`).  A harness-wide filter here
      // drops a benched member who has no active claim—the exact row needed to
      // discover the registered bench.  The fleet slug is the authoritative
      // scope for this roster; keep the optional harness out of this read.
      const rosterRead = await readFleetRosterBounded({
        workspaceId,
        fleet,
        activeOnly: true,
      });
      if (rosterRead.rows === null) return rosterUnavailable(fleet, rosterRead.reason);
      const memberIds = groupByAgent(rosterRead.rows)
        .filter((g) => g.fleetSlug === fleet)
        .map((g) => g.agentId);
      const parked = memberIds.length > 0 ? await listParkedAwaitsForSubscribers(memberIds) : [];
      const benched = projectBenchRows(parked);
      return {
        data: {
          ok: true,
          fleet,
          benched_count: benched.length,
          benched,
        },
      };
    }

    if (!args.member || !args.wakeEvent) {
      return {
        data: {
          ok: false,
          error: 'missing_args',
          hint: 'Stage mode needs { member, wakeEvent, stagedAssignment }. Pass { list: true } to query instead.',
        },
      };
    }

    const workspaceId = resolveConcreteWorkspaceId(args.workspace, actorWorkspace);

    const fleetTarget = await resolveBenchFleet({
      explicitFleet: args.fleet,
      ownerId,
      workspaceId,
    });
    if (fleetTarget.kind === 'ambiguous') {
      return {
        data: {
          ok: false,
          error: 'ambiguous_fleet',
          member: args.member,
          fleets: fleetTarget.fleets,
          hint:
            'Multiple fleets are led by this agent, so the omitted fleet is ambiguous. ' +
            'Pass { fleet: "<slug>" } explicitly before staging a bench.',
        },
      };
    }
    const benchFleet = fleetTarget.kind === 'none' ? null : fleetTarget.fleet;

    // EI-21277320983534020: resolve the target against the authoritative fleet roster
    // before doing any staging work. An unknown ownerId must refuse loudly instead of
    // allocating a bench row that can never wake anyone; a resolvable member with no
    // tracked session still follows the existing registered:false bench-miss path.
    if (!benchFleet) {
      return {
        data: {
          ok: false,
          error: 'no_fleet',
          member: args.member,
          hint: "No fleet resolvable — pass { fleet: '<slug>' } explicitly.",
        },
      };
    }
    const stageRosterRead = await readFleetRosterBounded({
      workspaceId,
      fleet: benchFleet,
      activeOnly: true,
    });
    if (stageRosterRead.rows === null) {
      return rosterUnavailable(benchFleet, stageRosterRead.reason, args.member);
    }
    const memberGroups = groupByAgent(stageRosterRead.rows);
    if (!memberGroups.some((group) => group.agentId === args.member)) {
      return {
        data: {
          ok: false,
          error: 'member_not_found',
          member: args.member,
          fleet: benchFleet,
          hint:
            `No member matching '${args.member}' is present in fleet '${benchFleet}'. ` +
            'Check fleet:assignments for the authoritative ownerId before staging a bench.',
        },
      };
    }

    // WI-5938: park/pull is derived state — resolve it BEFORE staging anything, so a
    // refused bench never leaves a half-registered await behind.
    // EI-21334781727749359: BOUNDED. This is the ~3.5-12s claim-candidate aggregate,
    // and benching is per-member, so a leader renewing N benches fires N of them at
    // once. Unbounded, that is what pushed all sixteen concurrent renewals past the
    // client deadline with their mutation state unknown. A read that misses its budget
    // is an unreadable count, which takes the EXISTING fail-open path below.
    const laneRead = await withBoundedTimeout<Awaited<ReturnType<typeof readFleetLaneHealth>>>(
      () =>
        readFleetLaneHealth({
          fleet: benchFleet,
          harness: args.harness,
          workspaceId,
          // Scope the floors to the MEMBER being benched: their own held claims must not
          // count against them as an exclusion, or a member holding work would read as a
          // gated lane rather than a live one.
          assignee: args.member,
        }),
      { fallback: null, timeoutMs: BENCH_LANE_READ_BUDGET_MS, label: 'fleet-bench:laneHealth' },
    );
    const laneHealth = laneRead.value;
    // Distinguish the two ways a count goes unknown. Both fail open, but only one of
    // them means "ask again in a moment" — reporting them as the same thing is how a
    // transient slow read gets mistaken for a permanently unscoped lane.
    const laneUnavailableReason =
      laneHealth !== null ? null : laneRead.degraded ? (laneRead.reason ?? 'unreadable') : 'unreadable';
    const verdict = benchQueueVerdict(laneHealth);

    if (verdict.refuse && !args.force) {
      return {
        data: {
          ok: false,
          error: 'bench_refused_queue_nonempty',
          member: args.member,
          fleet: benchFleet,
          claimable: verdict.claimable,
          matched_by_filter: verdict.matchedByFilter,
          spec_ref: verdict.specRef,
          hint:
            `REFUSED: ${verdict.claimable} item(s) are claimable RIGHT NOW for ${args.member} under ` +
            `${verdict.specRef ?? 'this fleet\'s claim spec'}. Benching parks them next to work they ` +
            'should be pulling — the lane is not drained, so park is the wrong verb. Wake them to ' +
            'pull instead (coord:wake / scheduler:get_next). If the lane looks drained to you, the ' +
            "disagreement is the point: read work_items:claimable's excludedBreakdown under this " +
            'same spec before overriding. Genuine cross-lane hold? Re-send with { force: true }.',
          advice:
            'This is the WI-5938 invariant: fleet:bench is for a DRAINED or BLOCKED lane by ' +
            'definition. A leader message that both asserts the lane is live and tells members to ' +
            'park is self-contradictory — that contradiction is what this refusal makes impossible.',
        },
      };
    }

    const patternAwait = isPattern(args.wakeEvent);
    const eventKey = patternAwait ? expandPatternMacro(args.wakeEvent) : args.wakeEvent;
    if (patternAwait) assertUsablePattern(eventKey);

    const claimableFilterScope =
      !patternAwait && eventKey === 'work-item:claimable'
        ? await resolveBenchPayloadFilter(args.member, workspaceId)
        : { filter: null, source: null };

    const staged = clampText(args.stagedAssignment, LIMITS.ANNOTATION) ?? '';

    // D-009: the park itself lives in ../../fleet/bench-park so this leader-driven
    // surface and P-009's context-critical auto-bench register ONE park shape rather
    // than two that can drift. `supersedePriorBenches: true` is the LEADER semantic —
    // a leader staging a NEW assignment replaces the old one atomically, and
    // ordinary member-owned awaits are preserved by the note-prefix filter. An
    // auto-bench must pass false; see the hazard note in that module.
    const park = await registerBenchPark(
      {
        member: args.member,
        eventKey,
        stagedAssignment: staged,
        timeoutSec: args.timeout_sec ?? null,
        payloadFilter: claimableFilterScope.filter,
        supersedePriorBenches: true,
      },
      { captureWakeHandleForOwner, registerAwait },
    );
    const handleNote = park.wakeHandleNote;
    const supersededBenches = park.supersededBenches;

    return {
      data: {
        ok: true,
        // Await row ids are numeric internally, but the public tool envelope
        // declares bench_id as a string (and callers use it as an opaque id).
        bench_id: String(park.benchId),
        member: args.member,
        event: park.eventKey,
        ...(patternAwait ? { pattern: true } : {}),
        stagedAssignment: staged || null,
        expires_ts: park.expiresTs,
        registered: park.registered,
        wake_handle_note: handleNote,
        benched_by: ownerId,
        ...(supersededBenches > 0 ? { superseded_benches: supersededBenches } : {}),
        ...(claimableFilterScope.source
          ? {
              auto_scoped_payload_filter: true,
              payload_filter: claimableFilterScope.filter,
              payload_filter_source: claimableFilterScope.source,
              auto_scoped_payload_filter_advice:
                'The work-item:claimable bench is narrowed to the staged member\'s claim spec, so unrelated claimable rows will not wake this member.',
            }
          : eventKey === 'work-item:claimable'
            ? {
                unscoped_claimable_await: true,
                unscoped_claimable_advice:
                  'No sound payload filter was available for the staged member\'s claim spec, so this bench is UNSCOPED and may wake on unrelated work-item:claimable emissions.',
              }
            : {}),
        // WI-5938: always report WHICH lane state justified the park, so a bench is never
        // just an assertion. 'unknown' is reported honestly rather than rendered as
        // 'drained' — the whole bug class here is a zero-ish reading standing in for a
        // verified-empty queue.
        lane: {
          verdict: verdict.reason,
          claimable: verdict.claimable,
          matched_by_filter: verdict.matchedByFilter,
          spec_ref: verdict.specRef,
          // EI-21334781727749359: say WHY the count is unknown when it is. 'timeout'
          // means the guard was skipped because the read missed its budget — the bench
          // stands (fail-open, per design note (1)), but the park/pull check did NOT
          // run, so this is not evidence the lane is drained.
          ...(laneUnavailableReason
            ? {
                unavailable_reason: laneUnavailableReason,
                ...(laneUnavailableReason === 'timeout'
                  ? {
                      budget_ms: BENCH_LANE_READ_BUDGET_MS,
                      unavailable_advice:
                        `The lane read exceeded ${BENCH_LANE_READ_BUDGET_MS}ms, so the WI-5938 park/pull ` +
                        'guard was SKIPPED for this bench rather than wedging it. The bench is registered. ' +
                        'If you need the guarantee that this member had nothing claimable, read ' +
                        'work_items:claimable under the same spec and re-check.',
                    }
                  : {}),
              }
            : {}),
        },
        ...(verdict.refuse && args.force
          ? {
              forced: true,
              force_note:
                `OVERRIDE: benched past ${verdict.claimable} claimable item(s) under ` +
                `${verdict.specRef ?? "this fleet's claim spec"} because { force: true } was passed. ` +
                'This member is now parked beside work it could have pulled.',
            }
          : {}),
        advice:
          park.registered
            ? 'Benched. events:emit on this key will wake them; the staged assignment rides the wake note.'
            : `BENCH MISS at stage time: ${handleNote} — the await row exists but has no wake handle to re-invoke; emitting this key will not resume them. Confirm they have a live session before relying on this bench.`,
      },
    };
  },
});
