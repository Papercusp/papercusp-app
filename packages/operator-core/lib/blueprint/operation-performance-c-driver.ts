/** P-013 workload C driver (plan D-016 (C)): a 4-step deterministic PROGRAM
 * with a conditional step, a conditional gate and stable step IDs; no model.
 *
 * control   = the legacy durable coord-program workflow (`startCoordProgram`,
 *             the top-level entry production reaches via startCoordProgramForEvent),
 *             no work item.
 * candidate = the blueprint execution program: public `blueprint:submit`
 *             (execution:{kind:'program'}) → the routines-tick launch scan
 *             (`findUnstartedAcceptedCoordPrograms` → `startCoordProgram`, the
 *             exact production launch, filtered to this receipt) → canonical
 *             root settlement.
 *
 * Phase marks are DB timestamps where the event is a durable commit, so no
 * observer poll interval enters either arm:
 *   ingress     both: invocation start (wall clock, this process)
 *   accepted    control: startCoordProgram returned (workflow enqueued)
 *               candidate: submit receipt returned
 *   dispatched  both: dbos.operation_outputs.started_at_epoch_ms of step op-s1
 *   terminal    control: completed_at_epoch_ms of the gate step (the program
 *               decision durably committed — the legacy terminal state)
 *               candidate: root work_items.state_changed_at (status done)
 *   business    control: dbos.workflow_status.updated_at at SUCCESS (the result
 *               published to callers)
 *               candidate: event_key_fires `work-item:done:<id>` last_fired_at
 * Shared by the Vitest parent (warm) and the fresh Node child (cold). */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import type { Sql } from 'postgres';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import type { BlueprintOperationHandle } from './operation-service';
import type { PhaseMarks } from '../../test/_paired-operation-benchmark';

export const P013C_WORKSPACE = 'p013-benchmark-c';
export const P013C_HARNESS = 'p013-benchmark-c-fixture';
export const P013C_BLUEPRINT_ID = 'p013-workload-c';
export const P013C_OPERATION = 'program';
/** Selects the full branch: s3 runs and the gate approves. */
export const P013C_PAYLOAD = Object.freeze({ branch: 'full' });
/** The DBOS step names every sample must record, in order, on BOTH arms. */
export const P013C_PROGRAM_STEPS = Object.freeze(['op-s1', 'op-s2', 'op-s3', 'op-s4', 'gate-resolve']);

const FULL = { 'payload.branch': 'full' };
const POSTS = [{ author_id: 'p013', body: 'fixed deterministic post' }];
/** The single source for both arms: the control resolver returns this parsed
 * blueprint and the candidate executes its projected specification. */
export const P013C_SOURCE = {
  id: P013C_BLUEPRINT_ID, version: '1', workItem: { kind: 'feature' },
  roles: [{ id: 'worker' }],
  spine: {
    steps: [
      { id: 's1', op: 'vote:aggregate', args: { posts: POSTS }, bind: 'r1' },
      { id: 's2', op: 'vote:aggregate', args: { posts: POSTS }, bind: 'r2' },
      { id: 's3', op: 'vote:aggregate', args: { posts: POSTS }, bind: 'r3', when: FULL },
      { id: 's4', op: 'vote:aggregate', args: { posts: POSTS }, bind: 'r4' },
    ],
    gate: [
      { when: FULL, op: 'resolve', args: { decision: 'approve', notify_caller: false } },
      { else: true, op: 'resolve', args: { decision: 'reject', notify_caller: false } },
    ],
  },
  operations: [{
    id: P013C_OPERATION, version: '1', target: { kind: 'work-item', itemKind: 'feature' },
    execution: { kind: 'program' },
    inputSchema: { type: 'object', required: ['branch'],
      properties: { branch: { enum: ['full', 'short'] } }, additionalProperties: false },
    acceptance: { resultSchema: { type: 'object', required: ['outcome', 'resolved', 'decision'],
      properties: { outcome: { const: 'resolve' }, resolved: { const: true }, decision: { const: 'approve' } } } },
  }],
};

