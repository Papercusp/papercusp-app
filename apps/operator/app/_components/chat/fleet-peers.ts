/**
 * fleet-peers — the conversation popup's FLEET rail derivation
 * (chat-popup-fleet-peers-rail-2026-08-09 P-001).
 *
 * [owner 2026-08-09] "when an agent is a member or leader of a fleet, can an
 * additional panel to the right of the activity panel show up showing all their
 * peers (leader & members)... Clicking on a peer should update the conversation
 * popup to display that peer."
 *
 * PURE: no React, no fetch, no clock read. `nowMs` is injected exactly as
 * hud-board-model requires, so the whole thing is testable against fixtures.
 *
 * ── Where the data comes from, and why there is no new query ────────────────
 * The caller hands us the `advRoster.list` payload SessionChatModal ALREADY
 * subscribes to — three times over, sharing one `useSyncQuery` cache entry
 * (identity chip P-012, action context P-006, dossier entry P-003). The peers
 * list is a filter over that same payload, so the rail costs zero additional
 * requests and, more importantly, cannot disagree with the status band and the
 * Activity rail beside it.
 *
 * That is also what makes it PUSH-based with nothing new wired:
 * `table-to-query-names.ts` already bridges `harness_shared.coord_presence ->
 * advRoster.list`, and fleet membership IS a coord_presence column
 * (`fleet_slug` / `fleet_role`, folded in by adv-roster's
 * `resolveFleetInfoByOwner`). A member joining, leaving, going stale or being
 * promoted moves that row, which SSE-invalidates the query the popup holds, and
 * this function re-derives. No poll, no interval, no second data path.
 *
 * ── Classification is BORROWED from the board, never re-invented ────────────
 * Each peer's state word comes from `toHudSession` -> `deriveColumn`, the same
 * verdict the HUD board renders, and the fleet's one-line health note comes from
 * `deriveFleetRollups` — the same sentence shape ("2 stalled, 1 needs you", "no
 * leader") the board's fleet chips already produce. A peer therefore reads
 * identically in the rail and on the board behind it. Writing a private
 * live/idle/busy vocabulary here would have been the easy version and would
 * have guaranteed the two surfaces eventually disagreed about one agent.
 */
import {
  deriveFleetRollups,
  toHudSession,
  HUD_DEFAULT_THRESHOLDS,
  type HudColumnId,
  type HudRosterEntry,
  type HudSession,
  type HudThresholds,
} from '../../adv/hud/hud-board-model';

export interface FleetPeer {
  ownerId: string;
  /** Short display handle, e.g. `su-e8a25` — hud-board-model's own shortener. */
  handle: string;
  label: string;
  intent: string | null;
  /** The board's verdict, not a private vocabulary. */
  column: HudColumnId;
  /** Why it landed there, in words a human can act on. */
  reason: string;
  sinceSec: number | null;
  isLeader: boolean;
  /** 0–100, or null when never sampled. Null is NOT 0 — an unmeasured context
   *  rendered as 0% reads as "plenty of room left". */
  contextPct: number | null;
  /** The agent kind (`claude`, `codex`, `cup`, …) for the row's mark. */
  agent: string | null;
  agentPaneKind: string;
  /** True for the agent the popup is currently showing. That row is marked and
   *  inert — clicking it would re-open the reader onto themselves. */
  isCurrent: boolean;
}

export interface FleetPeersModel {
  fleetSlug: string;
  fleetColor: string | null;
  /** null when the fleet has no leader — a real and BAD state (nobody reclaims a
   *  dead member's claim or opens the gates members are parked on), which is why
   *  `warning` calls it out rather than the rail quietly omitting a section. */
  leader: FleetPeer | null;
  members: FleetPeer[];
  /** leader + members. */
  total: number;
  /** The one-line health note, or null when nothing needs a human. Its ABSENCE
   *  is meaningful — the rail shows no bar at all for an all-clear fleet. */
  warning: string | null;
}

/**
 * Attention first, matching every other papercusp surface (the board's own
 * fleet ordering sorts by need too). A peer list is read to find the one that
 * needs you, not alphabetically.
 */
const COLUMN_RANK: Record<HudColumnId, number> = {
  'needs-you': 0,
  blocked: 1,
  stalled: 2,
  working: 3,
  parked: 4,
};

function toPeer(s: HudSession, currentOwnerId: string | null, e: HudRosterEntry): FleetPeer {
  return {
    ownerId: s.ownerId,
    handle: s.handle,
    label: s.label,
    intent: s.intent,
    column: s.column,
    reason: s.reason,
    sinceSec: s.sinceSec,
    isLeader: s.isLeader,
    contextPct: s.contextPct,
    agent: e.agent,
    agentPaneKind: e.agentPaneKind,
    isCurrent: s.ownerId === currentOwnerId,
  };
}

