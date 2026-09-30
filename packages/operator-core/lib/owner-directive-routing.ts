/**
 * owner-directive-routing — P-008 of plan `owner-directive-delivery-redesign-2026-09-22`
 * (R-7: an ended session does not strand its directives).
 *
 * An open directive belongs to its ADDRESSEE — the session the owner typed it
 * into (`recordedBy`) — or to a live session holding a non-terminal work-item
 * that carries it. When the addressee has ended and no live holder exists:
 *
 *   - it routes to the addressee's FLEET LEADER, when the addressee was in a
 *     fleet whose leader is alive — the leader receives it as its own
 *     obligation and may disposition it;
 *   - otherwise it is UNHANDLED — it lands on the owner's "nobody is handling
 *     these" list (the `unhandled-directive` inbox attention kind).
 *
 * Membership is read from the append-only `fleet_membership_events` ledger,
 * never from presence: an ended session's presence row is reaped within hours,
 * and session end does not append a `leave`, so the newest join/lead event is
 * the fleet the session was in when it ended.
 *
 * Liveness comes from THE shared oracle (`resolveSessionStates`). An UNKNOWN
 * verdict (null) never reroutes: moving a directive away from a session that
 * may be alive is worse than leaving it on an ended one for one more read.
 */
import type { Sql } from 'postgres';
import type { SessionState } from './agent-tools/coordination/presence-wakeability';

export type DirectiveRoute =
  | { kind: 'addressee' }
  | { kind: 'holder'; holders: string[] }
  | { kind: 'fleet-leader'; fleetSlug: string; leaderOwnerId: string }
  | { kind: 'unhandled'; why: 'no-fleet' | 'no-leader' | 'leader-ended'; fleetSlug: string | null };

/** The states in which a session has no process left to act on a directive. */
const GONE: ReadonlySet<SessionState> = new Set<SessionState>(['ended', 'recorded']);

export function isSessionGone(state: SessionState | null | undefined): boolean {
  return state != null && GONE.has(state);
}

export interface DirectiveRoutingFacts {
  /** Session state per owner id (addressees, holders, leaders); null = unknown. */
  states: ReadonlyMap<string, SessionState | null>;
  /** Addressee → the fleet it was last in. Absent = never in a fleet, or left. */
  fleets: ReadonlyMap<string, string>;
  /** Fleet slug → its current leader (null = leaderless). */
  leaders: ReadonlyMap<string, string | null>;
  /** Directive id → sessions holding a non-terminal work-item that carries it. */
  holders: ReadonlyMap<number, readonly string[]>;
}

/** PURE: where one open directive goes, given the facts. */
export function routeDirective(row: { id: number; recordedBy: string }, facts: DirectiveRoutingFacts): DirectiveRoute {
  if (!isSessionGone(facts.states.get(row.recordedBy))) return { kind: 'addressee' };
  const liveHolders = (facts.holders.get(row.id) ?? []).filter((h) => !isSessionGone(facts.states.get(h)));
  if (liveHolders.length > 0) return { kind: 'holder', holders: liveHolders };
  const fleetSlug = facts.fleets.get(row.recordedBy) ?? null;
  if (!fleetSlug) return { kind: 'unhandled', why: 'no-fleet', fleetSlug: null };
  const leader = facts.leaders.get(fleetSlug) ?? null;
  if (!leader || leader === row.recordedBy) return { kind: 'unhandled', why: 'no-leader', fleetSlug };
  if (isSessionGone(facts.states.get(leader))) return { kind: 'unhandled', why: 'leader-ended', fleetSlug };
  return { kind: 'fleet-leader', fleetSlug, leaderOwnerId: leader };
}

export interface DirectiveRoutingDeps {
  sessionStates(ownerIds: readonly string[]): Promise<Map<string, SessionState | null>>;
  lastFleets(workspaceId: string, ownerIds: readonly string[]): Promise<Map<string, string>>;
  fleetLeaders(workspaceId: string, fleetSlugs: readonly string[]): Promise<Map<string, string | null>>;
  directiveHolders(workspaceId: string, directiveIds: readonly number[]): Promise<Map<number, string[]>>;
  /** Fleets this session leads — the cheap pre-filter for {@link directivesInheritedBy}. */
  fleetsLedBy(workspaceId: string, ownerId: string): Promise<string[]>;
}

/**
 * `sqlOverride`: a caller that already holds a client (a transaction, a test
 * database) passes it, so every read here lands on the SAME database as the
 * caller's own. Liveness is the exception — it always comes from the oracle.
 */
