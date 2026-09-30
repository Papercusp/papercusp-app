/**
 * reset-backoff.ts — EI-1404: parse a "weekly limit · resets <time>" (or similar
 * usage/rate-limit reset hint) out of a dead worker's captured output, and turn it
 * into an absolute HOLD-UNTIL instant.
 *
 * Observed live (EI-1404, overnight 2026-07-16/17): the auto-implement dispatcher
 * re-fired EI-89/EI-17/EI-170/EI-172 roughly every 1-2h all night, every attempt
 * dying instantly on `worker exit 1 … You've hit your weekly limit · resets 7am
 * (America/New_York)`. The death is correctly classified as an env failure
 * (isEnvFailureExit, implement-worker-exit.ts) so it isn't charged — but nothing
 * stopped the NEXT tick from re-dispatching the same item into the same closed
 * window. The lane-wide `laneInEnvOutage` pause (P-032, orphaned-dispatch.ts)
 * requires >=2 env deaths inside a 90-minute window to engage; at a dispatch
 * cadence slower than that window, a death always ages out before the next one
 * lands, so the pause never trips against a quiet, isolated once-an-hour bounce —
 * exactly the shape this bug describes.
 *
 * This is the cheap, PER-ITEM fix the bug's own body proposes: when the death text
 * names an exact reset time, parse it and hold re-dispatch for THAT item until the
 * reset, instead of the generic hourly retry cadence. Self-correcting — every item
 * that dies on the same account-limit gets its own hold stamped independently, no
 * cross-item bookkeeping needed. Complementary to (not a replacement for)
 * laneInEnvOutage, which still catches the true SPIKE (many distinct items dying
 * back-to-back).
 *
 * Pure + IO-free (no PG, no clock ambient — `nowMs` is always passed in) so every
 * shape is unit-testable without a live process.
 */
import { createRequire } from 'node:module';

// luxon ships no type declarations in this install (see schedule-next.ts's identical
// note) — load it via createRequire (the repo's ESM-safe CJS pattern) with a minimal
// local type for the slice used here: resolving a WALL-CLOCK time-of-day in a given
// IANA zone to the correct absolute UTC instant (DST-correct, unlike a naive fixed
// UTC-offset guess).
interface LuxonDateTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  setZone(zone: string): LuxonDateTime;
  set(o: {
    month?: number;
    day?: number;
    hour?: number;
    minute?: number;
    second?: number;
    millisecond?: number;
  }): LuxonDateTime;
  plus(o: { days?: number; years?: number }): LuxonDateTime;
  toMillis(): number;
  isValid: boolean;
}
const { DateTime } = createRequire(import.meta.url)('luxon') as {
  DateTime: { fromMillis(ms: number, opts?: { zone?: string }): LuxonDateTime };
};

/**
 * Matches "resets 7am", "resets 7:30pm", optionally preceded by a month/day
 * ("resets Aug 20, 7am" — the WEEKLY-limit shape) and optionally followed by a
 * parenthesized IANA-ish zone name. Deliberately narrow (the live shape); a reset
 * hint with no parseable clock time returns null rather than guessing.
 *
 * ⚠ The optional month/day group is load-bearing (EI-20542327908037306). Without it
 * this regex needed a DIGIT immediately after "resets", so the multi-day weekly wall
 * — the case a hold matters most for — matched NOTHING and every caller fell back to
 * its generic ~1-2h retry, re-firing into a window that stays closed for days. That
 * is EI-1404's exact reported symptom, which this module was written to fix but only
 * fixed for the bare-clock (daily) shape. This module's OWN sibling tests already use
 * the date form ("...weekly limit · resets Jun 18, 7am"), so it was known text.
 *
 * Groups: 1=month 2=day 3=hour 4=minute 5=meridiem 6=zone.
 */
const RESET_TIME_RE =
  /\bresets\s+(?:([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([^)]+)\))?/i;

/** Month-name prefixes → luxon month number (1-12). */
const RESET_MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Furthest-out instant a parsed reset may name before we treat it as a misread. A
 * subscription reset is inherently near-future (weekly ⇒ ≤7d); a parse landing months
 * out means the message named a PAST month with no year, which rolls forward to the
 * next one. Holding an item for ~10 months on that is far worse than not holding it.
 */
