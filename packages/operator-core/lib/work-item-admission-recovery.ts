/** Original-item admission recovery, stored on the item and run by its existing promoter. */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { z } from 'zod';
import { getHarnessAdminUrl } from './embedded-pg-discovery';
import { getPresence } from './agent-tools/coordination/presence';
import {
  authorizeWorkItemDispatch,
  assignAndWakeActionableWorkItems,
} from './agent-tools/coordination/actionable-work-item-dispatch';
import { WORK_ITEM_ADMISSION_PROMOTER } from './work-items-admission-promoter';
import { issueOwnAuthorWhereSql } from './work-items-admission';
import { decodeOperatorSecretKey } from './operator-secret-key';
import { getModes } from './modes/store';
import { AUDIT_MODE, auditModeMutationDenyReason } from './capability-envelope/audit-mode-guard';
import { readOperatorState } from './operator-state-pg';
import type { SessionConfinementsPayload } from './capability-envelope/session-confinement-store';
import { evaluateSessionConfinement } from './capability-envelope/session-confinement';
import { DEFAULT_INBOX_BODY_CAP } from './agent-tools/coordination/tools/inbox-content-bounds';
import {
  admissionAuthoritySchema, authorizeAdmissionReplay, AdmissionAuthorityRefused,
  type AdmissionRecoveryAuthority,
} from './work-item-admission-authority';

const recoveryStageSchema = z.enum(['queued', 'authorize', 'screen', 'assign', 'wake', 'await-pickup']);
const requestSchema = z.object({
  version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  requestId: z.string().uuid(),
  caller: z.string().min(1),
  target: z.string().min(1),
  routineId: z.string().min(1),
  signature: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(['queued', 'delivered', 'held']),
  requestedAt: z.string(),
  updatedAt: z.string(),
  reason: z.string().optional(),
  /** Last observed stage, never a grant or proof that the target executed. */
  stage: recoveryStageSchema.optional(),
  /** Only a later target-owned pickup can establish execution. */
  pickupConfirmed: z.literal(false),
  note: z.string().min(1).max(DEFAULT_INBOX_BODY_CAP).optional(),
  body: z.string().max(DEFAULT_INBOX_BODY_CAP).optional(),
  authority: admissionAuthoritySchema.optional(),
}).refine((r) => r.version !== 1 || (r.note === undefined && r.body === undefined), {
  message: 'v1 recovery requests cannot carry unsigned instructions',
}).refine((r) => r.version === 3 || r.authority === undefined, {
  message: 'legacy recovery requests cannot carry unsigned authority',
}).refine((r) => r.version !== 3 || r.authority !== undefined, {
  message: 'v3 recovery requests require authenticated authority',
});
export type AdmissionRecoveryRequest = z.infer<typeof requestSchema>;
export interface AdmissionRecoveryScope {
  workspaceId: string;
  harnessSlug: string;
  workItemId: string;
}
const ADMISSION_RECOVERY_LOCK_NAMESPACE = 'admission-recovery';

function admissionRecoveryLockKey(scope: AdmissionRecoveryScope): string {
  return JSON.stringify([
    ADMISSION_RECOVERY_LOCK_NAMESPACE, scope.workspaceId, scope.harnessSlug, scope.workItemId,
  ]);
}

/** Session locks must bypass getOrgPg's PgBouncer transaction pool. */
function createAdmissionRecoveryLockSql(): postgres.Sql {
  return postgres(getHarnessAdminUrl(), {
    onnotice: () => {},
    max: 1,
    idle_timeout: 0,
    connection: { application_name: 'pcusp:admission-recovery-lock:p' + process.pid },
  });
}

interface RecoveryItem {
  feature_id: string;
  status: string;
  origin: string;
  taken_by: string | null;
  admission: string | null;
  payload: Record<string, unknown> | null;
}
export interface AdmissionRecoveryDeps {
  authorize: (scope: AdmissionRecoveryScope, request: Pick<AdmissionRecoveryRequest, 'caller' | 'target' | 'authority' | 'note' | 'body'>) => Promise<void>;
  screen: (scope: AdmissionRecoveryScope, beforePersist: () => Promise<void>) => Promise<unknown>;
  dispatch: typeof assignAndWakeActionableWorkItems;
  /** Test seam for an isolated direct-PG database; production creates a direct lock client. */
  lockSql?: Sql;
}

