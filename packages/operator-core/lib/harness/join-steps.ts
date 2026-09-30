/**
 * Join-flow step vocabulary — ids, statuses, per-step state shape.
 *
 * Dependency-free LEAF, extracted from `join-shared-harness.ts` so the client
 * join UI (`EntryHarnessLinkForm`, `JoinProgress`) can import the step
 * vocabulary WITHOUT dragging join-shared-harness's server-only deps
 * (node:child_process / fs / os and the identity→keychain chain) into the
 * operator-vite SPA bundle. Those modules make top-level node-builtin calls
 * (e.g. `os.homedir()`, `util.promisify(execFile)`) that are `undefined` in
 * the browser-stubbed build and throw at module-eval → blank page. Keeping the
 * pure constants here lets the client import them with zero server fan-in.
 *
 * `join-shared-harness.ts` re-exports these so existing server consumers are
 * unaffected.
 */

export type JoinStepId =
  | 'oauth_attest'
  | 'clone_repo'
  | 'publish_binding'
  | 'boot_federate'
  | 'await_admission_merge'
  | 'route_insights';

export type JoinStepStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'error'
  /** Phase-0-dependent stub: step not yet implemented; flow continues. */
  | 'phase_0_pending';

export interface JoinStepState {
  id: JoinStepId;
  status: JoinStepStatus;
  errorCode?: string;
  detail?: string;
}

export const ALL_STEP_IDS: JoinStepId[] = [
  'oauth_attest',
  'clone_repo',
  'publish_binding',
  'boot_federate',
  'await_admission_merge',
  'route_insights',
];

export const JOIN_STEP_IDS = ALL_STEP_IDS;
