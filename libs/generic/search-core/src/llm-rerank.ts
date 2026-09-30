/**
 * §1e — live LLM category-match rerank (the robust layer).
 *
 * A runtime pass that, for the query, infers the wanted item TYPE (the head
 * noun; other words are qualifiers) and per result infers its item type and
 * whether it MATCHES the wanted type or is only related (a part/accessory/
 * for-it). Sorts MATCH-first, preserving the incoming (cross-encoder) order
 * within each bucket. Types are inferred from the TITLE per query — never a
 * stored product_type — so it's robust to wrong/missing/multi-category data.
 *
 * Unlike a cross-encoder's blended score, this makes the discrete "this IS a
 * palmrest, NOT a laptop → demote" cut. Self-corrects part-queries: "laptop
 * palmrest" → wanted = palmrest → palmrests MATCH.
 *
 * FAIL-SAFE: disabled / <2 rows / no key / error / timeout / shape mismatch →
 * input order kept. The per-row title is read via the injected `getTitle` so
 * the lib carries no catalog-schema coupling.
 */
export interface LlmRerankOptions<T> {
  /**
   * When `false`, returns rows untouched. Map your env-gate here (Restart:
   * `LLM_RERANK === '1'`). Defaults to enabled.
   */
  enabled?: boolean;
  /** OpenAI-compatible key. Default `process.env.OPENAI_API_KEY`. */
  apiKey?: string;
  /** Chat model (must support JSON mode). Default 'gpt-4.1'. */
  model?: string;
  /** Abort the call after this many ms (fail-safe to input order). Default 8000. */
  timeoutMs?: number;
  /** Extract the title the model judges each row by. */
  getTitle: (row: T) => string;
  /**
   * Build the LLM prompt for a query + the newline-numbered titles. Inject your
   * own to make the category-match domain-agnostic — the default
   * (`defaultLlmRerankPrompt`) is e-commerce-specific (product vs. accessory).
   * A custom prompt MUST still instruct the model to return the same JSON shape
   * `{"wanted_type":"…","items":[{"n":1,"match":true|false}, …]}` — llmRerank
   * parses `items[].match`.
   */
  buildPrompt?: (query: string, numberedTitles: string) => string;
}

/**
 * The default (e-commerce) LLM category-match prompt: infer the wanted item TYPE
 * (head noun) and per result decide whether it IS that type (match) or only a
 * part/accessory for it. Exported so hosts can reference/extend it; pass a
 * different `buildPrompt` for a non-e-commerce domain.
 */
export function defaultLlmRerankPrompt(query: string, numberedTitles: string): string {
  return `You are an e-commerce search ranker for the query "${query}".
First determine the item TYPE the shopper wants to buy: treat the main noun (usually the last word) as the item type, and any other brand or product name as a qualifier of what it is for or compatible with. (e.g. "laptop bag" -> a bag; "dell charger" -> a charger; "laptop" -> a laptop; "laptop palmrest" -> a palmrest.)
Then for EACH result, infer its item type from its title and decide:
- match=true  if the result IS that wanted item type (the actual product the shopper wants)
- match=false if it is only a part, component, accessory, or other product FOR that item type (even if its title contains the item's name)
If the query itself names a part or accessory, then that part IS the wanted type (match=true for those).
Results:
${numberedTitles}
Return ONLY JSON: {"wanted_type":"<short>","items":[{"n":1,"match":true|false}, ... one per result, in order]}`;
}

export async function llmRerank<T>(query: string, rows: T[], opts: LlmRerankOptions<T>): Promise<T[]> {
  if (opts.enabled === false || rows.length < 2) return rows;
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) return rows;
  try {
    // Title-driven (not the stored category): judge what each item actually IS.
    const list = rows.map((r, i) => `${i + 1}. ${opts.getTitle(r) ?? ''}`).join('\n');
    const prompt = (opts.buildPrompt ?? defaultLlmRerankPrompt)(query, list);
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: opts.model ?? 'gpt-4.1',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0,
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
    });
    if (!res.ok) return rows;
    const data: any = await res.json();
    const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? '{}');
    const items: Array<{ n: number; match: boolean }> = parsed.items ?? [];
    if (!Array.isArray(items) || items.length !== rows.length) return rows;
    // match (1-indexed n) → boolean; default true so a missing entry never demotes.
    const matchByIdx = new Map<number, boolean>();
    for (const it of items) matchByIdx.set(Number(it.n) - 1, it.match !== false);
    // Stable sort: MATCH items first, original (cross-encoder) order within each bucket.
    return rows
      .map((r, i) => ({ r, m: matchByIdx.get(i) !== false, i }))
      .sort((a, b) => (a.m === b.m ? a.i - b.i : a.m ? -1 : 1))
      .map((x) => x.r);
  } catch {
    return rows;
  }
}