export class AdmissionRecoveryRefused extends Error {}

/** Read permissions again; the saved request is never an authorization grant. */
export async function authorizeAdmissionRecovery(
  scope: AdmissionRecoveryScope,
  request: Pick<AdmissionRecoveryRequest, 'caller' | 'target' | 'authority' | 'note' | 'body'>,
): Promise<void> {
  for (const actor of new Set([request.caller, request.target])) {
    const presence = await getPresence(actor);
    if (!presence || presence.revoked || presence.workspaceId !== scope.workspaceId) {
      throw new AdmissionRecoveryRefused(`actor ${actor} is absent, revoked, or outside this workspace`);
    }
    if ((await getModes(scope.workspaceId, actor)).some((mode) => mode.mode === AUDIT_MODE)) {
      throw new AdmissionRecoveryRefused(auditModeMutationDenyReason({ toolName: 'work_items:claim', ownerId: actor }));
    }
    // A system routine must not launder a session's launch-declared denial.
    // Reuse the canonical state/evaluator, with a fresh read rather than its UI cache.
    const confinements = await readOperatorState<SessionConfinementsPayload>(
      'operator_session_confinements', scope.workspaceId, { fresh: true },
    );
    const confinement = confinements?.sessions?.[actor];
    if (confinement) {
      const expiry = Date.parse(confinement.expiresAt);
      if (!Number.isFinite(expiry)) throw new AdmissionRecoveryRefused(`${actor}: confinement expiry is invalid`);
      if (expiry > Date.now()) {
        for (const toolName of actor === request.caller ? ['coord:dispatch', 'work_items:claim'] : ['work_items:claim']) {
          const verdict = evaluateSessionConfinement({ toolName, confinement: confinement.confinement });
          if (!verdict.allowed) throw new AdmissionRecoveryRefused(`${actor}: ${verdict.reason}`);
        }
      }
    }
    const permission = await authorizeWorkItemDispatch({
      workItemId: scope.workItemId, target: actor, harness: scope.harnessSlug, workspaceId: scope.workspaceId,
    });
    if (!permission.allowed) throw new AdmissionRecoveryRefused(`${actor}: ${permission.reason}`);
  }
  try {
    await authorizeAdmissionReplay(getOrgPg().sql, scope, request);
  } catch (error) {
    if (error instanceof AdmissionAuthorityRefused) throw new AdmissionRecoveryRefused(error.message);
    throw error;
  }
}

function savedRequest(item: RecoveryItem): AdmissionRecoveryRequest | null {
  const value = item.payload?._admissionRecovery;
  if (value == null) return null;
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) throw new AdmissionRecoveryRefused('malformed original-item recovery request; retry through the authorized request door');
  return parsed.data;
}

/** Payload is caller-writable on feature creation. Bind provenance to the existing
 * operator key, domain-separated from spawn tokens; a claimed caller name is not proof. */
async function requestSignature(sql: Sql, scope: AdmissionRecoveryScope, request: Omit<AdmissionRecoveryRequest, 'signature'>): Promise<string> {
  const [key] = await sql<{ value_b64: string }[]>`
    SELECT value_b64 FROM harness_shared.operator_secrets WHERE name = 'spawn-signing-key'`;
  if (!key) throw new AdmissionRecoveryRefused('operator signing key unavailable; recovery was not authorized');
  return createHmac('sha256', decodeOperatorSecretKey(key.value_b64, 'spawn-signing-key'))
    .update(JSON.stringify([`admission-recovery-v${request.version}`, scope.workspaceId, scope.harnessSlug, scope.workItemId,
      request.requestId, request.caller, request.target, request.routineId, request.requestedAt,
      ...(request.version >= 2 ? [request.note ?? null, request.body ?? null] : []),
      // Parsing fixes property order across input objects and PG jsonb reads.
      ...(request.version === 3 ? [admissionAuthoritySchema.parse(request.authority)] : [])]))
    .digest('hex');
}