/**
 * The fleet the given agent belongs to, and everyone in it.
 *
 * Returns `null` — meaning "render no rail at all, and no toggle" — when the
 * agent is SOLO (`fleetSlug == null`), unknown to the roster, or when no agent
 * is open. A solo agent is not a fleet of one, and an empty rail with an "in no
 * fleet" placeholder would be a column of chrome saying nothing.
 *
 * ⚠ It DOES return a model for a fleet whose other members have all gone: that
 * is a genuinely different situation from being solo (your peers died; the
 * warning will say `no leader` if the leader was among them), and the reader
 * needs to see it rather than have the rail vanish.
 *
 * ⚠ ENDED peers cannot appear here, by construction — and this is a property of
 * the substrate, not an omission to fix later. `coord_presence` is TTL-reaped
 * and an ended agent loses its `fleet_slug`; the roster payload's `ended`,
 * `pending` and `starting` tiers all hardcode `fleetSlug: null`
 * (adv-roster.ts's `pendingLaunchesToRosterEntries` /
 * `startingLaunchesToRosterEntries`, and `mapAdvSessionRow` carries no fleet
 * columns at all). So "who is in this fleet" is inherently a LIVE question. A
 * dying peer still shows — its presence row survives until reaped, classified
 * `stalled`/`parked` by the board's own verdict — but a reaped one is gone.
 * Historical membership ("who was EVER in this fleet") is a different mechanism
 * entirely: the append-only coord stream, via `coord:catch-up { audience:
 * '@fleet:<slug>' }`. Do not try to answer it from this payload.
 */
/**
 * EI-19968489971947616: distinguishes deriveFleetPeers' two `null`-returning
 * cases so a caller can render an explicit "this session isn't in the
 * roster" placeholder instead of silently showing no rail at all (which reads
 * identically to "you are a solo agent, there is nothing to show").
 *
 * True only when `ownerId` is non-null AND does not appear in `entries` at
 * all — e.g. a `hudsession=` query param carrying a truncated/stale id.
 * False for the genuinely-uninteresting cases: no agent open, or the agent IS
 * in the roster but has no `fleetSlug` (a real solo agent — correct to render
 * nothing).
 */
export function isUnknownSession(entries: HudRosterEntry[], ownerId: string | null): boolean {
  if (!ownerId) return false;
  return !entries.some((e) => e.ownerId === ownerId);
}

export function deriveFleetPeers(
  entries: HudRosterEntry[],
  currentOwnerId: string | null,
  opts: { nowMs: number; thresholds?: HudThresholds },
): FleetPeersModel | null {
  if (!currentOwnerId) return null;

  const self = entries.find((e) => e.ownerId === currentOwnerId);
  const fleetSlug = self?.fleetSlug;
  if (!fleetSlug) return null;

  const thresholds = opts.thresholds ?? HUD_DEFAULT_THRESHOLDS;
  const inFleet = entries.filter((e) => e.fleetSlug === fleetSlug);

  // Deliberately pass `undefined` asks: the rail is a NAVIGATION list, and the
  // needs-you column here means "this peer's own state needs a human", not "an
  // unanswered ask is attributed to it" — the popup's own escalation cards
  // already surface asks for the agent in view.
  const sessions = inFleet.map((e) => toHudSession(e, undefined, { nowMs: opts.nowMs, thresholds }));
  const byOwner = new Map(inFleet.map((e) => [e.ownerId, e] as const));

  const peers = sessions.map((s) => toPeer(s, currentOwnerId, byOwner.get(s.ownerId)!));

  // First leader wins, matching deriveFleetRollups' own `if (s.isLeader &&
  // !g.leaderOwnerId)` rule — two agents claiming leadership is a coordination
  // fault, and the two surfaces must at least name the SAME one of them.
  const leader = peers.find((p) => p.isLeader) ?? null;
  const members = peers
    .filter((p) => p !== leader)
    .sort((a, b) => {
      const r = COLUMN_RANK[a.column] - COLUMN_RANK[b.column];
      if (r !== 0) return r;
      // Within a state, longest-suffering first — the same rule the board's
      // columns use. Unknown ages sort last: they carry no urgency signal, so
      // they must never outrank a measured one.
      const as = a.sinceSec ?? -1;
      const bs = b.sinceSec ?? -1;
      if (as !== bs) return bs - as;
      return a.handle.localeCompare(b.handle);
    });

  // The health note, from the board's own rollup so the wording cannot drift.
  // Scoped to this fleet's sessions, so the returned array has exactly one row.
  const rollup = deriveFleetRollups(sessions)[0] ?? null;

  return {
    fleetSlug,
    fleetColor: self.fleetColor ?? rollup?.fleetColor ?? null,
    leader,
    members,
    total: peers.length,
    warning: rollup?.warning ?? null,
  };
}
