/**
 * ref-expand — WRITE-TIME REFERENCE EXPANSION for memory embedding (EI-10048).
 *
 * When a memory body mentions a work-item-class ref (WI-/EI-/F-/D-NNNN), resolve
 * that item's TITLE and append it to the text that gets EMBEDDED — never the
 * text that gets STORED (see RememberOptions.embedText in @papercusp/memory).
 * A memory that only says "resolved per WI-4028" then also matches a query
 * about the TOPIC of WI-4028, bridging a hop the flat store can't: the
 * benchmark proved flat retrieval can't span multi-hop queries (hop-recall
 * .038 absolute) and that query-time graph fusion closes it only at
 * general-lane-wrecking weights (REJECTED, D-001). Doing the hop ONCE at write
 * time costs nothing at query time and never perturbs ranking.
 *
 * LAYERING: this lives in operator-core (which can read the work-item store);
 * the generic memory backend stays generic and just embeds whatever `embedText`
 * it is handed. The ref RESOLVER is injected (a `RefResolver`) so this module
 * has no store coupling and is unit-testable with a stub — and so a future
 * resolver (plan-slug → title, P-NNN → plan-item) drops in without touching the
 * caller. BEST-EFFORT + bounded by contract: never throws; a resolver failure
 * or a wedged store yields `undefined` and the caller keeps the clean-text
 * baseline embedding.
 */

/**
 * Work-item-class reference: WI-/EI-/F-/D- + 2–20 digits. (Plan-slug and P-NNN
 * refs resolve through the same `RefResolver` seam when a resolver for them is
 * supplied; v1 wires only the work-item resolver — the dominant ref class.)
 *
 * The upper bound was 5 digits until EI-<this-item> (2026-08-09): ids on this
 * box are no longer 2-5 digits — a modern EI id is ~17 digits (e.g.
 * `EI-19988500685566622`) — and `\d{2,5}` doesn't truncate-match those, it
 * matches NOTHING: the pattern eats the first 2-5 digits, then `\b` demands a
 * word boundary, the next char is another digit (no boundary), and the regex
 * backtracks through every length in the quantifier and fails outright. So
 * every memory whose only ref was a modern EI id silently got the
 * un-enriched baseline embedding — see the module doc's recall@10 numbers
 * for what that costs. 20 digits keeps headroom well past any id width in
 * use; the SQL-side ref grammar (packages/operator-core/lib/search/embed-backfill.ts,
 * the `citedIds` P-026 target) already uses the same `{2,20}` bound — keep
 * these two in sync if either changes again.
 */
const REF_PAT = /\b((?:WI|EI|F|D)-\d{2,20})\b/g;

/** Cap the per-write resolve fan-out — a body with a wall of refs shouldn't
 *  turn one write into dozens of store lookups. */
export const MAX_REFS = 6;

const APPENDIX_PREFIX = '\n\n[refs] ';

/** Resolve one ref id to its title, or null if it doesn't resolve. */
export type RefResolver = (id: string) => Promise<{ id: string; title: string } | null>;

/** Distinct work-item-class refs in `text`, in first-seen order, capped at MAX_REFS. */
export function extractRefs(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(REF_PAT)) {
    seen.add(m[1]);
    if (seen.size >= MAX_REFS) break;
  }
  return [...seen];
}

/**
 * Append resolved "ID: title" pairs to the embed-text. Returns `undefined` when
 * nothing resolved (so the caller omits `embedText` and keeps the baseline).
 */
export function buildEmbedText(
  text: string,
  resolved: ReadonlyArray<{ id: string; title: string }>,
): string | undefined {
  const parts = resolved.map((r) => `${r.id}: ${r.title.trim()}`).filter((s) => !s.endsWith(': '));
  if (parts.length === 0) return undefined;
  return `${text}${APPENDIX_PREFIX}${parts.join('; ')}`;
}

/**
 * Extract refs from `text`, resolve their titles (in parallel, bounded), and
 * build the enriched embed-text. Returns `undefined` when the body has no refs,
 * none resolve, or the enriched text would equal the original. BEST-EFFORT:
 * never throws (each resolve is individually guarded, and the whole pass is
 * wrapped) so a caller can drop it straight into a write path.
 */
export async function expandRefsForEmbed(
  text: string,
  resolve: RefResolver,
): Promise<string | undefined> {
  try {
    const ids = extractRefs(text);
    if (ids.length === 0) return undefined;
    const hits = await Promise.all(ids.map((id) => resolve(id).catch(() => null)));
    const resolved = hits.flatMap((h, i) =>
      h && typeof h.title === 'string' && h.title.trim().length > 0
        ? [{ id: h.id || ids[i], title: h.title }]
        : [],
    );
    const out = buildEmbedText(text, resolved);
    return out && out !== text ? out : undefined;
  } catch {
    return undefined;
  }
}
