/** Resolve a worker's authority from the accepted operation, never launch args. */
import type { JSONValue, Sql } from 'postgres';
import { isDeepStrictEqual } from 'node:util';
import { getOrgPg } from '@papercusp/db-org';
import { normalizeModelId } from '@papercusp/model-pricing';
import { getWorkItem, type WorkItem } from '../work-items';
import { workItemStorageSlug } from '../pot-membership';
import { ANY_FAMILY_TERMINAL_STATES } from '../work-item-dispatch-states';
import { runWithWorkspace } from '../workspace-als';
import { getIdentitySource } from '../agent-identities/source';
import { normalizeSessionActivation } from '../session-activation';
import { resolveCodexModel } from '../model-context-budget.mjs';
import { readAcceptedBlueprintDirectWorkItem, type AcceptedOperationPin } from './operation-admission';

export interface AcceptedOperationWorkerBinding {
  workItemId: string;
  /** The harness the operation was accepted for: the launch harness and `pin.harnessSlug`. */
  harnessSlug: string;
  /** The `harness_slug` the accepted work-item row is STORED under. createWorkItem re-homes
   * a pot MEMBER harness's item to the pot home slug, so this differs from `harnessSlug`
   * for a potted harness (WI-10004367). Row lookups use this; pin comparisons never do. */
  storageHarnessSlug: string;
  operationId: string;
  specificationRevision: string;
  pin: AcceptedOperationPin;
  identity: { ref: string; revision: string; contentHash: string };
  stack: string[];
  requiredTools: string[];
  modelPolicy?: {
    mode: 'exact' | 'allowed' | 'preferred';
    models: readonly string[];
    effort?: string;
    onUnavailable: 'wait' | 'fail';
  };
  modelSelection?: {
    model: string;
    requestedModel: string | null;
    backend: 'claude' | 'omp' | 'codex';
    source: 'operation-policy';
  };
}

const MODEL_EFFORT_SUFFIX = /:(low|medium|high|xhigh|max|ultra)$/i;

/** A blueprint worker launches on a model from its accepted specification,
 * even when the caller supplied a compatible alias. The caller's selector
 * can choose within an allowed/preferred list but cannot widen that list. */
export function selectAcceptedOperationWorkerModel(
  binding: AcceptedOperationWorkerBinding | null,
  requestedModel: string | null,
  backend: 'claude' | 'omp' | 'codex',
): AcceptedOperationWorkerBinding['modelSelection'] | null {
  const policy = binding?.modelPolicy;
  if (!policy) return null;
  // OMP can egress directly to several providers, while the canonical
  // completion verifier currently has provider evidence for Claude/Codex
  // request grains only. Refuse before account selection or session creation
  // instead of letting an OMP worker run and fail attestation afterward.
  if (backend === 'omp') {
    throw new Error('accepted model policy has no verifiable OMP provider response path');
  }
  const canonical = (value: string) => normalizeModelId(
    backend === 'codex' ? resolveCodexModel(value) : value,
  );
  const provider = (value: string) => {
    const slash = value.indexOf('/');
    return slash > 0 ? value.slice(0, slash).toLowerCase() : null;
  };
  const requestedId = requestedModel ? canonical(requestedModel) : null;
  const selected = requestedId
    ? policy.models.find((candidate) => canonical(candidate) === requestedId &&
        (!provider(requestedModel!) || !provider(candidate) || provider(requestedModel!) === provider(candidate)))
    : policy.models[0];
  if (!selected) throw new Error(`requested model is outside the accepted ${policy.mode} model policy`);
  const chosenEffort = MODEL_EFFORT_SUFFIX.exec(selected)?.[1]?.toLowerCase();
  const requestedEffort = requestedModel ? MODEL_EFFORT_SUFFIX.exec(requestedModel)?.[1]?.toLowerCase() : undefined;
  const requiredEffort = policy.effort?.toLowerCase();
  if ((requiredEffort && chosenEffort && requiredEffort !== chosenEffort) ||
      (requiredEffort && requestedEffort && requiredEffort !== requestedEffort) ||
      (chosenEffort && requestedEffort && chosenEffort !== requestedEffort)) {
    throw new Error('requested reasoning effort differs from the accepted model policy');
  }
  const effort = requiredEffort ?? requestedEffort ?? chosenEffort;
  let model = selected.replace(MODEL_EFFORT_SUFFIX, '') + (effort ? `:${effort}` : '');
  if (backend === 'codex') {
    model = resolveCodexModel(model);
    if (!model.startsWith('gpt-')) throw new Error('accepted model is not supported by the Codex backend');
  } else if (backend === 'claude') {
    const slash = model.indexOf('/');
    if (slash > 0) {
      if (model.slice(0, slash) !== 'anthropic') throw new Error('accepted model uses a non-Anthropic provider');
      model = model.slice(slash + 1);
    }
    const bareModel = model.replace(MODEL_EFFORT_SUFFIX, '').replace(/\[1m\]$/i, '');
    if (!/^claude-[a-z0-9-]+$/i.test(bareModel) && !/^(opus|sonnet|haiku|fable)$/i.test(bareModel)) {
      throw new Error('accepted model is not supported by the Claude backend');
    }
  }
  return { model, requestedModel, backend, source: 'operation-policy' };
}

