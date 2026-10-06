/**
 * Scout loop — shared cross-step types (hive-creative-ideation-2026-06-08).
 *
 * The Scout loop is the Hive's generative-exploration engine — the "missing
 * third mode" of self-improvement (D-003): the deliberate creative *leap*
 * (analogy / reframing / recombination / first-principles) that the reactive
 * idea queue and the exploitative gym structurally cannot produce. Its cycle:
 *
 *   corpus synthesis (P-003) → divergent generation (P-004) → adversarial
 *   critics (P-005) → debate + recombine (P-006) → routing (P-007) →
 *   Queen-triage cadence (P-008).
 *
 * This module SEEDS the contract the steps hand each other. Per the lane split,
 * this file is seeded under P-004 and EXTENDED by P-005/P-006 (`Critique`,
 * `Proposal`), then consumed by P-007 + the verification lane.
 *
 * Two design rules carried from the plan's ratified decisions:
 *  - **Forced diversity (D-004):** divergence is structural, not a single
 *    "be creative" prompt — each ideator runs a *distinct* {@link CreativeLens}.
 *  - **Injected LLM (gym:judge pattern):** every Scout step takes a
 *    {@link ScoutLlmCall} so build → call → parse is unit-tested with a fake
 *    call (no network), exactly like `runGymJudge(args, { llmCall })`.
 */

// P-005/P-006 (su-d1170) extend this contract below; the pure critic spine lives
// in ./critique-core (Idea-shape-agnostic + reusable) and supplies these types.
import type { CorpusMatch, CritiqueVerdict } from './critique-core';

/**
 * The forced-diversity lens taxonomy (D-004). Each lens is a structurally
 * different generative stance so N ideators can't collapse to the median idea:
 *  - `analogical`        — map a distant domain's solution onto a Hive bottleneck.
 *  - `first-principles`  — derive the ideal mechanism from the goal, backward.
 *  - `reframing`         — find the real constraint nobody named (problem-finding).
 *  - `constraint-removal`— negate a load-bearing assumption; build what it blocked.
 */
export type CreativeLens = 'analogical' | 'first-principles' | 'reframing' | 'constraint-removal';

/** All lenses, in a stable order (the default ideator roster). */
export const CREATIVE_LENSES: readonly CreativeLens[] = [
  'analogical',
  'first-principles',
  'reframing',
  'constraint-removal',
] as const;

/**
 * The su IDEATE-pass lens vocabulary (su-ideate-learning-substrate-2026-07-10
 * P-002 / D-004): Scout's four creative lenses PLUS three stances shaped by how
 * an su session actually ideates (from lived friction inside the workspace, not
 * from a corpus digest). TYPE-ONLY vocabulary — the ledger's `lens` column is
 * text, and origin='su-ideate' rows never enter Scout's lens-weight learning
 * (D-002 origin partition), so widening costs no migration and cannot skew the
 * CreativeLens diversity floor. Per-su-lens win-rates are read-time (P-004).
 *  - `risk-first`    — start from the riskiest assumption in the current work;
 *                      ideate the thing that de-risks or falsifies it.
 *  - `user-value`    — start from what the owner/user concretely feels; work
 *                      backward from felt value to mechanism.
 *  - `cost-leverage` — find where a small change moves a large recurring cost
 *                      (time, tokens, toil) — the leverage-point stance.
 */
export type SuIdeationLens = CreativeLens | 'risk-first' | 'user-value' | 'cost-leverage';

/** All su ideation lenses, stable order (the CreativeLens roster first). */
export const SU_IDEATION_LENSES: readonly SuIdeationLens[] = [
  ...CREATIVE_LENSES,
  'risk-first',
  'user-value',
  'cost-leverage',
] as const;

/**
 * One meta-pattern category from the "state of the Hive" corpus digest. The four
 * friction lanes (P-003) plus `rubric-rating` — structured rubric measurements
 * grouped by rubric/source-hive (rubric-driven-observations-2026-06-20 P-006), so
 * the ideators leap from MEASUREMENTS, not just free-text clusters.
 */
