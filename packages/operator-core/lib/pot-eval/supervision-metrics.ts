/**
 * Supervision-detection MEASUREMENT (P-064 + P-065, D-021) — drives the REAL detection logic over
 * the adversarial corpus and quantifies how good it actually is: detection rate, latency, and the
 * load-bearing FALSE-POSITIVE rate against healthy controls. "Measure, don't assume."
 *
 * - **Liveness (P-064):** simulates the placement watchdog's sweep cadence over a synthetic clock,
 *   driving the real pure deciders `deriveCupLiveness` + `evaluatePlacement`, and finds the first
 *   tick a stalled bee turns into a `recover` (the recovery wake) → the detection LATENCY against
 *   the real `RECLAIM_STALE_MS`/`WEDGE_SILENT_MS` thresholds.
 * - **Behavioral (P-065):** runs a pluggable {@link BehavioralDetector} over the off-brief corpus.
 *   The dedicated P-052 collectors (scope-violation, convergence-churn) are UNBUILT, so the only
 *   detector today is {@link ekgDriftDetector} (the Fleet-EKG tool-mix drift). The report surfaces
 *   the misbehaving cases it misses as `undetectedHardCases` — the honest gap, and the yardstick
 *   for when P-052 lands (a new detector plugs into the SAME interface and the rate should rise).
 *
 * Pure + deterministic — no live hive, no DB. The detectors under test are the real shipped
 * functions; only the seeded inputs + the synthetic clock are the harness's.
 */
import { RECLAIM_STALE_MS, WEDGE_SILENT_MS } from '../fleet/spawn-reclaim';
import { deriveCupLiveness, evaluatePlacement, placementConfig, type PlacementConfig } from '../pot/placement-watchdog';
import { detectDrift, type DriftOptions } from '../fleet-ekg/drift';
import type { SessionVector } from '../fleet-ekg/features';
import {
  scopeViolation,
  convergenceChurn,
  shouldWakeOnScopeViolation,
  shouldWakeOnChurn,
  DEFAULT_BEHAVIORAL_WAKE_POLICY,
  type BehavioralWakePolicy,
} from '../pot/behavioral-supervision';
import { casesForFamily, type SupervisionCase, type SupervisionFamily, type BehavioralSeed, type ChannelBehavior } from './supervision-scenarios';

/** The placement watchdog runs on the 30s routinesTick — the model of its sweep cadence. */
export const WATCHDOG_SWEEP_MS = 30_000;
/** How long the harness simulates the sweep before declaring a stalled bee undetected. */
export const DETECTION_HORIZON_MS = 20 * 60_000;
/** Behavioral drift surfaces only after an EKG window cohort forms — detection is window-cadence
 *  (hours), not seconds. The default EKG window is 24h; reported as the behavioral latency so the
 *  trend shows behavioral catches are SLOW (a reason the dedicated P-052 live signal matters). */
export const EKG_WINDOW_MS = 24 * 60 * 60_000;

export type DetectionVerdict = 'tp' | 'tn' | 'fp' | 'fn';

export interface DetectionOutcome {
  caseId: string;
  misbehaving: boolean;
  detected: boolean;
  verdict: DetectionVerdict;
  /** Detection latency (ms) for a true positive, else null. */
  latencyMs: number | null;
}

export interface SupervisionDetectionReport {
  family: SupervisionFamily;
  detectorName: string;
  outcomes: DetectionOutcome[];
  /** detected misbehaving ÷ total misbehaving (true-positive rate). */
  detectionRate: number;
  /** falsely-flagged controls ÷ total controls. The number the whole eval guards. */
  falsePositiveRate: number;
  /** Mean detection latency over true positives (ms), or null if none detected. */
  meanLatencyMs: number | null;
  /** Misbehaving cases NOT detected — the honest gap (what a P-052 collector must close). */
  undetectedHardCases: string[];
}

