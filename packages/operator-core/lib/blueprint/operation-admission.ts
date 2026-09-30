/** Internal direct-item admission for a compiled blueprint operation.
 * Keyed admission stores a durable receipt and recovers the canonical item
 * after a lost response. Public invocation, plan targets, and execution belong
 * to the later operation lifecycle. The complete contract is immutable. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Sql, TransactionSql } from 'postgres';
import { z } from 'zod';
import { compileAgentSpecification, operationFromSpecification, type Blueprint } from '@papercusp/orchestrator/blueprint';
import { checkAgainstJsonSchema } from '../json-schema-validation';
import { createWorkItem, getWorkItem, type WorkItem, type WorkItemKind } from '../work-items';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import { runWithWorkspace } from '../workspace-als';
import { readBlueprintHashFromPg, readBlueprintSpecificationSnapshot, retainBlueprintSpecificationSnapshot } from './project-to-pg';
import { runScheduledPlanFire } from '../harness/routines/plan-run-action';
import { BlueprintOperationRefusal } from './operation-refusal';

const AcceptedOperationPinSchema = z
  .object({
    kind: z.literal('blueprint-operation'),
    harnessSlug: z.string().min(1),
    specificationRevision: z.string().regex(/^[0-9a-f]{64}$/),
    operationId: z.string().min(1),
    operationVersion: z.string().min(1),
    input: z.record(z.string(), z.unknown()),
    callerId: z.string().min(1).max(200).optional(),
    requestKey: z.string().min(1).max(200).optional(),
    requestFingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .strict();

export type AcceptedOperationPin = z.infer<typeof AcceptedOperationPinSchema>;

export interface AcceptBlueprintDirectItemInput {
  workspaceId: string;
  harnessSlug: string;
  operationId: string;
  input: Record<string, unknown>;
  title: string;
  summary?: string;
  createdBy?: string;
  /** Authenticated principal scope; required when requestKey is supplied. */
  callerId?: string;
  /** Stable caller key for concurrent and crash-safe admission replay. */
  requestKey?: string;
  /** Internal program-child call: use the parent's immutable specification. */
  expectedSpecificationRevision?: string;
}

/** A child invocation must keep its parent's definition even if the mutable
 * blueprint pointer moves before admission or a lost response is replayed. */
export function selectOperationSpecificationRevision(
  expected: string | undefined,
  receipt: string | undefined,
  current: string | null,
): string {
  if (expected !== undefined && !/^[0-9a-f]{64}$/.test(expected)) {
    throw new Error('expected blueprint operation specification revision is invalid');
  }
  if (expected && receipt && expected !== receipt) {
    throw new Error('blueprint operation receipt differs from the expected specification revision');
  }
  const revision = receipt ?? expected ?? current;
  if (!revision) throw new Error('blueprint operation has no projected specification');
  return revision;
}

interface InvocationReceiptRow {
  request_fingerprint: string;
  target_kind: string;
  target_ref: string | null;
  specification_revision: string;
}

/** Coalesce same-process retries before they occupy separate transaction
 * connections waiting on one advisory lock. The PostgreSQL receipt remains
 * authoritative across processes and restarts. */
const invocationFlights = new Map<string, { fingerprint: string; promise: Promise<unknown> }>();

function withInvocationSingleflight<T>(
  identity: { workspaceId: string; harnessSlug: string; callerId: string; operationId: string; key: string },
  fingerprint: string,
  run: () => Promise<T>,
): Promise<T> {
  const flightKey = canonicalJson(identity);
  const prior = invocationFlights.get(flightKey);
  if (prior) {
    if (prior.fingerprint !== fingerprint) {
      throw new BlueprintOperationRefusal('input_conflict', 'blueprint operation request key was reused with different input or target');
    }
    return prior.promise as Promise<T>;
  }
  const promise = Promise.resolve()
    .then(run)
    .finally(() => {
      invocationFlights.delete(flightKey);
    });
  invocationFlights.set(flightKey, { fingerprint, promise });
  return promise;
}

