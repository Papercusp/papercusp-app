/**
 * §1d — the adapted ZeroEntropy instruction-following template (default).
 *
 * Generic + universal: a single static instruction applied to EVERY query — no
 * per-query rules. The head-noun rule parses the query's item type, then steers
 * an instruction-following reranker (zerank-2) to rank the actual item above its
 * parts/accessories, defer to part-queries, and prefer brand/model match.
 *
 * Project-agnostic: the only catalog-specific line is the opening "we sell …"
 * inventory sentence, kept here as the default; callers that sell something else
 * pass their own instruction string. Override per-call via the reranker's
 * `instruction` option (Restart wires it behind a RERANK_INSTRUCTION gate).
 */
export const DEFAULT_RERANK_INSTRUCTION = [
  'We sell computers, computer parts, printers and ink/toner, cameras and lenses, networking gear, electronics, tools, and office and industrial supplies.',
  "Judge what each result actually IS from its title and description; do not assume any category label is correct. The shopper's query names the kind of item they want: treat the main noun (usually the last word) as the item TYPE, and any other brand or product name as a qualifier of what that item is for or is compatible with.",
  'Examples: "laptop bag" wants a bag (for laptops); "dell charger" wants a charger (for Dell); "laptop" wants a laptop itself; "laptop palmrest" wants a palmrest (a laptop part); "hp toner" wants a toner cartridge (for HP printers).',
  'Rank highest the results that ARE the exact item type the query asks for. Rank below them results that are only parts, components, or accessories for that item, or the products it attaches to — even if their title contains the item\'s name. If the query itself names a part or accessory, that part IS the requested item and ranks highest. Among equally-matching items, prefer those matching the brand and specific model named in the query.',
].join('\n');