export type MetaPatternCategory =
  | 'recurring-friction'
  | 'time-token-sink'
  | 'chronic-deferral'
  | 'capability-gap'
  | 'rubric-rating'
  // queen-memory-hybrid-2026-07-02 L1c: standing facts (agent_facts ledger) ride
  // the digest so ideation is grounded in the fleet's DETERMINISTIC conclusions.
  | 'standing-fact'
  // gym-unwedge-scout-novelty-2026-07-02 NOV-1: the QD archive's niche map —
  // occupied behavior-space niches (avoid duplicating) so generation actively
  // targets UNEXPLORED space (the quality-diversity novelty-search feedback).
  | 'niche-map'
  // blender-self-learning-2026-07-12 P-007: the watchdog's chronic collector
  // signals + standing open conditions — infrastructure pain measured every
  // 15min, fed to ideation directly instead of waiting for a human filing.
  | 'watchdog-health'
  | 'pty-host-health'
  | 'ci-test-health'
  | 'workspace-host-health'
  | 'system-health-flap'
  | 'rework-lesson'
  | 'browser-crash-health'
  // blender-self-learning-2026-07-12 P-010: the release pipeline's ship-path
  // health — standing gate reds + stall, promotion/deploy lag, and chronic
  // pipeline_events failure classes, JOINED into one incident (WI-4455).
  | 'gate-pipeline-health'
  // blender-self-learning-2026-07-12 P-008 / WI-4453: coordination breakdown —
  // re-mounting escalation storms, fleet-wide unanswered directed mail, per-
  // recipient inbox/wake floods, and claim conflicts, from coord_event_log.
  | 'coord-health'
  // blender-self-learning-2026-07-12 P-009 / WI-4454: measured tool DX friction —
  // per-tool error rates, arg-limit rejections, retry/batching-waste loops, and
  // chronic p95 latency, from tool_invocations.
  | 'tool-telemetry'
  // blender-self-learning-2026-07-12 P-011: cost-distribution anomalies the raw
  // time-token-sink lane cannot express (missing trigger attribution / extreme
  // trigger or role-class concentration).
  | 'spend-anomaly'
  // P-011: explicit owner correction signals — low owner grades + verified
  // owner-turn facts — so the next ideation cycle learns from correction, not
  // only from eventual artifact outcomes.
  | 'owner-correction'
  // P-011: repeated zero-hit knowledge demand + reusable recipes that aged out
  // after one run, exposing where the fleet keeps rediscovering instead of reusing.
  | 'knowledge-reuse-gap'
  // P-011: plan lifecycle coherence and stale planning backlog (separate from
  // the watchdog's already-covered stuck operational execution signal).
  | 'plan-health'
  // autonomous-loop-prod-audit-2026-07-02 NOV-2 / WI-4635: recent-commit churn
  // hotspots (repo-relative area rollup of recently-touched file paths) — an
  // EXOGENOUS entropy stimulus distinct from the tracked-completions view, so
  // ideation also sees where the tree is actively morphing right now even when
  // no work-item tracked the edit.
  | 'recent-commit';

/**
 * A grounded meta-pattern: a cross-corpus regularity (not a single capture),
 * carrying a `ref` back to the original (the rationale:feed / change-feed
 * pattern). The `ref` is also the attribution key P-013 uses to trace an
 * outcome back to the idea — and the lens — that produced it.
 *
 * `category` is optional so the digest's per-lane arrays (which need not repeat
 * the category on each row) are directly assignable; {@link flattenDigest}
 * stamps it when collapsing the digest into one list.
 */
export interface MetaPattern {
  /** Which corpus lane this came from (stamped by flattenDigest if absent). */
  category?: MetaPatternCategory;
  /** One-line meta-pattern (what recurs / where time goes / what's deferred / what's missing). */
  summary: string;
  /** Optional expansion or evidence. */
  detail?: string;
  /** Drill-back reference to the original record (e.g. "wi:F-012", "plan:slug"). */
  ref: string;
  /** Optional salience 0..1 (the digest's own ranking), to prime the ideators. */
  weight?: number;
}

