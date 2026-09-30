/**
 * outcome-feedback.ts — Scout loop P-013 (hive-creative-ideation-2026-06-08, D-009).
 *
 * The self-correction rail: track which *generated* ideas actually panned out
 * and weight the creative {@link CreativeLens lenses} that win for this Hive —
 * so the ideator (P-004) meta-learns which creative moves work, not just how to
 * execute them. "The ideator improves at *having* ideas."
 *
 * The attribution chain (closed entirely over data that already exists — no new
 * event log, consistent with self-learning-central D-005):
 *
 *   Idea (lens) ──P-007 route──▶ a rail artifact (plan / gym proposal /
 *   improvement) whose change-feed `ref` is recorded as the idea's
 *   {@link RoutedIdeaProvenance routedRef} ──▶ the Change Feed
 *   ({@link ChangeFeedEntry}, a projection over completions) tells us whether
 *   that artifact reached a winning terminal state.
 *
 * So an outcome is just: does this idea's `routedRef` appear in the change feed,
 * and with a winning status? Aggregating that per lens gives the lens weights
 * P-004 reads back to bias generation toward the moves that land — while a
 * diversity floor ({@link LensWeightOptions.minShare}) keeps every lens alive so
 * the weighting never strangles the leaps (the plan's anti-over-prune ethos +
 * the novelty-search lesson behind D-008).
 *
 * Grading (scout-idea-grading-2026-06-12): a 1–5 owner/Queen grade on the
 * ledger row is a faster, stronger outcome signal. When present it DOMINATES
 * the change-feed outcome in the tally (D-002) as fractional credit
 * ({@link winCredit}, C-5); ungraded ideas keep the change-feed path, and the
 * feed-derived classification stays persisted for comparison.
 *
 * Pure + side-effect-free over injected readers (the change-feed / watchdog
 * pattern): the production reader bag ({@link ScoutOutcomeReaders}) is wired to
 * the routed-idea ledger + `buildChangeFeedReaders()`, but every function here is
 * unit-tested with fakes (no PG, no network).
 */

import type { ChangeFeedEntry } from '../curation/change-feed';
import { CREATIVE_LENSES, type CreativeLens } from './types';

/**
 * The rails a Scout proposal routes into (P-007 / D-007; reconciliation P-005 adds
 * `instance`). The two eval rails are the eval-battery's two SUBJECTS: `gym` = the
 * HarnessSubject (component eval), `instance` = the InstanceSubject (whole-instance
 * eval, a genome delta). Both feed lens meta-learning (reconciliation P-006).
 * `goal` (blender-loop-repair-and-opus5-xhigh-2026-08-16 P-013 / D-005): a GOAL-SCALE
 * idea the Blender turns into an auto-created-and-started `harness_shared.goals` row —
 * wired into outcome feedback from day one (achieved → won, killed → lost), unlike the
 * gym rail's D-003 gap.
 */
export type RoutedRail = 'plan' | 'gym' | 'improvement' | 'instance' | 'goal';

/** Outcome of one routed idea, derived from the change feed. */
export type IdeaOutcome =
  /** The routed artifact reached a winning terminal state (plan done / gym accepted / improvement landed). */
  | 'won'
  /** The routed artifact reached a losing terminal state (gym rejected / superseded). */
  | 'lost'
  /** Not yet terminal in the change feed — outcome still unknown. */
  | 'pending';

/** A typed feedback-driven successor filing. `readRoutedIdeas` derives these from
 * coord_links `revises` edges; release scoring still validates origin + chronology. */
export interface FeedbackRevision {
  /** Work-item id of the newly filed revision. */
  revisionRef: string;
  /** Originating agent stamped on the revision work-item. */
  createdBy?: string;
  /** ISO timestamp the revision work-item was created. */
  revisedAt: string;
}

/**
 * Provenance of one Scout idea that P-007 routed into a rail — the record that
 * links a generated idea (and its lens) to the artifact whose fate determines
 * whether the idea panned out. This is genuine new state (the change feed cannot
 * say which lens produced a plan), persisted in the routed-idea ledger; it is
 * NOT a duplicate of the change feed (D-005 holds — the feed stays a projection).
 */
