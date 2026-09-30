/**
 * P-005: read projection, not a second progress store. Reuse carry's exact
 * held-item/checkpoint reader and ownership proof. The roster only selects
 * candidates; it cannot authorize historical first-person checkpoint prose.
 */
import { assessHeldItemOwnership, readHeldWorkItems, type CarryBriefHeldItem } from '../../carry-brief';
import { shortCarryHash, splitCarryNoteChecks, splitCarryNoteWalls } from '../../carry-note';
import { withBoundedTimeout } from '../../bounded-timeout';
import type { AgentAssignment } from '../../fleet/assignments';
import { computeCheckpointStaleness } from '../../checkpoint-staleness';
import { getWorkItemCheckpointFreshness } from '../../work-item-checkpoint';
import type { FreshnessVerdict } from '../../freshness';

export const LEADER_PROGRESS_MEMBER_LIMIT = 3;
export const LEADER_PROGRESS_ITEM_LIMIT = 3;
export const LEADER_PROGRESS_TEXT_LIMIT = 900;

export interface LeaderCheckpointItem {
  id: string;
  harness: string | null;
  holderProof: CarryBriefHeldItem['holderProof'];
  status: 'stored' | 'empty' | 'unknown';
  checkpoint: string | null;
  checkpointUpdatedAtMs: number | null;
  lastProgressAtMs: number | null;
  checkpointContentHash: string | null;
  checkpointTruncated: boolean;
  checkpointChars: number | null;
  checks: number | null;
  walls: number | null;
  freshness: {
    basis: 'declared' | 'relative-activity' | 'unknown';
    verdict?: FreshnessVerdict;
    declared?: number;
    changed?: number;
    unresolvable?: number;
    stale?: boolean;
    lagMs?: number | null;
    reason?: string;
  };
  recovery: { tool: 'work_items:get'; args: { id: string; harness?: string } };
}

export interface LeaderCheckpointProgress {
  status: 'read' | 'unknown' | 'omitted';
  source: 'work_items:checkpoint';
  snapshotOnly: true;
  readAtMs: number;
  /** Count from THIS roster, not a census of the current ledger. */
  rosterItems: number;
  items: LeaderCheckpointItem[];
  omitted: number;
  note: string;
}

const SNAPSHOT_NOTE =
  'Derived checkpoint snapshot, not an acceptance verdict. Check full item freshness, ' +
  'later work and retractions before acting; omitted checks/walls remain binding.';

function projectItem(item: CarryBriefHeldItem): LeaderCheckpointItem {
  const failed = item.checkpointReadFailed === true;
  const note = failed ? null : item.checkpoint;
  return {
    id: item.id, harness: item.harness, holderProof: item.holderProof,
    status: failed ? 'unknown' : note === null ? 'empty' : 'stored',
    checkpoint: note?.slice(0, LEADER_PROGRESS_TEXT_LIMIT) ?? null,
    checkpointUpdatedAtMs: failed ? null : item.checkpointUpdatedAtMs ?? null,
    lastProgressAtMs: item.lastProgressAtMs ?? null,
    checkpointContentHash: note === null ? null : shortCarryHash(note),
    checkpointTruncated: (note?.length ?? 0) > LEADER_PROGRESS_TEXT_LIMIT,
    checkpointChars: failed ? null : note?.length ?? 0,
    checks: failed ? null : splitCarryNoteChecks(note ?? '').checks.length,
    walls: failed ? null : splitCarryNoteWalls(note ?? '').walls.length,
    freshness: { basis: 'unknown' },
    recovery: {
      tool: 'work_items:get',
      args: { id: item.id, ...(item.harness ? { harness: item.harness } : {}) },
    },
  };
}