/**
 * The "state of the Hive" digest (P-003 output) — the grounded substrate the
 * ideators read so their leaps are anchored to real Hive history, not invented.
 *
 * STRUCTURAL CONTRACT: this is the shape P-004 consumes. The production digest
 * is `StateOfHiveDigest` from `curation/state-of-pot` (su-7a8ee, P-003); when
 * it lands, the loop seam adapts it to this shape (the four ref-carrying
 * categories are the agreed contract). Kept here so P-004 is buildable +
 * testable independently of P-003's in-flight implementation.
 */
export interface CorpusDigest {
  recurringFriction: MetaPattern[];
  timeTokenSinks: MetaPattern[];
  chronicDeferrals: MetaPattern[];
  capabilityGaps: MetaPattern[];
  /**
   * Structured rubric-rating measurements grouped by rubric / source-hive
   * (rubric-driven-observations-2026-06-20 P-006). OPTIONAL so pre-rubric digests
   * and the 4-lane test fixtures stay valid CorpusDigests; {@link flattenDigest}
   * folds it in when present so the ideators ideate on MEASUREMENTS, not just
   * free-text clusters. Each pattern is one (rubric, source-hive, criterion)
   * standing; its `ref` (`rubric:<id>#<criterion>@<hive>`) is the drill-back.
   */
  rubricRatings?: MetaPattern[];
  /** STANDING FACTS (queen-memory-hybrid L1c) — live agent_facts (harness +
   *  workspace scopes) projected as patterns (`ref` = `fact:<scope>:<key>`) so
   *  the ideators leap from the fleet's deterministic conclusions too. OPTIONAL
   *  so pre-facts digests and fixtures stay valid. */
  standingFacts?: MetaPattern[];
  /** QD NICHE MAP (gym-unwedge NOV-1) — occupied gym_qd_archive niches
   *  (`ref` = `niche:<key>`) so the ideators steer AWAY from crowded
   *  behavior-space and toward unexplored (scope, domain, risk) combinations.
   *  OPTIONAL: populated by the cycle seam; absent = archive empty/unreadable. */
  nicheMap?: MetaPattern[];
  /** WATCHDOG HEALTH (blender-self-learning-2026-07-12 P-007) — chronic
   *  collector signals + standing open conditions from watchdog_ticks
   *  (`ref` = `watchdog:<collector>` / `watchdog:open:<key>`). OPTIONAL:
   *  populated by the cycle seam, like standingFacts / nicheMap. */
  watchdogHealth?: MetaPattern[];
  /** PTY host delivery failures and recovered retries from the existing
   *  per-owner event ingest. OPTIONAL: populated by the cycle seam. */
  ptyHostHealth?: MetaPattern[];
  /** Repeated CI file failures and clean, same-commit local-pass divergence
   * from test_runs. CI rows remain separate from local flakiness analytics. */
  ciTestHealth?: MetaPattern[];
  /** Managed workspace-host operation failures and later host recovery. */
  workspaceHostHealth?: MetaPattern[];
  /** Repeated critical health transitions and observed time back to OK. */
  systemHealthFlaps?: MetaPattern[];
  /** Cause-backed status regression lessons; bare flips stay in reverts only. */
  reworkLessons?: MetaPattern[];
  /** Redacted durable render-boundary crashes from the telemetry archive. */
  browserCrashHealth?: MetaPattern[];
  /** GATE / PIPELINE HEALTH (blender-self-learning-2026-07-12 P-010) — the
   *  release ship-path: standing gate reds + stall, promotion/deploy lag, and
   *  chronic pipeline_events failure classes, joined into one incident
   *  (`ref` = `pipeline:gate` / `pipeline:promotion-stall` /
   *  `pipeline:event:<kind>:<status>`). OPTIONAL: populated by the cycle seam,
   *  like watchdogHealth. */
  gatePipelineHealth?: MetaPattern[];
  /** COORD HEALTH (blender-self-learning-2026-07-12 P-008 / WI-4453) —
   *  coordination breakdown from coord_event_log: re-mounting escalation storms
   *  (leaking dedup gate), fleet-wide unanswered directed mail, per-recipient
   *  inbox/wake floods, and claim conflicts
   *  (`ref` = `coord:escalation-storm:<sig>` / `coord:unanswered` /
   *  `coord:wake-storm:<recipient>` / `coord:claim-conflict`). OPTIONAL:
   *  populated by the cycle seam, like watchdogHealth. */
  coordHealth?: MetaPattern[];
  /** TOOL TELEMETRY (blender-self-learning-2026-07-12 P-009 / WI-4454) — measured
   *  tool DX friction from tool_invocations: per-tool error rates, arg-limit
   *  rejections, retry/batching-waste loops, and chronic p95 latency
   *  (`ref` = `tool:error-rate:<tool>` / `tool:limit-failure:<tool>` /
   *  `tool:retry-loop:<tool>` / `tool:p95:<tool>`). OPTIONAL: populated by the
   *  cycle seam, like watchdogHealth. */
  toolTelemetry?: MetaPattern[];
  /** SPEND ANOMALIES (blender-self-learning-2026-07-12 P-011) — missing turn-
   *  trigger attribution and extreme trigger / role-class cost concentration
   *  (`ref` = `spend:attribution-gap` / `spend:*:concentration:*`). */
  spendAnomalies?: MetaPattern[];
  /** OWNER CORRECTIONS (P-011) — low owner grades and verified owner-turn facts
   *  (`ref` = `owner-correction:idea:*` / `owner-correction:fact:*`). */
  ownerCorrections?: MetaPattern[];
  /** KNOWLEDGE REUSE GAPS (P-011) — repeated zero-hit demand and stale one-run
   *  recipes (`ref` = `knowledge:search-miss:*` / `knowledge:recipe-reuse-gap`). */
  knowledgeReuseGaps?: MetaPattern[];
  /** PLAN HEALTH (P-011) — lifecycle/index drift, drained-but-unclosed plans,
   *  and stale draft/ready backlog (`ref` = `plan-health:*`). */
  planHealth?: MetaPattern[];
  /** RECENT-COMMIT CHURN (NOV-2 / WI-4635) — repo-area rollup of recently-touched
   *  file paths (`ref` = `commit-churn:<area>`), independent of whether any of that
   *  churn was tracked by a work-item. OPTIONAL: populated by the cycle seam
   *  (cycle-deps readCorpus), like watchdogHealth; absent on a non-git checkout or
   *  a git-read failure (fail-soft). */
  recentCommits?: MetaPattern[];
  /** DELTA-FIRST rendering substrate (blender-self-learning-2026-07-12 P-003 /
   *  WI-4319): the refs the PREVIOUS fired cycle's persisted digest snapshot
   *  carried (scout_digest_snapshots, migration 582). {@link renderDigest}
   *  leads with the patterns NOT in this set ("NEW since your last cycle")
   *  before the standing ones — killing the stale-repetition → dedup-decline
   *  churn. OPTIONAL: stamped by the cycle seam (cycle-deps readCorpus);
   *  absent ⇒ the legacy whole-digest rendering, byte-identical. */
  previousCycleRefs?: string[];
  /** DEDUP-BURN saturation stamp (blender-loop-repair-and-opus5-xhigh-2026-08-16
   *  P-007 / WI-39479): present when the dedup-burn guard found consecutive
   *  ran-cycles burning ≥ threshold of their ideas as duplicates (the 08-06/07
   *  428-burned→0-routed incident class). {@link renderDigest} then drops the
   *  standing patterns from the ideator prompt (fresh-signal-only when fresh
   *  signal exists) and leads with a saturation banner. OPTIONAL: stamped by
   *  the cycle seam (cycle-deps readCorpus); absent ⇒ unchanged rendering. */
  dedupSaturation?: { consecutiveSaturated: number; wideningSteps: number };
  /** Optional one-line "state of the Hive" headline. */
  headline?: string;
  /** ISO timestamp the digest was synthesized. */
  generatedAt?: string;
}

