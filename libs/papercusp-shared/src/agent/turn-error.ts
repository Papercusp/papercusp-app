/**
 * Unified agent turn-error taxonomy (agent-turn-robustness P-001).
 *
 * Every agent turn — an in-process anthropic-direct LLM call OR a spawned CLI agent
 * (claude/omp/codex) — fails in one of a small, fixed set of ways. Classifying the
 * failure into one `TurnErrorClass` lets a single policy layer (`runAgentTurn`) decide
 * how to react (wait for the rate-limit reset, back off, escalate, degrade) instead of
 * each call site reinventing ad-hoc retry logic. Pure + backend-agnostic: the HTTP path
 * (anthropic-direct/API) classifies from `{status, headers, message}`; the subprocess path (CLI
 * backends) classifies from `{exitCode, signal, stderr, stdout, timedOut}`.
 */

import type { AdmissionDenial } from '../resilience/governor';
import {
  MODEL_CAPACITY_RE,
  MODEL_CAPACITY_RETRY_AFTER_MS,
  modelCapacityRetryAfterMs,
} from './model-capacity.mjs';

export { MODEL_CAPACITY_RE, MODEL_CAPACITY_RETRY_AFTER_MS };

export type TurnErrorClass =
  | 'rate_limited' // 429 / acceleration (RPM) limit — transient: back off the fleet briefly + retry
  | 'usage_limit' // plan/subscription CAP (Max/ChatGPT daily-weekly-session, insufficient_quota) — capped until a reset window (often hours): pause the fleet + surface, do NOT retry into the wall
  | 'overloaded' // 529 / 5xx transient — back off + retry
  | 'timeout' // wall-clock / deadline exceeded
  | 'transient_io' // network blip (ECONNRESET, socket hang up, …)
  | 'auth' // 401/403 — NOT retryable without new creds
  | 'context_overflow' // prompt exceeded the model context window — fix the launch/prompt, do NOT retry unchanged
  | 'agent_crash' // subprocess nonzero exit / killed by signal
  | 'empty_output' // ran clean but produced nothing
  | 'malformed_output' // produced output the caller couldn't parse
  | 'permanent'; // non-retryable 4xx / unknown permanent failure

export type TurnBackend = 'anthropic-direct' | 'claude-code' | 'omp' | 'codex';
export type TurnProvider = 'anthropic' | 'openai' | 'unknown';

/**
 * HOW a `resetAt` was derived — the CONFIDENCE a backoff policy is entitled to place in it.
 *
 * This exists because a re-arm ceiling must distinguish "the provider told us the exact instant"
 * from "we guessed which day 7am meant". EI-20544023385610622: a single 6h sanity cap served both,
 * so a correctly-parsed multi-day WEEKLY wall was clipped to 6h and the loop re-fired ~4x/day into
 * a window it already knew was closed — each COLD fire burning a full context reset for zero work.
 *
 * HIGH confidence (`header`, `dated`) names an explicit absolute instant and may be trusted for a
 * long hold; LOW confidence (`relative`, `clock`) is either inherently short-range or partly
 * INFERRED, and keeps the tight ceiling. See `usageRearmCapMs`.
 */
export type UsageResetPrecision =
  /** A provider `*-reset` header — structured, authoritative. HIGH. */
  | 'header'
  /** Message named an explicit calendar date + time ("resets Aug 20, 7am"). HIGH. */
  | 'dated'
  /** Message named a duration ("resets in 2h 30m") — exact, but inherently short-range. LOW. */
  | 'relative'
  /** Message named a bare clock time ("resets 7am"); the DAY is inferred as "next occurrence". LOW. */
  | 'clock';

/** A parsed usage-reset instant together with how it was derived. */
export interface UsageReset {
  /** Epoch ms the limit resets at. */
  atMs: number;
  /** How `atMs` was derived — see `UsageResetPrecision`. Never `'header'` from text parsing. */
  precision: Exclude<UsageResetPrecision, 'header'>;
}

/** The precisions a backoff policy may trust for a LONG hold. */
const HIGH_CONFIDENCE_RESET: ReadonlySet<UsageResetPrecision> = new Set<UsageResetPrecision>(['header', 'dated']);

