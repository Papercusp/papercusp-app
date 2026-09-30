/**
 * Phase 4 — context-aware spell/typo correction for the SEARCH query.
 *
 * Fixes the class a dictionary CAN'T: e.g. "del laptop" → "dell laptop". "del"
 * is itself a real catalog token (the `DEL <partno>` prefix on hundreds of Dell
 * titles, plus the "DEL Ozone" brand), so a keyword engine never typo-corrects
 * it — only understanding the *whole query* fixes it. The framework deciding
 * intent, not a hardcoded synonym.
 *
 * FAIL-SAFE: disabled / no key / any error / odd output → return the original
 * query untouched. Single-token queries containing a digit (SKUs / model numbers
 * like 379429-001, MAX3221CAE, U2417H) are never rewritten. An exact brand-name
 * query is never rewritten (the LLM mangles obscure brands, e.g. "ametric" →
 * "metric"); the brand check is injected via `isKnownBrand` so the lib has no
 * catalog/DB dependency. Results are cached per raw (lowercased) query in a
 * bounded process cache.
 */
export interface RewriteQueryOptions {
  /**
   * When `false`, returns the query untouched. Map your env-gate here
   * (Restart: `QUERY_REWRITE === '1'`). Defaults to enabled — the gate is the
   * caller's job, a `rewriteQuery` call should rewrite by default.
   */
  enabled?: boolean;
  /** OpenAI-compatible key. Default `process.env.OPENAI_API_KEY`. */
  apiKey?: string;
  /** Chat model. Default 'gpt-4o-mini'. */
  model?: string;
  /**
   * True if `key` (the lowercased trimmed query) is an exact catalog brand name
   * → never rewritten. Injected (sync or async) so the lib stays catalog-free.
   */
  isKnownBrand?: (key: string) => boolean | Promise<boolean>;
  /** Called when a rewrite actually changes the query — wire your logger here. */
  onRewrite?: (from: string, to: string) => void;
  /**
   * Build the correction prompt for the query. Inject your own to make rewrite
   * domain-agnostic — the default (`defaultRewritePrompt`) is electronics/
   * computer-store-specific. Must instruct the model to return ONLY the
   * corrected query text.
   */
  buildPrompt?: (query: string) => string;
}

/**
 * The default (electronics/computer/industrial-parts store) spell-correction
 * prompt. Exported so hosts can reference/extend it; pass a different
 * `buildPrompt` for a non-e-commerce domain.
 */
export function defaultRewritePrompt(q: string): string {
  return (
    'You are a spell-corrector for an electronics, computer, and industrial-parts store search box. ' +
    'Correct ONLY obvious typos and brand misspellings (e.g. "del laptop"->"dell laptop", "labtop"->"laptop", "lenvo"->"lenovo"). ' +
    'Do NOT change part numbers, model numbers, valid brands, or product types. ' +
    'If nothing needs correcting, return the query unchanged. Return ONLY the corrected query text, nothing else.\n\n' +
    `Query: ${q}`
  );
}

/** Bound the rewrite cache so a long-lived process can't grow it without limit
 *  as unique queries accumulate. FIFO-evict the oldest on overflow. */
const REWRITE_CACHE_MAX = 10_000;
const rewriteCache = new Map<string, string>();

function cacheRewrite(key: string, val: string): void {
  if (rewriteCache.size >= REWRITE_CACHE_MAX) {
    const oldest = rewriteCache.keys().next().value; // Map preserves insertion order
    if (oldest !== undefined) rewriteCache.delete(oldest);
  }
  rewriteCache.set(key, val);
}

/** Clear the process rewrite cache (test/maintenance helper). */
export function clearRewriteCache(): void {
  rewriteCache.clear();
}

export async function rewriteQuery(raw: string, opts: RewriteQueryOptions = {}): Promise<string> {
  if (opts.enabled === false) return raw;
  const q = raw.trim();
  if (!q || q.length > 60) return raw;
  // Never touch part / model numbers (single token containing a digit).
  if (!/\s/.test(q) && /\d/.test(q)) return raw;
  const key = q.toLowerCase();
  const cached = rewriteCache.get(key);
  if (cached !== undefined) return cached;
  // Never rewrite an exact brand-name query — real brands look like typos to
  // the LLM (e.g. "ametric"->"metric") and the correction tanks the results.
  if (opts.isKnownBrand && (await opts.isKnownBrand(key))) {
    cacheRewrite(key, q);
    return q;
  }
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) return raw;
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: opts.model ?? 'gpt-4o-mini',
        messages: [{ role: 'user', content: (opts.buildPrompt ?? defaultRewritePrompt)(q) }],
        temperature: 0,
        max_tokens: 30,
      }),
    });
    if (!res.ok) return raw;
    const data: any = await res.json();
    let out = String(data.choices?.[0]?.message?.content ?? '').trim();
    out = out.replace(/^["'`]+|["'`]+$/g, '').trim();
    const corrected = out && out.length <= 60 ? out : q;
    cacheRewrite(key, corrected);
    if (corrected.toLowerCase() !== key) opts.onRewrite?.(q, corrected);
    return corrected;
  } catch {
    return raw;
  }
}
