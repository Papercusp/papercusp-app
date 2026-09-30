/**
 * resource-broadcast — Phase 3 coord broadcasts for named-resource drain.
 *
 * The PG state machine + the resource_grant_cascade NOTIFY already make
 * drain *work* (the exclusive waiter wakes when shared holders release).
 * These broadcasts are the politeness layer that makes it *prompt*: they
 * tell peers to act.
 *
 *  - drain-start (P-009): a targeted coord message to each current shared
 *    holder — "release when your current use is done; don't start new".
 *  - back-up (P-010): a broadcast that the resource is free again.
 *
 * Locks are CONTROL-plane, not subscribe→inject content (coordination-substrate
 * D-007): you wait on a lock (the PG state machine + resource_grant_cascade
 * NOTIFY + the wait loop), you don't "follow" it. So these are plain coord
 * messages — the path-glob `fireNotifications(resource:<name>)` fan-out was
 * retired with the rest of coord:watch and is gone. All best-effort: a broadcast
 * failure must never break the acquire / release.
 */

import { sendMessage } from '../coordination/messages';
import type { AgentIdentity } from '../coordination/identity';
import type { ResourceHolder } from './su-lock-store';
import { emitResourceReleasedEvent } from '../../harness/git-sync/git-sync-events';

export async function broadcastResourceDrainStart(params: {
  source: AgentIdentity;
  resource: string;
  holders: ResourceHolder[];
  reason: string;
}): Promise<void> {
  const owners = [
    ...new Set(params.holders.filter((h) => h.mode === 'shared').map((h) => h.owner)),
  ];
  try {
    if (owners.length > 0) {
      await sendMessage(params.source, {
        to: owners,
        summary: `🔒 "${params.resource}" is draining for an exclusive hold by ${params.source.ownerLabel} — release when your current use is done`,
        body: `${params.source.ownerLabel} needs exclusive access to "${params.resource}"${
          params.reason ? ` (${params.reason})` : ''
        }. Finish your current use and call locks:release_resource — do NOT start new work needing it. You'll be notified when it's back up.`,
        // Already-automated lifecycle (coord-lifecycle-automation D-003 restart/resource):
        // mark it so the categorizer credits it + coord:inbox treats it as signal.
        extra: { auto: true, lifecycle: 'restart-resource' },
        // EI-386: ambient-classify the templated system prose (a synthetic
        // one-shot `drain-X-<ts>-N` sender re-emits this verbatim per drain) so
        // coord:inbox / coalescing / any other category-aware prose consumer can
        // recognize + fold it instead of reinventing text-pattern dedup (the
        // neologism miner's digit-normalized dedup workaround). Still targeted
        // (never `to: ['*']`), so it stays VISIBLE to the holder who must act —
        // isAmbientBroadcast's broadcast-only guard is unaffected.
        category: 'resource-locks',
      });
    }
  } catch {
    // best-effort — a broadcast failure must never break the acquire/drain.
  }
}

export async function broadcastResourceBackUp(params: {
  source: AgentIdentity;
  resource: string;
  /** Owner ids who were waiting on this resource (A4) — the targeted audience.
   *  Empty → nobody was refused while it was held, so we send nothing (no more
   *  ['*'] firehose to every agent for a resource only a few ever wanted). */
  waiters: string[];
}): Promise<void> {
  // Refused callers such as git-sync:run do not enter the waiter table, so the
  // targeted coord message alone cannot wake them. Emit an exact-key event at
  // the real release boundary; the resource suffix keeps it targeted.
  emitResourceReleasedEvent(params.resource, params.source.workspaceId);
  if (!params.waiters || params.waiters.length === 0) return;
  try {
    await sendMessage(params.source, {
      to: params.waiters,
      summary: `✅ "${params.resource}" is back up (released by ${params.source.ownerLabel})`,
      body: `${params.source.ownerLabel} finished its exclusive hold on "${params.resource}". You were waiting on it — acquire it again with locks:acquire_resource.`,
      // Already-automated lifecycle (coord-lifecycle-automation D-003 restart/resource).
      extra: { auto: true, lifecycle: 'restart-resource' },
      // EI-386: same ambient classification as the drain-start notice above.
      category: 'resource-locks',
    });
  } catch {
    // best-effort
  }
}