export interface TurnError {
  class: TurnErrorClass;
  message: string;
  /** From `retry-after` (rate_limited/overloaded), in ms. */
  retryAfterMs?: number;
  /** Epoch ms when the limiting bucket replenishes (from `*-reset`). */
  resetAt?: number;
  /** How `resetAt` was derived — gates how long a caller may back off on it (`usageRearmCapMs`).
   *  Absent when there is no `resetAt`, or on a legacy/hand-built error that never set one. */
  resetPrecision?: UsageResetPrecision;
  provider: TurnProvider;
  /** Convenience: is this class worth another attempt (with the right wait)? */
  retryable: boolean;
  /**
   * Should the operator surface this to the human (vs absorb + auto-handle)? True for the
   * classes the user must know about — a plan/usage cap they're hitting (`usage_limit`), an
   * auth failure that needs new creds (`auth`), and unexpected permanent failures. False for
   * transient classes the governor handles silently (`rate_limited`/`overloaded`/`timeout`/…).
   */
  surfaceToUser?: boolean;
  /** Structured admission fact from the governor/gateway; never infer this from message text. */
  admissionDenial?: AdmissionDenial;
  /**
   * The text the CLASS was actually decided on, when `message` does not already show it.
   *
   * `class` is chosen by scanning stderr and stdout TOGETHER (the CLIs print provider walls to
   * stdout), while `message` is taken from stderr whenever stderr is non-empty — so on a failed
   * exit with anything at all on stderr, the class rests on text `message` cannot contain, and a
   * consumer quoting `message` displays evidence that does not support the class printed beside
   * it. Absent when `message` is already good evidence, so its presence means "the quoted message
   * is NOT why this was classified this way — this is". See `classifiedOnFrom` (WI-2143683).
   */
  classifiedOn?: string;
}

const RETRYABLE: ReadonlySet<TurnErrorClass> = new Set<TurnErrorClass>([
  'rate_limited',
  'overloaded',
  'timeout',
  'transient_io',
  'agent_crash',
  'empty_output',
  'malformed_output',
]);

// Classes the human should see (vs the governor handling them silently). `usage_limit` is the
// load-bearing one — retrying is futile, so the user must know the fleet is parked until reset.
const SURFACE_TO_USER: ReadonlySet<TurnErrorClass> = new Set<TurnErrorClass>([
  'usage_limit',
  'auth',
  'context_overflow',
  'permanent',
]);

/**
 * Classes that back off the SHARED account-wide budget — every agent on the account pauses
 * together, not just the one that tripped. `rate_limited` (transient RPM) and `overloaded`
 * (5xx) pause-and-retry; `usage_limit` (plan cap) pauses-until-reset without retrying. The
 * single predicate every penalize/pause call site consults, so adding a class is one edit.
 */
export function isAccountWide(cls: TurnErrorClass): boolean {
  return cls === 'rate_limited' || cls === 'overloaded' || cls === 'usage_limit';
}

function mk(cls: TurnErrorClass, message: string, provider: TurnProvider, extra?: Partial<TurnError>): TurnError {
  return { class: cls, message, provider, retryable: RETRYABLE.has(cls), surfaceToUser: SURFACE_TO_USER.has(cls), ...extra };
}

/**
 * Populate `classifiedOn` for a pattern-decided class: the LINE of `scan` that `re` matched.
 *
 * A line is the unit the CLI actually printed, so the excerpt cannot sprawl the way a fixed
 * character window around a match would, and it stays readable in an alert body. Returns nothing
 * when `message` already contains that text (the stderr-empty case, where `message` IS the
 * evidence) so the field is never redundant — see the `classifiedOn` doc for why it exists.
 *
 * Deliberately NOT applied to the malformed-Authorization branch: that one builds its own
 * redacted diagnostic precisely so a live bearer credential is never persisted, and echoing a
 * raw matched line there would reintroduce exactly what it exists to prevent.
 */
function classifiedOnFrom(scan: string, re: RegExp, message: string): Pick<TurnError, 'classifiedOn'> | undefined {
  const m = re.exec(scan);
  if (!m) return undefined;
  const from = scan.lastIndexOf('\n', m.index) + 1;
  const to = scan.indexOf('\n', m.index);
  const text = ((to === -1 ? scan.slice(from) : scan.slice(from, to)).trim() || m[0]).trim();
  if (!text || message.includes(text)) return undefined;
  return { classifiedOn: text.slice(0, 200) };
}

/** `retry-after` is either delta-seconds or an HTTP-date. Returns ms, or undefined. */
export function parseRetryAfterMs(retryAfter: string | number | undefined, now: number = Date.now()): number | undefined {
  if (retryAfter === undefined || retryAfter === null || retryAfter === '') return undefined;
  if (typeof retryAfter === 'number') return retryAfter > 0 ? Math.round(retryAfter * 1000) : 0;
  const s = retryAfter.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s) * 1000);
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return Math.max(0, t - now);
  return undefined;
}

/** An `anthropic-ratelimit-*-reset` (RFC-3339) → epoch ms. */
export function parseResetAt(reset: string | undefined): number | undefined {
  if (!reset) return undefined;
  const t = Date.parse(reset);
  return Number.isNaN(t) ? undefined : t;
}

