/** Shared P-013 workload A driver. Both the Vitest parent and fresh Node child
 * execute these same public calls against the same migrated throwaway database. */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import type { Sql } from 'postgres';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import type { BlueprintOperationHandle } from './operation-service';
import type { PhaseMarks } from '../../test/_paired-operation-benchmark';

export const P013_WORKSPACE = 'p013-benchmark';
export const P013_HARNESS = 'p013-benchmark-fixture';
export const P013_PAYLOAD = 'x'.repeat(1024);
export type P013Arm = 'control' | 'candidate';
export type P013Tools = {
  createWorkItemTool: { handler: (...args: never[]) => Promise<unknown> };
  claimWorkItemTool: { handler: (...args: never[]) => Promise<unknown> };
  completeWorkItemTool: { args: { parse: (value: unknown) => unknown }; handler: (...args: never[]) => Promise<unknown> };
  getWorkItemTool: { handler: (...args: never[]) => Promise<unknown> };
  submitOperationTool: { handler: (...args: never[]) => Promise<unknown> };
  operationEventsTool: { handler: (...args: never[]) => Promise<unknown> };
  operationResultTool: { handler: (...args: never[]) => Promise<unknown> };
};
export type P013Sample = {
  arm: P013Arm; phasesMs: number[]; eventLagMs: number; marks: PhaseMarks;
  /** How the terminal business event was observed; see waitForTerminalEvent. */
  eventRecovery: P013EventRecovery;
};

async function timed<T>(run: () => Promise<T>): Promise<{
  value: T; ms: number; startedAt: number; endedAt: number;
}> {
  const start = performance.now();
  const value = await run();
  const end = performance.now();
  return { value, ms: end - start,
    startedAt: performance.timeOrigin + start, endedAt: performance.timeOrigin + end };
}

/** How long the normal post-commit `work-item:done` fire may take before the
 * sample falls back to production's recovery path. It must sit well outside the
 * measured tail. Rep1b (2026-09-27, 100 cold children) measured the
 * terminal→business-event phase at p99 6.4 s (control) and 8.2 s (candidate).
 * The former 5 s poll deadline therefore sat INSIDE that tail. One late fire
 * (WI-113) then aborted a 200-child R=2 matrix after 23 minutes with no sample,
 * and nothing said whether the fire was late or lost. */
export const P013_NORMAL_FIRE_BUDGET_MS = 40_000;
/** Bound for the fire the reconciler publishes once it has been invoked. */
export const P013_REPAIR_FIRE_BUDGET_MS = 10_000;
export type P013EventRecovery = 'normal' | 'reconciler';

type TerminalEventMark = { terminalAt: Date; eventAt: Date; eventIntentId: string };

