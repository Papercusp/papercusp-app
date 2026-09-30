/**
 * checkpoint-staleness — RELATIVE checkpoint staleness (EI-15184).
 *
 * A work-item checkpoint is a PULLED snapshot: a reader (especially a fleet
 * leader reconciling a peer's status) sees the checkpoint's content + write
 * time, but has no signal that the ASSIGNEE kept working PAST that checkpoint.
 * On WI-5013 a leader read a peer's last-visible checkpoint (~20:22Z),
 * concluded the peer's shared "MUST-NOT-TOUCH" rig was "intact," and never saw
 * that the peer had stayed genuinely active to ~20:47Z and completed a
 * destructive move-aside the checkpoint never captured — the rig sat degraded
 * 3h+ while the leader's authoritative status said it was fine.
 *
 * This is DISTINCT from ABSOLUTE staleness
 * (turn-end-tracking.isStaleHeldCheckpoint: "checkpoint older than N minutes").
 * ABSOLUTE age says "this snapshot is old"; RELATIVE staleness says "the
 * assignee has DONE THINGS this snapshot cannot reflect" — precisely the signal
 * that would have caught the incident, since a cold agent's last checkpoint can
 * be recent in absolute terms yet already lag its OWN final actions.
 *
 * Warn-only discipline (mirrors isStaleHeldCheckpoint): it can only fire when it
 * can PROVE the gap (both timestamps present); a false positive merely prompts a
 * ground-truth verification a leader should do anyway before a
 * safety/disposition conclusion, whereas the missed warning is what cost 3h. The
 * reason text never asserts a problem — it says "verify."
 */

/** Default lag beyond which a checkpoint is flagged relative-stale. The WI-5013
 *  gap was ~25m; 5m comfortably catches a MATERIAL lag without firing on the
 *  normal "checkpoint, then a couple more tool calls in the same minute"
 *  cadence. */
export const CHECKPOINT_RELATIVE_STALE_LAG_MS = 5 * 60_000;

export interface CheckpointStaleness {
  /** The assignee was genuinely active materially AFTER this checkpoint was
   *  written — the checkpoint cannot reflect that later work. */
  stale: boolean;
  /** ms the assignee's last genuine activity leads the checkpoint write; null
   *  when not computable (a timestamp is missing). Positive = activity after the
   *  checkpoint. */
  lagMs: number | null;
  /** Human-facing warning, present only when `stale` — never asserts a problem,
   *  points the reader at ground-truth verification. */
  reason?: string;
}

/**
 * PURE (no I/O) so it unit-tests without PG/DI ceremony. Compare a checkpoint's
 * write time against the assignee's last GENUINE-activity time (presence
 * `lastActiveAt`): a material positive lag means the assignee kept working past
 * the checkpoint, so a reader must not trust the checkpoint for a
 * safety/disposition conclusion.
 */
export function computeCheckpointStaleness(input: {
  checkpointUpdatedAtMs: number | null | undefined;
  /** Presence `lastActiveAt` of the item's assignee, in epoch ms. */
  assigneeActiveAtMs: number | null | undefined;
  lagThresholdMs?: number;
}): CheckpointStaleness {
  const threshold = input.lagThresholdMs ?? CHECKPOINT_RELATIVE_STALE_LAG_MS;
  const cp = input.checkpointUpdatedAtMs;
  const act = input.assigneeActiveAtMs;
  // Warn-only: without BOTH timestamps the gap is unprovable — stay silent
  // rather than guess (a wrong "stale" is worse than a missed nudge).
  if (cp == null || act == null || !Number.isFinite(cp) || !Number.isFinite(act)) {
    return { stale: false, lagMs: null };
  }
  const lagMs = act - cp;
  if (lagMs > threshold) {
    const lagMin = Math.max(1, Math.round(lagMs / 60_000));
    return {
      stale: true,
      lagMs,
      reason:
        `assignee was genuinely active ~${lagMin}m AFTER this checkpoint was written — it kept ` +
        `working past this snapshot, so the checkpoint may not reflect its latest state. Do NOT ` +
        `conclude safety/disposition (especially for a destructive or shared-resource op) from ` +
        `the checkpoint alone; verify ground truth directly or wait for the assignee's own ` +
        `confirmation.`,
    };
  }
  return { stale: false, lagMs };
}
