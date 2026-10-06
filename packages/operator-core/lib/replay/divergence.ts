/**
 * Deterministic divergence signals (P-020 / FB-06) — pure text comparison of a
 * replayed continuation against the historical one. These are the rawSignals
 * recorded with every cell (and the deterministic seam unit tests pin with a
 * fake LLM); the QUALITY judgment of the divergence stays with the frozen
 * eval-battery judge — these signals only measure HOW MUCH the trajectories
 * differ, never which is better.
 */

import { captureSourceHash } from '@papercusp/eval-battery';

export const REPLAY_DIVERGENCE_SOURCE_HASH = captureSourceHash(import.meta.url);

export interface DivergenceSignals {
  /** Jaccard similarity of the lowercase token sets (1 = same vocabulary). */
  tokenJaccard: number;
  /** Shared whitespace-normalized prefix ÷ longer length (1 = same opening). */
  prefixCommonRatio: number;
  /** Shorter length ÷ longer length (1 = same size). */
  lengthRatio: number;
  /** True when the trajectories meaningfully differ (tokenJaccard < threshold). */
  divergent: boolean;
}

export interface DivergenceOpts {
  /** tokenJaccard below this ⇒ divergent. */
  divergenceThreshold?: number;
}

const DEFAULT_THRESHOLD = 0.8;

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((t) => t.length > 1),
  );
}

function normalizeWs(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function divergenceSignals(
  original: string,
  replayed: string,
  opts: DivergenceOpts = {},
): DivergenceSignals {
  const threshold = opts.divergenceThreshold ?? DEFAULT_THRESHOLD;

  const a = tokens(original);
  const b = tokens(replayed);
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  const tokenJaccard = union === 0 ? 1 : intersection / union;

  const na = normalizeWs(original);
  const nb = normalizeWs(replayed);
  const longer = Math.max(na.length, nb.length);
  let common = 0;
  const limit = Math.min(na.length, nb.length);
  while (common < limit && na[common] === nb[common]) common++;
  const prefixCommonRatio = longer === 0 ? 1 : common / longer;

  const lengthRatio = longer === 0 ? 1 : Math.min(na.length, nb.length) / longer;

  return {
    tokenJaccard,
    prefixCommonRatio,
    lengthRatio,
    divergent: tokenJaccard < threshold,
  };
}
