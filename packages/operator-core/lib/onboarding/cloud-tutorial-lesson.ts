/** Browser-safe lesson contract. The authenticated product adapter owns observations;
 * the Guide owns presentation. Neither guide actions nor assistant text run product work.
 * Reuses the onboarding pack's brief/details convention without its node-only loader. */
export const CLOUD_TUTORIAL_ID = 'first-cloud-agent';
export const CLOUD_TUTORIAL_VERSION = 1;
export const CLOUD_TUTORIAL_BEGINNER_VERSION = 2;
export type TutorialVersion = 1 | 2;
export const CLOUD_TUTORIAL_TASK = 'Without running any tools or changing anything, list the tools available to you and explain what each is for.';
export const CLOUD_TUTORIAL_NOTES = 'Meeting notes: We want a small community book swap next month. Mira will ask the library about a room by Friday. Leon will collect suggested books. We have not chosen a date or budget. The team needs a short plan before contacting anyone else.';
export const CLOUD_TUTORIAL_PLAN_TASK = `Goal: turn these meeting notes into an action plan. Context: ${CLOUD_TUTORIAL_NOTES}\nOutput: a short table of actions, named owners, deadlines and open questions. Mark missing information as unknown; do not invent facts. Work only with the text above. Do not use tools, access files, contact anyone, or change anything.`;
export const CLOUD_TUTORIAL_REVISION_TASK = 'Revise your action plan: separate confirmed commitments from proposed next steps, put unresolved decisions first, and keep it under 150 words. Use only our supplied notes; do not use tools, contact anyone, or change anything.';

