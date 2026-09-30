/**
 * Typed policy and deterministic reducer for shared-pot plan admission.
 *
 * This is deliberately pure. The owner-signed Hive policy writer and the plan
 * lifecycle gate can embed/read the `governance.planAdmission` value without
 * introducing a second storage or governance runtime. Signatures are handled by
 * hive-policy-schema; this module validates the policy payload and evaluates a
 * ratification snapshot against an exact plan revision.
 */

export interface PlanAdmissionMateriality {
  /** Maximum changed lines that can use the lightweight materiality path. */
  maxChangedLines: number;
  /** Maximum changed plan items before a fresh round is required. */
  maxChangedItems: number;
}

/**
 * Whether an admission verdict is APPLIED or merely OBSERVED (P-013).
 *
 * `shadow` exists because the plan's activation model — "activate enforcement only
 * after evidence" — was otherwise unsatisfiable: the gate had exactly two states,
 * absent-policy (evaluates nothing, records nothing) and present-policy (refuses
 * for real across all seven doors), so the only way to learn what a policy WOULD
 * refuse was to switch it on and let it refuse the fleet. In `shadow` the verdict
 * is computed identically and reported, and the door proceeds regardless.
 *
 * `enforce` is the default everywhere it is absent, so a policy that exists but
 * predates this field still refuses. That direction is deliberate: an unreadable
 * or unstated mode must never be the one that disables the gate.
 */
export type PlanAdmissionMode = 'shadow' | 'enforce';

export const PLAN_ADMISSION_MODES: readonly PlanAdmissionMode[] = Object.freeze(['shadow', 'enforce'] as const);

/** Applied when a policy states no mode. See `PlanAdmissionMode` for why it is `enforce`. */
export const DEFAULT_PLAN_ADMISSION_MODE: PlanAdmissionMode = 'enforce';

export interface PlanAdmissionPolicy {
  /** Monotone owner-policy epoch, independent of a plan revision. */
  policyVersion: number;
  /** Quorum threshold in basis points of the eligible snapshot (0..10_000). */
  quorumBps: number;
  /** Approval threshold in basis points of cast, non-abstain votes (0..10_000). */
  approvalBps: number;
  /** Ratification validity window in seconds. */
  ratificationWindowSec: number;
  materiality: PlanAdmissionMateriality;
  /**
   * Observe-only or apply. OPTIONAL, defaulting to `enforce`.
   *
   * Optional rather than required so that adding it strands no existing
   * construction site; `resolvePlanAdmissionMode` is the ONE place the default is
   * applied, so no caller re-implements the fallback and drifts from it.
   */
  mode?: PlanAdmissionMode;
}

/** The effective mode of a policy — the one place the `enforce` default is applied. */
export function resolvePlanAdmissionMode(policy: Pick<PlanAdmissionPolicy, 'mode'>): PlanAdmissionMode {
  return policy.mode ?? DEFAULT_PLAN_ADMISSION_MODE;
}

export const DEFAULT_PLAN_ADMISSION_POLICY: PlanAdmissionPolicy = Object.freeze({
  policyVersion: 1,
  quorumBps: 5_000,
  approvalBps: 6_667,
  ratificationWindowSec: 7 * 24 * 60 * 60,
  materiality: Object.freeze({ maxChangedLines: 200, maxChangedItems: 3 }),
});

const isFiniteInt = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value);

function boundedInt(value: unknown, name: string, min: number, max: number): string | null {
  if (!isFiniteInt(value) || value < min || value > max) return `${name} must be an integer between ${min} and ${max}`;
  return null;
}

/** Validate an untrusted `governance.planAdmission` payload. */
export function validatePlanAdmissionPolicy(raw: unknown): { ok: true; policy: PlanAdmissionPolicy } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'governance.planAdmission must be an object' };
  const value = raw as Record<string, unknown>;
  for (const [key, min, max] of [
    ['policyVersion', 1, Number.MAX_SAFE_INTEGER],
    ['quorumBps', 0, 10_000],
    ['approvalBps', 0, 10_000],
    ['ratificationWindowSec', 1, 31_536_000],
  ] as const) {
    const error = boundedInt(value[key], `governance.planAdmission.${key}`, min, max);
    if (error) return { ok: false, error };
  }
  if (!value.materiality || typeof value.materiality !== 'object' || Array.isArray(value.materiality)) {
    return { ok: false, error: 'governance.planAdmission.materiality must be an object' };
  }
  const materiality = value.materiality as Record<string, unknown>;
  for (const [key, min, max] of [
    ['maxChangedLines', 0, 1_000_000],
    ['maxChangedItems', 0, 100_000],
  ] as const) {
    const error = boundedInt(materiality[key], `governance.planAdmission.materiality.${key}`, min, max);
    if (error) return { ok: false, error };
  }
  // An unrecognised mode is a MALFORMED policy, never a silent fallback to the
  // default. The caller (plan-admission-gate) turns a validation failure into a
  // present-and-unsatisfiable policy that refuses every certificate — so a typo'd
  // or hostile `mode` fails CLOSED, where defaulting it to `enforce` would have
  // been the same outcome by accident and defaulting to `shadow` would silently
  // disable the gate. Absent is the only permitted omission.
  if (value.mode !== undefined && !PLAN_ADMISSION_MODES.includes(value.mode as PlanAdmissionMode)) {
    return { ok: false, error: `governance.planAdmission.mode must be one of ${PLAN_ADMISSION_MODES.join(', ')}` };
  }
  return {
    ok: true,
    policy: {
      policyVersion: value.policyVersion as number,
      quorumBps: value.quorumBps as number,
      approvalBps: value.approvalBps as number,
      ratificationWindowSec: value.ratificationWindowSec as number,
      materiality: {
        maxChangedLines: materiality.maxChangedLines as number,
        maxChangedItems: materiality.maxChangedItems as number,
      },
      ...(value.mode === undefined ? {} : { mode: value.mode as PlanAdmissionMode }),
    },
  };
}