export interface RoutedIdeaProvenance {
  /** The generated idea's id (Idea.id from P-004). */
  ideaId: string;
  /** Which creative lens produced the idea — the attribution key (D-009). */
  lens: CreativeLens;
  /** The Scout cycle this idea came from (optional grouping). */
  cycleId?: string;
  /** Which rail P-007 routed it into. */
  rail: RoutedRail;
  /**
   * The change-feed `ref` of the artifact the routing created — "plan:<slug>",
   * "gym:<id>", or "wi:<id>". The join key into {@link ChangeFeedEntry.ref}.
   */
  routedRef: string;
  /**
   * The hive the idea came FROM (workspace-scoped-coordination D-003 source-hive
   * tag). Persisted on the ledger row (migration 333) + always populated by the
   * write path; the workspace-scoped Scout (P-002) groups its corpus by it.
   */
  sourceHive?: string;
  /** Optional best-effort hint: the hive the idea is ABOUT (a cross-hive idea, D-003). */
  targetHive?: string;
  /** One-line idea title (for the report's drill-down). */
  title?: string;
  /** ISO timestamp the idea was routed. */
  routedAt?: string;
  /**
   * The digest pattern refs the source idea addressed (Idea.addressesPatternRefs)
   * — the P-013 pattern-attribution key, threaded by deriveProvenance so the
   * scheduler's recordRoutedIdea persists it without a re-join.
   */
  addressesPatternRefs?: string[];
  /**
   * Grader's 1–5 verdict on the idea (scout-idea-grading C-1b; ledger column
   * `human_grade`). Absent/undefined = ungraded. When present (a valid 1–5
   * integer), the grade DOMINATES the change-feed outcome in the lens-weight
   * tally via {@link winCredit} (D-002) — the feed-derived `outcome` stays
   * recorded for analytics, but the weight math prefers the grade.
   */
  humanGrade?: number;
  /** Grader's free-text critique (ledger `human_feedback`) — the priming channel's payload, not used by the weight math. */
  humanFeedback?: string;
  /** Who graded: the owner's grade is sovereign over agent grades (D-004; enforced in the write seam). */
  gradedBy?: string;
  /** ISO timestamp of the grade (ledger `graded_at`). */
  gradedAt?: string;
  /**
   * The ORIGINATING AGENT's ownerId (ledger `created_by`, migration 558 —
   * su-ideate-learning-substrate P-001). Present on origin='su-ideate' rows stamped
   * by the su capture bridge; absent on Scout-origin rows and pre-558 history (P-016
   * backfills best-effort). Join key for the grade→revise wake and scope:'mine'
   * feedback reads; the weight math ignores it.
   */
  createdBy?: string;
  /** Typed successor filings pointing back to this routed idea via rel='revises'. */
  feedbackRevisions?: FeedbackRevision[];
}

/**
 * Per-lens outcome tally + the weight P-004 reads back. Generic over the lens
 * roster (su-ideate-learning-substrate P-004): Scout's surfaces use the default
 * {@link CreativeLens}; the su read-time win-rates instantiate with
 * `SuIdeationLens` — same math, wider vocabulary, no persistence.
 */
export interface LensOutcomeStat<L extends string = CreativeLens> {
  lens: L;
  /** Ideas from this lens that were routed (won + lost + pending). */
  routed: number;
  /**
   * Win mass. FRACTIONAL once grades exist: a graded idea contributes
   * {@link winCredit}(grade) here and `1 − credit` to `lost` (C-5), so
   * `won + lost + pending === routed` always holds exactly.
   */
  won: number;
  /** Loss mass — fractional under grading, see {@link LensOutcomeStat.won}. */
  lost: number;
  pending: number;
  /** won / (won + lost) over DECIDED ideas only; null when nothing decided yet. */
  winRate: number | null;
  /**
   * Normalized sampling share in [minShare, 1], summing to 1 across all lenses —
   * the probability mass P-004 should give this lens next cycle. Smoothed so a
   * low-volume lens isn't judged on one outcome, floored so no lens starves.
   */
  weight: number;
}