/** Bounded owner/item reads; late timeout results never mutate a returned view. */
export async function readLeaderCheckpointProgress(
  members: readonly (Pick<AgentAssignment, 'agentId' | 'claims'> & { lastActiveAt?: string | null })[],
  workspaceId: string,
  opts: {
    readHeldItems?: typeof readHeldWorkItems;
    readFreshness?: typeof getWorkItemCheckpointFreshness;
    timeoutMs?: number;
    nowMs?: number;
  } = {},
): Promise<Map<string, LeaderCheckpointProgress>> {
  const reader = opts.readHeldItems ?? readHeldWorkItems;
  const readAtMs = opts.nowMs ?? Date.now();
  const candidates = members.flatMap((member) => {
    const claims = member.claims.filter((claim) => claim.type === 'work-item' && claim.active && claim.id);
    return claims.length ? [{ member, claims }] : [];
  });
  const result = new Map<string, LeaderCheckpointProgress>();
  for (const { member, claims } of candidates) {
    result.set(member.agentId, {
      status: 'omitted', source: 'work_items:checkpoint', snapshotOnly: true,
      readAtMs, rosterItems: claims.length, items: [], omitted: claims.length,
      note: `Member read budget: use work_items:get for this member's workItemIds. ${SNAPSHOT_NOTE}`,
    });
  }
  // No silently selected default partition when the caller's scope is missing.
  if (!workspaceId.trim() || workspaceId === '*') {
    for (const progress of result.values()) {
      progress.status = 'unknown';
      progress.note = `Concrete workspace unavailable. ${SNAPSHOT_NOTE}`;
    }
    return result;
  }
  await Promise.all(candidates.slice(0, LEADER_PROGRESS_MEMBER_LIMIT).map(async ({ member, claims }) => {
    const read = await withBoundedTimeout<CarryBriefHeldItem[] | null>(
      async () => reader(member.agentId, workspaceId, { limit: LEADER_PROGRESS_ITEM_LIMIT }),
      { timeoutMs: opts.timeoutMs ?? 750, fallback: null, label: 'leader-checkpoint-progress' },
    );
    const progress = result.get(member.agentId)!;
    if (read.degraded || read.value === null) {
      progress.status = 'unknown';
      progress.note = `Held-item read unavailable (${read.reason ?? 'unknown'}). ${SNAPSHOT_NOTE}`;
      return;
    }
    const selected = read.value.slice(0, LEADER_PROGRESS_ITEM_LIMIT).filter((item) =>
      assessHeldItemOwnership(member.agentId, workspaceId, item).verified &&
      claims.some((claim) => claim.id === item.id && claim.harnessSlug === item.harness),
    );
    progress.items = await Promise.all(selected.map(async (item) => {
      const projected = projectItem(item);
      if (!item.checkpoint || item.checkpointReadFailed) return projected;
      const freshness = await withBoundedTimeout(
        () => (opts.readFreshness ?? getWorkItemCheckpointFreshness)({
          harness: item.harness, workItemId: item.id, workspaceId,
        }),
        { timeoutMs: opts.timeoutMs ?? 750, fallback: undefined, label: 'leader-checkpoint-freshness' },
      );
      if (freshness.degraded) {
        projected.freshness.reason = 'Freshness read unavailable; recover the full item before acting.';
      } else if (freshness.value !== undefined) {
        // Match work_items:get: a declared dependency verdict takes precedence
        // over activity heuristics. Counts retain unresolved dependencies even
        // when the canonical warn-only verdict calls the resolved subset fresh.
        const value = freshness.value;
        projected.freshness = {
          basis: 'declared', verdict: value.verdict, declared: value.declared,
          changed: value.changed.length, unresolvable: value.unresolvable.length,
          reason: value.reason,
        };
      } else {
        const stale = computeCheckpointStaleness({
          checkpointUpdatedAtMs: item.checkpointUpdatedAtMs,
          // Genuine presence activity, never heartbeat or item progress time.
          assigneeActiveAtMs: member.lastActiveAt ? Date.parse(member.lastActiveAt) : null,
        });
        projected.freshness = stale.lagMs === null
          ? { basis: 'unknown' }
          : { basis: 'relative-activity', ...stale };
      }
      return projected;
    }));
    progress.omitted = Math.max(0, claims.length - selected.length);
    progress.status = selected.some((item) => item.checkpointReadFailed) || progress.omitted > 0
      ? 'unknown' : 'read';
    progress.note = progress.omitted
      ? `Roster/ledger mismatch or item read budget; omitted candidates are unverified. ${SNAPSHOT_NOTE}`
      : SNAPSHOT_NOTE;
  }));
  return result;
}
