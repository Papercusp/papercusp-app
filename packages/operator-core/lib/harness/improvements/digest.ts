/**
 * Triage-digest for the papercusp self-improvement loop (Phase 2 —
 * papercusp-self-improvement-loop-2026-06-04). Pure logic over a set of captured
 * improvement candidates: it scores, dedups, and splits them into the **auto
 * lane** (kind=bug, no protected surface — D-004) vs the **human queue** (the
 * rest), producing a compact, human-reviewable digest. No implementing happens
 * here — Phase 2 is "triage only, earns trust cheaply with nothing auto-built."
 *
 * Dedup is best-effort surfacing, NOT a gate (D-001: search-first + cheap merge,
 * never machinery). A duplicate is flagged for a human/agent to merge, not
 * blocked.
 */

import {
  partitionByTier,
  type ImprovementCandidate,
  type ImprovementSeverity,
  type RiskTierPolicy,
  type Tier,
  type TierDecision,
  type WorkItemKind,
  DEFAULT_RISK_TIER_POLICY,
} from './policy';
import { classifyIdeaType, type IdeaType } from './triage';
import { clusterByDiagnosis, type DiagnosisClusterReport } from './diagnosis-clusters';

const SEVERITY_WEIGHT: Record<ImprovementSeverity, number> = {
  critical: 40,
  major: 25,
  minor: 12,
  nit: 4,
};
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Shared lexical-duplicate threshold (DUP_THRESHOLD).  Keep this scalar in the
 * already-lightweight digest module so callers that only need the title-token
 * policy do not import the PG-bound capture implementation.
 */
export const DUP_THRESHOLD = 0.6;

export interface ScoredItem {
  id: string;
  kind: WorkItemKind;
  title: string;
  scope: string;
  severity?: ImprovementSeverity;
  state?: string;
  assignee?: string | null;
  /** When the assignee claimed it — the dispatch loop's in-flight signal. */
  assignedAt?: string | null;
  /** Last lifecycle update (issue.updated_at) — bumped by ANY claim/release/state
   *  change, including a cross-lane touch that clears assignee without ever
   *  going through the auto-implement dispatch loop (EI-8385: the interactive
   *  backlog-drain fleet claiming + releasing an item the auto-implement lane
   *  has an open dispatch on). Used for the short post-touch cooldown below —
   *  `assignedAt` alone goes stale the instant such a claim is released. */
  updatedAt?: string | null;
  /** Auto-implement dispatch attempts so far (anti-re-dispatch counter). */
  attempts?: number;
  tier: Tier;
  /** Priority score (higher = triage sooner). */
  score: number;
  ageDays: number;
  /** Why this tier — from the policy decision. */
  tierReason: string;
  /** Idea type — the D-005 routing taxonomy (consume-edges P-021). */
  ideaType?: IdeaType;
  /** Idea-lifecycle state (payload.ideaLifecycle.state) — undefined for legacy
   *  captures. The scheduled triage pass picks untriaged items off this. */
  ideaLifecycleState?: import('./lifecycle').IdeaLifecycleState;
  /** The Queen's (or the scheduled pass's) recorded type-route, when triaged. */
  triageDecision?: 'place' | 'gate' | 'gym' | 'reject';
  /** Who filed it (payload.sourceRole, P-010): 'Scout' | 'Queen' | 'bee' | 'system';
   *  undefined = human/legacy. Drives the Learning tab's source filter. */
  source?: string;
  /** EI-1404: a parsed quota/rate-limit reset instant (ISO) — see policy.ts's
   *  ImprovementCandidate.dispatchHoldUntil doc. Undefined = no hold. */
  dispatchHoldUntil?: string | null;
  /** Stable watchdog signal identity (payload.watchdogKey, '<source>:<key>').
   *  Absent ⇒ a KEYLESS item (human-filed / manual capture, or any non-watchdog
   *  source) — per the keyless-EI policy (P-014) these are surfaced for HUMAN
   *  REVIEW and never auto-dispatched, so a keyless item sitting at attempts:0
   *  is BY DESIGN, not a feed-pumping stall (EI-14223: consumers that key off
   *  `attempts === 0` alone must further gate on `watchdogKey` presence before
   *  treating the count as a genuine dispatcher-stuck signal). */
  watchdogKey?: string;
  /** EI-15659: federation provenance — 'remote' when this row is federated in from
   *  its authoring peer (this node cannot terminal-complete it locally; see
   *  policy.ts's ImprovementCandidate.workItemOrigin doc). Undefined = local. */
  workItemOrigin?: 'remote';
}

export interface DupCluster {
  /** The normalized signature the members share. */
  signature: string;
  ids: string[];
}

/**
 * Recurrence-decay over a STABLE friction signature (self-learning-central P-003,
 * D-003). The keystone is the same normalized-signature + Jaccard matcher the
 * dedup uses — NOT raw title text — so re-encountered friction collides even when
 * the wording differs. For one signature we count how often it recurred and how
 * long since it last did:
 *
 *   - `count` — how many captures share this signature (recurrence strength).
 *   - `lastSeenMs` — the most recent capture/update of the signature.
 *   - `decayDays` — days since `lastSeenMs`. The recurrence-decay OUTCOME signal
 *     (D-003): a signature that stopped recurring is a WEAK *negative* — "the
 *     friction may have stopped" — fine for the broad product/local class, too
 *     weak alone for the process/prompt class (that class earns the gym's
 *     positive A/B). This struct exposes the raw decay; the consumer applies the
 *     class-specific weight.
 *   - `openCount` / `resolvedCount` — split so a still-open recurring signature
 *     (active friction) reads differently from a resolved one (probably handled).
 */
export interface SignatureRecurrence {
  signature: string;
  count: number;
  openCount: number;
  resolvedCount: number;
  /** Member ids, newest-first. */
  ids: string[];
  lastSeenMs: number;
  decayDays: number;
}

/**
 * The "already decided: <reason>" recall (self-learning-central P-003). When a
 * NEW friction is captured, the loop should recognise it if the SAME stable
 * signature was already decided (resolved/closed) — so it doesn't re-propose a
 * settled question. This is the recall hit for one candidate title.
 */
export interface AlreadyDecidedRecall {
  /** The prior decided item that matches the signature. */
  id: string;
  title: string;
  state: string;
  /** Exact normalized-signature match, or a near-dup (Jaccard ≥ threshold). */
  matchKind: 'signature' | 'near-dup';
  similarity: number;
  /** The recall line: "already decided: <reason>" when a durable reason was recorded. */
  reason?: string;
}