/**
 * A single divergent idea (P-004 output → P-005 critic input). `id` and `lens`
 * are assigned by the ideator code, never trusted from the model. The idea is
 * grounded by `addressesPatternRefs` (the digest patterns it targets) — the
 * hook for D-006 (bettable, not merely clever) and P-013 (outcome → lens).
 */
export interface Idea {
  id: string;
  lens: CreativeLens;
  /** One-line idea title. */
  title: string;
  /** The idea explained — what it is and why it could matter. */
  body: string;
  /** How it would work (the concrete mechanism — the anti-hand-wave field). */
  mechanism: string;
  /** For the analogical lens: the distant domain that primed it (e.g. 'immune-systems'). */
  seedDomain?: string;
  /**
   * Refs (into the corpus digest's MetaPattern.ref) the idea targets. Grounding
   * + attribution: empty means ungrounded (the novelty/feasibility critics weigh
   * this). Only refs that exist in the digest are kept.
   */
  addressesPatternRefs: string[];
  /**
   * Optional federated mutation seeds — foreign elites the idea adapted rather
   * than copied verbatim. These are NOT digest refs, so they do not participate
   * in grounding; they flow to routed provenance as `seededBy:<elite-ref>` tags.
   */
  seededByRefs?: string[];
}

/**
 * The injected LLM call — structurally identical to the gym's `JudgeLlmCall`
 * so the real `llmCall` (lib/llm-testing/llm-client) satisfies both,
 * and so every Scout step (ideators, critics, recombine) is unit-tested with a
 * fake call (no network). Defined here, not imported from the gym, so the Scout
 * module stays decoupled from the (Phase-2, heavily-edited) gym package.
 */
