/**
 * SUBJECT fixture — the mirror of `module-scoped-control.fixture.ts`, differing
 * in exactly one respect: its state goes through `pinModuleState`.
 *
 * Same shape as the control on purpose. The control must SPLIT across a module
 * reset and this must NOT, so the pair isolates the pinning as the only cause of
 * the difference.
 */
import { pinModuleState } from './index.js';

interface SubjectState {
  tag: string;
  writes: number;
}

export const SUBJECT_STATE: SubjectState = pinModuleState(
  '@papercusp/module-singleton.test.pinned-subject',
  () => ({ tag: 'pinned-subject', writes: 0 }),
);

export function recordWrite(): number {
  SUBJECT_STATE.writes += 1;
  return SUBJECT_STATE.writes;
}

export function writeCount(): number {
  return SUBJECT_STATE.writes;
}
