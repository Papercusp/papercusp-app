/**
 * Judge running-changelog (P-017) — the augmentation half of the loop's safety net.
 *
 * Each cycle appends an entry anchored to HARD numbers (dev-anchor Δ, cost Δ, probe
 * status) plus a short narrative. Fed into the proposer + judge context so the search
 * avoids dead-ends and oscillation is detectable. Pure formatting; the arithmetic
 * circuit-breaker (P-021) is the real safety net.
 */

export interface ChangelogEntry {
  cycle: number;
  decision: 'accept' | 'reject';
  /** Candidate dev-anchor aggregate minus the champion's (signed). */
  devAnchorDelta: number;
  /** Candidate mean cost minus baseline (signed). */
  costDelta: number;
  /** Were all planted bugs caught this cycle? */
  probeCaught: boolean;
  /** Short human-readable note on what changed and why. */
  narrative: string;
}

function signed(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;
}

export function formatChangelogEntry(e: ChangelogEntry): string {
  const probe = e.probeCaught ? 'caught' : 'MISSED';
  return `cycle ${e.cycle}: ${e.decision} — dev-anchor Δ ${signed(e.devAnchorDelta)}, cost Δ ${signed(e.costDelta)}, probe ${probe} — ${e.narrative}`;
}

export function appendChangelog(changelog: string, e: ChangelogEntry): string {
  const line = formatChangelogEntry(e);
  return changelog ? `${changelog}\n${line}` : line;
}
