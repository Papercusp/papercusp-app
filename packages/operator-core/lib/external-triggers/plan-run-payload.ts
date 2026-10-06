/**
 * plan-run-payload — the ONE place that knows which part of a trigger run is the
 * owner's private ingest, and the only supported way for a plan agent to read it.
 *
 * ── WHY THIS MODULE EXISTS (WI-2143575) ──
 * `binding-engine.ts` builds ONE object (`triggerArgs()`) that is consumed at TWO
 * different trust levels:
 *
 *   1. `harness_shared.trigger_runs.args` — owner-LOCAL and never federated (no
 *      module under `lib/sync/` references that table). This is the legitimate
 *      home of the private payload.
 *   2. the launch-plan branch's `inputs` — which lands inside
 *      `harness_shared.work_items.payload.plan_run.inputs.trigger` and DOES
 *      federate to admitted hive members.
 *
 * EI-22088522809897790 closed this at the federation boundary by redacting
 * external-ingest envelopes on the way out. This module closes it at the SOURCE:
 * the private payload never enters a federated record in the first place
 * (defence in depth). {@link redactTriggerArgsForPlanInputs} is the projection
 * that keeps trust level 2 free of it.
 *
 * The agent still needs the message it is supposed to respond to, so the payload
 * moves from PUSH to PULL: {@link readTriggerPlanRunPayload} resolves it
 * server-side from the local table by `planRunId`. That mirrors the write side:
 * `mail:reply { planRunId }` takes only the run id plus the reply body and resolves
 * recipient, thread, reply headers and the provider credential server-side. The
 * read side was the asymmetry; this removes it.
 */

import type postgres from 'postgres';

type Db = postgres.Sql | postgres.TransactionSql;

/**
 * The canonical trigger envelope written to `trigger_runs.args`.
 *
 * `payload` is the owner's private ingest — the inbound email or Slack message,
 * including sender, subject and full body. It belongs to trust level 1 only.
 */
export interface TriggerRunArgs {
  trigger: {
    key: string;
    source: string;
    event: string;
    sourceId: string;
    externalId: string;
    occurredAt: string | null;
    datatypeId: string;
    dedupeKey: string;
    payload: Record<string, unknown>;
  };
}

/** The same envelope minus the private payload — safe to federate. */
export interface PlanRunTriggerInputs {
  trigger: Omit<TriggerRunArgs['trigger'], 'payload'>;
}

/**
 * Project `trigger_runs.args` down to what a plan run's `inputs` may carry.
 *
 * Keeps every ROUTING field (key/source/event/sourceId/externalId/occurredAt/
 * datatypeId/dedupeKey) so the plan, its input schema, and any downstream
 * correlation still work; drops only `payload`.
 *
 * This is a DROP, not a redaction placeholder, because the two boundaries differ
 * in kind. `redactExternalIngest` (lib/sync/hyperbee) blanks the field on rows
 * that already exist, so an admitted member's work-item history keeps its shape.
 * Here the record has not been written yet, so there is nothing to preserve the
 * shape of — the honest representation of "the engine no longer sends this" is
 * an absent key, and an absent key is what the input schemas now expect.
 */
export function redactTriggerArgsForPlanInputs(args: TriggerRunArgs): PlanRunTriggerInputs {
  const { payload: _private, ...routing } = args.trigger;
  return { trigger: { ...routing } };
}

export interface TriggerPlanRunPayload {
  triggerRunId: string;
  key: string;
  source: string;
  event: string;
  sourceId: string;
  externalId: string;
  dedupeKey: string;
  occurredAt: string | null;
  payload: Record<string, unknown>;
}

