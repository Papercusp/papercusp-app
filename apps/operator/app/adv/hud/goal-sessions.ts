/**
 * goal-sessions.ts — the pure derivation behind the goal popup's Sessions rail.
 *
 * [owner 2026-08-10] approved the mockup with two changes: seat the pane on the
 * RIGHT, immediately left of the Work rail, and "mimic the design of the fleet
 * leader/fleet member pane in the conversation popup equivalent in the sessions
 * tab" — i.e. FleetPeersRail. This file is the `fleet-peers.ts` of that pairing:
 * every rule about membership, grouping, ordering and classification lives here,
 * unit-tested, and `GoalSessionsRail.tsx` only renders what it returns.
 *
 * ── The question this rail answers ──────────────────────────────────────────
 * The Work rail says WHAT sits under the goal. This says WHO is working on it.
 * They are different questions: a goal can have plenty of work and nobody on it,
 * which is precisely the state worth seeing and the one no other zone reports.
 *
 * ── Why the state words come from `toHudSession`, never from `liveness` ─────
 * Same rule FleetPeersRail holds itself to. WI-6636 measured what happens when a
 * fleet surface trusts `liveness`: it is heartbeat freshness alone, so a PARKED
 * agent — idle between turns, holding its inbox wake — keeps beating and reads
 * 'live' forever; on the default board that mislabelled 110 of 133 cards. Going
 * through the board's own session projection means a row here reads the same as
 * the same agent on the board behind the popup. Never re-derive a private
 * live/idle vocabulary in this file.
 */
import {
  HUD_DEFAULT_THRESHOLDS,
  toHudSession,
  type HudColumnId,
  type HudRosterEntry,
  type HudSession,
  type HudThresholds,
} from './hud-board-model';

/**
 * The five section types, in render order.
 *
 * These ARE the goal's coverage model, which is why the rail renders all five
 * even when empty (see `GoalSessionsSection.emptyLine`): a goal with no drain
 * fleet is a finding, and hiding the section would make "no drain fleet"
 * indistinguishable from "no drain section exists".
 */
export const GOAL_SESSION_SECTIONS = ['plan', 'drain', 'grade', 'testing', 'misc'] as const;
export type GoalSessionSectionId = (typeof GOAL_SESSION_SECTIONS)[number];

const SECTION_CAPTION: Record<GoalSessionSectionId, string> = {
  plan: 'Plan',
  drain: 'Drain',
  grade: 'Grade',
  testing: 'Testing',
  misc: 'Misc',
};

/** One line of prose per empty section. Deliberately says what is ABSENT rather
 *  than "none" — the reader is being told a coverage gap, not a count. */
const SECTION_EMPTY: Record<GoalSessionSectionId, string> = {
  plan: 'No plan fleet on this goal yet.',
  drain: 'No drain fleet yet.',
  grade: 'Nothing grading this goal yet.',
  testing: 'No test agent yet.',
  misc: 'No other sessions.',
};

export interface GoalSessionRow {
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
  /** Leads its fleet, or is a solo session standing in as its own lead. */
  isLead: boolean;
  /** 0–100, or null when never sampled. Null is NOT 0 — an unmeasured context
   *  rendered as 0% reads as "plenty of room left". */
  contextPct: number | null;
  agent: string | null;
  agentPaneKind: string;
  fleetSlug: string | null;
  /** True once this session has stopped for good. Kept and greyed rather than
   *  dropped — see `deriveGoalSessions`'s note on terminal sessions. */
  ended: boolean;
}

/** A lead and the fleet under it. Members NEST rather than getting their own
 *  heading: the lead is the addressable thing, and a flat list loses which
 *  member belongs to which fleet the moment a goal runs two plan fleets. */
export interface GoalSessionGroup {
  lead: GoalSessionRow;
  members: GoalSessionRow[];
}

export interface GoalSessionsSection {
  id: GoalSessionSectionId;
  caption: string;
  groups: GoalSessionGroup[];
  /** Every session in the section, leads + members. */
  count: number;
  /** Rendered INSTEAD of rows when the section is empty. */
  emptyLine: string;
}

export interface GoalSessionsModel {
  sections: GoalSessionsSection[];
  /** Every session on the goal, across all sections. */
  total: number;
  /** True when the goal has no sessions at all. The rail still renders its five
   *  headings — the caller uses this only to decide the header count. */
  empty: boolean;
}

/**
 * Attention first, matching FleetPeersRail and the board's own fleet ordering.
 * A session list is read to find the one that needs you, not alphabetically.
 */