export type ActiveOperationWorkerClaimRead =
  | { status: 'bound'; binding: AcceptedOperationWorkerBinding; receipt: {
      sessionId: number;
      workspaceId: string;
      ownerId: string;
      specificationRevision: string;
      stateRevision: string;
      acceptedOperation: Record<string, unknown>;
    } }
  | { status: 'none' }
  | { status: 'unavailable'; reason: string };

export interface ActiveOperationAttestationContext {
  operationReceiptId: number;
  advSessionId: number;
  nativeSessionId: string;
  workspaceId: string;
  ownerId: string;
  harnessSlug: string;
  workItemId: string;
  operationId: string;
  specificationRevision: string;
}

export type ActiveOperationModelPolicyRead =
  | { status: 'bound'; policy: NonNullable<AcceptedOperationWorkerBinding['modelPolicy']>;
      attestation: ActiveOperationAttestationContext | null }
  | { status: 'none' }
  | { status: 'unavailable'; reason: string };

/** Re-read the immutable accepted operation before the gateway changes a model.
 * The applied session receipt identifies the worker; its model-policy copy must
 * still agree with the specification pinned by the canonical work item. */
export async function readActiveOperationModelPolicy(
  workspaceId: string,
  ownerId: string,
  backend: 'claude' | 'omp' | 'codex' = 'claude',
): Promise<ActiveOperationModelPolicyRead> {
  const active = await readActiveOperationWorkerClaimBinding(workspaceId, ownerId);
  if (active.status !== 'bound') return active;
  try {
    return await runWithWorkspace(workspaceId, async () => {
      const item = await getWorkItem(active.binding.workItemId, active.binding.storageHarnessSlug);
      if (!item || item.harness !== active.binding.storageHarnessSlug) {
        return { status: 'unavailable', reason: 'accepted operation work item is missing' } as const;
      }
      const { pin, operation } = await readAcceptedBlueprintDirectWorkItem(getOrgPg().sql, workspaceId, item);
      if (!isDeepStrictEqual(pin, active.binding.pin) ||
          operation.id !== active.binding.operationId ||
          pin.specificationRevision !== active.binding.specificationRevision) {
        return { status: 'unavailable', reason: 'accepted operation model pin changed' } as const;
      }
      const policy = operation.policy.model;
      const receiptPolicy = active.receipt.acceptedOperation.modelPolicy;
      if (!policy && receiptPolicy == null) return { status: 'none' } as const;
      if (!policy || !isDeepStrictEqual(policy, receiptPolicy)) {
        return { status: 'unavailable', reason: 'accepted operation model policy differs from its launch receipt' } as const;
      }
      const selection = active.receipt.acceptedOperation.modelSelection;
      if (!selection || typeof selection !== 'object' || Array.isArray(selection)) {
        return { status: 'unavailable', reason: 'accepted operation model selection is missing' } as const;
      }
      const selected = selection as Record<string, unknown>;
      if (selected.backend !== backend ||
          (selected.requestedModel !== null && typeof selected.requestedModel !== 'string') ||
          !isDeepStrictEqual(
            selectAcceptedOperationWorkerModel(
              { ...active.binding, modelPolicy: policy }, selected.requestedModel as string | null, backend,
            ),
            selection,
          )) {
        return { status: 'unavailable', reason: 'accepted operation model selection differs from its policy' } as const;
      }
      // Resolve the existing operation invocation, not a caller-supplied
      // request key, as the durable event stream for actual model evidence.
      // Direct legacy admissions without an invocation remain policy-bound but
      // have no attestation sink; a later writer must fail closed on null.
      const [receipt] = await getOrgPg().sql<Array<{
        native_session_id: string | null;
        session_backend: string | null;
        operation_receipt_id: string | number | null;
      }>>`
        SELECT s.session_id AS native_session_id, s.agent AS session_backend,
               i.id AS operation_receipt_id
          FROM harness_shared.adv_sessions s
          LEFT JOIN harness_shared.blueprint_operation_invocations i
            ON i.workspace_id = s.workspace_id
           AND i.harness_slug = ${active.binding.harnessSlug}
           AND i.target_kind = 'work-item' AND i.target_ref = ${active.binding.workItemId}
           AND i.operation_id = ${active.binding.operationId}
           AND i.specification_revision = ${active.binding.specificationRevision}
           AND i.caller_id = ${active.binding.pin.callerId ?? null}
           AND i.request_key = ${active.binding.pin.requestKey ?? null}
           AND i.request_fingerprint = ${active.binding.pin.requestFingerprint ?? null}
         WHERE s.id = ${active.receipt.sessionId}
           AND s.workspace_id = ${workspaceId} AND s.coord_owner_id = ${ownerId}
           AND s.ended_at IS NULL AND s.ended_by IS NULL
      `;
      if (!receipt) return { status: 'unavailable', reason: 'accepted operation worker session ended' } as const;
      if (receipt.session_backend !== backend) {
        return { status: 'unavailable', reason: 'accepted operation backend differs from its active worker session' } as const;
      }
      const operationReceiptId = Number(receipt.operation_receipt_id);
      const attestation = receipt.native_session_id && Number.isSafeInteger(operationReceiptId) && operationReceiptId > 0
        ? { operationReceiptId, advSessionId: active.receipt.sessionId,
            nativeSessionId: receipt.native_session_id, workspaceId, ownerId,
            harnessSlug: active.binding.harnessSlug, workItemId: active.binding.workItemId,
            operationId: active.binding.operationId,
            specificationRevision: active.binding.specificationRevision }
        : null;
      return { status: 'bound', policy, attestation } as const;
    });
  } catch {
    return { status: 'unavailable', reason: 'accepted operation model policy could not be verified' };
  }
}

