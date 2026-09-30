/**
 * fleet-population — make every fleet headcount SAY WHICH POPULATION IT COUNTED,
 * computed from the same predicate that produced the rows (P-010,
 * fleet-lead-instrumentation-audit-2026-08-09).
 *
 * WHY THIS EXISTS. Measured across a few minutes of one fleet, the SAME fleet read
 * as 11 members (leader-brief `summary.members`), then 11 rows and 14 rows
 * (leader-brief `members[]`, the second with `include_stale:true`), then 8 and 9
 * agents (fleet:assignments, claim-scoped). Every one of those numbers is
 * defensible on its own terms and NOTHING in any response reconciles them, so a
 * leader comparing two of them concludes members appeared or vanished. The
 * default that hides stale-idle members hides them precisely WHEN MEMBERS ARE
 * DYING, which is the moment the count matters most.
 *
 * THE FIX IS STRUCTURAL, NOT DOCUMENTARY. A `population: '...'` string that a
 * caller sets by hand next to a count it computed separately is exactly the
 * arrangement that drifts — the label keeps saying what the filter USED to do.
 * So {@link selectFleetPopulation} takes the candidates AND the predicate and
 * returns the rows and the census TOGETHER: the numbers are derived from the same
 * array and the same `keep` in one pass, and there is no supported way to publish
 * a census that disagrees with the rows shipped beside it.
 *
 * The census answers, in every response that carries a headcount:
 *   - which population is being counted (`population` + `basis`),
 *   - how many rows existed BEFORE this response's filter (`candidates`),
 *   - how many were withheld and WHY (`withheld` / `withheldReason`),
 *   - the exact argument that reveals them (`reveal`).
 *
 * `withheld: 0` is as informative as a nonzero one — it says the filter had
 * nothing to hide, which is the reading a bare count cannot give you.
 *
 * ── The SECOND way a headcount misleads (EI-21550192883916303) ───────────────
 * Saying which population you counted is not enough, because the remaining
 * number still reads as ACTIVITY. Measured 2026-08-26: an agent diagnosing a
 * saturated MCP proxy counted 415 processes carrying a fleet's slug and reported
 * "415 members are saturating the proxy". 411 of them were PARKED — zero in a
 * running state, ~9% of the box between them. The count was right; the word
 * "active" was the reader's, and nothing in the answer contradicted it.
 *
 * A census that says `counted: 415` and stops has told the reader the filter's
 * verdict and left the composition — the part that decides whether the number
 * means anything about load — to be assumed. So {@link composeLiveness} keys the
 * counted rows by `sessionState`, the SHARED liveness oracle, and
 * {@link renderPopulationCensus} states the split inline. Note the vocabulary
 * gap this closes: both call sites filter on `alive`, which is raw heartbeat
 * FRESHNESS, while `sessionState: 'live'` is the derived verdict "taking turns".
 * A warm-dead session is `alive: true, sessionState: 'ended'`, so the filter that
 * produces the count cannot itself answer the question the count gets read for.
 */

import type { SessionState } from '../coordination/presence-wakeability';
import {
  measuredCensus,
  selectPopulation,
  withShownCount as withShownCountCensus,
  type MeasuredPopulationCensus,
  type PopulationMeta,
} from '../../population-census';

/** How a row's liveness verdict is read. Null/undefined ⇒ counted as unknown. */
export type SessionStateOf<T> = (row: T) => SessionState | null | undefined;

/**
 * The liveness composition of the rows a census COUNTED.
 *
 * `counted` says how many rows passed the filter. This says what they are — and
 * it is the half that determines whether the count supports a conclusion about
 * work being done.
 */
