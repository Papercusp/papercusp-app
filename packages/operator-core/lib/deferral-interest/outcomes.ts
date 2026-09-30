/**
 * outcomes.ts — realized-deferral-cost backfill core (self-learning-frontier
 * P-042 / FB-14). PURE: no PG, no IO — the store reads candidates + timestamped
 * edges, this module turns them into training outcomes.
 *
 * A DEFERRAL is an improvement that sat (or sits) in the HUMAN lane: the risk
 * policy replay says tier='human' (partitionByTier — the same split the live
 * digest uses), or it was explicitly routed there (needsHuman). For each one we
 * reconstruct the deferral WINDOW and count what actually accrued downstream
 * while it sat:
 *
 *   - outbound `blocks` edges created in-window (something got blocked on it)
 *   - inbound reference edges created in-window (work kept pointing at it)
 *   - re-captures: other items sharing the stable friction signature
 *     (dedupSignature — the digest's matcher) filed in-window
 *   - near-duplicate peers (likelyDuplicates clusters) filed in-window,
 *     beyond the exact-signature group — mirroring blocking-impact's split
 *
 * realizedCost weights these with BLOCKING_IMPACT_WEIGHTS, so the learned
 * pricing and B-08's static score share ONE unit ("one minor thing waiting") —
 * the ranker can compare features without a conversion (D-005/D-006).
 *
 * Honest v0 approximations (stated, not hidden — the brief's weak-coefficients
 * note): the window opens at createdAt (capture starts the owner-attention
 * clock); for a decided item it closes at updatedAt (the last lifecycle touch —
 * resolution is typically the final write, but any later payload touch shifts
 * it); the policy replay applies TODAY'S tier policy to historical rows. All
 * three sharpen automatically as real decided outcomes accumulate.
 */

import type { ImprovementCandidate } from '../harness/improvements/policy';
import { partitionByTier, DEFAULT_RISK_TIER_POLICY, type RiskTierPolicy } from '../harness/improvements/policy';
import { dedupSignature, findLikelyDuplicates } from '../harness/improvements/digest';
import { BLOCKING_IMPACT_WEIGHTS } from '../harness/improvements/blocking-impact';

const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_MS = 7 * DAY_MS;

/** One timestamped coord_links edge touching an issue (the store's read shape). */
export interface TimedEdge {
  issueId: string;
  direction: 'out' | 'in';
  rel: string;
  /** Edge created_at, epoch ms. */
  atMs: number;
}

/** Creation-time feature buckets — everything here is known the moment a
 *  deferral is created, so the model can price BEFORE any outcome exists. */
export interface DeferralFeatures {
  severity: 'critical' | 'major' | 'minor' | 'nit';
  kind: string;
  /** Carries an objective watchdog signal identity. */
  watchdog: boolean;
  /** Who filed it (sourceRole; undefined = human/legacy). */
  source: string;
  scopeKind: 'operator' | 'harness';
}

export function deferralFeaturesOf(c: ImprovementCandidate): DeferralFeatures {
  return {
    severity: c.severity ?? 'minor',
    kind: c.kind,
    watchdog: Boolean(c.watchdogKey),
    source: c.sourceRole ?? 'human',
    scopeKind: c.scope.startsWith('harness:') ? 'harness' : 'operator',
  };
}

/** The named-bucket projection the model learns over — every bucket name is a
 *  human-readable coefficient key (D-005: inspectable weights). */
export function featureBuckets(f: DeferralFeatures): string[] {
  return [
    `severity:${f.severity}`,
    `kind:${f.kind}`,
    `watchdog:${f.watchdog ? 'yes' : 'no'}`,
    `source:${f.source}`,
    `scope:${f.scopeKind}`,
  ];
}

/** One historical deferral with its realized downstream cost. */
export interface DeferralOutcome {
  id: string;
  features: DeferralFeatures;
  /** Window: capture → decision (or → now for a still-open deferral). */
  deferredAtMs: number;
  decidedAtMs: number | null;
  daysDeferred: number;
  weeksDeferred: number;
  /** In-window realized counts. */
  blocksOut: number;
  inboundRefs: number;
  recaptures: number;
  dupPeers: number;
  /** BLOCKING_IMPACT_WEIGHTS-weighted total — B-08's unit. */
  realizedCost: number;
}

export interface ComputeOutcomesOptions {
  /** Clock for still-open windows + deterministic tests. */
  nowMs: number;
  policy?: RiskTierPolicy;
  /** Drop windows shorter than this (a decision within the hour is triage,
   *  not a deferral — near-zero exposure rows just add noise). Default 1h. */
  minWindowMs?: number;
}

const DEFAULT_MIN_WINDOW_MS = 60 * 60 * 1000;