/**
 * Canonical, deterministic JSON bytes for signing or hashing a policy payload.
 *
 * ⚠ `mode` IS COVERED, and must stay covered. It is the switch between "this gate
 * refuses" and "this gate only watches", so leaving it out of the signed bytes
 * would let anyone who can edit the policy document flip enforcement off without
 * invalidating the owner's signature — a silent disable of the whole gate, which
 * is exactly what signing the policy exists to prevent.
 *
 * The EFFECTIVE mode is canonicalized, not the raw optional field: an omitted mode
 * and an explicit `enforce` mean the same thing and must therefore hash the same,
 * or the identical policy would produce two different signatures depending on how
 * it happened to be written.
 */
export function canonicalizePlanAdmissionPolicy(policy: PlanAdmissionPolicy): string {
  return JSON.stringify({
    approvalBps: policy.approvalBps,
    materiality: {
      maxChangedItems: policy.materiality.maxChangedItems,
      maxChangedLines: policy.materiality.maxChangedLines,
    },
    mode: resolvePlanAdmissionMode(policy),
    policyVersion: policy.policyVersion,
    quorumBps: policy.quorumBps,
    ratificationWindowSec: policy.ratificationWindowSec,
  });
}

export type PlanVote = { memberId: string; choice: 'approve' | 'reject' | 'abstain' };

export interface PlanAdmissionSnapshot {
  planRevisionHash: string;
  policyVersion: number;
  eligibleMemberIds: string[];
  votes: PlanVote[];
  ratifiedAtMs: number;
  /** Optional expiry override for replayed/imported snapshots. */
  expiresAtMs?: number;
}

export interface PlanAdmissionVerdict {
  admitted: boolean;
  reason:
    | 'approved'
    | 'wrong-policy-epoch'
    | 'expired'
    | 'no-eligible-members'
    | 'quorum-not-met'
    | 'approval-not-met'
    | 'duplicate-member-vote'
    | 'unknown-voter'
    | 'empty-plan-revision';
  eligibleCount: number;
  participatingCount: number;
  approveCount: number;
  rejectCount: number;
  abstainCount: number;
  quorumBps: number;
  approvalBps: number;
}

/**
 * Reduce one immutable ratification snapshot. Duplicate and unknown voters
 * refuse deterministically; abstentions count toward quorum but not approval.
 */
export function evaluatePlanAdmission(
  policy: PlanAdmissionPolicy,
  snapshot: PlanAdmissionSnapshot,
  nowMs: number,
): PlanAdmissionVerdict {
  const empty = (reason: PlanAdmissionVerdict['reason']): PlanAdmissionVerdict => ({
    admitted: false,
    reason,
    eligibleCount: snapshot.eligibleMemberIds.length,
    participatingCount: 0,
    approveCount: 0,
    rejectCount: 0,
    abstainCount: 0,
    quorumBps: 0,
    approvalBps: 0,
  });
  if (!snapshot.planRevisionHash.trim()) return empty('empty-plan-revision');
  if (snapshot.policyVersion !== policy.policyVersion) return empty('wrong-policy-epoch');
  const expiresAtMs = snapshot.expiresAtMs ?? snapshot.ratifiedAtMs + policy.ratificationWindowSec * 1000;
  if (!Number.isFinite(nowMs) || nowMs > expiresAtMs) return empty('expired');
  const eligible = new Set(snapshot.eligibleMemberIds);
  if (eligible.size === 0) return empty('no-eligible-members');
  const seen = new Set<string>();
  let approveCount = 0;
  let rejectCount = 0;
  let abstainCount = 0;
  for (const vote of snapshot.votes) {
    if (!eligible.has(vote.memberId)) return empty('unknown-voter');
    if (seen.has(vote.memberId)) return empty('duplicate-member-vote');
    seen.add(vote.memberId);
    if (vote.choice === 'approve') approveCount += 1;
    else if (vote.choice === 'reject') rejectCount += 1;
    else abstainCount += 1;
  }
  const participatingCount = seen.size;
  const quorumBps = Math.floor((participatingCount * 10_000) / eligible.size);
  const castCount = approveCount + rejectCount;
  const approvalBps = castCount === 0 ? 0 : Math.floor((approveCount * 10_000) / castCount);
  const base = { eligibleCount: eligible.size, participatingCount, approveCount, rejectCount, abstainCount, quorumBps, approvalBps };
  if (quorumBps < policy.quorumBps) return { admitted: false, reason: 'quorum-not-met', ...base };
  if (approvalBps < policy.approvalBps) return { admitted: false, reason: 'approval-not-met', ...base };
  return { admitted: true, reason: 'approved', ...base };
}
