/**
 * work-item-ref — the ONE place that reads a work-item id (and the harness
 * qualifying it) out of a COMPOSITE ref token.
 *
 * Why this is shared rather than a regex at each call site: an anchored
 * `^(WI|EI|F)-\d+$` test against a whole ref token is the intuitive spelling and
 * it is WRONG for essentially every ref this app actually produces. That mistake
 * shipped independently at two different destinations, both marked "unit tested
 * green", and both were dead on the live app:
 *
 *   · the HUD Work-items board (WI-6596, 2026-07-28) — 60 of 60 cards were
 *     silent no-ops, because a card id is `ask:work-item-needs-human:WI-1142`
 *     and a card `ref` is a DISPLAY label ("Work item"), never a bare id;
 *   · the chat status-card drill-in (2026-07-28, this module's second caller) —
 *     the curator emits `wi:papercusp#WI-6594` (`curation/deps.ts`), so the
 *     anchored test failed and the harness-qualified token was passed through
 *     verbatim as the work-item ID. Measured live: the popup opened on
 *     `papercusp#WI-6594` and rendered "No item found for papercusp#WI-6594."
 *
 * The through-line is that a ref token is a PATH: `<qualifier>(:|#)…<id>`, with
 * the id LAST. So read the trailing segment; never match the whole token.
 *
 * ⚠ Hand-written fixtures hide this bug rather than catching it — the natural
 * fixture is a bare `WI-7`, a shape no producer in this app emits. Tests for
 * either caller must use strings read off the LIVE app / the real producers.
 *
 * Pure, no React, no IO.
 */

/** A work-item id (WI-/EI-/F-), anchored — correct ONLY against a single
 *  already-isolated segment, never against a whole composite ref token. */
export const WORK_ITEM_ID = /^(WI|EI|F)-\d+$/i;

/** The work-item id carried by a composite token, read from its TRAILING
 *  segment and normalized to uppercase; null when the last segment is not an
 *  id. A token whose id is GLUED into a larger word (`XWI-123`, `WI-123abc`)
 *  is deliberately not a match — pointing a popup at the wrong item is worse
 *  than opening nothing. */
export function trailingWorkItemId(token: string | null | undefined): string | null {
  if (!token) return null;
  const last = token.split(/[:#]/).pop();
  return last && WORK_ITEM_ID.test(last) ? last.toUpperCase() : null;
}

export interface QualifiedWorkItemRef {
  /** The harness the id belongs to, when the token names one — i.e. the segment
   *  immediately before a `#`. Work-item lookups are harness-scoped, so a
   *  qualified ref carries everything needed to open the item WITHOUT a
   *  surrounding harness context (the `?slug`-derived one is absent on
   *  cross-harness surfaces, and falling back to it is what made a
   *  harness-qualified curator ref unopenable). */
  harness: string | null;
  /** The work-item id, or null when the token does not end in one. */
  id: string | null;
}

/**
 * Split a possibly harness-qualified ref token into its harness + work-item id.
 *
 * `papercusp#WI-6594`         → { harness: 'papercusp', id: 'WI-6594' }
 * `wi:papercusp#WI-6594`      → { harness: 'papercusp', id: 'WI-6594' }
 * `WI-6594`                   → { harness: null,        id: 'WI-6594' }
 * `ask:owner-wall:WI-4271`    → { harness: null,        id: 'WI-4271' }  (`:` is
 *                               not a harness qualifier — those segments are ask
 *                               KINDS, and reading one as a harness would scope a
 *                               lookup to a harness that does not exist)
 * `health:some-panel`         → { harness: null,        id: null }
 */
export function splitQualifiedWorkItemRef(
  token: string | null | undefined,
): QualifiedWorkItemRef {
  const id = trailingWorkItemId(token);
  if (!id) return { harness: null, id: null };
  const t = String(token);
  const hash = t.lastIndexOf('#');
  if (hash < 0) return { harness: null, id };
  const harness = t.slice(0, hash).split(/[:#]/).pop() || null;
  return { harness, id };
}