const COLUMN_RANK: Record<HudColumnId, number> = {
  'needs-you': 0,
  blocked: 1,
  stalled: 2,
  working: 3,
  parked: 4,
};

/** `modes` tolerates a bare string (an older operator, or a mid-deploy SSE push
 *  — see HudRosterEntry.modes), so read both shapes rather than assuming. */
function modeIds(e: HudRosterEntry): string[] {
  return (e.modes ?? [])
    .map((m) => (typeof m === 'string' ? m : m?.mode))
    .filter((m): m is string => typeof m === 'string' && m.length > 0)
    .map((m) => m.toLowerCase());
}

/**
 * Which section a session belongs to.
 *
 * ⚠ The five sections are NOT five modes, and pretending they are would be the
 * easy mistake here. Measured against `modes/registry.ts`: `drain` and `grade`
 * are real mode ids, so those two read straight off the session's standing
 * modes. There is NO `testing` mode — a test agent is identified by its ROLE —
 * so that leg keys off `role` instead. The asymmetry is real; it is written down
 * rather than smoothed over, because the next reader will otherwise "fix" the
 * inconsistency by inventing a mode that nothing sets.
 *
 * Everything left over splits on whether the session is bound to work (a fleet
 * or a plan ⇒ Plan) or not (⇒ Misc). Misc is a genuine bucket, not a dumping
 * ground: the goal's own agent — looping, holding the portfolio, in no fleet —
 * lands there, and that is the correct reading of it.
 */
export function classifyGoalSession(e: HudRosterEntry): GoalSessionSectionId {
  const modes = modeIds(e);
  if (modes.includes('drain')) return 'drain';
  if (modes.includes('grade')) return 'grade';
  const role = (e.role ?? '').toLowerCase();
  if (role.includes('test') || role.includes('validat')) return 'testing';
  if (e.fleetSlug || e.currentPlanSlug) return 'plan';
  return 'misc';
}

/** Terminal per the shared oracle. `sessionState` is optional (an older payload
 *  carries none) — absent means "not known to be ended", never "ended". */
function isEnded(e: HudRosterEntry): boolean {
  return (e.sessionState ?? '').toLowerCase() === 'ended';
}

function toRow(s: HudSession, e: HudRosterEntry, isLead: boolean): GoalSessionRow {
  return {
    ownerId: s.ownerId,
    handle: s.handle,
    label: s.label,
    intent: s.intent,
    column: s.column,
    reason: s.reason,
    sinceSec: s.sinceSec,
    isLead,
    contextPct: s.contextPct,
    agent: e.agent,
    agentPaneKind: e.agentPaneKind,
    fleetSlug: e.fleetSlug,
    ended: isEnded(e),
  };
}

function byAttention(a: GoalSessionRow, b: GoalSessionRow): number {
  // Ended sinks below every live row regardless of the column it stopped in —
  // a corpse's last state is history, and ranking it against live work would let
  // it outrank an agent that actually needs a human.
  if (a.ended !== b.ended) return a.ended ? 1 : -1;
  const r = COLUMN_RANK[a.column] - COLUMN_RANK[b.column];
  if (r !== 0) return r;
  // Within a state, longest-suffering first — the board's own rule. Unknown ages
  // sort last: they carry no urgency signal, so they must never outrank a
  // measured one.
  const as = a.sinceSec ?? -1;
  const bs = b.sinceSec ?? -1;
  if (as !== bs) return bs - as;
  return a.handle.localeCompare(b.handle);
}

/**
 * Every session working this goal, grouped by type and by fleet.
 *
 * MEMBERSHIP is deliberately two-legged, and neither leg alone is enough:
 *  1. STAMPED — the session carries this goal's marker (`agent_modes.subject`,
 *     D-007), which the payload already exposes as the goal's `agents`. This is
 *     the only leg that can see the goal's own agent, which is in no fleet.
 *  2. FLEET — a session sharing a fleet with a stamped one. A fleet MEMBER is
 *     normally not stamped (the leader was launched on the goal and the members
 *     were launched on the plan), so without this leg the rail would show a lead
 *     with no fleet under it and read as though nobody were working.
 *
 * TERMINAL SESSIONS are kept, greyed, and sunk to the bottom of their group
 * rather than dropped. A finished test agent is evidence the testing happened;
 * dropping it would leave the pane showing only the present tense, and a goal's
 * history would disappear exactly when someone asks what was done. (I raised
 * this in the mockup and the owner did not rule on it; this is the default I
 * stated there.) `cap` bounds how many terminal rows a group keeps so a
 * long-running goal cannot bury its live sessions under its dead ones.
 */
