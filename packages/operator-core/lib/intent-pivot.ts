/**
 * intent-pivot — mechanical pivot detection between consecutive declared
 * intents (deterministic-context-carry-2026-07-14 P-015; plan D-006:
 * embedding use is EXTRACTIVE only — distance math over verbatim text, no
 * generative summarization).
 *
 * WHY: a sharp pivot in an agent's declared intent ("fix the FS watcher" →
 * "rewrite ingestion on polling") usually means the previous approach
 * DEAD-ENDED — and dead ends recorded nowhere get faithfully re-tried by
 * successors. The system can detect the pivot mechanically at declare time
 * (it holds both intent strings) and nudge the agent toward the typed slot:
 * `facts:assert { slot: 'dead-end' }`.
 *
 * Distance: embedding cosine when an embedder is supplied and answers within
 * budget; deterministic lexical Jaccard otherwise (the method is reported, so
 * a reader knows which space the number lives in). ADVISORY ONLY — a pivot is
 * often legitimate (new directive, finished unit); the nudge says "if it
 * dead-ended, record it", never "you did something wrong".
 */
import { withBoundedTimeout } from './bounded-timeout';

/** Embedding budget — declare-intent has a timeout history (EI-9484); the
 *  pivot leg must stay a rounding error on the call. */
export const PIVOT_EMBED_BUDGET_MS = 1_500;

/** Below this cosine similarity, consecutive intents are a PIVOT. */
export const PIVOT_EMBED_MAX_SIM = 0.35;
/** Below this Jaccard similarity, consecutive intents are a PIVOT (lexical
 *  space is much sparser than embedding space — the bar sits lower). */
export const PIVOT_LEXICAL_MAX_SIM = 0.12;

/** Intents shorter than this carry too little signal to compare. */
const MIN_INTENT_CHARS = 12;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'onto', 'then',
  'them', 'its', 'per', 'via', 'now', 'next', 'all', 'are', 'was', 'were',
  'has', 'have', 'had', 'not', 'but', 'can', 'will', 'work', 'working',
  'resume', 'continue', 'continuing', 'implement', 'implementing', 'plan',
]);

/** Lowercased content tokens (length ≥ 3, stopwords out). Ids like P-015 /
 *  WI-4820 survive tokenization — plan/item continuity SHOULD read as
 *  similarity (moving P-014 → P-015 in one plan is not a pivot of approach). */
export function intentTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/[a-z0-9][a-z0-9-]{2,}/g)) {
    if (!STOPWORDS.has(m[0])) out.add(m[0]);
  }
  return out;
}

export function lexicalIntentSimilarity(a: string, b: string): number {
  const ta = intentTokens(a);
  const tb = intentTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export interface IntentPivotResult {
  pivot: boolean;
  /** Which space the similarity number lives in. */
  method: 'embedding' | 'lexical';
  similarity: number;
  prevIntent: string;
}

export type EmbedTextFn = (text: string) => Promise<number[]>;

/**
 * Compare consecutive intents. Returns null when there is nothing to compare
 * (no/short previous intent, identical strings). Fail-soft: an embedder error
 * or timeout degrades to the lexical method, never throws.
 */
export async function detectIntentPivot(
  prevIntent: string | null | undefined,
  nextIntent: string,
  opts: { embed?: EmbedTextFn; timeoutMs?: number } = {},
): Promise<IntentPivotResult | null> {
  const prev = (prevIntent ?? '').trim();
  const next = nextIntent.trim();
  if (prev.length < MIN_INTENT_CHARS || next.length < MIN_INTENT_CHARS) return null;
  if (prev === next) return null;

  if (opts.embed) {
    const embed = opts.embed;
    const { value } = await withBoundedTimeout(
      Promise.all([embed(prev), embed(next)]).then(
        ([a, b]) => cosineSimilarity(a, b),
        () => null,
      ),
      { fallback: null, timeoutMs: opts.timeoutMs ?? PIVOT_EMBED_BUDGET_MS, label: 'intent-pivot-embed' },
    );
    if (value !== null) {
      return { pivot: value < PIVOT_EMBED_MAX_SIM, method: 'embedding', similarity: value, prevIntent: prev };
    }
  }
  const sim = lexicalIntentSimilarity(prev, next);
  return { pivot: sim < PIVOT_LEXICAL_MAX_SIM, method: 'lexical', similarity: sim, prevIntent: prev };
}

const PREV_INTENT_CAP = 160;

/** The advisory nudge folded into a declare-intent response on a pivot. */
export function pivotHint(result: IntentPivotResult): string {
  return (
    `intent pivot detected (${result.method} similarity ${result.similarity.toFixed(2)} vs previous intent ` +
    `"${result.prevIntent.slice(0, PREV_INTENT_CAP)}"). If the previous approach DEAD-ENDED, record it in the ` +
    `typed slot so no successor retries it: facts:assert { slot: 'dead-end', key: '<what>', body: '<approach + ` +
    `why it failed>', sourceRef: '<evidence>' }. If it is merely paused, checkpoint it on its work-item first. ` +
    `A legitimate pivot (new directive, finished unit) needs no action. deterministic-context-carry P-015.`
  );
}
