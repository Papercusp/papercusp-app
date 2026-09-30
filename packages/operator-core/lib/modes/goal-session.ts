/**
 * goal-session — the ONE derivation of "is this session a goal's agent, and
 * which goal?" (goals-tab-improvement-2026-08-09 D-007, P-020).
 *
 * WHY THIS FILE EXISTS AT ALL. P-020's load-bearing requirement is not the
 * filter — it is that the sessions board and the goals board read the SAME
 * marker. Two independent notions of "goal session" disagree about which
 * sessions are hidden, and a session hidden by BOTH is invisible with nothing
 * on screen to say so. That failure is silent in the direction that matters:
 * nobody files a bug about a session they cannot see. So the rule lives here,
 * once, as a pure function both boards call, rather than as two `.some(m =>
 * m.mode === 'goal')` expressions that drift the first time either is touched.
 *
 * WHY THERE IS NO `session_kind` COLUMN. There was very nearly one. The marker
 * already exists and predates this plan: `harness_shared.agent_modes.subject`
 * holds the `harness_shared.goals.id` a GOAL-mode session is running, stamped
 * by `goals:create` as a documented side effect (goal-mode-2026-08-07 P-016).
 * A new column would have been a second source of truth for a fact the mode row
 * already carries, and the two would eventually disagree. This module reads the
 * existing one.
 *
 * The mode table's primary key is `(workspace_id, owner_id, axis_key)`, so an
 * agent holds at most one row per axis and therefore at most one goal subject.
 * D-006's "one directed agent = one goal" is thus a property of the schema, not
 * a rule any caller here has to enforce.
 *
 * This module is imported by the SPA bundle (`hud-board-model.ts`), so it stays
 * PURE — no PG, no imports beyond types.
 */

/** The registry id of the GOAL mode axis. */
export const GOAL_MODE = 'goal';

/**
 * The shape this module needs from a mode entry, declared structurally so both
 * `AdvRosterMode` (server) and `HudMode` (client) satisfy it without either
 * importing the other. A bare string is tolerated because the roster payload
 * historically flattened modes to ids, and such an entry can never carry a
 * subject — so it is never a goal session, which is the correct reading.
 */
export interface ModeLike {
  mode: string;
  subject?: string | null;
}

/**
 * The goal this session is RUNNING, or null when it is not a goal's agent.
 *
 * THE ASYMMETRY IS THE POINT, and it is the part most likely to be "simplified"
 * by a later reader: being in GOAL mode is NOT sufficient. The subject must be
 * present. A session that entered GOAL mode but has not yet filed its goal has
 * `mode='goal'` with `subject IS NULL`, and it must keep appearing in the
 * ordinary sessions pane — there is no goal card for it to appear under yet, so
 * hiding it would take it off both boards at once. Measured 2026-08-09: the one
 * live goal-mode row in this workspace was exactly that case, which is to say
 * the "impossible" state is the only one that has ever actually existed.
 *
 * Returns the first goal-mode entry carrying a subject. Order is the caller's
 * (the roster returns modes ordered by axis_key); the schema's primary key
 * makes more than one structurally unreachable, so this does not pick a winner
 * so much as decline to crash if the invariant is ever broken.
 */
export function goalIdFromModes(
  modes: ReadonlyArray<ModeLike | string> | null | undefined,
): string | null {
  if (!modes) return null;
  for (const raw of modes) {
    if (typeof raw === 'string') continue;
    if (raw?.mode !== GOAL_MODE) continue;
    const subject = raw.subject;
    if (typeof subject === 'string' && subject.trim() !== '') return subject;
  }
  return null;
}

/**
 * Whether this session should be HIDDEN from the ordinary sessions board
 * because it belongs to a goal and is rendered there instead
 * (owner 2026-08-09: "the goal sessions shouldnt show in the normal sessions
 * pane. goals are just sessions but a special type").
 *
 * Deliberately a named predicate rather than `goalIdFromModes(m) !== null` at
 * the call site: the two boards must agree, and a named rule is greppable and
 * testable in a way an inline comparison is not.
 */
export function isGoalSessionModes(
  modes: ReadonlyArray<ModeLike | string> | null | undefined,
): boolean {
  return goalIdFromModes(modes) !== null;
}
