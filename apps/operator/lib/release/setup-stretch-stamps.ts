/**
 * P-005 (plan gate-latency-selection-and-retry-policy-2026-09-06): per-phase stamps for the
 * candidate-selection→suite stretch of a green-checkpoint run.
 *
 * WI-7069 gave the gate ONE number for that stretch — `candidate-age: selected X Nm ago` — and a
 * warning when it exceeds CANDIDATE_SELECTION_TO_SUITE_WARN_MS. The number says the tree is
 * stale; it cannot say WHICH step made it stale, and the warning's fixed text ("suspect
 * setupTree's setup-release-checkout.sh") was written when that script was the only unbounded
 * call. The stretch now also holds the migration preflights, the tree-drift preflight and the
 * early changed-file typecheck (measured 63.7s on run cc857324), so a reader chasing a 25-minute
 * gap still had to reconstruct the phase timings from log line timestamps by hand.
 *
 * This module is the pure half: a recorder the run stamps as each phase completes, and a
 * formatter that renders the breakdown and names the DOMINANT phase. It has no side effects and
 * no opinion about what to do — the gate stays diagnostic-only here, exactly as WI-7069 was.
 */

export interface SetupStretchStamp {
  /** Stable phase name, e.g. `setup-tree`, `migration-preflight:post-materialization-backstop`. */
  phase: string;
  /** Wall-clock duration of that phase. */
  ms: number;
}

export interface SetupStretchStamps {
  /** Record a phase that started at `startedAtMs` and has just finished. */
  stamp(phase: string, startedAtMs: number): void;
  /** The stamps recorded so far, in completion order. */
  readonly stamps: readonly SetupStretchStamp[];
}

export function createSetupStretchStamps(
  now: () => number = () => Date.now(),
): SetupStretchStamps {
  const stamps: SetupStretchStamp[] = [];
  return {
    stamp(phase, startedAtMs) {
      const ms = now() - startedAtMs;
      stamps.push({ phase, ms: Number.isFinite(ms) && ms > 0 ? ms : 0 });
    },
    get stamps() {
      return stamps;
    },
  };
}

/** `48s`, `14m12s`, `2h05m` — compact enough to sit inside one log line. */
export function formatStretchDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (totalMin < 60) return sec === 0 ? `${totalMin}m` : `${totalMin}m${String(sec).padStart(2, "0")}s`;
  const hours = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return `${hours}h${String(min).padStart(2, "0")}m`;
}

export interface SetupStretchPhaseShare {
  phase: string;
  ms: number;
  /** Fraction of the whole stretch (0–1); 0 when the stretch itself is zero-length. */
  share: number;
}

export interface SetupStretchSummary {
  /** The single phase that took longest — `other` when the unstamped remainder wins. */
  dominant: SetupStretchPhaseShare | null;
  /** Time in the stretch that no stamp accounts for (never negative). */
  otherMs: number;
  /** Every phase (plus `other`), longest first. */
  phases: SetupStretchPhaseShare[];
  /** One log fragment: `phases: setup-tree 14m12s (71%), …, other 2m (10%)`. */
  breakdown: string;
}

/** The name given to the unstamped remainder of the stretch. */
export const SETUP_STRETCH_OTHER_PHASE = "other";

/**
 * Attribute a stretch of `totalMs` to its stamped phases.
 *
 * Phases are reported longest-first so the dominant one is also the first one a reader sees.
 * The remainder (`other`) competes for dominance on equal terms: when the biggest cost sits in
 * a step nobody stamped, the honest answer is "somewhere unstamped", not the largest stamped
 * phase — the failure mode this exists to end is a warning that names the wrong culprit.
 */
export function summarizeSetupStretch(
  stamps: readonly SetupStretchStamp[],
  totalMs: number,
): SetupStretchSummary {
  const total = Number.isFinite(totalMs) && totalMs > 0 ? totalMs : 0;
  const shareOf = (ms: number) => (total > 0 ? ms / total : 0);
  const stamped = stamps
    .filter((s) => Number.isFinite(s.ms) && s.ms >= 0)
    .map((s) => ({ phase: s.phase, ms: s.ms, share: shareOf(s.ms) }));
  const stampedMs = stamped.reduce((sum, s) => sum + s.ms, 0);
  const otherMs = Math.max(0, total - stampedMs);
  const phases: SetupStretchPhaseShare[] = [...stamped];
  if (otherMs > 0) {
    phases.push({ phase: SETUP_STRETCH_OTHER_PHASE, ms: otherMs, share: shareOf(otherMs) });
  }
  phases.sort((a, b) => b.ms - a.ms);
  const dominant = phases.length > 0 && phases[0].ms > 0 ? phases[0] : null;
  const breakdown =
    phases.length === 0
      ? "phases: none stamped"
      : `phases: ${phases
          .map((p) => `${p.phase} ${formatStretchDuration(p.ms)} (${Math.round(p.share * 100)}%)`)
          .join(", ")}`;
  return { dominant, otherMs, phases, breakdown };
}

/**
 * The clause the WI-7069 warning appends when the stretch exceeds its budget: WHICH phase to
 * suspect, with its share, so the fixed "suspect setupTree" guess is replaced by a measurement.
 */
export function formatDominantPhaseClause(summary: SetupStretchSummary, totalMs: number): string {
  if (!summary.dominant) return "dominant phase: unknown (nothing stamped)";
  const { phase, ms, share } = summary.dominant;
  const suspect =
    phase === SETUP_STRETCH_OTHER_PHASE
      ? "an UNSTAMPED step — the stamped phases do not account for the gap"
      : phase;
  return (
    `dominant phase: ${suspect} (${formatStretchDuration(ms)}, ${Math.round(share * 100)}% of the ` +
    `${formatStretchDuration(totalMs)} stretch)`
  );
}

/** One log line per sub-phase inside a stamped phase (setupTree's own steps). */
export function formatSetupSubPhaseLine(parent: string, phase: string, ms: number, note?: string): string {
  return `${parent} phase: ${phase} ${formatStretchDuration(ms)}${note ? ` (${note})` : ""}`;
}
