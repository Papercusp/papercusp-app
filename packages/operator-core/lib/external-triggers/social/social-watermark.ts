/**
 * The client-side watermark cursor, once
 * (social-platform-integrations-2026-08-23, extracted during P-018).
 *
 * WHY THIS EXISTS. Three platforms in this registry are `watermark-rescan`:
 * they offer NO server-side time filter and NO usable since-marker, so the only
 * way to close a gap is to re-read from the newest entry and stop CLIENT-SIDE
 * at a stored mark. Facebook Pages and Instagram each grew their own copy of
 * that logic, and Threads would have been the third. Two copies is a
 * coincidence; three is a shared concern that was never named.
 *
 * WHAT THE ALGORITHM IS FOR, and why it is not just `lastSeenTimestamp > x`.
 * Provider timestamps here have one-second resolution, so two items routinely
 * share an instant. A bare `>` drops the second of them permanently; a bare
 * `>=` re-emits the first on every pass, forever. Neither is acceptable, so the
 * cursor carries the mark PLUS the ids already emitted AT that mark, and the
 * comparison is exact-instant-aware. D-023 named a second half of this — query
 * one millisecond behind the mark — which needs a query parameter that none of
 * these platforms provides, so `boundaryIds` carries the whole burden.
 *
 * ⚠ THIS MODULE IS DELIBERATELY PLATFORM-NEUTRAL. It encodes OUR algorithm, not
 * a vendor fact, which is exactly why sharing it is safe where sharing a
 * constant, an error code or a cadence would not be (D-005). Nothing here may
 * grow a platform-specific branch: a platform that needs different behaviour
 * needs its own function and a recorded reason, not a flag on this one.
 */

/**
 * A position in a stream that has no server-side cursor.
 *
 * Both fields are PERSISTED, so the shape is a storage contract: renaming a
 * field silently invalidates every stored cursor and presents as every watched
 * source cold-starting at once.
 */
export interface SocialWatermarkCursor {
  /** The newest instant emitted so far, stored VERBATIM as the provider spelled it. */
  watermark: string;
  /** Ids already emitted whose instant is exactly that mark. */
  boundaryIds: string[];
}

/**
 * Parse a provider timestamp to epoch ms, tolerantly and on purpose.
 *
 * The formats in play differ across these platforms and are not always
 * documented: Instagram states `2017-05-19T23:27:28+0000` — ISO 8601 BASIC
 * offset, no colon — while Threads' reply fields document a `timestamp` without
 * stating its spelling anywhere on the pages read. `Date.parse` accepts the
 * basic offset, the extended form (`+00:00`) and `Z` alike, which is why it is
 * used directly instead of a hand-rolled regex. A regex written for RFC 3339
 * would reject every real Instagram timestamp, and the failure would surface as
 * "no new items" rather than as a parse error — silent, and indistinguishable
 * from a healthy quiet stream.
 */
export function socialInstantMs(iso: string | null | undefined): number | null {
  if (typeof iso !== 'string' || iso.trim() === '') return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Is this a usable stored cursor?
 *
 * The watermark must PARSE, not merely be a non-empty string. A cursor whose
 * mark cannot be placed on a timeline can never exclude anything, so treating
 * it as valid would mean re-emitting the entire window on every pass while
 * looking perfectly healthy; rejecting it degrades to a cold start, which is
 * loud, bounded and correct.
 */
export function isSocialWatermarkCursor(value: unknown): value is SocialWatermarkCursor {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { watermark?: unknown; boundaryIds?: unknown };
  if (typeof candidate.watermark !== 'string' || candidate.watermark === '') return false;
  if (socialInstantMs(candidate.watermark) === null) return false;
  return Array.isArray(candidate.boundaryIds) && candidate.boundaryIds.every((id) => typeof id === 'string');
}

/**
 * Decide whether an item at `instant` with id `id` is new, given the stored mark.
 *
 * AN UNPARSEABLE INSTANT IS EMITTED, NOT DROPPED. It cannot be placed against
 * the mark, so one of the two errors has to be chosen: emitting risks a
 * duplicate, which the dedupe key absorbs downstream; dropping loses the item
 * permanently with no signal. The recoverable error is the right one.
 */
export function socialIsNewAgainstWatermark(
  stored: SocialWatermarkCursor | null,
  instant: string | null | undefined,
  id: string,
): boolean {
  if (!stored) return true;
  const at = socialInstantMs(instant);
  if (at === null) return true;
  const mark = socialInstantMs(stored.watermark);
  if (mark === null) return true;
  if (at < mark) return false;
  if (at === mark) return !stored.boundaryIds.includes(id);
  return true;
}

/**
 * Fold an emitted item into the cursor.
 *
 * When the instant EQUALS the mark the id joins `boundaryIds`; when it exceeds
 * the mark the mark advances and the boundary set is REPLACED rather than
 * appended to, because ids at the old instant can no longer collide with
 * anything. An unparseable instant leaves the cursor untouched — advancing on a
 * timestamp that cannot be compared would move the mark to a position no future
 * comparison can use.
 */
export function socialAdvanceWatermark(
  stored: SocialWatermarkCursor | null,
  instant: string | null | undefined,
  id: string,
): SocialWatermarkCursor | null {
  const at = socialInstantMs(instant);
  if (at === null) return stored;
  if (!stored) return { watermark: instant as string, boundaryIds: [id] };
  const mark = socialInstantMs(stored.watermark);
  if (mark === null) return { watermark: instant as string, boundaryIds: [id] };
  if (at > mark) return { watermark: instant as string, boundaryIds: [id] };
  if (at === mark) {
    return stored.boundaryIds.includes(id)
      ? stored
      : { watermark: stored.watermark, boundaryIds: [...stored.boundaryIds, id] };
  }
  return stored;
}