/** A worker can claim only the direct item named by its applied launch receipt.
 * Ordinary sessions retain ordinary items; a pinned item requires its worker.
 * The SQL claim writer must repeat these pin comparisons in its UPDATE so a
 * changed payload cannot slip through after this read. */
export function matchOperationWorkerClaim(
  read: ActiveOperationWorkerClaimRead,
  item: { id: string; harness: string | null; payload: unknown },
): { allowed: true } | { allowed: false; reason: string } {
  if (read.status === 'unavailable') return { allowed: false, reason: read.reason };
  const payload = item.payload && typeof item.payload === 'object' && !Array.isArray(item.payload)
    ? item.payload as Record<string, unknown> : null;
  const pin = payload?.blueprintOperation;
  if (read.status === 'none') return pin === undefined
    ? { allowed: true }
    : { allowed: false, reason: 'accepted operation item requires its applied worker' };
  if (!pin || typeof pin !== 'object' || Array.isArray(pin)) {
    return { allowed: false, reason: 'operation worker cannot claim an unpinned item' };
  }
  const accepted = pin as Record<string, unknown>;
  const binding = read.binding;
  if (item.id !== binding.workItemId || item.harness !== binding.storageHarnessSlug ||
      accepted.kind !== 'blueprint-operation' || accepted.harnessSlug !== binding.harnessSlug ||
      accepted.operationId !== binding.operationId ||
      accepted.specificationRevision !== binding.specificationRevision ||
      !isDeepStrictEqual(accepted, binding.pin)) {
    return { allowed: false, reason: 'work item differs from the applied operation receipt' };
  }
  return { allowed: true };
}

/** Repeat the receipt/pin match inside the claiming UPDATE. The preceding
 * read gives a useful refusal reason; this predicate is the race fence. */
