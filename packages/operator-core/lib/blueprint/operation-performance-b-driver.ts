/** P-013 workload B driver (plan D-016 (B)): one explicit plan target, a
 * 3-item fork/join DAG (P-001 and P-002 parallel, P-003 blocked-by both — two
 * blocker edges), fixed 1 KiB input and 1 KiB published result.
 *
 * control   = plans:run-now on the template (instance + plan_runs + promotion).
 * candidate = blueprint:submit of the operation whose target is that template
 *             (operation-admission → runScheduledPlanFire, D-017/D-018/D-021).
 *
 * Both arms then run the SAME deterministic fixture worker through the public
 * work_items:claim / work_items:complete / plans:publish-outputs handlers, and
 * the SAME settle step (reconcileScheduledPlanRuns, which production runs on the
 * routines tick — the tick cadence itself is excluded from both arms alike).
 * Shared by the Vitest parent (warm) and the fresh Node child (cold). */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import type { Sql } from 'postgres';
import type { BlueprintOperationHandle } from './operation-service';
import type { PhaseMarks } from '../../test/_paired-operation-benchmark';
import { readUnresolvedDepBlockers } from '../work-items';
import { findAllLinkedWorkItems } from '../plan-items/reconcile-linked-work-items';

export const P013B_WORKSPACE = 'p013-benchmark-b';
export const P013B_HARNESS = 'p013-benchmark-b-fixture';
export const P013B_TEMPLATE = 'p013-fork-join';
export const P013B_OPERATION = 'fork-join';
export const P013B_PAYLOAD = 'x'.repeat(1024);
export const P013B_TEMPLATE_CONTENT = `# P-013 fork/join

## Now
**State:** template.
**Next:** run.

## Phase 1

- **P-001** \`todo\` fork left
- **P-002** \`todo\` fork right
- **P-003** \`todo\` join blocked-by: P-001, P-002`;
export const P013B_ITEMS = [
  { id: 'P-001', text: 'fork left', status: 'todo' },
  { id: 'P-002', text: 'fork right', status: 'todo' },
  { id: 'P-003', text: 'join', status: 'todo', blockedBy: ['P-001', 'P-002'] },
];

/** The join publishes one 1 KiB string, so the template declares exactly that. */
export const P013B_OUTPUT_SCHEMA = {
  type: 'object', required: ['value'], additionalProperties: false,
  properties: { value: { type: 'string' } },
};

export type P013BArm = 'control' | 'candidate';
export type P013BTools = {
  runNowTool: { handler: (...args: never[]) => Promise<unknown> };
  submitOperationTool: { handler: (...args: never[]) => Promise<unknown> };
  operationResultTool: { handler: (...args: never[]) => Promise<unknown> };
  claimWorkItemTool: { handler: (...args: never[]) => Promise<unknown> };
  completeWorkItemTool: { args: { parse: (value: unknown) => unknown }; handler: (...args: never[]) => Promise<unknown> };
  publishOutputsTool: { handler: (...args: never[]) => Promise<unknown> };
  /** Production's plan-run settle step (routines tick). */
  settle: (sql: Sql) => Promise<unknown>;
  /** Canonical single-run read behind the plans:runs tool. */
  getPlanRun: (runId: number) => Promise<{ status: string; outcome: string | null } | null>;
};
export type P013BSample = { arm: P013BArm; runId: number; marks: PhaseMarks; phasesMs: number[] };

async function timed<T>(run: () => Promise<T>) {
  const start = performance.now();
  const value = await run();
  const end = performance.now();
  return { value, ms: end - start, startedAt: performance.timeOrigin + start, endedAt: performance.timeOrigin + end };
}