async function verifyRequest(sql: Sql, scope: AdmissionRecoveryScope, request: AdmissionRecoveryRequest): Promise<void> {
  const expected = await requestSignature(sql, scope, request);
  if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(request.signature, 'hex'))) {
    throw new AdmissionRecoveryRefused('recovery provenance is invalid for this exact item and caller');
  }
}

async function readItem(sql: Sql, scope: AdmissionRecoveryScope): Promise<RecoveryItem> {
  const [item] = await sql<RecoveryItem[]>`
    SELECT feature_id, status, origin, taken_by, admission, payload
      FROM harness_shared.work_items
     WHERE workspace_id = ${scope.workspaceId} AND harness_slug = ${scope.harnessSlug}
       AND feature_id = ${scope.workItemId}`;
  if (!item) throw new AdmissionRecoveryRefused('the exact original work item was not found in this scope');
  return item;
}

/**
 * WI-10006515: an own-node row stranded at origin='remote' is OURS. `origin` records how a row
 * ARRIVED, not who wrote it (WI-10003565), so "repaired by its originating actor" names THIS
 * node. Heal the label on the base table before the eligibility gate, as the claim and write
 * paths do (selfHealOwnNodeOriginIfStranded): left at 'remote', every later write through the
 * engineer_issues view is a silent no-op. The WHERE clause IS the identity check, so a true
 * peer's row is untouched and still refused. Runs on the caller's handle (inside its transaction
 * where there is one), so a refusal later in that transaction rolls the heal back too.
 */
async function healOwnNodeStrand(sql: Sql, scope: AdmissionRecoveryScope, item: RecoveryItem): Promise<RecoveryItem> {
  if (item.origin !== 'remote') return item;
  const healed = await sql<{ feature_id: string }[]>`
    UPDATE harness_shared.work_items wi SET origin = 'local'
     WHERE wi.workspace_id = ${scope.workspaceId} AND wi.harness_slug = ${scope.harnessSlug}
       AND wi.feature_id = ${scope.workItemId} AND wi.origin = 'remote'
       AND ${issueOwnAuthorWhereSql(sql, scope.workspaceId)}
     RETURNING wi.feature_id`;
  return healed.length === 1 ? { ...item, origin: 'local' } : item;
}

function assertItemEligible(item: RecoveryItem, target: string): void {
  if (!['open', 'todo', 'failing', 'wip', 'in_progress', 'validating'].includes(item.status)) {
    throw new AdmissionRecoveryRefused(`original item is ${item.status}; recovery does not reopen it`);
  }
  if (item.origin !== 'local') throw new AdmissionRecoveryRefused('remote work must be repaired by its originating actor');
  if (item.taken_by && item.taken_by !== target) throw new AdmissionRecoveryRefused(`item is held by ${item.taken_by}`);
  if (item.payload?._claimHold === true || item.payload?.needsOwnerAction === true) {
    throw new AdmissionRecoveryRefused('original item has an owner-action or claim hold');
  }
}