/** The full P-013 report: per-lens stats + the ranked roster, every roster lens always present. */
export interface LensOutcomeReport<L extends string = CreativeLens> {
  /** ISO timestamp the report was computed (stamped by the caller; pure core leaves it undefined). */
  generatedAt?: string;
  /**
   * Total routed ideas considered — INCLUDING rows whose lens is outside the
   * roster (e.g. the su 'su-ideate' sentinel), which appear in no per-lens stat.
   */
  total: number;
  /** Stats keyed by lens — every roster member (default {@link CREATIVE_LENSES}) is present. */
  byLens: Record<L, LensOutcomeStat<L>>;
  /** The lenses sorted best-first (by weight, then winRate, then volume). */
  ranked: LensOutcomeStat<L>[];
}

/** Injectable reader bag (unit tests inject fakes; production wires PG + the change feed). */
export interface ScoutOutcomeReaders {
  /** The Scout ideas that have been routed into a rail (the ledger). */
  routedIdeas(): Promise<RoutedIdeaProvenance[]>;
  /** The Change Feed completions (gatherCompletions output). */
  completions(): Promise<ChangeFeedEntry[]>;
}

export interface LensWeightOptions {
  /**
   * Beta-prior pseudo-count per lens (Laplace smoothing). A lens with no decided
   * ideas gets a neutral 0.5 smoothed win-rate; one decided win/loss barely moves
   * it. Higher = more conservative (slower to trust a lens). Default 1.
   */
  priorStrength?: number;
  /**
   * Minimum normalized share any lens keeps after weighting — the diversity floor
   * that stops a cold/losing lens from being fully starved (D-004 forced diversity
   * + the plan's "don't over-prune the leaps"). Must leave room for all lenses:
   * minShare * lensCount < 1. Default 0.05.
   */
  minShare?: number;
}

/**
 * Classify one routed idea's outcome from the change feed.
 *
 * - Not present in the feed → `pending` (no terminal record yet).
 * - `plan-run` / work-item `completion` present → `won` (the change-feed
 *   production readers only surface winning terminal states for these — plan
 *   `op_status=done`, work-item done/passed/resolved/closed — so presence == win)
 *   — EXCEPT a completion entry tagged with one of
 *   {@link WORK_ITEM_LOSS_STATUSES} (`deprecated` — su-ideate-learning-substrate
 *   P-003 — or `dropped`, EI-20307121130730172), the losing work-item terminals
 *   the ref-scoped outcome reads fold in → `lost`.
 * - `proposal` (gym) → status decides: accepted → `won`; rejected/superseded → `lost`.
 *
 * The gym status is read from the entry's `detail` ("Status: <status>") with a
 * title fallback ("Accepted …" / "Rejected …"), so it survives either shape.
 *
 * Deliberately GRADE-BLIND (D-002): this classification is what
 * `refreshScoutOutcomes` persists to the ledger's `outcome` column — the
 * system-derived record kept for grade-vs-outcome comparison. The grade
 * dominates only in the weight tally ({@link computeLensOutcomes}).
 */