export interface TutorialScope { tenantId: string; userId: string; workspaceId: string }
export type TutorialStepId = 'connection' | 'configuration' | 'workspace' | 'agent' | 'task' | 'result' | 'revision' | 'practice';
export type GuideAction = 'show-target' | 'check-again' | 'help' | 'pause' | 'resume' | 'skip' | 'replay' | 'exit';
export type GuideDisposition = 'active' | 'paused' | 'skipped' | 'closed';
export type StepStatus = 'loading' | 'ready' | 'waiting' | 'delayed' | 'error' | 'blocked' | 'missing-target' | 'complete';
export interface LessonStep {
  id: TutorialStepId; title: string; brief: string; details: string;
  target: string; prerequisites: readonly TutorialStepId[];
  actions: readonly GuideAction[]; recovery: string;
}
const actions: readonly GuideAction[] = ['show-target', 'check-again', 'help', 'pause', 'skip', 'exit'];
export const CLOUD_TUTORIAL_STEPS: readonly LessonStep[] = [
  { id: 'connection', title: 'Connect Google Cloud', target: '[data-tutorial-target="cloud-connection"]', prerequisites: [], actions,
    brief: 'Connect your Google Cloud project using the app’s connection form.',
    details: 'You need permission to manage the project and enable the required Google Cloud APIs. Credentials stay in the product connection form; do not paste them into Help.',
    recovery: 'Review the connection’s validation details, fix the indicated permission or project setting, then validate again in the app.' },
  { id: 'configuration', title: 'Review configuration and cost', target: '[data-tutorial-target="cloud-configuration"]', prerequisites: ['connection'], actions,
    brief: 'Choose a region, machine size and disk, then review the estimated cost before provisioning.',
    details: 'Google Cloud bills for provisioned resources, including retained disks. The estimate is guidance; provider billing is authoritative. You can select an existing workspace instead.',
    recovery: 'Review the app’s configuration checks and estimate. Provision only when you accept the configuration and its cost.' },
  { id: 'workspace', title: 'Wait for a healthy workspace', target: '[data-tutorial-target="cloud-workspace"]', prerequisites: ['connection', 'configuration'], actions,
    brief: 'Provision explicitly in the app or select an existing healthy workspace.',
    details: 'Provisioning can take several minutes. The guide waits for the selected workspace’s readiness checks and never provisions, retries or destroys resources for you.',
    recovery: 'Open the selected workspace’s readiness and operation details. Use the product’s repair or retry controls after reviewing the failure.' },
  { id: 'agent', title: 'Launch your first agent', target: '[data-tutorial-target="cloud-agent"]', prerequisites: ['workspace'], actions,
    brief: 'Launch an agent on the selected workspace using the app’s New session control.',
    details: 'Choose an available model and account. An agent session may incur model usage costs. The guide waits for the session you explicitly launch.',
    recovery: 'Check your agent account and workspace connection, then launch or select an authorized session through the app.' },
  { id: 'task', title: 'Submit a small read-only task', target: '[data-tutorial-target="cloud-task"]', prerequisites: ['agent'], actions,
    brief: 'Ask the agent to describe its available tools without running them or changing anything.',
    details: CLOUD_TUTORIAL_TASK,
    recovery: 'Inspect the correlated session’s task status. If it failed, review the error and explicitly send the sample task again.' },
  { id: 'result', title: 'Inspect the result', target: '[data-tutorial-target="cloud-result"]', prerequisites: ['task'], actions,
    brief: 'Open the completed answer in that session and inspect the tools checklist.',
    details: 'The lesson completes after the app confirms the sample task finished and you inspect its correlated answer. Other chats and unrelated task outputs do not count.',
    recovery: 'Open the same session and completed task. If its answer is still pending, keep using the app while the guide waits.' },
];
export const CLOUD_TUTORIAL_BEGINNER_STEPS: readonly LessonStep[] = [
  { ...CLOUD_TUTORIAL_STEPS[1], prerequisites: [], brief: 'Select a prepared workspace and review its existing cost. You do not need provider credentials or machine settings.' },
  { ...CLOUD_TUTORIAL_STEPS[2], prerequisites: ['configuration'], brief: 'Wait for the selected prepared workspace and its authorized connection to be ready.' },
  CLOUD_TUTORIAL_STEPS[3],
  { ...CLOUD_TUTORIAL_STEPS[4], title: 'Turn notes into an action plan', brief: 'Give the agent a goal, useful context and a requested output. This exercise uses only supplied text.', details: CLOUD_TUTORIAL_PLAN_TASK },
  { ...CLOUD_TUTORIAL_STEPS[5], brief: 'Compare the action plan with the notes. Check owners, deadlines and anything marked unknown.', details: 'An answer can sound confident and still be wrong. Check each claim against your supplied notes before confirming that you reviewed it.' },
  { id: 'revision', title: 'Ask for a correction and review it', target: '[data-tutorial-target="cloud-revision"]', prerequisites: ['result'], actions,
    brief: 'Explicitly request a revision, then compare its answer with the original notes.', details: CLOUD_TUTORIAL_REVISION_TASK,
    recovery: 'Review this revision’s transcript and delivery status before explicitly retrying. An unrelated answer does not count.' },
  { id: 'practice', title: 'Write a different task yourself', target: '[data-tutorial-target="cloud-practice"]', prerequisites: ['revision'], actions,
    brief: 'Write a different goal, provide the text the agent needs, and describe the answer you want. Use a task that can be answered from that text alone.',
    details: 'No sample prompt is filled in for you. Keep private information out of this exercise. Review the successful answer against your own context, then explain how you checked it.',
    recovery: 'If the task needs tools or external actions, reframe it as a request for a proposal from supplied text. Review delivery and result status before retrying.' },
];
export const tutorialSteps = (version: number = CLOUD_TUTORIAL_VERSION) => version === CLOUD_TUTORIAL_BEGINNER_VERSION ? CLOUD_TUTORIAL_BEGINNER_STEPS : CLOUD_TUTORIAL_STEPS;

export type TutorialTaskObservation = { id: string; sessionId: string; sampleTask: boolean; submittedByUser: boolean; status: 'pending' | 'failed' | 'succeeded'; resultId?: string; firstTaskId?: string };
export type TutorialInspection = { sessionId: string; taskId: string; resultId: string };

