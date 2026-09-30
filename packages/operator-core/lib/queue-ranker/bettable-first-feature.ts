/**
 * bettable-first — the D-006 "bettable, not clever" signal on the human lane
 * (su-ideate-learning-substrate-2026-07-10 P-007).
 *
 * An idea that ships a COMPLETE cheap falsifiable experiment
 * (payload.ideation.cheapExperiment — hypothesis + method + falsifiableSignal,
 * each substantive; persisted at capture, judged by scout/invariants
 * `isBettable`) ranks ahead of otherwise-equal peers: it is the cheapest idea
 * to test, so it should reach a decision first. Every such item carries the
 * machine-checkable `bettable: true` flag — the hook a later auto-fork to
 * experiment-rail.ts `forkTestableToExperiments` consumes (the fork itself is
 * explicitly out of P-007's scope). Items carrying ANY ideation also get the
 * `ideation` struct attached so the triage tool / Learning tab render the bet +
 * experiment without a second read.
 *
 * Absence changes NOTHING (D-005 enrichment-only): an item without
 * payload.ideation contributes 0 and gains no fields, so registering this
 * feature is order-preserving until ideation-carrying captures exist.
 */

import type { ScoredItem } from '../harness/improvements/digest';
import type { CandidateIdeation } from '../harness/improvements/policy';
import { isBettable } from '../scout/invariants';
import type { HumanQueueRankContext } from './blocking-impact-feature';
import type { FeatureValue, QueueFeature } from './ranker';

/** Tunable (D-005 inspectable-weight registry): sized like owner-preference —
 *  a visible nudge among near-peers, never enough to outrank a heavy
 *  blocking-impact item. */
export const BETTABLE_FIRST_WEIGHT = 2;

/** The machine-checkable completeness test — `isBettable` over the persisted
 *  (untrusted, fields-optional) payload shape, absent fields read as empty. */
export function isBettableIdeation(ideation: CandidateIdeation | undefined): boolean {
  const e = ideation?.cheapExperiment;
  if (!e) return false;
  return isBettable({
    cheapExperiment: {
      hypothesis: e.hypothesis ?? '',
      method: e.method ?? '',
      falsifiableSignal: e.falsifiableSignal ?? '',
    },
  });
}

export const bettableFirstFeature: QueueFeature<ScoredItem, HumanQueueRankContext> = {
  name: 'bettable-first',
  weight: BETTABLE_FIRST_WEIGHT,
  description:
    'Idea ships a complete cheap falsifiable experiment (hypothesis + method + falsifiable signal — D-006 bettable-not-clever): cheapest to test, so it surfaces first; `bettable: true` is the machine hook for a later experiment-rail auto-fork.',
  score(items, ctx) {
    const byId = new Map((ctx.candidates ?? []).map((c) => [c.id, c]));
    const out = new Map<string, FeatureValue>();
    for (const item of items) {
      const ideation = byId.get(item.id)?.ideation;
      if (!ideation) continue; // no ideation ⇒ no value, no attach — byte-identical item
      const bettable = isBettableIdeation(ideation);
      out.set(item.id, {
        value: bettable ? 1 : 0,
        reasons: bettable
          ? ['ships a complete cheap falsifiable experiment (bettable, D-006) — cheapest to test first']
          : [],
        attach: { ideation, ...(bettable ? { bettable: true } : {}) },
      });
    }
    return out;
  },
};