async function pollTerminalEvent(sql: Sql, id: string, budgetMs: number): Promise<TerminalEventMark | null> {
  const deadline = performance.now() + budgetMs;
  for (;;) {
    const rows = await sql<Array<{
      terminalAt: Date; eventAt: Date; eventIntentId: string | null;
    }>>`
      SELECT wi.state_changed_at AS "terminalAt",
             fire.last_fired_at AS "eventAt",
             fire.last_payload->>'completionIntentId' AS "eventIntentId"
        FROM harness_shared.work_items wi
        JOIN harness_shared.event_key_fires fire
          ON fire.workspace_id = ${DEFAULT_COORD_WORKSPACE}
         AND fire.event_key = ${`work-item:done:${id}`}
       WHERE wi.workspace_id = ${P013_WORKSPACE} AND wi.harness_slug = ${P013_HARNESS}
         AND wi.feature_id = ${id} AND wi.status = 'done'
    `;
    if (rows.length === 1 && rows[0]!.eventIntentId) return rows[0] as TerminalEventMark;
    if (performance.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The state a missing fire leaves behind: separates "never emitted" (pending
 * intent, no fire row) from "emitted without the intent id" and "item not done". */
async function describeMissingTerminalEvent(sql: Sql, id: string): Promise<string> {
  const [item] = await sql<Array<{ status: string; intentKeys: string[] | null }>>`
    SELECT status,
           (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(COALESCE(payload, '{}'::jsonb)) k
             WHERE k ILIKE '%intent%') AS "intentKeys"
      FROM harness_shared.work_items
     WHERE workspace_id = ${P013_WORKSPACE} AND harness_slug = ${P013_HARNESS} AND feature_id = ${id}
  `;
  const fires = await sql<Array<{ workspaceId: string; firedAt: Date; intentId: string | null }>>`
    SELECT workspace_id AS "workspaceId", last_fired_at AS "firedAt",
           last_payload->>'completionIntentId' AS "intentId"
      FROM harness_shared.event_key_fires
     WHERE event_key = ${`work-item:done:${id}`}
  `;
  return JSON.stringify({ item: item ?? null, fires });
}

/** Production's recovery for a late or lost `work-item:done` fire is the await
 * sweeper's completion-event reconciler. The cold child does not run the sweeper,
 * so the rig invokes that reconciler once instead of aborting the matrix. The
 * sample is flagged `reconciler`, so the report counts it rather than hiding it in
 * the latency distribution. The import is lazy on purpose: a static import would
 * add the reconciler graph to every cold child's measured module-load cost. */
async function waitForTerminalEvent(sql: Sql, id: string): Promise<TerminalEventMark & {
  recovery: P013EventRecovery;
}> {
  const normal = await pollTerminalEvent(sql, id, P013_NORMAL_FIRE_BUDGET_MS);
  if (normal) return { ...normal, recovery: 'normal' };
  const missing = await describeMissingTerminalEvent(sql, id);
  const { reconcileWorkItemCompletionEventIntents } = await import('../work-item-completion-event-reconciler');
  const repair = await reconcileWorkItemCompletionEventIntents(P013_WORKSPACE);
  const repaired = await pollTerminalEvent(sql, id, P013_REPAIR_FIRE_BUDGET_MS);
  if (repaired) {
    console.warn(`P013_EVENT_RECOVERED id=${id} by=reconciler repair=${JSON.stringify(repair)} before=${missing}`);
    return { ...repaired, recovery: 'reconciler' };
  }
  throw new Error(`P-013 missing terminal business event for ${id} after ${P013_NORMAL_FIRE_BUDGET_MS} ms ` +
    `plus one reconciler pass (${JSON.stringify(repair)}); state before repair: ${missing}`);
}

export async function runP013WorkloadA(
  sql: Sql, tools: P013Tools, arm: P013Arm, sequence: number,
): Promise<P013Sample> {
  const { createWorkItemTool, claimWorkItemTool, completeWorkItemTool, getWorkItemTool,
    submitOperationTool, operationEventsTool, operationResultTool } = tools;
  const caller = {
    isSuperuser: true, uiClientId: 'su-p013', workspaceId: P013_WORKSPACE,
    principal: { slug: 'su-p013', workspaceId: P013_WORKSPACE },
  };
  const phasesMs: number[] = [];
  let ingress: number;
  let accepted: number;
  let candidate: BlueprintOperationHandle | undefined;
  let id: string;
  if (arm === 'control') {
    const created = await timed(() => createWorkItemTool.handler({
      kind: 'feature', title: `P-013 direct control ${sequence}`, summary: P013_PAYLOAD,
      harness: P013_HARNESS,
    } as never, caller as never));
    const result = (created.value as { data?: { results?: Array<{ ok: boolean; id: string; error?: string }> } })
      .data?.results?.[0];
    assert.equal(result?.ok, true, result?.error);
    id = result!.id;
    phasesMs.push(created.ms);
    ingress = created.startedAt;
    accepted = created.endedAt;
  } else {
    const submitted = await timed(() => submitOperationTool.handler({
      harness: P013_HARNESS, operationId: 'direct', requestKey: `workload-a-${sequence}`,
      input: { value: P013_PAYLOAD }, title: `P-013 direct candidate ${sequence}`,
    } as never, caller as never));
    candidate = (submitted.value as { data: { handle: BlueprintOperationHandle } }).data.handle;
    assert.equal(candidate.target.kind, 'work-item');
    if (candidate.target.kind !== 'work-item') throw new Error('expected direct work item');
    id = candidate.target.id;
    phasesMs.push(submitted.ms);
    ingress = submitted.startedAt;
    accepted = submitted.endedAt;
    const events = await operationEventsTool.handler({ handle: candidate } as never, caller as never);
    assert.ok((events as { data: { events: Array<{ kind: string; state: string }> } }).data.events
      .some((event) => event.kind === 'work-item' && event.state === 'open'));
  }
  const worker = `su-p013-${arm}-worker-${sequence}`;
  if (candidate) {
    const [{ pin }] = await sql<Array<{ pin: Record<string, unknown> }>>`
      SELECT payload->'blueprintOperation' AS pin FROM harness_shared.work_items
       WHERE workspace_id = ${P013_WORKSPACE} AND harness_slug = ${P013_HARNESS} AND feature_id = ${id}
    `;
    const launchRevision = { specificationRevision: 'a'.repeat(64), stateRevision: 'p013-applied' };
    await sql`
      INSERT INTO harness_shared.adv_sessions
        (workspace_id, mode, feature, agent, session_id, coord_owner_id, role, launch_spec)
      VALUES (${P013_WORKSPACE}, 'console', ${id}, 'claude', ${`native-p013-${sequence}`}, ${worker}, 'worker',
        ${sql.json({ workspaceId: P013_WORKSPACE, harnessSlug: P013_HARNESS, role: 'worker',
          ...launchRevision, specificationArtifact: { configuration: { grants: {} } },
          acceptedOperation: {
            kind: 'blueprint-operation-worker', workItemId: id,
            operationId: 'direct', specificationRevision: candidate.specificationRevision,
            pin, identity: { ref: 'worker', revision: '1', contentHash: 'b'.repeat(64) },
            requiredTools: ['work_items:complete'],
          },
        } as never)})
    `;
    await sql`
      INSERT INTO harness_shared.session_briefs (workspace_id, owner_id, control_state)
      VALUES (${P013_WORKSPACE}, ${worker}, ${sql.json({ activation: {
        schemaVersion: 1,
        attribution: { actorId: worker, principalId: worker, sessionId: worker },
        desired: launchRevision, prepared: null, applied: launchRevision, status: 'applied',
      } } as never)})
    `;
  }
  // The isolated fixture settles the shared duplicate-screening gate identically.
  await sql`
    UPDATE harness_shared.work_items SET admission = 'auto'
     WHERE workspace_id = ${P013_WORKSPACE} AND harness_slug = ${P013_HARNESS}
       AND feature_id = ${id} AND admission = 'pending'
  `;
  const claimed = await timed(() => claimWorkItemTool.handler({
    id, harness: P013_HARNESS, assignee: worker,
  } as never, { ...caller, uiClientId: worker } as never));
  const claim = (claimed.value as { data?: { results?: Array<{ ok: boolean; error?: string }> } })
    .data?.results?.[0];
  assert.equal(claim?.ok, true, claim?.error);
  phasesMs.push(claimed.ms);
  const args = completeWorkItemTool.args.parse({
    id, harness: P013_HARNESS, state: 'done', assumptions: 'none',
    outputPayload: { value: P013_PAYLOAD },
    completion: {
      summary: 'P-013 deterministic direct result',
      testsRun: 'deterministic provider fixture', testResult: '1 KiB value returned',
      verifiedHow: 'isolated integration fixture', filesChanged: [],
    },
  });
  const completed = await timed(() => completeWorkItemTool.handler(args as never,
    { ...caller, uiClientId: worker } as never));
  const completion = (completed.value as { data?: { results?: Array<{ ok: boolean; error?: string }> } })
    .data?.results?.[0];
  assert.equal(completion?.ok, true, completion?.error);
  phasesMs.push(completed.ms);
  const observed = await timed(async () => candidate
    ? {
        result: await operationResultTool.handler({ handle: candidate } as never, caller as never),
        events: await operationEventsTool.handler({ handle: candidate } as never, caller as never),
      }
    : getWorkItemTool.handler({ id, harness: P013_HARNESS, threadLimit: 0 } as never, caller as never));
  if (candidate) {
    const { result, events } = observed.value as {
      result: { data: { state: string; output: { value: string } } };
      events: { data: { events: Array<{ kind: string; state: string }> } };
    };
    assert.equal(result.data.state, 'ready');
    assert.equal(result.data.output.value, P013_PAYLOAD);
    assert.ok(events.data.events.some((event) => event.kind === 'work-item' && event.state === 'done'));
    const terminalEvents = await sql<Array<{ ts: Date }>>`
      SELECT ts FROM harness_shared.coord_event_log
       WHERE workspace_id = ${P013_WORKSPACE} AND surface = 'blueprint-operation'
         AND body->>'workItemId' = ${id} AND body->>'state' = 'done'
    `;
    assert.equal(terminalEvents.length, 1);
    assert.ok(Number.isFinite(new Date(terminalEvents[0]!.ts).getTime()));
  } else {
    assert.equal((observed.value as { data?: { results?: Array<{ workItem?: { state: string } }> } })
      .data?.results?.[0]?.workItem?.state, 'done');
  }
  phasesMs.push(observed.ms);
  const eventMark = await waitForTerminalEvent(sql, id);
  const eventLagMs = new Date(eventMark.eventAt).getTime() - new Date(eventMark.terminalAt).getTime();
  assert.ok(eventLagMs >= 0);
  const marks: PhaseMarks = {
    ingress, accepted, dispatched: claimed.endedAt,
    terminal: new Date(eventMark.terminalAt).getTime(),
    businessEvent: new Date(eventMark.eventAt).getTime(),
  };
  assert.equal(phasesMs.length, 4);
  assert.ok(phasesMs.every((duration) => Number.isFinite(duration) && duration >= 0));
  return { arm, phasesMs, eventLagMs, marks, eventRecovery: eventMark.recovery };
}
