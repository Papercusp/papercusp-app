/**
 * capture-core.ts — the shared capture verb of the self-improvement loop
 * (papercusp-self-improvement-loop-2026-06-04 D-001 +
 * close-the-self-improvement-loop-2026-06-05 D-002/D-003).
 *
 * ONE implementation of "file a captured papercusp improvement" used by BOTH
 * entry points:
 *   - the agent-facing `improvements:capture` tool (the soft prompt-nudge feed),
 *   - the watchdog's event-driven captures (the hard feed-in, D-003).
 *
 * It owns the capture semantics:
 *   - **dedup verdict annotation** (P-002/D-001): surfaces likely-existing items and
 *     records the verdict on the created row; normal filing is never declined. The
 *     explicit `checkDuplicatesOnly` probe is the non-persisting path.
 *   - **native `kind`** (close-loop D-002): writes the real `engineer_issues.kind`
 *     column (bug | change). The title-prefix convention is RETIRED. `feature`
 *     captures (net-new, rare) store as kind='change' + `payload.improvementKind:
 *     'feature'` — engineer_issues = work_items[kind ∈ bug|change|task]
 *     (migration 152) and the feature *family* lives in the features base table,
 *     so 'feature' is a display refinement here, not a storage kind.
 *   - **candidate `paths`** (close-loop D-002): stored in `payload.paths` so the
 *     protected-path gate (`classifyImprovement`) actually fires.
 *   - auto-tags the built-in `papercusp-improvement` topic (+ optional sub-topic).
 *
 * Deps are injectable so the core is unit-testable without PG.
 */

import {
  createIssue,
  getIssue,
  releaseIssue,
  searchIssuesForDedup,
  findIssuesByWatchdogKeys,
  findIssuesByToolFailureClassKeys,
  updateIssue,
  mergeIssuePayload,
  tagIssue,
  untagIssue,
  setIssueState,
  type EngineerIssue,
  type IssueSeverity,
  type IssueSource,
  type CreateIssueInput,
} from '../../issues-engineer';
import { findSemanticDupes, type SemanticDupeResult } from '../../agent-tools/work_items/semantic-dupe-guard';
import { acquireWithContentionRetry } from '../../agent-tools/locks/contention-retry';
import type { DedupCandidateStamp } from '../../agent-tools/work_items/dedup-candidates-stamp';
import type { AdmissionBypassReason } from '../../work-items-admission';
import { FLAGS } from '@papercusp/flags';
import {
  normalizeSuspectedToolFailure,
  toolFailureSignatureKey,
  type SuspectedToolFailure,
} from './tool-error-classifier';
import { getFlag } from '@papercusp/flags/server';
import { classifyObservationFold, type FoldCandidate, type FoldClassification } from './observation-fold';
import { trackDetached } from '../../detached-imports';
import { withBoundedTimeout } from '../../bounded-timeout';
import { IMPROVEMENT_TOPIC, OBSERVATION_TOPIC, issueToCandidate } from './read-items';
import {
  validateObservationRatings,
  validateScorecardCompleteness,
  validateScorecardRatingValues,
  validateScorecardPoorRatingDisposition,
  normalizeScorecardRatings,
  type StructuredObservation,
} from './observation-types';
import { getRubric, autoRatifyRubricOnFirstScorecard, type Rubric } from '../../rubrics';
import {
  admissionIdentity,
  titleSimilarity,
  titleContainment,
  DUP_THRESHOLD,
  recallAlreadyDecided,
  type AdmissionIdentity,
  type AlreadyDecidedRecall,
} from './digest';
import { initializeIdeaLifecycle } from './lifecycle';
import { createImplementationReadiness, type ImplementationReadinessState } from './agent-review-policy';
import { extractCitedIds } from './triage';
import { DEFAULT_SIGNAL_ORIGIN, effectiveOrigin, type SignalOrigin } from './provenance';
import { ANY_FAMILY_TERMINAL_STATES } from '../../work-item-dispatch-states';
import { canonicalPotSlug, PLATFORM_POT_SLUG } from '../../platform-pot-slug';
import { isFlakeKey } from '../../calibration/types';
import {
  decideIssueAdmissionCircuit,
  readIssueAdmissionPressure,
  recordIssueOccurrence,
  selectCanonicalIssue,
  type IssueAdmissionPressure,
  type IssueOccurrenceKind,
  type RecordIssueOccurrenceInput,
  type RecordedIssueOccurrence,
} from '../../issue-occurrence-ledger';

/** The fileable improvement kinds (companion D-001). */
export type ImprovementKind = 'bug' | 'change' | 'feature';

// Re-export the shared threshold for existing capture-core callers while keeping
// the value owned by the lightweight digest policy module.
export { DUP_THRESHOLD };

/** Keep the lexical dedup leg from holding the whole capture request hostage. */
export const CAPTURE_LEXICAL_SEARCH_BUDGET_MS = 1_500;

/**
 * A capture's final INSERT is an atomic bounded transaction. A transient PG
 * contention timeout aborts that transaction before commit, so retrying the
 * complete create is safe and prevents the failure-reporting path from losing
 * the finding it is trying to record. Keep this to one retry: the caller still
 * receives the typed timeout envelope when contention is sustained.
 */
export const CAPTURE_CONTENTION_BACKOFFS_MS = [500] as const;

/**
 * Fraction of the SHORTER title that must be covered for a candidate to be SURFACED as a
 * containment hit (knowledge-at-symptom-time-2026-08-09 P-007). Advisory-only: a
 * containment hit is never eligible to carry a blocking dedup verdict — see `blockEligible`.
 */
export const CONTAINMENT_THRESHOLD = 0.9;

export interface CaptureImprovementInput {
  /** One-line summary — clean, NO [kind] prefix (kind is a real column now). */
  title: string;
  kind: ImprovementKind;
  body?: string;
  severity?: IssueSeverity;
  /** Optional sub-area topic, e.g. coord-dx, db-tooling. */
  subTopic?: string;
  /** Omit → files under the workspace platform Pot; or 'harness:<slug>' for a specific Pot.
   *  An omitted/'operator'/workspace-global scope auto-homes to the platform Pot in
   *  createIssue (pot-membership-enforcement P-005). Determines per-Hive scope (P-010). */
  scope?: string;
  foundDuring?: string;
  /** Repo-relative paths the improvement touches — feeds the protected-path gate. */
  paths?: string[];
  /** scorecard-poor-rating-disposition (owner-directed 2026-08-31): when true, a
   *  fail/severe/broken/degraded/partial rating on a standard rubric must carry
   *  `remediation` (a WI-/EI-/F- ref) or `disregard` (a reasoned opt-out) — see
   *  validateScorecardPoorRatingDisposition. Set by the AGENT-facing capture tool;
   *  system floor emitters (pulse/backstop/watchdogs) leave it unset so the
   *  monitoring floor can never be broken by the gate. */
  enforcePoorRatingDisposition?: boolean;
  /** Caller asserts distinctness: suppresses the payload.dedupVerdict annotation
   *  and the burst-admission coalesce (P-002 — the former search-first decline this
   *  flag used to override is retired; every filing is accepted either way). */
  force?: boolean;
  /**
   * DRAIN admission rail — measurement-only since P-002 (D-001): the degraded-
   * coverage VETO is retired, so this no longer rejects anything; the coverage
   * verdict is stamped on the row (payload.dedupCoverage) either way. The
   * agent-facing wrapper derives this from the caller's live mode registry — it is
   * deliberately not a public caller override.
   */
  requireCompleteDedupCoverage?: boolean;
  /** Only run the dedup search, do not create. */
  checkDuplicatesOnly?: boolean;
  /**
   * Which duplicates count toward the file-time dedup VERDICT (P-002: annotation
   * on the created row, no longer a decline): 'all' (default) or 'open' (only an
   * OPEN dup counts — the watchdog's mode: a RESOLVED duplicate means the problem
   * regressed, so it re-files verdict-free unless the evidence is stale, D-002).
   */
  dedupScope?: 'all' | 'open';
  /**
   * Lowest semantic band eligible to carry the file-time dedup VERDICT (P-002:
   * payload.dedupVerdict annotation — the decline it used to gate is retired).
   * Default `'hard'`: a soft hit stays advisory because a soft-band identity
   * guess is not evidence of duplication (see `blockEligible` below).
   *
   * `'soft'` lets a soft-band hit carry the verdict too, and is for HIGH-VOLUME
   * MACHINE ideation ONLY — the Scout capture port (`buildCapturePort`), where
   * near-siblings dominate the corpus and the resolver wants them flagged.
   *
   * Measured 2026-08-09 (plan learning-loop-identity-and-consumption-2026-08-08,
   * D-032/D-033): of 507 open Scout-minted items carrying the `improvementBody`
   * template, 407 (80%) had a nearest open sibling in the SOFT band [0.85,0.93)
   * and 64 more in the hard band — only 36 were genuinely novel. The soft band
   * is where this backlog actually comes from.
   *
   * ⚠ Never set this on the agent-facing `improvements:capture` tool: owner
   * constraint D-004 (scorecard-blender-pipeline-fixes-2026-07-11) is that a
   * promotion/dedup gate applies to blender output ONLY, never to direct agent
   * filings.
   */
  semanticBlockBand?: 'hard' | 'soft';
  /**
   * Stable signal identity (`'<source>:<key>'`, or `overwatch:<anomalyKind>` from
   * the Kettle brief — watchdog-audit P-004 / D-001; EI-15448). Stamped into
   * `payload.watchdogKey` so cross-tick dedup is an exact indexed lookup instead
   * of a fuzzy title match. For a NON-observation capture this sharpens the title
   * net: a candidate carrying a DIFFERENT watchdogKey is a different signal and
   * never carries a blocking verdict for this capture (kills the subset-title false-dedup edge — a
   * nested-path red-test title token-subsetting another).
   *
   * For an `lane:'observation'` capture (EI-15448), this field does something
   * stronger: observations otherwise skip dedup entirely by design (recurrence
   * IS the signal Scout clusters — see `isObservation` below), so a repeat
   * reading of an unresolved condition minted a fresh open row every call,
   * unbounded. Passing `watchdogKey` on an observation capture COALESCES: a
   * still-OPEN prior observation carrying the SAME key is updated in place
   * (`payload.repeatCount` bumped, `lastSeenAt` refreshed, title/body replaced
   * with this call's latest reading) instead of creating a new row. Omit it for
   * a genuinely novel/one-off observation, which still always re-files.
   */
  watchdogKey?: string;
  /** A caller-owned durable reservation (e.g. dream_runs) fixes artifact identity across terminal replay. */
  artifactId?: string;
  /**
   * Newest evidence timestamp (ISO) backing this capture (watchdog-audit
   * P-005 / D-002). Under `dedupScope:'open'`, a RESOLVED duplicate normally
   * re-files (regression semantics) — but only when the evidence post-dates the
   * resolution. A resolved dup whose `updatedAt` >= `evidenceAt` declines the
   * capture as 'stale-evidence' (the collector's lookback window still contains
   * pre-fix rows; that is not a regression).
   */
  evidenceAt?: string;
  createdBy?: string;
  /**
   * The CONCRETE workspace the created row lives in (WI-2140701 (b)).
   *
   * Read by exactly one leg: the goal-provenance stamp. `stampGoalProvenance`
   * resolves the creator's goal from SESSION CONTEXT keyed on (workspace, owner),
   * so without a concrete workspace a freshly-minted row keeps `goal_id = NULL`
   * and the goal it was filed under cannot see it. The tool layer resolves this
   * the same way it does for every other workspace-keyed side effect; omit it
   * (PG-free callers, tests) and the stamp is skipped as not-applicable, never
   * as an error.
   */
  workspaceId?: string;
  /**
   * Atomically CLAIM the created item for this agent id, in the SAME create (WI-5950).
   *
   * The persona tells every agent to file the moment it notices something AND to hold a
   * work-item before it starts editing. Without this, those two instructions conflict:
   * capture could only ever mint an UNCLAIMED row, so filing a bug you were already
   * fixing published your in-progress work to the claimable pool and a peer would
   * duplicate the fix (observed 2026-07-26). Same name/semantics as
   * work_items:create's `assign_to` — the tool layer resolves the literal 'self'
   * before calling, so this is always a concrete ownerId. Omit ⇒ unclaimed (filing
   * stays cheap, which is the common case).
   *
   * Ignored for lane:'observation' — an observation is a sensor reading, not claimable work.
   */
  assignee?: string;
  /**
   * Source role that filed this improvement (P-010 source-tag): 'Queen', 'bee', 'system',
   * 'Scout' (autonomously generated by the Scout loop), or 'human'. Default 'human'.
   * Used to track per-Hive topic lens + who filed it.
   */
  sourceRole?: 'Queen' | 'cup' | 'system' | 'Scout' | 'human';
  /**
   * The filer's resolved fine ROLE (overwatch | queen | scout | bee | worker | su |
   * system | …) for per-role attribution — close-observation-attribution-gap
   * 2026-06-21. Persisted at `payload.filedByRole` so per-role observation analytics
   * (the OverwatchBrief observation panel, Scout's corpus-digest) attribute every
   * observation instead of bucketing ~100% as 'unknown'. Free-form (the fine role),
   * distinct from the narrow `sourceRole` improvement-source enum. The tool handler
   * resolves it from the caller's LIVE coord presence at capture time.
   */
  filedByRole?: string;
  source?: IssueSource;
  /**
   * Learning-signal provenance (frontier P-002/D-002): organic (default) | drill |
   * replay | shadow. Only the frontier loops pass non-organic — a vaccination drill,
   * a replay counterfactual, a shadow ablation. Stored as the real
   * `engineer_issues.signal_origin` column; every learning consumer filters to
   * organic unless explicitly opted in (read-items.ts). Dedup is origin-SCOPED:
   * a candidate with a different origin never declines this capture (a synthetic
   * row must never suppress a real signal, nor a real row a planted drill).
   */
  origin?: SignalOrigin;
  /**
   * Machine-readable finding class (frontier P-044/D-008): a stable
   * `<miner>:<shape>` slug (e.g. `negative-space:resolution-gap`,
   * `regret:process-counterfactual`) identifying WHAT KIND of finding this is,
   * independent of its free-prose title. Stored at `payload.findingClass` and
   * surfaced on ImprovementCandidate so downstream rails can route and count
   * per class — the graduation tracker (P-045/P-046) counts clean passes per
   * findingClass, never per fuzzy title. Automated filers (the miners, the
   * watchdog collectors) should always pass one; interactive captures may omit.
   */
  findingClass?: string;
  /**
   * Capture lane (turn-end-reflection-observations-2026-06-14 D-005). 'improvement'
   * (default) files into the work/triage pipeline. 'observation' files a PRE-IDEA
   * sensor reading into the OBSERVATION_TOPIC lane: it skips blocking dedup
   * (recurrence IS the signal Scout clusters), always stores as a non-bug nit,
   * carries no auto-implement lifecycle, and is read ONLY by Scout's corpus-digest
   * + the Observations pane — it never enters the work queue.
   */
  lane?: 'improvement' | 'observation';
  /**
   * Extra fields merged onto engineer_issues.payload — e.g. an observation's
   * structured { kind, scope, confidence, refs } record (D-005). Generic seam so
   * capture-core stays agnostic to the observation shape.
   */
  payloadExtra?: Record<string, unknown>;
  /**
   * File the row ALREADY-TERMINAL (observation-lane-scorecard-classification-2026-08-16
   * D-002/D-005). Used ONLY by scorecards:emit: an emitted scorecard is a completed
   * verdict, not a pending sensor reading, so leaving it 'open' forever misrepresents
   * it as untriaged work (the misread that started the 01a0031d investigation).
   * ⚠ NOT for capture-route rubric-graded observations — their conditionKey collapse
   * (EI-19325151590626958) matches state='open' rows in place, and a terminal filing
   * would re-mint a row per wake (D-005 of this plan records the split).
   */
  initialState?: 'done';
  /**
   * The agent-facing wrapper sets this for a fresh local change/feature capture so the
   * durable row is parked before the post-create review enrollment can run. Watchdog and
   * observation callers omit it; review enrollment is intentionally not a core-wide rule.
   */
  reviewRequired?: boolean;
  /** Harness used by the review lifecycle state writer. */
  reviewHarness?: string;
}

export type CaptureReviewFailurePhase = 'block' | 'enrollment' | 'reopen';

export interface AgentReviewFailure {
  phase: CaptureReviewFailurePhase;
  message: string;
  at: string;
}

export interface PossibleDuplicate {
  id: string;
  title: string;
  state: string;
  severity: string;
  similarity: number;
  /** P-011: present when this candidate arrived via the EMBEDDING net (its
   *  title never crossed the lexical DUP_THRESHOLD — a differently-worded
   *  refile). `similarity` is then the cosine, not titleSimilarity. 'hard'
   *  may carry the blocking verdict annotation like a lexical dup; 'soft' is advisory-only. */
  semantic?: 'hard' | 'soft';
  /** P-007 (knowledge-at-symptom-time-2026-08-09): present when this candidate arrived via
   *  the CONTAINMENT net — your (shorter) title is almost entirely covered by this one, but
   *  Jaccard scored below DUP_THRESHOLD because the stored title is much longer. `similarity`
   *  is then the containment coefficient, not titleSimilarity. ALWAYS advisory-only: a
   *  containment hit is surfaced and never declines a capture. */
  lexical?: 'containment';
  /** EI-20484430331973864: the candidate carries the SAME `watchdogKey` as this capture —
   *  a DEFINITIONAL duplicate, independent of any title or embedding similarity. Present
   *  only for non-observation captures that passed a `watchdogKey`. Always block-eligible
   *  and never dropped by the top-5 slice: the fuzzy nets exist to GUESS at identity, and
   *  an exact key already knows it. `similarity` is titleSimilarity as usual (it can be
   *  anything, including 1.0 for a re-file of the identical title). */
  exactKey?: true;
}

/**
 * What the dedup search actually managed to CHECK (P-007). Without this, an empty
 * `possibleDuplicates` is ambiguous between "checked, nothing similar exists" and
 * "could not check" — and the two demand opposite responses.
 *
 * The embedder-backed leg fails OPEN (returns null on timeout/unavailability), which is
 * correct for availability but silently degrades recall. EI-19502216864373653 measured the
 * cost: an agent read a bare `[]` as "no duplicates", filed, and had to retract minutes
 * later against an open major item filed ~12h earlier.
 */
export interface DedupCoverage {
  /** Token-based title match. 'unavailable' means the backing search failed. */
  lexical: 'ok' | 'unavailable' | 'skipped';
  /** Embedding leg. 'unavailable' = it returned no verdict (embedder down / over budget /
   *  disabled), so a differently-worded duplicate would NOT have been found. */
  semantic: 'ok' | 'unavailable' | 'skipped';
  /** True when any leg could not run — i.e. an empty result is NOT a clean bill of health. */
  degraded: boolean;
}

/**
 * What a COALESCE actually did to the caller's content (P-006, D-004).
 *
 * A coalesce returns `ok:true, created:false, reason:'coalesced'` whether the
 * caller's title/body replaced the row's text or was silently dropped — the
 * refresh is a `.catch(() => null)` and the prior text is kept on failure. So
 * `ok:true` meant "did not throw", not "your reading was persisted", and a
 * caller had no way to tell the two apart. This reports the difference.
 *
 * Mirrors the same disclosure `coordination/escalations.ts` already makes for
 * the identical coalesce-and-drop-the-text shape (`bodyDiscarded`).
 */
