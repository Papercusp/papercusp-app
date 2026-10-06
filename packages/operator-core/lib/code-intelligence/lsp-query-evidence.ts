/** Request-scoped archive evidence. No retained mirror or separate execution path. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { pinModuleState } from '@papercusp/module-singleton';

export interface LspQueryEvent {
  readonly phase: 'admission-queued' | 'admission-start' | 'service-start' | 'service-end' |
    'durable-enqueued' | 'durable-running' | 'durable-settled' | 'durable-cancelled';
  readonly atMs: number;
  readonly classKey?: string;
  readonly receiptId?: string;
  readonly confirmed?: boolean;
}
export interface LspWireEvidence {
  readonly method: string;
  readonly taskId: string;
  readonly pid: number | null;
  readonly startedAtMs: number;
  endedAtMs: number | null;
  outcome: 'pending' | 'response' | 'error';
}
export interface LspQueryEvidence {
  readonly requestId: string;
  readonly daemonPid: number;
  readonly receivedAtMs: number;
  respondedAtMs: number | null;
  readonly events: LspQueryEvent[];
  readonly wire: LspWireEvidence[];
}
const state = pinModuleState('papercusp.lsp-query-evidence', () => ({
  scope: new AsyncLocalStorage<LspQueryEvidence | undefined>(),
}));
export const lspEvidenceNow = () => performance.timeOrigin + performance.now();

/** Bind explicitly to the admitted task: a queue drain may run in another caller's scope. */
export function withLspQueryEvidence<T>(evidence: LspQueryEvidence | undefined, task: () => Promise<T>): Promise<T> {
  return state.scope.run(evidence, task);
}
export function newLspQueryEvidence(requestId: string): LspQueryEvidence {
  return { requestId, daemonPid: process.pid, receivedAtMs: lspEvidenceNow(), respondedAtMs: null, events: [], wire: [] };
}
export async function recordLspWireRequest<T>(
  identity: Pick<LspWireEvidence, 'method' | 'taskId' | 'pid'>, task: () => Promise<T>,
): Promise<T> {
  const evidence = state.scope.getStore();
  if (!evidence) return task();
  const wire: LspWireEvidence = { ...identity, startedAtMs: lspEvidenceNow(), endedAtMs: null, outcome: 'pending' };
  evidence.wire.push(wire);
  try { const result = await task(); wire.outcome = 'response'; return result; }
  catch (error) { wire.outcome = 'error'; throw error; }
  finally { wire.endedAtMs = lspEvidenceNow(); }
}