/** The exact population count for the filter used to build a digest. */
export interface ImprovementDigestCensus {
  total: number;
}

/**
 * Rollups over the bounded candidate read. Keeping these beside the number of
 * examined rows makes it impossible to mistake a window statistic for a
 * corpus-wide census.
 */
export interface ImprovementDigestWindow {
  examined: number;
  windowed: boolean;
  open: number;
  byKind: Record<string, number>;
  bySeverity: Record<string, number>;
  byState: Record<string, number>;
}

export interface ImprovementDigest {
  generatedAt: string;
  /**
   * The TRUE corpus total for this filter (EI-18790490225750395 D2) — a real
   * `COUNT(*)`, never bounded by the caller's `limit`. Falls back to
   * `candidates.length` when the caller does not supply
   * {@link BuildDigestOptions.corpusTotal} (e.g. a caller that already fetched the
   * FULL corpus with no limit). This is deliberately nested away from the
   * window rollups so a reader cannot lift a bounded number into a census.
   */
  census: ImprovementDigestCensus;
  /** Rollups over the candidates this digest actually scored/considered. */
  window: ImprovementDigestWindow;
  /** Open + auto-eligible (kind=bug, no protected surface), highest score first. */
  autoEligible: ScoredItem[];
  /** Open + human-tier, highest score first. */
  humanQueue: ScoredItem[];
  /** Groups of likely-duplicate candidates (open + resolved) for cheap merge.
   *  `null` means the pass was SKIPPED (`nearDuplicates: false` — D-002); `[]`
   *  means it ran and found none. Never conflate the two — a caller that only
   *  wants the scalar rollups should treat `null` as "not computed", not as
   *  "no duplicates". */
  likelyDuplicates: DupCluster[] | null;
  /**
   * Makes the dedup pass's SCOPE explicit (EI-18790490225750395 D1) — a caller
   * reading `likelyDuplicates: []` at a small `limit` could otherwise reasonably
   * (and wrongly) conclude "no duplicates exist" when the pass never saw the rest
   * of the corpus. `null` when dedup itself did not run (`nearDuplicates: false`,
   * mirroring `likelyDuplicates`'s own null-means-skipped convention) or when
   * `total`/`windowed` are unknown (no `corpusTotal` supplied).
   *
   * The dedup pass deliberately stays WINDOW-scoped rather than re-fetching the
   * whole corpus to stay exhaustive: the corpus can run to five figures, the
   * O(n²) near-dup leg is already cost-gated at {@link NEAR_DUP_MAX_CANDIDATES},
   * and a prior full-corpus dedup pass measurably saturated the operator event
   * loop (WI-5820, ~840ms/cycle). This field is the documented fallback the
   * ticket that reported D1 itself proposed for exactly that cost tradeoff:
   * make the scoping VISIBLE instead of paying to eliminate it.
   */
  likelyDuplicatesScope: {
    consideredCount: number;
    corpusTotal: number;
    windowed: boolean;
    /**
     * Whether the cost-gated near-dup leg RAN (EI-19393516222436864). The three
     * fields above describe only the WINDOW, so before this they reported
     * `windowed: false` — i.e. "fully scoped, exhaustive" — on exactly the
     * full-corpus read where the near-dup leg is always skipped. Scope and
     * COMPLETENESS are different claims and this one was missing.
     */
    nearDupPass: 'ran' | 'skipped-cost-gate';
    /** Candidates the near-dup leg had to consider, vs its NEAR_DUP_MAX_CANDIDATES bound. */
    nearDupConsidered: number;
  } | null;
  /**
   * Recurring friction signatures (P-003) — every signature seen more than once,
   * recurrence + decay attached. The Queen reads this to weight a *recurring*
   * friction up and to spot one that has decayed (stopped recurring). Keyed on the
   * stable signature, so re-worded re-encounters collide. Sorted recurrence desc.
   */
  recurringSignatures: SignatureRecurrence[];
  /**
   * Recurring DIAGNOSES (P-005) — distinct filings that share a LESSON rather
   * than a topic, ranked by independent convergence (distinct authors).
   *
   * Deliberately a SEPARATE lane from {@link recurringSignatures}: that one keys
   * on the title signature, so it can only collide re-encounters worded the same
   * way. The most-filed agent-confusion class is topically diverse by
   * construction and is invisible to every topical key the lane owns — measured,
   * see diagnosis-clusters.ts. These members are NOT duplicates and must never be
   * merged; the "N different agents hit this" count is the signal.
   */
  diagnosisClusters: DiagnosisClusterReport;
  /** One-line summary for a coord broadcast / notification. */
  headline: string;
}

export interface BuildDigestOptions {
  policy?: RiskTierPolicy;
  /** Now, in ms — passed for deterministic tests; the tool passes Date.now(). */
  nowMs?: number;
  /**
   * The OWNER FULL-AUTONOMY grant (`FLAGS.MUG_FULL_AUTONOMY`, Phase 2). When true the
   * tier split lifts the protected-path/keyword TCB bars (see {@link classifyImprovement}),
   * so a protected-surface kind=bug lands in the auto lane. The IO boundary reads the flag;
   * defaults off (today's classification). Display surfaces that omit it render the baseline.
   */
  ownerFullAutonomy?: boolean;
  /**
   * Whether to run the near-dup / exact-signature clustering pass at all
   * (default true — unchanged behavior). Pass `false` when the caller only
   * reads scalar rollups (`window.open`, `autoEligible.length`, `humanQueue.length`,
   * `byKind`, `bySeverity`) and never touches `likelyDuplicates` — the O(n²)
   * `findLikelyDuplicates` pass is not called at all, and `likelyDuplicates`
   * comes back `null` rather than `[]` (D-001/D-002: the health tick was
   * paying ~840ms/cycle for a dedup clustering it discarded outright).
   */
  nearDuplicates?: boolean;
  /**
   * The TRUE corpus total for the SAME filter that produced `candidates`
   * (EI-18790490225750395 D2) — typically `countImprovementItems(sameOpts)`, a
   * real `COUNT(*)` unbounded by `limit`. Omit when the caller already fetched
   * the WHOLE corpus (no limit applied) — `total` then falls back to
   * `candidates.length` and `window.windowed` is false, unchanged from before this
   * option existed. Passing a value SMALLER than `candidates.length` is a caller
   * bug (the count and the read must agree on the same filter) — treated as
   * `candidates.length` rather than reporting a nonsensical negative window.
   */
  corpusTotal?: number;
}

/** Normalize a title into a dedup signature: strip a leading `[kind]`, lowercase,
 *  drop punctuation, sort the remaining word-tokens (so word-order differences
 *  still collide). */
