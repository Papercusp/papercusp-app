/**
 * One typed view of every predicate that can keep a logical qualification from
 * starting (or resuming) a physical checkpoint run.
 *
 * The readers live in their existing owning modules. This file is deliberately
 * pure: callers gather one action-instant set of predicate results, then this
 * evaluator produces exactly one safe next action and one de-duplicated wait
 * tree. Keeping the decision here prevents the request handler, DBOS waiter and
 * detached runner from inventing subtly different blocker precedence.
 */

export const CHECKPOINT_ELIGIBILITY_SCHEMA_VERSION = 1 as const;

export const CHECKPOINT_ELIGIBILITY_PREDICATES = [
  'serializer-authority',
  'manual-run-admission',
  'qualification-transaction',
  'active-run',
  'frozen-repair-queue',
  'candidate',
  'required-ancestor',
  'quiet-cut-containment',
  'candidate-migrations',
  'dependency-generation',
  'target-relation-reservation',
  'backup-admission',
] as const;

export type CheckpointEligibilityPredicateCode =
  (typeof CHECKPOINT_ELIGIBILITY_PREDICATES)[number];

/**
 * `deferred` is resolved, not unknown: the predicate has an explicitly named
 * fail-closed preflight stage which runs before the suite. It therefore permits
 * only `launch-preflight-runner`, never a claim that the suite itself is ready.
 */
export type CheckpointEligibilityPredicateStatus =
  | 'clear'
  | 'deferred'
  | 'waiting'
  | 'blocked'
  | 'unreadable';

export interface CheckpointEligibilityPredicate {
  code: CheckpointEligibilityPredicateCode;
  status: CheckpointEligibilityPredicateStatus;
  detail: string;
  clearEvents: string[];
  evidenceRefs: string[];
}

export type CheckpointEligibilitySafeNextAction =
  | { code: 'launch-physical-run'; reason: string; waitEvents: string[] }
  | { code: 'launch-preflight-runner'; reason: string; waitEvents: string[] }
  | { code: 'await-current-run'; reason: string; waitEvents: string[] }
  | { code: 'await-blocker-events'; reason: string; waitEvents: string[] }
  | { code: 'read-release-control'; reason: string; waitEvents: string[] };

export interface CheckpointEligibilitySnapshot {
  schemaVersion: typeof CHECKPOINT_ELIGIBILITY_SCHEMA_VERSION;
  attemptId: string;
  observedAtMs: number;
  candidate: string | null;
  predicates: CheckpointEligibilityPredicate[];
  blockers: CheckpointEligibilityPredicate[];
  safeNextAction: CheckpointEligibilitySafeNextAction;
}

const uniqueStrings = (values: readonly string[], cap = 64): string[] =>
  [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, cap);

const normalizePredicate = (
  predicate: CheckpointEligibilityPredicate,
): CheckpointEligibilityPredicate => ({
  ...predicate,
  detail: predicate.detail.trim(),
  clearEvents: uniqueStrings(predicate.clearEvents),
  evidenceRefs: uniqueStrings(predicate.evidenceRefs),
});

function missingPredicate(code: CheckpointEligibilityPredicateCode): CheckpointEligibilityPredicate {
  return {
    code,
    status: 'unreadable',
    detail: 'predicate was not observed in this action-instant eligibility read',
    clearEvents: [],
    evidenceRefs: [],
  };
}

/**
 * Build the canonical snapshot. Missing or duplicate predicates fail closed:
 * every required code appears exactly once in the returned array, and a
 * duplicate becomes unreadable rather than depending on array order.
 */
