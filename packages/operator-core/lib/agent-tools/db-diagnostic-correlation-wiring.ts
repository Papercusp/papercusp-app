/**
 * Wire the db-org local diagnostic correlation seam to the existing named-hop
 * AsyncLocalStorage. The db package owns the optional channel; operator-core
 * owns the stage/attempt policy and supplies the current local context.
 *
 * This is observation-only: the returned tuple never enters LocalWriteOp,
 * crypto AAD, SQL, parameters, or a federated envelope.
 */

import {
  pgDiagnosticIdentity,
  recordPgDiagnosticResponse,
  setPgDiagnosticContextResolver,
  type PgResultDiagnosticCorrelation,
} from '@papercusp/db-org/acquire-registry';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { pinModuleState } from '@papercusp/module-singleton';
import { currentStageDiagnosticContext } from '../sync/hyperbee/stage-stall-log';

const REQUEST_CONTEXT = pinModuleState(
  'operator-core.db-diagnostic-correlation.request-context',
  () => new AsyncLocalStorage<PgResultDiagnosticCorrelation>(),
);

/** The route passes only a registry-confirmed name, or null for an unknown operation. */
export function withNamedQueryDiagnosticContext<T>(operation: string | null, fn: (requestId: string) => T): T {
  const requestId = randomUUID();
  return REQUEST_CONTEXT.run(Object.freeze({
    ...pgDiagnosticIdentity(),
    rowId: null,
    attemptId: requestId,
    hopId: null,
    stage: null,
    boundary: null,
    requestId,
    ...(operation ? { operation } : {}),
  }), () => fn(requestId));
}

/** Record the exact main-process objects, never a serializer-worker clone. */
export function recordNamedQueryResponse(
  phase: 'resolvedRows' | 'responseValue', value: unknown,
): void {
  const context = REQUEST_CONTEXT.getStore();
  if (context) recordPgDiagnosticResponse(context, phase, value);
}

export function installDbDiagnosticCorrelationWiring(): void {
  setPgDiagnosticContextResolver((): PgResultDiagnosticCorrelation | null => {
    const stage = currentStageDiagnosticContext();
    const request = REQUEST_CONTEXT.getStore();
    if (!stage) return request ?? null;
    return request ? { ...stage, requestId: request.requestId, operation: request.operation } : stage;
  });
}

installDbDiagnosticCorrelationWiring();
