/**
 * coord-identity.ts — Scout's stable coord identity (queen-scout-feedback-loop
 * -2026-06-20, P-003).
 *
 * The Queen↔Scout feedback loop (D-001/D-003) needs a STABLE address the Queen can
 * `coord:send(to:scout, wake:'required', plan_slug, body:guidance)` to, and that the
 * Scout cycle reads its inbox AS (`readInbox(scoutCoordOwnerId(hive))` at cycle-start,
 * scheduler.ts P-001).
 *
 * Why STATIC (not a session-resolved id like the Mug's {@link
 * ../pot/placement-watchdog.resolveMugOwner}): the Mug (formerly Queen) is an interactive
 * brain that re-spawns per wake, so her coord owner is the NEWEST `hive ·
 * <slug>/queen` adv_session's `coord_owner_id` — dynamic. Scout has NO per-session
 * identity: it IS the cron-fired `blender:cycle` op (register-scout-action.ts), with
 * no live session and no `adv_sessions` row. So its addressable identity must be a
 * deterministic ROLE id derived from the hive slug — `scout:<hive>` — which both
 * the Queen's send and the cycle's `readInbox` resolve to the same string with no
 * roster lookup (sendMessage's best-effort roster resolve leaves a non-session
 * `scout:<hive>` untouched, and readInbox matches on the literal `to[]`).
 *
 * Per the design's D-003 NOTE this `scout:<hive>` form is the deliberate per-hive
 * scope (the per-Swarm queen/bee/overwatch vs per-workspace sentinel scheme is
 * settled separately in the hive role-scope revisit); it generalizes to "every
 * autonomous role is an addressable coord identity."
 *
 * Pure + dependency-free so it unit-tests without PG/coord — the core/host split
 * the rest of lib/scout follows.
 */

/** The coord-owner prefix for the Scout role (mirrors `queen:`/`bee:` role scoping). */
export const SCOUT_COORD_PREFIX = 'blender:';

/**
 * The stable coord owner id the Scout cycle for `potSlug` reads-as and the Queen
 * addresses for plan feedback: `scout:<potSlug>`. The slug is trimmed; an
 * empty/blank slug throws (a Scout with no hive can't have a routable identity —
 * the caller should always have the routine's `installSlug`).
 */
export function scoutCoordOwnerId(potSlug: string): string {
  const slug = potSlug.trim();
  if (!slug) {
    throw new Error('scoutCoordOwnerId: potSlug is required (a Scout role identity is per-hive)');
  }
  return `${SCOUT_COORD_PREFIX}${slug}`;
}

/** True when `ownerId` is a Scout role identity (`scout:<hive>`) rather than a session id. */
export function isScoutCoordOwnerId(ownerId: string): boolean {
  return ownerId.startsWith(SCOUT_COORD_PREFIX) && ownerId.length > SCOUT_COORD_PREFIX.length;
}

/** The hive slug a `scout:<hive>` identity is for, or null if `ownerId` isn't one. */
export function hiveOfScoutCoordOwnerId(ownerId: string): string | null {
  if (!isScoutCoordOwnerId(ownerId)) return null;
  return ownerId.slice(SCOUT_COORD_PREFIX.length);
}