export interface FleetLivenessComposition {
  /** Count per `sessionState`. Only states actually present appear. */
  byState: Partial<Record<SessionState, number>>;
  /** Counted rows whose `sessionState` did not resolve. */
  unknown: number;
  /** Rows with `sessionState: 'live'` — the only ones that are taking turns. */
  live: number;
  /** `live / counted`, 0 when nothing was counted. */
  liveShare: number;
  /**
   * True when the `live` rows are not a MAJORITY of the counted ones — i.e.
   * exactly when reading this count as a measure of activity would overstate it.
   * Named for the misreading rather than the data so a caller cannot render the
   * number without the caveat being in reach.
   *
   * The boundary is `live * 2 <= counted`, not `<`: at exactly half, the total
   * still overstates activity twofold, which is material. `unknown` rows count
   * against liveness for the same reason they get their own bucket — an
   * unresolved verdict is not evidence of work, and crediting it to `live` would
   * silence the caveat on precisely the reads that are least certain.
   */
  overstatesActivity: boolean;
  /**
   * The caveat AS TEXT, present only when `overstatesActivity`.
   *
   * This is not decoration. `renderPopulationCensus` has no callers — the census
   * reaches agents as a JSON OBJECT on `summary.population`, so a caveat that
   * lives only in an unrendered sentence ships to nobody, and a bare
   * `overstatesActivity: true` still asks the reader to already know what it
   * means. The sentence has to travel in the payload beside the number it is
   * about, which is the whole content of "make the distinction impossible to
   * miss in the ANSWER".
   */
  note?: string;
}

/**
 * PURE: bucket rows by liveness verdict.
 *
 * Kept separate from the filter because the two call sites learn `sessionState`
 * at different times — leader-brief's rows arrive decorated, while
 * fleet:assignments stamps the verdict only after `decorateMemberVerdicts` runs,
 * which is why {@link withLivenessComposition} exists alongside the resolver
 * argument on {@link selectFleetPopulation}.
 */
export function composeLiveness<T>(
  rows: readonly T[],
  sessionStateOf: SessionStateOf<T>,
): FleetLivenessComposition {
  const byState: Partial<Record<SessionState, number>> = {};
  let unknown = 0;
  for (const row of rows) {
    const state = sessionStateOf(row);
    if (state == null) unknown += 1;
    else byState[state] = (byState[state] ?? 0) + 1;
  }
  const live = byState.live ?? 0;
  const overstatesActivity = rows.length > 0 && live * 2 <= rows.length;
  return {
    byState,
    unknown,
    live,
    liveShare: rows.length > 0 ? live / rows.length : 0,
    overstatesActivity,
    ...(overstatesActivity
      ? {
          note:
            `only ${live} of ${rows.length} are live (sessionState) — this count is a POPULATION ` +
            `size, not an activity measure. Parked/ended sessions are indistinguishable from ` +
            `working ones in a total, so do not read it as load or as concurrent work.`,
        }
      : {}),
  };
}

/**
 * What a response counted, stated beside the count itself.
 *
 * The counting half lives in `population-census.ts`, which every filtered read
 * can reach; this is the fleet flavour of it. Extending
 * {@link MeasuredPopulationCensus} rather than re-declaring the fields is what
 * keeps the two from drifting into separate vocabularies for one concept — and
 * it records, in the type, the guarantee this call site has and a SQL-backed
 * read does not: the denominator came from the same array as the rows, so it is
 * always `candidatesStatus: 'measured'` and never a floor.
 */
export interface FleetPopulationCensus extends MeasuredPopulationCensus {
  /**
   * What the counted rows ARE, by liveness verdict. Present whenever the caller
   * could resolve `sessionState`; absent means nobody asked, NOT that every row
   * is live — a distinction `renderPopulationCensus` states out loud rather than
   * letting the omission read as a clean bill of health.
   */
  liveness?: FleetLivenessComposition;
  /**
   * Rows actually PRESENT in the payload, when a later byte/row budget dropped
   * some of what `counted` counts. Omitted when the payload carries them all.
   * This is a SECOND, independent way a list stops matching its own summary —
   * `counted` describes the filter's verdict, `shown` describes what survived
   * transport — and conflating them is the same defect one level down.
   */
  shown?: number;
  /** Why `shown` < `counted`; present only alongside `shown`. */
  shownReason?: string;
}

/**
 * Descriptive metadata about a fleet population. One definition, shared with
 * every other filtered read — an alias rather than a copy, so a field added to
 * the contract cannot reach only half of its callers.
 */
export type FleetPopulationMeta = PopulationMeta;

