/**
 * P-013 (plan gate-file-level-test-reuse-2026-09-27): where one green-checkpoint round spent its
 * wall-clock time. The gate already stamps its selection→suite phases (`setup-stretch-stamps.ts`
 * in apps/operator: migration preflight, setup-tree, tree-drift, early typecheck); the round adds
 * the candidate suite, and everything the stamps do not cover (post-suite re-runs, salvage,
 * promotion, recording) is reported as `other` so the parts always add up to the round total.
 *
 * Lives in operator-core because both the producer (green-checkpoint) and the recorder
 * (release-actions → gate_health.roundPhases + the append-only pipeline event) need the one shape.
 * Pure: no clock, no I/O.
 */

import { formatDurationMs } from './test-pass-reuse-report';

export interface GateRoundPhase {
  phase: string;
  ms: number;
}

export interface GateRoundPhases {
  totalMs: number;
  /** Stamped phases in the order they ran, then `other` when anything is unattributed. */
  phases: GateRoundPhase[];
  /** One line for logs and /admin/git: `total 52m: candidate-suite 40m (77%), …`. */
  breakdown: string;
}

export const GATE_ROUND_OTHER_PHASE = 'other';
/** Storage cap. A round stamps well under this; the cap only bounds a runaway writer. */
export const GATE_ROUND_PHASES_MAX = 16;
const PHASE_NAME_MAX_CHARS = 80;

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/**
 * Build the round breakdown from stamped phases and the round's measured total. Returns null
 * when the total is not a positive duration: a breakdown of an unmeasured round would present
 * invented shares as a measurement.
 */
export function buildGateRoundPhases(
  stamps: readonly { phase: string; ms: number }[],
  totalMs: number,
): GateRoundPhases | null {
  if (!Number.isFinite(totalMs) || totalMs <= 0) return null;
  const total = Math.round(totalMs);
  const phases: GateRoundPhase[] = [];
  let stampedMs = 0;
  for (const s of stamps.slice(0, GATE_ROUND_PHASES_MAX - 1)) {
    const ms = Number.isFinite(s.ms) && s.ms > 0 ? Math.round(s.ms) : 0;
    phases.push({ phase: s.phase.slice(0, PHASE_NAME_MAX_CHARS), ms });
    stampedMs += ms;
  }
  // Stamps can overlap the total by clock skew or nesting; `other` is never negative, and a
  // stamped sum past the total is reported as-is rather than silently rescaled.
  const otherMs = Math.max(0, total - stampedMs);
  if (otherMs > 0) phases.push({ phase: GATE_ROUND_OTHER_PHASE, ms: otherMs });
  const share = (ms: number) => `${Math.round((ms / total) * 100)}%`;
  const breakdown =
    `total ${formatDurationMs(total)}: ` +
    (phases.length === 0
      ? 'no phases stamped'
      : phases.map((p) => `${p.phase} ${formatDurationMs(p.ms)} (${share(p.ms)})`).join(', '));
  return { totalMs: total, phases, breakdown };
}

/** Read-side shape check for a persisted breakdown (gate_health.roundPhases or an event detail).
 *  Never a cast: anything malformed reads as "not measured". */
export function parseGateRoundPhases(value: unknown): GateRoundPhases | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!isCount(v.totalMs) || v.totalMs === 0) return null;
  if (typeof v.breakdown !== 'string' || v.breakdown.length === 0) return null;
  if (!Array.isArray(v.phases) || v.phases.length > GATE_ROUND_PHASES_MAX) return null;
  const phases: GateRoundPhase[] = [];
  for (const p of v.phases) {
    if (!p || typeof p !== 'object') return null;
    const { phase, ms } = p as Record<string, unknown>;
    if (typeof phase !== 'string' || phase.length === 0 || !isCount(ms)) return null;
    phases.push({ phase, ms });
  }
  return { totalMs: v.totalMs, phases, breakdown: v.breakdown };
}