function verdictOf(misbehaving: boolean, detected: boolean): DetectionVerdict {
  if (misbehaving) return detected ? 'tp' : 'fn';
  return detected ? 'fp' : 'tn';
}

function summarize(family: SupervisionFamily, detectorName: string, outcomes: DetectionOutcome[]): SupervisionDetectionReport {
  const positives = outcomes.filter((o) => o.misbehaving);
  const negatives = outcomes.filter((o) => !o.misbehaving);
  const tp = positives.filter((o) => o.detected);
  const fp = negatives.filter((o) => o.detected);
  const latencies = tp.map((o) => o.latencyMs).filter((l): l is number => l != null);
  return {
    family,
    detectorName,
    outcomes,
    detectionRate: positives.length > 0 ? tp.length / positives.length : 0,
    falsePositiveRate: negatives.length > 0 ? fp.length / negatives.length : 0,
    meanLatencyMs: latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null,
    undetectedHardCases: positives.filter((o) => !o.detected).map((o) => o.caseId),
  };
}

// ── Liveness (P-064) ──────────────────────────────────────────────────────────

/** The timestamp of a channel's most-recent event at clock `now`: a stalled channel's last event
 *  was at t=0 (so its age = now and grows); a working channel emitted within the last `gapMs`. */
function lastEventAt(behavior: ChannelBehavior, now: number): number {
  if (behavior === 'stalled') return 0;
  return now - (behavior.gapMs > 0 ? now % behavior.gapMs : 0);
}

/** Is the stalled bee, at clock `now` (ms since stall-start), seen as needing recovery? Drives the
 *  REAL deciders: a non-`live` bee is no live holder, so a non-terminal unit → `recover`. */
function needsRecoveryAt(c: SupervisionCase, now: number, cfg: PlacementConfig): boolean {
  const seed = c.liveness!;
  const liveness = deriveCupLiveness({
    status: seed.status,
    heartbeatAtMs: lastEventAt(seed.heartbeat, now),
    lastOutputAtMs: lastEventAt(seed.output, now),
    now,
  });
  const decision = evaluatePlacement(
    {
      workItemId: c.id,
      unitExists: true,
      unitTerminal: false,
      hasLiveHolder: liveness === 'live',
      failCount: 0,
      infraLossCount: 0,
      placementStatus: null,
      lastRecoveryAtMs: null,
      recoveryStartedAtMs: null,
      now,
    },
    cfg,
  );
  return decision.kind === 'recover';
}

/**
 * Measure the liveness family's recovery-wake detection over the seeded hung-bee corpus by
 * simulating the watchdog sweep (every {@link WATCHDOG_SWEEP_MS}) up to {@link DETECTION_HORIZON_MS}.
 * Latency = the first sweep tick a stalled bee is flagged `recover`. Healthy controls are never
 * flagged (false-positive guard).
 */
export function measureLivenessDetection(opts: { cfg?: PlacementConfig; cases?: SupervisionCase[] } = {}): SupervisionDetectionReport {
  const cfg = opts.cfg ?? placementConfig();
  const cases = opts.cases ?? casesForFamily('liveness');
  const outcomes: DetectionOutcome[] = cases.map((c) => {
    let latencyMs: number | null = null;
    for (let t = 0; t <= DETECTION_HORIZON_MS; t += WATCHDOG_SWEEP_MS) {
      if (needsRecoveryAt(c, t, cfg)) {
        latencyMs = t;
        break;
      }
    }
    const detected = latencyMs != null;
    return { caseId: c.id, misbehaving: c.misbehaving, detected, verdict: verdictOf(c.misbehaving, detected), latencyMs };
  });
  return summarize('liveness', 'placement-watchdog (deriveCupLiveness/evaluatePlacement)', outcomes);
}

/** The expected recovery latency for each hung kind — the threshold rounded up to the next sweep.
 *  Exported so a test can assert the measured latency matches the real thresholds. */