export interface CoalesceEffect {
  /** The still-open row this capture merged onto. */
  id: string;
  /** `repeatCount` after this call's bump. */
  repeatCount: number;
  /** Did THIS call's title/body actually replace the row's text? */
  bodyPersisted: boolean;
  /** Only when the caller's prose was DISCARDED (a FAILED refresh). Absent on an
   *  `append-only` fold, where the prose was retained as an occurrence and
   *  nothing was lost — see `textDisposition`, which distinguishes the two
   *  `bodyPersisted:false` cases that a boolean alone conflates. */
  bodyDiscarded?: true;
  /** WHY the caller's text is or is not on the survivor row.
   *  `refreshed`   — it replaced the row's text (keyed folds: latest reading wins).
   *  `append-only` — BY DESIGN. A derived fold appends the reading to the
   *                  occurrence ledger and leaves the survivor's text alone,
   *                  because overwriting a row whose identity was INFERRED
   *                  would let one wrong guess destroy another agent's account.
   *                  Nothing was lost.
   *  `lost`        — the refresh FAILED. The repeatCount bump landed, the prose
   *                  did not. This is the silent write-loss case. */
  textDisposition: 'refreshed' | 'append-only' | 'lost';
  /** `createdBy` of the row merged onto (null on rows predating the column). */
  priorAuthor: string | null;
  /** True when `priorAuthor` is a DIFFERENT agent than this caller — i.e. this
   *  write landed on a peer's row. Undecidable (false) when either side is null. */
  crossAuthor: boolean;
  /** P-015 (D-042): HOW this fold's identity was established, because the
   *  routes carry different confidence and a reader must not conflate them.
   *  `condition-key` — the caller supplied a stable `watchdogKey`; the match is
   *  an exact indexed lookup, not a guess (P-001/P-002, machine emitters).
   *  `derived` — no key was supplied; identity was DERIVED from content
   *  similarity plus the D-036 subject discriminator (P-013, agent filings).
   *  `title-key` — P-004 (silent-intake): a keyless non-observation filer matched
   *  an open twin by exact normalized titleKey. Deterministic like a key match
   *  (same normalization both sides), narrower than a derived guess.
   *  A derived fold is a judgement and can be wrong; the other two cannot. */
  identity: 'condition-key' | 'class-key' | 'derived' | 'title-key';
  /** P-004: present when the survivor row had been watchdog-AUTO-RESOLVED and
   *  this exact-key recurrence REOPENED it (resolved → open) before coalescing.
   *  The auto-close was a dedup marker, not a completion — recurrence voids it. */
  reopened?: true;
  /** Derived folds only: which classifier rule fired. Absent on a keyed fold —
   *  there is no rule to name, the key matched. */
  foldRule?: FoldClassification['rule'];
  /** Derived folds only: the classifier's own explanation, including the
   *  subject tokens that agreed. Kept verbatim so an over-merge is auditable
   *  from the response alone. */
  foldNote?: string;
  /** Derived folds only: the cosine that carried the match. */
  similarity?: number;
  /** Plain-language statement of what happened, for a reader who will not
   *  interpret the booleans. */
  note: string;
}

/**
 * P-013/P-015 (D-042): a SOFT fold — the filing was minted as its OWN row and
 * LINKED to a similar open observation. Both rows survive.
 *
 * This exists so a filing agent is told what happened in EVERY branch, not only
 * when its row was absorbed. A soft fold is the classifier saying "similar
 * enough to be worth a cross-reference, not similar enough to merge" — most
 * often the D-036 template trap, where two filings share a wording template but
 * name different subjects.
 */
export interface FoldLinkEffect {
  /** The open observation this filing was linked to. */
  id: string;
  /** Cosine similarity to that row, 0..1. */
  similarity: number;
  /** Which classifier rule produced the SOFT verdict. */
  rule: FoldClassification['rule'];
  /** Did the `relates` edge actually get written? The link is best-effort — a
   *  failure never costs the filing, but it does mean the cross-reference is
   *  missing, so the caller is told rather than left to assume. */
  linkWritten: boolean;
  /** Plain-language statement of what happened and why it was NOT folded. */
  note: string;
}

export interface CaptureImprovementResult {
  ok: true;
  created: boolean;
  // P-002 (D-001): 'likely-duplicate' / 'stale-evidence' left this union with the
  // search-first decline — a duplicate-classified filing now CREATES, carrying
  // payload.dedupVerdict instead of a created:false reason.
  reason?: 'check-only' | 'coalesced' | 'promoted';
  /** P-006/D-004: present ONLY on a coalesce. What this write did to the row it
   *  merged onto, and whether the caller's own text survived. */
  coalescedOnto?: CoalesceEffect;
  /** P-013/P-015 (D-042): present ONLY on a SOFT derived fold. The row WAS
   *  created (`created:true`) and linked to a similar open observation. */
  linkedTo?: FoldLinkEffect;
  /** Native engineer_issues storage kind. Always agrees with issue.kind. */
  kind?: 'bug' | 'change';
  /** Caller-facing capture classification; `feature` is stored as kind=`change`. */
  improvementKind?: ImprovementKind;
  issue?: EngineerIssue;
  topics?: string[];
  possibleDuplicates: PossibleDuplicate[];
  /** P-007: what the dedup search could actually check. Read this BEFORE reading an empty
   *  `possibleDuplicates` as "nothing similar exists". */
  dedupCoverage?: DedupCoverage;
  /** Server-authored normalized title identity (+ stronger signal key when present). */
  admissionIdentity?: AdmissionIdentity;
  /** P-005 rolling writer-backed circuit observation, when an advisory canonical
   * candidate made pressure relevant to this admission. */
  queueAdmission?: IssueAdmissionPressure;
  /**
   * "Already decided" recall (self-learning-central P-003): prior RESOLVED/closed
   * items whose STABLE signature matches this capture — so the loop recognises a
   * settled friction before re-proposing it. Distinct from `possibleDuplicates`
   * (raw title-similarity over OPEN+resolved): this is signature-matched and
   * decided-only, and carries the "already decided: <reason>" recall line when one
   * was recorded. Surfaced even when the capture is created (force / genuinely
   * distinct) — it's recall, not a gate.
   */
  alreadyDecided?: AlreadyDecidedRecall[];
  /** True only for a fresh agent-facing change/feature row that needs review enrollment. */
  reviewRequired?: boolean;
  /** The pre-enrollment lifecycle state that was durably applied. */
  reviewState?: 'blocked';
  /** A committed capture whose review lifecycle could not complete. */
  agentReviewFailure?: AgentReviewFailure;
  /**
   * WI-2140701 (b): the goal this freshly-minted row was stamped with from the
   * creator's session context — present only on a `created: true` result whose
   * creator runs under a goal. Same field, same semantics as work_items:create.
   */
  goalId?: string;
  /** Set when the goal stamp THREW (recorded, never raised — see CaptureDeps.stampGoalProvenance). */
  goalStampError?: string;
  hint?: string;
}

/** Injectable dependency seam (unit tests run without PG). */
export interface CaptureDeps {
  searchIssues: (query: string, limit?: number) => Promise<EngineerIssue[]>;
  createIssue: (input: CreateIssueInput) => Promise<EngineerIssue>;
  /**
   * Seed the successor-visible checkpoint for an atomically self-claimed item.
   * Optional so watchdog/system captures and PG-free callers can omit the side effect.
   * A checkpoint failure must never lose the capture itself.
   */
  setCheckpoint?: (workItemId: string, checkpoint: string) => Promise<void>;
  /**
   * Stamp a freshly-minted row's `goal_id` from the creator's session context
   * (WI-2140701 (b)). Defaults to the shared `goals/provenance-stamp` — the same
   * function work_items:create uses — loaded lazily so the PG-free core never
   * statically pulls the org pool. Returns the goal id written, or null when the
   * creator runs under no goal. A throw is RECORDED on the result as
   * `goalStampError`, never raised: losing provenance must not fail a capture.
   */
  stampGoalProvenance?: (
    item: { id: string; harness?: string | null },
    workspaceId: string,
    ownerId: string,
  ) => Promise<string | null>;
  /** Load a rubric's criteria for the P-014a scorecard-completeness gate + the P-002
   *  rating-value gate (criterion/rubric ratingScale). OPTIONAL — the gate falls back to
   *  the real getRubric; injectable so tests can stub it (or omit it → PG-free tests skip
   *  the gate via the load-error catch). Returns null for an unknown rubric. */
  loadRubric?: (rubricId: string) => Promise<{
    criteria: { key: string; ratingScale?: readonly string[] }[];
    ratingScale?: readonly string[];
    /** Rubric kind ('standard' | 'acceptance'); the poor-rating disposition gate
     *  is scoped to standard rubrics. getRubric supplies it; a stub may omit it. */
    kind?: string | null;
  } | null>;
  /** P-011 semantic-widening seams. OPTIONAL — default to the real P-008 work-item
   *  dupe guard (itself vitest-inert + fail-open) and the real getIssue; injectable
   *  so tests drive the widening without PG or an embedder. */
  findSemanticDupes?: (input: { title: string; summary?: string }) => Promise<SemanticDupeResult | null>;
  getIssue?: (id: string) => Promise<EngineerIssue | null>;
  /**
   * WI-2147241 — the MIXED-family citation door for the Scout evidence-integrity record.
   * Kept SEPARATE from `getIssue` because every other use here is legitimately issue-family;
   * only the citation check spans both. Optional: when a caller injects neither, the check
   * falls back to the issue-family door, which is what the pure unit fixtures stub.
   */
  getCitedWorkItem?: (id: string, harness?: string) => Promise<CitedRowForIntegrity | null>;
  /** Auto-ratify-on-first-scorecard (WI-5415): OPTIONAL — defaults to the real
   *  rubrics.ts autoRatifyRubricOnFirstScorecard; injectable so tests can assert the
   *  hook fired (and with which args) without touching PG. */
  autoRatifyRubric?: (rubricId: string, graderId: string) => Promise<Rubric | null>;
  /** EI-15448 observation-coalescing seams. OPTIONAL — default to the real
   *  issues-engineer.ts implementations; injectable so tests drive the coalesce
   *  path without PG. */
  findIssuesByWatchdogKeys?: (keys: string[]) => Promise<EngineerIssue[]>;
  /** Stable tool-failure class lookup; unlike watchdog keys this spans message shapes. */
  findIssuesByToolFailureClassKeys?: (keys: string[]) => Promise<EngineerIssue[]>;
  updateIssuePatch?: (
    id: string,
    patch: {
      title?: string;
      body?: string;
      severity?: IssueSeverity;
      kind?: 'bug' | 'change';
      silent?: boolean;
      confirmShrink?: boolean;
    },
  ) => Promise<EngineerIssue | null>;
  mergeIssuePayload?: (
    id: string,
    patch: Record<string, unknown>,
    opts?: { unset?: readonly string[] },
  ) => Promise<EngineerIssue | null>;
  tagIssue?: (id: string, topic: string, by?: string) => Promise<void>;
  untagIssue?: (id: string, topic: string) => Promise<void>;
  /** P-004 append-only evidence seam. Optional so pure callers can inject a
   * recorder; the production default writes through issue-occurrence-ledger. */
  recordIssueOccurrence?: (input: RecordIssueOccurrenceInput) => Promise<RecordedIssueOccurrence | null>;
  /** P-013 (D-042) SOFT-fold seam: write a `relates` edge between the row just
   *  minted and the similar open observation the classifier declined to fold
   *  onto. Optional — the production default lazy-loads `linkWorkItem` so
   *  capture-core keeps its PG-free import graph, and a link failure is
   *  reported (`linkWritten:false`) rather than costing the filing. */
  linkIssues?: (srcId: string, dstId: string, rel: string, by?: string) => Promise<void>;
  /** P-005 bounded pressure reader. Optional/injectable so pure tests never open PG. */
  readIssueAdmissionPressure?: (input: {
    canonicalId: string;
    canonicalHarness?: string | null;
  }) => Promise<IssueAdmissionPressure | null>;
  /**
   * Lifecycle seam for the pre-enrollment review park. Kept injectable so the core's
   * PG-free tests can prove ordering without importing the large work-items module.
   */
  setWorkItemStateWithAliasInfo?: CaptureLifecycleStateWriter;
  /** Release the submitter claim when the review lifecycle cannot complete. */
  releaseIssue?: (id: string, opts?: { expectedAssignee?: string }) => Promise<EngineerIssue | null>;
  /** Resolve a probation observation after migration-865 promotion reconciliation. */
  setIssueState?: (
    id: string,
    state: 'open' | 'resolved' | 'closed',
    by?: string,
    completionRef?: string,
    opts?: { skipCompletionGate?: boolean },
  ) => Promise<EngineerIssue | null>;
}

export interface CaptureLifecycleStateResult {
  workItem: { id: string; state: string } | null;
  requestedState?: string;
  appliedState?: string | null;
}

export type CaptureLifecycleStateWriter = (
  id: string,
  requestedState: 'blocked' | 'open',
  opts?: { harness?: string; by?: string; reason?: string },
) => Promise<CaptureLifecycleStateResult>;

const defaultSetWorkItemStateWithAliasInfo: CaptureLifecycleStateWriter = async (id, requestedState, opts) => {
  const { setWorkItemStateWithAliasInfo } = await import('../../work-items');
  return setWorkItemStateWithAliasInfo(id, requestedState, opts);
};

/** Shared lifecycle writer used by the agent wrapper after capture-core returns. */
export async function setCaptureReviewState(
  id: string,
  requestedState: 'blocked' | 'open',
  opts: { harness?: string; by?: string; reason?: string } = {},
): Promise<CaptureLifecycleStateResult> {
  return defaultSetWorkItemStateWithAliasInfo(id, requestedState, opts);
}

// WI-4308: use the dedup-widened search (also checks the legacy DEFAULT_COORD_WORKSPACE
// for pre-ISSUES_PER_WORKSPACE-flip rows) — see searchIssuesForDedup's doc in issues-engineer.ts.
const defaultDeps: CaptureDeps = {
  searchIssues: searchIssuesForDedup,
  createIssue,
  getIssue,
  findIssuesByToolFailureClassKeys,
  releaseIssue,
  setIssueState,
  loadRubric: getRubric,
  autoRatifyRubric: autoRatifyRubricOnFirstScorecard,
  recordIssueOccurrence,
  readIssueAdmissionPressure,
  // Lazy on purpose: work-items.ts is a large PG-bound module, and capture-core
  // is imported by pure/vitest paths that must not pull it in. Resolving the
  // ObjectRef through the same `resolveWorkItemRef` the work_items:link tool
  // uses keeps issue-family vs feature-family ref shaping in ONE place.
  linkIssues: async (srcId, dstId, rel, by) => {
    const { linkWorkItem, resolveWorkItemRef } = await import('../../work-items');
    const dst = await resolveWorkItemRef(dstId);
    if (!dst) throw new Error(`link target '${dstId}' not found`);
    const result = await linkWorkItem(srcId, dst, rel, by ? { by } : {});
    if ('error' in result) throw new Error(result.error);
  },
  // Lazy for the same reason as linkIssues: `getWorkItem` is the PG-bound MIXED-family
  // door (issue view first, then the feature base table), and this core is imported by
  // pure/vitest paths that must not pull work-items.ts in.
  getCitedWorkItem: async (id, harness) => {
    const { getWorkItem } = await import('../../work-items');
    return getWorkItem(id, harness);
  },
  setWorkItemStateWithAliasInfo: defaultSetWorkItemStateWithAliasInfo,
  // Lazy for the same reason as linkIssues: the stamp reaches the org pool and
  // the mode store, and this core is imported by pure/vitest paths.
  stampGoalProvenance: async (item, workspaceId, ownerId) => {
    const { stampGoalProvenance } = await import('../../goals/provenance-stamp');
    return stampGoalProvenance(item, workspaceId, ownerId);
  },
};

function reviewFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Preserve a committed capture when its review lifecycle fails. The row is already
 * parked by the caller; release only the submitter's claim and stamp the existing
 * leader-triage metadata shape so a leader can diagnose and re-open it deliberately.
 */
export async function recordCaptureReviewFailure(
  id: string,
  failure: AgentReviewFailure,
  opts: { submittedBy?: string; harness?: string } = {},
  deps: CaptureDeps = defaultDeps,
): Promise<{ released: boolean; recorded: boolean }> {
  let released = false;
  if (opts.submittedBy) {
    released = Boolean(
      await (deps.releaseIssue ?? releaseIssue)(id, { expectedAssignee: opts.submittedBy }).catch(() => null),
    );
  }
  const recorded = Boolean(
    await (deps.mergeIssuePayload ?? mergeIssuePayload)(id, {
      blockedReason: `agent-review-${failure.phase}-failed`,
      blockedAt: failure.at,
      agentReviewFailure: failure,
    }).catch(() => null),
  );
  return { released, recorded };
}

function harnessFromScope(scope: string | undefined): string | null {
  return scope?.startsWith('harness:') ? scope.slice('harness:'.length) || null : null;
}

const WATCHDOG_IDENTITY_INDEX = 'work_items_watchdog_identity_uq';
const KEYLESS_TITLE_IDENTITY_INDEX = 'work_items_keyless_title_identity_uq';

/** The lane component of the durable watchdog identity. */
function effectiveWatchdogLane(input: Pick<CaptureImprovementInput, 'lane'>): string {
  return input.lane === 'observation' ? 'observation' : 'improvement';
}

/** Read the lane component from an issue row exactly as migration 865 does. */
function issueWatchdogLane(issue: EngineerIssue): string {
  const payload = (issue.payload as Record<string, unknown> | null) ?? {};
  return typeof payload.lane === 'string' ? payload.lane : 'improvement';
}

/**
 * Resolve the scope grain used by the migration-865 identity.
 *
 * Capture callers name Pots as `harness:<slug>`; workspace-global / omitted
 * scopes are auto-homed to the platform Pot by createIssue. The operator form
 * remains valid for un-potted test tenants, so both effective homes are
 * accepted for a global request. A concrete Pot never matches another Pot.
 */
function issueScopeMatchesCapture(issue: EngineerIssue, inputScope: string | undefined): boolean {
  const actual = issue.scope?.trim() || 'operator';
  const requested = inputScope?.trim();
  if (requested?.startsWith('harness:')) {
    const slug = canonicalPotSlug(requested.slice('harness:'.length).trim());
    return actual === `harness:${slug}`;
  }
  return actual === 'operator' || actual === `harness:${PLATFORM_POT_SLUG}`;
}

/** Exact keyless title identity check used after the database arbiter wins a race. */
function sameKeylessTitleIdentity(
  issue: EngineerIssue,
  input: Pick<CaptureImprovementInput, 'watchdogKey' | 'lane' | 'scope'>,
  identity: AdmissionIdentity,
): boolean {
  const payload = (issue.payload as Record<string, unknown> | null) ?? {};
  const stored = payload.admissionIdentity;
  const keylessWatchdog =
    payload.watchdogKey == null || (typeof payload.watchdogKey === 'string' && payload.watchdogKey.trim() === '');
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return false;
  const storedIdentity = stored as { schemaVersion?: unknown; titleKey?: unknown };
  return (
    !input.watchdogKey &&
    keylessWatchdog &&
    storedIdentity.schemaVersion === identity.schemaVersion &&
    storedIdentity.titleKey === identity.titleKey &&
    isWatchdogNonTerminal(issue) &&
    issueWatchdogLane(issue) === effectiveWatchdogLane(input) &&
    issueScopeMatchesCapture(issue, input.scope)
  );
}

