/**
 * THE HOLD REGISTRY — every reason a work-item can sit unworked, mapped to what ends it.
 *
 * Plan unified-bug-pipeline-and-honest-queue-2026-10-05, P-001 / D-026.
 *
 * WHY THIS FILE EXISTS. A row is "held" when something other than a free agent stands between
 * it and being worked: a claim floor refuses it, its readiness verdict is not `ready`, an
 * external blocker is active, a review is outstanding, it is parked, or it waits on the owner.
 * Each of those vocabularies grew in its own module, and none of them said WHO ends the hold or
 * WHEN anyone should look again. The measured result (2026-10-05 census) was hundreds of open
 * rows whose hold no lane, routine or person was responsible for — the stranded tool-failure
 * bugs P-003 swept were the largest single cohort.
 *
 * ONE ENTRY PER HOLD. Each entry names:
 *   - `class`    — `structural` (nothing changes until someone writes to the row) or
 *                  `transient` (it clears on its own; the clearer is already running);
 *   - `clearer`  — the lane, routine or owner that ends it. `ref` is concrete enough to act on;
 *   - `recheckSec` — how often a reader should test the hold again.
 *
 * THE VOCABULARIES ARE NOT RESTATED HERE AS TRUTH — they are PINNED. Each domain's key set is
 * checked in hold-registry.test.ts against the code vocabulary it covers (the claim-floor
 * oracle's ISSUE_FLOOR_EXPLANATIONS, EXTERNAL_BLOCKER_CAPABILITIES, AGENT_REVIEW_STATUSES), so a
 * new floor, capability or review state fails the build until it is registered here.
 *
 * REFUSAL. `assertHoldRegistered` is called by the readiness constructor
 * (`createImplementationReadiness`), so a non-ready readiness verdict with an unregistered
 * reason is refused at the write. Blocker capabilities and review statuses are closed enums
 * pinned by the totality test, so no unmapped value can reach those columns.
 *
 * DEPENDENCY-FREE AT RUNTIME on purpose: claim-floor-classification.ts and agent-review-policy.ts
 * both import this module, so it may only take TYPE imports from them.
 */
import type { ExternalBlockerCapability } from './external-blockers';

export type HoldDomain = 'claim-floor' | 'readiness' | 'blocker' | 'review' | 'park' | 'needs-human';
export type HoldClass = 'structural' | 'transient';
export type HoldClearerKind = 'lane' | 'routine' | 'owner';

export interface HoldClearer {
  readonly kind: HoldClearerKind;
  /** The concrete lane, routine or owner role that ends the hold. */
  readonly ref: string;
}

export interface HoldRegistryEntry {
  readonly domain: HoldDomain;
  readonly key: string;
  /** `prefix` only for reasons that carry run-specific text after a stable stem. */
  readonly match: 'exact' | 'prefix';
  readonly class: HoldClass;
  readonly clearer: HoldClearer;
  readonly recheckSec: number;
  /** The hold applies to some claimants only (D-023: verification conflict). */
  readonly claimantSpecific?: true;
}

const MIN = 60;
const QUARTER_HOUR = 15 * MIN;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function entry(
  domain: HoldDomain,
  key: string,
  cls: HoldClass,
  clearer: HoldClearer,
  recheckSec: number,
  extra: { match?: 'exact' | 'prefix'; claimantSpecific?: true } = {},
): HoldRegistryEntry {
  return {
    domain,
    key,
    match: extra.match ?? 'exact',
    class: cls,
    clearer,
    recheckSec,
    ...(extra.claimantSpecific ? { claimantSpecific: true as const } : {}),
  };
}

const lane = (ref: string): HoldClearer => ({ kind: 'lane', ref });
const routine = (ref: string): HoldClearer => ({ kind: 'routine', ref });
const owner = (ref: string): HoldClearer => ({ kind: 'owner', ref });

const AGENT_REVIEW_LANE = lane('improvements:agent-review (claim_next)');
const INTAKE_REVIEW_LANE = lane('attention:bulk-review (promote or investigate the intake candidate)');
const TRIAGE_LANE = lane('improvement-triage');
const STRANDED_SWEEP = routine('stranded-tool-failure-sweep (papercusp-invocation-friction watchdog pass)');

/** Prefix stem of the free-text legacy-adoption reason ('legacy-acceptance-adoption cohort <k> run <id>'). */
export const LEGACY_ACCEPTANCE_ADOPTION_REASON_PREFIX = 'legacy-acceptance-adoption';

