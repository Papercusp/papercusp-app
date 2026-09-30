/**
 * retired-tier-roles.ts — WHICH agent roles belong to the retired Mug/Kettle/Cup
 * tier (retire-mug-kettle-su-only-2026-08-09 P-008 / D-018).
 *
 * Split out as its own module for two deliberate reasons:
 *
 *  1. ONE definition, THREE doors. A role reaches a running agent through
 *     `fleet/operator-spawn.ts` (the role-admission chokepoint every agent-driven
 *     launch funnels through), `endpoint-route/routes/harness/spawn.ts` (the
 *     `/invoke` route every launch-blueprint + wake path traverses), and
 *     `endpoint-route/routes/agent-mcp/bootstrap-role.ts` (the CONSOLE path:
 *     `psu --role <role>` execs the backend LOCALLY after bootstrapping here, so
 *     it calls neither of the other two). All three must answer this question
 *     identically; inline literal lists would be things free to drift, and a
 *     drifted spawn gate fails OPEN.
 *
 *     ⚠ THIS HEADER SAID "exactly two doors" UNTIL P-013 (D-022), AND IT WAS
 *     WRONG — the console door was simply never enumerated. The claim read as
 *     settled fact and is exactly what made the third door easy to skip: an
 *     agent checking "is spawn-by-role-name covered?" finds a confident
 *     two-door statement, both doors gated, and stops. If you add a fourth
 *     launch path, it belongs in this list — and do not trust a count here
 *     over a fresh enumeration of who can turn a role NAME into a process.
 *
 *  2. NOT added to `pot/started.ts`. That module already exports
 *     `mugKettleSystemEnabled`, and adding an export there strands every
 *     `vi.mock('.../pot/started')` factory in the tree — measured twice on this
 *     plan (EI-20017608270017874), once loudly and once SILENTLY. A new module
 *     nobody mocks yet carries none of that blast radius.
 *
 * ⚠ CANONICALIZE BEFORE TESTING — this is the whole subtlety. The pot rename left
 * live ALIASES in `coordination/roles.ts` (`bee`→`cup`, `queen`→`mug`,
 * `overwatch`→`kettle`), and real callers still use the old spellings: the
 * `/invoke` route's own comment records `?role=queen` as the PRODUCTION
 * convention for Mug wakes. Matching the raw string would leave all three roles
 * reachable under their former names — a gate that looks closed and is open,
 * which is the "anchor to the property, not the spelling" failure this plan has
 * now hit at three separate layers.
 *
 * ⚠ `scout` ALSO maps through that table (→ `blender`) and is deliberately NOT
 * here: D-001 keeps Scout/Blender INTACT. Adding it would retire the subsystem
 * the replacement plan depends on.
 */
import { canonicalCoordRole } from '../agent-tools/coordination/roles';

/**
 * The CANONICAL role ids of the retired tier (D-001: Mug, Kettle, and the
 * Cup/nursery tier). Canonical spellings only — aliases are resolved by
 * `isRetiredTierRole`, never listed here, so this set stays the single statement
 * of WHAT is retired rather than a list of spellings to keep chasing.
 */
export const RETIRED_TIER_ROLES: ReadonlySet<string> = new Set(['mug', 'kettle', 'cup']);

/**
 * Does `role` name an agent of the retired Mug/Kettle/Cup tier — under EITHER
 * its current or its pre-rename spelling?
 *
 * Note this answers only "is this role in the retired tier", NOT "should this be
 * refused" — the caller pairs it with `mugKettleSystemEnabled()`, so the tier
 * stays spawnable while the flag is ON (it is a `case: 'cutover'` flag, and
 * reversibility is the point).
 */
export function isRetiredTierRole(role: string): boolean {
  return RETIRED_TIER_ROLES.has(canonicalCoordRole(role));
}