async function assertRoutineActive(sql: Sql, scope: AdmissionRecoveryScope, id?: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM harness_shared.routines
     WHERE workspace_id = ${scope.workspaceId} AND install_slug = ${scope.harnessSlug}
       AND name = ${WORK_ITEM_ADMISSION_PROMOTER}
       AND target_role = ${`system:${WORK_ITEM_ADMISSION_PROMOTER}`} AND active = true
       AND (trigger_config->>'cron' IS NOT NULL OR trigger_config->>'rrule' IS NOT NULL)
       AND (${id ?? null}::text IS NULL OR id = ${id ?? null})`;
  if (rows.length !== 1) throw new AdmissionRecoveryRefused('the existing recurring admission promoter must be present and active');
  return rows[0]!.id;
}

/** Advisory locks serialize our consumers, not other writers of the public payload.
 * Compare the complete saved request so an old worker cannot overwrite a replacement. */
async function writeRequest(
  sql: Sql, scope: AdmissionRecoveryScope, request: Record<string, unknown>, expected: unknown,
): Promise<boolean> {
  const rows = await sql`
    UPDATE harness_shared.work_items
       SET payload = jsonb_set(COALESCE(payload, '{}'::jsonb), '{_admissionRecovery}',
         ${sql.typed(JSON.stringify(request), 25)}::jsonb, true)
     WHERE workspace_id = ${scope.workspaceId} AND harness_slug = ${scope.harnessSlug}
       AND feature_id = ${scope.workItemId}
       AND COALESCE(payload->'_admissionRecovery', 'null'::jsonb) =
         ${sql.typed(JSON.stringify(expected ?? null), 25)}::jsonb
     RETURNING feature_id`;
  return rows.length === 1;
}

async function lockRequest(sql: Sql, scope: AdmissionRecoveryScope): Promise<boolean> {
  const [row] = await sql<{ locked: boolean }[]>`
    SELECT pg_try_advisory_xact_lock(hashtextextended(
      ${admissionRecoveryLockKey(scope)}, 0)) AS locked`;
  return row?.locked === true;
}

/** One item, one durable request. No create, re-title, claim override, or screening bypass. */
export async function requestAdmissionRecovery(
  input: AdmissionRecoveryScope & { caller: string; target: string; note?: string; body?: string; authority?: AdmissionRecoveryAuthority },
  deps: Pick<AdmissionRecoveryDeps, 'authorize'> = { authorize: authorizeAdmissionRecovery },
  sql: Sql = getOrgPg().sql,
): Promise<{ ok: true; workItemId: string; request: AdmissionRecoveryRequest; inProgress: boolean }> {
  if (![input.workspaceId, input.harnessSlug, input.workItemId, input.caller, input.target].every((s) => s.trim())) {
    throw new AdmissionRecoveryRefused('recovery requires exact workspace, harness, item, caller, and target identities');
  }
  await deps.authorize(input, input);
  return sql.begin(async (rawTx) => {
    const tx = rawTx as unknown as Sql;
    const locked = await lockRequest(tx, input);
    const item = await healOwnNodeStrand(tx, input, await readItem(tx, input));
    assertItemEligible(item, input.target);
    const rawPrevious = item.payload?._admissionRecovery;
    // This is a NEW authorized request, not replay by the routine. A rotated key or
    // malformed public payload must not permanently wedge the original item.
    // Well-formed requests retain their exact identity and actor binding; only this
    // fresh authorization path may re-sign them with the current key.
    const parsed = requestSchema.safeParse(rawPrevious);
    const previous = parsed.success ? parsed.data : null;
    if (previous && (previous.caller !== input.caller || previous.target !== input.target)) {
      throw new AdmissionRecoveryRefused(`existing recovery belongs to ${previous.caller} for ${previous.target}`);
    }
    if (!locked) {
      if (!previous) throw new AdmissionRecoveryRefused('original-item recovery is being registered; retry this same item');
      if ((input.note !== undefined && input.note !== previous.note) || (input.body !== undefined && input.body !== previous.body)) {
        throw new AdmissionRecoveryRefused('original recovery is in progress; retry this same item to update its instructions');
      }
      return { ok: true as const, workItemId: input.workItemId, request: previous, inProgress: true };
    }
    const routineId = await assertRoutineActive(tx, input, previous?.routineId);
    // Recheck after serialization too: a retry is not cached permission.
    await deps.authorize(input, input);
    const now = new Date().toISOString();
    const unsigned: Omit<AdmissionRecoveryRequest, 'signature'> = {
      version: input.authority ? 3 : 2, requestId: previous?.requestId ?? randomUUID(), caller: input.caller, target: input.target,
      routineId, requestedAt: previous?.requestedAt ?? now, updatedAt: now,
      state: 'queued', stage: 'queued', pickupConfirmed: false,
      ...(input.authority ? { authority: input.authority } : {}),
      ...(input.note !== undefined || previous?.note !== undefined ? { note: input.note ?? previous?.note } : {}),
      ...(input.body !== undefined || previous?.body !== undefined ? { body: input.body ?? previous?.body } : {}),
    };
    const request = requestSchema.parse({ ...unsigned, signature: await requestSignature(tx, input, unsigned) });
    if (!await writeRequest(tx, input, request, rawPrevious)) {
      throw new AdmissionRecoveryRefused('original recovery changed during registration; retry this same item');
    }
    if (request.state === 'queued') {
      // Queueing and acceleration commit together. The routine engine still owns its fire.
      const updated = await tx`
        UPDATE harness_shared.routines SET next_fire_at = LEAST(COALESCE(next_fire_at, now()), now())
         WHERE id = ${routineId} AND active = true RETURNING id`;
      if (updated.length !== 1) throw new AdmissionRecoveryRefused('promoter was paused during recovery registration');
    }
    return { ok: true as const, workItemId: input.workItemId, request, inProgress: false };
  });
}

/** Called inside the existing durable promoter action; a crash retries the original item. */
export async function runAdmissionRecoveries(
  scope: Omit<AdmissionRecoveryScope, 'workItemId'>,
  deps: AdmissionRecoveryDeps,
  sql: Sql = getOrgPg().sql,
): Promise<number> {
  const rows = await sql<{ feature_id: string }[]>`
    SELECT feature_id FROM harness_shared.work_items
     WHERE workspace_id = ${scope.workspaceId} AND harness_slug = ${scope.harnessSlug}
       AND payload->'_admissionRecovery'->>'state' = 'queued'
     ORDER BY feature_id LIMIT 20`;
  if (rows.length === 0) return 0;

  const ownsLockSql = deps.lockSql === undefined;
  const lockSql = deps.lockSql ?? createAdmissionRecoveryLockSql();
  try {
    for (const row of rows) {
      const exact = { ...scope, workItemId: row.feature_id };
      const lockKey = admissionRecoveryLockKey(exact);
      const reserved = await lockSql.reserve();
      let lockAcquired = false;
      try {
        const [lock] = await reserved<{ locked: boolean }[]>`
          SELECT pg_try_advisory_lock(hashtextextended(${lockKey}, 0)) AS locked`;
        if (lock?.locked !== true) continue;
        lockAcquired = true;

        // Keep the item lock across external screen/dispatch work, but commit this
        // read immediately. Screening may wait on an LLM for minutes.
        const setup = await sql.begin(async (rawTx) => {
          const tx = rawTx as unknown as Sql;
          const original = await readItem(tx, exact);
          const rawRequest = original.payload?._admissionRecovery;
          try {
            const request = savedRequest(original);
            if (!request || request.state !== 'queued') return null;
            return { request, rawRequest };
          } catch (error) {
            if (!(error instanceof AdmissionRecoveryRefused)) throw error;
            // Isolate one corrupt payload; do not abort the routine or admit its item.
            await writeRequest(tx, exact, {
              ...(rawRequest && typeof rawRequest === 'object' ? rawRequest : {}),
              state: 'held', stage: 'authorize', reason: error.message,
              pickupConfirmed: false, updatedAt: new Date().toISOString(),
            }, rawRequest);
            return null;
          }
        });
        if (!setup) continue;
        const { request, rawRequest } = setup;
        const assertAllowed = async () => {
          await verifyRequest(sql, exact, request);
          await assertRoutineActive(sql, exact, request.routineId);
          const live = await healOwnNodeStrand(sql, exact, await readItem(sql, exact));
          const current = savedRequest(live);
          // SQL jsonb equality ignores object-key ordering, unlike JSON.stringify.
          const [same] = await sql<{ unchanged: boolean }[]>`
            SELECT COALESCE(payload->'_admissionRecovery', 'null'::jsonb) =
              ${sql.typed(JSON.stringify(rawRequest ?? null), 25)}::jsonb AS unchanged
              FROM harness_shared.work_items WHERE workspace_id = ${exact.workspaceId}
                AND harness_slug = ${exact.harnessSlug} AND feature_id = ${exact.workItemId}`;
          if (!current || !same?.unchanged) {
            throw new AdmissionRecoveryRefused('original recovery identity changed');
          }
          await verifyRequest(sql, exact, current);
          assertItemEligible(live, request.target);
          await deps.authorize(exact, request);
        };
        let stage: z.infer<typeof recoveryStageSchema> = 'authorize';
        try {
          await assertAllowed();
          const item = await readItem(sql, exact);
          if (item.admission === 'pending' || item.admission === 'unreviewed') {
            stage = 'screen';
            await deps.screen(exact, assertAllowed);
          }
          await assertAllowed();
          const screened = await readItem(sql, exact);
          if (screened.admission === 'pending') {
            throw new AdmissionRecoveryRefused('screening left the original item pending; repair its named admission hold and retry this same item');
          }
          stage = 'assign';
          const result = await deps.dispatch({
            workItemIds: [exact.workItemId], targetAgent: request.target,
            harness: exact.harnessSlug, workspaceId: exact.workspaceId,
            summary: request.note ?? 'Resume original work item ' + exact.workItemId + ' after admission recovery',
            ...(request.body !== undefined ? { instructions: request.body } : {}),
            source: 'system:work-item-admission-recovery',
            beforeMutate: async (mutation) => {
              stage = mutation === 'wake' ? 'wake' : 'assign';
              await assertAllowed();
            },
          });
          // Assignment and wake have their own durable writes. A crash here leaves the
          // request queued; retry retains the assignment and reuses the normal wake path.
          // queued is authoritative when present; woken is only the older queue-count alias.
          const queued = (result.wake?.queued ?? result.wake?.woken ?? 0) > 0;
          stage = result.ok && queued ? 'await-pickup' : result.wake ? 'wake' : 'assign';
          const updated = await sql.begin(async (rawTx) => {
            const tx = rawTx as unknown as Sql;
            const current = await readItem(tx, exact);
            const currentRequest = savedRequest(current);
            const [same] = await tx<{ unchanged: boolean }[]>`
              SELECT COALESCE(payload->'_admissionRecovery', 'null'::jsonb) =
                ${tx.typed(JSON.stringify(rawRequest ?? null), 25)}::jsonb AS unchanged
                FROM harness_shared.work_items WHERE workspace_id = ${exact.workspaceId}
                  AND harness_slug = ${exact.harnessSlug} AND feature_id = ${exact.workItemId}`;
            if (!currentRequest || !same?.unchanged) return false;
            await verifyRequest(tx, exact, currentRequest);
            await assertRoutineActive(tx, exact, request.routineId);
            return writeRequest(tx, exact, {
              ...request, state: result.ok && queued ? 'delivered' : 'held', stage,
              reason: result.assignment?.skipped[0]?.reason ?? result.assignment?.failed[0]?.reason ?? result.warning ??
                (queued ? 'wake queued; target pickup remains unconfirmed' : 'dispatch did not queue a wake'),
              updatedAt: new Date().toISOString(),
            }, rawRequest);
          });
          if (!updated) throw new AdmissionRecoveryRefused('original recovery identity changed');
        } catch (error) {
          if (!(error instanceof AdmissionRecoveryRefused)) throw error;
          await sql.begin(async (rawTx) => {
            const tx = rawTx as unknown as Sql;
            await writeRequest(tx, exact, {
              ...request, state: 'held', stage,
              reason: error.message.slice(0, 2000), updatedAt: new Date().toISOString(),
            }, rawRequest);
          });
        }
      } finally {
        if (lockAcquired) {
          await reserved`SELECT pg_advisory_unlock(hashtextextended(${lockKey}, 0))`.catch(() => {});
        }
        reserved.release();
      }
    }
  } finally {
    if (ownsLockSql) await lockSql.end({ timeout: 5 }).catch(() => {});
  }
  return rows.length;
}