export function classifyIdeaOutcome(
  prov: RoutedIdeaProvenance,
  completionByRef: ReadonlyMap<string, ChangeFeedEntry>,
): IdeaOutcome {
  // D-003 / P-002 (blender-loop-repair-2026-08-16, EI-20597534704604481): a
  // LEGACY shared gym ref (`gym:SP-NNN` — the pre-batch-stamp per-cycle counter
  // ids) joined MANY ideas onto ONE frozen niche verdict: 600 of 746 decided
  // outcomes were copies of 4 dead July verdicts, flattening lens weights to
  // near-uniform. Their true per-idea outcomes are unknowable, so they classify
  // 'pending' permanently — which also makes the next refreshScoutOutcomes
  // batch-UPDATE repair the 600 poisoned cached rows in place. Batch-stamped
  // ids (`gym:SP-<stamp>-NNN`, recombine.ts) do not match.
  if (prov.rail === 'gym' && /^gym:SP-\d+$/.test(prov.routedRef)) return 'pending';
  const entry = completionByRef.get(prov.routedRef);
  if (!entry) return 'pending';
  // instance (InstanceSubject / apiary) eval — reconciliation P-006: a genome variant
  // that the battery PROMOTED (beat the champion beyond the noise band + held the
  // meta-eval) won; any other decided verdict lost. Both eval subjects feed lens
  // meta-learning, so a whole-system idea's apiary outcome weights its lens too.
  if (prov.rail === 'instance') {
    const status = gymStatusOf(entry);
    return status === 'promoted' || status === 'accepted' || status === 'won' ? 'won' : 'lost';
  }
  // goal (P-013 / D-005): the ledger's goal leg only emits TERMINAL goals
  // (stop-seam.ts TERMINAL_STATUSES — 'achieved' | 'killed'), tagged
  // "Status: <status>". Achieved = the weeks-long outcome landed → won; killed
  // (the kill criterion tripped, or any other decided non-achieve) → lost.
  // 'active'/'paused' goals produce no entry and stay pending here.
  if (prov.rail === 'goal') {
    return gymStatusOf(entry) === 'achieved' ? 'won' : 'lost';
  }
  if (entry.kind === 'proposal') {
    const status = gymStatusOf(entry);
    if (status === 'accepted') return 'won';
    if (status === 'rejected' || status === 'superseded') return 'lost';
    // Unknown decision label but the proposal IS in the feed (it was decided) —
    // treat an unrecognized non-accept as a loss rather than silently pending.
    return 'lost';
  }
  // completion (work-item): the production feed only carries winning terminals
  // (presence == win), but the ledger's ref-scoped reads fold in losing
  // terminals tagged "Status: <terminal>" — honor the tag so a filing whose
  // item died classifies lost instead of sitting pending forever.
  // Winning/untagged entries stay 'won' byte-identically.
  //
  // EI-20307121130730172: 'deprecated' alone was the wrong vocabulary. It is
  // the RAREST negative terminal in the store (31 rows workspace-wide, and
  // ZERO among 854 routed refs) while 'dropped' — 1,972 rows, 63 of them
  // routed — was in neither the win set nor the loss set, so it produced no
  // feed entry at all and read 'pending' forever. The wi rail therefore
  // recorded 100 wins and *zero* losses in two months: a win-only channel, so
  // `winRate = won / (won + lost)` could not fall for any ungraded filing.
  // Human grading masked this for su-ideate (88% graded) but not for scout
  // (9% graded), which is where the 56 of those 63 rows sit.
  if (entry.kind === 'completion' && isWorkItemLossStatus(gymStatusOf(entry))) return 'lost';
  // plan-run: SPOF 5 / P-006 (autonomous-loop-prod-audit-2026-07-02) — a plan
  // routed by Scout that reaches the ABANDONED terminal (harness_plans
  // op_status='dropped', isTerminalStatus) must resolve 'lost', not sit
  // 'pending' forever. Before this, the plan rail was win-only: only
  // op_status='done' ever produced a plan-run entry, so a dropped plan's idea
  // had no terminal entry at all and classified pending indefinitely — the
  // exact "plan-rail outcome ledger stuck pending" gap this fix closes. The
  // scout-scoped ledger read (readScoutRefScopedTerminalEntries) tags a
  // dropped plan's entry "Status: dropped"; any other/untagged plan-run entry
  // (op_status='done') stays 'won' byte-identically.
  //
  // GYM-3 (P-013): 'superseded' is the sibling LOSS terminal on the plan
  // STORE's own lifecycle status (frontmatter status, a separate state
  // machine from op_status — TERMINAL_PLAN_STATUSES in plan-start-state.ts).
  // A plan idea Scout routed can be reviewed and replaced/abandoned as a plan
  // DRAFT without ever running as a tracked harness op at all (op_status
  // stays null forever) — that idea had no terminal entry on either machine
  // and sat pending indefinitely until this fix.
  if (entry.kind === 'plan-run' && (gymStatusOf(entry) === 'dropped' || gymStatusOf(entry) === 'superseded')) return 'lost';
  // plan-run + winning completions: the feed only carries winning terminals.
  return 'won';
}

