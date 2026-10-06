/**
 * silent-member.ts — which live fleet members count toward headcount, and which are
 * SILENT (plan feature-drain-delivery-readiness-and-outcome-accounting-2026-10-01,
 * P-007 / R-17; threshold fixed by D-007 item 4).
 *
 * A launch heartbeat proves only that a process occupies a seat. A member whose only
 * sign of life for longer than the threshold is that heartbeat is SILENT: it holds a
 * seat without working it. Measured 2026-10-01: one drain-fleet worker heartbeat for
 * about 8 hours while making no calls, and the headcount controller kept counting it,
 * so the fleet never asked for a replacement.
 *
 * The rule:
 *   - a member is COUNTED when it made any agent-origin call (MCP or native tool —
 *     `executingOwnersSince`, which never sees heartbeats) inside the threshold, OR it is
 *     parked on a pending, unexpired `events:await` (waiting by contract — the 1800s
 *     await is the standard wait, and counting it absent would relaunch a filled seat:
 *     the churn `FLEET_HEADCOUNT_EXECUTION_WINDOW_MS` was widened to stop);
 *   - the always-armed `coord:inbox-wake:<owner>` keepalive await does NOT count: every
 *     psu member carries one, so honouring it would make every member non-silent and
 *     this rule vacuous;
 *   - in a PAUSED fleet (registry control_state 'winding-down') nobody is silent: an idle
 *     member is the compliant response to the stand-down, so every live member counts;
 *   - an unreadable execution or await leg answers UNKNOWN (`null`), never "everyone is
 *     silent": an under-count would spawn replacements for filled seats.
 *
 * The pure partition is exported for unit tests; `readFleetMemberSilence` is the IO seam
 * the headcount governor, `fleet:status` and `fleet:leader-brief` share, so a status read
 * cannot disagree with the writer that decides whether another member is needed.
 */
import { getOrgPg } from '@papercusp/db-org';
import { executingOwnersSince } from '../../fleet/assignments';
import { FLEET_MEMBER_SILENCE_THRESHOLD_MS } from '../../fleet/member-silence-threshold';

export { FLEET_MEMBER_SILENCE_THRESHOLD_MS };

/** Await keys that are standing keepalives rather than a declared wait. */
const KEEPALIVE_AWAIT_KEY_PREFIXES: readonly string[] = ['coord:inbox-wake:'];

/** True when a pending await on `eventKey` exempts its subscriber from silence. */
export function isSilenceExemptAwaitKey(eventKey: string): boolean {
  return !KEEPALIVE_AWAIT_KEY_PREFIXES.some((prefix) => eventKey.startsWith(prefix));
}

export interface FleetMemberSilencePartition {
  /** Live members that count toward headcount. */
  counted: string[];
  /** Live members silent past the threshold; they do NOT count. */
  silent: string[];
  /** The fleet was paused, so silence was not applied. */
  paused: boolean;
  thresholdMs: number;
}

/**
 * Pure. `recentCallerIds` = owners with an agent-origin call inside the threshold;
 * `awaitingKeysByOwner` = each owner's pending await keys. Either leg `null` means it
 * was unreadable and the answer is UNKNOWN (`null`), except in a paused fleet, where
 * silence is not applied and no leg is needed.
 */
export function partitionSilentFleetMembers(args: {
  liveMemberIds: readonly string[];
  recentCallerIds: ReadonlySet<string> | null;
  awaitingKeysByOwner: ReadonlyMap<string, readonly string[]> | null;
  fleetPaused: boolean | null | undefined;
  thresholdMs?: number;
}): FleetMemberSilencePartition | null {
  const thresholdMs = args.thresholdMs ?? FLEET_MEMBER_SILENCE_THRESHOLD_MS;
  const live = [
    ...new Set(args.liveMemberIds.filter((id): id is string => typeof id === 'string' && id.length > 0)),
  ];
  if (args.fleetPaused === true) {
    return { counted: live, silent: [], paused: true, thresholdMs };
  }
  if (args.recentCallerIds == null || args.awaitingKeysByOwner == null) return null;
  const counted: string[] = [];
  const silent: string[] = [];
  for (const ownerId of live) {
    const waiting = (args.awaitingKeysByOwner.get(ownerId) ?? []).some(isSilenceExemptAwaitKey);
    if (args.recentCallerIds.has(ownerId) || waiting) counted.push(ownerId);
    else silent.push(ownerId);
  }
  return { counted, silent, paused: false, thresholdMs };
}

/** IO: pending, unexpired await keys per subscriber (same predicate as presence-tier1). */
export async function pendingAwaitKeysByOwner(
  ownerIds: readonly string[],
): Promise<Map<string, string[]> | null> {
  const ids = [...new Set(ownerIds)];
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ subscriber_id: string; event_key: string }[]>`
      SELECT subscriber_id, event_key
        FROM harness_shared.event_awaits
       WHERE subscriber_id = ANY(${ids}::text[])
         AND fired_at IS NULL AND cancelled_at IS NULL
         AND (expires_ts IS NULL OR expires_ts > now())
    `;
    for (const row of rows) {
      const keys = out.get(row.subscriber_id) ?? [];
      keys.push(row.event_key);
      out.set(row.subscriber_id, keys);
    }
    return out;
  } catch {
    return null;
  }
}

/** IO seam shared by the headcount governor and the fleet read surfaces. */
export async function readFleetMemberSilence(
  liveMemberIds: readonly string[],
  opts: { fleetPaused?: boolean | null; thresholdMs?: number } = {},
): Promise<FleetMemberSilencePartition | null> {
  const thresholdMs = opts.thresholdMs ?? FLEET_MEMBER_SILENCE_THRESHOLD_MS;
  if (opts.fleetPaused === true) {
    return partitionSilentFleetMembers({
      liveMemberIds,
      recentCallerIds: null,
      awaitingKeysByOwner: null,
      fleetPaused: true,
      thresholdMs,
    });
  }
  const live = [...new Set(liveMemberIds)];
  const [recentCallerIds, awaitingKeysByOwner] = await Promise.all([
    executingOwnersSince(live, thresholdMs),
    pendingAwaitKeysByOwner(live),
  ]);
  return partitionSilentFleetMembers({
    liveMemberIds: live,
    recentCallerIds,
    awaitingKeysByOwner,
    fleetPaused: false,
    thresholdMs,
  });
}

/** Convenience for the population sites: the counted set, or `null` when unknown. */
export function countedMemberSet(partition: FleetMemberSilencePartition | null): Set<string> | null {
  return partition == null ? null : new Set(partition.counted);
}
