/**
 * Canonical participant identity receipts for the directed-pair pilot.
 *
 * This deliberately extends the existing session + work-item payload stores. The
 * caller supplies only a role (claim) or a binding receipt id (dispatch); owner,
 * session, receipt ids, and timestamps are all resolved/issued on the server.
 */

import { randomUUID } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';

export const PILOT_PARTICIPANT_ROLES = ['solo', 'director', 'implementer'] as const;
export type PilotParticipantRole = (typeof PILOT_PARTICIPANT_ROLES)[number];

export interface PilotParticipantBindingReceipt {
  readonly receiptId: string;
  readonly itemId: string;
  readonly ownerId: string;
  readonly sessionId: string;
  readonly role: PilotParticipantRole;
  /** Exact WorkItem.takenAt ISO string. */
  readonly claimVersion: string;
  readonly bindingIssuedAtMs: number;
}

export interface PilotParticipantDispatchReceipt {
  readonly receiptId: string;
  readonly bindingReceiptId: string;
  readonly itemId: string;
  readonly ownerId: string;
  readonly sessionId: string;
  readonly role: PilotParticipantRole;
  readonly dispatchedAtMs: number;
}

export interface PilotParticipantReceiptStore {
  readonly pilotBindingReceipts: readonly PilotParticipantBindingReceipt[];
  readonly pilotDispatchReceipts: readonly PilotParticipantDispatchReceipt[];
}

export interface PilotParticipantReceiptCandidate {
  readonly id: string;
  readonly expectedOwnerId: string;
  readonly expectedClaimVersion: string;
  readonly payload: unknown;
}

export interface CanonicalPilotParticipant {
  readonly ownerId: string;
  readonly sessionId: string;
  readonly role: PilotParticipantRole;
  readonly bindingReceiptId: string;
  readonly dispatchReceiptId: string;
}

export interface PilotParticipantReceiptCohortValidation {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly participantsByItem: Readonly<Record<string, readonly CanonicalPilotParticipant[]>>;
}

export interface PersistPilotParticipantBindingInput {
  readonly workspaceId: string;
  readonly harnessSlug: string;
  readonly itemId: string;
  readonly ownerId: string;
  readonly claimVersion: string;
  readonly role: PilotParticipantRole;
}

export interface PersistPilotParticipantDispatchInput {
  readonly workspaceId: string;
  readonly harnessSlug: string;
  readonly itemId: string;
  readonly bindingReceiptId: string;
  readonly ownerId: string;
}

