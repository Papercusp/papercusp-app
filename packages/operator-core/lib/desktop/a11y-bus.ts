/** Operator enrollment adapter for the reusable accessibility bus lifecycle. */
import { beginSyncEnrolment, completeSyncEnrolment, finishSyncEnrolment } from '../task-manager/enroll-sync';
import * as core from './a11y-bus-core';
export * from './a11y-bus-core';
export function startA11yBus(display: string, opts: core.StartA11yBusOptions = {}) {
  return core.startA11yBus(display, { ...opts, enrollment: opts.externallySupervised ? undefined : {
    begin: beginSyncEnrolment, complete: completeSyncEnrolment, finish: finishSyncEnrolment,
  } });
}