export const HOLD_REGISTRY: readonly HoldRegistryEntry[] = [
  // ── claim floors: every label explainIssueClaimFloors can report (minus not-found) ──
  entry('claim-floor', 'not-claimable-status', 'structural', lane('work_items:set_state (a status write; a blocked row is cleared by its blocker)'), DAY),
  entry('claim-floor', 'observation-lane', 'structural', routine('improvement-triage (promotes or closes observations)'), DAY),
  entry('claim-floor', 'needs-owner-action', 'structural', owner('owner (work_items:update clears needsOwnerAction)'), DAY),
  entry('claim-floor', 'external-blocker', 'structural', lane('the blocker entry for each active capability'), HOUR),
  entry('claim-floor', 'claim-hold', 'structural', lane('the park entry (lease or park)'), HOUR),
  entry('claim-floor', 'plan-lane-reserved', 'structural', lane('the reserving plan lane (plan item claimant)'), DAY),
  entry('claim-floor', 'federation-detector', 'structural', lane('the p2p fleet'), DAY),
  entry('claim-floor', 'loop-noise', 'structural', routine('loop bookkeeping (loop:end settles the marker)'), DAY),
  entry('claim-floor', 'live-gate-ops', 'structural', lane('the registered gate fixer (gate.greenCheckpoint.ownership)'), HOUR),
  entry('claim-floor', 'already-completed', 'structural', routine('completion reconciliation (the terminal record settles status)'), DAY),
  entry('claim-floor', 'cross-machine-rig', 'structural', lane('a claimant with rigAvailable'), DAY),
  entry('claim-floor', 'origin', 'structural', lane('the origin node of the federated row'), DAY),
  entry('claim-floor', 'already-taken', 'transient', lane('the current holder (release or completion)'), QUARTER_HOUR),
  entry('claim-floor', 'admission-pending', 'transient', routine('work-items admission promoter'), 10 * MIN),
  entry('claim-floor', 'agent-review', 'transient', AGENT_REVIEW_LANE, HOUR),
  entry('claim-floor', 'watchdog-recovery-window', 'transient', routine('watchdog auto-close (six complete ran ticks)'), HOUR),
  entry('claim-floor', 'blocked-dep', 'transient', lane('the holder of the blocking work-item'), HOUR),
  entry('claim-floor', 'cooldown', 'transient', routine('elapsed time (release cooldown / filing grace)'), QUARTER_HOUR),
  entry('claim-floor', 'stop-line', 'transient', routine('green-checkpoint (lifts when the gate greens)'), HOUR),
  // D-023 point 3: claimant-specific — refused for the reporter or implementer only. The key is
  // the claim door's own refusal code (agent-tools/work_items/claim.ts), not an oracle label.
  entry('claim-floor', 'verification_conflict', 'transient', lane('an independent verifier (neither reporter nor implementer)'), HOUR, { claimantSpecific: true }),

  // ── readiness: every non-ready implementationReadiness reason a writer produces ──
  entry('readiness', 'awaiting-agent-review', 'transient', AGENT_REVIEW_LANE, HOUR),
  entry('readiness', 'agent-review-resubmitted', 'transient', AGENT_REVIEW_LANE, HOUR),
  entry('readiness', 'triage-alone-does-not-establish-readiness', 'transient', AGENT_REVIEW_LANE, DAY),
  entry('readiness', 'corroborated-tool-failure-awaiting-review', 'transient', STRANDED_SWEEP, HOUR),
  entry('readiness', 'deployment-freshness-unknown', 'transient', STRANDED_SWEEP, HOUR),
  entry('readiness', 'no-acceptance-evidence-at-creation', 'transient', INTAKE_REVIEW_LANE, DAY),
  entry('readiness', LEGACY_ACCEPTANCE_ADOPTION_REASON_PREFIX, 'transient', INTAKE_REVIEW_LANE, DAY, { match: 'prefix' }),
  entry('readiness', 'citation-evidence-unresolved', 'transient', TRIAGE_LANE, DAY),
  entry('readiness', 'awaiting-validation', 'transient', lane('validation gym'), DAY),
  entry('readiness', 'awaiting-owner-escalation', 'structural', owner('owner escalation (coord:ask-owner)'), DAY),
  entry('readiness', 'agent-review-revision-requested', 'structural', lane('the submitter (revise, then agent-review resubmit)'), DAY),
  entry('readiness', 'intake-retain', 'structural', routine('intake promotion (a new occurrence reopens the candidate)'), DAY),
  entry('readiness', 'intake-reject', 'structural', routine('intake promotion (a new occurrence reopens the candidate)'), DAY),
  entry('readiness', 'intake-promotion-reversed', 'structural', INTAKE_REVIEW_LANE, DAY),
  entry('readiness', 'repair-already-present-but-undeployed', 'transient', routine('release-trigger deploy (the repair goes live)'), HOUR),
  entry('readiness', 'cited-evidence-already-completed', 'structural', TRIAGE_LANE, DAY),
  entry('readiness', 'triage-rejected', 'structural', TRIAGE_LANE, DAY),

  // ── blockers: every ExternalBlockerCapability; ref is the capability's resolutionOwner ──
  entry('blocker', 'approval-auto-clearable', 'transient', lane('agent-authority'), HOUR),
  entry('blocker', 'credential', 'structural', owner('credential-provider'), DAY),
  entry('blocker', 'physical-device', 'structural', owner('device-holder'), DAY),
  entry('blocker', 'external-service-action', 'structural', owner('external-operator'), DAY),
  entry('blocker', 'live-dependency', 'transient', lane('dependency-owner'), HOUR),
  entry('blocker', 'product-decision', 'structural', owner('product-owner'), DAY),

  // ── review: every non-approved agentReview status ──
  entry('review', 'pending', 'transient', AGENT_REVIEW_LANE, HOUR),
  entry('review', 'revision-requested', 'structural', lane('the submitter (revise, then agent-review resubmit)'), DAY),

  // ── park: the two _claimHold provenance conventions (readWorkItemClaimHoldProvenance) ──
  entry('park', 'lease', 'transient', routine('lease expiry (held_open_by ends with its holder session)'), QUARTER_HOUR),
  entry('park', 'park', 'structural', lane('the parker named in claim_hold_by (release or update)'), DAY),

  // ── needs-human: an issue-family needs-human row with an active strict human ask ──
  entry('needs-human', 'strict-human-ask', 'structural', owner('owner (answers the ask; the blocker-default reaper applies defaultIfUnanswered at decideBy)'), DAY),
];