export function dedupSignature(title: string): string {
  const noKind = title.replace(/^\s*\[(bug|change|feature|research-task|chunk)\]\s*/i, '');
  const tokens = noKind
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2); // drop tiny stopword-ish tokens
  return [...new Set(tokens)].sort().join(' ');
}

/**
 * The grouping key for recurrence counting: the machine-minted `watchdogKey` when
 * the filing carries one, else the normalized title signature.
 *
 * This is the precedence `hygiene.ts` has always applied when deciding what may
 * merge ("the key asserts one signal identity" — keyed never merges with keyless,
 * different keys never merge). `signatureRecurrence` simply did not share it, so
 * the recurrence/escalation leg counted repeats on free-prose titles alone, which
 * agent-authored filings almost never collide on.
 *
 * Measured on the live observation lane (papercusp-workspace, 2026-09-06) over the
 * 21,338 rows that carry a key: grouping by title signature reaches the escalation
 * threshold (3) for 155 groups; grouping by this key reaches it for 538 — 3.5x more
 * recurrence detected on the SAME rows. Coarsening the key further (dropping its
 * trailing message slug to group by `<tool>:<class>`) was measured and REJECTED: it
 * collapses 18,328 groups to 2,451 but moves threshold-reaching groups only 538 →
 * 539, buying no signal while creating a 953-member bucket.
 *
 * The `key:`/`sig:` namespace prefixes are load-bearing — they keep a keyed group
 * and a keyless group from ever colliding on the same string.
 */
export function recurrenceGroupKey(c: Pick<ImprovementCandidate, 'title' | 'watchdogKey'>): string {
  return c.watchdogKey ? `key:${c.watchdogKey}` : `sig:${dedupSignature(c.title)}`;
}

/**
 * Server-authored identity persisted on every issue-family admission.
 *
 * `titleKey` reuses the exact normalized signature the duplicate and recurrence
 * machinery already consumes; `signalKey` preserves the stronger source identity
 * when a watchdog/tool-failure caller has one. Keeping both avoids overloading
 * `payload.watchdogKey` (which has collector-specific lifecycle semantics) while
 * making every manual filing machine-groupable instead of keyless.
 */
export interface AdmissionIdentity {
  schemaVersion: 'admission-identity-v1';
  titleKey: string;
  signalKey?: string;
}

export function admissionIdentity(title: string, signalKey?: string): AdmissionIdentity {
  const signature = dedupSignature(title);
  // A valid title can consist entirely of short tokens ("UI is up"). The dedup
  // signature intentionally drops those tokens, but an admission identity may
  // never be empty, so retain a deterministic normalized-title fallback.
  const fallback = title.trim().toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  return {
    schemaVersion: 'admission-identity-v1',
    titleKey: `title:${signature || fallback}`,
    ...(signalKey?.trim() ? { signalKey: signalKey.trim() } : {}),
  };
}

/**
 * Lossless intake projection shared by the digest/fold lane and the saved review
 * flow (observation-candidate-acceptance-promotion-2026-09-30 P-003).
 *
 * This is deliberately a GROUPING contract, not an acceptance contract. Exact
 * stable identities and already-recorded canonical references may assemble the
 * evidence for one problem. Similarity, recurrence volume, consumption stamps,
 * and even the presence of a prior intake decision never grant execution
 * authority here; the later acceptance layer evaluates that independently.
 */
export const INTAKE_CANDIDATE_GROUP_SCHEMA_VERSION = 'intake-candidate-group-v1' as const;
export type IntakeEvidenceState = 'current' | 'stale' | 'unknown';

export interface IntakeEvidenceRef {
  /** Typed, navigable evidence reference (for example wi:, run:, test-run:). */
  ref: string;
  /** Currentness of the evidence bytes/revision themselves. */
  state: IntakeEvidenceState;
  /** Currentness of the code/runtime the evidence describes. */
  codeRuntimeState: IntakeEvidenceState;
  revision?: string;
  detail?: string;
}

export interface IntakeOccurrenceRef {
  ref: string;
  occurredAt?: string;
  kind?: string;
  evidenceRefs?: string[];
}

export interface IntakeRemedyRef {
  /** Stable identity of the proposed remedy, independent of the problem key. */
  key: string;
  ref: string;
  summary?: string;
}

export interface IntakeConsumptionRef {
  ref: string;
  mode: 'read' | 'backfill';
  at?: string;
}

export interface IntakeDecisionRef {
  ref: string;
  revision: string;
  disposition: string;
}

/** One already-resolved storage/input row supplied to the pure grouping pass. */
export interface IntakeCandidateSource {
  id: string;
  title: string;
  admissionIdentity?: AdmissionIdentity | null;
  conditionKey?: string | null;
  watchdogKey?: string | null;
  /** Existing canonical work-item refs, when a writer already resolved them. */
  canonicalRefs?: readonly string[];
  /** Additional navigable source refs (observation, report, thread, etc.). */
  sourceRefs?: readonly string[];
  occurrenceHistory?: readonly IntakeOccurrenceRef[];
  digestFoldRefs?: readonly string[];
  remedies?: readonly IntakeRemedyRef[];
  evidence?: readonly IntakeEvidenceRef[];
  consumption?: readonly IntakeConsumptionRef[];
  decisions?: readonly IntakeDecisionRef[];
}

export interface IntakeCandidateGroup {
  schemaVersion: typeof INTAKE_CANDIDATE_GROUP_SCHEMA_VERSION;
  /** Stable representative chosen by identity strength, never by similarity. */
  groupKey: string;
  /** Every exact identity that connected this component. */
  identityRefs: string[];
  sourceIds: string[];
  /** Complete navigable union, while typed collections below retain semantics. */
  sourceRefs: string[];
  canonicalRefs: string[];
  occurrenceHistory: Array<IntakeOccurrenceRef & { sourceId: string }>;
  digestFoldRefs: string[];
  remedies: Array<IntakeRemedyRef & { sourceIds: string[] }>;
  unresolvedRemedySourceIds: string[];
  evidence: Array<IntakeEvidenceRef & { sourceId: string }>;
  evidenceStates: Record<IntakeEvidenceState, number>;
  codeRuntimeStates: Record<IntakeEvidenceState, number>;
  consumption: Array<IntakeConsumptionRef & { sourceId: string }>;
  decisions: Array<IntakeDecisionRef & { sourceId: string }>;
  authority: {
    state: 'not-evaluated';
    reason: 'grouping-is-not-acceptance';
  };
}

function nonBlank(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].map((value) => value.trim()).filter(Boolean))].sort();
}