export type P013CArm = 'control' | 'candidate';
export type P013CWorkflow = {
  startCoordProgram: (input: never) => Promise<string>;
  findUnstartedAcceptedCoordPrograms: (sql: Sql, limit?: number) => Promise<Array<{
    acceptedOperation?: { receiptId: number } }>>;
};
export type P013CTools = {
  submitOperationTool: { handler: (...args: never[]) => Promise<unknown> };
  operationResultTool: { handler: (...args: never[]) => Promise<unknown> };
  workflow: P013CWorkflow;
};
export type P013CSample = {
  arm: P013CArm; sequence: number; workflowId: string; workItemId: string | null;
  marks: PhaseMarks; stepNames: string[];
  /** Per durable step (incl. candidate-only settlement): DBOS-recorded duration
   * and the gap since the previous step completed, for phase attribution. */
  stepProfile: Array<{ name: string; durationMs: number | null; gapBeforeMs: number | null }>;
};

const caller = {
  isSuperuser: true, uiClientId: 'su-p013c', workspaceId: P013C_WORKSPACE,
  principal: { slug: 'su-p013c', workspaceId: P013C_WORKSPACE },
};

function now(): number { return performance.timeOrigin + performance.now(); }
async function pause(ms: number) { await new Promise((resolve) => setTimeout(resolve, ms)); }

/** Wait for a durable workflow to reach SUCCESS; a non-success terminal fails loudly. */
async function waitForWorkflow(sql: Sql, workflowId: string, budgetMs: number): Promise<number> {
  const deadline = performance.now() + budgetMs;
  for (;;) {
    const [row] = await sql<Array<{ status: string; updatedAt: string | number; error: string | null }>>`
      SELECT status, updated_at AS "updatedAt", error FROM dbos.workflow_status WHERE workflow_uuid = ${workflowId}`;
    if (row?.status === 'SUCCESS') return Number(row.updatedAt);
    if (row && ['ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'].includes(row.status)) {
      throw new Error(`P-013 C workflow ${workflowId} ended ${row.status}: ${row.error}`);
    }
    if (performance.now() >= deadline) throw new Error(`P-013 C workflow ${workflowId} not SUCCESS after ${budgetMs} ms (${row?.status ?? 'absent'})`);
    await pause(10);
  }
}

type StepRow = { name: string; startedAt: number | null; completedAt: number | null; error: string | null };
async function readSteps(sql: Sql, workflowId: string): Promise<StepRow[]> {
  const rows = await sql<Array<{ name: string; startedAt: string | number | null; completedAt: string | number | null; error: string | null }>>`
    SELECT function_name AS name, started_at_epoch_ms AS "startedAt",
           completed_at_epoch_ms AS "completedAt", error
      FROM dbos.operation_outputs WHERE workflow_uuid = ${workflowId} ORDER BY function_id`;
  return rows.map((row) => ({ name: row.name, error: row.error,
    startedAt: row.startedAt === null ? null : Number(row.startedAt),
    completedAt: row.completedAt === null ? null : Number(row.completedAt) }));
}

/** The durable program steps, in order, excluding candidate-only settlement. */
export function programStepNames(steps: Array<{ name: string }>): string[] {
  return steps.map((step) => step.name).filter((name) => /^(op|gate)-/.test(name));
}

/** Business-event budget: the normal post-commit `work-item:done` fire. */
export const P013C_FIRE_BUDGET_MS = 40_000;
async function waitForDoneFire(sql: Sql, id: string): Promise<{ terminalAt: number; eventAt: number }> {
  const deadline = performance.now() + P013C_FIRE_BUDGET_MS;
  for (;;) {
    const rows = await sql<Array<{ terminalAt: Date; eventAt: Date }>>`
      SELECT wi.state_changed_at AS "terminalAt", fire.last_fired_at AS "eventAt"
        FROM harness_shared.work_items wi
        JOIN harness_shared.event_key_fires fire
          ON fire.workspace_id = ${DEFAULT_COORD_WORKSPACE}
         AND fire.event_key = ${`work-item:done:${id}`}
       WHERE wi.workspace_id = ${P013C_WORKSPACE} AND wi.harness_slug = ${P013C_HARNESS}
         AND wi.feature_id = ${id} AND wi.status = 'done'`;
    if (rows.length === 1) {
      return { terminalAt: new Date(rows[0]!.terminalAt).getTime(), eventAt: new Date(rows[0]!.eventAt).getTime() };
    }
    if (performance.now() >= deadline) {
      const fires = await sql`SELECT workspace_id, event_key, last_fired_at FROM harness_shared.event_key_fires
        WHERE event_key = ${`work-item:done:${id}`}`;
      const [item] = await sql`SELECT status FROM harness_shared.work_items
        WHERE workspace_id = ${P013C_WORKSPACE} AND feature_id = ${id}`;
      throw new Error(`P-013 C missing work-item:done for ${id} after ${P013C_FIRE_BUDGET_MS} ms: ` +
        JSON.stringify({ item: item ?? null, fires }));
    }
    await pause(25);
  }
}