/** Exact watchdog identity check used after the database arbiter wins a race. */
function sameWatchdogIdentity(
  issue: EngineerIssue,
  input: Pick<CaptureImprovementInput, 'watchdogKey' | 'origin' | 'lane' | 'scope'>,
  origin: string,
): boolean {
  const payload = (issue.payload as Record<string, unknown> | null) ?? {};
  return (
    typeof input.watchdogKey === 'string' &&
    payload.watchdogKey === input.watchdogKey &&
    effectiveOrigin(issue.signalOrigin) === origin &&
    issueWatchdogLane(issue) === effectiveWatchdogLane(input) &&
    issueScopeMatchesCapture(issue, input.scope)
  );
}

/** Exact stable class identity check after the broad class-key lookup. */
function sameToolFailureClassIdentity(
  issue: EngineerIssue,
  classKey: string,
  input: Pick<CaptureImprovementInput, 'origin' | 'scope'>,
  origin: string,
): boolean {
  const payload = (issue.payload as Record<string, unknown> | null) ?? {};
  const probation = toolFailureProbationOf(payload);
  return (
    probation?.classKey === classKey &&
    isWatchdogNonTerminal(issue) &&
    effectiveOrigin(issue.signalOrigin) === origin &&
    issueScopeMatchesCapture(issue, input.scope)
  );
}

/** A row covered by migration 865 is still live until it enters any family terminal state. */
function isWatchdogNonTerminal(issue: EngineerIssue): boolean {
  return !ANY_FAMILY_TERMINAL_STATES.includes(issue.state);
}

/** Only the watchdog identity arbiter is recoverable; never swallow another 23505. */
function isWatchdogIdentityConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as Record<string, unknown>;
  if (String(candidate.code ?? '') !== '23505') return false;
  const evidence = [candidate.constraint, candidate.constraint_name, candidate.message, candidate.detail]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
  return evidence.includes(WATCHDOG_IDENTITY_INDEX);
}

/** Only the keyless title arbiter is recoverable; never swallow another 23505. */
function isKeylessTitleIdentityConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as Record<string, unknown>;
  if (String(candidate.code ?? '') !== '23505') return false;
  const evidence = [candidate.constraint, candidate.constraint_name, candidate.message, candidate.detail]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
  return evidence.includes(KEYLESS_TITLE_IDENTITY_INDEX);
}

function captureOccurrenceEvidence(
  input: CaptureImprovementInput,
  possibleDuplicates: readonly PossibleDuplicate[],
  dedupCoverage: DedupCoverage,
  queueAdmission?: IssueAdmissionPressure,
): Record<string, unknown> {
  return {
    kind: input.kind,
    body: input.body ?? null,
    severity: input.severity ?? null,
    scope: input.scope ?? null,
    subTopic: input.subTopic ?? null,
    foundDuring: input.foundDuring ?? null,
    paths: input.paths ?? [],
    watchdogKey: input.watchdogKey ?? null,
    evidenceAt: input.evidenceAt ?? null,
    sourceRole: input.sourceRole ?? null,
    filedByRole: input.filedByRole ?? null,
    source: input.source ?? null,
    origin: input.origin ?? DEFAULT_SIGNAL_ORIGIN,
    findingClass: input.findingClass ?? null,
    payloadExtra: input.payloadExtra ?? null,
    possibleDuplicates,
    dedupCoverage,
    ...(queueAdmission ? { queueAdmission } : {}),
  };
}

/** Record the report before returning its admission verdict. The ledger is
 * diagnostic evidence, so an unavailable recorder never changes admission. */
async function appendCaptureOccurrence(
  deps: CaptureDeps,
  input: CaptureImprovementInput,
  identity: AdmissionIdentity,
  reportKind: IssueOccurrenceKind,
  canonicalId: string,
  possibleDuplicates: readonly PossibleDuplicate[],
  dedupCoverage: DedupCoverage,
  canonicalHarness: string | null = harnessFromScope(input.scope),
  queueAdmission?: IssueAdmissionPressure,
): Promise<void> {
  await (deps.recordIssueOccurrence ?? recordIssueOccurrence)({
    canonicalId,
    ...(canonicalHarness ? { canonicalHarness } : {}),
    reporter: input.createdBy ?? null,
    sourceTool: 'improvements:capture',
    reportKind,
    reportedTitle: input.title,
    evidence: captureOccurrenceEvidence(input, possibleDuplicates, dedupCoverage, queueAdmission),
    admissionIdentity: identity,
  }).catch(() => null);
}

/**
 * Capture-time provenance for work-item references in a Scout proposal.
 *
 * This is deliberately metadata rather than a hard capture rejection: a
 * transient resolver outage must not lose a generated signal. Triage performs
 * the authoritative fresh check before admitting `place`; this record makes
 * the capture-time result inspectable and tells downstream readers whether a
 * missing citation was actually checked or merely could not be resolved.
 */
export interface EvidenceIntegrityPayload {
  citedIds: string[];
  resolvedIds: string[];
  unresolvedIds: string[];
  circularIds: string[];
  lookupFailedIds: string[];
  checked: boolean;
}

/**
 * The only field this check reads off a cited row. FAMILY-NEUTRAL on purpose (WI-2147241):
 * a `WorkItem` from the canonical `work_items` base table and an `EngineerIssue` from the
 * issue-family view both satisfy it, so the resolver seam can return either.
 */
type CitedRowForIntegrity = { payload?: unknown };

/**
 * Resolve a Scout proposal's cited work-item ids at capture time (best-effort).
 *
 * WI-2147241: `resolveCitation` must be a MIXED-family door. `extractCitedIds` pulls
 * `EI-`/`WI-`/`F-` indiscriminately, but feature-family rows live in `work_items` and are
 * invisible to the issue-family view — so resolving through an issue-only door recorded
 * every real feature-family citation as `unresolvedIds`, i.e. an audit record asserting
 * "fabricated" about a citation that resolves fine. `harness` scopes the lookup because a
 * `WI-<n>` id is unique only within a (workspace, harness).
 */
export async function validateScoutEvidenceCitations(
  text: string,
  resolveCitation?: (id: string, harness?: string) => Promise<CitedRowForIntegrity | null>,
  harness?: string,
): Promise<EvidenceIntegrityPayload | undefined> {
  const citedIds = extractCitedIds(text);
  if (citedIds.length === 0) return undefined;

  const result: EvidenceIntegrityPayload = {
    citedIds,
    resolvedIds: [],
    unresolvedIds: [],
    circularIds: [],
    lookupFailedIds: [],
    checked: Boolean(resolveCitation),
  };
  if (!resolveCitation) return result;

  for (const id of citedIds) {
    try {
      const cited = await resolveCitation(id, harness);
      if (!cited) {
        result.unresolvedIds.push(id);
        continue;
      }
      result.resolvedIds.push(id);
      const payload =
        cited.payload && typeof cited.payload === 'object' ? (cited.payload as Record<string, unknown>) : {};
      if (payload.sourceRole === 'Scout') result.circularIds.push(id);
    } catch {
      // A resolver outage is recorded for observability but remains fail-open.
      result.lookupFailedIds.push(id);
    }
  }
  return result;
}

/** The native column kind for a capture: feature is a payload refinement of change. */
export function storageKindOf(kind: ImprovementKind): 'bug' | 'change' {
  return kind === 'bug' ? 'bug' : 'change';
}

interface ToolFailureProbationPayload {
  state?: 'probation' | 'promoted';
  reporters?: string[];
  classKey?: string;
  contractFingerprint?: string;
  deployedRevision?: string;
  correlationFingerprint?: string;
  intendedKind?: 'bug' | 'change';
  [key: string]: unknown;
}

function toolFailureProbationOf(
  payload: Record<string, unknown> | null | undefined,
): ToolFailureProbationPayload | null {
  const candidate = payload?.toolFailureProbation;
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? (candidate as ToolFailureProbationPayload)
    : null;
}

/**
 * Guard fallback promotion against a known stable-class mismatch.
 *
 * Migration 865 arbitrates the broad top-level watchdog identity, while the
 * nested classKey is the stable tool-failure contract/revision identity. A
 * legacy row may not carry classKey at all, so absence on either side remains
 * compatible; only two present, different class keys prove that the rows are
 * different failure classes.
 */
function compatibleToolFailureClassIdentity(
  issue: EngineerIssue,
  incoming: ToolFailureProbationPayload | null | undefined,
): boolean {
  const prior = toolFailureProbationOf((issue.payload as Record<string, unknown> | null) ?? {});
  const priorClassKey = prior?.classKey;
  const incomingClassKey = incoming?.classKey;
  const priorKnown = typeof priorClassKey === 'string' && priorClassKey.length > 0;
  const incomingKnown = typeof incomingClassKey === 'string' && incomingClassKey.length > 0;
  return !priorKnown || !incomingKnown || priorClassKey === incomingClassKey;
}

function initialImplementationReadiness(reviewRequired: boolean): ImplementationReadinessState {
  return createImplementationReadiness(
    reviewRequired
      ? {
          status: 'unknown',
          source: 'capture-policy',
          reason: 'awaiting-agent-review',
        }
      : {
          status: 'ready',
          source: 'capture-policy',
          reason: 'existing-immediate-capture-policy',
        },
  );
}

function promotedProbationReadiness(
  input: CaptureImprovementInput,
  probation: ToolFailureProbationPayload,
): ImplementationReadinessState {
  const trustedPromotion =
    probation.directEvidence === true ||
    input.sourceRole === 'system' ||
    input.createdBy?.startsWith('system:') === true;
  return createImplementationReadiness(
    trustedPromotion
      ? {
          status: 'ready',
          source: 'capture-policy',
          reason: 'trusted-tool-failure-promotion',
        }
      : {
          status: 'unknown',
          source: 'capture-policy',
          reason: 'corroborated-tool-failure-awaiting-review',
        },
  );
}

const PROMOTION_RECONCILIATION_OWNER = 'improvement-promotion-reconciler';

/**
 * Reconcile a probation observation when migration 865 already has an open
 * improvement row for the same watchdog identity. The lane flip cannot win the
 * unique index in that case, so preserve the evidence on the improvement row and
 * terminalize the now-redundant observation through the trusted dedup state path.
 */
async function reconcileToolFailurePromotionCollision(
  prior: EngineerIssue,
  input: CaptureImprovementInput,
  deps: CaptureDeps,
  candidates?: readonly EngineerIssue[],
  preserveCanonicalWatchdogKey = false,
): Promise<EngineerIssue | null> {
  const priorPayload = (prior.payload as Record<string, unknown> | null) ?? {};
  const incomingProbation = toolFailureProbationOf(input.payloadExtra ?? {}) ?? {};
  const priorProbation = toolFailureProbationOf(priorPayload) ?? {};
  const keys = [priorPayload.watchdogKey, incomingProbation.watchdogKey, input.watchdogKey].filter(
    (key): key is string => typeof key === 'string' && key.length > 0,
  );
  const uniqueKeys = [...new Set(keys)];
  if (uniqueKeys.length === 0) return null;

  const origin = input.origin ?? DEFAULT_SIGNAL_ORIGIN;
  const possibleCandidates =
    candidates ??
    (await (deps.findIssuesByWatchdogKeys ?? findIssuesByWatchdogKeys)(uniqueKeys).catch(() => [] as EngineerIssue[]));
  const canonical = possibleCandidates.find((candidate) => {
    if (candidate.id === prior.id || !isWatchdogNonTerminal(candidate)) return false;
    const payload = (candidate.payload as Record<string, unknown> | null) ?? {};
    return (
      compatibleToolFailureClassIdentity(candidate, incomingProbation) &&
      issueWatchdogLane(candidate) !== 'observation' &&
      typeof payload.watchdogKey === 'string' &&
      uniqueKeys.includes(payload.watchdogKey) &&
      effectiveOrigin(candidate.signalOrigin) === origin &&
      issueScopeMatchesCapture(candidate, input.scope)
    );
  });
  if (!canonical) return null;

  const canonicalPayload = (canonical.payload as Record<string, unknown> | null) ?? {};
  const canonicalProbation = toolFailureProbationOf(canonicalPayload) ?? {};
  const reporters = [
    ...new Set(
      [
        ...(Array.isArray(canonicalProbation.reporters) ? canonicalProbation.reporters : []),
        ...(Array.isArray(priorProbation.reporters) ? priorProbation.reporters : []),
        ...(Array.isArray(incomingProbation.reporters) ? incomingProbation.reporters : []),
        ...(input.createdBy ? [input.createdBy] : []),
      ].filter(Boolean),
    ),
  ];
  const kind = incomingProbation.intendedKind ?? priorProbation.intendedKind ?? storageKindOf(input.kind);
  const reconciledAt = new Date().toISOString();
  const canonicalKey = preserveCanonicalWatchdogKey
    ? typeof canonicalPayload.watchdogKey === 'string' && canonicalPayload.watchdogKey
      ? canonicalPayload.watchdogKey
      : undefined
    : (typeof canonicalPayload.watchdogKey === 'string' && canonicalPayload.watchdogKey) ||
      input.watchdogKey ||
      (typeof priorPayload.watchdogKey === 'string' ? priorPayload.watchdogKey : undefined);
  const merged = await (deps.mergeIssuePayload ?? mergeIssuePayload)(canonical.id, {
    ...(canonicalKey ? { watchdogKey: canonicalKey } : {}),
    ...(input.paths?.length ? { paths: input.paths } : {}),
    toolFailureProbation: {
      ...canonicalProbation,
      ...priorProbation,
      ...incomingProbation,
      state: 'promoted',
      reporters,
      intendedKind: kind,
      promotedAt: canonicalProbation.promotedAt ?? priorProbation.promotedAt ?? reconciledAt,
      promotedBy:
        canonicalProbation.promotedBy ?? priorProbation.promotedBy ?? input.createdBy ?? PROMOTION_RECONCILIATION_OWNER,
      promotionReconciledFrom: prior.id,
      promotionReconciledAt: reconciledAt,
    },
    ...(canonicalPayload.implementationReadiness
      ? {}
      : { implementationReadiness: promotedProbationReadiness(input, incomingProbation) }),
    promotionReconciledFrom: prior.id,
    promotionReconciledAt: reconciledAt,
  }).catch(() => null);
  if (!merged) return null;

  const markedLoser = await (deps.mergeIssuePayload ?? mergeIssuePayload)(prior.id, {
    decidedReason: `duplicate of ${canonical.id} — migration-865 promotion reconciliation`,
    promotionReconciledInto: canonical.id,
    promotionReconciledAt: reconciledAt,
  }).catch(() => null);
  if (!markedLoser) return null;

  const terminalized = await (deps.setIssueState ?? setIssueState)(
    prior.id,
    'resolved',
    PROMOTION_RECONCILIATION_OWNER,
    undefined,
    { skipCompletionGate: true },
  ).catch(() => null);
  if (!terminalized) return null;

  await (deps.tagIssue ?? tagIssue)(canonical.id, IMPROVEMENT_TOPIC, input.createdBy).catch(() => {});
  await (deps.untagIssue ?? untagIssue)(prior.id, OBSERVATION_TOPIC).catch(() => {});
  return merged;
}

/** Promote one exact-key probation row in place, preserving its history/id. */
async function promoteToolFailureProbation(
  prior: EngineerIssue,
  input: CaptureImprovementInput,
  deps: CaptureDeps,
  promotionCandidates?: readonly EngineerIssue[],
  preserveCanonicalWatchdogKey = false,
): Promise<EngineerIssue | null> {
  const priorPayload = (prior.payload as Record<string, unknown> | null) ?? {};
  const priorProbation = toolFailureProbationOf(priorPayload) ?? {};
  const incomingProbation = toolFailureProbationOf(input.payloadExtra ?? {}) ?? {};
  if (!compatibleToolFailureClassIdentity(prior, incomingProbation)) return null;
  const reporters = [
    ...new Set(
      [
        ...(Array.isArray(priorProbation.reporters) ? priorProbation.reporters : []),
        ...(Array.isArray(incomingProbation.reporters) ? incomingProbation.reporters : []),
        ...(input.createdBy ? [input.createdBy] : []),
      ].filter(Boolean),
    ),
  ];
  const kind = incomingProbation.intendedKind ?? storageKindOf(input.kind);

  // Change the visible content first while the row is still safely parked. The
  // lane flip is last: if either write fails, a retry cannot expose a half-
  // promoted observation to the scheduler.
  const updatedRaw = await (deps.updateIssuePatch ?? updateIssue)(prior.id, {
    title: input.title,
    body: input.body,
    severity: input.severity ?? (kind === 'bug' ? 'major' : 'minor'),
    kind,
    silent: true,
    confirmShrink: true,
  }).catch(() => null);
  const updated = updatedRaw && 'id' in updatedRaw ? updatedRaw : null;
  if (!updated) return null;
  const promotedAt = new Date().toISOString();
  let promotionMergeError: unknown;
  const merged = await (deps.mergeIssuePayload ?? mergeIssuePayload)(
    prior.id,
    {
      // The probation row may have been keyed by its first report while the
      // direct-evidence promotion carries a newer message fingerprint. Exact
      // and title-key routes update the top-level identity so the next lookup
      // follows the promoted report; class-key routes preserve their existing
      // indexed identity and keep the newer evidence in the nested payload.
      ...(!preserveCanonicalWatchdogKey &&
      typeof incomingProbation.watchdogKey === 'string' &&
      incomingProbation.watchdogKey
        ? { watchdogKey: incomingProbation.watchdogKey }
        : {}),
      ...(input.paths?.length ? { paths: input.paths } : {}),
      toolFailureProbation: {
        ...priorProbation,
        ...incomingProbation,
        state: 'promoted',
        reporters,
        intendedKind: kind,
        promotedAt,
        promotedBy: input.createdBy ?? 'system:improvement-watchdog',
      },
      implementationReadiness: promotedProbationReadiness(input, incomingProbation),
      ideaLifecycle: initializeIdeaLifecycle(),
    },
    { unset: ['lane'] },
  ).catch((error) => {
    promotionMergeError = error;
    return null;
  });
  if (!merged && isWatchdogIdentityConflict(promotionMergeError)) {
    const reconciled = await reconcileToolFailurePromotionCollision(
      prior,
      input,
      deps,
      promotionCandidates,
      preserveCanonicalWatchdogKey,
    );
    if (reconciled) return reconciled;
  }
  if (!merged) return null;
  await (deps.tagIssue ?? tagIssue)(prior.id, IMPROVEMENT_TOPIC, input.createdBy).catch(() => {});
  await (deps.untagIssue ?? untagIssue)(prior.id, OBSERVATION_TOPIC).catch(() => {});
  return merged;
}

/**
 * P-004: the writer identity the watchdog auto-close stamps into `terminalOwner`
 * via `setIssueState(id, 'resolved', WATCHDOG_AUTO_CLOSE_OWNER, …)` — the single
 * source auto-close.ts imports, and the recognizer the exact-key recurrence
 * reopen matches on. `terminalOwner` is never cleared on reopen, so historical
 * auto-closed rows are recognizable too.
 */
