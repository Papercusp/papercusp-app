/**
 * hygiene — the automatic knowledge-cleanup routine
 * (knowledge-pack-loop-integrity-2026-07-19 P-008; owner-asked 2026-07-19
 * "should we also have an automatic cleanup routine?").
 *
 * Knowledge decays: adopted fleet lessons go stale, pool contradictions EMERGE
 * after install (a pack row vs what a hive organically learned last week), and
 * the decided-candidate queue grows forever. Nothing pruned any of it. One
 * bounded tick, three passes, conservative-by-construction (plan D-002: only
 * PRISTINE pack rows are ever auto-deleted; organic/edited content is never
 * auto-deleted, only filed):
 *
 *   (a) PACK RE-REVIEW — fleet-lessons items whose adoption is older than
 *       `minAgeDays` (dated via their adopted candidate row) are re-run
 *       through the SAME transferability judge the auto-adopt review uses
 *       (candidate-review.ts). A FAIL retires the item: the pack file is
 *       removed + the manifest patch-bumped, and each hive's PRISTINE pool
 *       rows of that item are forgotten (edited rows are the user's words —
 *       kept, same rule as uninstall). Judge 'error' ⇒ untouched (D-004
 *       posture: never destroy on a broken judge). Hand-authored items with
 *       no candidate row are never auto-retired.
 *       (The plan's "source signature stopped recurring ⇒ retire" heuristic
 *       was deliberately DROPPED: non-recurrence is ambiguous — the lesson
 *       may be WHY it stopped. The judge is the meaningful check.)
 *   (b) CONFLICT SWEEP — sweepHiveConflicts per local hive (bounded).
 *       AUTO-RESOLVED only when exactly one side is a PRISTINE pack row and
 *       the other is organic: the pack row is forgotten (organic outranks
 *       pack — mirrors install-review D-003). Every other pair (organic vs
 *       organic, edited rows, pack vs pack) is FILED via the injected
 *       `fileConflict` (default: improvements capture), never auto-deleted.
 *   (c) QUEUE PRUNE — dismissed candidates older than `pruneDismissedDays`
 *       are deleted (adopted rows are provenance and kept forever).
 *
 * Deps injectable throughout; unit tests run with fakes, zero PG/LLM/fs.
 */
import { FLEET_LESSONS_PACK_ID } from './candidates-shared';
import { judgeCandidateTransferability } from './candidate-review';
import type { LessonDistillerLlm } from '../transfer/types';

export interface HygienePackItem {
  itemId: string;
  title: string;
  text: string;
  /** ISO adoption date from the adopted candidate row; null ⇒ hand-authored (never auto-retired). */
  adoptedAt: string | null;
}

export interface HygieneConflictPair {
  hive: string;
  aId: string;
  aText: string;
  bId: string;
  bText: string;
  summary: string;
  /** Which sides are PRISTINE pack rows (text == the pack's canonical render). */
  aPristinePack: boolean;
  bPristinePack: boolean;
}

export interface HygieneDeps {
  /** Fleet-lessons items joined with their adoption dates. */
  listPackItems: () => Promise<HygienePackItem[]>;
  /** The transferability judge's LLM port (candidate-review shape). */
  distiller: LessonDistillerLlm;
  /** Remove a retired item from the pack (file + manifest patch-bump). */
  retirePackItem: (itemId: string, reason: string) => Promise<void>;
  /** Forget every hive pool's PRISTINE rows of a retired item; returns count. */
  forgetPristinePoolRows: (itemId: string) => Promise<number>;
  /** The hives to conflict-sweep this tick (already bounded by the caller). */
  listHives: () => Promise<string[]>;
  /** Run the existing sweepHiveConflicts for one hive, pristine-annotated. */
  sweepConflicts: (hive: string) => Promise<HygieneConflictPair[]>;
  /** Forget one memory row (the pack side of an auto-resolved pair). */
  forgetRow: (id: string) => Promise<void>;
  /** File a non-auto-resolvable contradiction for review (never deletes). */
  fileConflict: (pair: HygieneConflictPair) => Promise<void>;
  /** Delete dismissed candidates older than the cutoff; returns count. */
  pruneDismissed: (olderThanDays: number) => Promise<number>;
}