export const EXPECTED_RECOVERY_LATENCY_MS = {
  heartbeat: Math.ceil((RECLAIM_STALE_MS + 1) / WATCHDOG_SWEEP_MS) * WATCHDOG_SWEEP_MS,
  silent: Math.ceil((WEDGE_SILENT_MS + 1) / WATCHDOG_SWEEP_MS) * WATCHDOG_SWEEP_MS,
} as const;

// ── Behavioral (P-065) ────────────────────────────────────────────────────────

/** The pluggable detector-under-test seam. The EKG drift detector is the only one TODAY; the
 *  P-052 scope-violation + convergence-churn collectors implement this when built, and the eval
 *  re-runs to show the rate rise (D-007 yardstick). */
export interface BehavioralDetector {
  name: string;
  /** Did this detector flag the case as off-brief? `latencyMs` = its detection delay. */
  detect(c: SupervisionCase): { detected: boolean; latencyMs: number | null };
}

/** Build a cohort of identical sessions from a tool-mix + numeric features (replicated to clear the
 *  EKG cohort floor). Bigrams left empty — the off-brief signal here is the mix/feature shift. */
function cohort(label: string, mix: Record<string, number>, features: Record<string, number>, count: number): SessionVector[] {
  const eventCount = Object.values(mix).reduce((a, b) => a + b, 0);
  return Array.from({ length: count }, (_, i) => ({
    ownerId: `${label}-${i}`,
    sessionId: `${label}-s${i}`,
    agent: null,
    harnessSlug: null,
    startedAtMs: 0,
    endedAtMs: 1,
    eventCount,
    features,
    toolMix: { ...mix },
    bigrams: {},
  }));
}

/**
 * The Fleet-EKG drift detector as a behavioral supervision signal: flag the bee off-brief iff its
 * recent tool-mix/features drift from baseline (a `detectDrift` finding). Catches a tool-mix SHIFT;
 * blind to stealth off-brief (normal-looking tools) + churn (re-placement signal isn't in EKG
 * sessions) — those are the gap the report surfaces. The cohort floors are lowered for the compact
 * eval corpus (they are a production NOISE gate, not the detection logic).
 */
export function ekgDriftDetector(opts: { drift?: DriftOptions; cohortSize?: number; latencyMs?: number } = {}): BehavioralDetector {
  const cohortSize = opts.cohortSize ?? 4;
  const driftOpts: DriftOptions = { minWindowSessions: 3, minBaselineSessions: 3, ...opts.drift };
  const latencyMs = opts.latencyMs ?? EKG_WINDOW_MS;
  return {
    name: 'fleet-ekg detectDrift (tool-mix/feature shift)',
    detect(c) {
      const seed: BehavioralSeed | undefined = c.behavioral;
      if (!seed) return { detected: false, latencyMs: null };
      const baseline = cohort('base', seed.baselineToolMix, {}, cohortSize);
      const window = cohort('win', seed.windowToolMix, seed.windowFeatures ?? {}, cohortSize);
      const result = detectDrift(baseline, window, driftOpts);
      const detected = result.status === 'ok' && result.findings.length > 0;
      return { detected, latencyMs: detected ? latencyMs : null };
    },
  };
}

/** The dedicated collectors fire on the bee's own activity (a commit / declared-files change / a
 *  re-placement) — checkable on the supervision tick, NOT bound to the EKG window. So they detect in
 *  ~a watchdog sweep, far faster than {@link EKG_WINDOW_MS} — itself a reason the dedicated family
 *  matters (the EKG drift catch is hours-late). */
export const COLLECTOR_DETECTION_LATENCY_MS = WATCHDOG_SWEEP_MS;

/** The P-052/P-003 SCOPE-VIOLATION collector as a behavioral detector: flag the bee off-brief iff it
 *  touched files outside its declared lane (above the wake policy's threshold). Catches the stealth
 *  off-brief case EKG drift is blind to. */