// Header keys that carry a reset timestamp, most-restrictive first.
const RESET_HEADERS = [
  'anthropic-ratelimit-output-tokens-reset',
  'anthropic-ratelimit-input-tokens-reset',
  'anthropic-ratelimit-tokens-reset',
  'anthropic-ratelimit-requests-reset',
  'x-ratelimit-reset-tokens',
  'x-ratelimit-reset-requests',
];

function resetFromHeaders(headers: Record<string, string | undefined> | undefined, now: number): number | undefined {
  if (!headers) return undefined;
  const lc: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers)) lc[k.toLowerCase()] = v;
  for (const key of RESET_HEADERS) {
    const v = lc[key];
    if (!v) continue;
    // OpenAI's x-ratelimit-reset-* are durations like "1.5s"/"60s"; Anthropic's are RFC-3339.
    const dur = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(v.trim());
    if (dur) {
      const n = parseFloat(dur[1]);
      const mult = dur[2] === 'ms' ? 1 : dur[2] === 'm' ? 60_000 : 1000;
      return now + n * mult;
    }
    const t = parseResetAt(v);
    if (t) return t;
  }
  return undefined;
}

// Plan / subscription CAP — the account is capped until a reset window (often hours away), so
// retrying is futile: pause the fleet + surface the reset, don't hammer the wall. Covers the
// Claude Code subscription lockout ("You've hit your usage limit · resets 4:20am" / "session
// limit" / "5-hour limit") AND OpenAI/codex hard quota ("insufficient_quota"). Kept DISTINCT
// from a transient RPM 429 (`RATE_RE`) because the disposition is opposite (D-001, Brief 20).
const USAGE_LIMIT_RE =
  /(usage limit|session limit|weekly limit|monthly limit|daily limit|\d+-?hour limit|hit your (?:session|usage|weekly|monthly|daily) limit|insufficient_quota|quota exceeded|exceeded your (?:current )?quota|out of (?:credits|quota))/i;
