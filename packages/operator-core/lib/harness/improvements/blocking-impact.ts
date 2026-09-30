/**
 * blocking-impact.ts — blocking-impact ranking over the human review queue
 * (self-improvement-consume-edges-2026-06-12 P-022, closing Scout's own
 * EI-340/EI-352 proposals; B-08).
 *
 * The human queue competes for ONE scarce resource — owner attention — but the
 * triage score (severity + age) carries no information about DOWNSTREAM cost:
 * a destructive-cleanup gate blocking five work-items ranks the same as a
 * cosmetic rename (EI-352). This module scores each human-lane item by what is
 * actually waiting on it, so the owner's queue view always leads with "the one
 * thing to decide now" (EI-340):
 *
 *   - `blocks` out-edges  — work-items/plans this item explicitly blocks
 *     (coord_links rel='blocks'; the hardest signal, weighted highest).
 *   - inbound references  — other objects pointing at this item (excluding
 *     topic tags and upstream `blocks`).
 *   - open re-captures    — other OPEN items sharing the stable friction
 *     signature (digest.recurringSignatures): the friction keeps re-arriving.
 *   - near-duplicate peers — likely-dup cluster members beyond the exact
 *     signature group (someone filed it again in different words).
 *   - an open watchdog key — the item tracks an objective, auto-detected
 *     failure signal; while open it represents live recurring breakage.
 *   - severity            — a critical item is presumed to block more.
 *
 * The base score is multiplied by a log staleness curve (EI-352's
 * `log(staleness+1)` bid shape): an unattended high-impact item self-promotes
 * as it ages, a fresh one doesn't spike the queue.
 *
 * Pure + deterministic given inputs. Weights are EXPORTED TUNABLES — adjust
 * from evidence, not by redesign.
 *
 * PRODUCTION RANKING PATH: since self-learning-frontier P-040 (FB-12) the
 * human-lane read path ranks through lib/queue-ranker/, where this module is
 * feature #1 (blocking-impact-feature.ts) — the defensive link fetch lives
 * there. This file stays the sole owner of the impact semantics;
 * `rankHumanQueueByImpact` is the pure reference ordering the ranker's
 * equivalence test pins against.
 */

import type { ImprovementDigest, ScoredItem, SignatureRecurrence } from './digest';
import type { ImprovementCandidate, ImprovementSeverity } from './policy';
import type { IssueLinkCounts } from '../../issues-engineer';

/** Tunable weights (P-022). One unit ≈ "one minor thing waiting on this". */
export const BLOCKING_IMPACT_WEIGHTS = {
  /** Per outbound `blocks` edge — an explicit downstream dependency. */
  blocksOut: 12,
  /** Per inbound reference edge (relates/duplicates/… from another object). */
  inboundRef: 3,
  /** Per OTHER open capture of the same friction signature. */
  openRecurrence: 4,
  /** Per resolved capture of the same signature (it recurred before — weak). */
  resolvedRecurrence: 1,
  /** Per near-duplicate peer beyond the exact-signature group. */
  dupPeer: 2,
  /** The item carries a watchdogKey and is still open — live objective signal. */
  watchdogActive: 5,
  /** Severity prior — a critical item is presumed to gate more. */
  severity: { critical: 10, major: 6, minor: 2, nit: 0 } as Record<ImprovementSeverity, number>,
  /** Cap on the age (days) feeding the log staleness multiplier. */
  stalenessCapDays: 60,
} as const;

export interface BlockingImpact {
  /** The blocking-impact score — base factors × log staleness. Higher = decide sooner. */
  score: number;
  blocksOut: number;
  inboundRefs: number;
  /** OTHER open captures sharing this item's friction signature. */
  openRecurrence: number;
  /** Resolved captures of the same signature (recurred + was handled before). */
  resolvedRecurrence: number;
  /** Near-duplicate peers beyond the exact-signature group. */
  dupPeers: number;
  watchdogActive: boolean;
  /** Log staleness multiplier applied to the base (1.0 = fresh). */
  staleness: number;
  /** Human-readable "why this ranks here" lines (only non-zero factors). */
  reasons: string[];
}

/** A human-queue item with its blocking-impact attached (additive on ScoredItem —
 *  existing digest consumers keep working untouched). */
export type ImpactRankedItem = ScoredItem & { impact: BlockingImpact };

/** Context the pure ranking reads. All optional — missing context degrades to
 *  the severity + staleness prior, never throws. */
export interface BlockingImpactContext {
  /** Raw candidates (for payload fields the ScoredItem doesn't carry — watchdogKey). */
  candidates?: readonly ImprovementCandidate[];
  /** Link-degree per issue id (issueLinkCounts shape). */
  linkCounts?: ReadonlyMap<string, IssueLinkCounts>;
}

function sevWeight(sev: ImprovementSeverity | undefined): number {
  return BLOCKING_IMPACT_WEIGHTS.severity[sev ?? 'minor'] ?? BLOCKING_IMPACT_WEIGHTS.severity.minor;
}

/** Log staleness multiplier (EI-352): 0d → 1.0, 1d → ~1.3, 7d → ~1.9, 30d → ~2.5. */
export function stalenessMultiplier(ageDays: number): number {
  const capped = Math.min(Math.max(0, ageDays), BLOCKING_IMPACT_WEIGHTS.stalenessCapDays);
  return 1 + Math.log10(1 + capped);
}