export interface ScoutLlmCall {
  (opts: {
    model: string;
    system?: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    responseFormat?: 'text' | 'json';
    thinkingBudgetTokens?: number;
    maxTokens?: number;
    /** Stable caller identity forwarded to the existing gateway owner-attribution seam. */
    ownerId?: string;
    /** Abort the host transport when the Scout cycle wall-clock timeout fires. */
    signal?: AbortSignal;
    /**
     * WI-4475 — cap (ms) on the ADMISSION wait (queueing behind the shared rate-limit
     * governor, before the request is issued). Derived from the time left on the cycle
     * deadline, so an inner wait can never outlive the cycle that owns it.
     */
    governorMaxWaitMs?: number;
    /**
     * WI-5391 — ABSOLUTE epoch-ms deadline for the transport's transient-retry ladder.
     * `governorMaxWaitMs` bounds one admission wait, but the host retry ladder (8 attempts
     * + backoff) is deadline-blind: under a mid-cycle pool pause it outlives the cycle's
     * own timer, which then mislabels the honest capacity error as "cycle timed out".
     * Derived from the cycle deadline minus a recording margin so the true error lands
     * while the tick can still record it.
     */
    retryDeadlineMs?: number;
    /**
     * WI-4475 — fired when the LOCAL governor admits the call (per attempt), immediately
     * before the HTTP request is issued. The inference gateway may still queue it, so this
     * is observability only — it is NOT the generation boundary.
     */
    onAdmitted?: () => void;
    /**
     * Fired when response headers / the first stream event arrive, after the inference
     * gateway has admitted the request. The per-call GENERATION timer starts/resets here.
     */
    onResponseStart?: () => void;
  }): Promise<{
    text: string;
    json?: unknown;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
  }>;
}