export function buildCheckpointEligibilitySnapshot(input: {
  attemptId: string;
  candidate?: string | null;
  predicates: readonly CheckpointEligibilityPredicate[];
  observedAtMs?: number;
}): CheckpointEligibilitySnapshot {
  const grouped = new Map<CheckpointEligibilityPredicateCode, CheckpointEligibilityPredicate[]>();
  for (const raw of input.predicates) {
    if (!(CHECKPOINT_ELIGIBILITY_PREDICATES as readonly string[]).includes(raw.code)) continue;
    const rows = grouped.get(raw.code) ?? [];
    rows.push(normalizePredicate(raw));
    grouped.set(raw.code, rows);
  }

  const predicates = CHECKPOINT_ELIGIBILITY_PREDICATES.map((code) => {
    const rows = grouped.get(code) ?? [];
    if (rows.length === 0) return missingPredicate(code);
    if (rows.length === 1) return rows[0]!;
    return {
      code,
      status: 'unreadable' as const,
      detail: `predicate was observed ${rows.length} times; one action-instant authority is required`,
      clearEvents: uniqueStrings(rows.flatMap((row) => row.clearEvents)),
      evidenceRefs: uniqueStrings(rows.flatMap((row) => row.evidenceRefs)),
    };
  });
  const blockers = predicates.filter((predicate) =>
    ['waiting', 'blocked', 'unreadable'].includes(predicate.status),
  );
  const waitEvents = uniqueStrings(blockers.flatMap((blocker) => blocker.clearEvents));

  let safeNextAction: CheckpointEligibilitySafeNextAction;
  const unreadable = blockers.find((blocker) => blocker.status === 'unreadable');
  const activeRun = blockers.find(
    (blocker) => blocker.code === 'active-run' && blocker.status === 'waiting',
  );
  if (unreadable) {
    safeNextAction = {
      code: 'read-release-control',
      reason: `${unreadable.code} is unreadable; unknown launch state fails closed`,
      waitEvents,
    };
  } else if (activeRun) {
    safeNextAction = {
      code: 'await-current-run',
      reason: activeRun.detail,
      waitEvents,
    };
  } else if (blockers.length > 0) {
    safeNextAction = waitEvents.length > 0
      ? {
          code: 'await-blocker-events',
          reason: `${blockers.map((blocker) => blocker.code).join(', ')} must clear before launch`,
          waitEvents,
        }
      : {
          code: 'read-release-control',
          reason: `${blockers.map((blocker) => blocker.code).join(', ')} is blocked without a durable clear event`,
          waitEvents: [],
        };
  } else if (predicates.some((predicate) => predicate.status === 'deferred')) {
    safeNextAction = {
      code: 'launch-preflight-runner',
      reason: 'request-time predicates are clear; fail-closed candidate preflights remain before the suite',
      waitEvents: [],
    };
  } else {
    safeNextAction = {
      code: 'launch-physical-run',
      reason: 'every qualification predicate is clear at one action instant',
      waitEvents: [],
    };
  }

  return {
    schemaVersion: CHECKPOINT_ELIGIBILITY_SCHEMA_VERSION,
    attemptId: input.attemptId,
    observedAtMs: input.observedAtMs ?? Date.now(),
    candidate: input.candidate?.trim() || null,
    predicates,
    blockers,
    safeNextAction,
  };
}

export function parseCheckpointEligibilitySnapshot(value: unknown): CheckpointEligibilitySnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Partial<CheckpointEligibilitySnapshot>;
  if (
    row.schemaVersion !== CHECKPOINT_ELIGIBILITY_SCHEMA_VERSION ||
    typeof row.attemptId !== 'string' || !row.attemptId ||
    !Number.isFinite(row.observedAtMs) ||
    (row.candidate !== null && typeof row.candidate !== 'string') ||
    !Array.isArray(row.predicates) ||
    !Array.isArray(row.blockers) ||
    !row.safeNextAction || typeof row.safeNextAction !== 'object'
  ) return null;
  const parsed = buildCheckpointEligibilitySnapshot({
    attemptId: row.attemptId,
    candidate: row.candidate,
    observedAtMs: row.observedAtMs,
    predicates: row.predicates as CheckpointEligibilityPredicate[],
  });
  return JSON.stringify(parsed.predicates) === JSON.stringify(row.predicates) &&
    JSON.stringify(parsed.blockers) === JSON.stringify(row.blockers) &&
    JSON.stringify(parsed.safeNextAction) === JSON.stringify(row.safeNextAction)
      ? parsed
      : null;
}
