/**
 * tick-load-shed.ts — the shared load-shed policy for background ticks.
 *
 * Extracted from periodic-workflows.ts (EI-1622) so the SAME shed rule is used
 * by both the remaining DBOS periodic workflows AND the lightweight in-process
 * periodic checks (in-process-periodic.ts). A heavy background tick sheds a
 * cycle under EITHER acute event-loop pressure (P5-1 — recover the serving
 * loop) OR chronic power-save (P5-3 — battery life).
 *
 * operator-scalability-event-loop-2026-06-16 P5-1/P5-3.
 */
import { loopPressure, type LoopPressure } from '../event-loop-lag-monitor';
import { getResourceProfile } from '../resource-profile';

// P5-1: Layer-2 load-shedding. When the request event loop is under pressure,
// skip cycles of a HEAVY background tick so the serving loop (and routinesTick)
// recover — instead of piling background CPU onto an already-degraded loop (the
// exact failure that crash-looped :3070). Two bands (WI-1084
// bg-host-freeze-eventloop-stall-2026-06-30 P-001):
//
//   CRITICAL (p95 ≥ 600ms) — FULL shed: skip EVERY cycle. The loop is acutely
//     saturated; get all heavy background CPU off it now.
//   ELEVATED (p95 ≥ 120ms) — WIDENED cadence: shed only 1 of every N cycles
//     (deterministic per-tick counter, env PAPERCUSP_LOOP_ELEVATED_SHED_EVERY,
//     default 2). The chronic-elevated regime (130–240ms sustained) was the real
//     failure — a 600ms-only trip meant 0 sheds in 2h despite 115 high-lag windows
//     — but a FULL shed across a sustained band would starve the heavy tick
//     entirely. A fractional shed RELIEVES the added pressure so routinesTick
//     squeezes through while the heavy tick still makes forward progress. This is
//     a MITIGATION; the underlying leak that elevates the loop is a separate item.
//
// Safe to skip a cycle: each heavy tick has an on-demand / next-cycle correctness
// floor. Light ticks (single-query sweeps, the connection-pressure + service-health
// probes) are NOT shed — they're cheap and we want their signal precisely under load.

/** ELEVATED-band shed cadence: shed 1 of every N cycles of a heavy tick while the
 *  loop is elevated (not yet critical). Env PAPERCUSP_LOOP_ELEVATED_SHED_EVERY,
 *  default 2 (shed every other cycle). A value ≤ 1 DISABLES the elevated widening
 *  (heavy ticks then shed only at CRITICAL). Read per-call so it's hot-tunable and
 *  testable (matching the dynamic getResourceProfile() read in shedUnderPowerSave). */
function loopElevatedShedEvery(): number {
  const raw = Number(process.env.PAPERCUSP_LOOP_ELEVATED_SHED_EVERY);
  return Number.isFinite(raw) ? Math.floor(raw) : 2;
}

// Deterministic per-tick cadence cursor for the ELEVATED band (no Math.random) —
// only advances while the loop is elevated, so it counts elevated cycles, not wall time.
const elevatedShedCounters = new Map<string, number>();

export function shedUnderLoopPressure(tickName: string): boolean {
  const pressure = loopPressure();
  if (pressure === 'ok') return false;

  // CRITICAL: full shed every cycle.
  if (pressure === 'critical') {
    console.warn(`[loop-shed] skipped ${tickName} — event loop CRITICAL, full shed (P5-1/WI-1084)`);
    return true;
  }

  // ELEVATED: shed 1 of every `every` cycles (widened cadence). ≤1 ⇒ disabled.
  const every = loopElevatedShedEvery();
  if (every <= 1) return false;
  const n = (elevatedShedCounters.get(tickName) ?? 0) + 1;
  elevatedShedCounters.set(tickName, n);
  if (n % every === 0) {
    console.warn(
      `[loop-shed] skipped ${tickName} — event loop ELEVATED (shed 1/${every}, P5-1/WI-1084)`,
    );
    return true;
  }
  return false;
}

// P5-3: power-aware cadence throttle. On battery the resource profile widens the
// background cadence (backgroundCadenceMultiplier > 1). We approximate the wider
// cadence by SKIPPING (mult-1)/mult of a heavy tick's invocations — a 1-min tick
// at multiplier 3 effectively fires ~every 3 min. Deterministic per-tick counter
// (no Math.random); AC ⇒ multiplier 1 ⇒ never skips.
const powerSaveCounters = new Map<string, number>();
export function shedUnderPowerSave(tickName: string): boolean {
  const mult = getResourceProfile().backgroundCadenceMultiplier;
  if (mult <= 1) return false;
  const n = (powerSaveCounters.get(tickName) ?? 0) + 1;
  powerSaveCounters.set(tickName, n);
  if (n % mult !== 0) {
    console.warn(`[power-save] skipped ${tickName} — on battery (cadence x${mult}, P5-3)`);
    return true;
  }
  return false;
}

// A heavy background tick sheds this cycle under EITHER acute loop pressure (P5-1)
// OR chronic power-save (P5-3).
export function shouldShedHeavyTick(tickName: string): boolean {
  return shedUnderLoopPressure(tickName) || shedUnderPowerSave(tickName);
}

/**
 * The root routinesTick is the lightweight scheduler that lets due work make
 * progress. Do not shed it on event-loop pressure: heavy periodic actions shed
 * through shouldShedHeavyTick(), and routine bodies can self-gate. Shedding the
 * scheduler itself strands every due routine in the exact elevated-loop regime
 * where the heavy tick policy was meant to let it squeeze through (WI-3351).
 */
export function shouldShedSchedulerTickUnderLoopPressure(
  _pressure: LoopPressure = loopPressure(),
): boolean {
  return false;
}
