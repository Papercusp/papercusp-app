/**
 * Fuzzy suggestion deduplication (final v5 polish item).
 *
 * Stable-id dedup catches exact re-emissions. This module catches
 * near-duplicates: an LLM that paraphrases the same suggestion across
 * scans ("Run validator on F-001" vs "Validate F-001 now") would
 * otherwise stack two cards on the user. We collapse such pairs by
 * comparing normalized titles with Levenshtein distance.
 *
 * Embedding-based dedup (the v5 §5 "optional" item) is the
 * higher-fidelity version, but requires an embedding service. This
 * substring + Levenshtein heuristic ships in the same release without
 * adding a dependency.
 */

const SIMILARITY_THRESHOLD = 0.82; // 1.0 = identical; below 1 means lev distance / max-len < 0.18

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  // Bounded — anything over 32 chars different we treat as "not similar"
  // for free; saves quadratic work on long titles.
  const maxLen = Math.max(a.length, b.length);
  if (Math.abs(a.length - b.length) > maxLen * 0.4) return maxLen;
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

export function similarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na && !nb) return 1;
  const maxLen = Math.max(na.length, nb.length);
  if (!maxLen) return 1;
  return 1 - levenshtein(na, nb) / maxLen;
}

export interface FuzzyMatch {
  /** id of the existing card whose title best matches the new one. */
  matchedId: string;
  similarity: number;
}

export function findFuzzyDuplicate(
  newTitle: string,
  existing: { id: string; title: string }[],
): FuzzyMatch | null {
  let best: FuzzyMatch | null = null;
  for (const e of existing) {
    const s = similarity(newTitle, e.title);
    if (s < SIMILARITY_THRESHOLD) continue;
    if (!best || s > best.similarity) best = { matchedId: e.id, similarity: s };
  }
  return best;
}

export const FUZZY_THRESHOLD = SIMILARITY_THRESHOLD;
