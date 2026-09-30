export const DEFAULT_RELEASE_TRIGGER_FIRE_STALE_MS = 30 * 60 * 1000;

export interface ReleaseTriggerFireStaleSnapshot {
  active: boolean | null;
  lastFiredMs: number | null;
  deployedBehindGreenPin: number | null;
}

export interface ReleaseTriggerFireStaleVerdict {
  stale: boolean;
  reason: string | null;
}

export function evaluateReleaseTriggerFireStale(
  s: ReleaseTriggerFireStaleSnapshot,
  now: number,
  opts: { thresholdMs?: number } = {},
): ReleaseTriggerFireStaleVerdict {
  const thresholdMs = opts.thresholdMs ?? DEFAULT_RELEASE_TRIGGER_FIRE_STALE_MS;
  if (thresholdMs <= 0 || s.active !== true || s.deployedBehindGreenPin == null || s.deployedBehindGreenPin <= 0) {
    return { stale: false, reason: null };
  }
  const ageMs = s.lastFiredMs != null ? now - s.lastFiredMs : Number.POSITIVE_INFINITY;
  if (ageMs <= thresholdMs) return { stale: false, reason: null };
  const mins = Number.isFinite(ageMs) ? Math.round(ageMs / 60_000) : null;
  return {
    stale: true,
    reason:
      'release-trigger is ACTIVE but has not FIRED' +
      (mins != null ? ' in ~' + mins + 'm' : ' (never fired)') +
      ' while ' +
      s.deployedBehindGreenPin +
      ' green commit(s) are deployable but not live — the documented cadence is ' +
      '<=15min, so the scheduler/tick engine appears to have silently stopped driving this routine (a DIFFERENT ' +
      'failure than a PAUSED routine — active is still true). Check schedule:inventory / routines:list for ' +
      "release-trigger's health; release:deploy { op:'trigger', confirm:true } expedites once it's ticking again.",
  };
}
