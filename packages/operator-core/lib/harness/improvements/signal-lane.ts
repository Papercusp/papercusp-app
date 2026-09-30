/**
 * signal-lane.ts — which watchdog signals are IMPROVEMENTS and which are STATISTICS
 * (watchdog-churn-delta-gate-2026-07-25 P-005 / D-002).
 *
 * THE PROBLEM (owner ruling, 2026-07-25): "should the improvement-watchdog really be using
 * improvement:capture — it seems like it's not really capturing improvements but capturing
 * stats; these stats should be recorded somewhere and then fed into the regular blender
 * self-improvement loop." Correct: a "work-item claim is held by a live agent and not
 * progressing" row is a COORDINATION MEASUREMENT, not a defect an auto-implement worker can
 * patch. Filing it as a `bug` sends a code-writing worker at a condition no code change
 * fixes; the worker closes it, the condition persists, and the next tick re-files it.
 * Measured 7d: `stalled-claim` alone minted 60 copies of ONE key.
 *
 * The codebase already reached this conclusion for the escalation path — `known-open-aging.ts`
 * (D-002): "Infra-class keys use the SHORT threshold: the learning system's own dependencies
 * escalate, they don't queue — an auto-implement worker cannot fix a docker port." This module
 * extends the same judgement to the FILING decision.
 *
 * THE SPLIT:
 *   - **metric** — a throughput / coordination / capacity measurement. Never mints a work
 *     item. Still collected, still counted, still persisted to `harness_shared.watchdog_ticks`,
 *     and therefore still reaches ideation through `scout/watchdog-health-lane.ts`, which
 *     feeds tick history into the Blender corpus digest as citable `watchdog:<collector>`
 *     patterns. So the signal is not lost — it is routed to the consumer that can actually
 *     act on a TREND rather than to one that can only act on a DEFECT.
 *   - **defect** — a concrete named artifact (a failing test file, a drifted migration, a
 *     erroring tool) or a live infra alert that needs a human/worker to look now. Keeps
 *     filing, delta-gated by the P-003 standing-signal suppression so it files ONCE.
 *
 * UNKNOWN SOURCES DEFAULT TO `defect` — fail-open. A new collector keeps today's
 * file-a-work-item behaviour until someone classifies it deliberately; silently swallowing
 * an unrecognised signal is the worse failure.
 */

/** Which consumer a watchdog signal is for. */
export type SignalLane = 'metric' | 'defect';

/**
 * Throughput / coordination / capacity MEASUREMENTS. Each describes a system state that no
 * code edit resolves: the fleet is congested, a claim is stalled, an escalation is unanswered,
 * spawns are timing out, an SLO moved. These belong in the Blender's trend corpus.
 */
export const METRIC_SOURCES: readonly string[] = [
  'stalled-claim',
  'unresolved-escalation',
  'escalation-spike',
  'orphaned-dispatch',
  'orphaned-spawn',
  'spawn-ceiling-jam',
  'perf-regression',
  'failed-spawn',
  'stalled-feature',
  'loop-stalled',
  'stale-protective-hold',
  'stuck-plan',
  'ship-link-stuck',
  'expired-lease',
  'routine-engine-death',
];

/**
 * Concrete named defects + live infra alerts that KEEP filing a work item.
 * Kept as an explicit allowlist (rather than "everything not metric") so the two sets are
 * both reviewable in one place; anything in neither list falls through to `defect`.
 */
export const DEFECT_SOURCES: readonly string[] = [
  // WI-38327. Listed EXPLICITLY even though `defect` is the fall-through default, because
  // its nearest neighbours are both metrics ('unresolved-escalation', 'escalation-spike')
  // and the distinction is the whole point: those measure how much escalation traffic is
  // going untriaged, which no code edit fixes. This one names a BROKEN DELIVERY PATH — the
  // bridge marked itself owner-gated and the owner rail has no record — which is a concrete
  // defect in the alarm code, exactly what an auto-implement worker can patch.
  'bridge-needs-owner-unalerted',
  'red-test',
  'smoke-fail',
  'migration-drift',
  'schema-ahead-of-code',
  // WI-918476. A concrete, patchable divergence: either a migration is missing
  // (add one) or the live database carries an object nothing ships (drop it).
  'schema-object-drift',
  'repeated-tool-error',
  'insight-staleness',
  'service-down',
  'fire-circuit-open',
  'routine-failure',
];

const METRIC_SET = new Set(METRIC_SOURCES);

/**
 * PURE: classify a signal source into its lane. Unknown → `defect` (fail-open: a new
 * collector keeps filing until deliberately classified).
 */
export function signalLaneOf(source: string): SignalLane {
  return METRIC_SET.has(source) ? 'metric' : 'defect';
}

/** Convenience: does a signal from this source mint a work item? */
export function sourceFilesWorkItem(source: string): boolean {
  return signalLaneOf(source) === 'defect';
}