/**
 * Shared population/lifecycle contract used by fleet:status, fleet:leader-brief,
 * and the fleet metric scope resolver (fleet-spec-scoped-metrics P-004).
 *
 * The three readers used to expose the same concepts under different names and
 * predicates: status counted a live roster, leader-brief counted a stale-filtered
 * roster, and metrics returned independent current/ever-member arrays.  This
 * contract keeps the population basis beside every identity/count and makes an
 * unavailable claim-flow read explicit rather than manufacturing zeroes.
 */
export const FLEET_POPULATION_LIFECYCLE_SCHEMA_VERSION = 'fleet-population-lifecycle-v1' as const;

export interface FleetPopulationLifecycleRoster {
  census: FleetPopulationCensus;
  /** Identities in the exact population represented by `census.counted`. */
  ownerIds: string[];
}

export interface FleetPopulationLifecycleEverMembers {
  population: 'ever-members';
  basis: 'append-only fleet membership events';
  writer: 'harness_shared.fleet_membership_events';
  available: boolean;
  counted: number | null;
  ownerIds: string[];
  reason?: string;
}

/**
 * P-019 (`silent-wrong-answers-2026-08-01`) — the roster read that can report LOSS.
 *
 * Every other population in this snapshot is a PRESENT-STATE read, so a member that
 * dropped off the roster entirely is not counted as anything: it is simply absent, and
 * a fleet that lost ten members renders as a healthy small fleet. `liveness.dead` does
 * not close the gap — that counts rows still ON the roster carrying an ended verdict,
 * which is the visible case. The invisible one has no row at all.
 *
 * This does not merely hide loss, it FABRICATES a phantom event: because absence is
 * discovered late and all at once, batched DISCOVERY is indistinguishable from a
 * batched EVENT. That is what put "mass death" in a leader's head before a single
 * timestamp was read (D-003), and aimed two successive hypotheses at a simultaneous
 * killer that never existed.
 *
 * Two properties are deliberate, and both are the bug class this plan exists to close:
 *
 * 1. `count` is null — never 0 — when ever-members could not be read. The subtraction
 *    has no minuend, so the honest answer is UNKNOWN. Rendering it as 0 would state
 *    "you have lost nobody" on the strength of a failed read (this plan's P-014).
 * 2. Departure TIMING is not derived here at all. The available signal,
 *    `adv_sessions.ended_at`, is written by the idle-session-reaper when it NOTICES a
 *    dead row — 9 rows stamped inside 13ms, one dead since 20 July — so it clusters by
 *    construction and dates the sweep, not the loss (D-003, and the caveat P-015
 *    shipped for exactly this column). A `since` sourced from it would be precisely the
 *    silent wrong answer this item was filed to remove, so `timing` names what is
 *    unmeasured and points at the column that can answer it.
 */
export interface FleetPopulationLifecycleMembersLost {
  population: 'ever-members-absent-from-roster';
  basis: 'ever-members minus every identity still present on the fleet roster in ANY lifecycle state; a member still on the roster as ended is visible and is NOT counted here';
  writer: 'harness_shared.fleet_membership_events';
  /** False when ever-members could not be read; `count` is then null, never 0. */
  available: boolean;
  count: number | null;
  ownerIds: string[];
  timing: {
    status: 'not-measured';
    reason: string;
    insteadRead: string;
  };
  reason?: string;
}

export interface FleetPopulationLifecycleTarget {
  enabled: boolean | null;
  target: number | null;
  current: number | null;
  shortfall: number | null;
  underStrength: boolean | null;
  verdict: string;
  /** The same productive-population basis as the source headcount projection. */
  basis?: unknown;
}

export type FleetPopulationLifecycleFlow =
  | {
      status: 'measured';
      population: 'current-runnable-roster';
      basis: string;
      claimable: number;
      inFlight: number;
      orphaned: number;
      stalled: number;
      idle: number;
      criticalContext: number;
    }
  | {
      status: 'unknown';
      population: 'current-runnable-roster';
      basis: string;
      values: null;
      reason: string;
    };

export interface FleetPopulationLifecycleLiveness {
  /** Counts are over the canonical fleet roster candidates, not a filtered display list. */
  byState: Partial<Record<SessionState, number>>;
  live: number;
  parked: number;
  suspect: number;
  dead: number;
  draining: number;
  recorded: number;
  unknown: number;
}

