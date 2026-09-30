/**
 * Battery-aware pause gate for periodic background workers.
 *
 * Step B2 of Tier-3 follow-up arc.
 *
 * Tauri-desktop concern: when the device is on battery and below a
 * threshold, defer expensive periodic sweeps (embed-backfill,
 * potentially others later) so the user isn't paying battery for
 * background work they don't need right now.
 *
 * Sources of truth (checked in order, first that resolves wins):
 *
 *   1. `BATTERY_POLICY_OVERRIDE` env: "force_pause" | "always_run".
 *      Used by tests and admins who want deterministic behavior.
 *
 *   2. `/sys/class/power_supply/BAT[N]/status` (Linux/Tauri-on-Linux).
 *      "Discharging" + `capacity` (read from same dir) below threshold
 *      → pause.
 *
 *   3. macOS / Windows: no native check yet — return `run` (the safer
 *      default; battery-conscious users can set the env override).
 *
 *   4. Server / non-desktop (no /sys/class/power_supply): always run.
 *      Backed servers don't have batteries; AC-powered desktops don't
 *      either.
 *
 * Threshold default: pause when on-battery AND below 30% remaining.
 * Operators can lower the threshold via `BATTERY_POLICY_MIN_PCT` env.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export type BatteryDecision = 'run' | 'pause';

const DEFAULT_MIN_PCT = 30;
const SYS_POWER_DIR = '/sys/class/power_supply';

interface BatteryReading {
  /** "Discharging" | "Charging" | "Full" | "Not charging" | "Unknown" */
  status: string;
  /** 0-100 remaining; null if unreadable. */
  capacity: number | null;
}

/**
 * Read the first battery found under /sys/class/power_supply. Returns
 * null when no battery is present (servers, AC-only desktops).
 */
export function readLinuxBattery(): BatteryReading | null {
  if (!existsSync(SYS_POWER_DIR)) return null;
  let entries: string[] = [];
  try {
    entries = readdirSync(SYS_POWER_DIR);
  } catch {
    return null;
  }
  const batteryDir = entries.find((name) => name.startsWith('BAT'));
  if (!batteryDir) return null;
  const base = join(SYS_POWER_DIR, batteryDir);
  let status = 'Unknown';
  let capacity: number | null = null;
  try {
    status = readFileSync(join(base, 'status'), 'utf8').trim();
  } catch { /* leave default */ }
  try {
    const raw = readFileSync(join(base, 'capacity'), 'utf8').trim();
    const n = Number.parseInt(raw, 10);
    capacity = Number.isFinite(n) ? n : null;
  } catch { /* leave null */ }
  return { status, capacity };
}

export interface BatteryPolicyOpts {
  /** Override the on-battery threshold (default: 30). */
  minPct?: number;
  /** Override the env-read for tests. */
  envOverride?: 'force_pause' | 'always_run' | null;
  /** Provide a reading directly (test seam). When set, OS-probe is skipped. */
  reading?: BatteryReading | null;
}

/**
 * Decide whether a periodic worker should run NOW based on battery
 * state. Returns `'pause'` only when we know the device is on battery
 * AND below the threshold. Unknown / no-battery / AC-power → `'run'`.
 */
export function shouldRun(opts: BatteryPolicyOpts = {}): BatteryDecision {
  const envOverride = opts.envOverride !== undefined
    ? opts.envOverride
    : (process.env.BATTERY_POLICY_OVERRIDE === 'force_pause'
        ? 'force_pause'
        : process.env.BATTERY_POLICY_OVERRIDE === 'always_run'
          ? 'always_run'
          : null);

  if (envOverride === 'force_pause') return 'pause';
  if (envOverride === 'always_run') return 'run';

  const minPct = opts.minPct ?? (
    Number.parseInt(process.env.BATTERY_POLICY_MIN_PCT ?? '', 10) || DEFAULT_MIN_PCT
  );

  const reading = opts.reading !== undefined ? opts.reading : readLinuxBattery();
  if (!reading) return 'run';          // no battery present → run
  if (reading.status !== 'Discharging') return 'run';  // plugged in → run
  if (reading.capacity === null) return 'run';         // unknown level → run (safer default)
  if (reading.capacity < minPct) return 'pause';
  return 'run';
}

/** Telemetry helper for /settings/user/memory diagnostics. */
export function describeBatteryPolicy(): {
  decision: BatteryDecision;
  reading: BatteryReading | null;
  minPct: number;
  envOverride: 'force_pause' | 'always_run' | null;
} {
  const reading = readLinuxBattery();
  const minPct = Number.parseInt(process.env.BATTERY_POLICY_MIN_PCT ?? '', 10) || DEFAULT_MIN_PCT;
  const envOverride = process.env.BATTERY_POLICY_OVERRIDE === 'force_pause'
    ? 'force_pause' as const
    : process.env.BATTERY_POLICY_OVERRIDE === 'always_run'
      ? 'always_run' as const
      : null;
  return {
    decision: shouldRun({ minPct, reading, envOverride }),
    reading,
    minPct,
    envOverride,
  };
}