export const WATCHDOG_AUTO_CLOSE_OWNER = 'watchdog-auto-close';

/** A quoted native exec refusal is a stable condition even when agents give it
 * different titles. Require the exact diagnostic and an exec/shell context:
 * prose about a different cleanup failure must keep its own row. */
function nativeShellRefusalKey(title: string, body: string | undefined): string | null {
  const report = `${title}\n${body ?? ''}`;
  if (!/rm -f style commands are not permitted/i.test(report)) return null;
  if (!/\b(?:exec_command|CreateProcess|shell|sandbox)\b/i.test(report)) return null;
  return 'native-exec-refusal:rm-f-style-commands-not-permitted';
}

/**
 * P-006/D-004: the coalesce report — what the write actually DID. Shared by the
 * observation-lane coalesce (EI-15448) and the non-observation detector coalesce
 * (WI-39594) so the two paths cannot drift in what they disclose: whether the
 * caller's prose landed or was discarded, and whether it overwrote a peer's row.
 */
function buildCoalesceEffect(args: {
  finalIssue: EngineerIssue;
  prior: EngineerIssue;
  input: CaptureImprovementInput;
  repeatCount: number;
  bodyPersisted: boolean;
  /** P-013: `append-only` when the survivor's text was deliberately left alone
   *  (derived folds), so a policy decision is never reported as a write loss.
   *  Defaults to the keyed behaviour: persisted ⇒ refreshed, else ⇒ lost. */
  textDisposition?: 'refreshed' | 'append-only' | 'lost';
  /** P-013/P-015: the DERIVED-identity classification, when this fold was not
   *  keyed. Omitted ⇒ the fold came from an exact `watchdogKey` match. Without
   *  it the note below rendered a literal "conditionKey `undefined`" on every
   *  derived fold — a false claim that a key existed. */
  fold?: FoldClassification;
  /** P-004: overrides the fold-derived identity — the `title-key` route (a
   *  keyless non-observation filer matched by exact normalized titleKey) has no fold
   *  classification AND no conditionKey, so neither default clause is true. */
  identityRoute?: CoalesceEffect['identity'];
  /** P-004: the survivor had been watchdog-auto-resolved; THIS recurrence
   *  reopened it (resolved → open) before the coalesce below. */
  reopened?: boolean;
}): CoalesceEffect {
  const { finalIssue, prior, input, repeatCount, bodyPersisted, fold } = args;
  const textDisposition = args.textDisposition ?? (bodyPersisted ? 'refreshed' : 'lost');
  const priorAuthor = prior.createdBy ?? null;
  // Undecidable when either side is unknown: an unattributed row must not be
  // reported as a peer's (it would manufacture a cross-author claim), nor as
  // your own. False = "not established", never "verified same author".
  const crossAuthor = Boolean(priorAuthor && input.createdBy && priorAuthor !== input.createdBy);
  const identity: CoalesceEffect['identity'] = args.identityRoute ?? (fold ? 'derived' : 'condition-key');
  // The identity clause must state WHICH route matched. A derived fold has no
  // key, so interpolating `input.watchdogKey` there renders "conditionKey
  // `undefined`" — a claim that a key existed when none did.
  const identityClause =
    identity === 'title-key'
      ? 'exact titleKey match — keyless non-observation filer, no conditionKey supplied'
      : identity === 'class-key'
        ? `stable tool-failure class identity carried by \`${input.watchdogKey}\``
        : identity === 'derived' && !fold
          ? `derived conditionKey \`${input.watchdogKey}\``
        : fold
          ? `derived identity — ${fold.rule}` +
            (typeof fold.candidate?.similarity === 'number' ? `, cosine ${fold.candidate.similarity.toFixed(3)}` : '')
          : `conditionKey \`${input.watchdogKey}\``;
  const identityBasis =
    identity === 'title-key'
      ? 'the shared normalized titleKey'
      : identity === 'class-key'
        ? 'the shared tool-failure class identity'
        : identity === 'derived'
          ? 'the derived identity'
          : 'the shared conditionKey';
  return {
    id: finalIssue.id,
    repeatCount,
    bodyPersisted,
    ...(textDisposition === 'lost' ? { bodyDiscarded: true as const } : {}),
    textDisposition,
    priorAuthor,
    crossAuthor,
    identity,
    ...(args.reopened ? { reopened: true as const } : {}),
    ...(fold
      ? {
          foldRule: fold.rule,
          foldNote: fold.note,
          ...(typeof fold.candidate?.similarity === 'number' ? { similarity: fold.candidate.similarity } : {}),
        }
      : {}),
    note:
      `No new row was created: this reading COALESCED onto ${args.reopened ? `${finalIssue.id} — which had been AUTO-RESOLVED by the watchdog and was REOPENED by this exact-key recurrence (the auto-close is a dedup marker, not a completion)` : `still-live ${finalIssue.id}`} ` +
      `(${identityClause}), now at repeatCount ${repeatCount}. ` +
      (textDisposition === 'refreshed'
        ? `Your title/body REPLACED the text that row previously carried`
        : textDisposition === 'append-only'
          ? `Your reading was APPENDED as an occurrence and the survivor's own text was left ` +
            `unchanged — deliberate, not a failure: this fold's identity was INFERRED from ` +
            `content, and an inferred match must never be allowed to overwrite another agent's ` +
            `account. Nothing you wrote was lost; ${finalIssue.id}'s visible text is simply not ` +
            `yours, so do not re-read it expecting your words`
          : `⚠ YOUR TITLE/BODY WAS DISCARDED — the refresh failed, so the row still shows the ` +
            `PREVIOUS reading. The repeatCount bump landed, your prose did not; re-read ` +
            `${finalIssue.id} before asserting anywhere that it reflects what you just wrote`) +
      (crossAuthor
        ? `. That row was authored by ${priorAuthor}, not you — you have written onto a PEER's ` +
          `row. This is intended (${identityBasis} is what stops a flood of near-identical ` +
          `rows), and every occurrence is retained, but the row's visible text is now the latest ` +
          `writer's, so do not read it as that author's own account.`
        : `.`),
  };
}

/** How many scored candidates the derived fold hydrates. Bounded because each
 *  is a row read; the classifier sorts by similarity, so a real match is at the
 *  top of the list, not the tail. */
const DERIVED_FOLD_MAX_CANDIDATES = 8;

/**
 * P-013 (D-042): establish a DERIVED identity for an agent filing that supplied
 * no `watchdogKey`, and classify it against the open observations it might be a
 * repeat of.
 *
 * Returns `null` for NO VERDICT — the embedding leg is disabled, timed out, or
 * vitest-inert. Null means "mint, exactly as before"; it must never be read as
 * "nothing similar", which is what a `verdict:'none'` says.
 *
 * Three filters run HERE rather than inside the classifier, deliberately: scope
 * and lifecycle are correctness, and burying them in a scorer is how a fold
 * silently crosses a Pot boundary.
 *  1. OPEN, observation-lane, same signal origin, same scope grain — the same
 *     rails the keyed path enforces via `sameWatchdogIdentity`.
 *  2. NOT already keyed. A row carrying a `watchdogKey` belongs to the emitter
 *     that keys it; letting an inferred match fold onto it would let one wrong
 *     guess rewrite a machine emitter's standing row. Consolidating those is a
 *     separate, and much more dangerous, change.
 *  3. Not the same row twice — the guard's two bands can both name a candidate.
 */
async function classifyDerivedObservationFold(args: {
  input: CaptureImprovementInput;
  origin: string;
  deps: CaptureDeps;
}): Promise<{ fold: FoldClassification; prior: EngineerIssue | null } | null> {
  const { input, origin, deps } = args;
  const sem = await (deps.findSemanticDupes ?? findSemanticDupes)({
    title: input.title,
    ...(input.body ? { summary: input.body } : {}),
  }).catch(() => null);
  if (!sem) return null;

  // Union BOTH bands. The guard buckets by ITS thresholds; the fold decider
  // applies its own (co-signal 0.86/0.45, soft 0.90), which cut the same range
  // differently — so it must see every scored candidate, never the guard's
  // verdict about them.
  const scored = new Map<string, { id: string; similarity: number; titleSimilarity?: number }>();
  for (const band of ['hard', 'soft'] as const) {
    for (const c of sem[band]) if (!scored.has(c.id)) scored.set(c.id, c);
  }

  const fetchIssue = deps.getIssue ?? getIssue;
  const hydrated = new Map<string, EngineerIssue>();
  const candidates: FoldCandidate[] = [];
  for (const scoredCandidate of [...scored.values()]
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, DERIVED_FOLD_MAX_CANDIDATES)) {
    const issue = await fetchIssue(scoredCandidate.id).catch(() => null);
    if (!issue || issue.state !== 'open') continue;
    const payload = (issue.payload as Record<string, unknown> | null) ?? {};
    if (payload.lane !== 'observation') continue;
    if (typeof payload.watchdogKey === 'string' && payload.watchdogKey) continue;
    if (effectiveOrigin(issue.signalOrigin) !== origin) continue;
    if (!issueScopeMatchesCapture(issue, input.scope)) continue;
    hydrated.set(issue.id, issue);
    candidates.push({
      id: issue.id,
      // The row's CURRENT title, not the one the vector was built from: the
      // discriminator compares subjects, and a stale title names stale subjects.
      title: issue.title,
      similarity: scoredCandidate.similarity,
      ...(typeof scoredCandidate.titleSimilarity === 'number'
        ? { titleSimilarity: scoredCandidate.titleSimilarity }
        : {}),
    });
  }

  const fold = classifyObservationFold(input.title, candidates);
  return { fold, prior: fold.candidate ? (hydrated.get(fold.candidate.id) ?? null) : null };
}

/**
 * Recover a migration-865 unique-index race by applying the same coalesce
 * semantics as the pre-insert exact-key path. The caller has already proved
 * the winner's key, origin, lane, Pot scope, and non-terminal state; this
 * helper intentionally performs no fuzzy matching.
 */
async function coalesceWatchdogWinner(args: {
  prior: EngineerIssue;
  input: CaptureImprovementInput;
  deps: CaptureDeps;
  identity: AdmissionIdentity;
  possibleDuplicates: PossibleDuplicate[];
  dedupCoverage: DedupCoverage;
  topics: string[];
  alreadyDecided?: AlreadyDecidedRecall[];
  queueAdmission?: IssueAdmissionPressure;
  identityRoute?: CoalesceEffect['identity'];
}): Promise<CaptureImprovementResult> {
  const { prior, input, deps, identity, possibleDuplicates, dedupCoverage, topics, alreadyDecided, queueAdmission } =
    args;
  if (input.artifactId) {
    if (prior.id !== input.artifactId) throw new Error('Reserved capture cannot coalesce into another artifact');
    return { ok: true, created: false, issue: prior, possibleDuplicates: [] };
  }
  const priorPayload = (prior.payload as Record<string, unknown>) ?? {};
  const priorProbation = toolFailureProbationOf(priorPayload);
  const incomingProbation = toolFailureProbationOf(input.payloadExtra ?? {});
  const preserveCanonicalWatchdogKey = args.identityRoute === 'class-key';
  const priorReporters = Array.isArray(priorProbation?.reporters) ? priorProbation.reporters : [];
  const incomingReporters = Array.isArray(incomingProbation?.reporters) ? incomingProbation.reporters : [];
  const reporters = [
    ...new Set([...priorReporters, ...incomingReporters, ...(input.createdBy ? [input.createdBy] : [])]),
  ];
  const independentReporter = reporters.some((reporter) => !priorReporters.includes(reporter));

  // Preserve the probation→promoted transition if two observation captures
  // raced before either could observe the other's newly-created row.
  if (
    issueWatchdogLane(prior) === 'observation' &&
    priorProbation?.state === 'probation' &&
    incomingProbation &&
    compatibleToolFailureClassIdentity(prior, incomingProbation) &&
    priorReporters.length > 0 &&
    independentReporter
  ) {
    const promoted = await promoteToolFailureProbation(prior, input, deps, undefined, preserveCanonicalWatchdogKey);
    if (promoted) {
      await appendCaptureOccurrence(
        deps,
        input,
        identity,
        'promoted',
        promoted.id,
        possibleDuplicates,
        dedupCoverage,
        harnessFromScope(promoted.scope) ?? harnessFromScope(input.scope),
        queueAdmission,
      );
      return {
        ok: true,
        created: false,
        reason: 'promoted',
        kind: promoted.kind as 'bug' | 'change',
        improvementKind: input.kind,
        issue: promoted,
        topics: [IMPROVEMENT_TOPIC, ...(input.subTopic ? [input.subTopic] : [])],
        possibleDuplicates,
        dedupCoverage,
        ...(alreadyDecided?.length ? { alreadyDecided } : {}),
        ...(queueAdmission ? { queueAdmission } : {}),
      };
    }
  }

  const repeatCount = (typeof priorPayload.repeatCount === 'number' ? priorPayload.repeatCount : 1) + 1;
  const mergePatch: Record<string, unknown> = {
    ...(!preserveCanonicalWatchdogKey && input.watchdogKey ? { watchdogKey: input.watchdogKey } : {}),
    repeatCount,
    lastSeenAt: new Date().toISOString(),
  };
  if (input.paths?.length) mergePatch.paths = input.paths;
  if (input.payloadExtra) Object.assign(mergePatch, input.payloadExtra);
  if (priorProbation && incomingProbation) {
    mergePatch.toolFailureProbation = {
      ...priorProbation,
      ...incomingProbation,
      reporters,
      lastSeenAt: new Date().toISOString(),
    };
  }
  if (preserveCanonicalWatchdogKey && typeof priorPayload.watchdogKey === 'string' && priorPayload.watchdogKey) {
    mergePatch.watchdogKey = priorPayload.watchdogKey;
  }
  if (input.filedByRole) mergePatch.filedByRole = input.filedByRole;
  if ((input.sourceRole ?? 'human') !== 'human') mergePatch.sourceRole = input.sourceRole;
  const merged = await (deps.mergeIssuePayload ?? mergeIssuePayload)(prior.id, mergePatch);
  const refreshed = await (deps.updateIssuePatch ?? updateIssue)(prior.id, {
    title: input.title,
    body: input.body,
    silent: true,
    confirmShrink: true,
  }).catch(() => null);
  const finalIssue = (refreshed && 'id' in refreshed ? refreshed : merged) ?? prior;
  await appendCaptureOccurrence(
    deps,
    input,
    identity,
    'coalesced',
    finalIssue.id,
    possibleDuplicates,
    dedupCoverage,
    harnessFromScope(finalIssue.scope) ?? harnessFromScope(input.scope),
    queueAdmission,
  );
  const bodyPersisted = refreshed !== null && 'id' in (refreshed as object);
  return {
    ok: true,
    created: false,
    reason: 'coalesced',
    coalescedOnto: buildCoalesceEffect({
      finalIssue,
      prior,
      input,
      repeatCount,
      bodyPersisted,
      identityRoute: args.identityRoute,
    }),
    kind: finalIssue.kind as 'bug' | 'change',
    improvementKind: input.kind,
    issue: finalIssue,
    topics,
    possibleDuplicates,
    dedupCoverage,
    ...(alreadyDecided?.length ? { alreadyDecided } : {}),
    ...(queueAdmission ? { queueAdmission } : {}),
  };
}

/** A committed invocation snapshot. Missing contract dimensions stay unknown. */
export interface ToolInvocationFriction {
  workspaceId: string;
  harnessSlug: string;
  ownerId: string;
  invokedAt: string;
  failure: Pick<SuspectedToolFailure, 'toolName' | 'errorCode' | 'status' | 'message' | 'schemaRevision' | 'fieldPath' | 'runtimeVersion'>;
}

