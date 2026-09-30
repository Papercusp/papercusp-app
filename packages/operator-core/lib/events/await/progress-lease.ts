import { createHash } from 'node:crypto';
import { dispatchReadOnlyTool, valueAtPath } from './predicate-watch';
import { wakeRecipients } from '../../agent-tools/coordination/inbox-wake';
import { upsertConditionWorkItem } from '../../coord/condition-upsert';
import { claimWorkItem } from '../../work-items';
import {
  PRODUCER_HEALTH_CERTIFICATE_VERSION,
  type ProducerHealthCertificate,
  type ProgressLeaseEvidence,
  type ProgressLeaseRemedy,
  type ProgressLeaseRemedyOutcome,
  type ProgressLeaseSourceKind,
  type ProgressLeaseTransition,
  type VerifiedWaitTimeoutResult,
} from './verified-wait';

export interface ProgressLeaseRegistration {
  source_kind: ProgressLeaseSourceKind;
  tool: string;
  args?: Record<string, unknown>;
  path: string;
  op?: 'changed' | 'increased';
  units: string;
  writer?: string;
  expected_cadence_sec: number;
  owner_id: string;
  work_item_id?: string;
  remedy_after_misses?: number;
  remedy: ProgressLeaseRemedy;
}

export interface ProgressLeaseRegistrationContext {
  subscriberId: string;
  workspaceId: string;
  harnessSlug: string | null;
  role: string;
  timeoutSec?: number;
  nowMs?: number;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

export function progressValueFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function preview(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (serialized.length <= 1_000) return value;
  return `${serialized.slice(0, 997)}...`;
}

function evidence(input: {
  writer: string;
  units: string;
  observedAtMs: number;
  value: unknown;
  tool: string;
  args: Record<string, unknown>;
  path: string;
  uncertainty?: string | null;
}): ProgressLeaseEvidence {
  return {
    writer: input.writer,
    units: input.units,
    observedAtMs: input.observedAtMs,
    valuePreview: preview(input.value),
    valueFingerprint: progressValueFingerprint(input.value),
    reference: { tool: input.tool, args: input.args, path: input.path },
    uncertainty: input.uncertainty ?? null,
  };
}

function increased(previous: unknown, current: unknown): boolean {
  if (typeof previous === 'number' && typeof current === 'number') return current > previous;
  const a = typeof previous === 'string' ? Date.parse(previous) : Number.NaN;
  const b = typeof current === 'string' ? Date.parse(current) : Number.NaN;
  return Number.isFinite(a) && Number.isFinite(b) && b > a;
}

export async function createProgressLeaseCertificate(
  registration: ProgressLeaseRegistration,
  context: ProgressLeaseRegistrationContext,
): Promise<ProducerHealthCertificate> {
  if (registration.owner_id === context.subscriberId) {
    throw new Error('progress_lease owner_id must name the delegated upstream owner, not the waiting subscriber');
  }
  const nowMs = context.nowMs ?? Date.now();
  const args = registration.args ?? {};
  const payload = await dispatchReadOnlyTool(registration.tool, args, {
    workspaceId: context.workspaceId,
    harnessSlug: context.harnessSlug,
    role: context.role,
    onBehalfOf: context.subscriberId,
    spawnId: 'progress-lease-registration',
  });
  const value = valueAtPath(payload, registration.path);
  if (value === undefined) {
    throw new Error(`progress_lease path "${registration.path}" resolved to undefined; no wait was registered`);
  }
  const initial = evidence({
    writer: registration.writer ?? registration.tool,
    units: registration.units,
    observedAtMs: nowMs,
    value,
    tool: registration.tool,
    args,
    path: registration.path,
  });
  const cadenceMs = registration.expected_cadence_sec * 1_000;
  const deadlineMs = nowMs + (context.timeoutSec == null ? cadenceMs : context.timeoutSec * 1_000);
  const leaseId = globalThis.crypto.randomUUID();
  return {
    version: PRODUCER_HEALTH_CERTIFICATE_VERSION,
    producer: { kind: 'delegated-progress', id: leaseId },
    owner: { ownerId: registration.owner_id, workItemId: registration.work_item_id ?? null },
    issuedAtMs: nowMs,
    lastProgressAtMs: nowMs,
    lastFireAtMs: null,
    expectedCadenceMs: cadenceMs,
    verificationDeadlineMs: deadlineMs,
    details: { sourceKind: registration.source_kind },
    progressLease: {
      leaseId,
      sourceKind: registration.source_kind,
      resolver: {
        tool: registration.tool,
        args,
        path: registration.path,
        op: registration.op ?? 'changed',
        workspaceId: context.workspaceId,
        harnessSlug: context.harnessSlug,
        role: context.role,
        onBehalfOf: context.subscriberId,
      },
      subscriberId: context.subscriberId,
      writer: initial.writer,
      units: initial.units,
      baselineFingerprint: initial.valueFingerprint,
      latestEvidence: initial,
      missCount: 0,
      remedyAfterMisses: registration.remedy_after_misses ?? 2,
      remedy: registration.remedy,
      history: [{ state: 'armed', atMs: nowMs, writer: initial.writer, units: initial.units, missCount: 0, evidence: initial }],
    },
  };
}

export async function observeProgressLease(
  certificate: ProducerHealthCertificate,
  nowMs = Date.now(),
): Promise<VerifiedWaitTimeoutResult> {
  const lease = certificate.progressLease;
  if (!lease) throw new Error('progress lease certificate is missing progressLease state');
  try {
    const payload = await dispatchReadOnlyTool(lease.resolver.tool, lease.resolver.args, {
      workspaceId: lease.resolver.workspaceId,
      harnessSlug: lease.resolver.harnessSlug,
      role: lease.resolver.role,
      onBehalfOf: lease.resolver.onBehalfOf,
      spawnId: 'progress-lease-verifier',
    });
    const value = valueAtPath(payload, lease.resolver.path);
    if (value === undefined) throw new Error(`path "${lease.resolver.path}" resolved to undefined`);
    const current = evidence({
      writer: lease.writer,
      units: lease.units,
      observedAtMs: nowMs,
      value,
      tool: lease.resolver.tool,
      args: lease.resolver.args,
      path: lease.resolver.path,
    });
    const progressed =
      lease.resolver.op === 'increased'
        ? increased(lease.latestEvidence.valuePreview, current.valuePreview)
        : current.valueFingerprint !== lease.baselineFingerprint;
    return {
      classification: progressed ? 'progressing' : 'stalled',
      nextAction: progressed ? 're-await' : 'wake-owner-or-takeover',
      producer: certificate.producer,
      owner: certificate.owner,
      checkedAtMs: nowMs,
      verificationDeadlineMs: certificate.verificationDeadlineMs,
      lastProgressAtMs: progressed ? nowMs : certificate.lastProgressAtMs,
      lastFireAtMs: certificate.lastFireAtMs,
      evidence: { progressLease: current, progressed, missCount: progressed ? 0 : lease.missCount + 1 },
    };
  } catch (error) {
    const uncertainty = error instanceof Error ? error.message : String(error);
    const current = evidence({
      writer: lease.writer,
      units: lease.units,
      observedAtMs: nowMs,
      value: lease.latestEvidence.valuePreview,
      tool: lease.resolver.tool,
      args: lease.resolver.args,
      path: lease.resolver.path,
      uncertainty,
    });
    return {
      classification: 'stalled',
      nextAction: 'wake-owner-or-takeover',
      producer: certificate.producer,
      owner: certificate.owner,
      checkedAtMs: nowMs,
      verificationDeadlineMs: certificate.verificationDeadlineMs,
      lastProgressAtMs: certificate.lastProgressAtMs,
      lastFireAtMs: certificate.lastFireAtMs,
      evidence: { progressLease: current, progressed: false, missCount: lease.missCount + 1, uncertainty },
    };
  }
}

function resultEvidence(result: VerifiedWaitTimeoutResult): ProgressLeaseEvidence {
  const current = result.evidence?.progressLease;
  if (!current || typeof current !== 'object') throw new Error('progress lease result lacks evidence envelope');
  return current as ProgressLeaseEvidence;
}

export function advanceProgressLeaseCertificate(
  certificate: ProducerHealthCertificate,
  result: VerifiedWaitTimeoutResult,
  sideEffect: { wake?: ProgressLeaseTransition['wake']; remedy?: ProgressLeaseRemedyOutcome } = {},
): ProducerHealthCertificate {
  const lease = certificate.progressLease;
  if (!lease) throw new Error('progress lease certificate is missing progressLease state');
  const current = resultEvidence(result);
  const progressing = result.classification === 'progressing';
  const missCount = progressing ? 0 : lease.missCount + 1;
  const baseTransition: ProgressLeaseTransition = {
    state: progressing ? 'progress' : 'miss',
    atMs: result.checkedAtMs,
    writer: current.writer,
    units: current.units,
    missCount,
    evidence: current,
  };
  const appended: ProgressLeaseTransition[] = [baseTransition];
  if (sideEffect.wake) appended.push({ ...baseTransition, state: 'owner-wake', wake: sideEffect.wake });
  if (sideEffect.remedy) appended.push({ ...baseTransition, state: 'remedy', remedy: sideEffect.remedy });
  return {
    ...certificate,
    issuedAtMs: result.checkedAtMs,
    lastProgressAtMs: result.lastProgressAtMs,
    verificationDeadlineMs: result.checkedAtMs + certificate.expectedCadenceMs,
    progressLease: {
      ...lease,
      baselineFingerprint: progressing ? current.valueFingerprint : lease.baselineFingerprint,
      latestEvidence: current,
      missCount,
      history: [...lease.history, ...appended],
    },
  };
}

export async function wakeProgressLeaseOwner(
  certificate: ProducerHealthCertificate,
  result: VerifiedWaitTimeoutResult,
): Promise<ProgressLeaseTransition['wake']> {
  const ownerId = certificate.owner.ownerId;
  if (!ownerId) return { attempted: false, queued: 0, staged: 0 };
  const wake = await wakeRecipients([ownerId], {
    summary: `Progress lease ${certificate.producer.id} missed its first cadence; inspect the authoritative evidence and resume the delegated condition.`,
    payload: { progressLease: certificate.producer.id, result },
    source: 'system:progress-lease',
    workspaceId: certificate.progressLease?.resolver.workspaceId,
    requiredWake: true,
  });
  return { attempted: true, queued: wake.queued ?? wake.woken, staged: wake.staged };
}

export async function executeProgressLeaseRemedy(
  certificate: ProducerHealthCertificate,
): Promise<ProgressLeaseRemedyOutcome> {
  const lease = certificate.progressLease;
  if (!lease) throw new Error('progress lease certificate is missing progressLease state');
  const remedy = lease.remedy;
  try {
    if (remedy.kind === 'spec-widen' || remedy.kind === 'outside-lane-placement') {
      return { kind: remedy.kind, disposition: 'surfaced', summary: remedy.instructions };
    }
    if (remedy.kind === 'leader-claim') {
      const workItemId = remedy.workItemId ?? certificate.owner.workItemId;
      if (!workItemId) {
        return { kind: remedy.kind, disposition: 'failed', summary: 'No work-item id was supplied for leader takeover.' };
      }
      const claimed = await claimWorkItem(workItemId, lease.subscriberId, {
        harness: remedy.harness ?? undefined,
        expectedAssignee: certificate.owner.ownerId ?? undefined,
      });
      return claimed
        ? { kind: remedy.kind, disposition: 'executed', summary: `Transferred ${workItemId} to waiting leader ${lease.subscriberId} by expected-holder CAS.`, workItemId }
        : { kind: remedy.kind, disposition: 'failed', summary: `Takeover CAS for ${workItemId} lost or was refused; re-read ownership.`, workItemId };
    }
    const conditionKey = `progress-lease:${lease.leaseId}`;
    const created = await upsertConditionWorkItem(conditionKey, {
      kind: 'task',
      title: remedy.title,
      summary: remedy.summary ?? `Unblock delegated wait progress lease ${lease.leaseId}.`,
      harness: remedy.harness,
      workspaceId: lease.resolver.workspaceId,
      payload: { progressLease: lease.leaseId, delegatedOwner: certificate.owner.ownerId },
    });
    if (created.id) await claimWorkItem(created.id, lease.subscriberId, { harness: remedy.harness });
    return {
      kind: remedy.kind,
      disposition: created.id ? 'executed' : 'failed',
      summary: created.id
        ? `${created.created ? 'Created' : 'Adopted'} and claimed unblock item ${created.id}.`
        : 'Unable to create or adopt the unblock work-item.',
      workItemId: created.id,
    };
  } catch (error) {
    return {
      kind: remedy.kind,
      disposition: 'failed',
      summary: `Remedy backend failed: ${error instanceof Error ? error.message : String(error)}`,
      ...(remedy.kind === 'leader-claim'
        ? { workItemId: remedy.workItemId ?? certificate.owner.workItemId }
        : {}),
    };
  }
}
