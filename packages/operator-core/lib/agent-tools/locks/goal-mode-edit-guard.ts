/**
 * goal-mode-edit-guard — mechanical enforcement of the GOAL contract's
 * never-implement clause (EI-20581099901890760).
 *
 * WHY HERE. The GOAL mode contract (modes/registry.ts, id 'goal') states "You
 * never IMPLEMENT it… there is no exception", and names the exact temptation
 * that defeats the prose: infrastructure blocking the agent's own fleets.
 * Measured 2026-08-16 (WI-39348): a GOAL agent with that contract in context
 * edited production source 2h into its run, and the only half-hour with edits
 * was also the lowest-supervision half-hour of the run — the contract's own
 * causal prediction, confirmed. Prose does not hold at the moment of
 * temptation; a tool gate does (precedent: NO_SUBAGENT_TOOLS_DENY, the
 * non-canonical-worktree edit guard).
 *
 * WHY THIS LOCUS. Every native Edit/Write on a psu client flows through the
 * PreToolUse lock hook, which claims a lock with intent 'PreToolUse:<Tool>'
 * and — on ANY `{ ok:false, reason }` from locks:acquire — denies the edit
 * with `reason` fed back to the MODEL (both Claude and Codex clients). So one
 * server-side check in the acquire path enforces the clause for every client,
 * with zero hook changes, and the teaching message arrives exactly at the
 * moment of temptation.
 *
 * WHAT IT DOES NOT DO. Only AUTOMATIC hook claims (intent 'PreToolUse:*') are
 * gated — a deliberate hand-held multi-file lock is not an edit by itself, and
 * resource locks never pass through here. Fleet members launched BY a goal
 * agent are untouched: they inherit goal CONTEXT (session_briefs.goal_id), not
 * a goal-mode row, and this guard reads the mode registry only
 * (agent_modes.mode = 'goal'). A goal-mode row WITHOUT a filed subject still
 * denies: the contract binds at mode entry (mode:set), not at goals:create —
 * this deliberately diverges from goal-session.ts's isGoalSession, which is a
 * BOARD-VISIBILITY predicate, not the contract-binding one.
 *
 * FAIL-OPEN like the rest of the lock stack: enforcement must never wedge
 * edits when flag infra or PG is down (the hook itself allows on operator
 * unreachability for the same reason).
 */
import type { Sql } from 'postgres';
import { getModes } from '../../modes/store';
import { GOAL_MODE } from '../../modes/goal-session';

export interface GoalModeEditGuardDeps {
  flagEnabled: () => Promise<boolean>;
  readModes: (workspaceId: string, ownerId: string) => Promise<Array<{ mode: string }>>;
}

async function defaultFlagEnabled(): Promise<boolean> {
  try {
    const [{ getFlag }, { FLAGS }] = await Promise.all([
      import('@papercusp/flags/server'),
      import('@papercusp/flags'),
    ]);
    return await getFlag(FLAGS.GOAL_MODE_EDIT_DENY, 'system');
  } catch {
    // Flag infra unavailable (early boot, tests) — fail open, never wedge edits.
    return false;
  }
}

export function goalModeEditDenyReason(o: { ownerId: string }): string {
  return (
    `GOAL mode: you never implement — not a feature, not a fix, not a test, not infrastructure ` +
    `(the GOAL contract admits no exception, and names this exact temptation). Your registered mode ` +
    `for ${o.ownerId} is 'goal', so this edit is refused. Route it instead: ` +
    `work_items:create { kind, title, … } and let your standing drain fleet pick it up, or launch a ` +
    `dedicated fixer — fleet:launch-on-plan { plan, count, leader:'spawn' }. If the owner genuinely ` +
    `wants this session editing, exit GOAL mode first (mode:set { mode:'goal', enabled:false }) or ` +
    `flip flag GOAL_MODE_EDIT_DENY at /admin/features.`
  );
}

/**
 * Returns the refusal reason when this acquire is an automatic per-edit hook
 * claim by a session whose registered mode is GOAL — or null to allow.
 */
export async function checkGoalModeEditGuard(
  o: { workspaceId: string | null; ownerId: string; intent: string; sql?: Sql },
  deps?: Partial<GoalModeEditGuardDeps>,
): Promise<string | null> {
  // Only the automatic hook-claim path is an EDIT; everything else passes.
  if (!o.intent.startsWith('PreToolUse:')) return null;
  if (!o.ownerId) return null;
  try {
    const enabled = await (deps?.flagEnabled ?? defaultFlagEnabled)();
    if (!enabled) return null;
    const readModes = deps?.readModes ?? ((ws: string, owner: string) => getModes(ws, owner, o.sql));
    const modes = await readModes(o.workspaceId ?? 'default', o.ownerId);
    const inGoalMode = modes.some((m) => m.mode === GOAL_MODE);
    if (!inGoalMode) return null;
    return goalModeEditDenyReason({ ownerId: o.ownerId });
  } catch {
    // Fail-open: a broken mode read must not block the fleet's edits.
    return null;
  }
}