export function operationWorkerClaimWhereSql(
  sql: Sql,
  read: ActiveOperationWorkerClaimRead,
  columns: {
    payload: 'target.payload' | 'payload' | 'wi.payload';
    id: 'target.feature_id' | 'target.issue_id' | 'feature_id' | 'wi.feature_id';
    harness: 'target.harness_slug' | 'target.scope' | 'harness_slug' | 'wi.harness_slug';
  },
) {
  if (read.status === 'unavailable') return sql`FALSE`;
  const payload = sql.unsafe(columns.payload);
  if (read.status === 'none') return sql`NOT (COALESCE(${payload}, '{}'::jsonb) ? 'blueprintOperation')`;
  const pin = sql`(${payload} -> 'blueprintOperation')`;
  const binding = read.binding;
  const receipt = read.receipt;
  return sql`(
    ${sql.unsafe(columns.id)} = ${binding.workItemId}
    AND ${sql.unsafe(columns.harness)} = ${columns.harness === 'target.scope'
      ? (binding.storageHarnessSlug ? `harness:${binding.storageHarnessSlug}` : 'operator')
      : binding.storageHarnessSlug}
    AND ${pin} ->> 'kind' = 'blueprint-operation'
    AND ${pin} ->> 'harnessSlug' = ${binding.harnessSlug}
    AND ${pin} ->> 'operationId' = ${binding.operationId}
    AND ${pin} ->> 'specificationRevision' = ${binding.specificationRevision}
    AND ${pin} = ${sql.json(binding.pin as JSONValue)}
    AND EXISTS (
      SELECT 1 FROM harness_shared.adv_sessions s
      JOIN harness_shared.session_briefs b
        ON b.workspace_id = s.workspace_id AND b.owner_id = s.coord_owner_id
      WHERE s.id = ${receipt.sessionId}
        AND s.workspace_id = ${receipt.workspaceId}
        AND s.coord_owner_id = ${receipt.ownerId}
        AND s.ended_at IS NULL AND s.ended_by IS NULL
        AND s.launch_spec->'acceptedOperation' = ${sql.json(receipt.acceptedOperation as JSONValue)}
        AND s.launch_spec->>'specificationRevision' = ${receipt.specificationRevision}
        AND s.launch_spec->>'stateRevision' = ${receipt.stateRevision}
        AND b.control_state->'activation'->>'status' = 'applied'
        AND b.control_state->'activation'->'applied'->>'specificationRevision' = ${receipt.specificationRevision}
        AND b.control_state->'activation'->'applied'->>'stateRevision' = ${receipt.stateRevision}
        AND b.control_state->'activation'->'attribution'->>'sessionId' = ${receipt.ownerId}
    )
  )`;
}

/** A claim receipt is not an effect lease. A worker must still hold the item
 * when a state or completion write reaches its canonical SQL writer. */
export function operationWorkerEffectWhereSql(
  sql: Sql,
  read: ActiveOperationWorkerClaimRead,
  columns: Parameters<typeof operationWorkerClaimWhereSql>[2] & {
    holder: 'taken_by' | 'wi.taken_by';
  },
) {
  const claim = operationWorkerClaimWhereSql(sql, read, columns);
  return read.status === 'bound'
    ? sql`${claim} AND ${sql.unsafe(columns.holder)} = ${read.receipt.ownerId}`
    : claim;
}

/** The program executor has a receipt, not an applied agent-session claim.
 * Carry the root's admission-row timestamp in its durable DBOS input. Any
 * unrelated mutation, completion/reopen, or cancellation that changes the
 * canonical row makes its old attempt unable to close successfully. */
export interface AcceptedProgramRootAttempt {
  workspaceId: string;
  /** The harness the operation was accepted for; receipt and pin comparisons use it. */
  harnessSlug: string;
  /** The `harness_slug` the root row is STORED under: the pot home slug for a pot member's
   * root (WI-10004562 / D-045), as `AcceptedOperationWorkerBinding.storageHarnessSlug` is for
   * an agent operation. Row matching uses this; pin comparisons never do. */
  storageHarnessSlug: string;
  workItemId: string;
  receiptId: number;
  operationId: string;
  specificationRevision: string;
  updatedTs: number;
  requireUncancelled: boolean;
}