export function defaultDirectiveRoutingDeps(sqlOverride?: Sql): DirectiveRoutingDeps {
  const sql = async () => sqlOverride ?? (await import('@papercusp/db-org')).getOrgPg().sql;
  return {
    async sessionStates(ownerIds) {
      const out = new Map<string, SessionState | null>();
      if (ownerIds.length === 0) return out;
      const { resolveSessionStates } = await import('./agent-tools/coordination/liveness-oracle');
      const verdicts = await resolveSessionStates(
        ownerIds.map((ownerId) => ({ ownerId })),
        { hydratePerId: true, psuHostPositiveAuthority: true },
      );
      for (const id of ownerIds) out.set(id, verdicts.get(id)?.sessionState ?? null);
      return out;
    },
    async lastFleets(workspaceId, ownerIds) {
      const out = new Map<string, string>();
      if (ownerIds.length === 0) return out;
      const s = await sql();
      const rows = await s<Array<{ owner_id: string; fleet_slug: string | null; event: string }>>`
        SELECT DISTINCT ON (owner_id) owner_id, fleet_slug, event
          FROM harness_shared.fleet_membership_events
         WHERE workspace_id = ${workspaceId} AND owner_id = ANY(${ownerIds as string[]})
         ORDER BY owner_id, at DESC, id DESC`;
      for (const r of rows) if (r.fleet_slug && r.event !== 'leave') out.set(r.owner_id, r.fleet_slug);
      return out;
    },
    async fleetLeaders(workspaceId, fleetSlugs) {
      const out = new Map<string, string | null>();
      if (fleetSlugs.length === 0) return out;
      const s = await sql();
      const rows = await s<Array<{ fleet_slug: string; leader_owner_id: string | null }>>`
        SELECT fleet_slug, leader_owner_id FROM harness_shared.agent_fleets
         WHERE workspace_id = ${workspaceId} AND fleet_slug = ANY(${fleetSlugs as string[]})`;
      for (const r of rows) out.set(r.fleet_slug, r.leader_owner_id);
      return out;
    },
    async directiveHolders(workspaceId, directiveIds) {
      const out = new Map<number, string[]>();
      if (directiveIds.length === 0) return out;
      const [s, { TERMINAL_WORK_ITEM_STATES }] = await Promise.all([sql(), import('./work-items')]);
      // `taken_by` is the unified table's claim column; there is no `assignee`.
      const rows = await s<Array<{ directive_ref: number; taken_by: string }>>`
        SELECT directive_ref, taken_by FROM harness_shared.work_items
         WHERE workspace_id = ${workspaceId}
           AND directive_ref = ANY(${directiveIds as number[]})
           AND NOT (status = ANY(${TERMINAL_WORK_ITEM_STATES as string[]}::text[]))
           AND taken_by IS NOT NULL`;
      for (const r of rows) out.set(Number(r.directive_ref), [...(out.get(Number(r.directive_ref)) ?? []), r.taken_by]);
      return out;
    },
    async fleetsLedBy(workspaceId, ownerId) {
      const s = await sql();
      const rows = await s<Array<{ fleet_slug: string }>>`
        SELECT fleet_slug FROM harness_shared.agent_fleets
         WHERE workspace_id = ${workspaceId} AND leader_owner_id = ${ownerId}`;
      return rows.map((r) => r.fleet_slug);
    },
  };
}

/** Gather the facts for a set of open directives and route each one. */
export async function routeOpenDirectives(
  workspaceId: string,
  rows: ReadonlyArray<{ id: number; recordedBy: string }>,
  deps: DirectiveRoutingDeps = defaultDirectiveRoutingDeps(),
): Promise<Map<number, DirectiveRoute>> {
  const out = new Map<number, DirectiveRoute>();
  const addressees = [...new Set(rows.map((r) => r.recordedBy))];
  const states = await deps.sessionStates(addressees);
  const gone = rows.filter((r) => isSessionGone(states.get(r.recordedBy)));
  for (const r of rows) out.set(r.id, { kind: 'addressee' });
  if (gone.length === 0) return out;

  const goneAddressees = [...new Set(gone.map((r) => r.recordedBy))];
  const [holders, fleets] = await Promise.all([
    deps.directiveHolders(workspaceId, gone.map((r) => r.id)),
    deps.lastFleets(workspaceId, goneAddressees),
  ]);
  const leaders = await deps.fleetLeaders(workspaceId, [...new Set(fleets.values())]);
  const unknown = [
    ...new Set([...[...holders.values()].flat(), ...[...leaders.values()].filter((l): l is string => !!l)]),
  ].filter((id) => !states.has(id));
  const more = await deps.sessionStates(unknown);
  const facts: DirectiveRoutingFacts = { states: new Map([...states, ...more]), fleets, leaders, holders };
  for (const r of gone) out.set(r.id, routeDirective(r, facts));
  return out;
}

/**
 * The open directives this session INHERITS as a fleet leader: addressed to a
 * member of a fleet it leads that has ended, with no live holder. A session
 * that leads no fleet pays one indexed query and nothing else — this runs on
 * the turn-start obligation read.
 */
export async function directivesInheritedBy(
  input: { workspaceId: string; ownerId: string; open: ReadonlyArray<{ id: number; recordedBy: string }> },
  deps: DirectiveRoutingDeps = defaultDirectiveRoutingDeps(),
): Promise<Set<number>> {
  const inherited = new Set<number>();
  const foreign = input.open.filter((r) => r.recordedBy !== input.ownerId);
  if (foreign.length === 0) return inherited;
  const led = new Set(await deps.fleetsLedBy(input.workspaceId, input.ownerId));
  if (led.size === 0) return inherited;
  const fleets = await deps.lastFleets(input.workspaceId, [...new Set(foreign.map((r) => r.recordedBy))]);
  const candidates = foreign.filter((r) => led.has(fleets.get(r.recordedBy) ?? ''));
  if (candidates.length === 0) return inherited;
  const routes = await routeOpenDirectives(input.workspaceId, candidates, deps);
  for (const [id, route] of routes) {
    if (route.kind === 'fleet-leader' && route.leaderOwnerId === input.ownerId) inherited.add(id);
  }
  return inherited;
}