/**
 * The work-item terminals that are a LOSS for the idea that filed them
 * (EI-20307121130730172) — the negative counterpart of
 * {@link CHANGE_FEED_COMPLETION_STATUSES} on the `wi:` rail.
 *
 * The production Change Feed carries only WINNING terminals (presence == win
 * for its consumers), so these never reach the classifier through the feed;
 * the ledger's ref-scoped reads (routed-ledger.ts) surface them explicitly and
 * tag them `Status: <terminal>` for {@link classifyIdeaOutcome}.
 *
 * `dropped` is the terminal that matters in practice — it is how work actually
 * dies here (1,972 rows vs `deprecated`'s 31). Both are folded with NO
 * terminal-integrity requirement: a hygiene/dedup death is still a negative
 * signal about the idea that proposed the work.
 */
export const WORK_ITEM_LOSS_STATUSES = ['deprecated', 'dropped'] as const;

/** True when a status label read off a completion entry is a losing wi terminal. */
function isWorkItemLossStatus(status: string): boolean {
  return (WORK_ITEM_LOSS_STATUSES as readonly string[]).includes(status);
}

/** Extract a status/decision label from a change-feed entry's detail ("Status: <x>") or title. */
function gymStatusOf(entry: ChangeFeedEntry): string {
  const fromDetail = entry.detail?.match(/status:\s*([a-z]+)/i)?.[1];
  if (fromDetail) return fromDetail.toLowerCase();
  const fromTitle = entry.title.match(/^(accepted|rejected|superseded)\b/i)?.[1];
  return fromTitle ? fromTitle.toLowerCase() : 'unknown';
}

/** Empty stat for a lens with no routed ideas (neutral, floor-eligible). */
function emptyStat<L extends string>(lens: L): LensOutcomeStat<L> {
  return { lens, routed: 0, won: 0, lost: 0, pending: 0, winRate: null, weight: 0 };
}

/**
 * Fractional win credit of a 1–5 grade (scout-idea-grading C-5):
 * `(grade − 1) / 4` — 5 → 1.0, 3 → 0.5 (exactly neutral under the Beta(1,1)
 * prior), 1 → 0.0. A graded idea contributes `credit` to its lens's wins and
 * `1 − credit` to its losses, so grade 5 weighs exactly like a change-feed win
 * and grade 1 exactly like a loss.
 */
export function winCredit(grade: number): number {
  return (grade - 1) / 4;
}

/**
 * The provenance's grade when it is usable: an integer in 1..5 (the DB CHECK's
 * domain). Anything else — absent, NaN, fractional, out of range — is treated
 * as ungraded rather than poisoning the tally.
 */
function validGradeOf(prov: RoutedIdeaProvenance): number | null {
  const g = prov.humanGrade;
  return typeof g === 'number' && Number.isInteger(g) && g >= 1 && g <= 5 ? g : null;
}

/**
 * Compute the per-lens outcome report from routed-idea provenance + the change
 * feed. Pure. Every lens in the roster (`opts.lenses`, default
 * {@link CREATIVE_LENSES} — the Scout path is byte-identical) appears in
 * `byLens` (so the roster P-004 reads is always complete), and `weight` is the
 * smoothed, floored, normalized sampling share.
 *
 * su-ideate-learning-substrate P-004: the su read-time win-rates pass
 * `lenses: SU_IDEATION_LENSES`. A provenance row whose lens is OUTSIDE the
 * roster (the 'su-ideate' sentinel on unlensed filings) enters no per-lens
 * stat but still counts in `total` — sentinel volume is visible without
 * polluting any lens's win-rate.
 */