function record(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function pilotRole(value: unknown): value is PilotParticipantRole {
  return (PILOT_PARTICIPANT_ROLES as readonly unknown[]).includes(value);
}

function exactIso(value: unknown): value is string {
  if (!nonEmpty(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

function bindingReceipt(value: unknown): PilotParticipantBindingReceipt | null {
  const row = record(value);
  return nonEmpty(row.receiptId) && nonEmpty(row.itemId) && nonEmpty(row.ownerId) &&
    nonEmpty(row.sessionId) && pilotRole(row.role) && exactIso(row.claimVersion) &&
    finiteNonNegative(row.bindingIssuedAtMs)
    ? {
        receiptId: row.receiptId,
        itemId: row.itemId,
        ownerId: row.ownerId,
        sessionId: row.sessionId,
        role: row.role,
        claimVersion: row.claimVersion,
        bindingIssuedAtMs: row.bindingIssuedAtMs,
      }
    : null;
}

function dispatchReceipt(value: unknown): PilotParticipantDispatchReceipt | null {
  const row = record(value);
  return nonEmpty(row.receiptId) && nonEmpty(row.bindingReceiptId) && nonEmpty(row.itemId) &&
    nonEmpty(row.ownerId) && nonEmpty(row.sessionId) && pilotRole(row.role) &&
    finiteNonNegative(row.dispatchedAtMs)
    ? {
        receiptId: row.receiptId,
        bindingReceiptId: row.bindingReceiptId,
        itemId: row.itemId,
        ownerId: row.ownerId,
        sessionId: row.sessionId,
        role: row.role,
        dispatchedAtMs: row.dispatchedAtMs,
      }
    : null;
}

function parsedStore(payload: unknown): { store: PilotParticipantReceiptStore; errors: string[] } {
  const body = record(payload);
  const rawBindings = Array.isArray(body.pilotBindingReceipts) ? body.pilotBindingReceipts : [];
  const rawDispatches = Array.isArray(body.pilotDispatchReceipts) ? body.pilotDispatchReceipts : [];
  const bindings = rawBindings.map(bindingReceipt);
  const dispatches = rawDispatches.map(dispatchReceipt);
  const errors: string[] = [];
  if (body.pilotBindingReceipts != null && !Array.isArray(body.pilotBindingReceipts)) {
    errors.push('pilotBindingReceipts is not an array');
  }
  if (body.pilotDispatchReceipts != null && !Array.isArray(body.pilotDispatchReceipts)) {
    errors.push('pilotDispatchReceipts is not an array');
  }
  bindings.forEach((entry, index) => {
    if (!entry) errors.push(`pilotBindingReceipts[${index}] is malformed`);
  });
  dispatches.forEach((entry, index) => {
    if (!entry) errors.push(`pilotDispatchReceipts[${index}] is malformed`);
  });
  return {
    store: {
      pilotBindingReceipts: bindings.filter((entry): entry is PilotParticipantBindingReceipt => entry != null),
      pilotDispatchReceipts: dispatches.filter((entry): entry is PilotParticipantDispatchReceipt => entry != null),
    },
    errors,
  };
}

export function readPilotParticipantReceiptStore(payload: unknown): PilotParticipantReceiptStore {
  return parsedStore(payload).store;
}

export function issuePilotParticipantBindingReceipt(
  input: Omit<PilotParticipantBindingReceipt, 'receiptId' | 'bindingIssuedAtMs'>,
  now = Date.now,
  issueId: () => string = randomUUID,
): PilotParticipantBindingReceipt {
  if (!exactIso(input.claimVersion)) throw new Error('pilot binding claimVersion must be an exact ISO timestamp');
  return { ...input, receiptId: issueId(), bindingIssuedAtMs: now() };
}

export function issuePilotParticipantDispatchReceipt(
  binding: PilotParticipantBindingReceipt,
  now = Date.now,
  issueId: () => string = randomUUID,
): PilotParticipantDispatchReceipt {
  return {
    receiptId: issueId(),
    bindingReceiptId: binding.receiptId,
    itemId: binding.itemId,
    ownerId: binding.ownerId,
    sessionId: binding.sessionId,
    role: binding.role,
    dispatchedAtMs: Math.max(now(), binding.bindingIssuedAtMs),
  };
}

export function validatePilotParticipantReceiptCohort(
  candidates: readonly PilotParticipantReceiptCandidate[],
): PilotParticipantReceiptCohortValidation {
  const errors: string[] = [];
  const participantsByItem: Record<string, CanonicalPilotParticipant[]> = {};
  const bindingIds = new Set<string>();
  const dispatchIds = new Set<string>();
  const owners = new Map<string, { sessionId: string; itemId: string; role: PilotParticipantRole }>();
  const sessions = new Map<string, { ownerId: string; itemId: string; role: PilotParticipantRole }>();

  for (const candidate of candidates) {
    const parsed = parsedStore(candidate.payload);
    parsed.errors.forEach((error) => errors.push(`${candidate.id}: ${error}`));
    const bindings = parsed.store.pilotBindingReceipts;
    const dispatches = parsed.store.pilotDispatchReceipts;
    const itemBindings = bindings.filter((entry) => entry.itemId === candidate.id);
    const foreignBindings = bindings.filter((entry) => entry.itemId !== candidate.id);
    const itemDispatches = dispatches.filter((entry) => entry.itemId === candidate.id);
    const foreignDispatches = dispatches.filter((entry) => entry.itemId !== candidate.id);
    if (foreignBindings.length) errors.push(`${candidate.id}: binding receipt re-used across item ids`);
    if (foreignDispatches.length) errors.push(`${candidate.id}: dispatch receipt re-used across item ids`);
    if (itemBindings.length === 0) errors.push(`${candidate.id}: no canonical binding receipt`);
    if (!itemBindings.some(
      (entry) => entry.ownerId === candidate.expectedOwnerId && entry.claimVersion === candidate.expectedClaimVersion,
    )) {
      errors.push(`${candidate.id}: no binding matches the frozen owner and claimVersion`);
    }

    const roleSet = new Set(itemBindings.map((entry) => entry.role));
    const validSolo = itemBindings.length === 1 && roleSet.size === 1 && roleSet.has('solo');
    const validPair = itemBindings.length === 2 && roleSet.size === 2 &&
      roleSet.has('director') && roleSet.has('implementer');
    if (itemBindings.length > 0 && !validSolo && !validPair) {
      errors.push(`${candidate.id}: roles must be exactly solo OR director+implementer`);
    }

    for (const binding of itemBindings) {
      if (bindingIds.has(binding.receiptId)) errors.push(`${candidate.id}: duplicate binding receiptId ${binding.receiptId}`);
      bindingIds.add(binding.receiptId);

      const priorOwner = owners.get(binding.ownerId);
      if (priorOwner && (priorOwner.sessionId !== binding.sessionId || priorOwner.itemId !== candidate.id || priorOwner.role !== binding.role)) {
        errors.push(`${candidate.id}: ownerId ${binding.ownerId} is re-used across session/item/role`);
      } else {
        owners.set(binding.ownerId, { sessionId: binding.sessionId, itemId: candidate.id, role: binding.role });
      }
      const priorSession = sessions.get(binding.sessionId);
      if (priorSession && (priorSession.ownerId !== binding.ownerId || priorSession.itemId !== candidate.id || priorSession.role !== binding.role)) {
        errors.push(`${candidate.id}: sessionId ${binding.sessionId} is re-used across owner/item/role`);
      } else {
        sessions.set(binding.sessionId, { ownerId: binding.ownerId, itemId: candidate.id, role: binding.role });
      }

      const linked = itemDispatches.filter((entry) => entry.bindingReceiptId === binding.receiptId);
      if (linked.length !== 1) {
        errors.push(`${candidate.id}: binding ${binding.receiptId} has ${linked.length} dispatch receipts (expected 1)`);
        continue;
      }
      const dispatch = linked[0];
      if (dispatchIds.has(dispatch.receiptId)) errors.push(`${candidate.id}: duplicate dispatch receiptId ${dispatch.receiptId}`);
      dispatchIds.add(dispatch.receiptId);
      if (dispatch.ownerId !== binding.ownerId || dispatch.sessionId !== binding.sessionId || dispatch.role !== binding.role) {
        errors.push(`${candidate.id}: dispatch ${dispatch.receiptId} does not match its canonical binding`);
      }
      if (dispatch.dispatchedAtMs < binding.bindingIssuedAtMs) {
        errors.push(`${candidate.id}: dispatch ${dispatch.receiptId} predates its binding`);
      }
      participantsByItem[candidate.id] ??= [];
      participantsByItem[candidate.id].push({
        ownerId: binding.ownerId,
        sessionId: binding.sessionId,
        role: binding.role,
        bindingReceiptId: binding.receiptId,
        dispatchReceiptId: dispatch.receiptId,
      });
    }
    const linkedDispatchIds = new Set(itemBindings.map((entry) => entry.receiptId));
    for (const dispatch of itemDispatches) {
      if (!linkedDispatchIds.has(dispatch.bindingReceiptId)) {
        errors.push(`${candidate.id}: orphan dispatch receipt ${dispatch.receiptId}`);
      }
    }
  }

  return { ok: errors.length === 0, errors, participantsByItem };
}

export async function resolveCanonicalPilotParticipantSession(
  workspaceId: string,
  ownerId: string,
): Promise<string> {
  const { sql } = getOrgPg();
  const rows = await sql.unsafe(
    'SELECT session_id FROM harness_shared.adv_sessions ' +
      "WHERE workspace_id = $1 AND coord_owner_id = $2 AND ended_at IS NULL AND NULLIF(btrim(session_id), '') IS NOT NULL " +
      'ORDER BY started_at DESC, id DESC LIMIT 1',
    [workspaceId, ownerId],
  ) as unknown as Array<{ session_id: string }>;
  const sessionId = rows[0]?.session_id?.trim();
  if (!sessionId) throw new Error(`no active canonical session for ${ownerId}`);
  return sessionId;
}

export async function persistPilotParticipantBindingReceipt(
  input: PersistPilotParticipantBindingInput,
): Promise<PilotParticipantBindingReceipt> {
  if (!exactIso(input.claimVersion)) throw new Error('pilot binding claimVersion must be an exact ISO timestamp');
  const sessionId = await resolveCanonicalPilotParticipantSession(input.workspaceId, input.ownerId);
  const receipt = issuePilotParticipantBindingReceipt({
    itemId: input.itemId,
    ownerId: input.ownerId,
    sessionId,
    role: input.role,
    claimVersion: input.claimVersion,
  });
  const { sql } = getOrgPg();
  const rows = await sql.unsafe(
    "UPDATE harness_shared.work_items SET payload = jsonb_set(COALESCE(payload, '{}'::jsonb), " +
      "'{pilotBindingReceipts}', COALESCE(CASE WHEN jsonb_typeof(payload->'pilotBindingReceipts') = 'array' " +
      "THEN payload->'pilotBindingReceipts' END, '[]'::jsonb) || $6::jsonb, true) " +
      'WHERE workspace_id = $1 AND harness_slug = $2 AND feature_id = $3 AND taken_by = $4 ' +
      // Tool-boundary claimVersion is ISO milliseconds; Postgres taken_at can
      // carry microseconds. Compare at the precision the caller actually read.
      "AND date_trunc('milliseconds', taken_at) = $5::timestamptz RETURNING feature_id",
    [input.workspaceId, input.harnessSlug, input.itemId, input.ownerId, input.claimVersion, JSON.stringify([receipt])],
  ) as unknown as Array<{ feature_id: string }>;
  if (rows.length !== 1) {
    throw new Error('pilot binding CAS refused: work-item owner or claimVersion changed');
  }
  return receipt;
}

export async function persistPilotParticipantDispatchReceipt(
  input: PersistPilotParticipantDispatchInput,
): Promise<PilotParticipantDispatchReceipt> {
  const sessionId = await resolveCanonicalPilotParticipantSession(input.workspaceId, input.ownerId);
  const { sql } = getOrgPg();
  const readRows = await sql.unsafe(
    "SELECT COALESCE(payload, '{}'::jsonb) AS payload FROM harness_shared.work_items " +
      'WHERE workspace_id = $1 AND harness_slug = $2 AND feature_id = $3 LIMIT 1',
    [input.workspaceId, input.harnessSlug, input.itemId],
  ) as unknown as Array<{ payload: unknown }>;
  const binding = readPilotParticipantReceiptStore(readRows[0]?.payload).pilotBindingReceipts.find(
    (entry) => entry.receiptId === input.bindingReceiptId,
  );
  if (!binding) throw new Error('canonical pilot binding receipt not found');
  if (binding.itemId !== input.itemId || binding.ownerId !== input.ownerId || binding.sessionId !== sessionId) {
    throw new Error('dispatch target/session does not match canonical pilot binding');
  }
  const receipt = issuePilotParticipantDispatchReceipt(binding);
  const rows = await sql.unsafe(
    "UPDATE harness_shared.work_items SET payload = jsonb_set(COALESCE(payload, '{}'::jsonb), " +
      "'{pilotDispatchReceipts}', COALESCE(CASE WHEN jsonb_typeof(payload->'pilotDispatchReceipts') = 'array' " +
      "THEN payload->'pilotDispatchReceipts' END, '[]'::jsonb) || $7::jsonb, true) " +
      'WHERE workspace_id = $1 AND harness_slug = $2 AND feature_id = $3 AND taken_by = $4 ' +
      "AND date_trunc('milliseconds', taken_at) = $5::timestamptz AND EXISTS (SELECT 1 FROM jsonb_array_elements(" +
      "COALESCE(CASE WHEN jsonb_typeof(payload->'pilotBindingReceipts') = 'array' " +
      "THEN payload->'pilotBindingReceipts' END, '[]'::jsonb)) receipt " +
      "WHERE receipt->>'receiptId' = $6) RETURNING feature_id",
    [
      input.workspaceId,
      input.harnessSlug,
      input.itemId,
      input.ownerId,
      binding.claimVersion,
      binding.receiptId,
      JSON.stringify([receipt]),
    ],
  ) as unknown as Array<{ feature_id: string }>;
  if (rows.length !== 1) {
    throw new Error('pilot dispatch CAS refused: binding is no longer the current run-owned claim');
  }
  return receipt;
}