/** R-7: reuse the ordinary probation door without agent-authored incident fields. */
export async function captureToolInvocationFriction(
  invocation: ToolInvocationFriction,
  deps: CaptureDeps = defaultDeps,
): Promise<CaptureImprovementResult | null> {
  const { failure, ownerId, workspaceId, harnessSlug, invokedAt } = invocation;
  if (!ownerId || !workspaceId || !['error', 'invalid-input', 'timeout'].includes(failure.status ?? '') ||
      /^(improvements:|system:improvement-)/.test(failure.toolName)) return null;
  // Copy only measured fields; a telemetry object can never smuggle direct-
  // evidence flags into an admission decision.
  const report: SuspectedToolFailure = {
    toolName: failure.toolName, errorCode: failure.errorCode, status: failure.status,
    message: failure.message, schemaRevision: failure.schemaRevision,
    fieldPath: failure.fieldPath, runtimeVersion: failure.runtimeVersion,
  };
  const normalized = normalizeSuspectedToolFailure(report);
  const kind = normalized.class === 'caller' || normalized.class === 'rate-limit' ? 'change' : 'bug';
  // D-010 (review-system-rework-reduction-2026-09-23): migration 865's arbiter
  // keys watchdogKey, so the ROW identity is the build-independent signature.
  // The contract/build class stays the CORROBORATION identity: it is the row's
  // probation classKey and is tallied per class below, so a report on another
  // build counts onto the row but can neither corroborate nor rewrite it.
  const signatureKey = toolFailureSignatureKey(report, normalized.class);
  // WI-10003605: a workspace-spanning invocation records its harness as the wildcard
  // '*'. The work-item scope guard (work-item-scope.ts) refuses `harness:*`, so every
  // such friction report threw and console.warned once per invocation (failing every
  // fail-on-console real-engine PUI test). A wildcard names no harness: file operator-scoped.
  const concreteHarness = typeof harnessSlug === 'string' && harnessSlug.trim() && harnessSlug.trim() !== '*'
    ? harnessSlug.trim() : null;
  const scope = concreteHarness ? `harness:${concreteHarness}` : 'operator';
  const toolInvocation = { workspaceId, harnessSlug, ownerId, invokedAt };
  const incomingProbation = {
    ...normalized, watchdogKey: signatureKey, signatureKey, state: 'probation' as const, intendedKind: kind,
    reporters: [ownerId], firstSeenAt: invokedAt, lastSeenAt: invokedAt, report,
  };
  const base: CaptureImprovementInput = {
    title: `${failure.toolName} tool-call failure (${failure.errorCode ?? failure.status})`,
    body: `Invocation telemetry observed ${failure.toolName} at ${invokedAt}.\n\n${failure.message}`,
    kind, severity: 'nit', lane: 'observation', scope,
    workspaceId, createdBy: ownerId, evidenceAt: invokedAt,
    watchdogKey: signatureKey,
    // Do not set sourceRole:'system': an automated report is still this
    // caller's evidence, not a trusted watchdog promotion or review waiver.
  };
  // Fail open like every other capture lookup: an unreadable index mints, and
  // migration 865's arbiter still refuses a second open row for the signature.
  const signatureHits = await (deps.findIssuesByWatchdogKeys ?? findIssuesByWatchdogKeys)([signatureKey])
    .catch(() => [] as EngineerIssue[]);
  const signatureRow = signatureHits.find((issue) =>
    (issue.payload as Record<string, unknown> | null)?.watchdogKey === signatureKey &&
    isWatchdogNonTerminal(issue) &&
    effectiveOrigin(issue.signalOrigin) === DEFAULT_SIGNAL_ORIGIN &&
    issueScopeMatchesCapture(issue, scope));
  const priorPayload = (signatureRow?.payload as Record<string, unknown> | null) ?? {};
  const rowProbation = toolFailureProbationOf(priorPayload);
  const occurrence: ToolFailureClassOccurrence = {
    classKey: normalized.classKey, ownerId, at: invokedAt,
    contractFingerprint: normalized.contractFingerprint, deployedRevision: normalized.deployedRevision,
  };
  const tally = tallyToolFailureClass(toolFailureSignatureOf(priorPayload), signatureKey, occurrence,
    rowProbation?.classKey);
  if (!signatureRow || rowProbation?.classKey === normalized.classKey) {
    // A new signature, or the row's own class: the ordinary class-key route
    // mints, coalesces or corroborates exactly as it did before D-010.
    return captureImprovement({
      ...base,
      payloadExtra: { toolFailureProbation: incomingProbation, toolFailureSignature: tally, toolInvocation },
    }, deps);
  }
  const identity = admissionIdentity(base.title, signatureKey);
  const coverage: DedupCoverage = { lexical: 'skipped', semantic: 'skipped', degraded: false };
  const harness = harnessFromScope(signatureRow.scope);
  const repeatCount = (typeof priorPayload.repeatCount === 'number' ? priorPayload.repeatCount : 1) + 1;
  // Another class of an observation still in probation: corroborated only when
  // THIS class already has a different reporter. The row then adopts the
  // corroborated class and is promoted; the uncorroborated first class never
  // promotes it, and a single new-build report never rewrites it.
  const earlierReporters = toolFailureSignatureOf(priorPayload)?.classes[normalized.classKey]?.reporters ?? [];
  if (issueWatchdogLane(signatureRow) === 'observation' && rowProbation?.state === 'probation' &&
      earlierReporters.length > 0 && !earlierReporters.includes(ownerId)) {
    const classView: EngineerIssue = { ...signatureRow, payload: { ...priorPayload,
      toolFailureProbation: { ...rowProbation, ...normalized, watchdogKey: signatureKey, signatureKey,
        reporters: earlierReporters } } };
    const input = { ...base, payloadExtra: { toolFailureProbation: incomingProbation, toolInvocation } };
    const promoted = await promoteToolFailureProbation(classView, input, deps, signatureHits, true);
    if (promoted) {
      const merged = await (deps.mergeIssuePayload ?? mergeIssuePayload)(promoted.id,
        { repeatCount, lastSeenAt: new Date().toISOString(), toolFailureSignature: tally }).catch(() => null);
      await appendCaptureOccurrence(deps, input, identity, 'promoted', promoted.id, [], coverage, harness);
      return {
        ok: true, created: false, reason: 'promoted', kind: promoted.kind as 'bug' | 'change',
        improvementKind: kind, issue: merged ?? promoted, topics: [IMPROVEMENT_TOPIC],
        possibleDuplicates: [], dedupCoverage: coverage,
      };
    }
  }
  // Otherwise the report is a counted occurrence: repeatCount and the class
  // tally move; the row's probation, disposition, title and body do not.
  const input = { ...base, payloadExtra: { toolFailureSignature: tally, toolInvocation } };
  const merged = await (deps.mergeIssuePayload ?? mergeIssuePayload)(signatureRow.id,
    { repeatCount, lastSeenAt: new Date().toISOString(), toolFailureSignature: tally });
  if (!merged) {
    // The row left the open set under us: file through the ordinary door.
    return captureImprovement({
      ...base,
      payloadExtra: { toolFailureProbation: incomingProbation, toolFailureSignature: tally, toolInvocation },
    }, deps);
  }
  await appendCaptureOccurrence(deps, input, identity, 'coalesced', merged.id, [], coverage, harness);
  return {
    ok: true, created: false, reason: 'coalesced', kind: merged.kind as 'bug' | 'change',
    improvementKind: kind, issue: merged, possibleDuplicates: [], dedupCoverage: coverage,
  };
}

/** One build/contract class inside a signature row (D-010). */
export interface ToolFailureSignatureClass {
  reporters: string[];
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  contractFingerprint: string;
  deployedRevision: string;
}

export interface ToolFailureSignaturePayload {
  signatureKey: string;
  classes: Record<string, ToolFailureSignatureClass>;
}

interface ToolFailureClassOccurrence {
  classKey: string;
  ownerId: string;
  at: string;
  contractFingerprint: string;
  deployedRevision: string;
}

/** Classes kept per row. The oldest are dropped first; the probation class never is. */
export const TOOL_FAILURE_SIGNATURE_MAX_CLASSES = 32;
const TOOL_FAILURE_SIGNATURE_MAX_REPORTERS = 16;

export function toolFailureSignatureOf(payload: Record<string, unknown> | null | undefined): ToolFailureSignaturePayload | null {
  const candidate = payload?.toolFailureSignature as Partial<ToolFailureSignaturePayload> | undefined;
  return candidate && typeof candidate === 'object' && candidate.classes && typeof candidate.classes === 'object'
    ? (candidate as ToolFailureSignaturePayload)
    : null;
}

/**
 * Add one occurrence to a signature row's per-class tally (pure). A row keyed by
 * signature can see a new class on every build, so the tally is bounded: the
 * least-recently-seen classes go first, and the class the row's probation is
 * about is always kept, because corroboration reads it.
 */
export function tallyToolFailureClass(
  prior: ToolFailureSignaturePayload | null,
  signatureKey: string,
  occurrence: ToolFailureClassOccurrence,
  keepClassKey?: string,
): ToolFailureSignaturePayload {
  return addToolFailureClassSnapshot(prior, signatureKey, occurrence.classKey, {
    reporters: [occurrence.ownerId], count: 1, firstSeenAt: occurrence.at, lastSeenAt: occurrence.at,
    contractFingerprint: occurrence.contractFingerprint, deployedRevision: occurrence.deployedRevision,
  }, keepClassKey);
}

/**
 * Add a whole class snapshot (reporters, count, first/last seen) to a signature
 * tally (pure). Used for single occurrences and for folding a legacy per-class
 * row into its signature row.
 */
export function addToolFailureClassSnapshot(
  prior: ToolFailureSignaturePayload | null,
  signatureKey: string,
  classKey: string,
  snapshot: ToolFailureSignatureClass,
  keepClassKey?: string,
): ToolFailureSignaturePayload {
  const classes: Record<string, ToolFailureSignatureClass> = { ...(prior?.classes ?? {}) };
  const before = classes[classKey];
  const earliest = [before?.firstSeenAt, snapshot.firstSeenAt].filter(Boolean).sort()[0] ?? snapshot.firstSeenAt;
  const latest = [before?.lastSeenAt, snapshot.lastSeenAt].filter(Boolean).sort().at(-1) ?? snapshot.lastSeenAt;
  classes[classKey] = {
    reporters: [...new Set([...(before?.reporters ?? []), ...snapshot.reporters])].slice(-TOOL_FAILURE_SIGNATURE_MAX_REPORTERS),
    count: (before?.count ?? 0) + snapshot.count,
    firstSeenAt: earliest,
    lastSeenAt: latest,
    contractFingerprint: snapshot.contractFingerprint,
    deployedRevision: snapshot.deployedRevision,
  };
  const evictable = Object.entries(classes)
    .filter(([key]) => key !== keepClassKey && key !== classKey)
    .sort(([, a], [, b]) => a.lastSeenAt.localeCompare(b.lastSeenAt));
  while (Object.keys(classes).length > TOOL_FAILURE_SIGNATURE_MAX_CLASSES && evictable.length > 0) {
    delete classes[evictable.shift()![0]];
  }
  return { signatureKey, classes };
}