// Transient acceleration / requests-per-minute 429 — back off the fleet briefly + retry. The
// usage-cap phrases were SPLIT OUT into USAGE_LIMIT_RE above (D-001).
const RATE_RE = /(\b429\b|rate.?limit|too many requests|slow down|temporarily limiting)/i;
// Anthropic's TRANSIENT-overload line — "Server is temporarily limiting requests (not your usage
// limit) · Rate limited" — contains the substring "usage limit", which would otherwise trip
// USAGE_LIMIT_RE (a plan CAP: pause-until-far-reset, no retry) — the OPPOSITE disposition to the
// transient 429 it actually is. This guard forces such text down the rate_limited (retry) path.
const TRANSIENT_OVERRIDE_RE = /temporarily limiting|not (?:your|a) (?:usage|session|weekly|monthly|daily) limit/i;
const OVERLOAD_RE = /(\b529\b|overloaded|service unavailable|\b50[0234]\b)/i;
// Codex can surface a malformed/undecodable authorization header as a Rust WebSocket
// conversion error rather than an HTTP 401/403. Treat this exact signature as an auth
// failure so the loop does not retry a credential that cannot be encoded.
const MALFORMED_AUTH_HEADER_RE = /failed to convert header to a str for header name ['"]authorization['"]/i;
const AUTH_RE = /(\b401\b|\b403\b|\bunauthorized\b|\bforbidden\b|\binvalid api key\b|\bauthentication\b|failed to convert header to a str for header name ['"]authorization['"])/i;
const IO_RE = /(ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|network|fetch failed)/i;
const TIMEOUT_RE = /(\b408\b|timed? ?out|deadline exceeded)/i;
// A prompt that exceeds the model window is a launch/prompt-sizing defect, not a
// transient provider wall. Keep this ahead of the 429/usage scans because some
// provider messages include a generic API-error prefix alongside the real cause.
const CONTEXT_OVERFLOW_RE =
  /autocompact(?:ion)? is thrashing|prompt is too long|input (?:length )?is too long|\bcontext[_ -]?length[_ -]?exceeded\b|maximum context length|input length and `?max_tokens`? exceed|exceeds? the (?:model'?s )?maximum (?:context|(?:number of )?(?:input )?tokens)|reduce the length of (?:the )?(?:messages|prompt|input)/i;

const AUTH_HEADER_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
const MALFORMED_AUTH_SAMPLE_CHARS = 32;

/** Extract only the value from Codex's malformed-header diagnostic. */
function malformedAuthorizationValue(text: string): string | undefined {
  const signature = MALFORMED_AUTH_HEADER_RE.exec(text);
  if (!signature) return undefined;
  const afterSignature = text.slice(signature.index + signature[0].length);
  const marker = /\bwith value:\s*/i.exec(afterSignature);
  if (!marker) return undefined;

  const candidate = afterSignature.slice(marker.index + marker[0].length);
  if (!candidate) return '';
  const quote = candidate[0];
  if (quote !== '"' && quote !== "'") return candidate.split(/\r?\n/, 1)[0].trimEnd();

  // The CLI uses a quoted debug representation. Stop at the matching unescaped quote;
  // if the provider cut the diagnostic before the close, keep only the first line.
  let escaped = false;
  for (let i = 1; i < candidate.length; i += 1) {
    const char = candidate[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === quote) return candidate.slice(1, i);
  }
  return candidate.slice(1).split(/\r?\n/, 1)[0];
}

/** Preserve only the auth scheme and post-token context; never persist bearer characters. */
function redactMalformedAuthorizationValue(value: string): string {
  const scheme = /^(\s*(?:bearer|basic|token)\s+)(\S+)/i.exec(value);
  if (!scheme) return '[redacted]';
  const credentialStart = scheme.index + scheme[1].length;
  const credentialEnd = credentialStart + scheme[2].length;
  return `${value.slice(0, credentialStart)}[redacted]${value.slice(credentialEnd)}`;
}

/**
 * Keep the malformed-auth signal useful without copying a credential into durable diagnostics.
 * The shape is measured from the extracted header value; head/tail are taken only after the
 * credential run has been replaced, so a well-formed bearer cannot leak through this path.
 */
function formatMalformedAuthorizationDiagnostic(text: string): string {
  const value = malformedAuthorizationValue(text);
  if (value === undefined) return 'malformed Authorization header: value unavailable (raw value redacted)';

  const classes: string[] = [];
  if (/\s/.test(value) || /\\x(?:09|0a|0d|20)/i.test(value)) classes.push('whitespace');
  if (/[^\x00-\x7f]/.test(value) || /\\x(?:[89a-f][0-9a-f])/i.test(value)) classes.push('non-ASCII');
  if (AUTH_HEADER_CONTROL_RE.test(value) || /\\x(?:0[0-9a-f]|1[0-9a-f]|7f|9[0-9a-f])/i.test(value)) classes.push('control');
  if (classes.length === 0) classes.push('ASCII');

  const redacted = redactMalformedAuthorizationValue(value);
  const head = redacted.slice(0, MALFORMED_AUTH_SAMPLE_CHARS);
  const tail = redacted.slice(-MALFORMED_AUTH_SAMPLE_CHARS);
  const bytes = new TextEncoder().encode(value).byteLength;
  const chars = Array.from(value).length;
  return (
    `malformed Authorization header: value shape bytes=${bytes}, chars=${chars}, classes=${classes.join(',')}; ` +
    `redacted head=${JSON.stringify(head)}, redacted tail=${JSON.stringify(tail)}`
  );
}

/**
 * Furthest-out instant a parsed usage reset may name before we treat it as a misread. Weekly
 * limits reset within 7d and monthly within ~31d; 35d leaves headroom without letting a garbled
 * date pause a caller for months.
 */
const USAGE_RESET_MAX_HORIZON_MS = 35 * 86_400_000;

/** Month-name prefixes for the date-qualified usage-reset form ("resets Aug 20, 7am"). */
const USAGE_RESET_MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Best-effort reset extraction from a subscription usage-limit MESSAGE (the subprocess path,
 * where structured `*-reset` headers aren't visible). Handles the relative form
 * ("resets in 2h 30m", "try again in 90 minutes") and the absolute clock form Claude prints
 * ("resets 4:20am", "resets at 11 pm", "resets 16:00"), plus the DATE-QUALIFIED form Claude
 * prints for a WEEKLY limit ("resets Aug 20, 7am"). Returns epoch ms, or undefined when no
 * reset is parseable (the caller still pauses + surfaces, just without a precise time). Pure:
 * `now` is injected so the absolute-clock "next occurrence" math is testable.
 *
 * ⚠ The date-qualified branch is not cosmetic — it is the case that matters MOST, and it used to
 * be the ONLY one that failed (EI-20542327908037306). Both older branches require a DIGIT
 * immediately after "resets", so `resets Aug 20, 7am` matched neither and returned undefined.
 * Every SHORT wall (hours away) parsed; only the LONG wall (days away) did not — so a loop that
 * died on a multi-day weekly limit got no hold at all and re-fired into the closed window every
 * ~90 minutes, each COLD fire burning a destructive context reset for zero work (measured
 * 2026-08-15: 91 such turns across 5 owners in 48h). Keep this branch AHEAD of the bare-clock
 * one: `resets Aug 20, 7am` must resolve to Aug 20, never to "7am tomorrow".
 *
 * ⚠ Returns the instant WITH its `precision`, not a bare number (EI-20544023385610622). Parsing
 * the weekly wall correctly was only half the fix: the caller then clipped it to a 6h sanity cap
 * tuned for daily walls. A ceiling cannot be widened safely without knowing whether the instant
 * was NAMED or INFERRED, so the derivation travels with the value rather than being re-guessed.
 */
export function parseUsageReset(text: string, now: number = Date.now()): UsageReset | undefined {
  // Relative: "resets in 2h", "try again in 90 minutes", "in 2h 30m", "in 45s".
  const rel = /(?:resets?|try again|again|wait)\b[^0-9]{0,12}((?:\d+\s*(?:h|hr|hrs|hours?|m|min|mins|minutes?|s|sec|secs|seconds?)\b\s*)+)/i.exec(text);
  if (rel) {
    let ms = 0;
    let matched = false;
    const re = /(\d+)\s*(h|hr|hrs|hours?|m|min|mins|minutes?|s|sec|secs|seconds?)\b/gi;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(rel[1])) !== null) {
      matched = true;
      const n = parseInt(mm[1], 10);
      const u = mm[2].toLowerCase();
      ms += u.startsWith('h') ? n * 3_600_000 : u.startsWith('m') ? n * 60_000 : n * 1000;
    }
    if (matched && ms > 0) return { atMs: now + ms, precision: 'relative' };
  }
  // Date-qualified absolute: "resets Aug 20, 7am", "resets Jun 18 7:30pm", "resets Sep 3, 16:00".
  // MUST precede the bare-clock branch below, which would otherwise never see these anyway (it
  // needs a digit right after "resets") but would misread a reordered variant as "today/tomorrow".
  // Codex prints the same wall as "try again at Oct 3rd, 2026 5:30 PM" — a "try again" lead and
  // an explicit YEAR (WI-10003494: without this branch a capped Codex account had no reset time,
  // so neither the fleet governor nor a chat viewer learned when it lifts).
  const absDate =
    /(?:resets?|try again)\s+(?:at\s+|on\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(?:(\d{4})\s*,?\s*)?(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(
      text,
    );
  if (absDate) {
    const mon = USAGE_RESET_MONTHS[absDate[1].slice(0, 3).toLowerCase()];
    // A non-month word ("resets tomorrow 7am") falls through to the branches below rather than
    // resolving to a wrong instant.
    if (mon !== undefined) {
      const day = parseInt(absDate[2], 10);
      const year = absDate[3] ? parseInt(absDate[3], 10) : null;
      let h = parseInt(absDate[4], 10);
      const min = absDate[5] ? parseInt(absDate[5], 10) : 0;
      const ap = absDate[6]?.toLowerCase();
      if (ap === 'pm' && h < 12) h += 12;
      if (ap === 'am' && h === 12) h = 0;
      if (day >= 1 && day <= 31 && h <= 23 && min <= 59) {
        const d = new Date(now);
        if (year !== null) d.setFullYear(year, mon, day);
        else d.setMonth(mon, day);
        d.setHours(h, min, 0, 0);
        // With no year named, a reset is always ahead of us, so a constructed instant in the past
        // means a year rollover (a late-December wall resetting in January). A NAMED year is taken
        // as written: a past instant then fails the `> now` check below instead of being moved.
        if (year === null && d.getTime() <= now) d.setFullYear(d.getFullYear() + 1);
        const t = d.getTime();
        // Sanity horizon. A subscription reset is inherently near-future (weekly ⇒ ≤7d), so a
        // parse landing months out is a MISREAD, not a long wall — and returning it would be
        // actively worse than returning nothing: not every caller clamps. classifyLoopLifecycleTurn
        // clamps via `clampUsageRearmDelayMs`, but gateway.ts's usage-cap pause takes this instant
        // as-is, so a stale/garbled "resets Jun 18" read in August would roll to the NEXT June and
        // pause inference for a year. Fall through to undefined instead: the caller still pauses
        // and surfaces, just without a precise time — the documented degraded mode.
        if (Number.isFinite(t) && t > now && t - now <= USAGE_RESET_MAX_HORIZON_MS) {
          return { atMs: t, precision: 'dated' };
        }
      }
    }
  }
  // Absolute clock: "resets 4:20am", "resets at 11 pm", "resets 16:00" → the NEXT occurrence.
  const abs = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
  if (abs) {
    let h = parseInt(abs[1], 10);
    const min = abs[2] ? parseInt(abs[2], 10) : 0;
    const ap = abs[3]?.toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (h <= 23 && min <= 59) {
      const d = new Date(now);
      d.setHours(h, min, 0, 0);
      let t = d.getTime();
      if (t <= now) t += 86_400_000; // already passed today → tomorrow
      // 'clock', not 'dated': the message named an hour, and the DAY is our inference. That guess
      // is why this precision keeps the tight re-arm ceiling — see `usageRearmCapMs`.
      return { atMs: t, precision: 'clock' };
    }
  }
  return undefined;
}

/**
 * Re-arm backoff ceiling for a LOW-CONFIDENCE reset (`relative` / `clock` / none) — a SANITY rail
 * on a bogus parse, not a normal bound.
 *
 * WI-6852: this was 1h, which BOUND in practice rather than acting as a rail — measured
 * 2026-08-02, 13 of 15 lifecycle-death re-arms landed on EXACTLY 60m, i.e. `resetAt - now`
 * exceeded the cap every time and each re-arm was clipped and therefore UNDER-waited. Provider
 * walls here commonly run ~3-5h (observed: a "resets 9am" wall active from 10:17Z to 13:00Z).
 * 6h clears a real DAILY wall while still refusing to park a loop for a day on a mis-parse.
 */
export const USAGE_REARM_CAP_MS = 6 * 3_600_000;

/**
 * Re-arm ceiling for a HIGH-CONFIDENCE reset (`header` / `dated`) — an instant the provider NAMED
 * rather than one we inferred.
 *
 * EI-20544023385610622: `USAGE_REARM_CAP_MS` was tuned for the daily/session wall regime and never
 * contemplated a WEEKLY limit, which resets in DAYS. Once `parseUsageReset` learned the
 * date-qualified form (EI-20542327908037306) a weekly wall parsed correctly to ~113h out and was
 * then clipped to 6h — ~4 wakes/day into a window already known to be closed, each COLD one
 * burning a full context reset for zero work. Raising the single cap blindly was rejected: it
 * would trade this bug for the mis-parse hazard the rail exists to prevent, for EVERY loop on the
 * box. Widening only for a NAMED instant keeps the rail where the guess is.
 *
 * 7d, not the parser's 35d `USAGE_RESET_MAX_HORIZON_MS`: a weekly limit resets within 7d BY
 * DEFINITION, so a high-confidence instant beyond that is a monthly cap or a stale message, and
 * re-checking beats sleeping. Bounds the worst case (a garbled dated parse) to one week while
 * clearing every real weekly wall exactly.
 */
export const USAGE_REARM_CAP_HIGH_CONFIDENCE_MS = 7 * 86_400_000;

/** The re-arm ceiling a reset of this precision earns. Absent precision ⇒ the tight rail. */
export function usageRearmCapMs(precision: UsageResetPrecision | undefined): number {
  return precision && HIGH_CONFIDENCE_RESET.has(precision) ? USAGE_REARM_CAP_HIGH_CONFIDENCE_MS : USAGE_REARM_CAP_MS;
}

/**
 * The one clamp every usage-wall re-arm goes through: never sooner than the caller's own cadence,
 * never longer than the ceiling this reset's `precision` earns.
 *
 * Lives HERE, beside the precision it consults, rather than as a private constant in each
 * consumer: `reconcile-loop-routines.ts` and `loop-turn-outcome.ts` each carried their own copy of
 * the 6h number with a comment asking the other to be kept in step, and a two-tier policy
 * duplicated twice is a drift waiting to happen. Both import this instead.
 */
export function clampUsageRearmDelayMs(
  hintMs: number,
  intervalMs: number,
  precision: UsageResetPrecision | undefined,
): number {
  return Math.min(Math.max(hintMs, intervalMs), usageRearmCapMs(precision));
}

/** Classify an HTTP-style failure (anthropic-direct in-process call, or an API error). */
export function classifyHttpError(
  input: { status?: number; headers?: Record<string, string | undefined>; message?: string; admissionDenial?: AdmissionDenial },
  provider: TurnProvider = 'unknown',
  now: number = Date.now(),
): TurnError {
  const msg = input.message ?? (input.status ? `HTTP ${input.status}` : 'unknown error');
  const headers = input.headers;
  const retryAfterMs = parseRetryAfterMs(headers?.['retry-after'] ?? headers?.['Retry-After'], now);
  const resetAt = resetFromHeaders(headers, now);
  const st = input.status;

  if (CONTEXT_OVERFLOW_RE.test(msg)) return mk('context_overflow', msg, provider);

  // A plan/usage CAP (429 w/ insufficient_quota, or a no-status message naming a usage cap) →
  // pause-until-reset + surface, do NOT retry. Checked before the transient-429 branch since the
  // disposition is opposite (D-001). The header reset (if any) IS the cap's reset time.
  if (USAGE_LIMIT_RE.test(msg) && !TRANSIENT_OVERRIDE_RE.test(msg) && (st === 429 || st === undefined)) {
    return mk('usage_limit', msg, provider, {
      retryAfterMs,
      resetAt,
      // A `*-reset` header is the provider's own structured field — the highest-confidence reset
      // there is, so it earns the long re-arm ceiling (`usageRearmCapMs`). Only stamped when a
      // header actually produced one; an absent reset must not read as a trusted one.
      ...(resetAt !== undefined ? { resetPrecision: 'header' as const } : {}),
      ...(input.admissionDenial ? { admissionDenial: input.admissionDenial } : {}),
    });
  }
  if (st === 429 || (st === undefined && (RATE_RE.test(msg) || TRANSIENT_OVERRIDE_RE.test(msg)))) {
    // Fail-closed mint discipline (WI-5391 Part B): only a REAL HTTP 429 status attests a
    // capacity denial (`via:'http-429'`). The prose branch (no status, message merely LOOKS
    // rate-limity) mints NOTHING — that shape is indistinguishable from an admission-path
    // defect (WI-4541), and an evidence-free denial would let the defect vanish into the
    // capacity bucket of the very error metric that should catch it. Prose failures stay
    // 'rate_limited' for retry policy but COUNT as errors unless the governor attached a
    // typed denial itself.
    return mk('rate_limited', msg, provider, {
      retryAfterMs,
      resetAt,
      // Stamped honestly (it IS a header-derived instant) even though a transient RPM bucket is
      // never a candidate for a long hold — the CLASS gate for that lives at the consumer
      // (`computeDeathRearmMs`), so neither layer has to lie about where its value came from.
      ...(resetAt !== undefined ? { resetPrecision: 'header' as const } : {}),
      ...(input.admissionDenial
        ? { admissionDenial: input.admissionDenial }
        : st === 429
          ? { admissionDenial: { reason: 'provider-429', via: 'http-429' } as AdmissionDenial }
          : {}),
    });
  }
  if (st === 529 || st === 503 || st === 502 || st === 500 || st === 504 || (st === undefined && OVERLOAD_RE.test(msg))) {
    return mk('overloaded', msg, provider, { retryAfterMs });
  }
  if (st === 408 || (st === undefined && TIMEOUT_RE.test(msg))) return mk('timeout', msg, provider);
  if (st === 401 || st === 403 || (st === undefined && AUTH_RE.test(msg))) return mk('auth', msg, provider);
  if (st === undefined && IO_RE.test(msg)) return mk('transient_io', msg, provider);
  if (st !== undefined && st >= 400 && st < 500) return mk('permanent', msg, provider);
  if (st === undefined) return mk('transient_io', msg, provider); // unknown w/ no status: treat as a retryable blip
  return mk('permanent', msg, provider);
}

/** Classify a finished CLI-agent subprocess (claude/omp/codex). */
export function classifySubprocessResult(
  input: { exitCode: number | null; signal?: string | null; stderr?: string; stdout?: string; timedOut?: boolean },
  provider: TurnProvider = 'unknown',
  now: number = Date.now(),
): TurnError {
  const stderr = input.stderr ?? '';
  if (input.timedOut) return mk('timeout', 'subprocess timed out', provider);
  // The claude/codex CLIs print API errors (rate limit, overload, auth) to STDOUT, not stderr —
  // e.g. "API Error: Server is temporarily limiting requests … · Rate limited" with EMPTY stderr.
  // Fold stdout into the pattern scan ON A FAILED EXIT so such a bee is classified `rate_limited`
  // (→ the fleet governor's 429 backoff / AIMD) instead of a generic `agent_crash`. Gated on
  // failure so a SUCCESSFUL bee whose output merely mentions "rate limit" isn't misclassified.
  const failed = !!input.signal || (input.exitCode !== 0 && input.exitCode !== null);
  const scan = failed ? `${stderr}\n${input.stdout ?? ''}` : stderr;
  const errText = stderr.trim() ? stderr : failed ? input.stdout ?? '' : '';
  // This error embeds the Authorization value in the provider diagnostic. Handle it before
  // every generic pattern and never apply the ordinary 200-character raw slice: that slice can
  // cut off the only useful suffix, while a wider one could persist a live bearer credential.
  if (MALFORMED_AUTH_HEADER_RE.test(scan)) {
    return mk('auth', formatMalformedAuthorizationDiagnostic(scan), provider);
  }
  // Prompt-size deaths are terminal until the launch configuration or prompt is
  // fixed. Detect them before provider-wall patterns so a descriptive 400/429
  // wrapper cannot turn a context failure into a retryable backoff class.
  if (CONTEXT_OVERFLOW_RE.test(scan)) {
    const message = errText.slice(0, 200) || 'context window exceeded';
    return mk('context_overflow', message, provider, classifiedOnFrom(scan, CONTEXT_OVERFLOW_RE, message));
  }
  // Codex's native CLI emits this capacity wording on a failed subprocess without exposing the
  // structured 429/503 response. Treat it as a transient, model-scoped rate-limit condition so
  // runAgentTurn waits a minute before retrying instead of misclassifying it as agent_crash.
  if (MODEL_CAPACITY_RE.test(scan)) {
    const message = errText.slice(0, 200) || 'selected model is at capacity';
    return mk('rate_limited', message, provider, {
      retryAfterMs: modelCapacityRetryAfterMs(scan),
      ...classifiedOnFrom(scan, MODEL_CAPACITY_RE, message),
    });
  }
  // Plan/usage CAP first (opposite disposition to a transient 429): pause-until-reset + surface,
  // no retry. The CLI prints the reset in the message ("resets 4:20am"), so parse it best-effort.
  if (USAGE_LIMIT_RE.test(scan) && !TRANSIENT_OVERRIDE_RE.test(scan)) {
    const reset = parseUsageReset(scan, now);
    const message = errText.slice(0, 200) || 'usage limit reached';
    return mk('usage_limit', message, provider, {
      ...(reset !== undefined ? { resetAt: reset.atMs, resetPrecision: reset.precision } : {}),
      ...classifiedOnFrom(scan, USAGE_LIMIT_RE, message),
    });
  }
  if (RATE_RE.test(scan)) {
    // Some CLIs print "retry after 30s" / "try again in 12 seconds".
    const m = /(?:retry after|try again in|wait)\s+(\d+(?:\.\d+)?)\s*(s|sec|seconds|m|min|minutes|ms)?/i.exec(scan);
    let retryAfterMs: number | undefined;
    if (m) {
      const n = parseFloat(m[1]);
      const unit = (m[2] ?? 's').toLowerCase();
      retryAfterMs = unit.startsWith('ms') ? n : unit.startsWith('m') ? n * 60_000 : n * 1000;
    }
    const message = errText.slice(0, 200) || 'rate limited';
    return mk('rate_limited', message, provider, { retryAfterMs, ...classifiedOnFrom(scan, RATE_RE, message) });
  }
  if (OVERLOAD_RE.test(scan)) {
    const message = errText.slice(0, 200);
    return mk('overloaded', message, provider, classifiedOnFrom(scan, OVERLOAD_RE, message));
  }
  if (AUTH_RE.test(scan)) {
    const message = errText.slice(0, 200);
    return mk('auth', message, provider, classifiedOnFrom(scan, AUTH_RE, message));
  }
  if (IO_RE.test(scan)) {
    const message = errText.slice(0, 200);
    return mk('transient_io', message, provider, classifiedOnFrom(scan, IO_RE, message));
  }
  if (input.signal) return mk('agent_crash', `killed by ${input.signal}`, provider);
  if (input.exitCode !== 0 && input.exitCode !== null) {
    return mk('agent_crash', errText.slice(0, 200) || `exit ${input.exitCode}`, provider);
  }
  // Exit 0 (or null with no signal): success-ish — only empty output is a failure here.
  if (!input.stdout || !input.stdout.trim()) return mk('empty_output', 'agent produced no output', provider);
  return mk('permanent', 'unclassified clean exit', provider); // shouldn't happen; caller treats stdout as success
}

interface HttpRaw {
  status?: number;
  headers?: Record<string, string | undefined>;
  message?: string;
}
interface SubprocessRaw {
  exitCode: number | null;
  signal?: string | null;
  stderr?: string;
  stdout?: string;
  timedOut?: boolean;
}

const PROVIDER_BY_BACKEND: Record<TurnBackend, TurnProvider> = {
  'anthropic-direct': 'anthropic',
  'claude-code': 'anthropic',
  omp: 'unknown', // model-agnostic / multi-provider
  codex: 'openai',
};

/** Top-level dispatch: anthropic-direct → HTTP-shape; CLI backends → subprocess-shape. */
export function classifyTurnError(
  backend: TurnBackend,
  raw: HttpRaw | SubprocessRaw,
  now: number = Date.now(),
): TurnError {
  const provider = PROVIDER_BY_BACKEND[backend];
  if (backend === 'anthropic-direct') return classifyHttpError(raw as HttpRaw, provider, now);
  return classifySubprocessResult(raw as SubprocessRaw, provider, now);
}