const BY_EXACT = new Map<string, HoldRegistryEntry>();
const PREFIXES: HoldRegistryEntry[] = [];
for (const e of HOLD_REGISTRY) {
  const k = `${e.domain}\u0000${e.key}`;
  if (BY_EXACT.has(k) || PREFIXES.some((p) => p.domain === e.domain && p.key === e.key)) {
    throw new Error(`hold registry: duplicate entry ${e.domain}:${e.key}`);
  }
  if (e.match === 'prefix') PREFIXES.push(e);
  else BY_EXACT.set(k, e);
}

/** The registry entry for a hold, or null when it is unregistered. Exact keys win over prefixes. */
export function resolveHold(domain: HoldDomain, key: string | null | undefined): HoldRegistryEntry | null {
  if (typeof key !== 'string' || key.length === 0) return null;
  const exact = BY_EXACT.get(`${domain}\u0000${key}`);
  if (exact) return exact;
  return PREFIXES.find((p) => p.domain === domain && (key === p.key || key.startsWith(`${p.key} `))) ?? null;
}

export class UnmappedHoldError extends Error {
  readonly code = 'unmapped_hold' as const;
  constructor(
    readonly domain: HoldDomain,
    readonly key: string,
  ) {
    super(
      `hold registry: refusing to write unregistered ${domain} hold '${key}'. Every hold must name ` +
        'its clearer and re-check time: add an entry to HOLD_REGISTRY in packages/operator-core/lib/hold-registry.ts ' +
        '(plan unified-bug-pipeline-and-honest-queue-2026-10-05 D-026).',
    );
    this.name = 'UnmappedHoldError';
  }
}

/** Refuse a hold write whose key has no registry entry. Returns the entry. */
export function assertHoldRegistered(domain: HoldDomain, key: string): HoldRegistryEntry {
  const found = resolveHold(domain, key);
  if (!found) throw new UnmappedHoldError(domain, key);
  return found;
}

/** Claim-floor labels of one class, for claim-floor-classification.ts (claimant-specific excluded). */
export function claimFloorLabels(cls: HoldClass): ReadonlySet<string> {
  return new Set(
    HOLD_REGISTRY.filter((e) => e.domain === 'claim-floor' && e.class === cls && !e.claimantSpecific).map(
      (e) => e.key,
    ),
  );
}

export function holdDomainKeys(domain: HoldDomain): string[] {
  return HOLD_REGISTRY.filter((e) => e.domain === domain).map((e) => e.key);
}

// ── classification of a stored row ──────────────────────────────────────────

