/**
 * Durable, federated storage for immutable plan-governance events.
 *
 * The backing `pot_settings` table federates one key at a time with LWW semantics,
 * so a governance round may never be stored as one mutable aggregate. Each event
 * instead receives a content-addressed key. Replaying the same event is idempotent;
 * changing any byte creates a second key and is surfaced as an immutable conflict
 * for the certificate source to fail closed on.
 */
import type { Sql } from 'postgres';
import { resolveFederatedPotScope } from '../../federated-pot-scope';
import {
  listHiveSettings,
  setHiveSetting,
  type HiveSettingRecord,
  type SetHiveSettingInput,
} from '../../hive-settings-store';
import {
  governanceEventDigest,
  type FederatedGovernanceEvent,
  type GovernanceEventBody,
} from './governance-federation';
import {
  verifyFinalizationCertificate,
  type FinalizationCertificate,
  type GovernanceRound,
  type GovernanceVoteEvent,
} from './governance-round';

export const PLAN_ADMISSION_GOVERNANCE_EVENT_PREFIX = 'governanceEvent.v1.';

type ListSettings = (
  workspaceId: string,
  potHomeSlug: string,
  sql?: Sql,
) => Promise<HiveSettingRecord[]>;
type SetSetting = (
  input: SetHiveSettingInput,
  sql?: Sql,
) => Promise<HiveSettingRecord>;
type ResolvePotScope = (
  workspaceId: string,
  localPotHomeSlug: string,
  opts?: { sql?: Sql },
) => Promise<string>;

export interface PlanAdmissionGovernanceStoreDeps {
  readonly listSettings?: ListSettings;
  readonly setSetting?: SetSetting;
  readonly resolvePotScope?: ResolvePotScope;
}

export interface PlanAdmissionGovernanceSnapshot {
  readonly potId: string;
  readonly events: readonly FederatedGovernanceEvent[];
  /** Rounds touched by two different immutable values carrying the same event id. */
  readonly conflictedRoundIds: ReadonlySet<string>;
  /** Dedicated-prefix rows that failed shape, key-integrity, or pot-boundary checks. */
  readonly integrityErrors: readonly string[];
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function integer(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonEmptyString);
}

function governanceRound(value: unknown): value is GovernanceRound {
  const row = object(value);
  return Boolean(
    row &&
      nonEmptyString(row.roundId) &&
      nonEmptyString(row.planRevisionHash) &&
      integer(row.policyVersion) &&
      row.policyVersion > 0 &&
      stringArray(row.eligibleMemberIds) &&
      row.eligibleMemberIds.length > 0 &&
      finiteNumber(row.createdAtMs),
  );
}

function governanceVote(value: unknown): value is GovernanceVoteEvent {
  const row = object(value);
  return Boolean(
    row &&
      nonEmptyString(row.eventId) &&
      nonEmptyString(row.roundId) &&
      nonEmptyString(row.memberId) &&
      (row.choice === 'approve' || row.choice === 'reject' || row.choice === 'abstain') &&
      integer(row.sequence) &&
      nonEmptyString(row.signature) &&
      (row.keyEpoch === undefined || integer(row.keyEpoch)),
  );
}

function finalizationCertificate(value: unknown): value is FinalizationCertificate {
  const row = object(value);
  if (
    !row ||
    !nonEmptyString(row.roundId) ||
    !nonEmptyString(row.planRevisionHash) ||
    !integer(row.policyVersion) ||
    typeof row.admitted !== 'boolean' ||
    typeof row.reason !== 'string' ||
    !stringArray(row.voteEventIds) ||
    !finiteNumber(row.finalizedAtMs) ||
    object(row.tally) === null ||
    !nonEmptyString(row.certificateHash)
  ) {
    return false;
  }
  return verifyFinalizationCertificate(row as unknown as FinalizationCertificate);
}

function governanceBody(value: unknown, roundId: string): value is GovernanceEventBody {
  const body = object(value);
  if (!body || typeof body.kind !== 'string') return false;
  switch (body.kind) {
    case 'round-open':
      return governanceRound(body.round) && body.round.roundId === roundId;
    case 'vote':
      return governanceVote(body.vote) && body.vote.roundId === roundId;
    case 'finalize':
      return finalizationCertificate(body.certificate) && body.certificate.roundId === roundId;
    case 'pause':
      return body.expiresAtMs === undefined || finiteNumber(body.expiresAtMs);
    case 'resume':
      return true;
    case 'revoke':
      return nonEmptyString(body.reason);
    default:
      return false;
  }
}

export function isFederatedGovernanceEvent(value: unknown): value is FederatedGovernanceEvent {
  const event = object(value);
  return Boolean(
    event &&
      nonEmptyString(event.eventId) &&
      nonEmptyString(event.potId) &&
      nonEmptyString(event.roundId) &&
      nonEmptyString(event.originPeerId) &&
      finiteNumber(event.occurredAtMs) &&
      nonEmptyString(event.signature) &&
      governanceBody(event.body, event.roundId),
  );
}