export interface HygieneTickResult {
  itemsReviewed: number;
  itemsRetired: number;
  poolRowsForgotten: number;
  reviewErrors: number;
  hivesSwept: number;
  conflictsAutoResolved: number;
  conflictsFiled: number;
  dismissedPruned: number;
}

export interface HygieneTickOpts {
  /** Adoption age before an item is re-reviewed. Default 30. */
  minAgeDays?: number;
  /** Max transferability re-judgements per tick (LLM cost bound). Default 10. */
  maxReviewsPerTick?: number;
  /** Max hives conflict-swept per tick. Default 3. */
  maxHivesPerTick?: number;
  /** Dismissed-candidate retention. Default 90. */
  pruneDismissedDays?: number;
  now?: () => number;
}

export async function runKnowledgeHygieneTick(
  opts: HygieneTickOpts,
  deps: HygieneDeps,
): Promise<HygieneTickResult> {
  const now = opts.now ?? Date.now;
  const minAgeMs = Math.max(0, opts.minAgeDays ?? 30) * 86_400_000;
  const maxReviews = Math.max(0, opts.maxReviewsPerTick ?? 10);
  const maxHives = Math.max(0, opts.maxHivesPerTick ?? 3);
  const pruneDays = Math.max(1, opts.pruneDismissedDays ?? 90);
  const result: HygieneTickResult = {
    itemsReviewed: 0,
    itemsRetired: 0,
    poolRowsForgotten: 0,
    reviewErrors: 0,
    hivesSwept: 0,
    conflictsAutoResolved: 0,
    conflictsFiled: 0,
    dismissedPruned: 0,
  };

  // ── (a) pack re-review ────────────────────────────────────────────────
  try {
    const items = await deps.listPackItems();
    const due = items
      .filter((i) => i.adoptedAt !== null && now() - Date.parse(i.adoptedAt) >= minAgeMs)
      .slice(0, maxReviews);
    for (const item of due) {
      result.itemsReviewed += 1;
      const verdict = await judgeCandidateTransferability(
        { title: item.title, draftText: item.text },
        deps.distiller,
      );
      if (verdict.verdict === 'error') {
        result.reviewErrors += 1; // never destroy on a broken judge (D-004)
        continue;
      }
      if (verdict.verdict === 'fail') {
        const reason = `hygiene re-review: ${verdict.reason}`;
        await deps.retirePackItem(item.itemId, reason);
        result.itemsRetired += 1;
        result.poolRowsForgotten += await deps.forgetPristinePoolRows(item.itemId).catch(() => 0);
        console.log(`[knowledge-hygiene] retired fleet-lessons/${item.itemId}: ${verdict.reason}`);
      }
    }
  } catch (e) {
    console.warn(`[knowledge-hygiene] pack re-review pass failed: ${e instanceof Error ? e.message : e}`);
  }

  // ── (b) conflict sweep ────────────────────────────────────────────────
  try {
    const hives = (await deps.listHives()).slice(0, maxHives);
    for (const hive of hives) {
      result.hivesSwept += 1;
      const pairs = await deps.sweepConflicts(hive).catch(() => [] as HygieneConflictPair[]);
      for (const pair of pairs) {
        const autoResolvable =
          (pair.aPristinePack && !pair.bPristinePack) || (pair.bPristinePack && !pair.aPristinePack);
        if (autoResolvable) {
          const loserId = pair.aPristinePack ? pair.aId : pair.bId;
          try {
            await deps.forgetRow(loserId);
            result.conflictsAutoResolved += 1;
            console.log(
              `[knowledge-hygiene] auto-resolved contradiction in ${hive}: forgot pristine pack row ${loserId} (organic outranks pack): ${pair.summary}`,
            );
          } catch {
            await deps.fileConflict(pair).catch(() => {});
            result.conflictsFiled += 1;
          }
        } else {
          await deps.fileConflict(pair).catch(() => {});
          result.conflictsFiled += 1;
        }
      }
    }
  } catch (e) {
    console.warn(`[knowledge-hygiene] conflict-sweep pass failed: ${e instanceof Error ? e.message : e}`);
  }

  // ── (c) queue prune ───────────────────────────────────────────────────
  try {
    result.dismissedPruned = await deps.pruneDismissed(pruneDays);
  } catch (e) {
    console.warn(`[knowledge-hygiene] queue-prune pass failed: ${e instanceof Error ? e.message : e}`);
  }

  return result;
}
