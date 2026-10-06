import { captureBrowserTelemetry } from '@/app/_components/PostHogProvider';
import { CLOUD_TUTORIAL_ID, CLOUD_TUTORIAL_VERSION, confirmedTutorialSteps, currentTutorialStep, sameTutorialScope, tutorialStepStatus, type TutorialState, type TutorialStepId, type StepStatus } from '@papercusp/operator-core/lib/onboarding/cloud-tutorial-lesson';

type Event = 'start' | 'step_displayed' | 'step_confirmed' | 'waiting' | 'recovery' | 'pause' | 'resume' | 'skip' | 'exit' | 'replay' | 'check_again' | 'complete' | 'help_requested';
type Properties = { lesson_id: string; lesson_version: number; action: Event; step?: TutorialStepId; status?: StepStatus };
type Capture = (event: string, properties: Properties) => unknown;
const needsRecovery = new Set<StepStatus>(['waiting', 'delayed', 'error', 'blocked', 'missing-target']);

function emit(capture: Capture, action: Event, step?: TutorialStepId, status?: StepStatus, version = CLOUD_TUTORIAL_VERSION) {
  // Construct an allowlisted payload; never spread state, task or chat objects.
  const properties: Properties = { lesson_id: CLOUD_TUTORIAL_ID, lesson_version: version, action,
    ...(step ? { step } : {}), ...(status ? { status } : {}) };
  try { void Promise.resolve(capture('cloud_tutorial', properties)).catch(() => {}); } catch { /* optional diagnostics */ }
}

export function recordTutorialHelpRequest(step: TutorialStepId, status: StepStatus, version = CLOUD_TUTORIAL_VERSION) {
  emit(captureBrowserTelemetry, 'help_requested', step, status, version);
}

/** Observe the controller's confirmed state, never intent clicks or AI answers.
 * The per-mount cursor prevents render/StrictMode duplicates and resets on scope
 * changes without placing tenant/user/workspace identifiers in telemetry. */
export function createTutorialAnalytics(sink: Capture = captureBrowserTelemetry) {
  let version = CLOUD_TUTORIAL_VERSION;
  const capture: Capture = (event, properties) => sink(event, { ...properties, lesson_version: version });
  let previous: TutorialState | null = null;
  let displayed: TutorialStepId | undefined;
  const confirmed = new Set<TutorialStepId>();
  let started = false;
  let completed = false;
  return {
    action(action: 'replay' | 'check_again', step?: TutorialStepId) { emit(capture, action, step); },
    update(state: TutorialState, displayedStep = currentTutorialStep(state)?.id) {
      version = state.version;
      if (previous && (previous.version !== state.version || !sameTutorialScope(previous.scope, state.scope))) {
        previous = null; displayed = undefined; confirmed.clear(); started = false; completed = false;
      }
      const status = tutorialStepStatus(state);
      if (!started && state.disposition === 'active') { started = true; emit(capture, 'start'); }
      if (previous && state.disposition !== previous.disposition) {
        const action = { paused: 'pause', active: 'resume', skipped: 'skip', closed: 'exit' } as const;
        emit(capture, action[state.disposition]);
      }
      if (state.disposition === 'active' && displayedStep && (displayedStep !== displayed || previous?.disposition !== 'active')) emit(capture, 'step_displayed', displayedStep, status);
      const steps = confirmedTutorialSteps(state);
      for (const step of steps) if (!confirmed.has(step)) { confirmed.add(step); emit(capture, 'step_confirmed', step); }
      if (state.disposition === 'active' && needsRecovery.has(status) && (!previous || tutorialStepStatus(previous) !== status || currentTutorialStep(previous)?.id !== currentTutorialStep(state)?.id)) emit(capture, 'waiting', currentTutorialStep(state)?.id, status);
      if (previous && needsRecovery.has(tutorialStepStatus(previous)) && !needsRecovery.has(status) && status !== 'loading') emit(capture, 'recovery', currentTutorialStep(previous)?.id, status);
      if (status === 'complete' && !completed) { completed = true; emit(capture, 'complete'); }
      previous = state; displayed = state.disposition === 'active' ? displayedStep : undefined;
    },
  };
}