export function planAdmissionGovernanceEventDigest(event: FederatedGovernanceEvent): string {
  const { signature: _signature, ...unsigned } = event;
  void _signature;
  return governanceEventDigest(unsigned);
}

export function planAdmissionGovernanceEventSettingKey(event: FederatedGovernanceEvent): string {
  return `${PLAN_ADMISSION_GOVERNANCE_EVENT_PREFIX}${planAdmissionGovernanceEventDigest(event)}`;
}

export async function readPlanAdmissionGovernanceSnapshot(
  input: { workspaceId: string; potHomeSlug: string },
  sql?: Sql,
  deps: PlanAdmissionGovernanceStoreDeps = {},
): Promise<PlanAdmissionGovernanceSnapshot> {
  const resolvePotScope = deps.resolvePotScope ?? resolveFederatedPotScope;
  const listSettings = deps.listSettings ?? listHiveSettings;
  const potId = await resolvePotScope(
    input.workspaceId,
    input.potHomeSlug,
    sql === undefined ? undefined : { sql },
  );
  const rows = await listSettings(input.workspaceId, input.potHomeSlug, sql);
  const events: FederatedGovernanceEvent[] = [];
  const integrityErrors: string[] = [];
  const conflictedRoundIds = new Set<string>();
  const byEventId = new Map<string, { digest: string; roundId: string }>();

  for (const row of rows) {
    if (!row.settingKey.startsWith(PLAN_ADMISSION_GOVERNANCE_EVENT_PREFIX)) continue;
    if (!isFederatedGovernanceEvent(row.value)) {
      integrityErrors.push(`${row.settingKey}: invalid governance event`);
      continue;
    }
    const event = row.value;
    const expectedKey = planAdmissionGovernanceEventSettingKey(event);
    if (row.settingKey !== expectedKey) {
      integrityErrors.push(`${row.settingKey}: content digest does not match key`);
      continue;
    }
    if (event.potId !== potId) {
      integrityErrors.push(`${row.settingKey}: event belongs to pot '${event.potId}', expected '${potId}'`);
      continue;
    }
    const digest = planAdmissionGovernanceEventDigest(event);
    const prior = byEventId.get(event.eventId);
    if (prior && prior.digest !== digest) {
      conflictedRoundIds.add(prior.roundId);
      conflictedRoundIds.add(event.roundId);
    } else if (!prior) {
      byEventId.set(event.eventId, { digest, roundId: event.roundId });
    }
    events.push(event);
  }

  return { potId, events, conflictedRoundIds, integrityErrors };
}

/**
 * Append one immutable governance event to the pot's federated setting log.
 * Exact replay is idempotent; a local attempt to reuse an event id with different
 * bytes is refused before writing. Cross-peer races are detected on the read path.
 */
export async function appendPlanAdmissionGovernanceEvent(
  input: {
    workspaceId: string;
    potHomeSlug: string;
    event: FederatedGovernanceEvent;
  },
  sql?: Sql,
  deps: PlanAdmissionGovernanceStoreDeps = {},
): Promise<HiveSettingRecord> {
  if (!isFederatedGovernanceEvent(input.event)) {
    throw new Error('appendPlanAdmissionGovernanceEvent: invalid governance event');
  }
  const snapshot = await readPlanAdmissionGovernanceSnapshot(
    { workspaceId: input.workspaceId, potHomeSlug: input.potHomeSlug },
    sql,
    deps,
  );
  if (input.event.potId !== snapshot.potId) {
    throw new Error(
      `appendPlanAdmissionGovernanceEvent: event belongs to pot '${input.event.potId}', expected '${snapshot.potId}'`,
    );
  }
  const digest = planAdmissionGovernanceEventDigest(input.event);
  const conflict = snapshot.events.find(
    (event) =>
      event.eventId === input.event.eventId &&
      planAdmissionGovernanceEventDigest(event) !== digest,
  );
  if (conflict) {
    throw new Error(
      `appendPlanAdmissionGovernanceEvent: immutable conflict for event '${input.event.eventId}'`,
    );
  }
  const existing = snapshot.events.find(
    (event) => planAdmissionGovernanceEventDigest(event) === digest,
  );
  const settingKey = planAdmissionGovernanceEventSettingKey(input.event);
  if (existing) {
    const listed = (await (deps.listSettings ?? listHiveSettings)(
      input.workspaceId,
      input.potHomeSlug,
      sql,
    )).find((row) => row.settingKey === settingKey);
    if (listed) return listed;
  }
  return (deps.setSetting ?? setHiveSetting)(
    {
      workspaceId: input.workspaceId,
      potHomeSlug: input.potHomeSlug,
      settingKey,
      value: input.event,
    },
    sql,
  );
}