export async function validateAcceptedProgramRootAttempt(
  attempt: AcceptedProgramRootAttempt,
  item: WorkItem,
): Promise<void> {
  if (!Number.isSafeInteger(attempt.receiptId) || attempt.receiptId <= 0 ||
      !Number.isSafeInteger(attempt.updatedTs) || attempt.updatedTs <= 0 ||
      attempt.workItemId !== item.id || attempt.storageHarnessSlug !== item.harness) {
    throw new Error('accepted program root attempt is stale or malformed');
  }
  const { pin, operation } = await readAcceptedBlueprintDirectWorkItem(
    getOrgPg().sql, attempt.workspaceId, item,
  );
  if (operation.execution?.kind !== 'program' || pin.operationId !== attempt.operationId ||
      pin.specificationRevision !== attempt.specificationRevision) {
    throw new Error('accepted program root attempt does not match the pinned program');
  }
}

/** Repeat the program receipt, immutable kind, status and attempt epoch inside
 * the canonical state UPDATE. This is a narrow alternative to the agent worker
 * effect predicate, never a general bypass of accepted-operation authority. */
export function programRootEffectWhereSql(
  sql: Sql,
  attempt: AcceptedProgramRootAttempt,
  columns: { payload: 'payload' | 'wi.payload'; id: 'feature_id' | 'wi.feature_id';
    harness: 'harness_slug' | 'wi.harness_slug'; status: 'status' | 'wi.status';
    updated: 'updated_ts' | 'wi.updated_ts' },
) {
  const payload = sql.unsafe(columns.payload);
  return sql`(
    ${sql.unsafe(columns.id)} = ${attempt.workItemId}
    AND ${sql.unsafe(columns.harness)} IN (${attempt.storageHarnessSlug}, ${`harness:${attempt.harnessSlug}`})
    AND ${sql.unsafe(columns.updated)} = ${attempt.updatedTs}
    AND NOT (${sql.unsafe(columns.status)} = ANY(${ANY_FAMILY_TERMINAL_STATES as string[]}::text[]))
    AND NOT (COALESCE(${payload}, '{}'::jsonb) ? 'reopenHistory')
    AND (${!attempt.requireUncancelled} OR NOT (COALESCE(${payload}, '{}'::jsonb) ? 'blueprintCancellation'))
    AND EXISTS (
      SELECT 1 FROM harness_shared.blueprint_operation_invocations i
      JOIN harness_shared.blueprint_specifications s
        ON s.workspace_id = i.workspace_id AND s.harness_slug = i.harness_slug
       AND s.specification_revision = i.specification_revision
     WHERE i.id = ${attempt.receiptId} AND i.workspace_id = ${attempt.workspaceId}
       AND i.harness_slug = ${attempt.harnessSlug}
       AND i.target_kind = 'work-item' AND i.target_ref = ${attempt.workItemId}
       AND i.operation_id = ${attempt.operationId}
       AND i.specification_revision = ${attempt.specificationRevision}
       AND ${payload}->'blueprintOperation'->>'callerId' = i.caller_id
       AND ${payload}->'blueprintOperation'->>'requestKey' = i.request_key
       AND ${payload}->'blueprintOperation'->>'requestFingerprint' = i.request_fingerprint
       AND ${payload}->'blueprintOperation'->>'specificationRevision' = i.specification_revision
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(s.artifact->'configuration'->'operations') op
          WHERE op->>'id' = i.operation_id AND op->'execution'->>'kind' = 'program'
            AND op->'target'->>'kind' = 'work-item'
       )
    )
  )`;
}

const RECEIPT_READ_FAULT = 'active operation worker receipt could not be read';

/** EI-24400810686776632: the receipt read fails CLOSED on any error, which is right, but a
 * bare reason hid the commonest cause: a test database that never built a relation this read
 * joins (adv_sessions, session_briefs). Name a SCHEMA fault (missing relation / column) so the
 * refusal points at the missing table; a transient fault keeps the generic reason. */
export function describeOperationReceiptReadFault(err: unknown): string {
  const e = err && typeof err === 'object' ? err as { code?: unknown; message?: unknown } : null;
  if (e && (e.code === '42P01' || e.code === '42703') && typeof e.message === 'string' && e.message) {
    return `${RECEIPT_READ_FAULT}: ${e.message} (SQLSTATE ${e.code}; the database lacks a relation or column this read needs)`;
  }
  return RECEIPT_READ_FAULT;
}

/** Read the current, applied operation identity for a claim target. A launch
 * request is only a desired identity; it cannot authorize a claim until the
 * host has applied it. Read a small role header first so ordinary SU pulls do
 * not detoast their large launch_spec on every scheduler call. */
