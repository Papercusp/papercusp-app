/**
 * role-slot-live-resolve.ts — resolve an `@role:<role>` slot selector against
 * the LIVE roster (EI-13620).
 *
 * B2 (park-for-slot, directed-wake-honesty-and-spawn-handoff-2026-06-14, P-025)
 * built `@role:`/`@wave:`/`@feature:` addressing PURELY as a "next agent
 * spawned into this slot" mailbox: sendMessage (./messages.ts) always parked a
 * role-addressed send and NEVER checked whether a session already holds that
 * role RIGHT NOW. For a workspace-singleton pot role (mug/kettle/papercup/
 * papercup-deep) that mailbox is drained only at the role's next LAUNCH
 * (mug-brief-launch.ts's gatherInbox → drainSlotMessages, fired from the fresh
 * spawn path) — never when an ALREADY-RUNNING session is merely idle/parked
 * waiting on `coord:await-inbox`. So a correction nudge to a stable, currently
 * live-but-idle Mug silently parked (targets:[], woken:0, `federated:true` with
 * no live recipient) and sat until some FUTURE relaunch that might not happen
 * for hours — exactly the EI-13620 symptom (Kettle's placement correction to
 * `@role:mug` never reached a Mug that was alive the whole time).
 *
 * This resolves the role against live presence (`agentRole`, pot-rename
 * canonicalized via canonicalCoordRole) BEFORE the slot-vs-live split in
 * sendMessage: any session whose role matches and whose derived sessionState
 * is not `ended` is a live holder. The slot is STILL parked unconditionally
 * (unchanged behavior) so a future relaunch keeps draining it too — this is
 * purely ADDITIVE: when a live holder exists, the message is delivered to (and
 * can wake) it exactly like an ordinary ownerId send; when none exists, nothing
 * changes from the legacy park-for-future-spawn behavior.
 */
import { listPresence } from './presence';
import { fetchWakeability } from './presence-wakeability';
import { deriveVerdict } from './liveness-oracle';
import { recordedLiveOwnerIds } from '../../adv-sessions';
import { canonicalCoordRole } from './roles';

/**
 * Roles that are a SINGLE instance per WORKSPACE, covering every hive/harness
 * the workspace has started — mirrors the `anyHarnessSlug` special-case already
 * coded for 'mug' in mug-brief-launch.ts ("there is ONE Queen/Mug per workspace
 * covering all started hives"). Resolved workspace-wide (never hive/harness-
 * filtered) so a nudge to e.g. `@role:mug` always finds the one Mug regardless
 * of which harness context the sender happened to carry.
 */
const WORKSPACE_SINGLETON_ROLES = new Set(['mug', 'kettle', 'papercup', 'papercup-deep']);

export interface RoleSlotScope {
  workspaceId?: string | null;
  /** Hive/pot slug to scope to for a non-singleton (pipeline) role lookup;
   *  ignored for a workspace-singleton role (see WORKSPACE_SINGLETON_ROLES). */
  potSlug?: string | null;
}

/**
 * Resolve every CURRENTLY LIVE (derived sessionState !== 'ended') session whose
 * presence row's `agentRole` canonicalizes to `role`. Fail-soft throughout: any
 * read error (including the plain-object `sql: {}` test double some sendMessage
 * unit tests swap in) degrades to `[]` — the caller's existing
 * park-for-future-spawn behavior is always the safe fallback, never a thrown
 * error out of a coord:send.
 */
export async function resolveLiveRoleHolders(
  role: string,
  scope: RoleSlotScope = {},
): Promise<string[]> {
  if (!role) return [];
  const wanted = canonicalCoordRole(role);
  const potSlug = WORKSPACE_SINGLETON_ROLES.has(wanted) ? null : (scope.potSlug ?? null);
  let records: Awaited<ReturnType<typeof listPresence>>;
  try {
    records = await listPresence({ workspaceId: scope.workspaceId ?? null, potSlug });
  } catch {
    return [];
  }
  const candidates = records.filter(
    (r) => r.agentRole && canonicalCoordRole(r.agentRole) === wanted,
  );
  if (candidates.length === 0) return [];
  let wakeability = new Map<string, { wakeable: boolean; liveTurn: boolean }>();
  try {
    wakeability = await fetchWakeability(candidates.map((r) => r.ownerId));
  } catch {
    /* fail-soft: no wakeability signal — deriveVerdict below still holds on stale/hardStale */
  }
  const recordedLive = await recordedLiveOwnerIds(candidates.map((r) => r.ownerId)).catch(
    () => new Set<string>(),
  );
  const nowMs = Date.now();
  return candidates
    .filter((r) => {
      const w = wakeability.get(r.ownerId) ?? { wakeable: false, liveTurn: false };
      // Unification P-003: ONE derivation via the shared oracle (pid probe +
      // recorded rescue included — a just-launched slot-holder is `recorded`,
      // not dropped as `ended`).
      const state = deriveVerdict(
        {
          ownerId: r.ownerId,
          heartbeatAt: r.heartbeatAt,
          stale: r.stale,
          host: r.host,
          pid: r.pid,
          source: r.source,
        },
        w,
        recordedLive,
        nowMs,
      ).sessionState;
      return state !== 'ended';
    })
    .map((r) => r.ownerId);
}

/**
 * Resolve the hive/pot scope for a harness-scoped (non-singleton) role lookup
 * — mirrors resolvePresenceScope's hive-default (presence-snapshot.ts),
 * fail-soft to `null` (workspace-wide) on any lookup error or missing harness.
 */
export async function resolveRoleSlotPotSlug(
  workspaceId: string | null | undefined,
  harnessSlug: string | null | undefined,
): Promise<string | null> {
  if (!harnessSlug) return null;
  try {
    const { potHomeSlugForHarness } = await import('../../hive-federation');
    return await potHomeSlugForHarness(workspaceId ?? 'default', harnessSlug);
  } catch {
    return null;
  }
}
