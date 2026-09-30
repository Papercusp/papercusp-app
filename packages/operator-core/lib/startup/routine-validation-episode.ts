/**
 * Recurrence aging for the routine-validation FATAL lines (EI-18685043834332306).
 *
 * THE PROBLEM: two of the three `[routine-validation] FATAL:` lines surface identically on
 * their first occurrence and their ten-thousandth. Both are the ones whose remedy is a HUMAN
 * or CODE change, so neither can resolve its own premise:
 *
 *  - `unregistered-system-action` — deliberately never auto-paused, because pausing the row
 *    would erase the only evidence that a side-effect import is missing.
 *  - `unpauseable-routine` — a blank `install_slug` is a data-integrity bug in the row itself,
 *    so it "keeps logging FATAL every time until a human fixes the row directly".
 *
 * An alarm that has been firing continuously carries no information, and worse, it teaches
 * every agent reading the log to filter that line out — which is how EI-10733 rotted for 30
 * days while its detector worked perfectly.
 *
 * THE POLICY, and the one design call that matters: THE EPISODE IS KEYED ON THE SET OF
 * OFFENDER IDENTITIES — not on a count, and not on a boolean.
 *
 * Re-notification is a policy with two independent questions (measured across papercusp's
 * alarms, 2026-08-10): (1) has the CLASS composition changed, and (2) has the MAGNITUDE
 * escalated materially. Every hand-rolled variant here answers one and not the other —
 * keying on exact counts answers (2) with infinite sensitivity and (1) not at all (5
 * notifications in 7 minutes off count wobble); keying on an open-blocker flag answers (1)
 * once and (2) never (a freeze detected at 1 routine kept broadcasting "1" while it grew to
 * 101). Keying on the SET answers BOTH at once, because gaining an offender IS a set change.
 * Magnitude stops being a separate axis anyone has to tune. Do not "simplify" this back to a
 * count comparison.
 *
 * So: the offender set CHANGED (gained or lost a member) => the condition is genuinely new,
 * emit FATAL. The set is UNCHANGED => collapse to one chronic line carrying the recurrence
 * facts. Evidence is never dropped; it is de-escalated, which is the whole point.
 *
 * This module is PURE and has no imports — the persistence half lives behind the `sql` seam
 * in `validate-active-routines.ts`. It is a generic-first candidate (nothing here is
 * papercusp-specific) but is NOT in `libs/generic` because those are git submodules and
 * adding one is a heavy git operation that git-sync owns.
 */

/** The two FATAL classes that structurally cannot self-limit, and so need aging. */
export type RoutineValidationFatalClass =
  | 'unregistered-system-action'
  | 'unpauseable-routine'
  // EI-18752496371939475: a registered `standing` system action with NO routine row — built,
  // imported, green, and never once fired. Aged like its two siblings because it shares their
  // defining property: the remedy is a human or code change, so the condition cannot resolve
  // its own premise and would otherwise emit an identical FATAL on every boot forever, which
  // is how a real finding becomes background noise.
  | 'unscheduled-system-action';

/**
 * The placeholder `validateActiveRoutines` substitutes for a blank/absent `install_slug`
 * (`slug || '<empty>'`). It leaks into the episode key, so the SQL half must normalize the
 * column the SAME way — `COALESCE(NULLIF(install_slug, ''), '<empty>')`, which maps exactly
 * the NULL/'' cases JS `||` does and leaves every other value (whitespace included) alone.
 *
 * Getting this wrong does not throw: the mark simply never matches its row, the wave gate is
 * never won, and the class goes SILENT — the worst possible outcome for an alarm fix.
 */
export const EMPTY_INSTALL_SLUG = '<empty>';

/**
 * The `harness_shared.routines.metadata` key this subsystem persists its episode marks under
 * (`metadata.validation.<class>`). Exported so the AGENT-FACING projection can key off the
 * writer instead of re-typing the literal.
 *
 * EI-20747395137280903: the detector worked perfectly and was invisible anyway. Its only
 * output was a `console.error`, and `routines:list` projects `metadata` through a hand-typed
 * allowlist that this key was never added to — so four routines (`consult-expiry-sweep`,
 * `idle-backend-reaper`, `project-history-refresh`, `coverage-census`) sat `active:true` with
 * `nextFireAt` advancing while every fire was skipped, 210 skipped fires between them, and
 * every tool an agent would naturally check reported them healthy.
 *
 * That allowlist's own header already warned this was "THE THIRD TIME" and that a per-field
 * fix "is what guarantees a fourth instance" — this WAS the fourth. So the projection now
 * imports this constant rather than repeating `'validation'`: renaming the key moves both
 * halves together, which is the only version of this that cannot rot again.
 */
export const ROUTINE_VALIDATION_METADATA_KEY = 'validation';

/** Per-offender episode state, persisted on the routine row at `metadata.validation.<class>`. */
export interface EpisodeMark {
  /** When this offender was FIRST observed offending, and never rewritten after. */
  firstSeenMs: number;
  /** The most recent observation, used to coalesce a multi-worker boot wave. */
  lastSeenMs: number;
  /** How many distinct boot waves have observed it (not how many processes logged it). */
  occurrences: number;
}

/** One current offender plus whatever mark it already carried. */
export interface OffenderObservation {
  /** Stable identity of the offending routine row. */
  key: string;
  /** Its previously-persisted mark, or null when this offender is new. */
  prior: EpisodeMark | null;
}

