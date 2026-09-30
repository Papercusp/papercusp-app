/**
 * Wire the db-org local diagnostic correlation seam to the existing named-hop
 * AsyncLocalStorage. The db package owns the optional channel; operator-core
 * owns the stage/attempt policy and supplies the current local context.
 *
 * This is observation-only: the returned tuple never enters LocalWriteOp,
 * crypto AAD, SQL, parameters, or a federated envelope.
 */

import {
  setPgDiagnosticContextResolver,
  type PgResultDiagnosticCorrelation,
} from '@papercusp/db-org';
import { currentStageDiagnosticContext } from '../sync/hyperbee/stage-stall-log';

export function installDbDiagnosticCorrelationWiring(): void {
  setPgDiagnosticContextResolver((): PgResultDiagnosticCorrelation | null => {
    return currentStageDiagnosticContext();
  });
}

installDbDiagnosticCorrelationWiring();