export function computeLensOutcomes<L extends string = CreativeLens>(
  provenance: readonly RoutedIdeaProvenance[],
  completions: readonly ChangeFeedEntry[],
  opts: LensWeightOptions & { lenses?: readonly L[] } = {},
): LensOutcomeReport<L> {
  const lenses = opts.lenses ?? (CREATIVE_LENSES as readonly string[] as readonly L[]);
  const completionByRef = new Map<string, ChangeFeedEntry>();
  for (const e of completions) {
    // First-wins matches gatherCompletions' dedup; refs are unique per artifact.
    if (!completionByRef.has(e.ref)) completionByRef.set(e.ref, e);
  }

  const byLens = Object.fromEntries(
    lenses.map((l) => [l, emptyStat(l)]),
  ) as Record<L, LensOutcomeStat<L>>;

  for (const prov of provenance) {
    // A row's lens is data (ledger text column) — index as a plain string so a
    // lens outside the roster falls through to the skip, never a type hole.
    const stat = (byLens as Record<string, LensOutcomeStat<L> | undefined>)[prov.lens];
    if (!stat) continue; // ignore an unknown/sentinel lens rather than throwing
    stat.routed += 1;
    const grade = validGradeOf(prov);
    if (grade !== null) {
      // C-5 / D-002: a grade DOMINATES the change-feed outcome — the graded
      // idea is decided by the grader regardless of feed state (a graded
      // pending idea counts decided; a grade-1 on a feed win counts as loss
      // mass). credit + (1 − credit) = 1, so the routed invariant holds.
      const credit = winCredit(grade);
      stat.won += credit;
      stat.lost += 1 - credit;
    } else {
      const outcome = classifyIdeaOutcome(prov, completionByRef);
      if (outcome === 'won') stat.won += 1;
      else if (outcome === 'lost') stat.lost += 1;
      else stat.pending += 1;
    }
  }

  for (const lens of lenses) {
    const s = byLens[lens];
    const decided = s.won + s.lost;
    s.winRate = decided > 0 ? s.won / decided : null;
  }

  applyLensWeights(byLens, lenses, opts);

  const ranked = [...lenses.map((l) => byLens[l])].sort(rankStats);
  return { total: provenance.length, byLens, ranked };
}

/** Sort best-first: weight desc, then winRate desc (nulls last), then volume desc, then lens name. */
function rankStats(a: LensOutcomeStat<string>, b: LensOutcomeStat<string>): number {
  if (b.weight !== a.weight) return b.weight - a.weight;
  const ar = a.winRate ?? -1;
  const br = b.winRate ?? -1;
  if (br !== ar) return br - ar;
  if (b.routed !== a.routed) return b.routed - a.routed;
  return a.lens < b.lens ? -1 : a.lens > b.lens ? 1 : 0;
}

/**
 * Mutate `byLens` to set each lens's normalized `weight`:
 *   1. smoothed win-rate r_l = (won + p) / (won + lost + 2p)  — Beta(p,p) prior;
 *   2. normalize to a probability mass over lenses;
 *   3. floor every share at minShare and re-normalize (diversity guarantee).
 */
function applyLensWeights<L extends string>(
  byLens: Record<L, LensOutcomeStat<L>>,
  lenses: readonly L[],
  opts: LensWeightOptions,
): void {
  const prior = opts.priorStrength ?? 1;
  const lensCount = lenses.length;
  const minShare = clampMinShare(opts.minShare ?? 0.05, lensCount);

  const smoothed = lenses.map((l) => {
    const s = byLens[l];
    return (s.won + prior) / (s.won + s.lost + 2 * prior);
  });
  const sum = smoothed.reduce((a, b) => a + b, 0);
  const normalized = smoothed.map((v) => (sum > 0 ? v / sum : 1 / lensCount));

  const floored = normalized.map((v) => Math.max(v, minShare));
  const flooredSum = floored.reduce((a, b) => a + b, 0);

  lenses.forEach((l, i) => {
    byLens[l].weight = floored[i] / flooredSum;
  });
}

/** Keep the floor feasible: the sum of floors must leave headroom under 1. */
function clampMinShare(minShare: number, lensCount: number): number {
  if (!Number.isFinite(minShare) || minShare <= 0) return 0;
  const max = 1 / lensCount; // floor == uniform is the degenerate max
  return Math.min(minShare, max);
}

