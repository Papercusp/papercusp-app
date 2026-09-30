/**
 * Phase-0 smoke workflow — proves DBOS durable execution end-to-end inside
 * the operator process. Registered at module load (imported by `startDbos`
 * before `DBOS.launch()` so workflow recovery can re-bind it).
 *
 * This is a placeholder: Phase 1 (`dbos-durable-jobs-2026-05-31`, P-003/P-004)
 * replaces it with the AutoLoop ticker modelled as a scheduled workflow +
 * a per-(harness, role) dedup-keyed queue.
 */
import { DBOS } from '@dbos-inc/dbos-sdk';
import { idempotentRegisterWorkflow } from './idempotent-register-workflow';

async function helloImpl(name: string): Promise<string> {
  const greeting = await DBOS.runStep(async () => `hello, ${name}`, { name: 'greet' });
  await DBOS.runStep(async () => {
    console.log(`[dbos] ${greeting} — durable step executed`);
  }, { name: 'log' });
  return greeting;
}

export const helloWorkflow = idempotentRegisterWorkflow('helloWorkflow', () =>
  DBOS.registerWorkflow(helloImpl, { name: 'helloWorkflow' }),
);