export interface FleetPopulationLifecycleSnapshot {
  schemaVersion: typeof FLEET_POPULATION_LIFECYCLE_SCHEMA_VERSION;
  fleet: string;
  /** Every population in this object shares this observation boundary. */
  window: {
    startAt: string | null;
    endAt: string | null;
    startSource: 'fleet-created-at';
    endSource: 'snapshot-generated-at' | 'unavailable';
  };
  populationBasis: {
    writer: 'fleet-roster';
    comparisonRule: 'compare only identical population, window, and unit';
  };
  currentRunnableRoster: FleetPopulationLifecycleRoster;
  relevantRoster: FleetPopulationLifecycleRoster;
  everMembers: FleetPopulationLifecycleEverMembers;
  membersLost: FleetPopulationLifecycleMembersLost;
  target: FleetPopulationLifecycleTarget | null;
  liveness: FleetPopulationLifecycleLiveness;
  claimFlow: FleetPopulationLifecycleFlow;
}

export interface FleetPopulationLifecycleInput<T extends {
  agentId: string;
  alive?: boolean | null;
  sessionState?: SessionState | null;
  claims?: readonly unknown[];
}> {
  fleet: string;
  candidates: readonly T[];
  everMemberIds: readonly string[];
  everMembersAvailable?: boolean;
  everMembersReason?: string;
  fleetStartedAtMs?: number | null;
  observedAtMs?: number | null;
  includeStale?: boolean;
  target?: Partial<FleetPopulationLifecycleTarget> | null;
  claimFlow?: FleetPopulationLifecycleFlow | null;
}

function lifecycleIso(value: number | null | undefined): string | null {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : null;
}

function lifecycleRosterCensus<T extends { sessionState?: SessionState | null }>(
  candidates: readonly T[],
  rows: readonly T[],
  population: string,
  basis: string,
  withheldReason: string,
  reveal: string,
): FleetPopulationCensus {
  return {
    ...measuredCensus(rows.length, candidates.length, {
      population,
      basis,
      withheldReason,
      reveal,
    }),
    liveness: composeLiveness(rows, (row) => row.sessionState ?? null),
  };
}

function lifecycleLiveness(rows: readonly { sessionState?: SessionState | null }[]): FleetPopulationLifecycleLiveness {
  const composition = composeLiveness(rows, (row) => row.sessionState ?? null);
  const count = (state: SessionState) => composition.byState[state] ?? 0;
  return {
    byState: composition.byState,
    live: count('live'),
    parked: count('parked'),
    suspect: count('suspect'),
    dead: count('ended'),
    draining: count('draining'),
    recorded: count('recorded'),
    unknown: composition.unknown,
  };
}