/**
 * Strong producer/problem identity outranks the lexical fallback. In particular,
 * two machine producers with different keys must not be joined merely because
 * their display titles are identical. Legacy/keyless rows fall back to the exact
 * persisted admission title key; no fuzzy similarity enters this function.
 */
function intakeIdentityRefs(source: IntakeCandidateSource): string[] {
  const canonical = uniqueSorted(source.canonicalRefs ?? []).map((ref) => `canonical:${ref}`);
  const conditionKey = nonBlank(source.conditionKey);
  const signalKey = nonBlank(source.admissionIdentity?.signalKey);
  const watchdogKey = nonBlank(source.watchdogKey);
  const strong = [
    ...canonical,
    ...(conditionKey ? [`condition:${conditionKey}`] : []),
    ...(signalKey ? [`signal:${signalKey}`] : []),
    ...(watchdogKey ? [`watchdog:${watchdogKey}`] : []),
  ];
  if (strong.length > 0) return uniqueSorted(strong);

  const persistedTitleKey =
    source.admissionIdentity?.schemaVersion === 'admission-identity-v1'
      ? nonBlank(source.admissionIdentity.titleKey)
      : null;
  return [`admission-title:${persistedTitleKey ?? admissionIdentity(source.title).titleKey}`];
}

const INTAKE_IDENTITY_PREFIX_ORDER = ['canonical:', 'condition:', 'signal:', 'watchdog:', 'admission-title:'] as const;

function intakeIdentityOrder(a: string, b: string): number {
  const rank = (value: string): number => {
    const index = INTAKE_IDENTITY_PREFIX_ORDER.findIndex((prefix) => value.startsWith(prefix));
    return index < 0 ? INTAKE_IDENTITY_PREFIX_ORDER.length : index;
  };
  return rank(a) - rank(b) || a.localeCompare(b);
}

class IntakeUnionFind {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }

  find(index: number): number {
    const parent = this.parent[index]!;
    if (parent === index) return index;
    const root = this.find(parent);
    this.parent[index] = root;
    return root;
  }

  union(a: number, b: number): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return;
    this.parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB);
  }
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  const out = new Map<string, T>();
  for (const value of values) if (!out.has(key(value))) out.set(key(value), value);
  return [...out.values()];
}

/**
 * Assemble exact-identity intake groups without making a triage or execution
 * decision. All output ordering is deterministic so a saved bulk run can pin the
 * projection and resume without recomputing a different membership order.
 */
export function assembleIntakeCandidateGroups(sources: readonly IntakeCandidateSource[]): IntakeCandidateGroup[] {
  const uf = new IntakeUnionFind(sources.length);
  const identities = sources.map(intakeIdentityRefs);
  const firstByIdentity = new Map<string, number>();
  for (let index = 0; index < identities.length; index += 1) {
    for (const identity of identities[index]!) {
      const first = firstByIdentity.get(identity);
      if (first === undefined) firstByIdentity.set(identity, index);
      else uf.union(first, index);
    }
  }

  const membersByRoot = new Map<number, Array<{ source: IntakeCandidateSource; index: number }>>();
  for (let index = 0; index < sources.length; index += 1) {
    const root = uf.find(index);
    const members = membersByRoot.get(root) ?? [];
    members.push({ source: sources[index]!, index });
    membersByRoot.set(root, members);
  }

  const groups: IntakeCandidateGroup[] = [];
  for (const members of membersByRoot.values()) {
    const identityRefs = uniqueSorted(members.flatMap(({ index }) => identities[index]!)).sort(intakeIdentityOrder);
    const sourceIds = uniqueSorted(members.map(({ source }) => source.id));
    const canonicalRefs = uniqueSorted(members.flatMap(({ source }) => source.canonicalRefs ?? []));
    const digestFoldRefs = uniqueSorted(members.flatMap(({ source }) => source.digestFoldRefs ?? []));

    const occurrenceHistory = uniqueBy(
      members.flatMap(({ source }) =>
        (source.occurrenceHistory ?? []).map((occurrence) => ({
          ...occurrence,
          evidenceRefs: occurrence.evidenceRefs ? uniqueSorted(occurrence.evidenceRefs) : undefined,
          sourceId: source.id,
        })),
      ),
      (occurrence) =>
        [occurrence.sourceId, occurrence.ref, occurrence.occurredAt ?? '', occurrence.kind ?? ''].join('\0'),
    ).sort(
      (a, b) =>
        (a.occurredAt ?? '').localeCompare(b.occurredAt ?? '') ||
        a.ref.localeCompare(b.ref) ||
        a.sourceId.localeCompare(b.sourceId),
    );

    const remedyByIdentity = new Map<string, IntakeRemedyRef & { sourceIds: string[] }>();
    for (const { source } of members) {
      for (const remedy of source.remedies ?? []) {
        const key = `${remedy.key.trim()}\0${remedy.ref.trim()}`;
        const prior = remedyByIdentity.get(key);
        if (prior) prior.sourceIds = uniqueSorted([...prior.sourceIds, source.id]);
        else
          remedyByIdentity.set(key, {
            ...remedy,
            key: remedy.key.trim(),
            ref: remedy.ref.trim(),
            sourceIds: [source.id],
          });
      }
    }
    const remedies = [...remedyByIdentity.values()].sort(
      (a, b) => a.key.localeCompare(b.key) || a.ref.localeCompare(b.ref),
    );

    const evidence = uniqueBy(
      members.flatMap(({ source }) => (source.evidence ?? []).map((item) => ({ ...item, sourceId: source.id }))),
      (item) =>
        [item.sourceId, item.ref, item.revision ?? '', item.state, item.codeRuntimeState, item.detail ?? ''].join('\0'),
    ).sort((a, b) => a.ref.localeCompare(b.ref) || a.sourceId.localeCompare(b.sourceId));
    const evidenceStates: Record<IntakeEvidenceState, number> = { current: 0, stale: 0, unknown: 0 };
    const codeRuntimeStates: Record<IntakeEvidenceState, number> = { current: 0, stale: 0, unknown: 0 };
    for (const item of evidence) {
      evidenceStates[item.state] += 1;
      codeRuntimeStates[item.codeRuntimeState] += 1;
    }

    const consumption = uniqueBy(
      members.flatMap(({ source }) => (source.consumption ?? []).map((item) => ({ ...item, sourceId: source.id }))),
      (item) => [item.sourceId, item.ref, item.mode, item.at ?? ''].join('\0'),
    ).sort((a, b) => a.ref.localeCompare(b.ref) || a.sourceId.localeCompare(b.sourceId));
    const decisions = uniqueBy(
      members.flatMap(({ source }) => (source.decisions ?? []).map((item) => ({ ...item, sourceId: source.id }))),
      (item) => [item.sourceId, item.ref, item.revision, item.disposition].join('\0'),
    ).sort((a, b) => a.ref.localeCompare(b.ref) || a.sourceId.localeCompare(b.sourceId));

    const sourceRefs = uniqueSorted(
      members.flatMap(({ source }) => [
        `wi:${source.id}`,
        ...(source.sourceRefs ?? []),
        ...(source.canonicalRefs ?? []),
        ...(source.digestFoldRefs ?? []),
        ...(source.occurrenceHistory ?? []).flatMap((item) => [item.ref, ...(item.evidenceRefs ?? [])]),
        ...(source.evidence ?? []).map((item) => item.ref),
        ...(source.consumption ?? []).map((item) => item.ref),
        ...(source.decisions ?? []).map((item) => item.ref),
        ...(source.remedies ?? []).map((item) => item.ref),
      ]),
    );

    groups.push({
      schemaVersion: INTAKE_CANDIDATE_GROUP_SCHEMA_VERSION,
      groupKey: identityRefs[0]!,
      identityRefs,
      sourceIds,
      sourceRefs,
      canonicalRefs,
      occurrenceHistory,
      digestFoldRefs,
      remedies,
      unresolvedRemedySourceIds: uniqueSorted(
        members.filter(({ source }) => (source.remedies?.length ?? 0) === 0).map(({ source }) => source.id),
      ),
      evidence,
      evidenceStates,
      codeRuntimeStates,
      consumption,
      decisions,
      authority: { state: 'not-evaluated', reason: 'grouping-is-not-acceptance' },
    });
  }

  return groups.sort((a, b) => a.groupKey.localeCompare(b.groupKey));
}

