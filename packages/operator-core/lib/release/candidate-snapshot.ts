/**
 * The terminal green-checkpoint candidate snapshot.
 *
 * A checkpoint's candidate, failure set, repair ownership, and post-suite
 * measurements used to live in several loosely-related gate_health keys and
 * log trailers.  This module gives those facts one bounded, versioned shape.
 * It is deliberately independent of apps/operator so both the producer and
 * the reader can use the same parser and identity rules.
 */

import {
  isCheckpointCandidateSource,
  type CheckpointCandidateSource,
} from './checkpoint-candidate-source';

export const CANDIDATE_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const CANDIDATE_SNAPSHOT_MAX_AGE_MS = 3 * 60 * 60_000;
export const CANDIDATE_SNAPSHOT_MAX_FAILURES = 32;
export const CANDIDATE_SNAPSHOT_MAX_POST_SUITE_LEGS = 32;
export const CANDIDATE_SNAPSHOT_MAX_TEXT = 1000;

export type CandidateSnapshotSource = CheckpointCandidateSource;
export type CandidateSnapshotRetriageClassification = 'real-red' | 'stale-candidate' | 'unknown' | 'none';
export type CandidateSnapshotPostSuiteStatus = 'passed' | 'failed' | 'skipped';

export interface CandidateSnapshotPostSuiteLeg {
  id: string;
  status: CandidateSnapshotPostSuiteStatus;
  durationMs: number | null;
  skipReason: string | null;
}

export interface CandidateSnapshotOwnership {
  kind: 'moving-tip' | 'frozen-repair';
  frozenCandidate: string | null;
  repairHead: string | null;
  phase: string | null;
  fixerSpawnId: string | null;
}

export interface CandidateSnapshotSupersession {
  classification: CandidateSnapshotRetriageClassification;
  tip: string | null;
  repairHead: string | null;
}

/**
 * The one persisted gate_health record used to bind a release-fixer dispatch
 * to the exact verdict that produced it.
 */
export interface CandidateSnapshot {
  schemaVersion: typeof CANDIDATE_SNAPSHOT_SCHEMA_VERSION;
  /** Full candidate SHA, bounded for JSONB safety. */
  candidate: string;
  /** Green pin the candidate was selected from. */
  base: string | null;
  /** Producing checkpoint run identity; null for legacy/custom callers. */
  runId: string | null;
  source: CandidateSnapshotSource;
  /** When this terminal/pending observation was persisted. */
  observedAtMs: number;
  /** When the candidate was selected/finalized, when the producer supplied it. */
  selectedAtMs: number | null;
  candidateCommittedAt: string | null;
  commitsBehindTip: number | null;
  /** Stable P-012 failure signature, sorted and candidate-backed. */
  failureSignature: string;
  failingTests: string[];
  failingTestsMeasured: boolean | null;
  postSuiteMeasured: boolean | null;
  postSuiteLegs: CandidateSnapshotPostSuiteLeg[];
  ownership: CandidateSnapshotOwnership;
  supersession: CandidateSnapshotSupersession;
  /** Detects a torn/mutated snapshot before a CAS. */
  identity: string;
}

export interface CandidateSnapshotInput {
  candidate: string;
  base?: string | null;
  runId?: string | null;
  source?: CandidateSnapshotSource;
  observedAtMs?: number;
  selectedAtMs?: number | null;
  candidateCommittedAt?: string | null;
  commitsBehindTip?: number | null;
  failingTests?: readonly string[] | null;
  failingTestsMeasured?: boolean | null;
  postSuiteMeasured?: boolean | null;
  postSuiteLegs?: readonly {
    id: string;
    status: CandidateSnapshotPostSuiteStatus;
    durationMs?: number | null;
    skipReason?: string | null;
  }[] | null;
  repairQueue?: {
    candidate?: string | null;
    repairHead?: string | null;
    phase?: string | null;
    fixerSpawnId?: string | null;
  } | null;
  retriage?: {
    classification?: Exclude<CandidateSnapshotRetriageClassification, 'none'> | null;
    tip?: string | null;
  } | null;
}

/**
 * The queue identity a frozen-repair dispatcher is about to act on. Keep this
 * structural so the snapshot module stays independent of the queue reducer;
 * the dispatcher supplies the canonical queue row at the call site.
 */