/** Build the one canonical fleet population/lifecycle snapshot. */
export function buildFleetPopulationLifecycle<T extends {
  agentId: string;
  alive?: boolean | null;
  sessionState?: SessionState | null;
  claims?: readonly unknown[];
}>(input: FleetPopulationLifecycleInput<T>): {
  currentRunnableRows: T[];
  relevantRows: T[];
  snapshot: FleetPopulationLifecycleSnapshot;
} {
  const currentRunnableRows = input.candidates.filter((row) => {
    const state = row.sessionState;
    return !['ended', 'suspect', 'draining', 'recorded'].includes(state ?? '') && row.alive !== false;
  });
  const relevantRows = input.candidates.filter(
    (row) => input.includeStale === true || (row.claims?.length ?? 0) > 0 || row.alive !== false,
  );
  const currentOwnerIds = currentRunnableRows.map((row) => row.agentId);
  const relevantOwnerIds = relevantRows.map((row) => row.agentId);
  const everOwnerIds = [...new Set(input.everMemberIds.filter((id) => typeof id === 'string' && id.length > 0))].sort();
  // P-019: subtract against EVERY candidate the roster still carries, in any lifecycle
  // state — not the runnable/relevant filters. A member visible as `ended` is already
  // reportable through `liveness.dead`; the loss this field exists to surface is the
  // identity with no roster row at all, which no present-state read can return.
  const everMembersReadable = input.everMembersAvailable ?? true;
  const rosterOwnerIds = new Set(input.candidates.map((row) => row.agentId));
  const lostOwnerIds = everMembersReadable ? everOwnerIds.filter((id) => !rosterOwnerIds.has(id)) : [];
  const target = input.target
    ? {
        enabled: input.target.enabled ?? null,
        target: input.target.target ?? null,
        current: input.target.current ?? null,
        shortfall: input.target.shortfall ?? null,
        underStrength: input.target.underStrength ?? null,
        verdict: input.target.verdict ?? 'unknown',
        ...(input.target.basis !== undefined ? { basis: input.target.basis } : {}),
      }
    : null;
  const claimFlow: FleetPopulationLifecycleFlow = input.claimFlow ?? {
    status: 'unknown',
    population: 'current-runnable-roster',
    basis: 'claim-flow diagnostics were not read by this surface',
    values: null,
    reason: 'claim-flow-unread',
  };
  const startAt = lifecycleIso(input.fleetStartedAtMs);
  const endAt = lifecycleIso(input.observedAtMs);
  return {
    currentRunnableRows,
    relevantRows,
    snapshot: {
      schemaVersion: FLEET_POPULATION_LIFECYCLE_SCHEMA_VERSION,
      fleet: input.fleet,
      window: {
        startAt,
        endAt,
        startSource: 'fleet-created-at',
        endSource: endAt ? 'snapshot-generated-at' : 'unavailable',
      },
      populationBasis: {
        writer: 'fleet-roster',
        comparisonRule: 'compare only identical population, window, and unit',
      },
      currentRunnableRoster: {
        census: lifecycleRosterCensus(
          input.candidates,
          currentRunnableRows,
          'current-runnable-roster',
          'fleet-roster rows that are not ended, suspect, draining, or recorded and retain a runnable heartbeat',
          'non-runnable lifecycle verdict',
          'fleet:status { fleet } (full roster)',
        ),
        ownerIds: currentOwnerIds,
      },
      relevantRoster: {
        census: lifecycleRosterCensus(
          input.candidates,
          relevantRows,
          'relevant-roster',
          'fleet-roster rows with a claim or heartbeat freshness; includeStale reveals the complete roster',
          'idle AND not heartbeat-fresh (stale-idle)',
          'fleet:status { fleet } (full roster)',
        ),
        ownerIds: relevantOwnerIds,
      },
      everMembers: {
        population: 'ever-members',
        basis: 'append-only fleet membership events',
        writer: 'harness_shared.fleet_membership_events',
        available: everMembersReadable,
        counted: everMembersReadable ? everOwnerIds.length : null,
        ownerIds: everMembersReadable ? everOwnerIds : [],
        ...(everMembersReadable || !input.everMembersReason ? {} : { reason: input.everMembersReason }),
      },
      membersLost: {
        population: 'ever-members-absent-from-roster',
        basis:
          'ever-members minus every identity still present on the fleet roster in ANY lifecycle state; a member still on the roster as ended is visible and is NOT counted here',
        writer: 'harness_shared.fleet_membership_events',
        available: everMembersReadable,
        // null, never 0: with ever-members unreadable the subtraction has no minuend,
        // and "0 lost" would assert a fleet is whole on the strength of a failed read.
        count: everMembersReadable ? lostOwnerIds.length : null,
        ownerIds: lostOwnerIds,
        timing: {
          status: 'not-measured',
          reason:
            'departure time is not derivable here: adv_sessions.ended_at is stamped by the idle-session-reaper when it NOTICES a dead row, so it clusters by construction and dates the sweep rather than the loss (plan silent-wrong-answers-2026-08-01 D-003, P-015)',
          insteadRead:
            'coord_presence.last_active_at per member in membersLost.ownerIds — true last activity; adv_sessions.ended_by names which process wrote the end',
        },
        ...(everMembersReadable || !input.everMembersReason ? {} : { reason: input.everMembersReason }),
      },
      target,
      liveness: lifecycleLiveness(input.candidates),
      claimFlow,
    },
  };
}