/**
 * WI-10003586: the keyed direct and scheduled admission transactions hold one
 * pool connection while createWorkItem() takes a SECOND one from getOrgPg(). When
 * the in-flight transactions on one pool reach its max, every holder waits for a
 * connection none of them will release: a deadlock with no lock wait (backends
 * sit idle in transaction on ClientRead). Bounding the holders to poolMax - 1
 * leaves one connection free for the nested writer, so the wait always ends.
 */
const DEFAULT_POOL_MAX_WHEN_UNKNOWN = 10;
const nestedAcquireGates = new WeakMap<object, { active: number; waiters: Array<() => void> }>();

export function nestedAcquireCapacity(sql: Sql): number {
  const max = Number((sql as unknown as { options?: { max?: unknown } }).options?.max);
  const poolMax = Number.isInteger(max) && max > 0 ? max : DEFAULT_POOL_MAX_WHEN_UNKNOWN;
  return Math.max(1, poolMax - 1);
}

export async function withNestedAcquireHeadroom<T>(sql: Sql, run: () => Promise<T>): Promise<T> {
  let gate = nestedAcquireGates.get(sql);
  if (!gate) {
    gate = { active: 0, waiters: [] };
    nestedAcquireGates.set(sql, gate);
  }
  const capacity = nestedAcquireCapacity(sql);
  while (gate.active >= capacity) {
    await new Promise<void>((resolve) => gate.waiters.push(resolve));
  }
  gate.active += 1;
  try {
    return await run();
  } finally {
    gate.active -= 1;
    gate.waiters.shift()?.();
  }
}

function requestFingerprint(request: AcceptBlueprintDirectItemInput, input: Record<string, unknown>): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        callerId: request.callerId?.trim() ?? null,
        operationId: request.operationId,
        input,
        title: request.title.trim(),
        summary: request.summary ?? null,
      }),
    )
    .digest('hex');
}

/** Recover a committed item if its separate receipt transaction was interrupted.
 * work_items is the canonical base table for both item families. */
async function findDirectItemByRequest(
  sql: Sql | TransactionSql,
  request: AcceptBlueprintDirectItemInput,
  callerId: string,
  key: string,
  fingerprint: string,
): Promise<WorkItem | null> {
  return resolveDirectItemRows(await findDirectItemRows(sql, request, callerId, key), request, key, fingerprint);
}

/** The recovery scan alone, so admission can pipeline it (WI-10003631). */
function findDirectItemRows(
  sql: Sql | TransactionSql,
  request: AcceptBlueprintDirectItemInput,
  callerId: string,
  key: string,
) {
  return sql<Array<{ feature_id: string }>>`
    SELECT feature_id FROM harness_shared.work_items
     WHERE workspace_id = ${request.workspaceId}
       AND harness_slug = ${request.harnessSlug}
       AND payload->'blueprintOperation'->>'callerId' = ${callerId}
       AND payload->'blueprintOperation'->>'operationId' = ${request.operationId}
       AND payload->'blueprintOperation'->>'requestKey' = ${key}
     LIMIT 2
  `;
}

async function resolveDirectItemRows(
  rows: ReadonlyArray<{ feature_id: string }>,
  request: AcceptBlueprintDirectItemInput,
  key: string,
  fingerprint: string,
): Promise<WorkItem | null> {
  if (rows.length > 1) throw new Error('blueprint operation request has multiple canonical work items');
  if (!rows[0]) return null;
  const item = await getWorkItem(rows[0].feature_id, request.harnessSlug);
  if (!item) throw new Error('blueprint operation accepted work item disappeared');
  const payload =
    item.payload && typeof item.payload === 'object' && !Array.isArray(item.payload)
      ? (item.payload as Record<string, unknown>)
      : {};
  const pin = AcceptedOperationPinSchema.parse(payload.blueprintOperation);
  if (request.expectedSpecificationRevision &&
      pin.specificationRevision !== request.expectedSpecificationRevision) {
    throw new Error('recovered blueprint operation differs from the expected specification revision');
  }
  if (pin.requestFingerprint !== fingerprint || pin.requestKey !== key) {
    throw new BlueprintOperationRefusal('input_conflict', 'blueprint operation request key was reused with different input');
  }
  return item;
}