export interface EpisodeSummary {
  /** How many offenders were observed this pass. */
  offenders: number;
  /** Offenders with no prior mark — the set GREW. */
  fresh: number;
  /** Offenders that already carried a mark. */
  chronic: number;
  /** Previously-marked rows that are no longer offending — the set SHRANK. */
  cleared: number;
  /** The transition test: did the offender set gain or lose a member? */
  setChanged: boolean;
  /** Oldest `firstSeenMs` across current offenders — how long this has been broken. */
  oldestFirstSeenMs: number | null;
  /** Newest `firstSeenMs` across current offenders — when the set last GREW. */
  newestFirstSeenMs: number | null;
  /** Highest occurrence count across current offenders. */
  maxOccurrences: number;
}

/**
 * Read a persisted mark defensively.
 *
 * `jsonb ->>` yields TEXT, so a numeric field round-trips as a string depending on how it is
 * projected; both forms must parse. Anything else — a missing mark, a malformed one, a
 * non-object — reads as NEVER SEEN.
 *
 * That direction is deliberate and is the safe one: an unreadable mark makes the offender
 * look FRESH, which escalates to FATAL. The opposite default would let a corrupt or
 * schema-drifted mark silence a real alarm permanently, which is precisely the failure this
 * module exists to prevent, reintroduced one level up.
 */
export function parseEpisodeMark(raw: unknown): EpisodeMark | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const firstSeenMs = coerceCount(r.firstSeenMs);
  const lastSeenMs = coerceCount(r.lastSeenMs);
  const occurrences = coerceCount(r.occurrences);
  if (firstSeenMs === null || lastSeenMs === null || occurrences === null) return null;
  return { firstSeenMs, lastSeenMs, occurrences };
}

function coerceCount(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Advance one offender's mark. `firstSeenMs` is written once and never rewritten. */
export function nextEpisodeMark(prior: EpisodeMark | null, nowMs: number): EpisodeMark {
  if (!prior) return { firstSeenMs: nowMs, lastSeenMs: nowMs, occurrences: 1 };
  return {
    firstSeenMs: prior.firstSeenMs,
    lastSeenMs: nowMs,
    occurrences: prior.occurrences + 1,
  };
}

/** Fold this pass's observations into the aggregate the emitted line reports. */
export function summarizeEpisode(
  observations: readonly OffenderObservation[],
  clearedCount: number,
): EpisodeSummary {
  let fresh = 0;
  let chronic = 0;
  let oldestFirstSeenMs: number | null = null;
  let newestFirstSeenMs: number | null = null;
  let maxOccurrences = 0;

  for (const o of observations) {
    if (o.prior) {
      chronic += 1;
      if (oldestFirstSeenMs === null || o.prior.firstSeenMs < oldestFirstSeenMs) {
        oldestFirstSeenMs = o.prior.firstSeenMs;
      }
      if (newestFirstSeenMs === null || o.prior.firstSeenMs > newestFirstSeenMs) {
        newestFirstSeenMs = o.prior.firstSeenMs;
      }
      if (o.prior.occurrences + 1 > maxOccurrences) maxOccurrences = o.prior.occurrences + 1;
    } else {
      fresh += 1;
      if (maxOccurrences < 1) maxOccurrences = 1;
    }
  }

  const cleared = Math.max(0, clearedCount);
  return {
    offenders: observations.length,
    fresh,
    chronic,
    cleared,
    setChanged: fresh > 0 || cleared > 0,
    oldestFirstSeenMs,
    newestFirstSeenMs,
    maxOccurrences,
  };
}

/**
 * FATAL only on a TRANSITION. A recurrence of the identical offender set collapses to
 * `chronic`, which the caller logs as a single warn line instead of a fresh FATAL.
 */
export function episodeSeverity(summary: EpisodeSummary): 'fatal' | 'chronic' {
  return summary.setChanged ? 'fatal' : 'chronic';
}

/**
 * The recurrence facts appended to (or standing in for) the FATAL line, so a chronic alarm
 * is distinguishable from a new one AT A GLANCE — the item's actual ask.
 */
export function renderRecurrence(summary: EpisodeSummary, nowMs: number): string {
  if (summary.setChanged) {
    const parts: string[] = [];
    if (summary.fresh > 0) parts.push(`${summary.fresh} NEW`);
    if (summary.cleared > 0) parts.push(`${summary.cleared} resolved since last check`);
    if (summary.chronic > 0) {
      parts.push(
        `${summary.chronic} pre-existing (oldest ${formatAge(summary.oldestFirstSeenMs, nowMs)})`,
      );
    }
    return `CHANGED: ${parts.join(', ')}`;
  }
  return (
    `CHRONIC: unchanged set of ${summary.offenders}, ` +
    `${ordinal(summary.maxOccurrences)} consecutive check, ` +
    `first seen ${formatAge(summary.oldestFirstSeenMs, nowMs)}, ` +
    `nothing new since ${formatAge(summary.newestFirstSeenMs, nowMs)}`
  );
}

function formatAge(thenMs: number | null, nowMs: number): string {
  if (thenMs === null) return 'unknown';
  const ms = Math.max(0, nowMs - thenMs);
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function ordinal(n: number): string {
  const abs = Math.abs(n);
  const rem100 = abs % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (abs % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}