function textJson(result: unknown): Record<string, unknown> {
  // Tools return either MCP text content or a structured `{ data }` envelope.
  const data = (result as { data?: unknown }).data;
  if (data && typeof data === 'object') return data as Record<string, unknown>;
  const text = (result as { content?: Array<{ text?: string }> }).content?.[0]?.text;
  assert.ok(text, `expected a text tool result: ${JSON.stringify(result).slice(0, 400)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

function firstResult(result: unknown): { ok: boolean; error?: string } | undefined {
  return (result as { data?: { results?: Array<{ ok: boolean; error?: string }> } }).data?.results?.[0];
}

export async function runP013WorkloadB(
  sql: Sql, tools: P013BTools, arm: P013BArm, sequence: number,
): Promise<P013BSample> {
  const caller = {
    isSuperuser: true, uiClientId: 'su-p013b', workspaceId: P013B_WORKSPACE,
    principal: { slug: 'su-p013b', workspaceId: P013B_WORKSPACE },
  };
  const phasesMs: number[] = [];
  let runId: number;
  let instanceSlug: string;
  let handle: BlueprintOperationHandle | undefined;
  const input = { value: P013B_PAYLOAD };
  const ingressCall = arm === 'control'
    ? await timed(() => tools.runNowTool.handler({
        harness: P013B_HARNESS, slug: P013B_TEMPLATE, inputs: input,
      } as never, caller as never))
    : await timed(() => tools.submitOperationTool.handler({
        harness: P013B_HARNESS, operationId: P013B_OPERATION, requestKey: `workload-b-${sequence}`,
        input, title: `P-013 fork/join candidate ${sequence}`,
      } as never, caller as never));
  if (arm === 'control') {
    const body = textJson(ingressCall.value);
    assert.equal(body.ok, true, JSON.stringify(body));
    runId = Number(body.runId);
    instanceSlug = String(body.instanceSlug);
  } else {
    handle = (ingressCall.value as { data: { handle: BlueprintOperationHandle } }).data?.handle;
    assert.ok(handle, JSON.stringify(ingressCall.value).slice(0, 400));
    if (handle.target.kind !== 'plan') throw new Error('P-013 B candidate must target a plan');
    assert.equal(handle.operationId, P013B_OPERATION);
    runId = handle.target.runId;
    instanceSlug = handle.target.instanceSlug;
  }
  phasesMs.push(ingressCall.ms);
  assert.ok(Number.isSafeInteger(runId) && runId > 0);

  const items = await sql<Array<{ id: string; planItem: string }>>`
    SELECT feature_id AS id, (source_plan_item_ids)[1] AS "planItem"
      FROM harness_shared.work_items
     WHERE workspace_id = ${P013B_WORKSPACE}
       AND payload->'plan_run'->>'runId' = ${String(runId)}
       AND payload->'plan_run'->>'instancePlanSlug' = ${instanceSlug}
     ORDER BY feature_id`;
  assert.deepEqual(items.map((row) => row.planItem).sort(), ['P-001', 'P-002', 'P-003'],
    `run ${runId} promoted ${JSON.stringify(items)}`);
  // The isolated fixture settles the shared duplicate-screening gate identically for both arms.
  await sql`
    UPDATE harness_shared.work_items SET admission = 'auto'
     WHERE workspace_id = ${P013B_WORKSPACE} AND payload->'plan_run'->>'runId' = ${String(runId)}
       AND admission = 'pending'`;
  const worker = `su-p013b-${arm}-worker-${sequence}`;
  const workerCtx = { ...caller, uiClientId: worker };
  const byPlanItem = new Map(items.map((row) => [row.planItem, row.id]));
  const claim = async (id: string) => {
    const claimed = await timed(() => tools.claimWorkItemTool.handler({
      id, harness: P013B_HARNESS, assignee: worker,
    } as never, workerCtx as never));
    return { ...claimed, result: firstResult(claimed.value) };
  };
  const complete = async (id: string) => {
    const args = tools.completeWorkItemTool.args.parse({
      id, harness: P013B_HARNESS, state: 'done', assumptions: 'none',
      outputPayload: { value: P013B_PAYLOAD },
      completion: {
        summary: 'P-013 workload B deterministic item', testsRun: 'deterministic fixture worker',
        testResult: '1 KiB value returned', verifiedHow: 'isolated integration fixture', filesChanged: [],
      },
    });
    const done = await timed(() => tools.completeWorkItemTool.handler(args as never, workerCtx as never));
    const result = firstResult(done.value);
    assert.equal(result?.ok, true, result?.error);
    return done;
  };

  // Fork: both roots are claimable at once. Dispatch = the first accepted claim.
  const forkClaims = await Promise.all(['P-001', 'P-002'].map((item) => claim(byPlanItem.get(item)!)));
  for (const claimed of forkClaims) assert.equal(claimed.result?.ok, true, claimed.result?.error);
  const dispatched = Math.min(...forkClaims.map((claimed) => claimed.endedAt));
  phasesMs.push(Math.max(...forkClaims.map((claimed) => claimed.ms)));
  // Invariant: the join carries BOTH blocker edges while the fork is open. Read via
  // the queue floor's own predicate — a by-id claim is the deliberate D-008 override
  // (work-item-dependency-edges-2026-08-02) and would succeed, so it cannot test this.
  const joinId = byPlanItem.get('P-003')!;
  const openBlockers = await readUnresolvedDepBlockers(joinId, P013B_HARNESS);
  assert.equal(openBlockers.length, 2,
    `P-013 B join must carry two unresolved blocker edges: ${JSON.stringify(openBlockers)}`);
  const forkDone = await Promise.all(['P-001', 'P-002'].map((item) => complete(byPlanItem.get(item)!)));
  assert.deepEqual(await readUnresolvedDepBlockers(joinId, P013B_HARNESS), [],
    'P-013 B join still blocked after both blockers completed');
  const forkPlanItems = await sql<Array<{ item_id: string; status: string }>>`
    SELECT item_id, status FROM harness_shared.plan_items
     WHERE workspace_id = ${P013B_WORKSPACE} AND plan_slug = ${instanceSlug} ORDER BY item_id`;
  assert.deepEqual(forkPlanItems.filter((row) => row.item_id !== 'P-003').map((row) => row.status),
    ['done', 'done'], `P-013 B fork plan items after concurrent completion: ${JSON.stringify(forkPlanItems)} receipts=${
      JSON.stringify(forkDone.map((done) => {
        const row = ((done.value as { data?: { results?: Array<Record<string, unknown>> } }).data?.results ?? [])[0];
        return { id: row?.id, finish: row?.finish, errors: row?.errors, warnings: row?.warnings };
      }))} linked=${JSON.stringify(await Promise.all(['P-001', 'P-002'].map(async (item) => ({
        item,
        linked: (await findAllLinkedWorkItems(instanceSlug, item)).map((wi) => ({
          id: wi.id, harness: wi.harness, state: wi.state, viaImplementsEdge: wi.viaImplementsEdge,
        })),
      }))))} revisions=${JSON.stringify(await sql`
        SELECT seq, rationale, author_id FROM harness_shared.plan_revisions
         WHERE workspace_id = ${P013B_WORKSPACE} AND plan_slug = ${instanceSlug} ORDER BY seq`)}`);
  const join = await claim(byPlanItem.get('P-003')!);
  assert.equal(join.result?.ok, true, join.result?.error);
  // The join publishes the run's 1 KiB result, then completes.
  const published = textJson(await tools.publishOutputsTool.handler({
    harness: P013B_HARNESS, runId, slug: instanceSlug, outputs: { value: P013B_PAYLOAD },
  } as never, workerCtx as never));
  assert.equal(published.ok, true, JSON.stringify(published));
  const joined = await complete(byPlanItem.get('P-003')!);
  phasesMs.push(joined.endedAt - dispatched);

  await tools.settle(sql);
  const [run] = await sql<Array<{ status: string; outcome: string | null; finishedAt: number | null }>>`
    SELECT status, outcome, finished_at::float8 AS "finishedAt" FROM harness_shared.plan_runs
     WHERE id = ${runId} AND workspace_id = ${P013B_WORKSPACE}`;
  assert.deepEqual({ status: run?.status, outcome: run?.outcome }, { status: 'done', outcome: 'success' });
  assert.ok(run?.finishedAt && Number.isFinite(run.finishedAt));

  const observed = await timed(async () => handle
    ? tools.operationResultTool.handler({ handle } as never, caller as never)
    : tools.getPlanRun(runId));
  if (handle) {
    const result = (observed.value as { data: { state: string; output: { value: string } } }).data;
    assert.equal(result.state, 'ready', JSON.stringify(result).slice(0, 400));
    assert.equal(result.output.value, P013B_PAYLOAD);
  } else {
    const row = observed.value as { status: string; outcome: string | null } | null;
    assert.deepEqual({ status: row?.status, outcome: row?.outcome }, { status: 'done', outcome: 'success' });
  }
  phasesMs.push(observed.ms);
  // finished_at is the settle process's Date.now(); clamp against sub-ms clock skew
  // between Date.now() and performance.timeOrigin so marks stay monotonic.
  const terminal = Math.max(run.finishedAt, joined.endedAt);
  const marks: PhaseMarks = {
    ingress: ingressCall.startedAt, accepted: ingressCall.endedAt, dispatched,
    terminal, businessEvent: Math.max(observed.endedAt, terminal),
  };
  return { arm, runId, marks, phasesMs };
}
