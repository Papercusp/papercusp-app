/**
 * Detect measurement-shaped prose in a durable fact.
 *
 * A fact is folded verbatim into future briefs and orients. A number that was
 * true when asserted can therefore become a confident stale claim while the
 * fact still looks authoritative. This is deliberately an advisory detector,
 * not a gate: historical measurements and deliberately pinned values are
 * legitimate, and refusing a fact would turn a warning into a write outage.
 *
 * Precision matters here. A bare number is not enough — release ids, migration
 * numbers, and fixed limits are common in durable conclusions. A numeric value
 * must be close to language that makes it look like a live observation or
 * changing status before we warn.
 */

export const MEASUREMENT_CONTEXT_WINDOW = 80;

// Exclude colon-adjacent digits so a measurement timestamp (20:50Z) or port
// (:3070) does not crowd the advisory ahead of the count/status it describes.
const NUMBER = /(?<![A-Za-z0-9_:#-])(?:\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?%?|\+\d+(?:\s*\/\s*-\d+)?)(?![A-Za-z0-9_:#-])/g;

/** Words that make a nearby number look like a moving observation. */
const MOVING_CONTEXT =
  /\b(?:measur(?:e|ed|ement|ing)|as\s+of|currently|right\s+now|today|latest|so\s+far|observ(?:e|ed|ation)|count(?:s|ed|ing)?|current|remaining|unchecked|adjudicated|candidate[s]?|status|open|closed|pending|supported|not[-\s]checked|working\s+tree|uncommitted)\b/i;

export interface FactMeasurementSignal {
  /** The numeric value or delta that triggered the advisory. */
  value: string;
  /** The moving-state phrase found near the value. */
  context: string;
}

function signalKey(signal: FactMeasurementSignal): string {
  return `${signal.value.toLowerCase()}::${signal.context.toLowerCase()}`;
}

/**
 * PURE. Find numeric values stated alongside measurement-like language.
 *
 * The scan is bounded and fail-soft because facts:assert is a write path. A
 * detector failure must never turn an advisory into a failed fact write.
 */
export function detectFactMeasurements(text: unknown): FactMeasurementSignal[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const haystack = text.length > 20_000 ? text.slice(0, 20_000) : text;
  const out: FactMeasurementSignal[] = [];
  const seen = new Set<string>();
  const numbers = new RegExp(NUMBER.source, NUMBER.flags);
  let match: RegExpExecArray | null;

  while ((match = numbers.exec(haystack)) !== null) {
    if (match[0].length === 0) {
      numbers.lastIndex += 1;
      continue;
    }
    const start = Math.max(0, match.index - MEASUREMENT_CONTEXT_WINDOW);
    const end = Math.min(haystack.length, match.index + match[0].length + MEASUREMENT_CONTEXT_WINDOW);
    const window = haystack.slice(start, end);
    const contextMatch = MOVING_CONTEXT.exec(window);
    if (!contextMatch) continue;

    const signal: FactMeasurementSignal = {
      value: match[0],
      context: contextMatch[0].toLowerCase(),
    };
    const key = signalKey(signal);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(signal);
  }
  return out;
}

/** Render the write-side advisory, or null when the body is clean. */
export function formatFactMeasurementHint(signals: FactMeasurementSignal[]): string | null {
  if (signals.length === 0) return null;
  const listed = signals
    .slice(0, 3)
    .map((signal) => `"${signal.value}" near "${signal.context}"`)
    .join('; ');
  const more = signals.length > 3 ? ` …and ${signals.length - 3} more` : '';
  return (
    `⚠ this fact body contains ${signals.length} measurement-like value(s): ${listed}${more}. ` +
    'Durable facts are folded VERBATIM into future orients, so a count or status that changes after this write ' +
    'becomes a confident stale claim. Prefer an invariant conclusion plus a pointer to the live source/tool and ' +
    'how to remeasure at use time; if this is intentionally historical, label it historical. Advisory only — the ' +
    'write succeeded and nothing was blocked.'
  );
}

/** Convenience: detect + format in one call. */
export function factMeasurementHint(text: unknown): string | null {
  return formatFactMeasurementHint(detectFactMeasurements(text));
}

/**
 * Detect ABSENCE claims in a durable fact.
 *
 * EI-20307375669832848. The measurement scan above is driven by NUMBER
 * matches, so it can only ever see an absence that was written numerically
 * ("observed ... of 0"). An absence stated in words — "no membership exists",
 * "was never touched", "the census found nothing" — carries no digit, so the
 * loop never reaches the context check and the advisory is structurally
 * silent for exactly the phrasing absence claims usually take. Measured on
 * this detector before the fix: 5 of 6 representative absence bodies silent,
 * both numeric controls firing.
 *
 * An absence is the claim most worth expiring. A positive observation that
 * ages is merely stale; an absence that ages actively PREVENTS action — it is
 * read as "already checked, nothing there" and the next reader skips the
 * check. The repo already treats this as a first-class hazard everywhere it
 * SEARCHES (the false-absence search-path guard, `positiveControlSql` on
 * dev:pg_query); this closes the same gap where it REMEMBERS.
 *
 * Deliberately anchored + windowed, mirroring the measurement scan, and the
 * anchors reject hyphen adjacency so domain terms that merely CONTAIN a
 * negation ("no-op", "deliberate-no-pair", "no-fall") cannot trip it.
 */
export const ABSENCE_CONTEXT_WINDOW = 80;

/** Negation anchors. Hyphen-adjacency is excluded so `no-op` is not a claim. */
const ABSENCE_ANCHOR =
  /(?<![A-Za-z0-9_-])(?:no|none|never|nothing|nowhere|neither|not)(?![A-Za-z0-9_-])/gi;

/**
 * Words that make a nearby negation an EXISTENCE claim about state rather
 * than ordinary prose. A bare "not" is far too common to warn on alone.
 */
const EXISTENCE_CONTEXT =
  /\b(?:exists?|existed|existence|found|present|remain(?:s|ed|ing)?|match(?:es|ed|ing)?|return(?:s|ed)?|fired?|emit(?:s|ted|ter|ters)?|touch(?:es|ed)?|appear(?:s|ed)?|surfaced?|occur(?:s|red)?|register(?:ed|s)?|record(?:ed|s)?|configured?|implement(?:ed|s)?|wired|reachable|referenc(?:e|es|ed)|cit(?:e|es|ed)|membership|rows?|results?|callers?|instances?|entr(?:y|ies)|hits?)\b/i;

export interface FactAbsenceSignal {
  /** The negation token that triggered the advisory. */
  token: string;
  /** The existence-claim phrase found near it. */
  context: string;
}

/**
 * PURE. Find negation tokens stated alongside existence-claim language.
 *
 * Bounded and fail-soft for the same reason as the measurement scan: this
 * runs on the facts:assert write path and must never turn an advisory into a
 * failed write.
 */
export function detectFactAbsenceClaims(text: unknown): FactAbsenceSignal[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const haystack = text.length > 20_000 ? text.slice(0, 20_000) : text;
  const out: FactAbsenceSignal[] = [];
  const seen = new Set<string>();
  const anchors = new RegExp(ABSENCE_ANCHOR.source, ABSENCE_ANCHOR.flags);
  let match: RegExpExecArray | null;

  while ((match = anchors.exec(haystack)) !== null) {
    if (match[0].length === 0) {
      anchors.lastIndex += 1;
      continue;
    }
    const start = Math.max(0, match.index - ABSENCE_CONTEXT_WINDOW);
    const end = Math.min(haystack.length, match.index + match[0].length + ABSENCE_CONTEXT_WINDOW);
    const contextMatch = EXISTENCE_CONTEXT.exec(haystack.slice(start, end));
    if (!contextMatch) continue;

    const signal: FactAbsenceSignal = {
      token: match[0].toLowerCase(),
      context: contextMatch[0].toLowerCase(),
    };
    const key = `${signal.token}::${signal.context}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(signal);
  }
  return out;
}

/** Render the absence advisory, or null when the body claims no absence. */
export function formatFactAbsenceHint(signals: FactAbsenceSignal[]): string | null {
  if (signals.length === 0) return null;
  const listed = signals
    .slice(0, 3)
    .map((signal) => `"${signal.token}" near "${signal.context}"`)
    .join('; ');
  const more = signals.length > 3 ? ` …and ${signals.length - 3} more` : '';
  return (
    `⚠ this fact body states ${signals.length} absence claim(s): ${listed}${more}. ` +
    'An absence is a time-bound observation, not an invariant: it was true of the state you searched, at the ' +
    'moment you searched it, THROUGH THE INSTRUMENT YOU USED. Absence ages worse than a positive claim, because ' +
    'a reader takes it as "already checked" and skips the check. Give it a ttlSec (not kind:\'convention\'), and a ' +
    'recheck:{ probe, falsifier } naming the search you ran and what result would disprove it — a search that was ' +
    'scoped to the wrong path, relation, or case answers empty exactly like a true absence. Advisory only — the ' +
    'write succeeded and nothing was blocked.'
  );
}

/** Convenience: detect + format in one call. */
export function factAbsenceHint(text: unknown): string | null {
  return formatFactAbsenceHint(detectFactAbsenceClaims(text));
}
