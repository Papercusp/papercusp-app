/**
 * Circuit-breaker + alarms (P-021) — the loop's real safety net.
 *
 * The arithmetic circuit-breaker (D-006/D-012) tracks the dedicated gym harness's
 * dev-anchor aggregate (a FROZEN set ⇒ a valid absolute comparison over time) vs the
 * baseline-of-record; on drift below threshold it auto-reverts the harness's overrides
 * to last-known-good (a cheap config rewrite). The monitor alarm flags overfitting-to-
 * anchor (dev-anchor climbs while the fresh monitor set stalls). The proxy alarm flags
 * the gym score rising while the real-anchor stays flat (D-014). Pure predicates; the
 * revert/flag actions are wired in the loop driver (P-022).
 */

/** Trip iff the current dev-anchor aggregate has drifted below baseline − threshold. */
export function circuitBreakerTripped(
  currentDevAnchorAgg: number,
  baselineOfRecord: number,
  dropThreshold: number,
): boolean {
  return currentDevAnchorAgg < baselineOfRecord - dropThreshold;
}

/**
 * Overfitting-to-anchor alarm: the dev-anchor is climbing while the fresh monitor set
 * stalls — i.e. the two diverge by at least `minDivergence`.
 */
export function overfittingAlarm(devAnchorDelta: number, monitorDelta: number, minDivergence: number): boolean {
  return devAnchorDelta > 0 && devAnchorDelta - monitorDelta >= minDivergence;
}

/**
 * Proxy alarm (D-014): the gym score is rising while the real-anchor doesn't move —
 * the loop may be optimizing an Opus-judged proxy rather than real-feature success.
 */
export function proxyAlarm(gymScoreDelta: number, realAnchorDelta: number, minDivergence: number): boolean {
  return gymScoreDelta > 0 && gymScoreDelta - realAnchorDelta >= minDivergence;
}