function exactJsonInput(input: Record<string, unknown>): Record<string, unknown> {
  let saved: unknown;
  try {
    saved = JSON.parse(JSON.stringify(input));
  } catch {
    throw new Error('blueprint operation input must be JSON serializable');
  }
  if (!saved || Array.isArray(saved) || typeof saved !== 'object' || !isDeepStrictEqual(saved, input)) {
    throw new Error('blueprint operation input must be a lossless JSON object');
  }
  return saved as Record<string, unknown>;
}

function validateOperationInput(schema: Record<string, unknown>, input: Record<string, unknown>): void {
  const verdict = checkAgainstJsonSchema(schema, input);
  if (!verdict.ok) {
    throw new BlueprintOperationRefusal('invalid_payload', `blueprint operation ${verdict.code}: ${verdict.errors.join('; ')}`);
  }
}

/** Select the current revision once, then accept that exact immutable artifact.
 * An author moving the mutable blueprint pointer afterward cannot change the
 * accepted item's contract, even if it happens before the work-item INSERT. */
export function acceptBlueprintDirectWorkItem(
  sql: Sql,
  request: AcceptBlueprintDirectItemInput,
): Promise<WorkItem> {
  return runWithWorkspace(request.workspaceId, () => acceptBlueprintDirectWorkItemScoped(sql, request));
}