export function deriveGoalSessions(
  entries: HudRosterEntry[],
  goalAgentOwnerIds: string[],
  opts: { nowMs: number; thresholds?: HudThresholds; endedCap?: number },
): GoalSessionsModel {
  const thresholds = opts.thresholds ?? HUD_DEFAULT_THRESHOLDS;
  const endedCap = opts.endedCap ?? 3;

  const stamped = new Set(goalAgentOwnerIds.filter((id) => typeof id === 'string' && id.length > 0));

  // Leg 2 needs the fleets of the STAMPED sessions only — a fleet is on the goal
  // because its lead is, never the other way round. Deriving it from any member
  // would let one shared member drag an unrelated fleet onto the goal.
  const goalFleets = new Set(
    entries.filter((e) => stamped.has(e.ownerId) && e.fleetSlug).map((e) => e.fleetSlug as string),
  );

  const onGoal = entries.filter(
    (e) => stamped.has(e.ownerId) || (e.fleetSlug != null && goalFleets.has(e.fleetSlug)),
  );

  // Deliberately pass `undefined` asks, as FleetPeersRail does: this rail is a
  // roster, and needs-you here means "this session's own state needs a human",
  // not "an unanswered ask is attributed to it".
  const rowByOwner = new Map<string, { row: GoalSessionRow; entry: HudRosterEntry }>();
  for (const e of onGoal) {
    const s = toHudSession(e, undefined, { nowMs: opts.nowMs, thresholds });
    rowByOwner.set(e.ownerId, { row: toRow(s, e, e.fleetRole === 'leader'), entry: e });
  }

  const sections = GOAL_SESSION_SECTIONS.map<GoalSessionsSection>((id) => ({
    id,
    caption: SECTION_CAPTION[id],
    groups: [],
    count: 0,
    emptyLine: SECTION_EMPTY[id],
  }));
  const sectionById = new Map(sections.map((s) => [s.id, s] as const));

  // Group by fleet; a session with no fleet is its own group. The GROUP's
  // section is decided by its LEAD, so a fleet is never split across two
  // sections by a member whose modes happen to differ from its leader's.
  const fleetGroups = new Map<string, { lead: GoalSessionRow | null; members: GoalSessionRow[]; leadEntry: HudRosterEntry | null }>();
  const solos: Array<{ row: GoalSessionRow; entry: HudRosterEntry }> = [];

  for (const { row, entry } of rowByOwner.values()) {
    if (!entry.fleetSlug) {
      solos.push({ row, entry });
      continue;
    }
    const g = fleetGroups.get(entry.fleetSlug) ?? { lead: null, members: [], leadEntry: null };
    if (entry.fleetRole === 'leader' && !g.lead) {
      // First leader wins, matching deriveFleetRollups and fleet-peers.ts — two
      // agents claiming leadership is a coordination fault, and these surfaces
      // must at least name the SAME one of them.
      g.lead = row;
      g.leadEntry = entry;
    } else {
      g.members.push(row);
    }
    fleetGroups.set(entry.fleetSlug, g);
  }

  for (const [, g] of fleetGroups) {
    let lead = g.lead;
    let leadEntry = g.leadEntry;
    if (!lead) {
      // A leaderless fleet still renders: promote its most-attention-worthy
      // member to the lead SLOT so the fleet is visible, and let the row's own
      // glyph say it is a member. Hiding a leaderless fleet would hide the very
      // state most worth seeing.
      const promoted = [...g.members].sort(byAttention)[0]!;
      lead = promoted;
      leadEntry = rowByOwner.get(promoted.ownerId)!.entry;
      g.members = g.members.filter((m) => m.ownerId !== promoted.ownerId);
    }
    const section = sectionById.get(classifyGoalSession(leadEntry!))!;
    section.groups.push({ lead, members: capEnded(g.members.sort(byAttention), endedCap) });
  }

  for (const { row, entry } of solos) {
    sectionById.get(classifyGoalSession(entry))!.groups.push({ lead: row, members: [] });
  }

  for (const s of sections) {
    s.groups.sort((a, b) => byAttention(a.lead, b.lead));
    s.count = s.groups.reduce((n, g) => n + 1 + g.members.length, 0);
  }

  const total = sections.reduce((n, s) => n + s.count, 0);
  return { sections, total, empty: total === 0 };
}

/** Keep every live row and at most `cap` terminal ones. Applied AFTER sorting,
 *  which `byAttention` has already sunk the ended rows to the bottom of. */
function capEnded(rows: GoalSessionRow[], cap: number): GoalSessionRow[] {
  let kept = 0;
  return rows.filter((r) => !r.ended || ++kept <= cap);
}