// ───────────────────── P-005 / P-006 (su-d1170) — critics → proposals ─────────────────────
// Appended onto su-797a5's seed per the lane split. The pure critic spine + its
// CorpusMatch / CritiqueVerdict types live in ./critique-core (network-free,
// Idea-shape-agnostic); these are the typed contract the steps hand each other:
// ideators (P-004) → ScoredIdea (P-005) → Proposal (P-006) → routing (P-007).

/**
 * One idea after the adversarial critics (P-005 output → P-006 input). `novelty`
 * blends the deterministic SEARCH-FIRST signal (corpusNovelty — a ceiling, so an
 * already-tried idea stays caught) with the LLM novelty-skeptic; `feasibility` is
 * the LLM feasibility critic. `verdict` is the bucket it landed in (D-005), and
 * `noveltyMatches` is the search-first evidence so a reviewer sees *why*.
 */
export interface ScoredIdea {
  idea: Idea;
  /** 0..1 — how unlike the corpus (1 = nothing like it). */
  novelty: number;
  /** 0..1 — how groundable in this architecture (cost vs upside). */
  feasibility: number;
  /** The closest priors the search-first pass surfaced (evidence for the verdict). */
  noveltyMatches: CorpusMatch[];
  /** Which bucket: 'keep' (build), 'moonshot' (preserved leap), 'reject'. */
  verdict: CritiqueVerdict;
  /** One-line rationale (verdict reason + critic notes), for the digest / audit. */
  notes: string;
}

/**
 * The cheap, falsifiable first experiment every Proposal must carry (D-006) —
 * STRUCTURED so "bettable" is machine-checkable (not free prose): a hypothesis,
 * the method to test it, and the concrete signal that would FALSIFY it. The
 * natural hand-off to the gym.
 */
export interface ScoutExperiment {
  /** What we believe will be true if the idea has merit. */
  hypothesis: string;
  /** The cheap first test (what to run / build / measure). */
  method: string;
  /** The observable that would prove the hypothesis WRONG (the falsifier). */
  falsifiableSignal: string;
}

/** Durable disposition for the D-010 peer review that precedes a goal-rail
 * dispatch. It rides on the persisted proposal itself, so an asynchronous
 * consult can resume in a later Scout cycle without a second queue/table. */
export interface ProposalConsultation {
  /** Cycle that first opened the consult (the stable half of the resume key). */
  originCycleId: string;
  /** Proposal id in that origin cycle (proposal ids are positional and may repeat). */
  originalProposalId: string;
  /** The durable consult conversation, or null when the attempt failed before open. */
  conversationId: string | null;
  /** Workflow disposition, deliberately separate from the consult row's raw state. */
  status: 'pending' | 'answered' | 'unavailable';
  /** Raw consult state/result label for audit and forward compatibility. */
  state: string;
  /** The get_feedback verdict that created this disposition. `relevance_unmeasured`
   * is NOT a synonym for `no_qualified_responder`: the latter is a measured finding
   * that nobody cleared the floor, the former means the embedder was down so nothing
   * was measured. Both yield status 'unavailable', which is why they were collapsed
   * here until EI-21485716602970457 — but only one of them justifies a retry.
   * `retrieval_only` means the caller forbade any responder launch, so the core
   * returned its ranked menu without attempting a review: also 'unavailable', and
   * not a failed launch. */
  verdict: 'routed' | 'served_from_archive' | 'no_qualified_responder' | 'relevance_unmeasured' | 'retrieval_only' | 'failed';
  /** Selected/answering reviewer when known. */
  reviewerId?: string;
  /** Critique folded into the routed artifact once an answer is available. */
  feedback?: string;
  /** Honest explanation for an unavailable/failed review. */
  reason?: string;
}

/** Source-idea snapshot carried only when a consult-deferred proposal resumes in
 * a later cycle. The original cycle's ideas are otherwise out of scope, so this
 * preserves the lens-attribution ledger without inventing a parallel queue. */
export interface ProposalSourceIdeaProvenance {
  id: string;
  lens: CreativeLens;
  addressesPatternRefs?: string[];
}