export interface CandidateSnapshotDispatchRepairQueue {
  candidate: string;
  repairHead: string;
  phase: string;
  failingTests?: readonly string[] | null;
}

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function boundedSha(value: unknown): string | null {
  return boundedText(value, 64);
}

function boundedRunId(value: unknown): string | null {
  return boundedText(value, 128);
}

function boundedFailureList(values: readonly string[] | null | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values ?? []) {
    const item = boundedText(value, CANDIDATE_SNAPSHOT_MAX_TEXT);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length >= CANDIDATE_SNAPSHOT_MAX_FAILURES) break;
  }
  return out;
}

export function candidateSnapshotFailureSignature(
  failingTests: readonly string[] | null | undefined,
  candidate: string | null | undefined,
): string | null {
  const failures = boundedFailureList(failingTests);
  return failures.length > 0 ? failures.slice().sort().join(',') : boundedSha(candidate);
}

function stableIdentity(snapshot: Omit<CandidateSnapshot, 'identity'>): string {
  return JSON.stringify([
    snapshot.schemaVersion,
    snapshot.candidate.toLowerCase(),
    snapshot.base?.toLowerCase() ?? null,
    snapshot.runId,
    snapshot.source,
    snapshot.observedAtMs,
    snapshot.failureSignature,
    snapshot.ownership.frozenCandidate?.toLowerCase() ?? null,
    snapshot.ownership.repairHead?.toLowerCase() ?? null,
    snapshot.supersession.classification,
    snapshot.supersession.tip?.toLowerCase() ?? null,
  ]);
}

function parsePostSuiteLegs(raw: unknown): CandidateSnapshotPostSuiteLeg[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.slice(0, CANDIDATE_SNAPSHOT_MAX_POST_SUITE_LEGS).flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const row = value as Record<string, unknown>;
    const id = boundedText(row.id, CANDIDATE_SNAPSHOT_MAX_TEXT);
    const status = row.status;
    if (!id || (status !== 'passed' && status !== 'failed' && status !== 'skipped')) return [];
    const durationMs =
      typeof row.durationMs === 'number' && Number.isFinite(row.durationMs)
        ? Math.max(0, Math.trunc(row.durationMs))
        : null;
    return [
      {
        id,
        status,
        durationMs,
        skipReason: boundedText(row.skipReason, CANDIDATE_SNAPSHOT_MAX_TEXT),
      },
    ];
  });
}

/**
 * Build the bounded persisted representation.  Returning null for a missing
 * candidate is intentional: a snapshot without candidate identity cannot be
 * used for a safe dispatch CAS.
 */
export function buildCandidateSnapshot(
  input: CandidateSnapshotInput,
  nowMs: number = Date.now(),
): CandidateSnapshot | null {
  const candidate = boundedSha(input.candidate);
  if (!candidate || !Number.isFinite(nowMs)) return null;

  const failingTests = boundedFailureList(input.failingTests);
  const failureSignature =
    candidateSnapshotFailureSignature(failingTests, candidate) ?? candidate;
  const queue = input.repairQueue;
  const frozenCandidate = boundedSha(queue?.candidate);
  const repairHead = boundedSha(queue?.repairHead);
  const ownership: CandidateSnapshotOwnership = {
    kind: frozenCandidate ? 'frozen-repair' : 'moving-tip',
    frozenCandidate,
    repairHead,
    phase: boundedText(queue?.phase, 64),
    fixerSpawnId: boundedRunId(queue?.fixerSpawnId),
  };
  const retriageClassification: CandidateSnapshotRetriageClassification =
    input.retriage?.classification ?? 'none';
  const postSuiteLegs = (input.postSuiteLegs ?? []).slice(0, CANDIDATE_SNAPSHOT_MAX_POST_SUITE_LEGS).flatMap((leg) => {
    const id = boundedText(leg.id, CANDIDATE_SNAPSHOT_MAX_TEXT);
    if (!id) return [];
    return [
      {
        id,
        status: leg.status,
        durationMs:
          typeof leg.durationMs === 'number' && Number.isFinite(leg.durationMs)
            ? Math.max(0, Math.trunc(leg.durationMs))
            : null,
        skipReason: boundedText(leg.skipReason, CANDIDATE_SNAPSHOT_MAX_TEXT),
      },
    ];
  });
  const snapshotWithoutIdentity: Omit<CandidateSnapshot, 'identity'> = {
    schemaVersion: CANDIDATE_SNAPSHOT_SCHEMA_VERSION,
    candidate,
    base: boundedSha(input.base),
    runId: boundedRunId(input.runId),
    source: input.source ?? 'tip',
    observedAtMs: nowMs,
    selectedAtMs:
      typeof input.selectedAtMs === 'number' && Number.isFinite(input.selectedAtMs)
        ? input.selectedAtMs
        : null,
    candidateCommittedAt: boundedText(input.candidateCommittedAt, 64),
    commitsBehindTip:
      typeof input.commitsBehindTip === 'number' && Number.isFinite(input.commitsBehindTip)
        ? Math.max(0, Math.trunc(input.commitsBehindTip))
        : null,
    failureSignature,
    failingTests,
    failingTestsMeasured:
      typeof input.failingTestsMeasured === 'boolean' ? input.failingTestsMeasured : null,
    postSuiteMeasured:
      typeof input.postSuiteMeasured === 'boolean'
        ? input.postSuiteMeasured
        : input.postSuiteLegs !== undefined
          ? postSuiteLegs.length > 0
          : null,
    postSuiteLegs,
    ownership,
    supersession: {
      classification: retriageClassification,
      tip: boundedSha(input.retriage?.tip),
      repairHead,
    },
  };
  return { ...snapshotWithoutIdentity, identity: stableIdentity(snapshotWithoutIdentity) };
}