/** Compute one item's blocking impact. Pure. */
export function computeBlockingImpact(
  item: ScoredItem,
  ctx: BlockingImpactContext & {
    /** This item's signature recurrence row, when its signature recurred. */
    recurrence?: SignatureRecurrence;
    /** Likely-duplicate cluster size containing this item (members incl. itself). */
    dupClusterSize?: number;
  } = {},
): BlockingImpact {
  const W = BLOCKING_IMPACT_WEIGHTS;
  const links = ctx.linkCounts?.get(item.id) ?? { blocksOut: 0, inboundRefs: 0 };
  const candidate = ctx.candidates?.find((c) => c.id === item.id);
  // "Still firing" precision lands with the known-open aging work (P-020); the
  // honest signal today is: an objective watchdog capture that is still open.
  const watchdogActive = Boolean(candidate?.watchdogKey) && (item.state ?? 'open') === 'open';

  const rec = ctx.recurrence;
  const isOpen = (item.state ?? 'open') === 'open';
  const openRecurrence = rec ? Math.max(0, rec.openCount - (isOpen ? 1 : 0)) : 0;
  const resolvedRecurrence = rec ? rec.resolvedCount : 0;
  // Near-dup peers beyond the exact-signature group (recurrence already counts those).
  const exactPeers = rec ? rec.count - 1 : 0;
  const dupPeers = Math.max(0, (ctx.dupClusterSize ?? 1) - 1 - exactPeers);

  const base =
    W.blocksOut * links.blocksOut +
    W.inboundRef * links.inboundRefs +
    W.openRecurrence * openRecurrence +
    W.resolvedRecurrence * resolvedRecurrence +
    W.dupPeer * dupPeers +
    (watchdogActive ? W.watchdogActive : 0) +
    sevWeight(item.severity);

  const staleness = Math.round(stalenessMultiplier(item.ageDays) * 100) / 100;
  const score = Math.round(base * staleness * 10) / 10;

  const reasons: string[] = [];
  if (links.blocksOut > 0) reasons.push(`blocks ${links.blocksOut} downstream item(s)`);
  if (links.inboundRefs > 0) reasons.push(`${links.inboundRefs} inbound reference(s)`);
  if (openRecurrence > 0) reasons.push(`${openRecurrence} open re-capture(s) of the same friction`);
  if (dupPeers > 0) reasons.push(`${dupPeers} near-duplicate(s) filed`);
  if (watchdogActive) reasons.push('open watchdog signal (objective, recurring)');
  if (item.severity === 'critical' || item.severity === 'major') reasons.push(`${item.severity} severity`);
  if (staleness >= 1.5) reasons.push(`unattended ${Math.round(item.ageDays)}d (staleness ×${staleness})`);

  return {
    score,
    blocksOut: links.blocksOut,
    inboundRefs: links.inboundRefs,
    openRecurrence,
    resolvedRecurrence,
    dupPeers,
    watchdogActive,
    staleness,
    reasons,
  };
}

/**
 * Map the digest's recurrence + likely-duplicate clusters into per-item
 * context. The single owner of that join — the queue-ranker feature and the
 * pure reference ranking below both consume it.
 */
export function buildImpactItemContext(
  digest: Pick<ImprovementDigest, 'recurringSignatures' | 'likelyDuplicates'>,
): { recurrenceById: Map<string, SignatureRecurrence>; dupClusterSizeById: Map<string, number> } {
  const recurrenceById = new Map<string, SignatureRecurrence>();
  for (const rec of digest.recurringSignatures) {
    for (const id of rec.ids) recurrenceById.set(id, rec);
  }
  const dupClusterSizeById = new Map<string, number>();
  // digest.likelyDuplicates is null when the caller opted out of the near-dup
  // pass (nearDuplicates: false, D-002) — treat "did not run" as "no context
  // to add", same as an empty array would, never as a crash.
  for (const cluster of digest.likelyDuplicates ?? []) {
    for (const id of cluster.ids) dupClusterSizeById.set(id, cluster.ids.length);
  }
  return { recurrenceById, dupClusterSizeById };
}

/**
 * Rank the digest's human queue by blocking impact (descending). Pure: maps
 * recurrence + dup-cluster context out of the digest itself; ties break on the
 * existing triage score, then id (deterministic). The REFERENCE ordering —
 * production ranks through lib/queue-ranker/ (one weighted feature today, so
 * the orders are identical; the equivalence test keeps it that way until a
 * second feature deliberately changes the order).
 */
export function rankHumanQueueByImpact(
  digest: Pick<ImprovementDigest, 'humanQueue' | 'recurringSignatures' | 'likelyDuplicates'>,
  ctx: BlockingImpactContext = {},
): ImpactRankedItem[] {
  const { recurrenceById, dupClusterSizeById } = buildImpactItemContext(digest);
  return digest.humanQueue
    .map<ImpactRankedItem>((item) => ({
      ...item,
      impact: computeBlockingImpact(item, {
        ...ctx,
        recurrence: recurrenceById.get(item.id),
        dupClusterSize: dupClusterSizeById.get(item.id),
      }),
    }))
    .sort(
      (a, b) =>
        b.impact.score - a.impact.score || b.score - a.score || a.id.localeCompare(b.id),
    );
}