export interface ProductObservation {
  scope: TutorialScope;
  /** Strictly increasing adapter generation; responses from an older fetch are ignored. */
  revision: number;
  access: 'allowed' | 'denied';
  connection?: { id: string; provider: 'gcp'; validated: boolean };
  configuration?: { connectionId: string; valid: boolean; costReviewed: boolean };
  workspace?: { id: string; connectionId: string; healthy: boolean };
  agent?: { id: string; workspaceId: string; launchedByUser: boolean; available: boolean };
  task?: TutorialTaskObservation;
  revisionTask?: TutorialTaskObservation;
  practiceTask?: TutorialTaskObservation;
  attempt?: { step: TutorialStepId; status: 'pending' | 'failed' | 'delayed' };
}
export interface SavedTutorialProgress {
  lessonId: typeof CLOUD_TUTORIAL_ID; version: number; scope: TutorialScope;
  disposition: GuideDisposition;
  /** A UI inspection receipt, never a saved assertion that domain work succeeded. */
  inspectedResult?: TutorialInspection;
  inspectedRevision?: TutorialInspection;
  inspectedPractice?: TutorialInspection;
}
export interface TutorialState {
  version: TutorialVersion;
  scope: TutorialScope; disposition: GuideDisposition; observation: ProductObservation | null;
  inspectedResult: SavedTutorialProgress['inspectedResult'];
  inspectedRevision?: TutorialInspection; inspectedPractice?: TutorialInspection;
  targetStatus: 'waiting' | 'missing' | 'ready';
}
export type TutorialEvent =
  | { type: 'observe'; observation: ProductObservation }
  | { type: 'action'; action: GuideAction }
  | { type: 'target'; scope: TutorialScope; step: TutorialStepId; status: TutorialState['targetStatus'] }
  | { type: 'inspect-result'; scope: TutorialScope; sessionId: string; taskId: string; resultId: string; kind?: 'first' | 'revision' | 'practice' }
  | { type: 'change-scope'; scope: TutorialScope; saved?: SavedTutorialProgress };