function parseMs(ts: string | undefined): number | null {
  if (!ts) return null;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The backfill: historical human-lane items → realized downstream blockage.
 * Pure + deterministic given (candidates, edges, nowMs).
 */
export function computeDeferralOutcomes(
  candidates: readonly ImprovementCandidate[],
  edges: readonly TimedEdge[],
  opts: ComputeOutcomesOptions,
): DeferralOutcome[] {
  const policy = opts.policy ?? DEFAULT_RISK_TIER_POLICY;
  const minWindowMs = opts.minWindowMs ?? DEFAULT_MIN_WINDOW_MS;
  const all = [...candidates];
  const { decisions } = partitionByTier(all, policy);

  // Edge index: per issue, out-blocks + inbound-ref timestamps.
  const outBlocksByIssue = new Map<string, number[]>();
  const inboundRefsByIssue = new Map<string, number[]>();
  const pushTo = (map: Map<string, number[]>, key: string, value: number): void => {
    const arr = map.get(key);
    if (arr) arr.push(value);
    else map.set(key, [value]);
  };
  for (const e of edges) {
    if (e.direction === 'out' && e.rel === 'blocks') pushTo(outBlocksByIssue, e.issueId, e.atMs);
    else if (e.direction === 'in' && e.rel !== 'tagged' && e.rel !== 'blocks') pushTo(inboundRefsByIssue, e.issueId, e.atMs);
  }

  // Signature groups (the digest's stable matcher) for in-window re-captures.
  const createdMsById = new Map<string, number | null>(all.map((c) => [c.id, parseMs(c.createdAt)]));
  const bySignature = new Map<string, string[]>();
  for (const c of all) {
    const sig = dedupSignature(c.title);
    if (!sig) continue;
    const arr = bySignature.get(sig) ?? [];
    arr.push(c.id);
    bySignature.set(sig, arr);
  }
  const sigPeersById = new Map<string, string[]>();
  for (const ids of bySignature.values()) {
    if (ids.length < 2) continue;
    for (const id of ids) sigPeersById.set(id, ids.filter((other) => other !== id));
  }
  // Near-dup clusters beyond the exact-signature group (B-08's dupPeers split).
  const dupPeersById = new Map<string, string[]>();
  for (const cluster of findLikelyDuplicates(all)) {
    for (const id of cluster.ids) {
      const sigPeers = new Set(sigPeersById.get(id) ?? []);
      const peers = cluster.ids.filter((other) => other !== id && !sigPeers.has(other));
      if (peers.length > 0) dupPeersById.set(id, peers);
    }
  }

  const inWindow = (ms: number | null | undefined, start: number, end: number): boolean =>
    typeof ms === 'number' && ms >= start && ms <= end;
  const countInWindow = (stamps: number[] | undefined, start: number, end: number): number =>
    stamps ? stamps.filter((ms) => inWindow(ms, start, end)).length : 0;
  const countPeersInWindow = (peers: string[] | undefined, start: number, end: number): number =>
    peers ? peers.filter((id) => inWindow(createdMsById.get(id), start, end)).length : 0;

  const W = BLOCKING_IMPACT_WEIGHTS;
  const out: DeferralOutcome[] = [];
  for (const c of all) {
    const isHumanLane = decisions[c.id]?.tier === 'human' || c.needsHuman === true;
    if (!isHumanLane) continue;
    const deferredAtMs = parseMs(c.createdAt);
    if (deferredAtMs === null) continue;
    const decided = (c.state ?? 'open') !== 'open';
    const decidedAtMs = decided ? (parseMs(c.updatedAt) ?? opts.nowMs) : null;
    const endMs = Math.min(decidedAtMs ?? opts.nowMs, opts.nowMs);
    const windowMs = endMs - deferredAtMs;
    if (windowMs < minWindowMs) continue;

    const blocksOut = countInWindow(outBlocksByIssue.get(c.id), deferredAtMs, endMs);
    const inboundRefs = countInWindow(inboundRefsByIssue.get(c.id), deferredAtMs, endMs);
    const recaptures = countPeersInWindow(sigPeersById.get(c.id), deferredAtMs, endMs);
    const dupPeers = countPeersInWindow(dupPeersById.get(c.id), deferredAtMs, endMs);

    const realizedCost =
      W.blocksOut * blocksOut +
      W.inboundRef * inboundRefs +
      W.openRecurrence * recaptures +
      W.dupPeer * dupPeers;

    out.push({
      id: c.id,
      features: deferralFeaturesOf(c),
      deferredAtMs,
      decidedAtMs,
      daysDeferred: Math.round((windowMs / DAY_MS) * 10) / 10,
      weeksDeferred: windowMs / WEEK_MS,
      blocksOut,
      inboundRefs,
      recaptures,
      dupPeers,
      realizedCost,
    });
  }
  return out;
}