/**
 * A recombined proposal (P-006 output → P-007 routing input). Surviving critiques
 * are debated + *merged* (A's mechanism + B's framing — the best ideas are usually
 * a fusion) into this shape. `cheapExperiment` is REQUIRED (D-006): the
 * anti-bullshit gate that keeps a proposal bettable, not merely clever, and the
 * natural hand-off to the gym. `routeHint` is P-007's hint (the router may override).
 */
export interface Proposal {
  id: string;
  /** The problem framing the proposal addresses. */
  framing: string;
  /** The novel mechanism — how it would work. */
  mechanism: string;
  /** Why it's new vs everything the Hive has already considered (search-first grounded). */
  whyNew: string;
  /** The bet — the upside if it pans out. */
  bet: string;
  /** REQUIRED (D-006): the cheap falsifiable first experiment, STRUCTURED + machine-checkable.
   *  All three sub-fields must be non-empty (see validateProposal). */
  cheapExperiment: ScoutExperiment;
  /** The critiqued ideas that recombined into this proposal (≥1). */
  sourceIdeaIds: string[];
  /**
   * P-007 routing hint (reconciliation P-005 — the two eval subjects are rails here):
   *   broad-scope → 'plan'; concrete → 'improvement';
   *   testable COMPONENT idea → 'gym' (the eval-battery HarnessSubject);
   *   testable WHOLE-SYSTEM idea → 'instance' (the eval-battery InstanceSubject — a genome
   *   delta over the interacting wholes; the missing rail this plan adds);
   *   GOAL-SCALE idea (multi-plan scope, weeks-long measurable end-state) → 'goal'
   *   (blender-loop-repair-and-opus5-xhigh-2026-08-16 P-013 / D-005 — the Blender
   *   creates+starts the goal autonomously; rails ride inside the goal record).
   */
  routeHint?: 'plan' | 'gym' | 'improvement' | 'instance' | 'goal';
  /**
   * Existing goal to amend when `routeHint === 'goal'` (D-004). A target does
   * not create a sixth rail and does not route by itself: goal-with-target is
   * an amendment; goal-without-target remains creation.
   */
  targetGoalId?: string;
  /**
   * WI-39879 — the rail the model ASKED FOR that intake did not accept, recorded
   * verbatim so a starved rail is READABLE rather than merely countable.
   *
   * ⚠ EVIDENCE ONLY. This field NEVER routes. `classifyProposal` reads `routeHint`
   * and nothing else, so a proposal carrying `droppedRouteHint: 'goal'` still takes
   * DEFAULT_ROUTING_RAIL exactly as before — admitting 'goal' at intake remains the
   * owner-reserved decision (D-006), untouched by this field.
   *
   * WHY IT EXISTS: WI-39721 already tallied dropped hints, but the tally died at the
   * `recombine` PORT boundary — the port is typed `=> Promise<Proposal[]>`, so the
   * cycle structurally could not see it and the only trace was a console.warn. The
   * proposal CONTENT was persisted all along (scout_cycle_stage_artifacts.proposals);
   * the single field identifying which of those proposals were goal-scale was dropped
   * one hop before it landed. Carrying it on the Proposal makes the existing artifact
   * answer "what WOULD the Blender have proposed as a goal?" with no new pipeline,
   * no new table, and no write to `harness_shared.goals`.
   */
  droppedRouteHint?: string;
  /** Corpus pattern refs carried from the source ideas — grounding (⊆ digest refs) + P-013 lens attribution. */
  addressesPatternRefs: string[];
  /** Federated mutation seeds preserved from the source ideas. */
  seededByRefs?: string[];
  /** D-010: independent feedback disposition before the goal rail is consumed. */
  consultation?: ProposalConsultation;
  /** Cross-cycle provenance snapshot for a consult-deferred proposal. */
  sourceIdeaProvenance?: ProposalSourceIdeaProvenance[];
}