export function scopeViolationDetector(policy: BehavioralWakePolicy = DEFAULT_BEHAVIORAL_WAKE_POLICY): BehavioralDetector {
  return {
    name: 'scope-violation (declared-lane vs touched files)',
    detect(c) {
      const seed = c.behavioral;
      if (!seed?.declaredLane || !seed.touchedFiles) return { detected: false, latencyMs: null };
      const v = scopeViolation({ declaredLane: seed.declaredLane, touchedFiles: seed.touchedFiles });
      const detected = shouldWakeOnScopeViolation(v, policy);
      return { detected, latencyMs: detected ? COLLECTOR_DETECTION_LATENCY_MS : null };
    },
  };
}

/** The P-052/P-003 CONVERGENCE-CHURN collector as a behavioral detector: flag the bee iff it has
 *  re-attempted without converging (above the wake policy's threshold). Catches the churn case that
 *  lives in hive_placements, not EKG sessions. */
export function convergenceChurnDetector(policy: BehavioralWakePolicy = DEFAULT_BEHAVIORAL_WAKE_POLICY): BehavioralDetector {
  return {
    name: 'convergence-churn (re-placement without convergence)',
    detect(c) {
      const p = c.behavioral?.placement;
      if (!p) return { detected: false, latencyMs: null };
      const detected = shouldWakeOnChurn(convergenceChurn(p), policy);
      return { detected, latencyMs: detected ? COLLECTOR_DETECTION_LATENCY_MS : null };
    },
  };
}

/** Compose detectors into one (the full behavioral-supervision family): flagged iff ANY sub-detector
 *  fires; latency = the FASTEST detector that fired. */
export function compositeDetector(detectors: BehavioralDetector[]): BehavioralDetector {
  return {
    name: `composite(${detectors.map((d) => d.name).join(' + ')})`,
    detect(c) {
      const hits = detectors.map((d) => d.detect(c)).filter((r) => r.detected);
      if (hits.length === 0) return { detected: false, latencyMs: null };
      const latencies = hits.map((r) => r.latencyMs).filter((l): l is number => l != null);
      return { detected: true, latencyMs: latencies.length > 0 ? Math.min(...latencies) : null };
    },
  };
}

/** The full behavioral-supervision family as ONE detector (EKG drift + scope-violation +
 *  convergence-churn) — the P-052/P-003 collectors now real, not the Brief D stub. */
export function fullBehavioralDetector(policy: BehavioralWakePolicy = DEFAULT_BEHAVIORAL_WAKE_POLICY): BehavioralDetector {
  return compositeDetector([ekgDriftDetector(), scopeViolationDetector(policy), convergenceChurnDetector(policy)]);
}

/** Measure a behavioral detector over the off-brief corpus → rate / latency / false-positive. */
export function measureBehavioralDetection(detector: BehavioralDetector, opts: { cases?: SupervisionCase[] } = {}): SupervisionDetectionReport {
  const cases = opts.cases ?? casesForFamily('behavioral');
  const outcomes: DetectionOutcome[] = cases.map((c) => {
    const { detected, latencyMs } = detector.detect(c);
    return { caseId: c.id, misbehaving: c.misbehaving, detected, verdict: verdictOf(c.misbehaving, detected), latencyMs: detected ? latencyMs : null };
  });
  return summarize('behavioral', detector.name, outcomes);
}

/** Run the whole supervision battery: liveness (built) + behavioral (EKG today; pass a future
 *  P-052 detector to re-measure). Returns one report per family. */
export function measureSupervision(opts: { behavioralDetector?: BehavioralDetector; cfg?: PlacementConfig } = {}): {
  liveness: SupervisionDetectionReport;
  behavioral: SupervisionDetectionReport;
} {
  return {
    liveness: measureLivenessDetection({ cfg: opts.cfg }),
    // Default is now the FULL family (EKG drift + the P-052/P-003 collectors) — pass ekgDriftDetector()
    // explicitly to measure the EKG-only baseline.
    behavioral: measureBehavioralDetection(opts.behavioralDetector ?? fullBehavioralDetector()),
  };
}