/**
 * Parse a JSONB value fail-closed.  Newer schema versions and identity
 * mismatches are unreadable rather than silently downgraded.
 */
export function parseCandidateSnapshot(raw: unknown): CandidateSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== CANDIDATE_SNAPSHOT_SCHEMA_VERSION) return null;
  const candidate = boundedSha(value.candidate);
  const runId = boundedRunId(value.runId);
  const base = boundedSha(value.base);
  const source =
    value.source === undefined
      ? ('tip' as const)
      : isCheckpointCandidateSource(value.source)
        ? value.source
        : null;
  const observedAtMs =
    typeof value.observedAtMs === 'number' && Number.isFinite(value.observedAtMs)
      ? value.observedAtMs
      : null;
  const selectedAtMs =
    typeof value.selectedAtMs === 'number' && Number.isFinite(value.selectedAtMs)
      ? value.selectedAtMs
      : null;
  const failureSignature = boundedText(value.failureSignature, CANDIDATE_SNAPSHOT_MAX_TEXT);
  const failingTests = Array.isArray(value.failingTests)
    ? boundedFailureList(value.failingTests.filter((entry): entry is string => typeof entry === 'string'))
    : null;
  const postSuiteLegs = parsePostSuiteLegs(value.postSuiteLegs);
  const ownershipRaw = value.ownership;
  const supersessionRaw = value.supersession;
  if (
    !candidate ||
    !source ||
    observedAtMs == null ||
    !failureSignature ||
    !failingTests ||
    !postSuiteLegs ||
    !ownershipRaw ||
    typeof ownershipRaw !== 'object' ||
    Array.isArray(ownershipRaw) ||
    !supersessionRaw ||
    typeof supersessionRaw !== 'object' ||
    Array.isArray(supersessionRaw)
  ) {
    return null;
  }
  const ownershipValue = ownershipRaw as Record<string, unknown>;
  const ownershipKind =
    ownershipValue.kind === 'moving-tip' || ownershipValue.kind === 'frozen-repair'
      ? ownershipValue.kind
      : null;
  const supersessionValue = supersessionRaw as Record<string, unknown>;
  const classification =
    supersessionValue.classification === 'real-red' ||
    supersessionValue.classification === 'stale-candidate' ||
    supersessionValue.classification === 'unknown' ||
    supersessionValue.classification === 'none'
      ? supersessionValue.classification
      : null;
  const commitsBehindTip =
    typeof value.commitsBehindTip === 'number' && Number.isFinite(value.commitsBehindTip)
      ? Math.max(0, Math.trunc(value.commitsBehindTip))
      : null;
  const snapshotWithoutIdentity: Omit<CandidateSnapshot, 'identity'> = {
    schemaVersion: CANDIDATE_SNAPSHOT_SCHEMA_VERSION,
    candidate,
    base,
    runId,
    source,
    observedAtMs,
    selectedAtMs,
    candidateCommittedAt: boundedText(value.candidateCommittedAt, 64),
    commitsBehindTip,
    failureSignature,
    failingTests,
    failingTestsMeasured:
      typeof value.failingTestsMeasured === 'boolean' ? value.failingTestsMeasured : null,
    postSuiteMeasured:
      typeof value.postSuiteMeasured === 'boolean' ? value.postSuiteMeasured : null,
    postSuiteLegs,
    ownership: {
      kind: ownershipKind ?? 'moving-tip',
      frozenCandidate: boundedSha(ownershipValue.frozenCandidate),
      repairHead: boundedSha(ownershipValue.repairHead),
      phase: boundedText(ownershipValue.phase, 64),
      fixerSpawnId: boundedRunId(ownershipValue.fixerSpawnId),
    },
    supersession: {
      classification: classification ?? 'none',
      tip: boundedSha(supersessionValue.tip),
      repairHead: boundedSha(supersessionValue.repairHead),
    },
  };
  const identity = typeof value.identity === 'string' && value.identity ? value.identity : null;
  if (!identity || identity !== stableIdentity(snapshotWithoutIdentity)) return null;
  return { ...snapshotWithoutIdentity, identity };
}