export function sameTutorialScope(a: TutorialScope, b: TutorialScope): boolean {
  return a.tenantId === b.tenantId && a.userId === b.userId && a.workspaceId === b.workspaceId;
}
export function createTutorialState(scope: TutorialScope, saved?: SavedTutorialProgress, version: TutorialVersion = CLOUD_TUTORIAL_VERSION): TutorialState {
  const compatible = saved?.lessonId === CLOUD_TUTORIAL_ID && saved.version === version && sameTutorialScope(scope, saved.scope);
  return { scope, version, disposition: compatible ? saved.disposition : 'active', observation: null,
    inspectedResult: compatible ? saved.inspectedResult : undefined,
    ...(version === 2 && compatible ? { inspectedRevision: saved.inspectedRevision, inspectedPractice: saved.inspectedPractice } : {}), targetStatus: 'waiting' };
}
const inspectedTask = (task: TutorialTaskObservation | undefined, receipt: TutorialInspection | undefined) => Boolean(task?.status === 'succeeded' && task.resultId && receipt?.sessionId === task.sessionId && receipt.taskId === task.id && receipt.resultId === task.resultId);
export function confirmedTutorialSteps(state: TutorialState): TutorialStepId[] {
  const o = state.observation;
  if (!o || o.access !== 'allowed') return [];
  const completed: TutorialStepId[] = [];
  if (state.version === 1) {
    if (!o.connection?.validated) return completed;
    completed.push('connection');
  }
  if (!o.configuration?.valid || !o.configuration.costReviewed || o.configuration.connectionId !== (state.version === 2 ? o.workspace?.connectionId : o.connection?.id)) return completed;
  completed.push('configuration');
  if (!o.workspace?.healthy || o.workspace.connectionId !== o.configuration.connectionId || (state.version === 2 && o.workspace.id !== state.scope.workspaceId)) return completed;
  completed.push('workspace');
  if (!o.agent?.available || !o.agent.launchedByUser || o.agent.workspaceId !== o.workspace.id) return completed;
  completed.push('agent');
  const task = o.task;
  if (!task?.submittedByUser || !task.sampleTask || task.sessionId !== o.agent.id || task.status !== 'succeeded' || !task.resultId) return completed;
  completed.push('task');
  const inspected = state.inspectedResult;
  if (!inspectedTask(task, inspected)) return completed;
  completed.push('result');
  if (state.version === 2) {
    const revision = o.revisionTask, practice = o.practiceTask;
    if (!revision?.submittedByUser || revision.firstTaskId !== task.id || revision.sessionId !== task.sessionId || revision.id === task.id || !inspectedTask(revision, state.inspectedRevision)) return completed;
    completed.push('revision');
    if (!practice?.submittedByUser || practice.sampleTask || practice.firstTaskId !== task.id || practice.sessionId !== task.sessionId || [task.id, revision.id].includes(practice.id) || !inspectedTask(practice, state.inspectedPractice)) return completed;
    completed.push('practice');
  }
  return completed;
}
export function currentTutorialStep(state: TutorialState): LessonStep | null {
  const completed = confirmedTutorialSteps(state);
  return tutorialSteps(state.version).find(step => !completed.includes(step.id)) ?? null;
}
export function tutorialStepStatus(state: TutorialState): StepStatus {
  if (!state.observation) return 'loading';
  if (state.observation.access === 'denied') return 'blocked';
  const step = currentTutorialStep(state);
  if (!step) return 'complete';
  const attempt = state.observation.attempt;
  if (attempt?.step === step.id) return attempt.status === 'failed' ? 'error' : attempt.status === 'pending' ? 'waiting' : 'delayed';
  if (step.id === 'task' && state.observation.task?.sessionId === state.observation.agent?.id) {
    if (state.observation.task?.status === 'failed') return 'error';
    if (state.observation.task?.status === 'pending') return 'waiting';
  }
  return state.targetStatus === 'missing' ? 'missing-target' : 'ready';
}
export function tutorialReducer(state: TutorialState, event: TutorialEvent): TutorialState {
  switch (event.type) {
    case 'change-scope': return createTutorialState(event.scope, event.saved, state.version);
    case 'observe': {
      const o = event.observation;
      if (!sameTutorialScope(state.scope, o.scope) || !Number.isSafeInteger(o.revision) || o.revision < 0 || (state.observation && o.revision <= state.observation.revision)) return state;
      const next = { ...state, observation: o };
      return currentTutorialStep(state)?.id === currentTutorialStep(next)?.id ? next : { ...next, targetStatus: 'waiting' };
    }
    case 'target':
      return sameTutorialScope(state.scope, event.scope) && currentTutorialStep(state)?.id === event.step ? { ...state, targetStatus: event.status } : state;
    case 'inspect-result': {
      const kind = event.kind ?? 'first';
      const task = kind === 'revision' ? state.observation?.revisionTask : kind === 'practice' ? state.observation?.practiceTask : state.observation?.task;
      const prior = kind === 'first' ? 'task' : kind === 'revision' ? 'result' : 'revision';
      if ((kind !== 'first' && state.version !== 2) || !sameTutorialScope(state.scope, event.scope) || task?.status !== 'succeeded' || task.sessionId !== event.sessionId || task.id !== event.taskId || task.resultId !== event.resultId || !confirmedTutorialSteps(state).includes(prior)) return state;
      return { ...state, [kind === 'first' ? 'inspectedResult' : kind === 'revision' ? 'inspectedRevision' : 'inspectedPractice']: { sessionId: event.sessionId, taskId: event.taskId, resultId: event.resultId } };
    }
    case 'action': {
      const disposition: Partial<Record<GuideAction, GuideDisposition>> = { pause: 'paused', resume: 'active', skip: 'skipped', replay: 'active', exit: 'closed' };
      return disposition[event.action] ? { ...state, disposition: disposition[event.action]!, targetStatus: 'waiting' } : state;
    }
  }
}
export function tutorialProgress(state: TutorialState): SavedTutorialProgress {
  return { lessonId: CLOUD_TUTORIAL_ID, version: state.version, scope: state.scope, disposition: state.disposition,
    ...(state.inspectedResult ? { inspectedResult: state.inspectedResult } : {}),
    ...(state.version === 2 ? { inspectedRevision: state.inspectedRevision, inspectedPractice: state.inspectedPractice } : {}) };
}