function tokenSet(title: string): Set<string> {
  return new Set(dedupSignature(title).split(' ').filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Title similarity in [0,1] — token-set Jaccard over the dedup signature.
 *  Used by the capture tool's soft search-first dedup (D-001). */
export function titleSimilarity(a: string, b: string): number {
  return jaccard(tokenSet(a), tokenSet(b));
}

/** A containment query needs at least this many signature tokens to count. Below it,
 *  "every token of my query appears in that title" is not evidence — a 2-token query
 *  is contained in half the backlog. */
export const CONTAINMENT_MIN_TOKENS = 4;

/**
 * Title CONTAINMENT in [0,1] — the overlap coefficient (|A∩B| / min(|A|,|B|)),
 * i.e. "how much of the SHORTER title is covered by the longer one".
 *
 * Why this exists alongside {@link titleSimilarity} (knowledge-at-symptom-time-2026-08-09
 * P-007): Jaccard divides by the UNION, so a short query that is a perfect SUBSET of a
 * longer stored title scores only |query|/|title|. That is a structural bias against the
 * exact shape of a symptom-first lookup — at symptom time your query is SHORT (the error
 * you just saw), while stored titles are LONG (written after diagnosis, so specific).
 *
 * MEASURED 2026-08-09: the query "No way to locate or focus an agent's desktop terminal
 * window" is a VERBATIM SUBSTRING of the stored title of EI-19948333346987654, and scored
 * BELOW the 0.6 lexical threshold — the dedup net returned `possibleDuplicates: []` for a
 * literal substring of an item filed 20 minutes earlier. Containment scores it 1.0.
 *
 * This is deliberately a SEPARATE signal, never folded into `titleSimilarity`: containment
 * is recall-oriented and asymmetric, so it is surfaced as advisory-only and MUST NOT be
 * allowed to decline a capture (see the blockEligible filter in capture-core). Widening
 * the BLOCKING net would trade a missed duplicate for a LOST filing, which is the more
 * expensive failure.
 *
 * Returns 0 when the shorter side has fewer than {@link CONTAINMENT_MIN_TOKENS} tokens.
 */
export function titleContainment(a: string, b: string): number {
  const sa = tokenSet(a);
  const sb = tokenSet(b);
  const shorter = Math.min(sa.size, sb.size);
  if (shorter < CONTAINMENT_MIN_TOKENS) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  return inter / shorter;
}

const NEAR_DUP_JACCARD = 0.8;

/** Minimum length of a quoted span to count as an error/exception SIGNATURE rather
 *  than incidental quoted prose (a short quoted word is not a distinguishing
 *  identity signal). */
const QUOTE_SIGNATURE_MIN_LEN = 20;
/** Upper bound so a runaway/garbled quote (unterminated across a huge body) can't
 *  produce a pathological match key. */
const QUOTE_SIGNATURE_MAX_LEN = 400;

/**
 * Extract normalized quoted-error signatures from free text (EI-18790490225750395
 * D3) — substrings wrapped in `"…"` or `` `…` ``, lowercased + whitespace-collapsed.
 * Watchdog-filed items routinely quote the triggering error/exception string
 * VERBATIM in the title or body; three items filed against the exact same Postgres
 * error ("no unique or exclusion constraint matching the ON CONFLICT specification")
 * had entirely different titles and were invisible to title-token dedup — a shared
 * quoted signature is a far stronger identity signal than title-prose overlap for
 * exactly this filing pattern.
 */
export function extractQuotedSignatures(text: string | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  const re = /"([^"]{1,1000})"|`([^`]{1,1000})`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const raw = m[1] ?? m[2] ?? '';
    const norm = raw.toLowerCase().replace(/\s+/g, ' ').trim();
    if (norm.length >= QUOTE_SIGNATURE_MIN_LEN && norm.length <= QUOTE_SIGNATURE_MAX_LEN) out.push(norm);
  }
  return out;
}

/** Above this candidate count the O(n²) near-dup pass is skipped (exact-signature
 *  clusters are still returned). Dedup is best-effort surfacing, NOT a gate
 *  (D-001), so degrading to exact-signature-only on a pathological backlog is safe
 *  — and it keeps findLikelyDuplicates off the operator event loop's critical path
 *  (round-4 P-001: the near-dup pass recomputed tokenSet() ~n²/2 times → a
 *  regex+sort+alloc storm + GC churn that saturated the loop at a 775+ backlog). */
export const NEAR_DUP_MAX_CANDIDATES = 4000;

/**
 * What {@link findLikelyDuplicatesDetailed} actually managed to do
 * (EI-19393516222436864).
 *
 * The near-dup leg is cost-gated at {@link NEAR_DUP_MAX_CANDIDATES}, and MEASURED
 * 2026-08-03 the production corpus is 15,166 open rows — so in practice that leg
 * had NEVER run, and nothing in the result said so. A caller saw only clusters,
 * and 80.7% of rows landing in none of them reads as a fact about the corpus
 * rather than about a skipped pass. This makes the degradation legible instead of
 * paying to remove a bound that is load-bearing (WI-5820: the quadratic pass was
 * the single largest first-party cost in a live CPU profile).
 */