export async function runP013WorkloadC(
  sql: Sql, tools: P013CTools, arm: P013CArm, sequence: number,
): Promise<P013CSample> {
  const { submitOperationTool, operationResultTool, workflow } = tools;
  let ingress: number;
  let accepted: number;
  let workflowId: string;
  let handle: BlueprintOperationHandle | undefined;
  if (arm === 'control') {
    ingress = now();
    workflowId = await workflow.startCoordProgram({
      blueprintId: P013C_BLUEPRINT_ID, payload: { ...P013C_PAYLOAD },
      callerId: 'su-p013c', workspaceId: P013C_WORKSPACE, harnessSlug: P013C_HARNESS,
      runId: `p013c-control-${sequence}`,
    } as never);
    accepted = now();
  } else {
    ingress = now();
    const submitted = await submitOperationTool.handler({
      harness: P013C_HARNESS, operationId: P013C_OPERATION, requestKey: `workload-c-${sequence}`,
      input: { ...P013C_PAYLOAD }, title: `P-013 program candidate ${sequence}`,
    } as never, caller as never);
    accepted = now();
    handle = (submitted as { data: { handle: BlueprintOperationHandle } }).data.handle;
    assert.equal(handle.target.kind, 'work-item');
    // Production launch: the routines tick's bounded scan, then startCoordProgram.
    const input = (await workflow.findUnstartedAcceptedCoordPrograms(sql, 16))
      .find((candidate) => candidate.acceptedOperation?.receiptId === handle!.receiptId);
    assert.ok(input, `P-013 C receipt ${handle.receiptId} missing from the launch scan`);
    workflowId = await workflow.startCoordProgram(input as never);
  }
  const successAt = await waitForWorkflow(sql, workflowId, 60_000);
  const steps = await readSteps(sql, workflowId);
  const stepNames = programStepNames(steps);
  assert.deepEqual(stepNames, [...P013C_PROGRAM_STEPS], `P-013 C ${arm} step names`);
  assert.ok(steps.every((step) => step.error === null), `P-013 C ${arm} step error`);
  // No duplicated effects: each durable step recorded exactly once.
  assert.equal(new Set(steps.map((step) => step.name)).size, steps.length);
  const first = steps.find((step) => step.name === 'op-s1')!;
  const gate = steps.find((step) => step.name === 'gate-resolve')!;
  assert.ok(first.startedAt !== null && gate.completedAt !== null, 'P-013 C step timestamps are unmeasured');
  let terminal: number;
  let businessEvent: number;
  let workItemId: string | null = null;
  if (handle) {
    if (handle.target.kind !== 'work-item') throw new Error('expected program root work item');
    workItemId = handle.target.id;
    const result = await operationResultTool.handler({ handle } as never, caller as never) as {
      data: { state: string; output: { outcome: string; resolved: boolean; decision: unknown } } };
    assert.equal(result.data.state, 'ready');
    assert.deepEqual(result.data.output, { outcome: 'resolve', resolved: true, decision: 'approve' });
    const mark = await waitForDoneFire(sql, workItemId);
    terminal = mark.terminalAt;
    businessEvent = mark.eventAt;
  } else {
    const [row] = await sql<Array<{ output: string | null }>>`
      SELECT output FROM dbos.workflow_status WHERE workflow_uuid = ${workflowId}`;
    assert.match(String(row?.output), /approve/);
    terminal = gate.completedAt!;
    businessEvent = successAt;
  }
  const marks: PhaseMarks = {
    ingress, accepted, dispatched: first.startedAt!, terminal, businessEvent,
    durableSteps: steps.length,
  };
  assert.ok(marks.accepted >= marks.ingress && marks.terminal >= marks.dispatched &&
    marks.businessEvent >= marks.terminal, `P-013 C ${arm} marks out of order ${JSON.stringify(marks)}`);
  const stepProfile = steps.map((step, index) => {
    const previous = index > 0 ? steps[index - 1]!.completedAt : null;
    return {
      name: step.name,
      durationMs: step.startedAt !== null && step.completedAt !== null ? step.completedAt - step.startedAt : null,
      gapBeforeMs: previous !== null && step.startedAt !== null ? step.startedAt - previous : null,
    };
  });
  return { arm, sequence, workflowId, workItemId, marks, stepNames, stepProfile };
}