interface TriggerPayloadRow {
  triggerRunId: string;
  args: unknown;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function string(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Resolve the private ingest for one external-trigger plan run, server-side.
 *
 * Deliberately NOT filtered by source kind — the envelope is source-agnostic, so
 * one reader serves gmail, slack, gcal and every future adapter. The trust
 * boundary is the same one `mail:reply { planRunId }` relies on: a caller must
 * name a `planRunId` that resolves inside its OWN workspace.
 *
 * `status = 'succeeded'` is the correct predicate even though the agent reads
 * this at the START of its work: the binding engine marks the trigger run
 * succeeded as soon as the plan LAUNCHES (it records `plan_run_ref` in the same
 * write), not when the agent finishes.
 */
export async function readTriggerPlanRunPayload(
  sql: Db,
  workspaceId: string,
  planRunId: number,
): Promise<TriggerPlanRunPayload> {
  if (!Number.isSafeInteger(planRunId) || planRunId <= 0) throw new Error('trigger_payload_plan_run_id_invalid');
  const rows = await sql<TriggerPayloadRow[]>`
    SELECT tr.id::text AS "triggerRunId",
           tr.args
      FROM harness_shared.trigger_runs tr
     WHERE tr.workspace_id = ${workspaceId}
       AND tr.plan_run_ref = ${String(planRunId)}
       AND tr.status = 'succeeded'
     ORDER BY tr.completed_at DESC NULLS LAST, tr.id
     LIMIT 1`;
  const row = rows[0];
  if (!row) throw new Error(`trigger_payload_run_not_found:${planRunId}`);
  return payloadFromRow(row);
}

/**
 * Resolve the private ingest for the work item a trigger-fired blueprint
 * OPERATION created (app-agent-tasks-durable-execution-2026-10-06 D-006).
 *
 * An operation-dispatched trigger run has no plan run, so `planRunId` cannot
 * name it. The binding engine submits it with `callerId =
 * trigger-binding:<bindingId>` and `requestKey = trigger-run:<triggerRunId>`
 * (binding-engine.ts, the `blueprint-operation` branch), and the invocation row
 * records the work item it created as its target. Joining on BOTH halves is
 * the trust boundary: only an invocation the binding engine minted for THAT
 * trigger run resolves, inside the caller's own workspace, so a caller cannot
 * name an arbitrary trigger run by guessing a request key.
 *
 * No status predicate: the invocation row is written in the submit transaction,
 * BEFORE the engine marks the trigger run succeeded, so a worker that claims the
 * item at once must still resolve it.
 */
export async function readTriggerOperationPayload(
  sql: Db,
  workspaceId: string,
  workItemId: string,
): Promise<TriggerPlanRunPayload> {
  const id = workItemId.trim();
  if (!id) throw new Error('trigger_payload_work_item_id_invalid');
  const rows = await sql<TriggerPayloadRow[]>`
    SELECT tr.id::text AS "triggerRunId",
           tr.args
      FROM harness_shared.blueprint_operation_invocations i
      JOIN harness_shared.trigger_runs tr
        ON tr.workspace_id = i.workspace_id
       AND i.request_key = 'trigger-run:' || tr.id::text
       AND i.caller_id = 'trigger-binding:' || tr.binding_id::text
     WHERE i.workspace_id = ${workspaceId}
       AND i.target_kind = 'work-item'
       AND i.target_ref = ${id}
     ORDER BY i.id DESC
     LIMIT 1`;
  const row = rows[0];
  if (!row) throw new Error(`trigger_payload_operation_not_found:${id}`);
  return payloadFromRow(row);
}

function payloadFromRow(row: TriggerPayloadRow): TriggerPlanRunPayload {
  const trigger = object(object(row.args).trigger);
  return {
    triggerRunId: row.triggerRunId,
    key: string(trigger.key),
    source: string(trigger.source),
    event: string(trigger.event),
    sourceId: string(trigger.sourceId),
    externalId: string(trigger.externalId),
    dedupeKey: string(trigger.dedupeKey),
    occurredAt: typeof trigger.occurredAt === 'string' ? trigger.occurredAt : null,
    payload: object(trigger.payload),
  };
}