export async function captureImprovement(
  input: CaptureImprovementInput,
  deps: CaptureDeps = defaultDeps,
): Promise<CaptureImprovementResult> {
  const readReservedArtifact = async (): Promise<CaptureImprovementResult | null> => {
    if (!input.artifactId) return null;
    if (!/^(EI|WI)-\d+$/.test(input.artifactId) || !input.watchdogKey)
      throw new Error('A reserved capture requires a canonical artifact id and stable watchdog key');
    const existing = await (deps.getIssue ?? getIssue)(input.artifactId);
    if (!existing) return null;
    const payload = (existing.payload ?? {}) as Record<string, unknown>;
    if (existing.scope !== input.scope || payload.watchdogKey !== input.watchdogKey)
      throw new Error('Reserved capture id belongs to another identity');
    return { ok: true, created: false, issue: existing, possibleDuplicates: [] };
  };
  const reserved = await readReservedArtifact();
  if (reserved) return reserved;
  // Dedup search (D-001/P-002): full-text search, then a title-similarity pass.
  // Origin-scoped (frontier P-002/D-002): only candidates with the SAME effective
  // origin participate in dedup + decided-recall — a drill row deduping against an
  // organic capture (or vice versa) would let synthetic signals suppress real ones.
  const isObservation = input.lane === 'observation';
  // Use the existing keyed recurrence path for this exact native diagnostic.
  // This key is INFERRED, so its coalesce below keeps the first row's text and
  // records later accounts only in the occurrence ledger (D-042).
  const inferredShellRefusalKey = isObservation && input.initialState !== 'done' && !input.watchdogKey && !input.force
    ? nativeShellRefusalKey(input.title, input.body)
    : null;
  if (inferredShellRefusalKey) input = { ...input, watchdogKey: inferredShellRefusalKey };
  // Scorecards are immutable event records, not recurring sensor observations. They
  // use `initialState:'done'` as the scorecards:emit-only marker; letting that filing
  // enter the derived observation-fold path can shallow-merge its nested observation
  // onto an unrelated open scorecard row and corrupt both the row identity and the
  // freshness timestamp. Keyed observation coalescing is already unavailable to
  // scorecards (the public emit schema has no watchdogKey), but keep this explicit so
  // the immutable-event rule remains true if another observation dedup path is added.
  const immutableScorecard = isObservation && input.initialState === 'done';
  const reviewRequired = Boolean(
    input.reviewRequired && !isObservation && (input.kind === 'change' || input.kind === 'feature'),
  );
  const reviewHarness = input.reviewHarness ?? harnessFromScope(input.scope);
  const sourceRole = input.sourceRole ?? 'human';
  const identity = admissionIdentity(input.title, input.watchdogKey);
  const skippedDedupCoverage: DedupCoverage = {
    lexical: 'skipped',
    semantic: 'skipped',
    degraded: false,
  };
  // Rubric-grading evidence gate (rubric-driven-observations-2026-06-20 D-002):
  // FAIL FAST — a structured observation whose ratings lack evidence (or whose
  // ratings block names no rubric) is a contract violation, rejected before any
  // dedup/search work. One gate here covers BOTH capture entry points (the
  // improvements:capture tool + the watchdog). Throws ObservationEvidenceError;
  // the tool handler catches it into a clean { ok:false, error } result.
  let observationForGate = input.payloadExtra?.observation as StructuredObservation | undefined;
  validateObservationRatings(observationForGate);
  // P-014a completeness gate (D-005): a rubric-graded scorecard must rate EVERY rubric criterion —
  // an omitted key is a silent truncation, not a pass (D-005 caught 3–4 of 13 keys live). Load the
  // rubric's criterion keys (best-effort: a load error skips the gate, never breaks the capture) +
  // reject on any missing key. validateObservationRatings already enforced per-rating evidence.
  if (
    deps.loadRubric &&
    observationForGate?.rubricRef &&
    observationForGate.ratings &&
    Object.keys(observationForGate.ratings).length > 0
  ) {
    const rubric = await deps.loadRubric(observationForGate.rubricRef).catch(() => null);
    if (rubric) {
      const normalizedRatings = normalizeScorecardRatings(observationForGate.ratings, rubric);
      const rawObservation = input.payloadExtra?.observation as Record<string, unknown>;
      observationForGate = { ...observationForGate, ratings: normalizedRatings };
      input = {
        ...input,
        payloadExtra: {
          ...input.payloadExtra,
          observation: { ...rawObservation, ratings: normalizedRatings },
        },
      };
    }
    validateScorecardCompleteness(observationForGate, rubric ? rubric.criteria.map((c) => c.key) : null);
    // P-002 rating-VALUE gate (rubric-system-improvements-2026-07-12): an off-scale
    // rating ("pas", "helthy") would file fine and be silently excluded from
    // trends/staleness — reject it here with the allowed values instead.
    validateScorecardRatingValues(observationForGate, rubric);
    // scorecard-poor-rating-disposition (owner-directed 2026-08-31): an AGENT-filed
    // poor rating must route somewhere — a remediation work-item or an explicit
    // disregard. Flag-scoped to the agent tool so floor emitters stay exempt.
    if (input.enforcePoorRatingDisposition) {
      validateScorecardPoorRatingDisposition(observationForGate, rubric);
    }
  }
  const origin = input.origin ?? DEFAULT_SIGNAL_ORIGIN;
  const checkOnly = input.checkDuplicatesOnly === true;

  // P-013: the invocation-ledger watchdog (or a caller with deterministic
  // reproduction evidence) corroborates an exact-key probation observation.
  // Promote THAT row in place before fuzzy dedup can misclassify it against itself.
  // EI-20484430331973864: fetched ONCE and used TWICE — to promote a probation
  // observation (immediately below), and as a first-class BLOCKING dedup source further
  // down. Previously an exact-key hit that matched no probation row was simply DISCARDED,
  // which left blocking dedup resting entirely on the fuzzy `searchIssues` title net.
  // That net fails OPEN (search unavailable ⇒ empty candidate set ⇒ capture admitted), so
  // a sentinel re-filing a standing condition on a stable key created a fresh critical row
  // on every pass the search happened to be down: measured 459 open copies of one
  // red-queen title, ~25% of the whole bug backlog duplicated this way.
  const incomingProbation = toolFailureProbationOf(input.payloadExtra ?? {});
  let exactKeyIssues: EngineerIssue[] = [];
  let exactKeyLookupFailed = false;
  let classKeyLookupFailed = false;
  let classKeyIssues: EngineerIssue[] = [];
  if (incomingProbation?.classKey) {
    classKeyIssues = await (deps.findIssuesByToolFailureClassKeys ?? findIssuesByToolFailureClassKeys)([
      incomingProbation.classKey,
    ]).catch(() => {
      classKeyLookupFailed = true;
      return [] as EngineerIssue[];
    });
    const classPrior = classKeyIssues.find((issue) =>
      sameToolFailureClassIdentity(issue, incomingProbation.classKey!, input, origin),
    );
    if (!checkOnly && isObservation && classPrior && issueWatchdogLane(classPrior) !== 'observation') {
      // A later retry is evidence on the accountable existing issue. Preserve
      // its disposition, severity, narrative, review state and promoted payload.
      await appendCaptureOccurrence(deps, input, identity, 'coalesced', classPrior.id,
        [], skippedDedupCoverage, harnessFromScope(classPrior.scope));
      return { ok: true, created: false, reason: 'coalesced', issue: classPrior,
        possibleDuplicates: [], dedupCoverage: skippedDedupCoverage };
    }
    if (!checkOnly && classPrior && incomingProbation.state === 'promoted') {
      const priorPayload = (classPrior.payload as Record<string, unknown> | null) ?? {};
      const priorProbation = toolFailureProbationOf(priorPayload);
      if (issueWatchdogLane(classPrior) === 'observation' && priorProbation?.state === 'probation') {
        const promoted = await promoteToolFailureProbation(classPrior, input, deps, classKeyIssues, true);
        if (promoted) {
          await appendCaptureOccurrence(
            deps,
            input,
            identity,
            'promoted',
            promoted.id,
            [],
            skippedDedupCoverage,
            harnessFromScope(promoted.scope),
          );
          return {
            ok: true,
            created: false,
            reason: 'promoted',
            kind: promoted.kind as 'bug' | 'change',
            improvementKind: input.kind,
            issue: promoted,
            topics: [IMPROVEMENT_TOPIC, ...(input.subTopic ? [input.subTopic] : [])],
            possibleDuplicates: [],
            dedupCoverage: skippedDedupCoverage,
          };
        }
      }
    }
    if (!checkOnly && classPrior?.state === 'open') {
      return coalesceWatchdogWinner({
        prior: classPrior,
        input,
        deps,
        identity,
        possibleDuplicates: [],
        dedupCoverage: skippedDedupCoverage,
        topics: [IMPROVEMENT_TOPIC, ...(input.subTopic ? [input.subTopic] : [])],
        identityRoute: 'class-key',
      });
    }
  }
  if (!isObservation && input.watchdogKey) {
    exactKeyIssues = await (deps.findIssuesByWatchdogKeys ?? findIssuesByWatchdogKeys)([input.watchdogKey]).catch(
      () => {
        // UNKNOWN must never read as "no duplicate exists" — surfaced via
        // dedupCoverage.degraded below, exactly like an unavailable lexical leg.
        exactKeyLookupFailed = true;
        return [] as EngineerIssue[];
      },
    );
    if (input.artifactId) {
      const winner = await readReservedArtifact();
      if (winner) return winner;
      if (exactKeyIssues.some((i) => sameWatchdogIdentity(i, input, origin)))
        throw new Error('Reserved capture key already belongs to another artifact');
    }
    // The database lookup is intentionally broad (it spans legacy workspace
    // homes for read-side recovery).  The one deliberate cross-lane exception
    // is probation promotion: the invocation-ledger watchdog promotes an
    // observation row into an improvement when independent direct evidence
    // arrives.  Ordinary exact-key blocking/coalescing remains migration-865
    // identity-exact (origin + lane + Pot scope).
    const probation = exactKeyIssues.find((i) => {
      const payload = (i.payload as Record<string, unknown> | null) ?? {};
      return (
        i.state === 'open' &&
        payload.lane === 'observation' &&
        toolFailureProbationOf(payload)?.state === 'probation' &&
        compatibleToolFailureClassIdentity(i, incomingProbation) &&
        effectiveOrigin(i.signalOrigin) === origin &&
        issueScopeMatchesCapture(i, input.scope)
      );
    });
    if (!checkOnly && probation) {
      const promoted = await promoteToolFailureProbation(probation, input, deps, exactKeyIssues);
      if (promoted) {
        await appendCaptureOccurrence(
          deps,
          input,
          identity,
          'promoted',
          promoted.id,
          [],
          skippedDedupCoverage,
          harnessFromScope(promoted.scope),
        );
        return {
          ok: true,
          created: false,
          reason: 'promoted',
          kind: promoted.kind as 'bug' | 'change',
          improvementKind: input.kind,
          issue: promoted,
          topics: [IMPROVEMENT_TOPIC, ...(input.subTopic ? [input.subTopic] : [])],
          possibleDuplicates: [],
          dedupCoverage: skippedDedupCoverage,
        };
      }
    }
    exactKeyIssues = exactKeyIssues.filter(
      (issue) =>
        sameWatchdogIdentity(issue, input, origin) &&
        compatibleToolFailureClassIdentity(issue, incomingProbation),
    );
    // WI-39594: an OPEN same-lane exact-key row COALESCES — a keyed detector
    // re-fire refreshes the standing row (repeatCount bump, latest title/body)
    // instead of forking a sibling. Runs BEFORE the fuzzy nets and BEFORE the
    // `force` override, deliberately: `force` means "this is genuinely distinct
    // from anything the nets GUESSED at" — an exact key match is not a guess, so
    // force must not turn a re-fire of the SAME keyed condition into a fresh row
    // (that force-through is exactly how the gym-champion escalations, filed
    // force:true "so the signal is never dropped", piled up ~25 open near-identical
    // items; a coalesce retains the signal — occurrence appended, repeatCount
    // bumped, text refreshed to the newest reading — while keeping ONE open item
    // per condition, the queue-audit-2026-08-17 ruling). An observation-lane
    // prior is excluded: its lifecycle (probation promotion above, Scout
    // clustering) owns that row, and merging an improvement INTO it would change
    // its lane semantics — the pre-existing exact-key BLOCK still covers that case.
    const openKeyPrior = exactKeyIssues.find((i) => {
      const payload = (i.payload as Record<string, unknown> | null) ?? {};
      return i.state === 'open' && payload.lane !== 'observation';
    });
    if (!checkOnly && openKeyPrior) {
      const priorPayload = (openKeyPrior.payload as Record<string, unknown> | null) ?? {};
      const repeatCount = (typeof priorPayload.repeatCount === 'number' ? priorPayload.repeatCount : 1) + 1;
      const mergePatch: Record<string, unknown> = {
        watchdogKey: input.watchdogKey,
        repeatCount,
        lastSeenAt: new Date().toISOString(),
      };
      if (input.paths?.length) mergePatch.paths = input.paths;
      if (input.payloadExtra) Object.assign(mergePatch, input.payloadExtra);
      if (input.filedByRole) mergePatch.filedByRole = input.filedByRole;
      if (sourceRole !== 'human') mergePatch.sourceRole = sourceRole;
      const merged = await (deps.mergeIssuePayload ?? mergeIssuePayload)(openKeyPrior.id, mergePatch);
      // Best-effort title/body refresh — never blocks the coalesce (the payload
      // bump above is the load-bearing part). Silent: a detector re-fire must not
      // fan out subscriber notifications every cadence tick.
      const refreshed = await (deps.updateIssuePatch ?? updateIssue)(openKeyPrior.id, {
        title: input.title,
        body: input.body,
        silent: true,
        confirmShrink: true,
      }).catch(() => null);
      const finalIssue = (refreshed && 'id' in refreshed ? refreshed : merged) ?? openKeyPrior;
      await appendCaptureOccurrence(
        deps,
        input,
        identity,
        'coalesced',
        finalIssue.id,
        [],
        skippedDedupCoverage,
        harnessFromScope(finalIssue.scope),
      );
      const bodyPersisted = refreshed !== null && 'id' in (refreshed as object);
      return {
        ok: true,
        created: false,
        reason: 'coalesced',
        coalescedOnto: buildCoalesceEffect({ finalIssue, prior: openKeyPrior, input, repeatCount, bodyPersisted }),
        kind: finalIssue.kind as 'bug' | 'change',
        improvementKind: input.kind,
        issue: finalIssue,
        topics: [
          IMPROVEMENT_TOPIC,
          ...(input.subTopic ? [input.subTopic] : []),
          ...(sourceRole !== 'human' ? [`improvement-source:${sourceRole}`] : []),
        ],
        possibleDuplicates: [],
        dedupCoverage: skippedDedupCoverage,
      };
    }
    // ─── P-004 (silent-intake-central-resolution-2026-09-01): exact-key recurrence
    // of a watchdog-AUTO-RESOLVED condition REOPENS the canonical row instead of
    // minting a sibling. The auto-close is a dedup marker, not a completion ("no
    // fix was dispatched; re-files automatically if it recurs" — auto-close.ts),
    // but the promised re-file used to mint a NEW row, stranding the occurrence
    // history and repeatCount on the resolved one — or, pre-P-002, decline outright
    // (EI-22065259669472144: capture found the exact resolved item and neither
    // reopened nor appended). Recognizer: terminalOwner === WATCHDOG_AUTO_CLOSE_OWNER,
    // stamped by setIssueState on the auto-close path and never cleared on reopen,
    // so historical auto-closed rows match too. An AGENT-resolved row deliberately
    // does NOT reopen — that close may be a genuine fix, and regression semantics
    // (re-file with dedupVerdict) remain correct for it.
    const autoResolvedPrior = exactKeyIssues.find(
      (i) => i.state === 'resolved' && i.terminalOwner === WATCHDOG_AUTO_CLOSE_OWNER,
    );
    if (!checkOnly && autoResolvedPrior) {
      // Stale-lookback rail (same shape as the D-002 stale-evidence verdict): a
      // recurrence whose newest evidence pre-dates the row's resolution is
      // collector lookback junk — resurrecting a resolved row on it would be a
      // false reopen. Absent/unparseable timestamps fail open (fresh), mirroring
      // the verdict rail's own fail-open.
      const evidenceMs = input.evidenceAt ? Date.parse(input.evidenceAt) : Number.NaN;
      const resolvedMs = Date.parse(autoResolvedPrior.updatedAt ?? '');
      const staleLookback = Number.isFinite(evidenceMs) && Number.isFinite(resolvedMs) && resolvedMs >= evidenceMs;
      if (!staleLookback) {
        const reopened = await (deps.setWorkItemStateWithAliasInfo ?? defaultSetWorkItemStateWithAliasInfo)(
          autoResolvedPrior.id,
          'open',
          {
            harness: harnessFromScope(autoResolvedPrior.scope) ?? undefined,
            by: input.createdBy ?? 'capture-recurrence-reopen',
            reason: `exact-key recurrence of \`${input.watchdogKey}\` after watchdog auto-resolve (P-004)`,
          },
        ).catch(() => null);
        // A failed reopen falls through to the ordinary nets (mint-with-verdict):
        // losing the filing to protect the fold would be the silencing D-001/D-003 forbid.
        if (reopened?.workItem && (reopened.appliedState ?? reopened.workItem.state) === 'open') {
          const priorPayload = (autoResolvedPrior.payload as Record<string, unknown> | null) ?? {};
          const repeatCount = (typeof priorPayload.repeatCount === 'number' ? priorPayload.repeatCount : 1) + 1;
          const nowIso = new Date().toISOString();
          const mergePatch: Record<string, unknown> = {
            watchdogKey: input.watchdogKey,
            repeatCount,
            lastSeenAt: nowIso,
            // Resolver-facing marker (D-003: persist what detection finds): this row
            // was reopened by an exact-key recurrence after a watchdog auto-resolve.
            recurrenceReopen: {
              at: nowIso,
              key: input.watchdogKey,
              priorResolvedAt: autoResolvedPrior.closedAt ?? autoResolvedPrior.updatedAt ?? null,
            },
          };
          if (input.paths?.length) mergePatch.paths = input.paths;
          if (input.payloadExtra) Object.assign(mergePatch, input.payloadExtra);
          if (input.filedByRole) mergePatch.filedByRole = input.filedByRole;
          if (sourceRole !== 'human') mergePatch.sourceRole = sourceRole;
          const merged = await (deps.mergeIssuePayload ?? mergeIssuePayload)(autoResolvedPrior.id, mergePatch).catch(
            () => null,
          );
          const refreshed = await (deps.updateIssuePatch ?? updateIssue)(autoResolvedPrior.id, {
            title: input.title,
            body: input.body,
            silent: true,
            confirmShrink: true,
          }).catch(() => null);
          const finalIssue = (refreshed && 'id' in refreshed ? refreshed : merged) ?? autoResolvedPrior;
          await appendCaptureOccurrence(
            deps,
            input,
            identity,
            'coalesced',
            finalIssue.id,
            [],
            skippedDedupCoverage,
            harnessFromScope(finalIssue.scope),
          );
          const bodyPersisted = refreshed !== null && 'id' in (refreshed as object);
          return {
            ok: true,
            created: false,
            reason: 'coalesced',
            coalescedOnto: buildCoalesceEffect({
              finalIssue,
              prior: autoResolvedPrior,
              input,
              repeatCount,
              bodyPersisted,
              reopened: true,
            }),
            kind: finalIssue.kind as 'bug' | 'change',
            improvementKind: input.kind,
            // The lifecycle writer above flipped the state; the payload/text reads
            // may carry a pre-flip snapshot, so state the post-reopen truth.
            issue: { ...finalIssue, state: 'open' },
            topics: [
              IMPROVEMENT_TOPIC,
              ...(input.subTopic ? [input.subTopic] : []),
              ...(sourceRole !== 'human' ? [`improvement-source:${sourceRole}`] : []),
            ],
            possibleDuplicates: [],
            dedupCoverage: skippedDedupCoverage,
          };
        }
      }
    }
  }
  // Observations skip the dedup search entirely (D-005): recurrence IS the signal
  // Scout clusters downstream, and the reflecting agent is told not to dedup — so a
  // recurring observation re-files without a duplicate verdict.
  let lexicalLeg: DedupCoverage['lexical'] = isObservation ? 'skipped' : 'unavailable';
  let searched: EngineerIssue[] = [];
  if (!isObservation) {
    const lexical = await withBoundedTimeout(() => Promise.resolve().then(() => deps.searchIssues(input.title, 20)), {
      fallback: [] as EngineerIssue[],
      timeoutMs: CAPTURE_LEXICAL_SEARCH_BUDGET_MS,
      label: 'captureImprovement:lexical-dedup',
    });
    searched = lexical.value;
    if (!lexical.degraded) lexicalLeg = 'ok';
    // Preserve an empty candidate set, but never mislabel a timed-out or failed
    // search as a clean lexical verdict. DRAIN consumes this bit as a fail-closed gate.
  }
  const candidates = searched.filter((i) => effectiveOrigin(i.signalOrigin) === origin);

  // P-011 (shared-embedding-sidecar-and-enrichment-2026-07-10): semantic
  // candidate WIDENING. The lexical searchIssues + titleSimilarity net misses
  // a differently-worded refile of the same friction (the P-008 dupe-storm
  // class). Improvements ARE work-items, so the migration-551 vectors already
  // cover them: cosine-band the capture via the shared work-item dupe guard,
  // hydrate the hits into full EngineerIssues, and let them ride the SAME
  // origin / watchdogKey / dedupScope / alreadyDecided rails as lexical
  // candidates. Fail-open (null verdict ⇒ lexical-only) and vitest-inert via
  // the guard itself. A 'hard' hit may carry the verdict annotation; 'soft' is
  // advisory-only (surfaced, never contributes to the verdict).
  const semanticBand = new Map<string, { similarity: number; band: 'hard' | 'soft' }>();
  // P-007: track whether the embedding leg actually produced a verdict. It fails OPEN
  // (null on timeout / embedder down / disabled), so without this the caller cannot tell
  // a checked-clean [] from a could-not-check [].
  let semanticLeg: DedupCoverage['semantic'] = isObservation ? 'skipped' : 'unavailable';
  if (!isObservation) {
    try {
      const sem = await (deps.findSemanticDupes ?? findSemanticDupes)({
        title: input.title,
        ...(input.body ? { summary: input.body } : {}),
      });
      if (sem) {
        semanticLeg = 'ok';
        for (const band of ['hard', 'soft'] as const) {
          for (const c of sem[band])
            if (!semanticBand.has(c.id)) semanticBand.set(c.id, { similarity: c.similarity, band });
        }
        const known = new Set(candidates.map((i) => i.id));
        const fetchIssue = deps.getIssue ?? getIssue;
        for (const id of [...semanticBand.keys()].filter((i) => !known.has(i)).slice(0, 6)) {
          const issue = await fetchIssue(id).catch(() => null);
          if (issue && effectiveOrigin(issue.signalOrigin) === origin) candidates.push(issue);
          else semanticBand.delete(id);
        }
      }
    } catch {
      /* fail-open: the lexical verdict stands */
    }
  }

  // EI-20484430331973864: fold the exact-key hits into the candidate set so they ride the
  // SAME possibleDuplicates → blockEligible → compatible rails as lexical/semantic hits,
  // instead of being a side-lookup only the probation path could see. Origin-filtered like
  // the lexical leg deliberately: the red-queen DRILL leg files this very title under
  // origin='drill' in a sandbox scope, and a drill row must never suppress a real organic
  // outage filing.
  const exactKeyIds = new Set<string>();
  if (exactKeyIssues.length > 0) {
    const known = new Set(candidates.map((i) => i.id));
    for (const issue of exactKeyIssues) {
      if (effectiveOrigin(issue.signalOrigin) !== origin) continue;
      exactKeyIds.add(issue.id);
      if (!known.has(issue.id)) candidates.push(issue);
    }
  }

  // P-013: a direct-evidence re-report can carry a different message
  // fingerprint (and therefore a different watchdogKey) from the original
  // probation report. When the caller's title is exactly the same, promote the
  // existing probation row in place instead of letting the key-aware dedup net
  // treat the two fingerprints as distinct work. The exact-title + probation
  // + origin/scope rails keep this fallback narrower than ordinary fuzzy dedup.
  if (!isObservation && incomingProbation?.state === 'promoted') {
    const exactTitleProbation = candidates.find((candidate) => {
      const payload = (candidate.payload as Record<string, unknown> | null) ?? {};
      return (
        candidate.state === 'open' &&
        candidate.title === input.title &&
        issueWatchdogLane(candidate) === 'observation' &&
        toolFailureProbationOf(payload)?.state === 'probation' &&
        compatibleToolFailureClassIdentity(candidate, incomingProbation) &&
        effectiveOrigin(candidate.signalOrigin) === origin &&
        issueScopeMatchesCapture(candidate, input.scope)
      );
    });
    if (exactTitleProbation) {
      const promoted = await promoteToolFailureProbation(exactTitleProbation, input, deps, candidates);
      if (promoted) {
        await appendCaptureOccurrence(
          deps,
          input,
          identity,
          'promoted',
          promoted.id,
          [],
          skippedDedupCoverage,
          harnessFromScope(promoted.scope),
        );
        return {
          ok: true,
          created: false,
          reason: 'promoted',
          kind: promoted.kind as 'bug' | 'change',
          improvementKind: input.kind,
          issue: promoted,
          topics: [IMPROVEMENT_TOPIC, ...(input.subTopic ? [input.subTopic] : [])],
          possibleDuplicates: [],
          dedupCoverage: skippedDedupCoverage,
        };
      }
    }
  }

  const possibleDuplicates: PossibleDuplicate[] = candidates
    .map((i) => {
      const lexical = Math.round(titleSimilarity(input.title, i.title) * 100) / 100;
      const sem = semanticBand.get(i.id);
      // A candidate the lexical net already catches keeps its lexical score and
      // blocking behavior; the semantic flag marks ONLY net-new semantic catches.
      const semanticOnly = sem && lexical < DUP_THRESHOLD;
      // P-007: CONTAINMENT is the third net, and it marks ONLY net-new catches — a
      // candidate already caught lexically or semantically keeps its existing score and
      // behavior, so this can never re-label an existing hit.
      const containment = Math.round(titleContainment(input.title, i.title) * 100) / 100;
      const containmentOnly = !semanticOnly && lexical < DUP_THRESHOLD && containment >= CONTAINMENT_THRESHOLD;
      return {
        id: i.id,
        title: i.title,
        state: i.state,
        severity: i.severity,
        similarity: semanticOnly ? Math.round(sem.similarity * 100) / 100 : containmentOnly ? containment : lexical,
        ...(semanticOnly ? { semantic: sem.band } : {}),
        ...(containmentOnly ? { lexical: 'containment' as const } : {}),
        ...(exactKeyIds.has(i.id) ? { exactKey: true as const } : {}),
      };
    })
    // An exact watchdogKey match survives regardless of how its TITLE scored — that is the
    // entire point of carrying a key — and sorts FIRST so the top-5 slice can never drop a
    // definitional duplicate in favour of five fuzzy ones.
    .filter(
      (d) =>
        d.exactKey === true || d.similarity >= DUP_THRESHOLD || d.semantic !== undefined || d.lexical !== undefined,
    )
    .sort((a, b) => Number(b.exactKey === true) - Number(a.exactKey === true) || b.similarity - a.similarity)
    .slice(0, 5);

  const dedupCoverage: DedupCoverage = {
    lexical: lexicalLeg,
    semantic: semanticLeg,
    degraded:
      lexicalLeg === 'unavailable' || semanticLeg === 'unavailable' || exactKeyLookupFailed || classKeyLookupFailed,
  };

  // "Already decided" recall (P-003): signature-match this capture against the
  // PRIOR resolved/closed items so a settled friction is recognised before it
  // re-enters the queue. Reads the stable signature (not raw title) via the shared
  // matcher. Recall, not a gate — surfaced even when we create.
  const alreadyDecided = recallAlreadyDecided(input.title, candidates.map(issueToCandidate), {
    excludeId: undefined,
  });

  if (checkOnly) {
    return {
      ok: true,
      created: false,
      reason: 'check-only',
      possibleDuplicates,
      dedupCoverage,
      admissionIdentity: identity,
      hint: input.body
        ? 'Dedup results apply to this exact title and body. If the body will change before filing, rerun checkDuplicatesOnly with the final body because semantic matches can change.'
        : 'This was a title-only pre-check. A final body can surface additional semantic duplicates, so rerun checkDuplicatesOnly with the final body before treating an empty result as clean.',
      ...(alreadyDecided.length ? { alreadyDecided } : {}),
    };
  }
  // Key-aware title net (watchdog-audit P-004 / D-001): a candidate carrying a
  // DIFFERENT watchdogKey is a different signal — nested-path red-test titles
  // token-subset each other and used to false-classify. A candidate WITHOUT a key
  // stays in the net (legacy items + agent captures).
  const candidateById = new Map(candidates.map((i) => [i.id, i]));
  const candidateKeyOf = (id: string): string | null => {
    const p = candidateById.get(id)?.payload;
    const k = p && typeof p === 'object' ? (p as Record<string, unknown>).watchdogKey : undefined;
    return typeof k === 'string' ? k : null;
  };

  // ─── P-004: keyless non-observation titleKey fold ─────────────────────────────
  // A recurring non-observation capture that supplies no watchdogKey has NO
  // recurrence identity: the keyed tiers above cannot see it, and the derived
  // fold (D-042) is observation-lane-only — so every re-detection minted an open
  // sibling. An exact normalized-titleKey match is not a guess (the WI-39594
  // reasoning: exact identity needs no carve-outs), so fold the re-detection onto
  // the open canonical row — occurrence appended, repeatCount bumped, text
  // refreshed to the newest reading. Scoped narrowly: non-observation, no key
  // supplied, not forced — observations keep their own recurrence paths and
  // force:true preserves the caller's assertion of distinctness.
  if (!isObservation && !input.watchdogKey && !input.force) {
    const titleTwins = candidates.filter(
      (i) =>
        i.state === 'open' &&
        issueWatchdogLane(i) !== 'observation' &&
        issueScopeMatchesCapture(i, input.scope) &&
        admissionIdentity(i.title).titleKey === identity.titleKey,
    );
    if (titleTwins.length > 0) {
      const canonical = selectCanonicalIssue(
        identity,
        titleTwins.map((i) => ({
          id: i.id,
          title: i.title,
          canonicalHarness: harnessFromScope(i.scope),
          eligible: true,
          similarity: 1,
        })),
      );
      const prior = canonical ? candidateById.get(canonical.id) : undefined;
      if (prior) {
        // A failed fold mints instead (D-003: the filing always lands) — same
        // tolerance as the derived fold's merge failure, unlike the keyed path
        // whose identity is caller-asserted.
        const folded = await (async () => {
          const priorPayload = (prior.payload as Record<string, unknown> | null) ?? {};
          const repeatCount = (typeof priorPayload.repeatCount === 'number' ? priorPayload.repeatCount : 1) + 1;
          const mergePatch: Record<string, unknown> = {
            repeatCount,
            lastSeenAt: new Date().toISOString(),
          };
          if (input.paths?.length) mergePatch.paths = input.paths;
          if (input.payloadExtra) Object.assign(mergePatch, input.payloadExtra);
          if (input.filedByRole) mergePatch.filedByRole = input.filedByRole;
          if (sourceRole !== 'human') mergePatch.sourceRole = sourceRole;
          const merged = await (deps.mergeIssuePayload ?? mergeIssuePayload)(prior.id, mergePatch);
          const refreshed = await (deps.updateIssuePatch ?? updateIssue)(prior.id, {
            title: input.title,
            body: input.body,
            silent: true,
            confirmShrink: true,
          }).catch(() => null);
          return { merged, refreshed, repeatCount };
        })().catch(() => null);
        if (folded?.merged) {
          const { merged, refreshed, repeatCount } = folded;
          const finalIssue = (refreshed && 'id' in refreshed ? refreshed : merged) ?? prior;
          await appendCaptureOccurrence(
            deps,
            input,
            identity,
            'coalesced',
            finalIssue.id,
            possibleDuplicates,
            dedupCoverage,
            harnessFromScope(finalIssue.scope),
          );
          const bodyPersisted = refreshed !== null && 'id' in (refreshed as object);
          return {
            ok: true,
            created: false,
            reason: 'coalesced',
            coalescedOnto: buildCoalesceEffect({
              finalIssue,
              prior,
              input,
              repeatCount,
              bodyPersisted,
              identityRoute: 'title-key',
            }),
            kind: finalIssue.kind as 'bug' | 'change',
            improvementKind: input.kind,
            issue: finalIssue,
            topics: [
              IMPROVEMENT_TOPIC,
              ...(input.subTopic ? [input.subTopic] : []),
              ...(sourceRole !== 'human' ? [`improvement-source:${sourceRole}`] : []),
            ],
            possibleDuplicates,
            dedupCoverage,
            ...(alreadyDecided.length ? { alreadyDecided } : {}),
          };
        }
      }
    }
  }
  // P-011: a soft semantic hit is advisory-only — visible in possibleDuplicates,
  // never eligible to carry the dedup verdict (mirrors the create-time work-item
  // guard's soft band → similarOpen contract).
  // P-007: a CONTAINMENT hit is advisory-only, exactly like a soft semantic hit. Widening
  // the surfacing net is cheap (you see one more candidate); widening the BLOCKING net
  // trades a missed duplicate for a LOST filing, which is the more expensive failure —
  // and containment is asymmetric, so a broad stored title covers many narrow real ones.
  // `semanticBlockBand:'soft'` (Scout's port only — see the option's doc) opts INTO
  // letting a soft hit carry the verdict. Containment stays advisory in BOTH modes: it is
  // asymmetric (a broad stored title covers many narrow real ones), so it is not a
  // similarity band and widening it would not be the same trade.
  const softMayBlock = input.semanticBlockBand === 'soft';
  const blockEligible = possibleDuplicates.filter(
    // EI-20484430331973864: an exact watchdogKey match is block-eligible UNCONDITIONALLY.
    // The soft-semantic and containment carve-outs exist because those nets GUESS at
    // identity, and a wrong guess costs a lost filing. An exact key is not a guess, so
    // neither carve-out applies to it.
    (d) => d.exactKey === true || ((softMayBlock || d.semantic !== 'soft') && d.lexical !== 'containment'),
  );
  const compatible = input.watchdogKey
    ? blockEligible.filter((d) => {
        const ck = candidateKeyOf(d.id);
        return ck == null || ck === input.watchdogKey;
      })
    : blockEligible;

  let blockingDuplicates: PossibleDuplicate[];
  let declineReason: 'likely-duplicate' | 'stale-evidence' = 'likely-duplicate';
  if (input.dedupScope === 'open') {
    blockingDuplicates = compatible.filter((d) => d.state === 'open');
    if (blockingDuplicates.length === 0 && input.evidenceAt) {
      // P-005 / D-002 (verdict retained under P-002): a RESOLVED dup's re-file is
      // a real regression only on evidence NEWER than the resolution. Collector
      // lookback windows still contain pre-fix rows; when the newest evidence
      // pre-dates the dup's resolution that is stale lookback evidence — since
      // P-002 it files anyway (D-001) and the verdict rides payload.dedupVerdict
      // so the central resolver can tell a regression-refile from stale junk.
      // Unparseable timestamps fail open (no stale verdict).
      const evidenceMs = Date.parse(input.evidenceAt);
      const staleResolved = compatible.filter((d) => {
        if (d.state === 'open') return false;
        const resolvedMs = Date.parse(candidateById.get(d.id)?.updatedAt ?? '');
        return Number.isFinite(evidenceMs) && Number.isFinite(resolvedMs) && resolvedMs >= evidenceMs;
      });
      if (staleResolved.length > 0) {
        blockingDuplicates = staleResolved;
        declineReason = 'stale-evidence';
      }
    }
  } else {
    blockingDuplicates = compatible;
  }
  // P-002 (silent-intake-central-resolution-2026-09-01, D-001): every filing is
  // accepted — the search-first decline that used to return created:false here is
  // retired, and its 'duplicate' occurrence append with it (the created row IS the
  // record). The classification above still runs so the file-time verdict survives
  // on the created row (payload.dedupVerdict at the mint below): the central
  // resolver ranks and merges; the filer carries no dup-investigation burden.
  // force still short-circuits the verdict: the caller asserted distinctness.
  const dedupVerdict: 'likely-duplicate' | 'stale-evidence' | undefined =
    blockingDuplicates.length > 0 && !input.force ? declineReason : undefined;

  // P-005: during a concentrated low-diversity burst, an advisory SOFT semantic
  // sibling becomes a safe occurrence home instead of allowing another canonical
  // row into the scheduler. Containment-only hits stay ineligible: a broad title
  // can cover a genuinely novel narrow finding. No candidate and critical severity
  // both pass, so the circuit cannot swallow critical novelty. The pressure read is
  // fail-open and exact/uncapped; every coalesce appends the complete report below.
  let queueAdmission: IssueAdmissionPressure | undefined;
  const burstCandidates = possibleDuplicates.filter((candidate) => {
    if (candidate.semantic !== 'soft' || candidate.state !== 'open') return false;
    if (!input.watchdogKey) return true;
    const candidateKey = candidateKeyOf(candidate.id);
    return candidateKey == null || candidateKey === input.watchdogKey;
  });
  if (!input.force && input.severity !== 'critical' && burstCandidates.length > 0) {
    const pressureCandidate = selectCanonicalIssue(
      identity,
      burstCandidates.map((candidate) => ({
        id: candidate.id,
        title: candidate.title,
        similarity: candidate.similarity,
        canonicalHarness: harnessFromScope(candidateById.get(candidate.id)?.scope),
        eligible: true,
      })),
    );
    if (pressureCandidate) {
      queueAdmission =
        (await (deps.readIssueAdmissionPressure ?? readIssueAdmissionPressure)({
          canonicalId: pressureCandidate.id,
          canonicalHarness: pressureCandidate.canonicalHarness,
        }).catch(() => null)) ?? undefined;
      const decision = decideIssueAdmissionCircuit({
        identity,
        candidates: burstCandidates.map((candidate) => ({
          id: candidate.id,
          title: candidate.title,
          similarity: candidate.similarity,
          canonicalHarness: harnessFromScope(candidateById.get(candidate.id)?.scope),
          eligible: true,
        })),
        pressure: queueAdmission ?? null,
        severity: input.severity,
        force: input.force,
      });
      if (decision.action === 'coalesce' && decision.canonical) {
        const canonicalIssue = candidateById.get(decision.canonical.id);
        await appendCaptureOccurrence(
          deps,
          input,
          identity,
          'coalesced',
          decision.canonical.id,
          possibleDuplicates,
          dedupCoverage,
          harnessFromScope(canonicalIssue?.scope),
          queueAdmission,
        );
        return {
          ok: true,
          created: false,
          reason: 'coalesced',
          kind: canonicalIssue?.kind as 'bug' | 'change' | undefined,
          improvementKind: input.kind,
          ...(canonicalIssue ? { issue: canonicalIssue } : {}),
          possibleDuplicates,
          dedupCoverage,
          admissionIdentity: identity,
          queueAdmission,
          ...(alreadyDecided.length ? { alreadyDecided } : {}),
          hint:
            `Low-diversity admission burst: preserved this report as an occurrence on ${decision.canonical.id}; ` +
            'no new scheduler row was created.',
        };
      }
    }
  }

  // P-002 (silent-intake-central-resolution-2026-09-01, D-001): the DRAIN
  // degraded-coverage veto (WI-38403's DedupCoverageUnavailableError throw) is
  // retired — a bug filed on an unmeasured dedup path files anyway. The
  // degradation is already stamped unconditionally on the row
  // (payload.dedupCoverage below, EI-20275452450016416), which is where the
  // central resolver reads it.

  // Per-Hive topic lens (P-010): add sourceRole to topics when it differs from default.
  // Observations file the DISTINCT OBSERVATION_TOPIC lane (D-005) so they stay out of
  // the work/triage pipeline by construction — no topic:IMPROVEMENT_TOPIC reader sees them.
  const baseTopic = isObservation ? OBSERVATION_TOPIC : IMPROVEMENT_TOPIC;
  const topics = [baseTopic, ...(input.subTopic ? [input.subTopic] : [])];
  if (sourceRole !== 'human') {
    topics.push(`improvement-source:${sourceRole}`);
  }

  // EI-15448: an observation capture carrying a stable `watchdogKey` COALESCES onto
  // its existing OPEN row (bump repeatCount, refresh lastSeenAt + title/body) instead
  // of minting a fresh row every call — observations otherwise skip dedup entirely by
  // design (recurrence IS the signal Scout clusters, `isObservation` branch below), so
  // a repeat reading of an unresolved condition (e.g. the Kettle's escalation-aging
  // drift) self-inflated the backlog to 7k+ near-identical open items. A caller that
  // omits the key keeps the original always-re-file behavior — correct for a genuinely
  // novel/one-off reading.
  if (isObservation && input.watchdogKey) {
    const priorHits = await (deps.findIssuesByWatchdogKeys ?? findIssuesByWatchdogKeys)([input.watchdogKey]).catch(
      () => [] as EngineerIssue[],
    );
    const prior = priorHits.find(
      (i) =>
        i.state === 'open' &&
        (i.payload as Record<string, unknown> | undefined)?.lane === 'observation' &&
        compatibleToolFailureClassIdentity(i, incomingProbation) &&
        sameWatchdogIdentity(i, input, origin),
    );
    if (prior) {
      const priorPayload = (prior.payload as Record<string, unknown>) ?? {};
      const priorProbation = toolFailureProbationOf(priorPayload);
      const incomingProbation = toolFailureProbationOf(input.payloadExtra ?? {});
      const priorReporters = Array.isArray(priorProbation?.reporters) ? priorProbation.reporters : [];
      const incomingReporters = Array.isArray(incomingProbation?.reporters) ? incomingProbation.reporters : [];
      const reporters = [
        ...new Set([...priorReporters, ...incomingReporters, ...(input.createdBy ? [input.createdBy] : [])]),
      ];
      const independentReporter = reporters.some((r) => !priorReporters.includes(r));
      if (
        priorProbation?.state === 'probation' &&
        incomingProbation &&
        priorReporters.length > 0 &&
        independentReporter
      ) {
        const promoted = await promoteToolFailureProbation(prior, input, deps, priorHits);
        if (promoted) {
          await appendCaptureOccurrence(
            deps,
            input,
            identity,
            'promoted',
            promoted.id,
            possibleDuplicates,
            dedupCoverage,
            harnessFromScope(promoted.scope),
          );
          return {
            ok: true,
            created: false,
            reason: 'promoted',
            kind: promoted.kind as 'bug' | 'change',
            improvementKind: input.kind,
            issue: promoted,
            topics: [IMPROVEMENT_TOPIC, ...(input.subTopic ? [input.subTopic] : [])],
            possibleDuplicates,
            dedupCoverage,
            ...(alreadyDecided.length ? { alreadyDecided } : {}),
          };
        }
      }
      const repeatCount = (typeof priorPayload.repeatCount === 'number' ? priorPayload.repeatCount : 1) + 1;
      const mergePatch: Record<string, unknown> = {
        watchdogKey: input.watchdogKey,
        repeatCount,
        lastSeenAt: new Date().toISOString(),
      };
      if (input.payloadExtra) Object.assign(mergePatch, input.payloadExtra);
      if (priorProbation && incomingProbation) {
        mergePatch.toolFailureProbation = {
          ...priorProbation,
          ...incomingProbation,
          reporters,
          lastSeenAt: new Date().toISOString(),
        };
      }
      if (input.filedByRole) mergePatch.filedByRole = input.filedByRole;
      if (sourceRole !== 'human') mergePatch.sourceRole = sourceRole;
      const merged = await (deps.mergeIssuePayload ?? mergeIssuePayload)(prior.id, mergePatch);
      // Best-effort title/body refresh — never blocks the coalesce (a shrink-guard
      // trip or transient error just keeps the prior text; the payload bump above is
      // the load-bearing part). Silent: a routine status refresh shouldn't fan out
      // subscriber notifications every wake.
      const refreshed = inferredShellRefusalKey ? null : await (deps.updateIssuePatch ?? updateIssue)(prior.id, {
        title: input.title,
        body: input.body,
        silent: true,
        confirmShrink: true,
      }).catch(() => null);
      const finalIssue = (refreshed && 'id' in refreshed ? refreshed : merged) ?? prior;
      await appendCaptureOccurrence(
        deps,
        input,
        identity,
        'coalesced',
        finalIssue.id,
        possibleDuplicates,
        dedupCoverage,
        harnessFromScope(finalIssue.scope),
      );
      // P-006/D-004: report what this write actually DID, not merely that it ran.
      // `refreshed` is null exactly when the title/body update above failed (its
      // `.catch`), which is the case where the caller's prose was dropped while
      // the call still returned ok — the silent write-loss this item exists for.
      const bodyPersisted = refreshed !== null && 'id' in (refreshed as object);
      const coalescedOnto: CoalesceEffect = buildCoalesceEffect({
        finalIssue,
        prior,
        input,
        repeatCount,
        bodyPersisted,
        ...(inferredShellRefusalKey ? { identityRoute: 'derived' as const, textDisposition: 'append-only' as const } : {}),
      });
      return {
        ok: true,
        created: false,
        reason: 'coalesced',
        coalescedOnto,
        kind: finalIssue.kind as 'bug' | 'change',
        improvementKind: input.kind,
        issue: finalIssue,
        topics,
        possibleDuplicates,
        dedupCoverage,
        ...(alreadyDecided.length ? { alreadyDecided } : {}),
      };
    }
  }

  // ─── P-013 (owner amendment D-042): DERIVED-identity fold for AGENT filings ───
  //
  // The keyed branch above covers callers that supply a stable conditionKey —
  // machine emitters, and it already works (5,491 keyed rows over 4,718 distinct
  // keys = 1.16 rows per condition). Agents filing by hand supply none, so
  // ~1,583 rows/day reached this point and minted unconditionally. This branch
  // gives those filings an identity DERIVED from content and folds a repeat onto
  // the row it repeats.
  //
  // Three dispositions, and NONE is a rejection — D-003's no-rejection half is
  // unweakened, and the classifier's return type has no 'reject' variant, so the
  // guarantee is structural rather than a comment a later edit can quietly break:
  //   hard → fold onto the survivor (repeatCount, reporter, occurrence appended)
  //   soft → MINT the row anyway, and link it
  //   none → mint cleanly
  // Every path below returns ok:true. The filing always lands.
  //
  // HARD is the semantic-dupe-guard CO-SIGNAL (cosine ≥ 0.86 AND pg_trgm title
  // ≥ 0.45), not a pure cosine cut, because on this corpus known-duplicates
  // (0.861–0.892) OVERLAP known-distinct pairs (0.857–0.868): no single cosine
  // threshold separates them, so a second independent signal has to.
  let softFold: { fold: FoldClassification; prior: EngineerIssue } | null = null;
  if (isObservation && !input.watchdogKey && !immutableScorecard) {
    // Fail-open on the flag read exactly like the classifier's own null: a flag
    // service blip must never change what happens to an agent's filing.
    const foldEnabled = await getFlag(FLAGS.OBSERVATION_DERIVED_FOLD, `observation-fold:${origin}`).catch(() => false);
    const derived = foldEnabled
      ? await classifyDerivedObservationFold({ input, origin, deps }).catch(() => null)
      : null;
    // `null` is NO VERDICT (flag off, embedder down, vitest-inert) — mint, as
    // before. It is NOT the same as verdict:'none', which is a measured "nothing
    // similar enough", and the two must not collapse into one branch.
    if (derived?.fold.verdict === 'hard' && derived.prior) {
      const prior = derived.prior;
      const priorPayload = (prior.payload as Record<string, unknown> | null) ?? {};
      const repeatCount = (typeof priorPayload.repeatCount === 'number' ? priorPayload.repeatCount : 1) + 1;
      // WHO has now reported this condition. The occurrence ledger holds the
      // per-filing detail; this list is what makes "two agents, one row" legible
      // on the row itself without a join.
      const priorReporters = Array.isArray(priorPayload.reporters)
        ? priorPayload.reporters.filter((r): r is string => typeof r === 'string')
        : [];
      const reporters = [...new Set([...priorReporters, ...(input.createdBy ? [input.createdBy] : [])])];
      const mergePatch: Record<string, unknown> = {
        repeatCount,
        lastSeenAt: new Date().toISOString(),
        reporters,
        // Provenance of the fold itself, so an over-merge is diagnosable from the
        // row and not only from a response nobody kept.
        derivedFold: {
          rule: derived.fold.rule,
          similarity: derived.fold.candidate?.similarity ?? null,
          at: new Date().toISOString(),
          by: input.createdBy ?? null,
        },
      };
      if (input.payloadExtra) Object.assign(mergePatch, input.payloadExtra);
      if (input.filedByRole) mergePatch.filedByRole = input.filedByRole;
      const merged = await (deps.mergeIssuePayload ?? mergeIssuePayload)(prior.id, mergePatch).catch(() => null);
      if (merged) {
        // NOTE the asymmetry with the keyed path, which refreshes title/body:
        // there, the caller PROVED the identity with a key. Here it was inferred,
        // so the reading is APPENDED (the occurrence below carries the full
        // title/body) and the survivor's own text is left alone. One wrong guess
        // must not be able to erase another agent's account of a problem.
        await appendCaptureOccurrence(
          deps,
          input,
          identity,
          'coalesced',
          merged.id,
          possibleDuplicates,
          dedupCoverage,
          harnessFromScope(merged.scope),
        );
        return {
          ok: true,
          created: false,
          reason: 'coalesced',
          coalescedOnto: buildCoalesceEffect({
            finalIssue: merged,
            prior,
            input,
            repeatCount,
            bodyPersisted: false,
            textDisposition: 'append-only',
            fold: derived.fold,
          }),
          kind: merged.kind as 'bug' | 'change',
          improvementKind: input.kind,
          issue: merged,
          topics,
          possibleDuplicates,
          dedupCoverage,
          ...(alreadyDecided.length ? { alreadyDecided } : {}),
        };
      }
      // The merge failed. Fall THROUGH to the mint below rather than returning an
      // error: a fold is an optimization, and losing the filing to protect it
      // would be exactly the silencing D-042 forbids.
    } else if (derived?.fold.verdict === 'soft' && derived.prior) {
      // Recorded now, applied after the row exists — the link needs both ids.
      softFold = { fold: derived.fold, prior: derived.prior };
    }
  }

  // Kind-specific payload: the 'feature' refinement + candidate paths (close-loop D-002) + sourceRole (P-010).
  const payload: Record<string, unknown> = {};
  if (isObservation) {
    // A PRE-IDEA sensor reading (D-005): mark the lane; carry no auto-implement
    // lifecycle / paths — it is never dispatchable. Structured fields ride payloadExtra.
    payload.lane = 'observation';
    // EI-15448: stamp the key on first filing too, so the NEXT repeat call's
    // findIssuesByWatchdogKeys lookup above actually finds this row.
    if (input.watchdogKey) payload.watchdogKey = input.watchdogKey;
  } else {
    if (input.kind === 'feature') payload.improvementKind = 'feature';
    if (input.paths?.length) payload.paths = input.paths;
    // Stable signal identity (watchdog-audit P-004 / D-001): the indexed cross-tick
    // dedup key the watchdog pre-filters against (findIssuesByWatchdogKeys).
    if (input.watchdogKey) payload.watchdogKey = input.watchdogKey;
    // Machine-readable finding class (frontier P-044/D-008) — the taxonomy slug
    // the triage/graduation rails route and count by.
    if (input.findingClass) payload.findingClass = input.findingClass;
    // Idea lifecycle starts at capture (self-learning P-031): open → triaged → applied
    // → verified/recurred. triage-core / resolve-core / the decay sweep advance it.
    payload.ideaLifecycle = initializeIdeaLifecycle();
    // Migration 1157's title arbiter intentionally ignores forced keyless rows:
    // `force:true` is the caller's assertion that this filing is distinct, so
    // persisting the normalized title identity here would make that assertion
    // collide with the shared keyless title singleton. Keyed force captures still
    // persist their stronger condition identity.
    if (!(input.force && !input.watchdogKey)) payload.admissionIdentity = identity;
    // EI-20275452450016416: persist the coverage the dedup ACTUALLY achieved. The
    // semantic leg fails OPEN, so a row filed while the embedder was load-shedding was
    // admitted without a differently-worded-duplicate check — and that was previously
    // reported to the caller and then discarded, leaving no way to find those rows
    // later. Degradation is load-correlated and so is filing volume, so blind filings
    // cluster exactly when the most rows are created.
    // Stamped UNCONDITIONALLY (not only when degraded) on purpose: presence of the key
    // is what separates "checked clean" from "unknown" — stamping only the degraded
    // rows would make absence mean either "checked" or "filed before this existed",
    // which is the same lost distinction the discard created.
    // Re-dedup work-list: payload->'dedupCoverage'->>'degraded' = 'true'.
    payload.dedupCoverage = dedupCoverage;
    // P-001 (silent-intake-central-resolution-2026-09-01, D-003): persist the file-time
    // CANDIDATES themselves, not only the coverage verdict above. possibleDuplicates
    // was computed, returned to the caller, and discarded (observed live on
    // EI-22068807981214694: 5 twins listed; the row carried none) — under silent intake
    // (D-001) the filer is not the consumer, the central resolver is, so the twins go
    // where the resolver reads. Non-empty only: dedupCoverage above already separates
    // "checked clean" from "could not check". Reaching this mint with candidates means
    // they were advisory (soft/containment) or force-overridden — either way they are
    // exactly the resolver's evidence.
    if (possibleDuplicates.length > 0) {
      payload.dedupCandidates = possibleDuplicates.map(
        (candidate): DedupCandidateStamp => ({
          id: candidate.id,
          similarity: candidate.similarity,
          method:
            candidate.exactKey === true
              ? 'exact-key'
              : candidate.semantic !== undefined
                ? candidate.semantic === 'hard'
                  ? 'semantic-hard'
                  : 'semantic-soft'
                : candidate.lexical === 'containment'
                  ? 'containment'
                  : 'lexical',
        }),
      );
    }
    // P-002 (D-001): the verdict the retired search-first decline would have
    // returned — 'likely-duplicate' (an open twin existed at file time) or
    // 'stale-evidence' (a resolved twin exists and the newest evidence pre-dates
    // its resolution). The verdict does not discard the filing: the admission
    // promoter judges it with the candidate state joined by id.
    if (dedupVerdict) payload.dedupVerdict = dedupVerdict;
  }
  // P-010 source-tag: track who filed this for per-Hive analytics
  if (sourceRole !== 'human') payload.sourceRole = sourceRole;
  // Filer-role attribution (close-observation-attribution-gap 2026-06-21): stamp the
  // caller's resolved fine role so per-role observation analytics group it instead of
  // bucketing 'unknown'. Stored for BOTH lanes — every capture has a filer worth
  // attributing. Read back by the OverwatchBrief observation panel (compute.ts).
  if (input.filedByRole) payload.filedByRole = input.filedByRole;
  // Structured-field seam (D-005): the observation's { kind, scope, confidence, refs }.
  if (input.payloadExtra) Object.assign(payload, input.payloadExtra);
  // P-004: every newly claimable capture enrolls in the shared readiness
  // contract. Observations stay outside the work queue and therefore carry no
  // implementation verdict. Existing immediate paths remain ready by policy;
  // change/feature captures awaiting peer review are explicitly unknown.
  if (!isObservation) payload.implementationReadiness = initialImplementationReadiness(reviewRequired);

  // EI-19450720466036446: generated Scout proposals must resolve their cited
  // work-items before those citations can be treated as incident evidence.
  // Keep capture fail-open (metadata records resolver failures); triage makes
  // the fresh place→gate decision from the live rows.
  if (!isObservation && sourceRole === 'Scout') {
    // WI-2147241: prefer the MIXED-family door so a feature-family `WI-`/`F-` citation is
    // not recorded as fabricated. The `getIssue` link keeps the pure unit fixtures (which
    // stub only the issue door) resolving exactly as before.
    const resolveCitation = deps.getCitedWorkItem ?? deps.getIssue;
    const citationHarness =
      typeof input.scope === 'string' && input.scope.startsWith('harness:')
        ? input.scope.slice('harness:'.length) || undefined
        : undefined;
    const evidenceIntegrity = await validateScoutEvidenceCitations(
      `${input.title}\n${input.body ?? ''}`,
      resolveCitation,
      citationHarness,
    );
    if (evidenceIntegrity) payload.evidenceIntegrity = evidenceIntegrity;
  }

  // Match work_items:create's filing-time bypasses. Every non-observation capture
  // is born behind admission unless critical, security-related, or explicitly
  // assigned. Review-required proposals keep their stronger review fence. This
  // makes dedup/freshness evidence visible to the promoter before self-pull,
  // without making a search outage or fuzzy match drop a filing.
  const admissionBypass: AdmissionBypassReason | null =
    isObservation || reviewRequired
      ? null
      : input.severity === 'critical'
        ? 'bypass:severity-critical'
        : topics.some((topic) => topic.trim().toLowerCase() === 'security')
          ? 'bypass:topic-security'
          : input.assignee?.trim()
            ? 'bypass:explicit-assignment'
            : null;
  const createInput: CreateIssueInput = {
    ...(input.artifactId ? { id: input.artifactId } : {}),
    title: input.title,
    kind: isObservation ? 'change' : storageKindOf(input.kind),
    body: input.body,
    severity: input.severity ?? (isObservation ? 'nit' : input.kind === 'bug' ? 'major' : 'minor'),
    scope: input.scope,
    topics,
    foundDuring: input.foundDuring,
    createdBy: input.createdBy,
    // WI-5950: atomic claim-on-file. An observation is a sensor reading, never claimable
    // work, so it never carries an assignee however the caller asked.
    ...(input.assignee && !isObservation ? { assignee: input.assignee, assignedBy: input.createdBy } : {}),
    source: input.source,
    signalOrigin: origin,
    payload: Object.keys(payload).length > 0 ? payload : undefined,
    // Admission is an INSERT-time fence: no born-to-promoter claim race. Legacy
    // NULL remains readable for old rows, but new work never depends on it.
    ...(!isObservation
      ? {
          admission: admissionBypass ? ('auto' as const) : ('pending' as const),
          ...(admissionBypass ? { admittedBy: admissionBypass } : {}),
        }
      : {}),
    // D-002/D-005 (observation-lane-scorecard-classification-2026-08-16): a
    // scorecards:emit verdict files already-terminal; everything else stays 'open'.
    ...(input.initialState ? { state: input.initialState } : {}),
  };

  let issue: EngineerIssue;
  try {
    issue = await acquireWithContentionRetry(() => deps.createIssue(createInput), {
      backoffsMs: CAPTURE_CONTENTION_BACKOFFS_MS,
    });
  } catch (error) {
    if (input.artifactId) {
      const winner = await readReservedArtifact();
      if (winner) return winner;
    }
    // The SELECT-before-INSERT exact-key path above is advisory.  Migration 865
    // is the authority under a race: recover ONLY its unique-index violation,
    // then re-read and require the complete identity before coalescing.  A
    // different 23505 (or a winner from another lane/Pot/origin) must remain a
    // visible failure rather than being silently turned into a duplicate merge.
    if (input.watchdogKey && isWatchdogIdentityConflict(error)) {
      const raced = await (deps.findIssuesByWatchdogKeys ?? findIssuesByWatchdogKeys)([input.watchdogKey]).catch(() => {
        throw error;
      });
      const winner = raced.find(
        (candidate) =>
          isWatchdogNonTerminal(candidate) &&
          sameWatchdogIdentity(candidate, input, origin) &&
          compatibleToolFailureClassIdentity(candidate, incomingProbation),
      );
      if (!winner) throw error;
      return coalesceWatchdogWinner({
        prior: winner,
        input,
        deps,
        identity,
        possibleDuplicates,
        dedupCoverage,
        topics,
        alreadyDecided,
        queueAdmission,
      });
    }
    // Migration 1157 is the authority for keyless non-observation captures. The
    // SELECT-before-INSERT title fold remains advisory, so a concurrent retry can
    // lose the INSERT to the partial title-key index even when both reads missed.
    // Re-read through the existing dedup search and coalesce only an exact persisted
    // titleKey/scope/lane/non-terminal winner; every other 23505 stays visible.
    if (!input.force && !input.watchdogKey && isKeylessTitleIdentityConflict(error)) {
      const raced = await deps.searchIssues(input.title, 20).catch(() => {
        throw error;
      });
      const winner = raced.find((candidate) => sameKeylessTitleIdentity(candidate, input, identity));
      if (!winner) throw error;
      return coalesceWatchdogWinner({
        prior: winner,
        input,
        deps,
        identity,
        possibleDuplicates,
        dedupCoverage,
        topics,
        alreadyDecided,
        queueAdmission,
        identityRoute: 'title-key',
      });
    }
    throw error;
  }
  let reviewState: 'blocked' | undefined;
  let agentReviewFailure: AgentReviewFailure | undefined;
  if (reviewRequired) {
    const at = new Date().toISOString();
    try {
      const parked = await (deps.setWorkItemStateWithAliasInfo ?? defaultSetWorkItemStateWithAliasInfo)(
        issue.id,
        'blocked',
        {
          ...(reviewHarness ? { harness: reviewHarness } : {}),
          ...(input.createdBy ? { by: input.createdBy } : {}),
          reason: 'agent-review enrollment pending',
        },
      );
      const appliedState = parked.appliedState ?? parked.workItem?.state;
      if (appliedState !== 'blocked') {
        throw new Error(`review park did not apply blocked state (appliedState=${appliedState ?? 'null'})`);
      }
      reviewState = 'blocked';
    } catch (error) {
      agentReviewFailure = { phase: 'block', message: reviewFailureMessage(error), at };
      await recordCaptureReviewFailure(
        issue.id,
        agentReviewFailure,
        { submittedBy: input.createdBy, harness: reviewHarness ?? undefined },
        deps,
      );
    }
  }
  await appendCaptureOccurrence(
    deps,
    input,
    identity,
    'canonical-created',
    issue.id,
    possibleDuplicates,
    dedupCoverage,
    harnessFromScope(issue.scope) ?? harnessFromScope(input.scope),
    queueAdmission,
  );
  // WI-20261780231648564: improvements:capture can atomically claim an item for the
  // current agent, but request-compaction's flush gate requires every same-turn claim
  // to have a successor-visible checkpoint. Seed a minimal handoff immediately after
  // the create; this is deliberately fail-open so a transient checkpoint-store failure
  // cannot turn a durable capture into a lost filing.
  if (input.assignee && !isObservation && deps.setCheckpoint) {
    await deps
      .setCheckpoint(
        issue.id,
        'Created and claimed by improvements:capture; no implementation work has started. ' +
          'Verify the title/body against current HEAD, then reproduce before editing.',
      )
      .catch(() => {});
  }
  // Push the right Learning-tab feed (operator-learning-tab-2026-06-09 P-002 /
  // observations P-044). Fire-and-forget via a lazy import so the pure, PG-free
  // capture core (+ its unit tests) never statically depend on the SSE layer.
  void trackDetached(
    import('../../sync-sse').then(async (m): Promise<void> => {
      if (isObservation) {
        await Promise.all([
          m.notifySyncInvalidate('learning.observations'),
          m.notifySyncInvalidate('learning.observations.summary'),
          m.notifySyncInvalidate('learning.observations.counts'),
        ]);
        return;
      }
      await Promise.all([
        m.notifySyncInvalidate('learning.improvements'),
        m.notifySyncInvalidate('learning.improvements.summary'),
      ]);
    }),
  ).catch(() => {});
  // Push-on-write for the Health tab's observations/improvements panels
  // (stop-discarded-dedup-and-audit-server-polling-2026-07-26 P-013 / D-007):
  // refresh the cached panel now instead of waiting up to 30s for the next
  // health tick to notice this write. Same lazy fire-and-forget discipline —
  // a cold health cache (or the flag off) makes this a safe no-op.
  void trackDetached(
    import('../../system-health/compute').then((m) =>
      m.refreshHealthPanel(isObservation ? 'observations' : 'improvements'),
    ),
  ).catch(() => {});
  // Calibration bet on flake-shaped signals (frontier P-041 / FB-13): filing a
  // flake IS the natural moment to bet on its recurrence. Same lazy
  // fire-and-forget discipline as above (the seam is flag-gated + never-throw
  // inside recordPrediction); origin rides along so a drill's bet stays
  // partitioned from organic scoring (D-002).
  const flakeKey = input.watchdogKey;
  if (flakeKey && isFlakeKey(flakeKey)) {
    const flakePredictor = input.createdBy ?? sourceRole;
    const flakeSubjectId = issue.id;
    void trackDetached(
      import('../../calibration/capture').then((m) =>
        m.recordPrediction({
          predictor: flakePredictor,
          domain: 'flake-recurrence',
          subjectKind: 'improvement',
          subjectId: flakeSubjectId,
          claim: `flake ${flakeKey} re-captures within the horizon`,
          watchdogKey: flakeKey,
          origin,
          // P-002 pot-scope: a 'harness:<slug>' scope names the owning-pot grain;
          // other scopes (operator/workspace-global) resolve via the env home pot.
          harnessSlug: input.scope?.startsWith('harness:') ? input.scope.slice('harness:'.length) : null,
        }),
      ),
    ).catch(() => {});
  }
  // Auto-ratify-on-first-scorecard (WI-5415): a scorecard just landed against
  // `observationForGate.rubricRef` — if that rubric is still `proposed`, grading it IS
  // adoption (owner ask 2026-07-19). Awaited (not fire-and-forget) so the ratification
  // is visible the moment this capture returns, but never lets a ratify failure fail
  // the scorecard write itself — the underlying function already never throws.
  if (isObservation && observationForGate?.rubricRef && input.createdBy) {
    await (deps.autoRatifyRubric ?? autoRatifyRubricOnFirstScorecard)(
      observationForGate.rubricRef,
      input.createdBy,
    ).catch(() => null);
  }

  // P-013 SOFT fold: the row was minted (both survive) — now record the
  // cross-reference. Best-effort: a link failure is REPORTED, never fatal. The
  // filing has already landed, and losing it to protect a cross-reference would
  // invert the priority D-042 sets.
  let linkedTo: FoldLinkEffect | undefined;
  if (softFold) {
    const { fold, prior } = softFold;
    const linkWritten = await (deps.linkIssues ?? defaultDeps.linkIssues!)(
      issue.id,
      prior.id,
      'relates',
      input.createdBy,
    )
      .then(() => true)
      .catch(() => false);
    linkedTo = {
      id: prior.id,
      similarity: fold.candidate?.similarity ?? 0,
      rule: fold.rule,
      linkWritten,
      note:
        fold.note +
        (linkWritten
          ? ''
          : ` ⚠ The cross-reference edge to ${prior.id} could NOT be written, so the two rows are ` +
            `related in fact but not in the graph — cite ${prior.id} by hand if that matters.`),
    };
  }

  // ── Goal provenance (WI-2140701 (b)) ─────────────────────────────────────
  // Stamp goal_id from the creator's SESSION CONTEXT, exactly as work_items:create
  // does. Until this leg existed every row minted through this door carried
  // goal_id NULL, so a goal steward's own filings were invisible to its goal's
  // "what belongs to me" view and spend rollup. A DECORATION: best-effort, and a
  // throw is RECORDED rather than raised — the row exists, and failing a capture
  // because provenance could not be written is worse than losing the attribution.
  // Only a NEW row is stamped: a coalesced/promoted prior row keeps whatever
  // attribution it already has (or none), so a re-capture by a goal agent can
  // never re-home somebody else's item.
  let goalStamp: string | undefined;
  let goalStampError: string | undefined;
  if (input.workspaceId && input.createdBy && deps.stampGoalProvenance) {
    try {
      const stamped = await deps.stampGoalProvenance(
        { id: issue.id, harness: harnessFromScope(issue.scope) ?? harnessFromScope(input.scope) },
        input.workspaceId,
        input.createdBy,
      );
      if (stamped) goalStamp = stamped;
    } catch (e) {
      goalStampError = e instanceof Error ? e.message : String(e);
      console.warn(`[improvements:capture] goal provenance stamp failed for ${issue.id}:`, goalStampError);
    }
  }

  return {
    ok: true,
    created: true,
    kind: issue.kind as 'bug' | 'change',
    improvementKind: input.kind,
    issue,
    topics,
    possibleDuplicates,
    dedupCoverage,
    ...(input.force && !input.watchdogKey ? {} : { admissionIdentity: identity }),
    ...(reviewRequired ? { reviewRequired: true } : {}),
    ...(reviewState ? { reviewState } : {}),
    ...(agentReviewFailure ? { agentReviewFailure } : {}),
    ...(linkedTo ? { linkedTo } : {}),
    ...(alreadyDecided.length ? { alreadyDecided } : {}),
    ...(goalStamp ? { goalId: goalStamp } : {}),
    ...(goalStampError ? { goalStampError } : {}),
  };
}
