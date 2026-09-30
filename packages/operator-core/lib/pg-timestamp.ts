/**
 * pg-timestamp — normalise a Postgres timestamp value to an explicit UTC
 * ISO-8601 string (always ending in `Z`), for any tool-boundary read that
 * surfaces a DB timestamp to an agent.
 *
 * WHY THIS EXISTS (EI-18691099450966094): six call sites independently grew
 * their own `tsIso`/`tsIsoOrNull` helper (issues-engineer.ts, work-items.ts,
 * delegated-tasks.ts, scorecards.ts, rubrics.ts, work-item-redundancy.ts),
 * and every one of them fell back to a bare `String(v)` for any value that
 * wasn't already a JS `Date` or a `number`. When the underlying query path
 * returns a raw Postgres text-formatted timestamptz instead of a parsed
 * `Date` (e.g. a UNION leg that casts a column to `text` for type parity, or
 * a client configured to skip type parsing), `String(v)` passes through
 * Postgres' own default text rendering verbatim: `"2026-07-26
 * 03:34:43.647148-04"` — a space-separated, non-'Z', session-timezone-offset
 * string with NO explicit UTC marker. An agent that (reasonably) treats a
 * bare timestamp as UTC then miscomputes staleness by exactly the session
 * UTC offset (4h on this box) — enough to manufacture a false "abandoned
 * claim" verdict on a peer's genuinely live work (see the work-item for the
 * full incident: two independent readings both agreed a ~6-minute-old claim
 * was ~4h stale).
 *
 * THE FIX: a Postgres-text-formatted timestamp (with or without a fractional
 * seconds / offset suffix) is still something `new Date(...)` parses
 * correctly in V8 — it just wasn't being tried. Route every non-Date,
 * non-number value through `new Date(String(v))` before falling back to the
 * literal string, so the class of trap (an implicit local-offset string
 * misread as UTC) can't recur at any of these call sites again.
 */

/**
 * Normalise a DB timestamp value to a UTC ISO-8601 string (`...Z`).
 *
 * - `Date` → `.toISOString()`.
 * - `number` → treated as epoch millis.
 * - `string` (or anything else stringifiable) → parsed as a `Date`; if that
 *   parse fails, the original stringified value is returned as a last-resort
 *   fallback rather than throwing (callers of the pre-existing helpers never
 *   expected this to throw).
 * - `null` / `undefined` → `''` (matches the pre-existing non-nullable
 *   helpers' behavior — use `pgTimestampToIsoOrNull` where `null` should be
 *   preserved instead of coerced to an empty string).
 */
export function pgTimestampToIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number') return new Date(v).toISOString();
  if (v == null) return '';
  const str = String(v);
  const parsed = new Date(str);
  return Number.isNaN(parsed.getTime()) ? str : parsed.toISOString();
}

/** Same as {@link pgTimestampToIso}, but preserves `null`/`undefined` as `null`. */
export function pgTimestampToIsoOrNull(v: unknown): string | null {
  if (v == null) return null;
  return pgTimestampToIso(v);
}