/**
 * Allocate `n` ideator slots across lenses for the next Scout cycle, blending
 * D-009 (favor winning lenses) with D-004 (forced diversity): when `n` ≥ the
 * lens count, every lens gets at least one slot (exploration guarantee), then
 * the remaining slots go by weight via largest-remainder (deterministic). When
 * `n` < the lens count, the top-`n` lenses by weight each get one.
 *
 * Returns a deterministic list of length `n` (lens ids, repeats allowed).
 */
export function allocateIdeators(report: LensOutcomeReport, n: number): CreativeLens[] {
  const count = Math.max(0, Math.floor(n));
  if (count === 0) return [];
  const lensCount = CREATIVE_LENSES.length;
  const weights = CREATIVE_LENSES.map((l) => ({ lens: l, w: report.byLens[l].weight }));

  if (count < lensCount) {
    return [...weights]
      .sort((a, b) => b.w - a.w || (a.lens < b.lens ? -1 : 1))
      .slice(0, count)
      .map((x) => x.lens);
  }

  // Guarantee one per lens, then distribute the remainder by weight.
  const base: Record<CreativeLens, number> = Object.fromEntries(
    CREATIVE_LENSES.map((l) => [l, 1]),
  ) as Record<CreativeLens, number>;
  const remaining = count - lensCount;
  if (remaining > 0) {
    const ideal = weights.map((x) => ({ lens: x.lens, exact: x.w * remaining }));
    const floors = ideal.map((x) => ({ lens: x.lens, n: Math.floor(x.exact), rem: x.exact - Math.floor(x.exact) }));
    let assigned = floors.reduce((a, b) => a + b.n, 0);
    for (const f of floors) base[f.lens] += f.n;
    // Largest-remainder for the leftover slots (deterministic tie-break by lens id).
    const leftover = remaining - assigned;
    floors
      .sort((a, b) => b.rem - a.rem || (a.lens < b.lens ? -1 : 1))
      .slice(0, leftover)
      .forEach((f) => {
        base[f.lens] += 1;
      });
  }

  const out: CreativeLens[] = [];
  for (const l of CREATIVE_LENSES) for (let i = 0; i < base[l]; i++) out.push(l);
  return out;
}

/**
 * Project a report's per-lens weights into the `lensWeights` shape the ideator
 * fan-out (P-004 `runIdeators`, BuildRosterInput.lensWeights) consumes — the
 * D-009 feedback hook: extra ideators are distributed across lenses proportional
 * to these weights (the diversity floor in the weights keeps every lens alive).
 */
export function lensWeightsFromReport(report: LensOutcomeReport): Record<CreativeLens, number> {
  return Object.fromEntries(
    CREATIVE_LENSES.map((l) => [l, report.byLens[l].weight]),
  ) as Record<CreativeLens, number>;
}

/**
 * One persisted per-lens weight row (`harness_shared.scout_lens_weights`,
 * migration 208) — the P-033 projection of a {@link LensOutcomeReport} the
 * production cycle upserts after classifying routed-idea outcomes, and the
 * ideator lens-selection path reads back. Pure data; the PG seam lives in
 * routed-ledger.ts.
 */
export interface LensWeightRow {
  lens: CreativeLens;
  /**
   * Win mass from this lens (Change-Feed terminal wins + fractional grade
   * credit, C-5). May be fractional in memory; the persisted column is int so
   * the upsert seam rounds it before the cast (jsonb int casts error on
   * fractions) — `weight` (computed here, pre-rounding) is the value the
   * sampling path reads back, so rounding only blurs the analytics.
   */
  wins: number;
  /** Decided mass either way (won + lost); pending excluded. Fractional under grading, rounded on persist like `wins`. */
  decided: number;
  /** The smoothed/floored/normalized sampling share from {@link computeLensOutcomes}. */
  weight: number;
}

/** Project a report into the persistable per-lens weight rows (P-033 upsert math). */
export function lensWeightRowsFromReport(report: LensOutcomeReport): LensWeightRow[] {
  return CREATIVE_LENSES.map((l) => {
    const s = report.byLens[l];
    return { lens: l, wins: s.won, decided: s.won + s.lost, weight: s.weight };
  });
}

