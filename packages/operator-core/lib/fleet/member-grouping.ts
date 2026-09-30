/**
 * member-grouping — the per-member projection of the fleet roster
 * (shared-hive-collaboration-2026-06-14 P-010, Brief B10): "what is each member
 * working on". Buckets the fleet:assignments by-agent roster
 * ({@link groupByAgent}) into one group per HIVE MEMBER — a federated
 * participant (a github user on a machine) or the local machine — so a shared
 * hive shows who is collaborating and what each is doing. Pure (no PG, no
 * React) so it unit-tests without either.
 *
 * Member identity is derived from the agent's ownerId, the only member key the
 * `fleet_assignment` view carries: a federated agent rides in over the coord
 * federation as `fed:<userKey>@<host>`; everything else is a local session of
 * THIS machine. (When per-user LOCAL identity federates, extend deriveMember —
 * today local sessions carry no distinct user identity in coord_presence.)
 */

/** The minimal agent shape this projection needs — structurally a WorkingAgent
 *  (apps/operator AdvAgentsPanel) / a stamped {@link AgentAssignment}. */
export interface RosterAgent {
  agentId: string;
  label: string | null;
  name: string | null;
  alive: boolean;
  heartbeatAt: string | null;
  /** Work-item load (count of held work-items). */
  load: number;
  /** The colony-tab kind glyph key (queen/bee/sentinel/planner/su). */
  agentPaneKind: string;
}

export interface MemberIdentity {
  /** Stable grouping key. */
  key: string;
  /** Human display name ("gh:279242982", "This machine"). */
  displayName: string;
  /** Machine/host when known (federated members); null for the local machine. */
  host: string | null;
  /** 'user' = a federated github participant; 'local' = this machine. */
  kind: 'user' | 'local';
}

export interface MemberGroup<A extends RosterAgent = RosterAgent> extends MemberIdentity {
  agents: A[];
  /** Agents with a fresh heartbeat. */
  liveCount: number;
  /** Σ work-item load across the member's agents. */
  totalLoad: number;
  /** Newest heartbeat across the member's agents (ISO), null if none. */
  lastHeartbeatAt: string | null;
}

const LOCAL: MemberIdentity = {
  key: 'local',
  displayName: 'This machine',
  host: null,
  kind: 'local',
};

/** Pull the "gh:<id>" head off a federated label ("gh:279242982 · host" → "gh:279242982"). */
function labelHead(label: string | null): string | null {
  if (!label) return null;
  const head = label.split('·')[0]?.trim();
  return head && head.length > 0 ? head : null;
}

/**
 * Derive the hive-member identity an agent belongs to. Federated presence rides
 * in as `fed:<userKey>@<host>`; everything else is the local machine.
 */
export function deriveMember(agent: { agentId: string; label: string | null }): MemberIdentity {
  const id = agent.agentId;
  if (id.startsWith('fed:')) {
    const rest = id.slice(4);
    const at = rest.lastIndexOf('@');
    const userKey = at >= 0 ? rest.slice(0, at) : rest;
    const host = at >= 0 ? rest.slice(at + 1) : null;
    return {
      key: `user:${userKey}`,
      // The label is the canonical display ("gh:<id> · <host>"); fall back to the key.
      displayName: labelHead(agent.label) ?? `gh:${userKey}`,
      host,
      kind: 'user',
    };
  }
  return LOCAL;
}

/**
 * Group the by-agent roster into one bucket per hive member. Members with live
 * agents sort first (more-live first), then busier (total load), then by name;
 * within a member, live agents lead, higher load first (mirrors AdvAgentsPanel).
 */
export function groupByMember<A extends RosterAgent>(agents: A[]): MemberGroup<A>[] {
  const groups = new Map<string, MemberGroup<A>>();
  for (const a of agents) {
    const m = deriveMember(a);
    let g = groups.get(m.key);
    if (!g) {
      g = { ...m, agents: [], liveCount: 0, totalLoad: 0, lastHeartbeatAt: null };
      groups.set(m.key, g);
    }
    g.agents.push(a);
    if (a.alive) g.liveCount += 1;
    g.totalLoad += a.load;
    if (a.heartbeatAt && (g.lastHeartbeatAt == null || a.heartbeatAt > g.lastHeartbeatAt)) {
      g.lastHeartbeatAt = a.heartbeatAt;
    }
  }
  for (const g of groups.values()) {
    g.agents.sort((a, b) => Number(b.alive) - Number(a.alive) || b.load - a.load);
  }
  return [...groups.values()].sort(
    (a, b) =>
      Number(b.liveCount > 0) - Number(a.liveCount > 0) ||
      b.liveCount - a.liveCount ||
      b.totalLoad - a.totalLoad ||
      a.displayName.localeCompare(b.displayName),
  );
}