export interface DupClusterResult {
  clusters: DupCluster[];
  /** Whether the O(n²) token-overlap leg ran, or was skipped by the cost gate. */
  nearDupPass: 'ran' | 'skipped-cost-gate';
  /** How many candidates that leg had to consider (post exact/quote claiming). */
  nearDupConsidered: number;
}

/** Cluster candidates that are likely duplicates (a shared quoted error/exception
 *  signature, exact normalized title-signature, OR title token-overlap ≥
 *  NEAR_DUP_JACCARD). Best-effort surfacing for a cheap merge.
 *
 *  Returns ONLY the clusters, so it cannot tell you whether the near-dup leg
 *  actually ran — prefer {@link findLikelyDuplicatesDetailed} when that matters
 *  (i.e. whenever you report coverage to anyone). Kept as-is for the callers that
 *  legitimately only consume clusters. */
export function findLikelyDuplicates(candidates: ImprovementCandidate[]): DupCluster[] {
  return findLikelyDuplicatesDetailed(candidates).clusters;
}

/** {@link findLikelyDuplicates}, plus whether the cost-gated near-dup leg ran. */
export function findLikelyDuplicatesDetailed(candidates: ImprovementCandidate[]): DupClusterResult {
  const clusters: DupCluster[] = [];
  const claimed = new Set<string>();

  // 0. quoted-error-signature groups (EI-18790490225750395 D3) — the STRONGEST
  // identity signal, computed FIRST so it takes priority over the weaker
  // title-based passes below: candidates quoting an IDENTICAL error/exception
  // string cluster together even when their titles share no vocabulary at all.
  const byQuoteSig = new Map<string, Set<string>>();
  for (const c of candidates) {
    const sigs = new Set([...extractQuotedSignatures(c.title), ...extractQuotedSignatures(c.body)]);
    for (const sig of sigs) {
      const set = byQuoteSig.get(sig) ?? new Set<string>();
      set.add(c.id);
      byQuoteSig.set(sig, set);
    }
  }
  for (const [sig, idSet] of byQuoteSig) {
    if (idSet.size > 1) {
      // Prefixed so a reader (and a test) can tell a quote-based cluster apart
      // from a title-signature one at a glance — same `signature` field, an
      // unambiguous namespace rather than a second field every consumer would
      // need to learn.
      clusters.push({ signature: `quote:${sig}`, ids: [...idSet] });
      idSet.forEach((id) => claimed.add(id));
    }
  }

  // 1. exact TITLE signature groups — compute each signature ONCE (reused in step
  // 2), skipping ids already claimed by the stronger quote-signature pass above.
  const bySig = new Map<string, string[]>();
  const sigById = new Map<string, string>();
  for (const c of candidates) {
    const sig = dedupSignature(c.title);
    sigById.set(c.id, sig);
    if (!sig || claimed.has(c.id)) continue;
    const arr = bySig.get(sig) ?? [];
    arr.push(c.id);
    bySig.set(sig, arr);
  }
  for (const [signature, ids] of bySig) {
    if (ids.length > 1) {
      clusters.push({ signature, ids });
      ids.forEach((id) => claimed.add(id));
    }
  }
  // 2. near-dup pass (token overlap) over the not-yet-claimed.
  const remaining = candidates.filter((c) => !claimed.has(c.id));
  // Bound: above NEAR_DUP_MAX_CANDIDATES skip the O(n²) pass (best-effort, D-001)
  // so a pathological backlog can't peg the event loop. The skip is REPORTED
  // rather than silent (EI-19393516222436864) — at production scale this is the
  // branch that always taken, so a caller that cannot see it is being told the
  // clustering was more complete than it was.
  if (remaining.length > NEAR_DUP_MAX_CANDIDATES) {
    return { clusters, nearDupPass: 'skipped-cost-gate', nearDupConsidered: remaining.length };
  }
  // Precompute each token set ONCE. The previous implementation recomputed
  // tokenSet() (regex strip + lowercase + split + sort + Set alloc) inside the
  // inner loop — ~n²/2 heavy calls — which dominated the operator-loop CPU + GC at
  // a 775+ backlog (round-4 P-001, cpuprofile-attributed). The inner loop is now a
  // cheap set intersection over the prebuilt sets; results are unchanged.
  const tokenSets = remaining.map((c) => tokenSet(c.title));
  // WI-5820: the inner loop still evaluated jaccard() for ALL ~n²/2 pairs, and a
  // live bg-host CPU profile (2026-07-25, loop-saturation-1785037317587, p95 692ms)
  // attributed 842ms of self-time — the single largest first-party cost in the
  // sampled window — to jaccard() under findLikelyDuplicates <- buildDigest. The
  // round-4 P-001 fix above removed the redundant tokenSet() work but left the
  // quadratic pair count intact.
  //
  // Skip pairs that CANNOT reach the threshold, using two conditions that are
  // provably necessary — so the returned clusters are byte-identical, this is a
  // pure cost reduction and not a behaviour change:
  //   (a) SHARED TOKEN. jaccard >= NEAR_DUP_JACCARD > 0 requires a non-empty
  //       intersection, so a pair sharing no token can never qualify. An inverted
  //       token index yields only the pairs that share at least one.
  //   (b) SIZE BAND. |a∩b| <= min(|a|,|b|) and |a∪b| >= max(|a|,|b|), so
  //       jaccard <= min/max. A pair whose sizes differ by more than the threshold
  //       ratio therefore cannot qualify, whatever its overlap.
  const postings = new Map<string, number[]>();
  for (let i = 0; i < tokenSets.length; i++) {
    for (const t of tokenSets[i]) {
      const arr = postings.get(t);
      if (arr) arr.push(i);
      else postings.set(t, [i]);
    }
  }
  for (let i = 0; i < remaining.length; i++) {
    if (claimed.has(remaining[i].id)) continue;
    const a = tokenSets[i];
    if (a.size === 0) continue;
    // Candidates j > i sharing >= 1 token with i, within the size band.
    const minSize = a.size * NEAR_DUP_JACCARD;
    const maxSize = a.size / NEAR_DUP_JACCARD;
    const candidateJs = new Set<number>();
    for (const t of a) {
      const arr = postings.get(t);
      if (!arr) continue;
      for (const j of arr) {
        if (j <= i) continue;
        const size = tokenSets[j].size;
        if (size < minSize || size > maxSize) continue;
        candidateJs.add(j);
      }
    }
    const group = [remaining[i].id];
    // MUST stay ascending: the pass claims greedily, so visiting js out of order
    // would change which cluster a contested candidate lands in. A Set iterates in
    // insertion order (token order), not numeric order — hence the explicit sort.
    for (const j of [...candidateJs].sort((x, y) => x - y)) {
      if (claimed.has(remaining[j].id)) continue;
      if (jaccard(a, tokenSets[j]) >= NEAR_DUP_JACCARD) {
        group.push(remaining[j].id);
        claimed.add(remaining[j].id);
      }
    }
    if (group.length > 1) {
      claimed.add(remaining[i].id);
      clusters.push({ signature: sigById.get(remaining[i].id) ?? dedupSignature(remaining[i].title), ids: group });
    }
  }
  return { clusters, nearDupPass: 'ran', nearDupConsidered: remaining.length };
}