export function isCandidateSnapshotFresh(
  snapshot: CandidateSnapshot | null | undefined,
  nowMs: number = Date.now(),
  maxAgeMs: number = CANDIDATE_SNAPSHOT_MAX_AGE_MS,
): boolean {
  if (!snapshot || !Number.isFinite(nowMs) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) return false;
  const ageMs = nowMs - snapshot.observedAtMs;
  return ageMs >= 0 && ageMs <= maxAgeMs;
}

function sameSha(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = left?.trim().toLowerCase();
  const b = right?.trim().toLowerCase();
  return Boolean(a && b && (a === b || a.startsWith(b) || b.startsWith(a)));
}

/**
 * Check the identity a dispatcher is about to act on against the terminal
 * snapshot it read. The moving-tip path intentionally uses the same sorted
 * signature derivation as the dispatcher, preventing a fresh snapshot for a
 * different failure from being treated as equivalent.
 *
 * Frozen repair is a different stream: `candidate` is the immutable full-gate
 * pin in the persisted snapshot, while the dispatcher targets the queue's
 * mutable `repairHead`. Its queue row is the authoritative failure signature,
 * and the queue may remain awaiting-fixer longer than the moving-tip freshness
 * window. Only an identity-matched `awaiting-fixer` queue gets that age waiver;
 * malformed, phase-mismatched, or future-dated snapshots still fail closed.
 */
export function candidateSnapshotMatchesDispatch(
  snapshot: CandidateSnapshot | null | undefined,
  input: {
    candidate: string;
    failingTests?: readonly string[] | null;
    repairQueue?: CandidateSnapshotDispatchRepairQueue | null;
    nowMs?: number;
    maxAgeMs?: number;
  },
): boolean {
  if (!snapshot) return false;

  const nowMs = input.nowMs ?? Date.now();
  const queue = input.repairQueue;
  if (queue) {
    // A queue-aware dispatch is valid only for the one phase where a fixer is
    // owned by the queue. Do not turn this exception into a general stale-data
    // bypass, and do not accept a snapshot from the future.
    if (queue.phase !== 'awaiting-fixer' || !Number.isFinite(nowMs) || snapshot.observedAtMs > nowMs) {
      return false;
    }
    if (snapshot.ownership.kind !== 'frozen-repair' || snapshot.ownership.phase !== queue.phase) return false;
    if (!sameSha(snapshot.ownership.frozenCandidate, queue.candidate)) return false;
    if (!sameSha(snapshot.ownership.repairHead, queue.repairHead)) return false;
    if (!sameSha(queue.repairHead, input.candidate)) return false;
    // A hold tick records the immutable pin; a red verdict at the repair head
    // records that head in the legacy `candidate` field. Both are valid only
    // when the ownership fields above bind them to this exact queue row.
    if (!sameSha(snapshot.candidate, queue.candidate) && !sameSha(snapshot.candidate, queue.repairHead)) {
      return false;
    }
    const expected = candidateSnapshotFailureSignature(queue.failingTests, queue.candidate);
    return expected != null && snapshot.failureSignature === expected;
  }

  if (!isCandidateSnapshotFresh(snapshot, nowMs, input.maxAgeMs)) return false;
  if (!sameSha(snapshot.candidate, input.candidate)) return false;
  const expected = candidateSnapshotFailureSignature(input.failingTests, input.candidate);
  return expected != null && snapshot.failureSignature === expected;
}