export async function readActiveOperationWorkerClaimBinding(
  workspaceId: string,
  ownerId: string,
  opts?: { sql?: Sql; throwOnError?: boolean },
): Promise<ActiveOperationWorkerClaimRead> {
  if (!workspaceId.trim() || !ownerId.trim()) return { status: 'unavailable', reason: 'claim target scope is missing' };
  try {
    const sql = opts?.sql ?? getOrgPg().sql;
    const [session] = await sql<Array<{ id: number; role: string | null }>>`
      SELECT id, role FROM harness_shared.adv_sessions
       WHERE workspace_id = ${workspaceId} AND coord_owner_id = ${ownerId}
         AND ended_at IS NULL AND ended_by IS NULL
       ORDER BY started_at DESC, id DESC LIMIT 1
    `;
    if (!session || !session.role || session.role === 'su') return { status: 'none' };
    const [row] = await sql<Array<{
      accepted_operation: unknown;
      launch_workspace_id: string | null;
      launch_harness_slug: string | null;
      launch_role: string | null;
      specification_revision: string | null;
      state_revision: string | null;
      grants_kind: string | null;
      activation: unknown;
    }>>`
      SELECT s.launch_spec->'acceptedOperation' AS accepted_operation,
             s.launch_spec->>'workspaceId' AS launch_workspace_id,
             s.launch_spec->>'harnessSlug' AS launch_harness_slug,
             s.launch_spec->>'role' AS launch_role,
             s.launch_spec->>'specificationRevision' AS specification_revision,
             s.launch_spec->>'stateRevision' AS state_revision,
             jsonb_typeof(s.launch_spec->'specificationArtifact'->'configuration'->'grants') AS grants_kind,
             b.control_state->'activation' AS activation
        FROM harness_shared.adv_sessions s
        LEFT JOIN harness_shared.session_briefs b
          ON b.workspace_id = s.workspace_id AND b.owner_id = s.coord_owner_id
       WHERE s.id = ${session.id} AND s.workspace_id = ${workspaceId}
         AND s.coord_owner_id = ${ownerId} AND s.ended_at IS NULL AND s.ended_by IS NULL
    `;
    if (!row) return { status: 'unavailable', reason: 'role session ended during claim admission' };
    if (row.accepted_operation == null) return { status: 'none' };
    const accepted = row.accepted_operation && typeof row.accepted_operation === 'object' &&
      !Array.isArray(row.accepted_operation) ? row.accepted_operation as Record<string, unknown> : null;
    const identity = accepted?.identity && typeof accepted.identity === 'object' &&
      !Array.isArray(accepted.identity) ? accepted.identity as Record<string, unknown> : null;
    const pin = accepted?.pin && typeof accepted.pin === 'object' &&
      !Array.isArray(accepted.pin) ? accepted.pin as Record<string, unknown> : null;
    const requiredTools = accepted?.requiredTools;
    if (row.launch_workspace_id !== workspaceId || !row.launch_harness_slug ||
        row.launch_role !== session.role || row.grants_kind !== 'object' ||
        !/^[0-9a-f]{64}$/.test(row.specification_revision ?? '') || !row.state_revision ||
        accepted?.kind !== 'blueprint-operation-worker' ||
        typeof accepted.workItemId !== 'string' || !accepted.workItemId ||
        typeof accepted.operationId !== 'string' || !accepted.operationId ||
        !/^[0-9a-f]{64}$/.test(String(accepted.specificationRevision ?? '')) ||
        pin?.kind !== 'blueprint-operation' || pin.harnessSlug !== row.launch_harness_slug ||
        pin.operationId !== accepted.operationId ||
        pin.specificationRevision !== accepted.specificationRevision ||
        typeof pin.operationVersion !== 'string' || !pin.operationVersion ||
        !pin.input || typeof pin.input !== 'object' || Array.isArray(pin.input) ||
        typeof identity?.ref !== 'string' || !identity.ref ||
        typeof identity.revision !== 'string' || !identity.revision ||
        !/^[0-9a-f]{64}$/.test(String(identity.contentHash ?? '')) ||
        !Array.isArray(requiredTools) ||
        !requiredTools.every((name) => typeof name === 'string' && name.length > 0)) {
      return { status: 'unavailable', reason: 'active operation worker receipt is malformed' };
    }
    let activation;
    try {
      activation = normalizeSessionActivation(row.activation);
    } catch {
      return { status: 'unavailable', reason: 'active operation worker activation is malformed' };
    }
    if (activation?.status !== 'applied' ||
        activation.applied?.specificationRevision !== row.specification_revision ||
        activation.applied.stateRevision !== row.state_revision ||
        activation.attribution.sessionId !== ownerId) {
      return { status: 'unavailable', reason: 'active operation worker identity is not applied' };
    }
    // WI-10004367: the accepted row lives under the pot home when the launch harness is a
    // pot MEMBER. Resolved here, once, because the claim race fence is synchronous SQL.
    // workItemStorageSlug fails open to the launch slug, which only ever narrows a claim.
    const storageHarnessSlug = await workItemStorageSlug(row.launch_harness_slug, workspaceId);
    return {
      status: 'bound',
      receipt: {
        sessionId: session.id,
        workspaceId,
        ownerId,
        specificationRevision: row.specification_revision as string,
        stateRevision: row.state_revision as string,
        acceptedOperation: accepted,
      },
      binding: {
        workItemId: accepted.workItemId,
        harnessSlug: row.launch_harness_slug,
        storageHarnessSlug,
        operationId: accepted.operationId,
        specificationRevision: accepted.specificationRevision as string,
        pin: pin as AcceptedOperationPin,
        identity: { ref: identity.ref, revision: identity.revision, contentHash: identity.contentHash as string },
        stack: [`domain:${identity.ref}`],
        requiredTools: [...new Set(requiredTools as string[])].sort(),
      },
    };
  } catch (err) {
    // The scheduler's bounded transaction must see PostgreSQL timeout errors intact
    // so it can report contention rather than a generic operation-authority failure.
    if (opts?.throwOnError) throw err;
    return { status: 'unavailable', reason: describeOperationReceiptReadFault(err) };
  }
}