/** The most recent activity timestamp for a candidate (resolution time when
 *  resolved/closed, else creation). The recurrence-decay clock. */
function lastSeenMsOf(c: ImprovementCandidate): number {
  const ts = c.updatedAt ?? c.createdAt;
  const parsed = ts ? Date.parse(ts) : NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Compute recurrence-decay per stable signature (P-003). Groups every candidate
 * by `dedupSignature` (the same matcher the dedup + recall use), then for each
 * signature reports recurrence strength + decay. Sorted by recurrence count desc,
 * then freshest-first — the most-recurring, most-recent friction surfaces first.
 */
export function signatureRecurrence(
  candidates: ImprovementCandidate[],
  opts: { nowMs?: number } = {},
): SignatureRecurrence[] {
  const nowMs = opts.nowMs ?? Date.now();
  const bySig = new Map<string, ImprovementCandidate[]>();
  for (const c of candidates) {
    // A KEYLESS candidate whose title normalizes to nothing has no identity to
    // group on (the original guard). A KEYED one always has one, so it is never
    // skipped — `recurrenceGroupKey` would otherwise return a truthy bare `sig:`.
    if (!c.watchdogKey && !dedupSignature(c.title)) continue;
    const sig = recurrenceGroupKey(c);
    const arr = bySig.get(sig) ?? [];
    arr.push(c);
    bySig.set(sig, arr);
  }
  const out: SignatureRecurrence[] = [];
  for (const [signature, members] of bySig) {
    const sorted = [...members].sort((a, b) => lastSeenMsOf(b) - lastSeenMsOf(a));
    const lastSeenMs = sorted.length ? lastSeenMsOf(sorted[0]) : 0;
    const openCount = members.filter((m) => (m.state ?? 'open') === 'open').length;
    const resolvedCount = members.length - openCount;
    out.push({
      signature,
      count: members.length,
      openCount,
      resolvedCount,
      ids: sorted.map((m) => m.id),
      lastSeenMs,
      decayDays: lastSeenMs ? Math.round(((nowMs - lastSeenMs) / DAY_MS) * 10) / 10 : 0,
    });
  }
  return out.sort((a, b) => b.count - a.count || b.lastSeenMs - a.lastSeenMs);
}

/**
 * "Already decided" recall (P-003). Given a candidate title and the set of PRIOR
 * candidates, surface decided (resolved/closed) items whose STABLE signature
 * matches — exact normalized-signature first, then a near-dup Jaccard pass — so a
 * new capture of a settled friction is recognised before it re-enters the queue.
 * Returns the strongest matches first. Reads the signature, never raw title.
 */
export function recallAlreadyDecided(
  title: string,
  prior: ImprovementCandidate[],
  opts: { minSimilarity?: number; excludeId?: string } = {},
): AlreadyDecidedRecall[] {
  const minSim = opts.minSimilarity ?? NEAR_DUP_JACCARD;
  const sig = dedupSignature(title);
  if (!sig) return [];
  const tokens = tokenSet(title);
  const hits: AlreadyDecidedRecall[] = [];
  for (const c of prior) {
    if (opts.excludeId && c.id === opts.excludeId) continue;
    const state = c.state ?? 'open';
    if (state === 'open') continue; // only ALREADY-DECIDED (resolved/closed) items recall
    const candSig = dedupSignature(c.title);
    if (!candSig) continue;
    const exact = candSig === sig;
    const sim = exact ? 1 : jaccard(tokens, tokenSet(c.title));
    if (!exact && sim < minSim) continue;
    hits.push({
      id: c.id,
      title: c.title,
      state,
      matchKind: exact ? 'signature' : 'near-dup',
      similarity: Math.round(sim * 100) / 100,
      ...(c.decidedReason ? { reason: `already decided: ${c.decidedReason}` } : {}),
    });
  }
  return hits.sort((a, b) => b.similarity - a.similarity);
}

function inc(rec: Record<string, number>, key: string): void {
  rec[key] = (rec[key] ?? 0) + 1;
}

function scoreOf(c: ImprovementCandidate, tier: Tier, ageDays: number): number {
  const sev = c.severity ? SEVERITY_WEIGHT[c.severity] : SEVERITY_WEIGHT.minor;
  // Age adds up to ~30 pts over a month (older = staler = triage sooner), capped.
  const age = Math.min(ageDays, 30);
  // A tiny nudge so the auto lane (verifiable, cheap to ship) floats up within a tier.
  const autoNudge = tier === 'auto' ? 3 : 0;
  return Math.round(sev + age + autoNudge);
}

function scoredItemOf(c: ImprovementCandidate, decision: TierDecision, nowMs: number): ScoredItem {
  const ageDays = c.createdAt ? Math.max(0, (nowMs - Date.parse(c.createdAt)) / DAY_MS) : 0;
  const { type: ideaType } = classifyIdeaType(c);
  return {
    id: c.id,
    kind: c.kind,
    title: c.title,
    scope: c.scope,
    severity: c.severity,
    state: c.state,
    assignee: c.assignee ?? null,
    assignedAt: c.assignedAt ?? null,
    updatedAt: c.updatedAt ?? null,
    attempts: c.attempts ?? 0,
    tier: decision.tier,
    score: scoreOf(c, decision.tier, ageDays),
    ageDays: Math.round(ageDays * 10) / 10,
    tierReason: decision.reasons[decision.reasons.length - 1] ?? '',
    ideaType,
    ...(c.ideaLifecycle ? { ideaLifecycleState: c.ideaLifecycle.state } : {}),
    ...(c.ideaLifecycle?.triageDecision ? { triageDecision: c.ideaLifecycle.triageDecision } : {}),
    ...(c.sourceRole ? { source: c.sourceRole } : {}),
    ...(c.dispatchHoldUntil ? { dispatchHoldUntil: c.dispatchHoldUntil } : {}),
    ...(c.watchdogKey ? { watchdogKey: c.watchdogKey } : {}),
    ...(c.workItemOrigin === 'remote' ? { workItemOrigin: 'remote' as const } : {}),
  };
}

/** Classify every candidate, retaining terminal rows for server-side stage filters. */
export function scoreImprovementCandidates(
  candidates: readonly ImprovementCandidate[],
  opts: BuildDigestOptions = {},
): ScoredItem[] {
  const nowMs = opts.nowMs ?? Date.now();
  const { decisions } = partitionByTier([...candidates], opts.policy ?? DEFAULT_RISK_TIER_POLICY, {
    ...(opts.ownerFullAutonomy !== undefined ? { ownerFullAutonomy: opts.ownerFullAutonomy } : {}),
  });
  return candidates.map((candidate) => scoredItemOf(candidate, decisions[candidate.id], nowMs));
}

/**
 * Build the triage digest from a set of candidates. Pure + deterministic given
 * `nowMs`. The auto/human split uses the risk-tier policy; only OPEN items are
 * queued (resolved/closed still count in the rollups + dedup).
 */
export function buildDigest(
  candidates: ImprovementCandidate[],
  opts: BuildDigestOptions = {},
): ImprovementDigest {
  const policy = opts.policy ?? DEFAULT_RISK_TIER_POLICY;
  const nowMs = opts.nowMs ?? Date.now();
  const { decisions } = partitionByTier(candidates, policy, {
    ...(opts.ownerFullAutonomy !== undefined ? { ownerFullAutonomy: opts.ownerFullAutonomy } : {}),
  });

  const byKind: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  const byState: Record<string, number> = {};
  const autoEligible: ScoredItem[] = [];
  const humanQueue: ScoredItem[] = [];
  let open = 0;

  for (const c of candidates) {
    inc(byKind, c.kind);
    if (c.severity) inc(bySeverity, c.severity);
    inc(byState, c.state ?? 'open');
    const isOpen = (c.state ?? 'open') === 'open';
    if (isOpen) open += 1;

    const decision = decisions[c.id];
    // Full-fidelity classification (D-005): the candidate carries paths +
    // watchdogKey + kind, which the taxonomy keys off — never a scope-only call.
    const scored = scoredItemOf(c, decision, nowMs);
    // Only OPEN items go into the actionable queues.
    if (!isOpen) continue;
    (decision.tier === 'auto' ? autoEligible : humanQueue).push(scored);
  }

  const byScore = (a: ScoredItem, b: ScoredItem): number => b.score - a.score;
  autoEligible.sort(byScore);
  humanQueue.sort(byScore);

  // P-001/D-001: skip the O(n²) near-dup pass entirely when the caller only
  // reads scalar rollups and never touches likelyDuplicates (the health tick
  // was paying ~840ms/cycle for a clustering it discarded outright). `null`
  // (not `[]`) marks "did not run" so a reader can never mistake skipped for
  // "ran, found none" (D-002).
  const dupResult = opts.nearDuplicates === false ? null : findLikelyDuplicatesDetailed(candidates);
  const likelyDuplicates = dupResult?.clusters ?? null;
  // Recurrence-decay on the stable signature (P-003) — only the signatures that
  // actually recurred (count > 1) are interesting for triage.
  const recurringSignatures = signatureRecurrence(candidates, { nowMs }).filter((s) => s.count > 1);
  const generatedAt = new Date(nowMs).toISOString();

  // D2: the TRUE corpus total, when the caller supplied it — never smaller than
  // what was actually returned (a caller passing a stale/mismatched count is a
  // bug on ITS side; clamping here keeps `windowed` sane rather than surfacing a
  // negative or nonsensical window from that bug).
  const returned = candidates.length;
  const total = opts.corpusTotal !== undefined ? Math.max(opts.corpusTotal, returned) : returned;
  const windowed = total > returned;

  const window: ImprovementDigestWindow = {
    examined: returned,
    windowed,
    open,
    byKind,
    bySeverity,
    byState,
  };
  const census: ImprovementDigestCensus = { total };

  const likelyDuplicatesScope =
    dupResult === null
      ? null
      : {
          consideredCount: returned,
          corpusTotal: total,
          windowed,
          nearDupPass: dupResult.nearDupPass,
          nearDupConsidered: dupResult.nearDupConsidered,
        };

  // P-005: a LINEAR pass, so unlike the O(n²) dedup leg it never degrades and is
  // always run over everything the caller loaded.
  const diagnosisClusters = clusterByDiagnosis(candidates);

  const topDiagnosis = diagnosisClusters.clusters[0];
  const headline =
    `papercusp-improvement digest: ${returned} of ${total} loaded${windowed ? ' (windowed)' : ''} (${open} open) — ` +
    `${autoEligible.length} auto-eligible, ${humanQueue.length} need a human` +
    (likelyDuplicates && likelyDuplicates.length ? `, ${likelyDuplicates.length} likely-dup cluster(s)` : '') +
    (windowed && likelyDuplicates && likelyDuplicates.length === 0
      ? ` (dedup scoped to the ${returned}-item window — pass a higher \`limit\` to check the rest of the ${total}-item corpus)`
      : '') +
    // The skip is the ALWAYS-taken branch at production scale, so a headline that
    // omits it overstates the dedup every single time it is read.
    (dupResult?.nearDupPass === 'skipped-cost-gate'
      ? ` ⚠ near-dup pass SKIPPED (${dupResult.nearDupConsidered} candidates > the ${NEAR_DUP_MAX_CANDIDATES} cost gate) — only exact title/quote signatures were clustered, so re-worded duplicates are NOT counted`
      : '') +
    (recurringSignatures.length ? `, ${recurringSignatures.length} recurring signature(s)` : '') +
    // Surfaced in the headline on purpose: this class went unaddressed while
    // narrower ones shipped, and a lane nobody reads is why. Lead with the axis
    // that makes it rankable — how many DIFFERENT agents hit it.
    (topDiagnosis
      ? `, top diagnosis "${topDiagnosis.shape}" filed ${topDiagnosis.rows}× by ${topDiagnosis.distinctAuthors} different agents`
      : '');

  return {
    generatedAt,
    census,
    window,
    autoEligible,
    humanQueue,
    likelyDuplicates,
    likelyDuplicatesScope,
    recurringSignatures,
    diagnosisClusters,
    headline,
  };
}
