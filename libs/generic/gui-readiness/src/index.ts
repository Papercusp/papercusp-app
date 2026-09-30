/**
 * @papercusp/gui-readiness — a generic, domain-free GUI process/window readiness
 * barrier + cold-start measurement helper.
 *
 * Two primitives:
 *
 *   waitUntilReady(probe, liveness?, options)      — bounded readiness wait.
 *   measureGuiColdStart(probe, liveness?, options) — the same wait, plus a
 *                                                     cold-start latency ONLY
 *                                                     for a genuinely fresh
 *                                                     launch (never fabricated
 *                                                     for an attached/persistent
 *                                                     process).
 *
 * Both are LEVEL-triggered (poll current state) and hard-bounded on every axis
 * (overall deadline, per-probe-call timeout, liveness fail-fast) — see
 * `wait-until-ready.ts`'s header for exactly why that is the guarantee this
 * library exists to provide: an edge-triggered readiness wait (grep a log for a
 * line that only appears once, resolve on a one-shot "did-finish-load" event)
 * hangs forever against a PERSISTENT process whose one-shot signal already fired
 * before the wait began. Nothing here can do that.
 *
 * Example — measuring a freshly spawned process:
 *
 *   const child = spawn(...);
 *   const result = await measureGuiColdStart(
 *     { checkReady: () => myAppReadyCheck() },
 *     pidLivenessProbe(child.pid),
 *     { origin: 'launched', timeoutMs: 30_000 },
 *   );
 *   // result.coldStartMs is birth → ready, only when result.ok
 *
 * Example — attaching to a process that might already be running (never hangs
 * even if it's been sitting ready for hours):
 *
 *   const result = await measureGuiColdStart(
 *     { checkReady: () => myAppReadyCheck() },
 *     pidLivenessProbe(existingPid),
 *     { origin: 'attached', timeoutMs: 5_000 },
 *   );
 *   // result.coldStartMs is always null here — origin:'attached' never reports one
 */
export type {
  ReadinessProbe,
  LivenessProbe,
  WaitOptions,
  ReadinessFailureReason,
  ReadinessOutcome,
  ProcessOrigin,
  ColdStartOptions,
  ColdStartResult,
} from './types.js';
export { waitUntilReady } from './wait-until-ready.js';
export { measureGuiColdStart } from './cold-start.js';
export { pidLivenessProbe, tcpPortProbe } from './adapters.js';
export type {
  DocumentObservation,
  MountClassifierConfig,
  MountProgress,
  MountVerdict,
} from './document-mount.js';
export { classifyMountObservation, INITIAL_MOUNT_PROGRESS } from './document-mount.js';
export type {
  InjectedInstrumentState,
  InjectedInstrumentObservation,
  InjectedInstrumentVerdict,
} from './injected-instrument.js';
export { classifyInjectedInstrument, isInstrumentUnusable } from './injected-instrument.js';
export type {
  InteractionMeasureObservation,
  InteractionMeasureVerdict,
  InteractionMeasureDiagnosis,
  AttemptTimeoutObservation,
  AttemptTimeoutDiagnosis,
} from './interaction-measure.js';
export {
  classifyInteractionMeasure,
  classifyAttemptTimeout,
  describeInteractionMeasureFailure,
} from './interaction-measure.js';
export type {
  MainThreadQuietOptions,
  MainThreadQuietRuntime,
  MainThreadQuietResult,
} from './main-thread-quiet.js';
export {
  MAIN_THREAD_QUIET_DEFAULTS,
  waitForMainThreadQuiet,
} from './main-thread-quiet.js';
