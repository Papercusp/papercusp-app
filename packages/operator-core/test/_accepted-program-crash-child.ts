/** Process driver for the real accepted-program child-wait crash integration test. */
import postgres from 'postgres';
import { DBOS } from '@dbos-inc/dbos-sdk';

const mode = process.env.ACCEPTED_PROGRAM_CRASH_MODE;
const dsn = process.env.ACCEPTED_PROGRAM_CRASH_DSN;
const workspaceId = process.env.ACCEPTED_PROGRAM_CRASH_WORKSPACE;
const harnessSlug = process.env.ACCEPTED_PROGRAM_CRASH_HARNESS;
const callerId = process.env.ACCEPTED_PROGRAM_CRASH_CALLER;
const receiptId = Number(process.env.ACCEPTED_PROGRAM_CRASH_RECEIPT);
const rootId = process.env.ACCEPTED_PROGRAM_CRASH_ROOT;
if ((mode !== 'crash' && mode !== 'recover') || !dsn || !workspaceId || !harnessSlug ||
    !callerId || !rootId || !Number.isSafeInteger(receiptId) || receiptId <= 0) {
  throw new Error('accepted-program crash fixture configuration is incomplete');
}

const sql = postgres(dsn, { max: 2, onnotice: () => {} });
DBOS.setConfig({
  name: 'accepted-program-crash-test', systemDatabaseUrl: dsn,
  systemDatabaseSchemaName: 'dbos', applicationVersion: 'accepted-program-crash-v1',
  runAdminServer: false,
});
const workflow = await import('../lib/dbos/coord-program-workflow');
await DBOS.launch();
const workflowId = `coord-program:operation:${workspaceId}:${receiptId}`;

if (mode === 'crash') {
  const input = (await workflow.findUnstartedAcceptedCoordPrograms(sql))
    .find((candidate) => candidate.acceptedOperation?.receiptId === receiptId);
  if (!input) throw new Error('accepted root launch candidate missing');
  await workflow.startCoordProgram(input);
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    const deadline = await sql<Array<{ function_name: string }>>`
      SELECT function_name FROM dbos.operation_outputs
       WHERE workflow_uuid = ${workflowId} AND function_name = 'op-wait-leaf:deadline'
    `;
    const child = await sql<Array<{ id: string }>>`
      SELECT id::text FROM harness_shared.blueprint_operation_invocations
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
         AND request_key = ${`program:${receiptId}:op-create-leaf`}
    `;
    if (deadline.length === 1 && child.length === 1) {
      process.kill(process.pid, 'SIGKILL');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('program did not enter its canonical child wait before the crash deadline');
}

// A fresh process recovers the PENDING workflow. Leave its child pending, then
// request cancellation on the canonical root; the recovered wait must see it.
await new Promise((resolve) => setTimeout(resolve, 1_000));
await sql`
  UPDATE harness_shared.work_items
     SET payload = jsonb_set(payload, '{blueprintCancellation}', '{"eventId":"crash-test"}'::jsonb, true)
   WHERE workspace_id = ${workspaceId} AND feature_id = ${rootId}
`;
const result = await DBOS.getResult<{ outcome: string; resolved: boolean }>(workflowId, 90);
if (result.outcome !== 'cancelled' || result.resolved !== false) {
  throw new Error(`recovered program returned ${JSON.stringify(result)} instead of cancellation`);
}
await DBOS.shutdown();
await sql.end({ timeout: 5 });
process.stdout.write('ACCEPTED_PROGRAM_RECOVERED\n');
