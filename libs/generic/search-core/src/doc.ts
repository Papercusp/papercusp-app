/**
 * §1c — the rerank "document": the text a cross-encoder scores against the query.
 *
 * Configurable mode (Restart wires it behind RERANK_DOC_MODE):
 *  - `title`           bare title.
 *  - `title_category`  title + " — <product type>" (legacy). A WRONG stored
 *                      category misleads zerank (a palmrest reading "notebook
 *                      computer"), so this is only safe on a cleaned taxonomy.
 *  - `title_desc`      (default) title + a 240-char description slice. Category-
 *                      FREE: robust to the uncleaned catalog tail.
 *
 * Pure: the caller maps its row fields onto {title, description, productType}.
 */
export type RerankDocMode = 'title' | 'title_category' | 'title_desc';

export interface RerankDocFields {
  title?: string | null;
  description?: string | null;
  /** Stored item type / category; only consulted by the `title_category` mode. */
  productType?: string | null;
}

export function buildRerankDoc(fields: RerankDocFields, mode: RerankDocMode = 'title_desc'): string {
  const title = fields.title ?? '';
  if (mode === 'title') return title.trim();
  if (mode === 'title_category') {
    return `${title} — ${(fields.productType ?? '').replace(/_/g, ' ').toLowerCase()}`.trim();
  }
  const desc = typeof fields.description === 'string' ? fields.description.trim().slice(0, 240) : '';
  return desc ? `${title}. ${desc}` : title.trim();
}