export async function resolveAcceptedOperationWorkerBinding(input: {
  sql: Sql;
  workspaceId: string;
  harnessSlug: string;
  workItemId: string;
  role: string;
  repoDir: string;
}): Promise<AcceptedOperationWorkerBinding | null> {
  return runWithWorkspace(input.workspaceId, async () => {
    // WI-10004367: a pot MEMBER harness's accepted item is stored under the pot home slug.
    const storageHarnessSlug = await workItemStorageSlug(input.harnessSlug, input.workspaceId);
    const item = await getWorkItem(input.workItemId, storageHarnessSlug);
    if (!item || item.harness !== storageHarnessSlug) {
      throw new Error('operation worker launch requires a work item in its harness');
    }
    const payload = item.payload && typeof item.payload === 'object' && !Array.isArray(item.payload)
      ? item.payload as Record<string, unknown> : null;
    if (!payload?.blueprintOperation) return null;

    const { pin, operation } = await readAcceptedBlueprintDirectWorkItem(input.sql, input.workspaceId, item);
    if (pin.harnessSlug !== input.harnessSlug) {
      throw new Error('operation worker launch requires a work item in its harness');
    }
    if (operation.execution?.kind !== 'agent' || operation.execution.role !== input.role) {
      throw new Error('accepted blueprint operation does not authorize this worker role');
    }
    const ref = operation.policy.identity;
    if (!ref) throw new Error('accepted blueprint agent operation has no pinned worker identity');
    const source = await getIdentitySource(ref.ref, { repoDir: input.repoDir });
    if (!source.ok || !source.sourcePath || source.identity.id !== ref.ref ||
        source.identity.version !== ref.revision || source.contentHash !== ref.contentHash) {
      throw new Error('accepted blueprint worker identity is missing or differs from its pinned revision');
    }
    if (source.identity.grants == null) {
      throw new Error('accepted blueprint worker identity must declare grants explicitly');
    }
    if (source.identity.slots.length !== 1 || source.identity.slots[0]?.slot !== 'domain') {
      throw new Error('accepted blueprint worker identity must fill exactly the domain slot');
    }
    const requiredTools = [...new Set(operation.policy.requiredTools)].sort();
    return {
      workItemId: item.id,
      harnessSlug: input.harnessSlug,
      storageHarnessSlug,
      operationId: pin.operationId,
      specificationRevision: pin.specificationRevision,
      pin,
      identity: { ref: ref.ref, revision: ref.revision, contentHash: ref.contentHash },
      stack: [`domain:${ref.ref}`],
      requiredTools,
      ...(operation.policy.model ? { modelPolicy: operation.policy.model } : {}),
    };
  });
}