/**
 * The sampling floor (P-033): every lens keeps at least this fraction of its
 * UNIFORM share when persisted weights are read back as sampling weights — so a
 * cold/losing lens is never zeroed out of the ideator roster.
 */
export const SAMPLING_FLOOR_FRACTION = 0.15;

/**
 * Turn (possibly partial / stale / empty) persisted per-lens weights into
 * sampling weights with a hard diversity floor. Pure.
 *
 *   - empty / missing / non-positive input → uniform (the cold-start fallback);
 *   - otherwise the raw weights are normalized, then mixed with the floor:
 *     `final = floor + (1 − N·floor) · normalized`, where
 *     `floor = floorFraction / N` — exact: every lens's final share is ≥ floor,
 *     the shares sum to 1, and the ordering of the raw weights is preserved.
 *
 * A lens absent from `raw` (e.g. a partial persisted set) contributes 0 raw
 * weight and lands exactly on the floor — alive, never starved.
 *
 * Generic over the roster (P-004): `opts.lenses` (default
 * {@link CREATIVE_LENSES}) — the su read-time weights floor over
 * SU_IDEATION_LENSES with the same math.
 */
export function samplingWeightsWithFloor<L extends string = CreativeLens>(
  raw: Partial<Record<L, number>> | null | undefined,
  opts: { floorFraction?: number; lenses?: readonly L[] } = {},
): Record<L, number> {
  const lenses = opts.lenses ?? (CREATIVE_LENSES as readonly string[] as readonly L[]);
  const lensCount = lenses.length;
  const uniform = 1 / lensCount;
  const requested = opts.floorFraction ?? SAMPLING_FLOOR_FRACTION;
  const fraction =
    Number.isFinite(requested) && requested >= 0 ? Math.min(requested, 1) : SAMPLING_FLOOR_FRACTION;
  const floor = fraction * uniform;

  const vals = lenses.map((l) => {
    const v = raw?.[l];
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
  });
  const sum = vals.reduce((a, b) => a + b, 0);
  if (sum <= 0) {
    return Object.fromEntries(lenses.map((l) => [l, uniform])) as Record<L, number>;
  }

  const headroom = 1 - lensCount * floor; // ≥ 0 because fraction ≤ 1
  return Object.fromEntries(
    lenses.map((l, i) => [l, floor + headroom * (vals[i] / sum)]),
  ) as Record<L, number>;
}

/**
 * Top-level P-013 entry: read routed-idea provenance + the change feed and
 * compute the lens-outcome report. The caller stamps `generatedAt`.
 */
export async function gatherLensOutcomes<L extends string = CreativeLens>(
  readers: ScoutOutcomeReaders,
  opts: LensWeightOptions & { lenses?: readonly L[] } = {},
): Promise<LensOutcomeReport<L>> {
  const [provenance, completions] = await Promise.all([
    readers.routedIdeas().catch(() => [] as RoutedIdeaProvenance[]),
    readers.completions().catch(() => [] as ChangeFeedEntry[]),
  ]);
  return computeLensOutcomes(provenance, completions, opts);
}

// P-007's redesigned reward seam lives in a separate pure module so the
// historical lens-outcome API remains byte-compatible while callers migrate.
// Re-export it here because this is the existing Scout feedback entrypoint.
export {
  SCOUT_REWARD_DIMENSIONS,
  computeRoutedIdeaRewards,
  computeScoutRewardReport,
  computeScoutRewards,
  normalizeReviewerPreference,
} from './reward';
export type {
  ScoutArtifactDelivery,
  ScoutArtifactReward,
  ScoutEffectiveness,
  ScoutEffectivenessStatus,
  ScoutLensRewardStat,
  ScoutRegressionEvidence,
  ScoutRegressionStatus,
  ScoutRewardDimension,
  ScoutRewardInput,
  ScoutRewardObservation,
  ScoutRewardReport,
  ScoutUncertainty,
  ScoutUncertaintyStatus,
} from './reward';
