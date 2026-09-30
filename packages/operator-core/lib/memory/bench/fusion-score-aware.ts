/**
 * P-031 — score-aware fusion arms for `@papercusp/search`'s RRF, as pure
 * functions so the CLI does IO and this module does the arithmetic (and can be
 * unit-tested without PG or an embedder).
 *
 * ─── THE STRUCTURAL FACT THIS MODULE IS BUILT AROUND ──────────────────────
 * Within ONE ranker's list, score order ≡ rank order BY CONSTRUCTION. Every
 * source in `agent-tools/search/sources.ts` emits either
 *   `ORDER BY ts_rank_cd(...) DESC`   with `score := rank`, or
 *   `ORDER BY <col> <=> qVec`         with `score := sim`,
 * and `applyMinScore` filters without reordering. So the list handed to fusion
 * is already sorted by the very quantity a "score-aware" weight would consult.
 *
 * CONSEQUENCE, and it is the whole point of P-031: a weight that is a monotone
 * non-decreasing function of a candidate's OWN score cannot change that
 * candidate's order relative to its own list-mates. Re-weighting can only move
 * a candidate relative to the OTHER ranker's candidates. Score-awareness is
 * therefore a CROSS-RANKER balance knob, never a within-ranker reordering — a
 * distinction `fusion-score-aware.test.ts` pins as a property test so it cannot
 * be quietly re-proposed as the former.
 */

import { rrfCombine, RRF_K_DEFAULT, type RankedItem } from '@papercusp/rrf';

export type Leg = { name: string; list: Array<RankedItem<string>> };

/** clamp((x-lo)/(hi-lo), 0, 1) — the shape every calibration here uses. */
export function ramp(x: number, lo: number, hi: number): number {
  if (!(hi > lo)) return 1;
  return Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
}

/**
 * Generic weighted-RRF driver: `weight(legName, score, leg) · 1/(k+rank)`.
 * `weight` returning a constant 1 reproduces plain RRF exactly.
 */
export function weightedRrf(
  legs: Leg[],
  weight: (legName: string, score: number, leg: Leg) => number,
  k: number = RRF_K_DEFAULT,
): string[] {
  const acc = new Map<string, number>();
  for (const leg of legs) {
    leg.list.forEach((entry, idx) => {
      const contrib = weight(leg.name, entry.score, leg) / (k + idx + 1);
      acc.set(entry.key, (acc.get(entry.key) ?? 0) + contrib);
    });
  }
  return [...acc.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);
}

export interface Arm {
  label: string;
  fuse: (legs: Leg[]) => string[];
}

/**
 * Build the arm set for one embedder's operating point.
 *
 * `embLo` is that model's embeddings floor and `embHi` sits just above the
 * highest top-1 cosine observed for it on the gold set, so the ramp spans the
 * model's ACTUAL usable score band. Passing gemma's band to another model is
 * the error `search/prose-min-score.ts` documents at length — hence parameters,
 * not constants.
 */
export function buildArms(embLo: number, embHi: number): Arm[] {
  const embWeight = (score: number): number => ramp(score, embLo, embHi);
  return [
    {
      // Calls the PRODUCTION primitive, so the baseline cannot drift from what
      // search:semantic actually runs.
      label: 'A rrf (production baseline)',
      fuse: (legs) => rrfCombine(legs.map((l) => ({ name: l.name, list: l.list }))).map((f) => f.row),
    },
    {
      label: 'B per-candidate absolute score weight (embeddings only)',
      fuse: (legs) => weightedRrf(legs, (name, score) => (name === 'embeddings' ? embWeight(score) : 1)),
    },
    {
      label: 'C per-candidate, both legs (bm25 max-normalised)',
      fuse: (legs) =>
        weightedRrf(legs, (name, score, leg) => {
          if (name === 'embeddings') return embWeight(score);
          const max = leg.list[0]?.score ?? 1;
          return max > 0 ? score / max : 1;
        }),
    },
    {
      // The variant the structural fact above actually predicts something for:
      // scale the WHOLE embeddings leg by how confident it is on this query.
      label: 'D list-confidence (whole leg scaled by its top score)',
      fuse: (legs) =>
        weightedRrf(legs, (name, _score, leg) => {
          if (name !== 'embeddings') return 1;
          return embWeight(leg.list[0]?.score ?? 0);
        }),
    },
    {
      label: 'E convex blend 0.5·normScore + 0.5·rrf',
      fuse: (legs) => {
        const acc = new Map<string, number>();
        for (const leg of legs) {
          const max = leg.list[0]?.score ?? 1;
          leg.list.forEach((entry, idx) => {
            const norm =
              leg.name === 'embeddings' ? embWeight(entry.score) : max > 0 ? entry.score / max : 0;
            // RRF values live at ~1/61; rescale by k so the blend is not degenerate.
            const rrf = (1 / (RRF_K_DEFAULT + idx + 1)) * RRF_K_DEFAULT;
            acc.set(entry.key, (acc.get(entry.key) ?? 0) + 0.5 * norm + 0.5 * rrf);
          });
        }
        return [...acc.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);
      },
    },
    // Single-leg references — the band each fusion arm should sit between.
    {
      label: 'R bm25 only',
      fuse: (legs) => (legs.find((l) => l.name === 'bm25')?.list ?? []).map((e) => e.key),
    },
    {
      label: 'R embeddings only',
      fuse: (legs) => (legs.find((l) => l.name === 'embeddings')?.list ?? []).map((e) => e.key),
    },
  ];
}

/**
 * Paired bootstrap CI on the mean per-query difference (arm − baseline).
 * Deterministic PRNG so a re-run reproduces the interval exactly — the same
 * paired-statistic discipline `paired-leg-report.ts` applies to the embedder
 * bake-off (a mean delta with no interval cannot answer "is this outside
 * noise", which is the only question that matters here).
 */
export function pairedBootstrap(
  diffs: number[],
  iters = 10000,
  seed0 = 20260803,
): { mean: number; lo: number; hi: number } {
  const n = diffs.length;
  if (n === 0) return { mean: 0, lo: 0, hi: 0 };
  const mean = diffs.reduce((s, x) => s + x, 0) / n;
  const means: number[] = [];
  let seed = seed0;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let b = 0; b < iters; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += diffs[Math.floor(rnd() * n)]!;
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  return { mean, lo: means[Math.floor(0.025 * iters)]!, hi: means[Math.floor(0.975 * iters)]! };
}