const RESET_MAX_HORIZON_MS = 35 * 86_400_000;

export interface ResetHold {
  /** Absolute instant (epoch ms) to hold re-dispatch until. */
  holdUntilMs: number;
  /** The matched substring, for the ledger/payload detail. */
  raw: string;
  /** The IANA zone used, when one was present in the text. */
  tzid?: string;
}

/**
 * True-looking IANA zone id — a bare sanity check ("Region/City", optionally with
 * an underscore/second slash) so junk parenthetical text ("resets 7am (ish)")
 * doesn't get treated as a zone and silently mis-resolve the hold instant.
 */
function looksLikeIanaZone(s: string): boolean {
  return /^[A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?$/.test(s.trim());
}

/**
 * Parse a "resets <time>[am|pm][ (<tz>)]" hint out of `text` and resolve it to the
 * NEXT future occurrence of that wall-clock time (today if still ahead of `nowMs`,
 * else tomorrow) — null when no such hint is present, or the parsed pieces don't
 * resolve to a valid instant. When a zone is present it is resolved DST-correctly
 * via luxon; when absent, the hour/minute is treated as the PROCESS's own local
 * time (Node's `Date` local-zone rules) as the best available fallback — still far
 * more precise than the generic 90-minute env-outage window.
 */
export function parseResetHoldUntil(text: string | undefined | null, nowMs: number): ResetHold | null {
  if (!text) return null;
  const m = RESET_TIME_RE.exec(text);
  if (!m) return null;
  const rawHour = Number.parseInt(m[3], 10);
  const rawMinute = m[4] ? Number.parseInt(m[4], 10) : 0;
  const meridiem = m[5].toLowerCase();
  if (!Number.isFinite(rawHour) || rawHour < 1 || rawHour > 12 || rawMinute < 0 || rawMinute > 59) return null;
  let hour24 = rawHour % 12;
  if (meridiem === 'pm') hour24 += 12;
  const tzid = m[6] && looksLikeIanaZone(m[6]) ? m[6].trim() : undefined;

  // Optional "Aug 20" prefix. A word occupying the date slot that is not a month name
  // (e.g. "resets Foo 20, 7am") leaves this undefined and we fall back to the
  // next-occurrence-of-the-clock-time behavior, rather than resolving to a wrong DAY.
  const month = m[1] ? RESET_MONTHS[m[1].slice(0, 3).toLowerCase()] : undefined;
  const day = month !== undefined && m[2] ? Number.parseInt(m[2], 10) : undefined;
  const dated = month !== undefined && day !== undefined && day >= 1 && day <= 31;

  let holdUntilMs: number;
  if (tzid) {
    const nowInZone = DateTime.fromMillis(nowMs, { zone: tzid });
    if (!nowInZone.isValid) return null; // an unrecognized zone name — don't guess
    let candidate = nowInZone.set({
      ...(dated ? { month, day } : {}),
      hour: hour24,
      minute: rawMinute,
      second: 0,
      millisecond: 0,
    });
    // A dated reset that lands in the past named no year, so it rolls a year; an
    // undated one is simply the next occurrence of that clock time (tomorrow).
    if (candidate.toMillis() <= nowMs) candidate = candidate.plus(dated ? { years: 1 } : { days: 1 });
    holdUntilMs = candidate.toMillis();
  } else {
    const now = new Date(nowMs);
    const candidate = dated
      ? new Date(now.getFullYear(), (month as number) - 1, day as number, hour24, rawMinute, 0, 0)
      : new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour24, rawMinute, 0, 0);
    if (candidate.getTime() <= nowMs) {
      if (dated) candidate.setFullYear(candidate.getFullYear() + 1);
      else candidate.setDate(candidate.getDate() + 1);
    }
    holdUntilMs = candidate.getTime();
  }
  if (!Number.isFinite(holdUntilMs)) return null;
  // See RESET_MAX_HORIZON_MS: a hold months out is a misread, and no hold beats a wrong one.
  if (holdUntilMs - nowMs > RESET_MAX_HORIZON_MS) return null;
  return { holdUntilMs, raw: m[0], ...(tzid ? { tzid } : {}) };
}