async function acceptBlueprintDirectWorkItemScoped(
  sql: Sql,
  request: AcceptBlueprintDirectItemInput,
): Promise<WorkItem> {
  if (!request.workspaceId.trim() || !request.harnessSlug.trim() || !request.operationId.trim()) {
    throw new Error('blueprint operation admission requires workspace, harness, and operation');
  }
  if (!request.title.trim()) throw new Error('blueprint operation work item requires a title');
  const key = request.requestKey?.trim();
  const callerId = request.callerId?.trim();
  if (request.requestKey !== undefined && (!key || key.length > 200)) {
    throw new Error('blueprint operation request key must be 1-200 characters');
  }
  if (key && (!callerId || callerId.length > 200)) {
    throw new Error('keyed blueprint operation admission requires an authenticated caller id');
  }
  const input = exactJsonInput(request.input);
  const fingerprint = key ? requestFingerprint(request, input) : undefined;

  if (key && fingerprint && callerId) {
    // The one lock covers the receipt and both work-item families. The
    // work-item writer uses its own connection; the payload scan repairs the
    // crash gap after that writer commits but before this transaction commits.
    return withInvocationSingleflight(
      {
        workspaceId: request.workspaceId,
        harnessSlug: request.harnessSlug,
        callerId,
        operationId: request.operationId,
        key,
      },
      fingerprint,
      () => withNestedAcquireHeadroom(sql, () =>
        sql.begin(async (tx) => {
          const lockKey =
            'blueprint-operation:' +
            [request.workspaceId, request.harnessSlug, callerId, request.operationId, key].join(':');
          // WI-10003631 D-030(4): pipeline the lock and every read the
          // admission may need into ONE flush on this transaction's
          // connection. Postgres executes them in send order, so the advisory
          // lock is held before the receipt FOR UPDATE and the recovery scan,
          // exactly as with sequential awaits; the recovery rows and current
          // hash are read speculatively and used only on the paths that
          // previously read them.
          const [, receipts, recoveredRows, currentHash] = await Promise.all([
            tx`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
            tx<InvocationReceiptRow[]>`
        SELECT request_fingerprint, target_kind, target_ref, specification_revision
          FROM harness_shared.blueprint_operation_invocations
         WHERE workspace_id = ${request.workspaceId} AND harness_slug = ${request.harnessSlug}
           AND caller_id = ${callerId}
           AND operation_id = ${request.operationId} AND request_key = ${key}
         FOR UPDATE
      `,
            findDirectItemRows(tx, request, callerId, key),
            request.expectedSpecificationRevision
              ? Promise.resolve(null)
              : readBlueprintHashFromPg(tx, request.workspaceId, request.harnessSlug),
          ]);
          const receipt = receipts[0];
          if (receipt && (receipt.request_fingerprint !== fingerprint || receipt.target_kind !== 'work-item')) {
            throw new BlueprintOperationRefusal('input_conflict', 'blueprint operation request key was reused with different input or target');
          }
          if (request.expectedSpecificationRevision && receipt?.specification_revision &&
              receipt.specification_revision !== request.expectedSpecificationRevision) {
            throw new Error('blueprint operation receipt differs from the expected specification revision');
          }
          if (receipt?.target_ref) {
            const item = await getWorkItem(receipt.target_ref, request.harnessSlug);
            if (!item) throw new Error('blueprint operation receipt points to a missing work item');
            const pin = AcceptedOperationPinSchema.parse((item.payload as Record<string, unknown>)?.blueprintOperation);
            if (
              pin.requestKey !== key ||
              pin.requestFingerprint !== fingerprint ||
              pin.specificationRevision !== receipt.specification_revision
            ) {
              throw new Error('blueprint operation receipt and canonical work item disagree');
            }
            return item;
          }
          const recovered = await resolveDirectItemRows(recoveredRows, request, key, fingerprint);
          if (recovered) {
            const pin = AcceptedOperationPinSchema.parse(
              (recovered.payload as Record<string, unknown>)?.blueprintOperation,
            );
            if (receipt && receipt.specification_revision !== pin.specificationRevision) {
              throw new Error('blueprint operation receipt and recovered work item disagree');
            }
            if (receipt) {
              await tx`
            UPDATE harness_shared.blueprint_operation_invocations SET target_ref = ${recovered.id}, updated_at = now()
             WHERE workspace_id = ${request.workspaceId} AND harness_slug = ${request.harnessSlug}
               AND caller_id = ${callerId}
               AND operation_id = ${request.operationId} AND request_key = ${key}
          `;
            } else {
              await tx`
            INSERT INTO harness_shared.blueprint_operation_invocations
              (workspace_id, harness_slug, caller_id, operation_id, request_key, request_fingerprint,
               specification_revision, target_kind, target_ref)
            VALUES (${request.workspaceId}, ${request.harnessSlug}, ${callerId}, ${request.operationId}, ${key},
                    ${fingerprint}, ${pin.specificationRevision}, 'work-item', ${recovered.id})
          `;
            }
            return recovered;
          }
          const revision = selectOperationSpecificationRevision(
            request.expectedSpecificationRevision,
            receipt?.specification_revision,
            receipt?.specification_revision || request.expectedSpecificationRevision
              ? null : currentHash,
          );
          const specification = await readBlueprintSpecificationSnapshot(
            tx,
            request.workspaceId,
            request.harnessSlug,
            revision,
          );
          if (!specification) throw new Error('blueprint operation specification snapshot is missing');
          const { operation } = operationFromSpecification(specification, request.operationId);
          if (operation.target.kind !== 'work-item') {
            throw new Error('blueprint operation ' + request.operationId + ' targets a plan, not a direct work item');
          }
          validateOperationInput(operation.inputSchema, input);
          const pin: AcceptedOperationPin = {
            kind: 'blueprint-operation',
            harnessSlug: request.harnessSlug,
            specificationRevision: revision,
            operationId: request.operationId,
            operationVersion: operation.version,
            input,
            callerId,
            requestKey: key,
            requestFingerprint: fingerprint,
          };
          // WI-10003631 (P-013 C): the receipt is written ONCE, after the item
          // exists, with target_ref set. The advisory xact lock above already
          // serializes same-key callers, and the old INSERT-then-UPDATE pair
          // committed together in this same tx, so a crash between
          // createWorkItem and commit leaves no receipt in either shape; the
          // findDirectItemByRequest payload scan recovers it on retry.
          const item = await createWorkItem({
            kind: operation.target.itemKind as WorkItemKind,
            title: request.title.trim(),
            summary: request.summary,
            harness: request.harnessSlug,
            workspaceId: request.workspaceId,
            createdBy: request.createdBy,
            payload: { blueprintOperation: pin },
          });
          if (receipt) {
            await tx`
          UPDATE harness_shared.blueprint_operation_invocations SET target_ref = ${item.id}, updated_at = now()
           WHERE workspace_id = ${request.workspaceId} AND harness_slug = ${request.harnessSlug}
             AND caller_id = ${callerId}
             AND operation_id = ${request.operationId} AND request_key = ${key}
        `;
          } else {
            await tx`
          INSERT INTO harness_shared.blueprint_operation_invocations
            (workspace_id, harness_slug, caller_id, operation_id, request_key, request_fingerprint,
             specification_revision, target_kind, target_ref)
          VALUES (${request.workspaceId}, ${request.harnessSlug}, ${callerId}, ${request.operationId}, ${key},
                  ${fingerprint}, ${revision}, 'work-item', ${item.id})
        `;
          }
          return item;
        })),
    );
  }
  const revision = selectOperationSpecificationRevision(
    request.expectedSpecificationRevision, undefined,
    request.expectedSpecificationRevision ? null : await readBlueprintHashFromPg(sql, request.workspaceId, request.harnessSlug),
  );
  const specification = await readBlueprintSpecificationSnapshot(
    sql,
    request.workspaceId,
    request.harnessSlug,
    revision,
  );
  if (!specification) throw new Error('blueprint operation specification snapshot is missing');
  const { operation } = operationFromSpecification(specification, request.operationId);
  if (operation.target.kind !== 'work-item') {
    throw new Error(`blueprint operation ${request.operationId} targets a plan, not a direct work item`);
  }
  validateOperationInput(operation.inputSchema, input);
  const pin: AcceptedOperationPin = {
    kind: 'blueprint-operation',
    harnessSlug: request.harnessSlug,
    specificationRevision: revision,
    operationId: request.operationId,
    operationVersion: operation.version,
    input,
  };
  return createWorkItem({
    kind: operation.target.itemKind as WorkItemKind,
    title: request.title.trim(),
    summary: request.summary,
    harness: request.harnessSlug,
    workspaceId: request.workspaceId,
    createdBy: request.createdBy,
    payload: { blueprintOperation: pin },
  });
}

export interface AcceptBlueprintPlanRunInput {
  workspaceId: string;
  harnessSlug: string;
  callerId: string;
  operationId: string;
  requestKey: string;
  input: Record<string, unknown>;
  /** Internal program-child call: use the parent's immutable specification. */
  expectedSpecificationRevision?: string;
}

export interface AcceptedBlueprintPlanRun {
  kind: 'plan';
  specificationRevision: string;
  templateSlug: string;
  instanceSlug: string;
  runId: number;
  replayed: boolean;
}

interface PlanInvocationReceiptRow extends InvocationReceiptRow {
  id: number | string;
}

/** Reserve a durable identity before minting the plan instance. A crash after
 * reservation reuses the same plan-run token; a crash after the plan-run seed
 * re-enters runScheduledPlanFire's canonical promotion repair. */
export function acceptBlueprintPlanRun(
  sql: Sql,
  request: AcceptBlueprintPlanRunInput,
): Promise<AcceptedBlueprintPlanRun> {
  return runWithWorkspace(request.workspaceId, () => acceptBlueprintPlanRunScoped(sql, request));
}

async function acceptBlueprintPlanRunScoped(
  sql: Sql,
  request: AcceptBlueprintPlanRunInput,
): Promise<AcceptedBlueprintPlanRun> {
  const callerId = request.callerId?.trim();
  const key = request.requestKey?.trim();
  if (
    !request.workspaceId.trim() ||
    !request.harnessSlug.trim() ||
    !request.operationId.trim() ||
    !callerId ||
    callerId.length > 200 ||
    !key ||
    key.length > 200
  ) {
    throw new Error(
      'plan operation admission requires workspace, harness, operation, authenticated caller and request key',
    );
  }
  // A plan item is an execution leaf. Its accepted worker may submit direct
  // work through the normal item queue, but cannot turn its own plan target
  // into another plan run. Recheck the live applied launch receipt here, not a
  // caller-supplied ancestry hint that can be omitted on transport replay.
  const { readActiveOperationWorkerClaimBinding } = await import('./operation-worker-binding');
  const worker = await readActiveOperationWorkerClaimBinding(request.workspaceId, callerId);
  if (worker.status === 'bound') {
    throw new Error('plan leaf operation cannot recursively relaunch a plan');
  }
  if (worker.status === 'unavailable') {
    throw new Error(`plan operation caller authority unavailable: ${worker.reason}`);
  }
  const input = exactJsonInput(request.input);
  const fingerprint = createHash('sha256')
    .update(
      canonicalJson({
        callerId,
        operationId: request.operationId,
        input,
      }),
    )
    .digest('hex');
  return withInvocationSingleflight(
    {
      workspaceId: request.workspaceId,
      harnessSlug: request.harnessSlug,
      callerId,
      operationId: request.operationId,
      key,
    },
    fingerprint,
    async () => {
      const accepted = await sql.begin(async (tx) => {
        const lockKey =
          'blueprint-operation:' +
          [request.workspaceId, request.harnessSlug, callerId, request.operationId, key].join(':');
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
        const prior = await tx<PlanInvocationReceiptRow[]>`
      SELECT id, request_fingerprint, target_kind, target_ref, specification_revision
        FROM harness_shared.blueprint_operation_invocations
       WHERE workspace_id = ${request.workspaceId} AND harness_slug = ${request.harnessSlug}
         AND caller_id = ${callerId} AND operation_id = ${request.operationId} AND request_key = ${key}
       FOR UPDATE
    `;
        const receipt = prior[0];
        if (receipt && (receipt.request_fingerprint !== fingerprint || receipt.target_kind !== 'plan')) {
          throw new BlueprintOperationRefusal('input_conflict', 'blueprint operation request key was reused with different input or target');
        }
        const revision = selectOperationSpecificationRevision(
          request.expectedSpecificationRevision,
          receipt?.specification_revision,
          receipt?.specification_revision || request.expectedSpecificationRevision
            ? null : await readBlueprintHashFromPg(tx, request.workspaceId, request.harnessSlug),
        );
        const specification = await readBlueprintSpecificationSnapshot(
          tx,
          request.workspaceId,
          request.harnessSlug,
          revision,
        );
        if (!specification) throw new Error('blueprint operation specification snapshot is missing');
        const { operation } = operationFromSpecification(specification, request.operationId);
        if (operation.target.kind !== 'plan') {
          throw new Error('blueprint operation ' + request.operationId + ' targets a direct work item, not a plan');
        }
        validateOperationInput(operation.inputSchema, input);
        if (receipt) return { receipt, revision, template: operation.target.template };
        const inserted = await tx<PlanInvocationReceiptRow[]>`
      INSERT INTO harness_shared.blueprint_operation_invocations
        (workspace_id, harness_slug, caller_id, operation_id, request_key, request_fingerprint,
         specification_revision, target_kind)
      VALUES (${request.workspaceId}, ${request.harnessSlug}, ${callerId}, ${request.operationId}, ${key},
              ${fingerprint}, ${revision}, 'plan')
      RETURNING id, request_fingerprint, target_kind, target_ref, specification_revision
    `;
        return { receipt: inserted[0], revision, template: operation.target.template };
      });
      const { receipt, revision, template } = accepted;
      if (!receipt) throw new Error('blueprint operation invocation receipt was not reserved');
      if (receipt.target_ref) {
        const runs = await sql<Array<{ id: number | string }>>`
      SELECT id FROM harness_shared.plan_runs
       WHERE workspace_id = ${request.workspaceId} AND harness_slug = ${request.harnessSlug}
         AND instance_plan_slug = ${receipt.target_ref}
       LIMIT 1
    `;
        if (!runs[0]) throw new Error('blueprint operation receipt points to a missing plan run');
        return {
          kind: 'plan',
          specificationRevision: revision,
          templateSlug: template.ref,
          instanceSlug: receipt.target_ref,
          runId: Number(runs[0].id),
          replayed: true,
        };
      }
      const fired = await runScheduledPlanFire(sql, {
        installSlug: request.harnessSlug,
        workspaceId: request.workspaceId,
        templateSlug: template.ref,
        trigger: 'event',
        runToken: String(receipt.id),
        inputs: input,
        execution: null,
        expectedTemplate: { revision: template.revision, contentHash: template.contentHash },
      });
      if (!fired.started) {
        throw new Error('blueprint plan operation refused: ' + fired.reason + ': ' + fired.detail);
      }
      const updated = await sql<Array<{ target_ref: string }>>`
    UPDATE harness_shared.blueprint_operation_invocations
       SET target_ref = ${fired.instanceSlug}, updated_at = now()
     WHERE id = ${receipt.id} AND workspace_id = ${request.workspaceId}
       AND (target_ref IS NULL OR target_ref = ${fired.instanceSlug})
     RETURNING target_ref
  `;
      if (!updated[0]) throw new Error('blueprint operation receipt target changed during plan run');
      return {
        kind: 'plan',
        specificationRevision: revision,
        templateSlug: template.ref,
        instanceSlug: fired.instanceSlug,
        runId: fired.runId,
        replayed: fired.replayed,
      };
    },
  );
}

const ScheduledRequestSchema = z.object({
  kind: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  targetHarnessSlug: z.string().min(1),
  blueprintId: z.string().min(1),
}).strict();

const ScheduledMarkerSchema = z.object({
  receiptId: z.string().min(1),
  requestKey: z.string().min(1),
  requestFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  specificationRevision: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

export interface AcceptScheduledBlueprintWorkItemInput {
  workspaceId: string;
  installSlug: string;
  targetHarnessSlug: string;
  callerId: string;
  requestKey: string;
  /** A DBOS workflow retry may resolve a newer blueprint; use the saved input. */
  allowDefinitionDrift: boolean;
  blueprint: Blueprint;
  title: string;
  summary?: string;
  payload?: Record<string, unknown>;
  explicitId?: string;
}

interface ScheduledReceiptRow extends InvocationReceiptRow {
  id: number | string;
  request_payload: unknown;
}

/** Compatibility adapter for blueprint-run's legacy mode='work-item'.
 * Its per-fire receipt is committed before the canonical item create, and
 * target_ref reserves one id even if the worker dies before its response. */
export function acceptScheduledBlueprintWorkItem(
  sql: Sql,
  request: AcceptScheduledBlueprintWorkItemInput,
): Promise<WorkItem> {
  return runWithWorkspace(request.workspaceId, () => acceptScheduledBlueprintWorkItemScoped(sql, request));
}

async function acceptScheduledBlueprintWorkItemScoped(
  sql: Sql,
  request: AcceptScheduledBlueprintWorkItemInput,
): Promise<WorkItem> {
  const callerId = request.callerId.trim();
  const key = request.requestKey.trim();
  const explicitId = request.explicitId?.trim();
  if (!request.workspaceId.trim() || !request.installSlug.trim() || !request.targetHarnessSlug.trim() ||
      !callerId || callerId.length > 200 || !key || key.length > 200 ||
      (request.explicitId !== undefined && (!explicitId || explicitId.length > 120))) {
    throw new Error('scheduled blueprint admission requires valid workspace, harness, caller, request key and optional id');
  }
  const payload = exactJsonInput(request.payload ?? {});
  if (Object.prototype.hasOwnProperty.call(payload, '_blueprintScheduled')) {
    throw new Error('scheduled blueprint input may not supply the reserved _blueprintScheduled marker');
  }
  const proposed = ScheduledRequestSchema.parse({
    kind: request.blueprint.workItem.kind, title: request.title.trim(),
    summary: request.summary ?? null, payload,
    targetHarnessSlug: request.targetHarnessSlug, blueprintId: request.blueprint.id,
  });
  const fingerprint = createHash('sha256').update(canonicalJson(proposed)).digest('hex');
  const identity = { workspaceId: request.workspaceId, harnessSlug: request.installSlug,
    callerId, operationId: '__scheduled_default', key };
  const flightFingerprint = request.allowDefinitionDrift
    ? createHash('sha256').update(canonicalJson(identity)).digest('hex') : fingerprint;
  return withInvocationSingleflight(identity, flightFingerprint, async () => {
    const receipt = await sql.begin(async (tx) => {
      const lockKey = 'blueprint-operation:' + [request.workspaceId, request.installSlug, callerId,
        identity.operationId, key].join(':');
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
      const prior = await tx<ScheduledReceiptRow[]>`
        SELECT id, request_fingerprint, target_kind, target_ref, specification_revision, request_payload
          FROM harness_shared.blueprint_operation_invocations
         WHERE workspace_id = ${request.workspaceId} AND harness_slug = ${request.installSlug}
           AND caller_id = ${callerId} AND operation_id = ${identity.operationId} AND request_key = ${key}
         FOR UPDATE
      `;
      if (prior[0]) {
        if (prior[0].target_kind !== 'work-item' || !prior[0].target_ref) {
          throw new Error('scheduled blueprint receipt has no reserved work-item identity');
        }
        if (!request.allowDefinitionDrift && prior[0].request_fingerprint !== fingerprint) {
          throw new Error('scheduled blueprint request key was reused with different input');
        }
        return prior[0];
      }
      const specification = compileAgentSpecification({ source: request.blueprint });
      const revision = await retainBlueprintSpecificationSnapshot(tx, {
        workspaceId: request.workspaceId, harnessSlug: request.installSlug, specification,
      });
      const targetRef = explicitId ?? (await tx<{ id: string }[]>`SELECT harness_shared.next_work_item_id() AS id`)[0].id;
      const saved = JSON.stringify(proposed);
      const rows = await tx<ScheduledReceiptRow[]>`
        INSERT INTO harness_shared.blueprint_operation_invocations
          (workspace_id, harness_slug, caller_id, operation_id, request_key, request_fingerprint,
           specification_revision, target_kind, target_ref, request_payload)
        VALUES (${request.workspaceId}, ${request.installSlug}, ${callerId}, ${identity.operationId},
                ${key}, ${fingerprint}, ${revision}, 'work-item', ${targetRef}, ${saved}::text::jsonb)
        RETURNING id, request_fingerprint, target_kind, target_ref, specification_revision, request_payload
      `;
      return rows[0];
    });
    if (!receipt || !receipt.target_ref) throw new Error('scheduled blueprint receipt was not reserved');
    const saved = ScheduledRequestSchema.parse(receipt.request_payload);
    const marker = { receiptId: String(receipt.id), requestKey: key,
      requestFingerprint: receipt.request_fingerprint, specificationRevision: receipt.specification_revision };
    const matchesReceipt = (item: WorkItem): boolean => {
      const itemPayload = item.payload && typeof item.payload === 'object' && !Array.isArray(item.payload)
        ? item.payload as Record<string, unknown> : {};
      const parsed = ScheduledMarkerSchema.safeParse(itemPayload._blueprintScheduled);
      return parsed.success && isDeepStrictEqual(parsed.data, marker) && item.kind === saved.kind;
    };
    const existing = await getWorkItem(receipt.target_ref, saved.targetHarnessSlug);
    if (existing) {
      if (!matchesReceipt(existing)) throw new Error('scheduled blueprint receipt target conflicts with another work item');
      return existing;
    }
    try {
      const item = await createWorkItem({
        id: receipt.target_ref, kind: saved.kind as WorkItemKind, title: saved.title,
        summary: saved.summary ?? undefined, harness: saved.targetHarnessSlug,
        workspaceId: request.workspaceId, createdBy: callerId,
        payload: { ...saved.payload, _blueprintScheduled: marker },
      });
      if (!matchesReceipt(item)) throw new Error('scheduled blueprint created item lost its receipt pin');
      return item;
    } catch (error) {
      const winner = await getWorkItem(receipt.target_ref, saved.targetHarnessSlug);
      if (winner && matchesReceipt(winner)) return winner;
      throw error;
    }
  });
}

/** Resolve an accepted item from its retained revision, never the current cache. */
export async function readAcceptedBlueprintDirectWorkItem(sql: Sql, workspaceId: string, item: WorkItem) {
  const payload =
    item.payload && typeof item.payload === 'object' && !Array.isArray(item.payload)
      ? (item.payload as Record<string, unknown>)
      : {};
  const pin = AcceptedOperationPinSchema.parse(payload.blueprintOperation);
  const specification = await readBlueprintSpecificationSnapshot(
    sql,
    workspaceId,
    pin.harnessSlug,
    pin.specificationRevision,
  );
  if (!specification) throw new Error('accepted blueprint operation specification snapshot is missing');
  const { operation } = operationFromSpecification(specification, pin.operationId);
  if (
    operation.target.kind !== 'work-item' ||
    operation.version !== pin.operationVersion ||
    operation.target.itemKind !== item.kind
  ) {
    throw new Error('accepted blueprint operation pin does not match the work item');
  }
  validateOperationInput(operation.inputSchema, pin.input);
  return { pin, operation, specification };
}