export interface HoldMatch {
  readonly domain: HoldDomain;
  readonly key: string;
  /** null = the row is held by something the registry does not map (no clearer). */
  readonly entry: HoldRegistryEntry | null;
}

export interface HoldClassifiableRow {
  status: string;
  lane?: string | null;
  payload: unknown;
}

const NON_TERMINAL_STATUSES = new Set(['open', 'wip', 'blocked', 'needs-human']);
/**
 * Blocker capabilities only an owner can clear — DERIVED from the blocker entries whose clearer
 * is an owner. hold-registry.test.ts pins this set equal to the capabilities whose policy has
 * `requiresOwnerCapability` (external-blockers.ts), so the two cannot drift apart.
 */
export const OWNER_CAPABILITIES: ReadonlySet<ExternalBlockerCapability> = new Set(
  HOLD_REGISTRY.filter((e) => e.domain === 'blocker' && e.clearer.kind === 'owner').map(
    (e) => e.key as ExternalBlockerCapability,
  ),
);

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/**
 * An active, strict, answerable human ask: the precondition the needs-human entry registers, and
 * the ONE predicate every needs-human writer applies (D-029). It is the structured owner ask that
 * agent-review-policy readStructuredOwnerAsk reads (question = summary, asker = createdBy,
 * askedAt = a parseable createdAt, unblockedBy = nextVerb, a strict owner capability) PLUS a
 * nonblank defaultIfUnanswered, which is what makes it answerable: the owner can see what happens
 * if they never reply. All of it must hold on the SAME blocker.
 */
export function hasActiveStrictHumanAsk(payload: unknown): boolean {
  const blockers = obj(payload)?.externalBlockers;
  if (!Array.isArray(blockers)) return false;
  return blockers.some((raw) => {
    const b = obj(raw);
    return (
      b !== null &&
      b.status === 'active' &&
      b.kind === 'human' &&
      OWNER_CAPABILITIES.has(b.capability as ExternalBlockerCapability) &&
      str(b.summary) !== null &&
      str(b.createdBy) !== null &&
      str(b.nextVerb) !== null &&
      typeof b.createdAt === 'string' &&
      Number.isFinite(Date.parse(b.createdAt)) &&
      str(b.defaultIfUnanswered) !== null
    );
  });
}

/**
 * Every hold on a stored row, each resolved against the registry. An empty list means the row
 * is not held by any registered vocabulary (it may still be refused by a claim floor; those are
 * read through `explainIssueClaimFloors`, whose labels are the claim-floor domain).
 */
/**
 * The payload keys `classifyHolds` reads — and ONLY those. A reader that projects payloads before
 * classifying (the hold census pages every non-terminal row, so it cannot ship whole payloads)
 * selects exactly these. hold-registry.test.ts pins it: classifying a fixture through the
 * projection must equal classifying the whole payload, so a new key read here without being
 * listed fails the build instead of silently reading as "not held".
 */
export const HOLD_PAYLOAD_KEYS = [
  'implementationReadiness',
  'agentReview',
  'externalBlockers',
  '_claimHold',
  'held_open_by',
] as const;

export function classifyHolds(row: HoldClassifiableRow): HoldMatch[] {
  if (!NON_TERMINAL_STATUSES.has(row.status) || row.lane === 'observation') return [];
  const payload = obj(row.payload) ?? {};
  const out: HoldMatch[] = [];
  const push = (domain: HoldDomain, key: string) => out.push({ domain, key, entry: resolveHold(domain, key) });

  const readiness = obj(payload.implementationReadiness);
  if (readiness && readiness.status !== 'ready') {
    push('readiness', str(readiness.reason) ?? '(missing reason)');
  }
  const review = obj(payload.agentReview);
  if (review && review.status !== 'approved') push('review', str(review.status) ?? '(missing status)');

  if (Array.isArray(payload.externalBlockers)) {
    for (const raw of payload.externalBlockers) {
      const b = obj(raw);
      if (b?.status === 'active') push('blocker', str(b.capability) ?? '(missing capability)');
    }
  }
  if (payload._claimHold === true) {
    push('park', str(payload.held_open_by) ? 'lease' : 'park');
  }
  if (row.status === 'needs-human') {
    out.push(
      hasActiveStrictHumanAsk(payload)
        ? { domain: 'needs-human', key: 'strict-human-ask', entry: resolveHold('needs-human', 'strict-human-ask') }
        : { domain: 'needs-human', key: 'needs-human-without-answerable-ask', entry: null },
    );
  }
  return out;
}
