/**
 * recipe-cooccurrence-leg.ts — the W_COOCCUR scoring leg for code-recipes promotion
 * (tool-call-batching-wrappers-2026-06-21 P-004 / D-016).
 *
 * Wires the deterministic dev:tool_cooccurrence miner (dev-data.ts) into the
 * recipe-candidate scorer's OPTIONAL `toolCooccurrence` dep (code-recipes-candidates.ts):
 * given a recipe's tool-set, returns a 0..1 "how strongly do these tools co-occur in real
 * agent turns" strength — the MEAN pairwise CONFIDENCE among the recipe's tools — or null
 * when there is no datum (so the scorer gracefully skips the leg).
 *
 * Why this is the right signal: a recipe whose tools genuinely travel together in live
 * turns (high co-occurrence) is a stronger tool-genesis candidate — the demand is proven,
 * not guessed. It re-normalizes into the rubric sum alongside run-frequency / breadth /
 * success / cohesion.
 *
 * Reuse boundary (D-010): this is the COUNTING side — deterministic co-occurrence over
 * exact tool-name keys. The recipe scorer's separate dedup/merge legs use @papercusp/search
 * (similarity); the two never cross. The miner is prefetched ONCE here and closed over, so
 * the per-recipe dep is a cheap in-memory lookup, not a query per recipe.
 */
import { toolCooccurrence, type CooccurrenceEntry } from './dev-data';

/** Order-independent pair key (matches the miner's LEAST/GREATEST tool ordering). */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}\x00${b}` : `${b}\x00${a}`;
}

export interface RecipeCooccurrenceOpts {
  /** Miner lookback window (hours). Default 168 (7d). */
  hours?: number;
  /** Min spawns a pair must co-occur in to count (noise floor). Default 2. */
  minSupport?: number;
  /** Max pairs to pull from the miner. Default 1000. */
  limit?: number;
}

/**
 * Build the `toolCooccurrence` dep for `recipeCandidates()`. Prefetches the co-occurrence
 * corpus for `workspaceId` ONCE and returns a closure that scores a recipe's tool-set in
 * 0..1 (mean pairwise confidence of the in-set pairs the miner has data for). Returns null
 * when the miner has no data or errors — the scorer then skips the leg (its four base legs
 * carry the score).
 */
export async function buildRecipeCooccurrenceDep(
  workspaceId: string,
  opts: RecipeCooccurrenceOpts = {},
): Promise<((toolsUsed: string[]) => Promise<number | null>) | null> {
  let entries: CooccurrenceEntry[];
  try {
    const res = await toolCooccurrence({
      workspaceIds: [workspaceId],
      hours: opts.hours ?? 168,
      minSupport: opts.minSupport ?? 2,
      limit: opts.limit ?? 1000,
      orderBy: 'confidence',
    });
    entries = res.entries;
  } catch {
    return null; // miner unavailable ⇒ leg skipped
  }
  if (entries.length === 0) return null;

  const confByPair = new Map<string, number>();
  for (const e of entries) confByPair.set(pairKey(e.tool_a, e.tool_b), e.confidence);

  return async (toolsUsed: string[]): Promise<number | null> => {
    const tools = [
      ...new Set((toolsUsed ?? []).filter((t): t is string => typeof t === 'string' && t.length > 0)),
    ];
    if (tools.length < 2) return null; // a single-tool recipe has no co-occurrence
    const scores: number[] = [];
    for (let i = 0; i < tools.length; i++) {
      for (let j = i + 1; j < tools.length; j++) {
        const c = confByPair.get(pairKey(tools[i], tools[j]));
        if (c != null) scores.push(c);
      }
    }
    if (scores.length === 0) return null; // no datum for any pair in this tool-set
    return scores.reduce((a, b) => a + b, 0) / scores.length;
  };
}
