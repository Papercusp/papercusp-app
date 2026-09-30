/**
 * agent-wedge — PURE: is an agent present-but-unproductive?
 *
 * THE ONE RULE, so it cannot be written twice. `goals/activity.ts` asked this
 * question about a goal's HOLDER first (EI-21578742955425881) and the predicate
 * was born there, goal-shaped. But the condition it detects has nothing to do
 * with goals: it is a property of an AGENT SESSION — alive by every liveness
 * signal, and has never once done work. Leaving the rule inside the goals
 * module meant every other population that needs it (fleet members, drain
 * workers, any launched session) would grow its own copy, and two copies of a
 * threshold rule drift silently — nobody notices two detectors disagreeing,
 * because each one is only ever read on its own.
 *
 * So the rule lives here, subject-agnostic, and `resolveGoalHolderWedge`
 * delegates to it while keeping its own goal-shaped vocabulary.
 *
 * ── WHY THIS IS NOT VISIBLE TO ANY EXISTING SURFACE ─────────────────────────
 *
 * Measured workspace-wide 2026-08-27: of 166 sessions past the grace window
 * that the liveness oracle called present, 22 had made ZERO agent-origin tool
 * calls since `started_at` — 11 of them members of a fleet. `coord:presence`
 * reported all of them `wakeable: true`, which is what a dispatcher reads to
 * decide who can take work; one had been wakeable for eighteen hours without a
 * single tool call of any origin. Nothing anywhere was wrong: heartbeats fresh,
 * sessionState a legitimate `parked`, no alarm on any surface. Present and
 * never-worked is simply not a question the count-based reads ask.
 *
 * ── THE TWO PHASES, AND WHY THE DISTINCTION IS LOAD-BEARING ─────────────────
 *
 * The same measurement split cleanly into two populations that want different
 * repairs, which is why `phase` exists rather than a bare boolean:
 *
 *   `never-booted`         zero calls of ANY origin, hook-origin included. The
 *                          session-start hooks never fired, so nothing ever ran
 *                          in that process — yet a presence row exists and its
 *                          heartbeat is fresh. Either the launcher wrote
 *                          presence for a session that never came up, or
 *                          something is keeping the row warm after death. The
 *                          repair is at the LAUNCHER/presence layer.
 *   `booted-never-worked`  hook-origin calls > 0, agent-origin calls 0. The
 *                          process came up and ran its start hooks, then never
 *                          took a turn — the classic wedge (a first-turn 429,
 *                          an unlaunchable model, a wedged CLI). The repair is
 *                          at the SESSION layer, and only this phase is a
 *                          candidate for respawn.
 *
 * Collapsing them would produce one alarm class with two unrelated cures, and
 * the cure for one is actively wrong for the other: respawning a `never-booted`
 * row re-runs a launcher that already failed, and re-launching the presence
 * layer does nothing for a session that is genuinely up.
 *
 * ── WHAT THIS MODULE DELIBERATELY DOES NOT DECIDE ───────────────────────────
 *
 * It reports; it never prescribes a respawn. Wedge causes are CORRELATED — one
 * throttled account pool wedges every session launched against it at once — so
 * a detector wired to relaunch fires N respawns straight back into the same
 * wall. A caller that can also see whether capacity exists owns that decision.
 * The same reasoning is why `goals/activity.ts` keeps this signal out of its
 * deactivation predicate, and it transfers unchanged.
 */

/** How long a present agent may produce NOTHING before it counts as wedged.
 *
 *  Generous on purpose. The predicate only ever fires on an agent that has
 *  NEVER produced an agent-origin call, so this is not "idle for 15 minutes" —
 *  it is "has never once worked, and has now had a quarter of an hour to". An
 *  agent midway through one long tool call has already made that call and can
 *  never trip this. */
export const AGENT_PRODUCTIVITY_GRACE_MS = 15 * 60_000;

/**
 * Whether the subject is there at all.
 *
 * Three values, not a boolean, for the reason `holder.ts` keeps `unknown`
 * separate from `lost`: a degraded liveness fetch returns no verdict, and
 * reading that omission as absence turns one transient DB hiccup into a wave of
 * false alarms across every subject at once. `unknown` suppresses exactly like
 * `absent` here, but the caller can still tell the two apart.
 */
