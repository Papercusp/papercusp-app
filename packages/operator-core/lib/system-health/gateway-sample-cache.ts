/**
 * Stateful glue around the PURE `gateway-wedge` detector (B-GW-5). A confirmed wedge needs the
 * TEMPORAL signature — `totalRequests` frozen WHILE saturated for a sustained interval — but the
 * system-health aggregator is a stateless per-tick recompute. This module holds the minimal rolling
 * state across the periodic health ticks (the ~30s-2min tick / liveness-alarm loop) so the tokens
 * panel can surface a confirmed wedge without re-implementing the watchdog's freeze logic.
 *
 * It tracks a freeze ANCHOR — the reading at which the current saturated-freeze BEGAN — held stable
 * (it does NOT advance) while the freeze persists, so the detector's `minFreezeMs` gate measures the
 * TRUE freeze duration regardless of tick cadence. The anchor clears the moment `totalRequests`
 * advances or the gateway un-saturates (recovery). This mirrors the standalone watchdog's
 * `frozenSince` model; the watchdog still owns the real-time freeze→restart, this owns visibility.
 *
 * The only mutable state is one prior + one anchor per operator worker — a metric cache, not durable
 * state (the gateway is a separate process; an operator restart simply re-baselines).
 */
import {
  detectGatewayWedge,
  sampleGateway,
  type GatewayMetrics,
  type GatewaySample,
  type GatewayWedgeVerdict,
} from '../inference-gateway/gateway-wedge';

/** A saturated freeze must PERSIST at least this long to count as a wedge (the standalone watchdog
 *  restarts at 120s; the dashboard surfaces it a touch earlier so a human/overwatch sees it before
 *  — or as — the watchdog acts). Below this the panel still shows `saturated` (a warn). */
export const WEDGE_MIN_FREEZE_MS = 60_000;

/** WI-3565 (2026-07-09 admission-starvation incident, durable fix part b): a deep-backlog-vs-ceiling
 *  reading must PERSIST this long before it is treated as a confirmed starvation alert (a brief queue
 *  bump is normal churn; 24 queued at maxConcurrent=2 sat undetected for ~50min before this existed). */
export const ADMISSION_STARVATION_MIN_PERSIST_MS = 5 * 60_000;

let prior: GatewaySample | undefined; // the immediately-previous reading
let freezeAnchor: GatewaySample | undefined; // the reading at which the current freeze began
let starvationSince: number | undefined; // epoch ms the CURRENT unbroken starvation-risk streak began

/**
 * Run the wedge/throttle detector against `metrics`, maintaining the rolling prior + freeze anchor,
 * and return the verdict (with `wedge` true only once the saturated freeze has persisted
 * `WEDGE_MIN_FREEZE_MS`, and `admissionStarvationRisk` promoted to a CONFIRMED alert only once it
 * has persisted `ADMISSION_STARVATION_MIN_PERSIST_MS` continuously). `saturated` + `sustainedThrottle`
 * are instantaneous (no history needed).
 */
export function readGatewayWedge(metrics: GatewayMetrics, now: number): GatewayWedgeVerdict {
  // Instantaneous saturation, from a history-free detector call.
  const instant = detectGatewayWedge(metrics, undefined, now);
  const frozenVsPrior = prior !== undefined && metrics.totalRequests === prior.totalRequests;

  if (instant.saturated && frozenVsPrior) {
    // A saturated freeze is in progress — anchor it at the reading the freeze began (the prior).
    if (freezeAnchor === undefined) freezeAnchor = prior;
  } else {
    // Requests advanced, or the gateway un-saturated → the freeze (if any) is over.
    freezeAnchor = undefined;
  }

  // WI-3565: track the starvation-risk streak independently of the freeze anchor above — starvation
  // has no "frozen counter" identity check, just "has the spatial condition held continuously".
  if (instant.admissionStarvationRisk) {
    if (starvationSince === undefined) starvationSince = now;
  } else {
    starvationSince = undefined;
  }
  const admissionStarvationSustained =
    instant.admissionStarvationRisk &&
    starvationSince !== undefined &&
    now - starvationSince >= ADMISSION_STARVATION_MIN_PERSIST_MS;

  // The durable verdict: pass the (stable) anchor as prior + the min-persist gate.
  const verdict = detectGatewayWedge(metrics, freezeAnchor, now, { minFreezeMs: WEDGE_MIN_FREEZE_MS });

  prior = sampleGateway(metrics, now);
  // `verdict.admissionStarvationRisk` is instantaneous (mirrors `saturated`); fold in the SUSTAINED
  // read as `admissionStarved` (mirrors `wedge`) so callers get the confirmed, alert-worthy signal.
  return { ...verdict, admissionStarved: admissionStarvationSustained };
}

/** Test seam — reset the rolling state so cases don't bleed across each other. */
export function __resetGatewaySampleCacheForTests(): void {
  prior = undefined;
  freezeAnchor = undefined;
  starvationSince = undefined;
}
