/**
 * tools-search — capability search + relevance ranking over the resolved
 * tool-discovery entries (`tool-distribution-discovery-2026-06-08` P-005,
 * the Discovery lane's search core).
 *
 * The base plan's Tools view (`tools-discovery.ts`) answered *who provides
 * each tool?* and let the UI substring-filter the name. This adds the missing
 * half: **search the 380-tool catalog by capability** — match a query against
 * each tool's name, its category (namespace), its capability gate, the
 * providing unit, and the tool/unit description, then rank by relevance so the
 * best provider for "pack a repo" / "send a message" surfaces first.
 *
 * A focused field-weighted scorer rather than `@papercusp/rrf`: rank fusion
 * deliberately discards score magnitude + field semantics, but here a
 * name-exact match must ALWAYS outrank a description hit — an ordering RRF
 * can't express. The weights below encode that (name ≫ category/capability ≫
 * provider ≫ description). Pure + unit-testable; the route does the IO.
 */
import type { ToolDiscoveryEntry } from './tools-discovery';

/** Lowercase + split on any non-alphanumeric run (`coord:send` → coord, send). */
export function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/i).filter((t) => t.length > 0);
}

/**
 * The tool's category = its namespace prefix (`coord:send` → `coord`,
 * `repomix.pack` → `repomix`). The natural grouping for the UI's category
 * facets + the search's mid-weight signal. A separatorless name is its own
 * category.
 */
export function categoryOf(tool: string): string {
  const i = tool.search(/[:.]/);
  return (i > 0 ? tool.slice(0, i) : tool).toLowerCase();
}

/** Searchable field of an entry, with its relevance weight. */
interface WeightedField {
  text: string;
  tokens: string[];
  weight: number;
}

/** name ≫ category/capability ≫ provider ≫ description ≫ argSchema (see file head). */
export const FIELD_WEIGHTS = {
  name: 10,
  category: 5,
  capability: 4,
  provider: 3,
  description: 2,
  // Lowest signal: arg names/docs are a weak last-resort match (a query word
  // that only appears in a parameter name shouldn't outrank a description hit).
  argSchema: 1,
} as const;

function fieldsOf(e: ToolDiscoveryEntry): WeightedField[] {
  const fields: WeightedField[] = [];
  const push = (text: string | null | undefined, weight: number) => {
    if (!text) return;
    const lower = text.toLowerCase();
    fields.push({ text: lower, tokens: tokenize(lower), weight });
  };
  push(e.tool, FIELD_WEIGHTS.name);
  push(e.category, FIELD_WEIGHTS.category);
  push(e.capability, FIELD_WEIGHTS.capability);
  push(e.provider?.name, FIELD_WEIGHTS.provider);
  if (e.unit?.name && e.unit.name !== e.provider?.name) push(e.unit.name, FIELD_WEIGHTS.provider);
  push(e.description, FIELD_WEIGHTS.description);
  if (e.unit?.description && e.unit.description !== e.description) {
    push(e.unit.description, FIELD_WEIGHTS.description);
  }
  push(e.argSchema, FIELD_WEIGHTS.argSchema);
  return fields;
}

/** How well one query token hits one field: exact token ≫ token-prefix ≫ substring. */
function tokenFieldTier(qt: string, f: WeightedField): number {
  if (f.tokens.includes(qt)) return 1;
  if (qt.length >= 2 && f.tokens.some((t) => t.startsWith(qt))) return 0.6;
  if (qt.length >= 2 && f.text.includes(qt)) return 0.3;
  return 0;
}

/**
 * Query-side stopwords — articles / prepositions / conjunctions / pronouns /
 * copula that carry no capability signal. Dropped so a natural-language query
 * ("send a message to a peer") matches on its content words instead of failing
 * because every filler word must also land. Field text keeps all tokens; only
 * the query is filtered.
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'to', 'of', 'for', 'and', 'or', 'in', 'on', 'at', 'by',
  'with', 'from', 'into', 'my', 'your', 'our', 'me', 'i', 'is', 'are', 'be',
  'am', 'that', 'this', 'it', 'as',
]);

/**
 * Tokenize a query and drop stopwords. Falls back to the raw tokens when the
 * query is *all* stopwords, so such a query still does something.
 */
export function contentTokens(query: string): string[] {
  const all = tokenize(query);
  const content = all.filter((t) => !STOPWORDS.has(t));
  return content.length > 0 ? content : all;
}

/**
 * Relevance of one entry for a query. **OR across content tokens** (stopwords
 * dropped): an entry matches if AT LEAST ONE token hits some field — a
 * natural-language query shouldn't require every word to land. Each matched
 * token adds the best (weight × tier) it achieves on any field, so broader
 * coverage scores higher; a whole-query contiguous hit on the name adds a
 * phrase boost so an exact / substring name match leads.
 */
export function scoreTool(entry: ToolDiscoveryEntry, query: string): number {
  const qTokens = contentTokens(query);
  if (qTokens.length === 0) return 0;
  const fields = fieldsOf(entry);
  let total = 0;
  let matched = 0;
  for (const qt of qTokens) {
    let best = 0;
    for (const f of fields) best = Math.max(best, f.weight * tokenFieldTier(qt, f));
    if (best > 0) {
      total += best;
      matched += 1;
    }
  }
  if (matched === 0) return 0; // no content token hit → not a match
  const raw = query.trim().toLowerCase();
  if (raw.length >= 2) {
    const name = entry.tool.toLowerCase();
    if (name === raw) total += 50;
    else if (name.includes(raw)) total += 12;
    else if ((entry.description ?? '').toLowerCase().includes(raw)) total += 4;
  }
  return total;
}

export interface ToolSearchOptions {
  /** Cap the result count (the highest-ranked `limit` entries). */
  limit?: number;
}

/**
 * Rank entries by relevance to `query`, dropping non-matches. Ties break by
 * tool name (stable, alphabetical). An empty query returns every entry sorted
 * by name — the neutral browse order, so the caller can use this for both
 * "search" and "list".
 */
export function searchTools(
  entries: readonly ToolDiscoveryEntry[],
  query: string,
  opts: ToolSearchOptions = {},
): ToolDiscoveryEntry[] {
  const q = query.trim();
  if (!q) return [...entries].sort((a, b) => a.tool.localeCompare(b.tool));
  const scored: Array<{ entry: ToolDiscoveryEntry; score: number }> = [];
  for (const entry of entries) {
    const score = scoreTool(entry, q);
    if (score > 0) scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score || a.entry.tool.localeCompare(b.entry.tool));
  const list = opts.limit && opts.limit > 0 ? scored.slice(0, opts.limit) : scored;
  return list.map((s) => s.entry);
}
