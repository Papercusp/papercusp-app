/**
 * P-004 / R-4 (feature-drain-delivery-readiness-and-outcome-accounting-2026-10-01):
 * stalled-item rotation through the EXISTING fleet controls.
 *
 * The 0930 feature-drain incident: live, busy workers stayed on week-old items for hours
 * while closeable items waited in the fleet's own claim set. Every existing leader-brief
 * signal read those workers as healthy, because every one of them keys on WORKER activity
 * (tool-call recency, productive calls, loop state). A worker can be very active while the
 * item it holds does not move at all — status reads, orient calls and get_next probes are
 * activity, not advancement.
 *
 * This module therefore measures the ITEM, not the worker. The material-advancement anchor
 * is `max(claim acquired, last_progress_at)`:
 *   - `last_progress_at` is written only by a checkpoint write or a state transition on the
 *     held row (work-item-checkpoint.ts bumpCheckpointProgressAnchor, work-items.ts
 *     markFeatureProgress / transition UPDATEs), never by a heartbeat, a lease keepalive or
 *     any read — so a status read can never reset this clock;
 *   - it is reset to NULL whenever a NEW holder claims the row, so the claim time is the
 *     floor for a fresh holder;
 *   - a checkpoint the claim-health writer classifies as `mechanical` (a system-written
 *     recovery note) is NOT authored progress, so its bump is ignored.
 *
 * Exemptions (the requirement's falsifier names both): a PAUSED fleet (an idle or quiet
 * member is the compliant response to a stand-down) and an INSTRUMENTED LONG TEST (the
 * member is inside a test/exec call the in-flight registry can see, so the item may be
 * advancing in a way no settled row has recorded yet). An item already in a blocked /
 * needs-human state has had its accountable action taken (a real blocker is recorded), so
 * it is not named either.
 *
 * Naming requires READY work to rotate to: the fleet's live authoritative claimable count
 * (the same `claimableCount` the idle-with-claimable branch reads) must be > 0. Unknown
 * (`null`) never names anyone — it is not evidence that ready items wait.
 *
 * Pure: no I/O. The leader brief threads the inputs it already reads.
 */
import type { ClaimHealth } from '../../fleet/assignments';

/** D-007 (R-4): 30 minutes without material advancement. */
export const STALLED_ITEM_ROTATION_THRESHOLD_MS = 30 * 60_000;

/** The one accountable action the leader requires — any ONE of these four. */
export const STALLED_ITEM_REQUIRED_ACTION =
  'require ONE accountable action: finish it (work_items:complete), split it ' +
  '(work_items:create the remainder + link it), record a real blocker (work_items:set_blocker, ' +
  'or a blocks edge to the prerequisite item), or release it (work_items:release) and take the ' +
  'ready item via scheduler:get_next. Direct it with coord:send { expects:"action", ' +
  'expectEffect:{ kind:"checkpoint", itemId } } so the choice is recorded on the item.';

/** Tool names whose in-flight call counts as an instrumented long test/exec. */
export function isInstrumentedLongTestTool(tool: string | null | undefined): boolean {
  if (!tool) return false;
  const t = tool.trim();
  return t.startsWith('testing:') || t === 'capability:bash' || t === 'build:typecheck' || t === 'release:checkpoint-run';
}

export interface StalledItemClaimInput {
  type: string;
  id: string | null;
  status?: string | null;
  detail?: string | null;
  acquiredTs: string | null;
  lastProgressAt: string | null;
  orphaned?: boolean;
  claimHealth?: Pick<ClaimHealth, 'evidence'> | null;
}

export interface StalledItemMemberInput {
  agentId: string;
  sessionState?: string | null;
  claims: readonly StalledItemClaimInput[];
  longCallInFlight?: { tool: string; ageSec: number } | null;
}

export interface StalledItemRotation {
  item: string;
  itemTitle: string | null;
  /** Whole minutes since the last material advancement of the held item. */
  noAdvanceMin: number;
  /** ISO timestamp of that last material advancement. */
  advancedAt: string;
  /** Which writer supplied the anchor. */
  advanceSignal: 'last_progress_at' | 'claim_acquired_at';
  /** Live claimable count in the fleet claim set when this was computed. */
  readyWaiting: number;
  requiredAction: string;
}

const BLOCKED_STATES = new Set(['blocked', 'needs-human', 'cursed']);
const TERMINAL_STATES = new Set(['done', 'passed', 'resolved', 'closed', 'deprecated', 'dropped']);

function parseMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function isMechanicalCheckpoint(health: StalledItemClaimInput['claimHealth']): boolean {
  return (health?.evidence ?? []).some(
    (e) => e.signal === 'checkpoint_kind' && e.value === 'mechanical',
  );
}

/** Material-advancement anchor for one held claim, or null when it cannot be measured. */
export function materialAdvanceAnchor(
  claim: Pick<StalledItemClaimInput, 'acquiredTs' | 'lastProgressAt' | 'claimHealth'>,
): { atMs: number; signal: StalledItemRotation['advanceSignal'] } | null {
  const acquired = parseMs(claim.acquiredTs);
  const progress = isMechanicalCheckpoint(claim.claimHealth) ? null : parseMs(claim.lastProgressAt);
  if (progress != null && (acquired == null || progress >= acquired)) {
    return { atMs: progress, signal: 'last_progress_at' };
  }
  if (acquired != null) return { atMs: acquired, signal: 'claim_acquired_at' };
  return null;
}

/**
 * Name the stalled held item for one member, or undefined. At most one entry per member:
 * the item with the OLDEST material advancement (the one the rotation most needs).
 */
export function computeStalledItemRotation(
  member: StalledItemMemberInput,
  nowMs: number,
  claimableCount: number | null | undefined,
  fleetPaused: boolean | null | undefined,
  thresholdMs: number = STALLED_ITEM_ROTATION_THRESHOLD_MS,
): StalledItemRotation | undefined {
  if (fleetPaused) return undefined;
  if (claimableCount == null || !(claimableCount > 0)) return undefined;
  if (member.sessionState === 'ended') return undefined;
  if (member.longCallInFlight && isInstrumentedLongTestTool(member.longCallInFlight.tool)) return undefined;

  let worst: StalledItemRotation | undefined;
  let worstAt = Number.POSITIVE_INFINITY;
  for (const claim of member.claims) {
    if (claim.type !== 'work-item' || !claim.id || claim.orphaned) continue;
    const status = (claim.status ?? '').toLowerCase();
    if (BLOCKED_STATES.has(status) || TERMINAL_STATES.has(status)) continue;
    const anchor = materialAdvanceAnchor(claim);
    if (!anchor) continue;
    const ageMs = nowMs - anchor.atMs;
    if (ageMs < thresholdMs) continue;
    if (anchor.atMs < worstAt) {
      worstAt = anchor.atMs;
      worst = {
        item: claim.id,
        itemTitle: claim.detail ? claim.detail.slice(0, 120) : null,
        noAdvanceMin: Math.floor(ageMs / 60_000),
        advancedAt: new Date(anchor.atMs).toISOString(),
        advanceSignal: anchor.signal,
        readyWaiting: claimableCount,
        requiredAction: STALLED_ITEM_REQUIRED_ACTION,
      };
    }
  }
  return worst;
}