export type AgentPresence = 'present' | 'absent' | 'unknown';

/** Evidence that a present agent has actually DONE something. */
export interface AgentProductivity {
  /**
   * Agent-origin tool calls since the subject became present. Hook-origin calls
   * MUST NOT be counted — that exclusion IS the signal. A session that boots and
   * immediately fails still emits hook-fired calls (`coord:glance`,
   * `activity:report` on the session-start hook), so a RAW invocation count is
   * non-zero for an agent that never ran a single instruction of its own. In the
   * measured cases the raw count was 2–5 and the agent-origin count was 0.
   *
   * ⚠ When counting these in SQL use `call_origin IS DISTINCT FROM 'hook'`, not
   * `<> 'hook'`: the latter is FALSE for a NULL origin and silently drops those
   * rows, undercounting toward a FALSE WEDGE — the one direction this must never
   * err in.
   */
  agentOriginCalls: number;
  /**
   * Calls of ANY origin, hook included — the phase discriminator. Optional: a
   * caller that cannot cheaply measure it gets a correct `wedged` verdict with a
   * null `phase`, rather than a guessed one.
   */
  anyOriginCalls?: number | null;
  /** How long the subject has been present, in ms — the clock the grace runs against. */
  presentForMs: number;
}

/** Which of the two wedge shapes this is — see the module header. */
export type AgentWedgePhase = 'never-booted' | 'booted-never-worked';

export type AgentWedgeReason =
  | 'wedged'
  | 'not-present'
  | 'not-measured'
  | 'has-produced-work'
  | 'within-grace';

export interface AgentWedgeVerdict {
  /** Present, and has never produced work past the grace window. */
  wedged: boolean;
  /**
   * Why not, when `wedged` is false — so a caller rendering "healthy" can say
   * whether that was MEASURED or merely unmeasured. `not-measured` is the one
   * that must never be read as a clean bill of health: an absent measurement and
   * a passing measurement are the same boolean and completely different facts,
   * and collapsing them is how "nothing reported a problem" becomes "there is no
   * problem".
   */
  reason: AgentWedgeReason;
  /**
   * The wedge shape when `wedged` is true AND `anyOriginCalls` was supplied;
   * null otherwise. Null means "not determined", never "neither".
   */
  phase: AgentWedgePhase | null;
}

/**
 * PURE: is this agent alive-but-not-working?
 *
 * Only ever a real question about a PRESENT subject — every other presence
 * verdict is already described correctly by whatever produced it, and a wedge is
 * by definition something that happens to somebody who IS there.
 */
export function resolveAgentWedge(input: {
  presence: AgentPresence;
  productivity?: AgentProductivity | null;
  graceMs?: number;
}): AgentWedgeVerdict {
  if (input.presence !== 'present') {
    return { wedged: false, reason: 'not-present', phase: null };
  }

  const productivity = input.productivity ?? null;
  if (!productivity) return { wedged: false, reason: 'not-measured', phase: null };

  if (productivity.agentOriginCalls > 0) {
    return { wedged: false, reason: 'has-produced-work', phase: null };
  }

  const graceMs = input.graceMs ?? AGENT_PRODUCTIVITY_GRACE_MS;
  if (productivity.presentForMs < graceMs) {
    return { wedged: false, reason: 'within-grace', phase: null };
  }

  return { wedged: true, reason: 'wedged', phase: resolvePhase(productivity) };
}

/**
 * The phase discriminator, split out so the "unmeasured ⇒ null, never a guess"
 * rule lives in one place.
 *
 * Note `anyOriginCalls` is only consulted once `agentOriginCalls` is already
 * known to be 0, so `anyOriginCalls > 0` here can only mean hook-origin traffic.
 */
function resolvePhase(p: AgentProductivity): AgentWedgePhase | null {
  if (p.anyOriginCalls == null) return null;
  return p.anyOriginCalls > 0 ? 'booted-never-worked' : 'never-booted';
}
