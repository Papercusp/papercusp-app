/**
 * The ONE derivation of an announced gate declaration's generation state and
 * expected-condition verdict.
 *
 * Extracted from `events:status` (agent-tools/events/status.ts) so the
 * declared-gate recovery contract (declared-gate-recovery.ts) classifies with
 * exactly the reading the status surface reports — two copies of "is this
 * generation fired / did its expected SHA match" would drift, and a drift here
 * is precisely a timeout-to-success conversion (plan
 * declared-gate-recovery-contract-2026-09-21, R-002).
 */
import { payloadMatchesFilter } from './pattern';
import type { AwaitRow } from './types';

export type AnnouncementGenerationState = 'declared' | 'fired' | 'cancelled' | 'expired' | 'superseded';

export type AnnouncementExpectedVerdict = 'not-declared' | 'pending' | 'matched' | 'mismatched' | 'invalid';

type ExpectedCondition =
  | { kind: 'sha'; sha: string }
  | { kind: 'predicate'; predicate: unknown };

export function announcementGenerationState(row: AwaitRow): AnnouncementGenerationState {
  if (row.supersededAt) return 'superseded';
  if (row.cancelledAt) return 'cancelled';
  if (row.firedReason === 'expired') return 'expired';
  if (row.firedAt) return 'fired';
  return 'declared';
}

/** The SHA a fire payload carries, lower-cased — null when it names none. */
export function firedPayloadSha(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  for (const key of ['sha', 'commitSha', 'commit_sha', 'deployedSha', 'deployed_sha', 'testedSha', 'tested_sha']) {
    if (typeof p[key] === 'string') return p[key].toLowerCase();
  }
  return null;
}

export function announcementExpectedVerdict(row: AwaitRow): AnnouncementExpectedVerdict {
  if (row.expectedCondition == null) return 'not-declared';
  if (!row.firedAt) return 'pending';
  const expected = row.expectedCondition as Partial<ExpectedCondition> & Record<string, unknown>;
  if (expected.kind === 'sha' && typeof expected.sha === 'string') {
    const actual = firedPayloadSha(row.firedPayload);
    return actual != null && actual === expected.sha.toLowerCase() ? 'matched' : 'mismatched';
  }
  if (expected.kind === 'predicate' && expected.predicate != null) {
    return payloadMatchesFilter(expected.predicate, row.firedPayload) ? 'matched' : 'mismatched';
  }
  return 'invalid';
}
