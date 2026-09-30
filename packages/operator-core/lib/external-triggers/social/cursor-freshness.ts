/**
 * How fresh is a social source's persisted cursor?
 *
 * WHY THIS IS NOT A ONE-LINE `cursor.watermark` READ.
 *
 * `SocialReconcileResult.cursor` is typed `unknown` on purpose: every adapter
 * owns its own cursor shape, and the eight that exist today do NOT agree on a
 * field name or even on whether a cursor carries a time at all.
 *
 *   watermark      + boundaryIds     — threads, facebook-pages, youtube comments
 *   watermark      + seenAtWatermark — instagram   (the same idea, drifted name)
 *   publishedAfter + boundaryIds     — youtube activities
 *   minId          + lastEventAt?    — mastodon    (time OPTIONAL)
 *   seq            + lastEventAt?    — bluesky     (time OPTIONAL)
 *   newestFullname                   — reddit      (NO time, by design)
 *
 * So a pane that reads `cursor.watermark` is correct for three platforms and
 * silently null for the rest — and a null renders as "never synced", which is
 * indistinguishable from a genuinely dead integration. Reddit would report
 * "never synced" forever while working perfectly, because an opaque `t3_…`
 * fullname is a POSITION, not an instant.
 *
 * Hence four states rather than a nullable timestamp. `position-only` is the
 * one that earns its keep: it says "this cursor is advancing, and this platform
 * cannot tell you when" — a true statement that neither `synced` nor
 * `never-synced` can express, and the difference between a calm reading and a
 * false alarm.
 *
 * The field lists below are pinned against the real adapter interfaces by
 * `cursor-freshness.test.ts`, so a ninth cursor shape fails that test instead of
 * quietly degrading this to `unrecognized`.
 */

import { socialInstantMs } from './social-watermark';

/**
 * Fields that carry a provider INSTANT, newest-first in preference order.
 *
 * `watermark` and `publishedAfter` are the mark itself. `lastEventAt` is last
 * because it is the optional companion on a position cursor (bluesky, mastodon)
 * — present it when the adapter recorded it, but never require it.
 */
export const SOCIAL_CURSOR_INSTANT_FIELDS = ['watermark', 'publishedAfter', 'lastEventAt'] as const;

/**
 * Fields that carry an opaque PROVIDER POSITION and no time.
 *
 * A cursor holding only these is healthy — it is how the platform paginates.
 * It is emphatically not an error state, which is the whole reason
 * `position-only` exists as a separate verdict.
 */
export const SOCIAL_CURSOR_POSITION_FIELDS = ['minId', 'seq', 'newestFullname'] as const;

/**
 * Boundary-id sets: the ids already emitted AT the mark, carried to break ties.
 *
 * They say nothing about freshness, so they are classified purely so the drift
 * test can prove every field of every cursor interface is accounted for.
 * The two spellings are real drift between adapters, tracked by WI-41027 — this
 * module tolerates both rather than pretending the divergence is not there.
 */
export const SOCIAL_CURSOR_BOUNDARY_FIELDS = ['boundaryIds', 'seenAtWatermark'] as const;

export type SocialCursorState =
  /** An instant was recovered; `at` and `ageMs` are meaningful. */
  | 'synced'
  /** The cursor is advancing but carries no instant BY DESIGN. Not a fault. */
  | 'position-only'
  /** No cursor has been persisted yet — cold, never reconciled. */
  | 'never-synced'
  /** A cursor is stored but matches no shape we know. A defect signal. */
  | 'unrecognized'
  /**
   * The PLATFORM has no readable content stream at any grant tier we hold, so
   * there is no cursor to be fresh or stale (LinkedIn, P-021: `read: null`).
   *
   * This is D-050's own rule applied one level up. D-050 exists because reading
   * `cursor.watermark` directly reported healthy reddit/bluesky/mastodon
   * sources as "never synced" forever — a warning state that no action could
   * clear. A write-only platform hits that same wall harder: it will NEVER
   * reconcile, so `never-synced` would be permanently true, permanently
   * alarming, and permanently not actionable. The two situations look identical
   * on the pane and mean opposite things ("nobody has run this yet" vs "this
   * can never run"), so they get different states.
   *
   * This verdict is NOT derivable from a cursor — the cursor is genuinely empty
   * either way — so `socialCursorFreshness` cannot return it. Only a caller
   * holding the registry row can, which is why `socialAdminFacts` short-circuits
   * on `read === null` before classifying.
   */
  | 'not-readable';

export interface SocialCursorFreshness {
  state: SocialCursorState;
  /** The provider instant, VERBATIM as the provider spelled it. Null unless `synced`. */
  at: string | null;
  /**
   * Age of `at` in ms. Null unless `synced`.
   *
   * MAY BE NEGATIVE, and is deliberately not clamped: a negative age means the
   * provider's instant is ahead of our clock, which is a skew signal worth
   * seeing. Clamping it to zero would render a skewed source as perfectly
   * fresh — hiding the one reading that explains it.
   */
  ageMs: number | null;
  /** The opaque position, when the cursor carries one. */
  position: string | null;
  /** Why this verdict, in terms a reader of the pane can act on. */
  detail: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read a field only when it holds a non-empty string. */
function stringField(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * Classify a persisted social cursor.
 *
 * `nowMs` is injected rather than read from `Date.now()` so the verdict is a
 * pure function of its inputs and the age arithmetic is testable without
 * freezing global time.
 */
export function socialCursorFreshness(cursor: unknown, nowMs: number): SocialCursorFreshness {
  if (!isRecord(cursor) || Object.keys(cursor).length === 0) {
    // A brand-new source is written with `{}` (see source-store's
    // `input.cursor ?? {}`), so an empty object is the cold-start shape and
    // must read as never-synced rather than as an unrecognized cursor.
    return {
      state: 'never-synced',
      at: null,
      ageMs: null,
      position: null,
      detail: 'no cursor persisted yet — this source has not reconciled',
    };
  }

  const position =
    SOCIAL_CURSOR_POSITION_FIELDS.map((field) => {
      const raw = cursor[field];
      if (typeof raw === 'string' && raw.trim() !== '') return `${field}=${raw}`;
      if (typeof raw === 'number' && Number.isFinite(raw)) return `${field}=${raw}`;
      return null;
    }).find((found): found is string => found !== null) ?? null;

  for (const field of SOCIAL_CURSOR_INSTANT_FIELDS) {
    const raw = stringField(cursor, field);
    if (raw === null) continue;
    const instantMs = socialInstantMs(raw);
    if (instantMs === null) {
      // A known instant field holding a value we cannot parse is a real defect:
      // the adapter stored something no comparison can use. Say so, rather than
      // falling through to `position-only` and reporting a broken cursor as a
      // healthy one.
      return {
        state: 'unrecognized',
        at: null,
        ageMs: null,
        position,
        detail: `cursor field '${field}' holds an unparseable instant: ${raw}`,
      };
    }
    return {
      state: 'synced',
      at: raw,
      ageMs: nowMs - instantMs,
      position,
      detail: `cursor instant from '${field}'`,
    };
  }

  if (position !== null) {
    return {
      state: 'position-only',
      at: null,
      ageMs: null,
      position,
      detail: `cursor advancing at ${position}; this platform's cursor carries no timestamp`,
    };
  }

  return {
    state: 'unrecognized',
    at: null,
    ageMs: null,
    position: null,
    detail: `stored cursor matches no known social cursor shape (fields: ${Object.keys(cursor)
      .sort()
      .join(', ')})`,
  };
}