/**
 * Filter a candidate roster AND describe what the filter did, in one pass.
 *
 * Both halves come from the same `candidates` array and the same `keep`
 * predicate, so a census can never describe a different selection than the rows
 * returned with it. `withheldReason` is dropped to null when nothing was actually
 * withheld — a reason attached to zero rows reads as an admission that something
 * is hidden, and would train readers to discount the field when it matters.
 */
export function selectFleetPopulation<T>(
  candidates: readonly T[],
  keep: (row: T) => boolean,
  meta: FleetPopulationMeta,
  sessionStateOf?: SessionStateOf<T>,
): { rows: T[]; census: FleetPopulationCensus } {
  // The one-pass guarantee is `selectPopulation`'s, not a second copy of it here:
  // rows and denominator come from the same array and the same predicate.
  const { rows, census } = selectPopulation(candidates, keep, meta);
  return {
    rows,
    census: {
      ...census,
      ...(sessionStateOf ? { liveness: composeLiveness(rows, sessionStateOf) } : {}),
    },
  };
}

/**
 * Attach the liveness composition to a census whose rows only learned their
 * verdict later.
 *
 * Mirrors {@link withShownCount}: returns a NEW census and leaves the original a
 * faithful record of the filter's verdict. `rows` must be the rows the census
 * counted — passing a different array is the drift this module exists to
 * prevent, so callers apply it to the same array they are about to publish.
 */
export function withLivenessComposition<T>(
  census: FleetPopulationCensus,
  rows: readonly T[],
  sessionStateOf: SessionStateOf<T>,
): FleetPopulationCensus {
  return { ...census, liveness: composeLiveness(rows, sessionStateOf) };
}

/**
 * Record that a later budget trimmed the rows actually shipped below `counted`.
 *
 * Returns a NEW census — the original stays a faithful record of the filter's
 * verdict. A `shown` equal to (or above) `counted` is a no-op rather than an
 * error: transport dropping nothing is the normal case, and a census that
 * announced a truncation of zero rows would be noise.
 */
export function withShownCount(
  census: FleetPopulationCensus,
  shown: number,
  shownReason: string,
): FleetPopulationCensus {
  return withShownCountCensus(census, shown, shownReason);
}

/**
 * Render the liveness split as the clause a reader would otherwise supply from
 * assumption.
 *
 * The `overstatesActivity` caveat is spelled out rather than left to the
 * numbers because the failure this guards against is not arithmetic — the agent
 * who reported "415 members saturating the proxy" could see 415 and would have
 * seen `4 live, 411 parked` too. What was missing was the sentence saying the
 * count does not measure activity.
 */
function renderLiveness(counted: number, liveness: FleetLivenessComposition): string {
  const split = [
    ...Object.entries(liveness.byState).map(([state, n]) => `${n} ${state}`),
    ...(liveness.unknown > 0 ? [`${liveness.unknown} unknown`] : []),
  ];
  const head = `of the ${counted} counted: ${split.join(', ')}`;
  if (!liveness.overstatesActivity) return head;
  const pct = Math.round(liveness.liveShare * 100);
  return (
    `${head} — only ${liveness.live} of ${counted} (${pct}%) are live, so this count does ` +
    `NOT measure activity; parked sessions are indistinguishable from working ones in a total`
  );
}

/**
 * One line for a human/agent reading the response — the reconciliation sentence
 * a leader otherwise has to assemble from two tool calls.
 */
export function renderPopulationCensus(census: FleetPopulationCensus): string {
  const parts = [`${census.counted} ${census.population} (of ${census.candidates} on the roster)`];
  if (census.withheld > 0) {
    parts.push(
      `${census.withheld} withheld: ${census.withheldReason}` +
        (census.reveal ? ` — reveal with ${census.reveal}` : ''),
    );
  }
  if (census.shown != null) {
    parts.push(`only ${census.shown} shown in this payload: ${census.shownReason}`);
  }
  if (census.liveness && census.counted > 0) {
    parts.push(renderLiveness(census.counted, census.liveness));
  } else if (census.counted > 0) {
    // Silence here would read as "all live". Say which question went unasked.
    parts.push('liveness composition not resolved for this read — the count is not an activity measure');
  }
  parts.push(census.basis);
  return parts.join('. ') + '.';
}
