/**
 * connection-pressure-governor.ts — C5-1 (backend-connection-scaling-2026-06-17).
 *
 * Closes the loop on PG connection saturation — the sibling of the event-loop-lag
 * loop-pressure governor (P5-2, loop-pressure-governor.ts). The 30s
 * connection-pressure tick (dbos/in-process-periodic.ts) already reads
 * pgHealth().saturationPct; until C5-1 it only WARNED past 85%. This turns that
 * signal into the SAME AIMD concurrency feedback the loop governor uses: a
 * transition INTO `critical` saturation applies one multiplicative-decrease (shed
 * effective agent concurrency toward the floor); recovery to `ok` records a clean
 * step so the existing AIMD ramp (+1 per N) walks concurrency back up.
 *
 * Defense-in-depth: with PgBouncer on (default for server-class) PG backends are
 * bounded and saturation rarely climbs, so this almost never fires. But if the
 * pooler is killed (PAPERCUSP_PGBOUNCER=0), bypassed, or a connection storm hits,
 * the governor sheds load BEFORE PG returns "too many clients" — the exact
 * exhaustion this plan exists to prevent. Bounded + self-recovering by
 * construction (mirrors the loop governor): it only narrows effective concurrency
 * UNDER the user's cap, never below the floor, ramps back automatically, and the
 * AIMD penalty is a no-op while no finite cap is installed.
 *
 * Two guards against flapping / concurrency-cratering:
 *   - HYSTERESIS: shed at/above {@link CONN_SHED_PCT}, recover at/below
 *     {@link CONN_RECOVER_PCT}; the gap between is `elevated` — hold the current
 *     state, no transition.
 *   - TRANSITION-DEBOUNCE: penalize ONCE per critical episode (not every 30s tick
 *     a sustained-critical loop would otherwise crater eff to the floor), clean
 *     ONCE on recovery.
 *
 * Gated by the CONNECTION_PRESSURE_GOVERNOR flag (default ON) — the operator's
 * kill-switch back to signal-only behavior (the caller reads the flag).
 */
import {
  recordGlobalConcurrencyPenalty,
  recordGlobalConcurrencyClean,
} from '@papercusp/papercusp-shared/agent';

export type ConnectionPressure = 'ok' | 'elevated' | 'critical';

/** Shed at/above this server-wide PG saturation %. */
export const CONN_SHED_PCT = 90;
/** Consider recovered at/below this % — the hysteresis gap (75–90) avoids flapping. */
export const CONN_RECOVER_PCT = 75;

/**
 * Map a server-wide saturation % to a pressure band with hysteresis. Between the
 * recover and shed thresholds is `elevated` — no transition; the governor holds
 * whatever decisive band it was last in. PURE (unit-testable without a database).
 */
export function connectionPressureBand(saturationPct: number): ConnectionPressure {
  if (saturationPct >= CONN_SHED_PCT) return 'critical';
  if (saturationPct <= CONN_RECOVER_PCT) return 'ok';
  return 'elevated';
}

export interface ConnectionPressureGovernorOpts {
  /** AIMD multiplicative-decrease. Defaults to the global governor seam; injected in tests. */
  onPenalty?: () => void;
  /** AIMD clean-step. Defaults to the global governor seam; injected in tests. */
  onClean?: () => void;
  /** Structured log sink. Default console.warn. */
  log?: (line: string) => void;
}

export interface ConnectionPressureGovernor {
  /** Feed the latest server-wide saturation %; applies debounced AIMD on transition. */
  observe(saturationPct: number): void;
}

/**
 * A connection-pressure governor holding the transition-debounce state in a
 * closure (no module global — one instance per process, created by the caller).
 * `elevated` observations never move the decisive band, so a saturation hovering
 * in the hysteresis gap never flaps the AIMD state. Mirrors the loop governor's
 * semantics exactly so both local-saturation sources behave identically.
 */
export function createConnectionPressureGovernor(
  opts: ConnectionPressureGovernorOpts = {},
): ConnectionPressureGovernor {
  const onPenalty = opts.onPenalty ?? recordGlobalConcurrencyPenalty;
  const onClean = opts.onClean ?? recordGlobalConcurrencyClean;
  const log = opts.log ?? ((m) => console.warn(m));
  // The last DECISIVE band (ok|critical). `elevated` never updates it — that is the
  // hysteresis hold. Starts 'ok' so the first observation can only shed on a real
  // climb into critical, never a spurious clean-step.
  let last: 'ok' | 'critical' = 'ok';

  return {
    observe(saturationPct: number): void {
      const band = connectionPressureBand(saturationPct);
      if (band === 'critical' && last !== 'critical') {
        onPenalty();
        log(
          `[conn-governor] PG saturation ${saturationPct}% ≥ ${CONN_SHED_PCT}% — ` +
            `shedding effective agent concurrency (C5-1)`,
        );
        last = 'critical';
      } else if (band === 'ok' && last !== 'ok') {
        onClean();
        log(
          `[conn-governor] PG saturation recovered to ${saturationPct}% ≤ ${CONN_RECOVER_PCT}% — ` +
            `ramping effective agent concurrency back up (C5-1)`,
        );
        last = 'ok';
      }
      // band === 'elevated' (hysteresis gap) or a same-band repeat → hold, no-op.
    },
  };
}
