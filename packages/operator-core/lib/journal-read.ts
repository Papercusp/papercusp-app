/**
 * journal-read — read a systemd unit's journal and return DISTILLED entries.
 *
 * Plan `bash-to-tool-substitution-2026-07-26`, P-023 (D-027 measurement + design
 * ruling). The agent-facing verb is `logs:read`; this module is the pure parsing
 * + argv construction plus the one exec edge, so every decision below is
 * unit-testable without mocking `child_process`.
 *
 * ── Why this exists, and why it filters SERVER-SIDE ─────────────────────────
 * D-027 measured the 7d corpus: 428 journalctl commands across 38 of 86 su
 * sessions. 413 of them (96%) pipe the journal into a CLIENT-SIDE filter
 * (`| grep` 292, `| tail` 102) and NOT ONE uses journalctl's own `--grep`. So
 * every one of them pulls a whole unit-window across the pipe and filters after
 * the fact. That is the exact defect `readBgHostJournal` (pot/soak-report.ts)
 * already had to fix once: this host's 24h user journal is ~400MB, the unfiltered
 * read blew execFile's maxBuffer, and a fail-soft catch returned zeros — so the
 * soak gate reported CLEAN while bg-host had restarted 9 times and peaked at
 * 23.8GB. Pushing the pattern down to `--grep` took that read from ~400MB to
 * ~3KB. This tool therefore pushes `grep` down as its whole reason to exist, and
 * offers NO raw-output passthrough: that would re-create the `| grep | tail`
 * pipe inside the tool and forfeit the entire saving (same argument as D-022 for
 * `testing:run`).
 *
 * ── The four journalctl semantics reused from soak-report.ts ────────────────
 * These were expensive to learn and are trivially easy to re-break:
 *  1. EXIT CODE 1 WITH EMPTY STDERR MEANS "--grep MATCHED NOTHING" — a genuinely
 *     clean window, NOT a failed read.
 *  2. ENOENT MEANS THERE IS NO JOURNAL AT ALL (no systemd: macOS, a bare
 *     container, the shipped desktop target). A platform capability, not an
 *     error — reported as `journalAvailable:false`, never as "no log lines".
 *  3. ALWAYS UNIT-SCOPE when a unit is known: measured 25.97s unscoped versus
 *     7.58s scoped on a 1.2GB journal, for a read that returned 17 bytes.
 *  4. maxBuffer must be raised well above the Node default.
 *
 * ABSENT EVIDENCE MUST NEVER READ AS EVIDENCE OF ABSENCE — the result carries
 * `journalAvailable` and `journalError` explicitly, so an unreadable journal can
 * never be projected as an empty one.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Lazily promisified (NOT `const execFileAsync = promisify(execFile)` at module
// scope): this module is reachable via a transitive import chain from test files
// that narrowly mock `node:child_process` for their own subprocess assertions —
// under such a mock the `execFile` import binding resolves to `undefined`, and
// eagerly calling `promisify(undefined)` at module-eval time throws for every such
// suite, even ones that never actually read a journal (lint:no-eager-execfile-
// promisify / EI-10161; same pattern as watchdog.ts's `execFileP`). Deferring the
// promisify to first actual call means a transitive importer that never exercises
// this function never pays the cost.
type ExecFileAsync = (
  file: string,
  args: string[],
  opts?: Record<string, unknown>,
) => Promise<{ stdout: string; stderr: string }>;
let cachedExecFileAsync: ExecFileAsync | null = null;
function execFileAsync(file: string, args: string[], opts?: Record<string, unknown>): Promise<{ stdout: string; stderr: string }> {
  if (!cachedExecFileAsync) cachedExecFileAsync = promisify(execFile) as unknown as ExecFileAsync;
  return cachedExecFileAsync(file, args, opts);
}

/** Default returned-row cap. The corpus's own `-n` values cluster low (median
 *  30, max 2000); 200 covers the shape without ever handing back a dump. */
export const JOURNAL_READ_DEFAULT_LIMIT = 200;
/** Hard ceiling. Above this the caller wants a file, not an agent-context read. */
export const JOURNAL_READ_MAX_LIMIT = 1000;
/** Default window when the caller names a unit but no `since`. 91% of measured
 *  commands pass `--since`, overwhelmingly a short relative window. */
export const JOURNAL_READ_DEFAULT_SINCE = '-30 min';
/** Per-message clip. A single journal line can be a whole stack trace. */
export const JOURNAL_MESSAGE_MAX_CHARS = 2000;
/** 32MB, matching readBgHostJournal — the `--grep` push-down keeps real reads
 *  orders of magnitude under this, so hitting it means the caller asked for a
 *  dump and should narrow instead. */
export const JOURNAL_MAX_BUFFER = 32 * 1024 * 1024;
/** Wall-clock budget for one journalctl invocation. The measured worst case (an
 *  UNSCOPED scan of a 1.2GB journal) was ~26s; a unit-scoped read is ~7s. */
export const JOURNAL_TIMEOUT_MS = 30_000;
/**
 * Maximum interval handed to one grep'd journalctl invocation. `-n` bounds the
 * result, not the reverse scan needed to find sparse matches, so wide windows
 * must be split before they reach one subprocess.
 */
export const JOURNAL_READ_SLICE_MS = 60 * 60 * 1000;
/** Keep the slice fan-out bounded; journalctl is disk-backed host I/O. */
export const JOURNAL_READ_SLICE_CONCURRENCY = 8;

/**
 * Normalize the compact and bare-spaced lookback shorthand agents commonly use
 * (`40m`, `-2h`, `30 min`) into journalctl's accepted relative-time grammar.
 * Keep every other value verbatim so journalctl remains the authority for its
 * full timestamp syntax.
 */
export function normalizeJournalWindow(value: string): string {
  const units: Record<string, string> = {
    s: 'seconds',
    sec: 'seconds',
    secs: 'seconds',
    second: 'seconds',
    seconds: 'seconds',
    m: 'minutes',
    min: 'minutes',
    mins: 'minutes',
    minute: 'minutes',
    minutes: 'minutes',
    h: 'hours',
    hr: 'hours',
    hrs: 'hours',
    hour: 'hours',
    hours: 'hours',
    d: 'days',
    day: 'days',
    days: 'days',
    w: 'weeks',
    week: 'weeks',
    weeks: 'weeks',
  };
  const trimmed = value.trim();
  // A bare spaced duration is a useful shorthand for a past lookback, but
  // journalctl only accepts it when expressed as a relative timestamp (for
  // example, `-30 min`). Preserve already-valid signed forms verbatim so the
  // default window and its returned echo remain backwards-compatible.
  const spaced = trimmed.match(
    /^(\d+)\s+(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)$/i,
  );
  if (spaced) return `-${spaced[1]} ${units[spaced[2].toLowerCase()]}`;

  const compact = trimmed.match(/^-?(\d+)(s|m|h|d|w)$/i);
  if (!compact) return value;
  return `-${compact[1]} ${units[compact[2].toLowerCase()]}`;
}

/** syslog severities, most severe first — index IS the numeric priority. */
export const JOURNAL_LEVELS = [
  'emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug',
] as const;
export type JournalLevel = (typeof JOURNAL_LEVELS)[number];

/**
 * Which journal to read — journalctl's own three-way choice, not a boolean.
 *
 * `--user` and `--system` are DIFFERENT JOURNALS, and passing NEITHER is a third,
 * distinct request: journalctl then shows every message the caller can see. This
 * started life as a `system: boolean`, which silently collapsed that third case
 * onto `--user`; the corpus contains 18 such reads across 6 sessions and every
 * one of them targets a SYSTEM unit (`systemd-oomd`, `pgbouncer`,
 * `kopia-snapshots`), so each would have come back convincingly empty.
 */
export const JOURNAL_SCOPES = ['user', 'system', 'all'] as const;
export type JournalScope = (typeof JOURNAL_SCOPES)[number];
export const JOURNAL_DEFAULT_SCOPE: JournalScope = 'user';

export interface JournalEntry {
  /** ISO-8601 UTC. Derived from `__REALTIME_TIMESTAMP` (microseconds since the
   *  epoch), NOT from a locale-formatted string — same reasoning as
   *  systemd-service-probe preferring `ps -o etimes=` over parsing systemd's
   *  locale-formatted timestamps. */
  ts: string;
  /** `_SYSTEMD_UNIT`, falling back to `SYSLOG_IDENTIFIER`. Null when the entry
   *  carries neither (kernel/audit records). */
  unit: string | null;
  level: JournalLevel | null;
  message: string;
  /** How many CONSECUTIVE identical (unit, message) lines this row stands for.
   *  1 ⇒ not collapsed. */
  repeat: number;
  /** Timestamp of the LAST line in a collapsed run; present only when repeat>1. */
  lastTs?: string;
  /** True when `message` was clipped at JOURNAL_MESSAGE_MAX_CHARS. */
  clipped?: true;
}

export interface JournalReadResult {
  entries: JournalEntry[];
  /**
   * Journal lines journalctl actually emitted, BEFORE dedup and the row cap.
   *
   * BOUNDED BY `limit + 1`, because the row cap is pushed down to journalctl's
   * own `-n` (which bounds the SCAN, not just the output — strictly cheaper than
   * slicing afterwards). So when `truncated` is true this is a FLOOR on the true
   * match count, never the total. Narrow `grep`/`since` to learn the real number;
   * do not report `matched` as "there were N matches" on a truncated read.
   *
   * `null` ⇒ the read FAILED (`journalError` is set) — NEVER 0. A failed scan
   * has no honest count to report, and reporting 0 there is exactly the false
   * negative that made a still-firing defect read as "stopped reproducing"
   * (EI-19980767336148101): a slow `--grep`+wide-`since`+tail-cap scan hit the
   * exec timeout, and the old code still reported `matched: 0` alongside the
   * error — indistinguishable from a genuinely clean window unless the caller
   * separately checked `journalError`.
   */
  matched: number | null;
  /** Lines removed by consecutive-identical collapsing. */
  collapsed: number;
  /** True when older rows were dropped to honour `limit` (newest are kept). */
  truncated: boolean;
  /**
   * The window this read searched. `since` / `until` are the SPECS as passed
   * (journalctl's own grammar, normalised); `resolved` is the ABSOLUTE UTC
   * window those specs actually named.
   *
   * P-022 / WI-7133: the specs alone cannot tell you what was searched.
   * journalctl parses them in the host's LOCAL time while every papercusp
   * surface reports UTC, so `since: '2026-08-16 21:35:07'` echoes back looking
   * exactly like the UTC stamp the caller meant while silently naming an instant
   * four hours away from it. A zero-row result then reads as "no such event was
   * ever logged" when it means "you searched the wrong hours" — and was read
   * exactly that way during a live fleet-death investigation, pushing an already
   * wrong cause further. Echoing the resolved absolute window makes "nothing
   * there" distinguishable from "wrong there" without the caller re-deriving the
   * timezone arithmetic that produced the mistake in the first place.
   *
   * `windowOutsideJournal` below is the narrower, PROVEN diagnosis (the window
   * starts after the newest record). `resolved` is unconditional on the
   * zero-row path: it states what was searched even when nothing is provably
   * wrong, which is the state a reader most needs and is least able to check.
   */
  window: {
    since: string;
    until: string | null;
    /**
     * The absolute UTC window the specs above resolved to, or `null` when the
     * resolution was NOT ATTEMPTED — deliberately, on the paths where it buys
     * nothing: a read that returned rows (those rows carry their own UTC
     * timestamps), a failed read (`journalError` — the window is not why), and
     * a non-systemd backend. `null` never means "resolved to nothing": an
     * attempted-but-unresolvable spec is a null FIELD inside a PRESENT object,
     * which is a different answer and is reported as one.
     */
    resolved: JournalResolvedWindow | null;
  };
  units: string[];
  /** False ⇒ this host has NO readable host-log backend. Not the same as "no lines". */
  journalAvailable: boolean;
  /** Which host log backend supplied the result (`none` means unsupported/unavailable). */
  backend: JournalBackend;
  /** Non-null ⇒ the read FAILED and `entries` is meaningless, not empty. */
  journalError: string | null;
  /**
   * Requested units systemd does not know about — the read returned nothing
   * because the UNIT NAME IS WRONG, not because the window was clean.
   *
   * journalctl exits 0 with zero entries for a unit that has never existed, so
   * a typo is otherwise INDISTINGUISHABLE from a healthy silent service. That is
   * the same absent-evidence-reads-as-evidence-of-absence trap this whole module
   * is built against, so it is checked (only on the empty path, so the common
   * case pays nothing) rather than left for the caller to notice.
   */
  unitsUnknown: string[];
  /**
   * Units that systemd no longer has loaded, but whose bounded, unscoped
   * journal fallback returned historical records containing the exact unit
   * name. Transient units disappear from `systemctl` after exit while their
   * manager-written lifecycle messages remain in the journal, so this is a
   * distinct, useful answer rather than a contradiction of `unitsUnknown`.
   */
  unitsHistorical?: string[];
  /** The exact bounded fallback command, when the historical probe ran. */
  historicalCommand?: string | null;
  /**
   * Non-null ⇒ the read returned nothing because THE WINDOW IS IN THE FUTURE
   * relative to the newest record in the journal — a fifth distinct meaning of
   * an empty `entries`, and the only one the caller cannot discover by reading
   * any other field here.
   *
   * WI-7133: journalctl parses `--since`/`--until` in the host's LOCAL time,
   * while every papercusp surface reports UTC. On this box (UTC-4) pasting a UTC
   * stamp into `since` therefore queries a window ~4h AHEAD of now, which
   * journalctl answers with a perfectly clean exit and zero lines. That empty
   * result is indistinguishable from "no such event was ever logged" — and was
   * read exactly that way during a live fleet-death investigation, confirming a
   * wrong cause that had already been reported to the owner. The real window
   * held the whole story.
   *
   * Null when the window is fine, when the read failed, or WHENEVER THE CHECK
   * COULD NOT BE MADE (no `systemd-analyze`, an unparseable window, an empty
   * journal). Never guessed: a false "your timezone is wrong" would send the
   * next reader off exactly as badly as the silence it replaces — the same rule
   * `unitIsUnknownTo` follows when it reports nothing rather than risk a false
   * "that unit does not exist".
   */
  windowOutsideJournal: JournalWindowDiagnosis | null;
  /** The exact argv used, so a result is reproducible by hand. */
  command: string;
}

/**
 * The ABSOLUTE UTC window a zero-row read actually searched (P-022).
 *
 * Resolved through `systemd-analyze timestamp` — journalctl's OWN grammar — for
 * the same reason `windowOutsideJournal` defers to it: a hand-rolled parser for
 * '-30 min' | '09:40:00' | '2 hours ago' would eventually disagree with the thing
 * it is explaining, and a window report that is itself wrong is worse than none.
 */
export interface JournalResolvedWindow {
  /** ISO-8601 UTC `since` resolved to; null ⇒ that spec could not be resolved. */
  sinceUtc: string | null;
  /**
   * ISO-8601 UTC `until` resolved to. Null means EITHER no `until` was passed
   * OR it could not be resolved — `untilRequested` separates those, because
   * "unbounded end" and "we could not tell where the end was" are different
   * windows and only one of them explains an empty result.
   */
  untilUtc: string | null;
  /** True ⇒ the caller passed an `until` at all. */
  untilRequested: boolean;
  /** Host offset from UTC in minutes (-240 on an EDT box) — the usual culprit. */
  hostUtcOffsetMinutes: number;
  /**
   * Non-null ⇒ the window CANNOT match anything BY CONSTRUCTION: `until`
   * resolved to an instant BEFORE `since`. Zero rows then says nothing
   * whatsoever about what was logged.
   *
   * Unlike `windowOutsideJournal` this needs no journal probe to prove — the two
   * boundary stamps contradict each other on their own — so it is reported even
   * when the newest-entry probe cannot answer. It is the shape a MIXED-grammar
   * window produces: a UTC stamp in one bound and a relative spec in the other
   * silently cross on any host that is not UTC.
   */
  invertedHint: string | null;
}

/** Why a time-bounded read came back empty: the window sits past the journal's end. */
export interface JournalWindowDiagnosis {
  /** The `since` string exactly as the caller passed it. */
  requestedSince: string;
  /** What journalctl's own grammar resolved it to (ISO-8601 UTC). */
  resolvedSinceUtc: string;
  /** The newest record in the journal for this scope (ISO-8601 UTC). */
  newestEntryUtc: string;
  /** How far past the newest record the window starts. */
  aheadByMs: number;
  /** Host offset from UTC in minutes (-240 on an EDT box) — the usual culprit. */
  hostUtcOffsetMinutes: number;
  /** A ready-to-read sentence naming the likely cause and the fix. */
  hint: string;
}

export interface JournalReadOptions {
  /** Unit names; bare names are `.service`-suffixed by the caller. */
  units?: string[];
  /** `-t` syslog identifier. */
  identifier?: string;
  since?: string;
  until?: string;
  /** Pushed down to `journalctl --grep` (a PCRE, case-insensitive). */
  grep?: string;
  /** `-p`: this severity AND MORE SEVERE, matching journalctl's own semantics. */
  level?: JournalLevel;
  limit?: number;
  /** Which journal to read. Default `user`. */
  scope?: JournalScope;
  /** Test seam for platform selection; production uses `process.platform`. */
  platform?: NodeJS.Platform;
}

/** A journalctl interval, represented in its unambiguous `@epoch` grammar. */
export interface JournalReadSlice {
  since: string;
  until: string;
}

/**
 * Render epoch milliseconds without going through local-time parsing. Three
 * fractional digits preserve the resolver's millisecond precision and avoid
 * the UTC-vs-local ambiguity of an ISO timestamp.
 */
function journalEpoch(ms: number): string {
  return `@${(ms / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}`;
}

/**
 * Build newest-first, contiguous slices for a resolved journal window.
 * Adjacent slices share their boundary; mergeJournalRecords removes the one
 * boundary record that journalctl may return in both intervals.
 */
export function buildJournalReadSlices(
  sinceMs: number,
  untilMs: number,
  sliceMs = JOURNAL_READ_SLICE_MS,
): JournalReadSlice[] {
  if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs) || !Number.isFinite(sliceMs)) return [];
  if (sliceMs <= 0 || untilMs <= sinceMs || untilMs - sinceMs <= sliceMs) return [];

  const slices: JournalReadSlice[] = [];
  let cursor = untilMs;
  while (cursor > sinceMs) {
    const start = Math.max(sinceMs, cursor - sliceMs);
    if (start === cursor) break;
    slices.push({ since: journalEpoch(start), until: journalEpoch(cursor) });
    cursor = start;
  }
  return slices;
}

/** Host log backend selected for a read. */
export type JournalBackend = 'systemd' | 'macos-unified' | 'none';

/** Select the host log reader without probing or mutating the host. */
export function journalBackendForPlatform(platform: NodeJS.Platform = process.platform): JournalBackend {
  if (platform === 'darwin') return 'macos-unified';
  if (platform === 'linux') return 'systemd';
  return 'none';
}

/** Fields we ask journalctl for. Restricting them is what keeps `-o json`
 *  affordable: without it, JSON output is ~10x the wire size of `short-iso` for
 *  the same lines. We take JSON anyway because parsing `short-iso` means
 *  splitting on spaces across arbitrary hostnames and identifiers — a silent
 *  mis-parse that drops the unit or truncates the message, which is precisely
 *  the class of quiet wrongness this tool exists to remove. */
export const JOURNAL_OUTPUT_FIELDS = [
  '__REALTIME_TIMESTAMP',
  // `_SYSTEMD_USER_UNIT` MUST come with `_SYSTEMD_UNIT`, and must WIN. For a
  // `--user` unit the systemd-level `_SYSTEMD_UNIT` is the SESSION CONTAINER
  // (`user@1000.service`) and the real unit is only in `_SYSTEMD_USER_UNIT` —
  // caught in live verification, where every bg-host line came back attributed
  // to `user@1000.service`. A system read simply has no user-unit field, so
  // preferring it is correct in both modes.
  '_SYSTEMD_USER_UNIT',
  '_SYSTEMD_UNIT',
  'SYSLOG_IDENTIFIER',
  'PRIORITY',
  'MESSAGE',
] as const;

/** Escape one value for an NSPredicate string literal. */
export function escapeMacPredicateString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`;
}

/** Convert a journal-style relative window into `log show --last` grammar. */
export function macLastWindow(value: string): string | null {
  const normalized = normalizeJournalWindow(value).trim();
  const match = normalized.match(/^-?(\d+)\s+(seconds?|minutes?|hours?|days?|weeks?)(?:\s+ago)?$/i);
  if (!match) return null;
  const suffix: Record<string, string> = {
    second: 's',
    seconds: 's',
    minute: 'm',
    minutes: 'm',
    hour: 'h',
    hours: 'h',
    day: 'd',
    days: 'd',
    week: 'w',
    weeks: 'w',
  };
  return `${match[1]}${suffix[match[2].toLowerCase()]}`;
}

/** Build the macOS unified-log predicate without moving filtering client-side. */
export function buildMacLogPredicate(opts: JournalReadOptions): string | null {
  const terms: string[] = [];
  const units = opts.units ?? [];
  if (units.length) {
    const processTerms = units.flatMap((unit) => {
      const bare = unit.replace(/\.service$/, '');
      return [
        `process == ${escapeMacPredicateString(bare)}`,
        `process == ${escapeMacPredicateString(unit)}`,
        `processImagePath ENDSWITH ${escapeMacPredicateString(`/${bare}`)}`,
        `senderImagePath ENDSWITH ${escapeMacPredicateString(`/${bare}`)}`,
      ];
    });
    terms.push(`(${processTerms.join(' OR ')})`);
  }
  if (opts.identifier) {
    const identifier = escapeMacPredicateString(opts.identifier);
    terms.push(`(process == ${identifier} OR sender == ${identifier} OR subsystem == ${identifier})`);
  }
  if (opts.grep) {
    // NSPredicate MATCHES is ICU regex and supports the alternation used by the
    // existing grep contract. Quoting protects the predicate, while the regex
    // itself remains server-side in the unified-log process.
    terms.push(`eventMessage MATCHES[c] ${escapeMacPredicateString(opts.grep)}`);
  }
  if (opts.level) {
    const threshold = JOURNAL_LEVELS.indexOf(opts.level);
    // Unified logging has no warning/notice/crit/alert/emerg types. Keep the
    // nearest severity boundary instead of emitting unsupported predicate
    // values (Apple spells these values lower-case in `log show` output).
    const allowed = threshold <= 2
      ? ['fault']
      : threshold <= 4
        ? ['fault', 'error']
        : threshold === 5
          ? ['fault', 'error', 'default']
          : threshold === 6
            ? ['fault', 'error', 'default', 'info']
            : ['fault', 'error', 'default', 'info', 'debug'];
    terms.push(`messageType IN {${allowed.map(escapeMacPredicateString).join(', ')}}`);
  }
  return terms.length ? terms.join(' AND ') : null;
}

/** Pure argv construction for Apple's unified log reader. */
export function buildMacLogArgs(opts: JournalReadOptions): string[] {
  // `log show` has no row-count flag. The predicate and time window stay
  // server-side; readJournal applies the same newest-row cap after parsing,
  // while JOURNAL_MAX_BUFFER keeps an accidentally broad query bounded.
  const args = ['show', '--no-pager', '--style', 'json', '--info'];
  if (opts.level === 'debug') args.push('--debug');
  const since = opts.since ?? JOURNAL_READ_DEFAULT_SINCE;
  const last = macLastWindow(since);
  if (last) args.push('--last', last);
  else args.push('--start', since);
  if (opts.until) args.push('--end', normalizeJournalWindow(opts.until));
  const predicate = buildMacLogPredicate(opts);
  if (predicate) args.push('--predicate', predicate);
  return args;
}

/**
 * PURE — build the journalctl argv.
 *
 * `--no-pager` is unconditional (a pager on a pipe would hang the read), and
 * `--case-sensitive=false` matches what the corpus's hand-written `grep -i`
 * calls already do.
 */
/**
 * The scope selector, alone. `all` passes NEITHER flag — that is exactly how
 * journalctl expresses "every message this caller can see"; emitting one of the
 * two would narrow it. Shared so the window probe reads the SAME journal the
 * main query did (a probe against a different journal could report "nothing is
 * newer" about a journal the caller never asked about).
 */
export function journalScopeArgs(scope: JournalScope): string[] {
  if (scope === 'all') return [];
  return [scope === 'system' ? '--system' : '--user'];
}

export function buildJournalctlArgs(opts: JournalReadOptions): string[] {
  const scope = opts.scope ?? JOURNAL_DEFAULT_SCOPE;
  const args: string[] = [...journalScopeArgs(scope)];
  args.push('--no-pager', '-o', 'json');
  args.push(`--output-fields=${JOURNAL_OUTPUT_FIELDS.join(',')}`);
  for (const unit of opts.units ?? []) args.push('-u', unit);
  if (opts.identifier) args.push('-t', opts.identifier);
  args.push('--since', normalizeJournalWindow(opts.since ?? JOURNAL_READ_DEFAULT_SINCE));
  if (opts.until) args.push('--until', normalizeJournalWindow(opts.until));
  if (opts.level) args.push('-p', opts.level);
  if (opts.grep) {
    args.push('--grep', opts.grep, '--case-sensitive=false');
  }
  // `-n` is journalctl's own TAIL cap: it bounds the SCAN, not just the output,
  // so pushing the row cap down here is strictly cheaper than slicing after the
  // fact. We ask for one more than we intend to return so `truncated` can be
  // reported honestly rather than guessed.
  const limit = clampLimit(opts.limit);
  args.push('-n', String(limit + 1));
  return args;
}

/** Escape a unit name before embedding it in journalctl's PCRE `--grep`. */
function escapeJournalGrepLiteral(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

/**
 * Build the bounded fallback used when a named transient unit has exited.
 *
 * `journalctl -u` is the cheap, precise path, but the unit manager can forget
 * a transient unit before its manager-written lifecycle messages age out of
 * the journal. In that window an unscoped message grep is the only way to
 * recover those records. Keep the caller's time/severity/row bounds. When the
 * caller supplied a grep, retain it as the server-side filter and use the
 * decoded unit/message fields to reject unrelated records after the bounded
 * read; journalctl's deployed matcher does not support composing look-aheads.
 */
export function buildHistoricalJournalctlArgs(
  opts: JournalReadOptions,
  units: string[],
  limit = clampLimit(opts.limit),
): string[] {
  const unitPattern = units.map(escapeJournalGrepLiteral).join('|');
  const grep = opts.grep ?? `(?:${unitPattern})`;
  return buildJournalctlArgs({
    ...opts,
    units: [],
    identifier: undefined,
    grep,
    limit,
  });
}

/** PURE — clamp a caller's row cap into the supported range. */
export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return JOURNAL_READ_DEFAULT_LIMIT;
  return Math.max(1, Math.min(JOURNAL_READ_MAX_LIMIT, Math.floor(limit)));
}

/** One decoded journal record, before dedup. */
export interface RawJournalRecord {
  ts: string;
  unit: string | null;
  level: JournalLevel | null;
  message: string;
  clipped: boolean;
}

/**
 * Merge records returned by adjacent slices into one chronological stream.
 * The shared boundary is intentional: journalctl's timestamp grammar can
 * include a record at either edge, so remove only exact duplicate records
 * created by that overlap and retain otherwise-identical log lines.
 */
export function mergeJournalRecords(chunks: readonly RawJournalRecord[][]): RawJournalRecord[] {
  const seen = new Set<string>();
  const merged: RawJournalRecord[] = [];
  for (const chunk of chunks) {
    for (const record of chunk) {
      const key = `${record.ts}\u0000${record.unit ?? ''}\u0000${record.level ?? ''}\u0000${record.message}\u0000${record.clipped ? '1' : '0'}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(record);
    }
  }
  return merged.sort((a, b) => {
    if (!a.ts || !b.ts) return 0;
    return a.ts.localeCompare(b.ts);
  });
}

/**
 * PURE — decode journalctl `-o json` (one JSON object per line).
 *
 * Malformed lines are SKIPPED rather than thrown on: journalctl interleaves
 * informational lines (`-- No entries --`, rotation notices) into the stream,
 * and one of those must not fail a read that otherwise succeeded.
 */
export function parseJournalJson(stdout: string): RawJournalRecord[] {
  const out: RawJournalRecord[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const raw = decodeMessage(rec.MESSAGE);
    if (raw === null) continue;
    const clipped = raw.length > JOURNAL_MESSAGE_MAX_CHARS;
    out.push({
      ts: decodeRealtime(rec.__REALTIME_TIMESTAMP),
      unit: decodeUnit(rec),
      level: decodePriority(rec.PRIORITY),
      message: clipped ? `${raw.slice(0, JOURNAL_MESSAGE_MAX_CHARS)}…` : raw,
      clipped,
    });
  }
  return out;
}

/** Decode one timestamp emitted by `log show --style json`. */
export function decodeMacTimestamp(value: unknown): string {
  if (typeof value !== 'string') return '';
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

/** Map Apple's messageType vocabulary onto the shared journal severity scale. */
export function decodeMacPriority(value: unknown): JournalLevel | null {
  if (typeof value !== 'string') return null;
  const key = value.toLowerCase();
  if (key === 'fault') return 'crit';
  if (key === 'error') return 'err';
  if (key === 'warning') return 'warning';
  if (key === 'info') return 'info';
  if (key === 'debug') return 'debug';
  if (key === 'notice') return 'notice';
  if (key === 'default') return 'notice';
  return null;
}

function macProcessName(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const slash = value.lastIndexOf('/');
  return slash >= 0 ? value.slice(slash + 1) || null : value;
}

/** Parse Apple's JSON event objects (JSON lines or a single JSON array). */
export function parseMacLogJson(stdout: string): RawJournalRecord[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  let values: unknown[] = [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    values = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    values = trimmed
      .split('\n')
      .map((line) => {
        try {
          return JSON.parse(line) as unknown;
        } catch {
          return null;
        }
      });
  }
  return values
    .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object')
    .flatMap((rec) => {
      const messageValue = rec.eventMessage ?? rec.message ?? rec.MESSAGE;
      const message = typeof messageValue === 'string' ? messageValue : decodeMessage(messageValue);
      if (!message) return [];
      const process = rec.process ?? rec.processName;
      const unit =
        (typeof process === 'string' && process) ||
        macProcessName(rec.processImagePath) ||
        macProcessName(rec.senderImagePath) ||
        (typeof rec.subsystem === 'string' && rec.subsystem) ||
        (typeof rec.sender === 'string' && rec.sender) ||
        null;
      const timestamp = decodeMacTimestamp(rec.timestamp ?? rec.time ?? rec.__REALTIME_TIMESTAMP);
      return [{
        ts: timestamp,
        unit,
        level: decodeMacPriority(rec.messageType ?? rec.level),
        message: message.length > JOURNAL_MESSAGE_MAX_CHARS ? `${message.slice(0, JOURNAL_MESSAGE_MAX_CHARS)}…` : message,
        clipped: message.length > JOURNAL_MESSAGE_MAX_CHARS,
      }];
    })
    .sort((a, b) => {
      if (!a.ts || !b.ts) return 0;
      return a.ts.localeCompare(b.ts);
    });
}

/** PURE — `__REALTIME_TIMESTAMP` is microseconds-since-epoch AS A STRING. */
export function decodeRealtime(value: unknown): string {
  const micros = Number(value);
  if (!Number.isFinite(micros) || micros <= 0) return '';
  return new Date(Math.floor(micros / 1000)).toISOString();
}

/**
 * PURE — journald stores MESSAGE as an ARRAY OF BYTE VALUES whenever the payload
 * is not valid UTF-8 (an ANSI-coloured build log is the common case here). A
 * naive `String(rec.MESSAGE)` renders that as "72,101,108,…", which looks like
 * data and is not — so decode it properly.
 */
export function decodeMessage(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const bytes = value.filter((b): b is number => typeof b === 'number');
    if (!bytes.length) return null;
    return Buffer.from(bytes).toString('utf8');
  }
  return null;
}

/**
 * PURE — resolve the unit an entry belongs to.
 *
 * `_SYSTEMD_USER_UNIT` FIRST: for a `--user` unit, `_SYSTEMD_UNIT` is the user
 * session container (`user@1000.service`), not the service. Reading the wrong
 * one attributes every line of every user unit to the same container, which is
 * exactly what live verification showed before this fix.
 */
export function decodeUnit(rec: Record<string, unknown>): string | null {
  for (const key of ['_SYSTEMD_USER_UNIT', '_SYSTEMD_UNIT', 'SYSLOG_IDENTIFIER'] as const) {
    const value = rec[key];
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

/** PURE — PRIORITY arrives as a numeric STRING ("0".."7"). */
export function decodePriority(value: unknown): JournalLevel | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n >= JOURNAL_LEVELS.length) return null;
  return JOURNAL_LEVELS[n];
}

/**
 * PURE — collapse runs of CONSECUTIVE identical (unit, message) lines.
 *
 * Consecutive-only, deliberately. Grouping globally would compress a noisy unit
 * far harder, but it destroys chronology — and the measured intent is "the
 * matching lines, in order, from window W" (70% grep for a content needle, 25%
 * then `tail` it). A restart storm or a retry loop is exactly the consecutive
 * shape, so this collapses the volume that actually exists without reordering
 * the evidence anyone is reading.
 */
export function collapseConsecutive(records: RawJournalRecord[]): {
  entries: JournalEntry[];
  collapsed: number;
} {
  const entries: JournalEntry[] = [];
  let collapsed = 0;
  for (const rec of records) {
    const prev = entries[entries.length - 1];
    if (prev && prev.unit === rec.unit && prev.message === rec.message) {
      prev.repeat += 1;
      prev.lastTs = rec.ts;
      collapsed += 1;
      continue;
    }
    entries.push({
      ts: rec.ts,
      unit: rec.unit,
      level: rec.level,
      message: rec.message,
      repeat: 1,
      ...(rec.clipped ? { clipped: true as const } : {}),
    });
  }
  return { entries, collapsed };
}

export type JournalFailureKind = 'no-match' | 'no-systemd' | 'timeout' | 'error';

/**
 * PURE — classify a journalctl rejection.
 *
 * The `no-match` case is the one that bites: journalctl exits 1 when `--grep`
 * matched nothing, which is a CLEAN WINDOW, not a failure. Treating it as an
 * error makes the tool report a read failure for the most common good outcome;
 * treating a real failure as no-match makes it report an empty log for a journal
 * it could not read. Both are wrong in opposite, equally quiet directions.
 *
 * `timeout` is the SECOND such trap, found live (EI-19980767336148101): a
 * `--grep` combined with a wide `since` and the `-n` tail cap forces journalctl
 * into a REVERSE scan that must walk back to the `--since` boundary whenever the
 * window holds fewer than `limit` matches — genuinely slow against a chatty unit
 * (measured >35s against `papercup-bg-host` over a 48h window, well past
 * `JOURNAL_TIMEOUT_MS`). Node's own `execFile({ timeout })` then SIGTERMs the
 * child: per Node's documented contract that yields `err.killed === true`,
 * `err.code === null`, and (because journalctl never got to print anything)
 * EMPTY stderr — a shape that used to fall through to the generic `error`
 * branch below with a bare "Command failed: <argv>" message and no indication
 * anything unusual happened. Distinguishing it lets the caller report a
 * specific, actionable cause instead of an opaque one.
 */
export function classifyJournalctlFailure(err: unknown, command = 'journalctl'): { kind: JournalFailureKind; message: string } {
  const e = err as { code?: unknown; stderr?: unknown; message?: unknown; killed?: unknown; signal?: unknown };
  const stderr = String(e?.stderr ?? '').trim();
  if (e?.code === 'ENOENT') return { kind: 'no-systemd', message: `no ${command} binary on this host` };
  if (e?.code === 1 && !stderr) return { kind: 'no-match', message: '' };
  if (e?.killed === true) {
    return {
      kind: 'timeout',
      message:
        `${command} was killed (${String(e?.signal ?? 'timeout')}) after ${JOURNAL_TIMEOUT_MS}ms with no output — ` +
        'the scan did not finish, it is NOT a clean/empty window. Narrow `since`, tighten `grep`, or lower `limit` and retry.',
    };
  }
  return { kind: 'error', message: (stderr || String(e?.message ?? 'journalctl read failed')).slice(0, 300) };
}

/** Shape of the exec seam, so tests drive it without a real journal. */
export type JournalExec = (args: string[]) => Promise<{ stdout: string }>;

const defaultExec: JournalExec = (args) =>
  execFileAsync('journalctl', args, { timeout: JOURNAL_TIMEOUT_MS, maxBuffer: JOURNAL_MAX_BUFFER });

/** The macOS unified-log command uses the same exec seam and resource bounds. */
const defaultMacExec: JournalExec = (args) =>
  execFileAsync('log', args, { timeout: JOURNAL_TIMEOUT_MS, maxBuffer: JOURNAL_MAX_BUFFER });

/** Resolve a wide grep window before deciding whether to split it. */
async function resolveWideJournalSlices(
  opts: JournalReadOptions,
  resolveWindow: WindowResolver,
): Promise<JournalReadSlice[]> {
  // The reverse-scan defect is specific to journalctl's server-side grep path.
  // Leave unfiltered reads on the native single invocation, where unit indexes
  // and the existing -n bound retain their intended behavior.
  if (opts.platform && opts.platform !== 'linux') return [];
  if (!opts.grep?.trim()) return [];

  const since = normalizeJournalWindow(opts.since ?? JOURNAL_READ_DEFAULT_SINCE);
  const until = opts.until ? normalizeJournalWindow(opts.until) : null;
  let sinceMs: number | null;
  let untilMs: number | null;
  try {
    sinceMs = await resolveWindow(since);
    untilMs = until === null ? Date.now() : await resolveWindow(until);
  } catch {
    // A resolver failure must not change the ordinary journal read semantics.
    return [];
  }
  if (sinceMs === null || untilMs === null) return [];
  return buildJournalReadSlices(sinceMs, untilMs);
}

interface SlicedJournalRead {
  records: RawJournalRecord[];
  failure: { kind: JournalFailureKind; message: string; slice: JournalReadSlice } | null;
}

/** Run bounded slices in a small worker batch, newest first. */
async function readJournalSlices(
  opts: JournalReadOptions,
  slices: readonly JournalReadSlice[],
  limit: number,
  run: JournalExec,
): Promise<SlicedJournalRead> {
  const chunks: RawJournalRecord[][] = [];
  for (let offset = 0; offset < slices.length; offset += JOURNAL_READ_SLICE_CONCURRENCY) {
    const batch = slices.slice(offset, offset + JOURNAL_READ_SLICE_CONCURRENCY);
    const outcomes = await Promise.all(batch.map(async (slice) => {
      const args = buildJournalctlArgs({ ...opts, since: slice.since, until: slice.until, limit });
      try {
        const { stdout } = await run(args);
        return { slice, records: parseJournalJson(stdout), failure: null };
      } catch (err) {
        const failure = classifyJournalctlFailure(err);
        if (failure.kind === 'no-match') return { slice, records: [], failure: null };
        return { slice, records: [], failure };
      }
    }));

    const failure = outcomes.find((outcome) => outcome.failure !== null)?.failure;
    if (failure) return { records: [], failure: { ...failure, slice: outcomes.find((outcome) => outcome.failure !== null)!.slice } };

    chunks.push(...outcomes.map((outcome) => outcome.records));
    const merged = mergeJournalRecords(chunks);
    // We only need limit+1 records to establish the same bounded/truncated
    // contract as the single invocation. Older slices cannot affect the rows
    // returned once the newest limit+1 are known.
    if (merged.length > limit) return { records: merged.slice(-limit - 1), failure: null };
  }
  return { records: mergeJournalRecords(chunks), failure: null };
}

/** Resolves each requested unit to whether systemd knows it. */
export type UnitLoadProbe = (units: string[], scope: JournalScope) => Promise<string[]>;

/** Does THIS systemd manager report the unit as not-found? Null ⇒ cannot tell. */
async function unitIsUnknownTo(manager: '--user' | '--system', unit: string): Promise<boolean | null> {
  try {
    const { stdout } = await execFileAsync('systemctl', [manager, 'show', '-p', 'LoadState', unit], { timeout: 3000 });
    return /^LoadState=not-found$/m.test(stdout.trim());
  } catch {
    return null;
  }
}

/**
 * Which of these units does systemd NOT know?
 *
 * `LoadState=not-found` is the determinate answer; anything else (including a
 * probe failure) reports NOTHING, because a false "that unit does not exist" is
 * worse than saying nothing at all. Under scope `all` a unit counts as unknown
 * only when BOTH managers deny it — the read spanned both journals, so denial by
 * one proves nothing.
 */
export const defaultUnitLoadProbe: UnitLoadProbe = async (units, scope) => {
  const managers: Array<'--user' | '--system'> =
    scope === 'all' ? ['--user', '--system'] : [scope === 'system' ? '--system' : '--user'];
  const unknown: string[] = [];
  await Promise.all(
    units.map(async (unit) => {
      const verdicts = await Promise.all(managers.map((m) => unitIsUnknownTo(m, unit)));
      if (verdicts.every((v) => v === true)) unknown.push(unit);
    }),
  );
  return unknown;
};

/**
 * Resolve a journalctl window string to epoch ms, using journalctl's OWN grammar.
 * Returns null when it cannot be resolved — never a guess.
 */
export type WindowResolver = (spec: string) => Promise<number | null>;

/**
 * `systemd-analyze timestamp` parses the SAME time grammar journalctl does and
 * prints `UNIX seconds: @<epoch>`. Deferring to it is the whole point: a
 * hand-rolled parser for '-30 min' | '09:40:00' | '2 hours ago' would eventually
 * disagree with the thing it is trying to explain, and a diagnosis that is itself
 * wrong about the window is worse than no diagnosis.
 *
 * `--` guards a leading-dash spec ('-30 min'), which systemd-analyze would
 * otherwise read as its own option.
 */
export const defaultWindowResolver: WindowResolver = async (spec) => {
  try {
    const { stdout } = await execFileAsync('systemd-analyze', ['timestamp', '--', spec], {
      timeout: 3000,
    });
    const m = /^\s*UNIX seconds:\s*@?(-?\d+(?:\.\d+)?)/m.exec(stdout);
    if (!m) return null;
    const seconds = Number(m[1]);
    return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
  } catch {
    return null;
  }
};

/** Newest record epoch-ms in this scope, ignoring every filter. Null ⇒ cannot tell. */
async function newestJournalEntryMs(
  scope: JournalScope,
  exec: JournalExec,
): Promise<number | null> {
  try {
    // Deliberately UNFILTERED except for scope: the question is "does the journal
    // hold anything newer than the requested window", which a unit/grep filter
    // would confound with its own emptiness.
    //
    // ⚠ MESSAGE must stay in --output-fields even though only the timestamp is
    // used: parseJournalJson DROPS any record whose MESSAGE will not decode, so
    // requesting the timestamp alone makes every record parse to nothing and this
    // probe silently return null forever — a diagnosis that never fires, which is
    // indistinguishable from a window that is fine.
    const { stdout } = await exec([
      ...journalScopeArgs(scope),
      '--no-pager',
      '-n',
      '1',
      '-o',
      'json',
      '--output-fields=__REALTIME_TIMESTAMP,MESSAGE',
    ]);
    const [record] = parseJournalJson(stdout);
    if (!record?.ts) return null;
    const ms = Date.parse(record.ts);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

/**
 * Read the journal and return distilled entries.
 *
 * Never throws for an expected condition: a clean window, an absent journal and
 * a failed read are all reported in the RESULT, distinguishably.
 */
export async function readJournal(
  opts: JournalReadOptions,
  exec?: JournalExec,
  probeUnits: UnitLoadProbe = defaultUnitLoadProbe,
  resolveWindow: WindowResolver = defaultWindowResolver,
): Promise<JournalReadResult> {
  const backend = journalBackendForPlatform(opts.platform);
  const limit = clampLimit(opts.limit);
  const args = backend === 'macos-unified'
    ? buildMacLogArgs({ ...opts, limit })
    : backend === 'systemd'
      ? buildJournalctlArgs({ ...opts, limit })
      : [];
  const units = opts.units ?? [];
  const commandName = backend === 'macos-unified' ? 'log' : 'journalctl';
  const base = {
    matched: 0,
    collapsed: 0,
    truncated: false,
    window: {
      since: normalizeJournalWindow(opts.since ?? JOURNAL_READ_DEFAULT_SINCE),
      until: opts.until ? normalizeJournalWindow(opts.until) : null,
      // Filled in on the zero-row path only (see the field's own doc) — every
      // early return below is a path where resolving buys the reader nothing.
      resolved: null as JournalResolvedWindow | null,
    },
    units,
    unitsUnknown: [] as string[],
    unitsHistorical: [] as string[],
    historicalCommand: null as string | null,
    windowOutsideJournal: null as JournalWindowDiagnosis | null,
    command: backend === 'none' ? 'no host log backend' : `${commandName} ${args.join(' ')}`,
    backend,
  };

  if (backend === 'none') {
    return {
      ...base,
      entries: [],
      journalAvailable: false,
      journalError: null,
    };
  }

  const run = exec ?? (backend === 'macos-unified' ? defaultMacExec : defaultExec);

  /** Zero lines from a named unit is ambiguous — resolve it before returning. */
  const withUnknownUnits = async (result: JournalReadResult): Promise<JournalReadResult> => {
    if (backend !== 'systemd' || result.entries.length || !units.length || !result.journalAvailable) return result;
    const unitsUnknown = await probeUnits(units, opts.scope ?? JOURNAL_DEFAULT_SCOPE);
    if (!unitsUnknown.length) return { ...result, unitsUnknown: [] };

    // An identifier-constrained query cannot safely be widened to systemd's
    // manager messages, so preserve the ordinary unknown-unit answer there.
    // The common unit-only path gets one bounded, unscoped fallback instead.
    if (opts.identifier) return { ...result, unitsUnknown };

    const historicalArgs = buildHistoricalJournalctlArgs(opts, unitsUnknown, limit);
    const historicalCommand = `journalctl ${historicalArgs.join(' ')}`;
    let historicalRecords: RawJournalRecord[] = [];
    try {
      const historical = await run(historicalArgs);
      historicalRecords = parseJournalJson(historical.stdout)
        // With no caller grep, the fallback's literal unit pattern is already
        // server-side. With one, journalctl must retain that original filter;
        // this exact check prevents its unscoped read from returning another
        // unit's matching message. Some historical rows carry the requested
        // unit in a decoded field; manager lifecycle rows carry it in MESSAGE.
        .filter((record) => unitsUnknown.some((unit) => record.unit === unit || record.message.includes(unit)));
    } catch {
      // The primary read succeeded. A failed auxiliary probe must not turn a
      // genuinely empty read into a journal failure; keep unitsUnknown honest.
      return { ...result, unitsUnknown, historicalCommand };
    }

    const historicalUnits = unitsUnknown.filter((unit) =>
      historicalRecords.some((record) => record.unit === unit || record.message.includes(unit)),
    );
    if (!historicalUnits.length) return { ...result, unitsUnknown, historicalCommand };

    const historicalTruncated = historicalRecords.length > limit;
    const historicalKept = historicalTruncated
      ? historicalRecords.slice(historicalRecords.length - limit)
      : historicalRecords;
    const { entries, collapsed } = collapseConsecutive(historicalKept);
    return {
      ...result,
      entries,
      matched: historicalRecords.length,
      collapsed,
      truncated: historicalTruncated,
      // A unit with durable journal evidence is not a typo or a never-seen
      // unit. Keep only the genuinely unproven names in unitsUnknown.
      unitsUnknown: unitsUnknown.filter((unit) => !historicalUnits.includes(unit)),
      unitsHistorical: historicalUnits,
      historicalCommand,
    };
  };

  /**
   * Zero lines from a window that is in the FUTURE is the same class of ambiguity
   * (WI-7133) — and unlike a wrong unit name it leaves no trace anywhere else in
   * the result. Checked ONLY on the empty, successful path, so a normal read pays
   * nothing; two short probes, each of which reports nothing when it cannot tell.
   */
  const withWindowDiagnosis = async (result: JournalReadResult): Promise<JournalReadResult> => {
    if (backend !== 'systemd' || result.entries.length || !result.journalAvailable || result.journalError) return result;
    const requestedSince = result.window.since;
    const requestedUntil = result.window.until;
    const [resolvedMs, resolvedUntilMs, newestMs] = await Promise.all([
      resolveWindow(requestedSince),
      // Only paid when the caller actually bounded the end. `until` is the half
      // the future-window diagnosis below cannot see at all: a `since` that is
      // perfectly fine plus an `until` that crossed it still returns a clean 0.
      requestedUntil === null ? Promise.resolve(null) : resolveWindow(requestedUntil),
      newestJournalEntryMs(opts.scope ?? JOURNAL_DEFAULT_SCOPE, run),
    ]);
    const offsetMinutes = -new Date().getTimezoneOffset();
    const offsetLabel = `UTC${offsetMinutes < 0 ? '' : '+'}${(offsetMinutes / 60).toFixed(0)}`;
    const inverted = resolvedMs !== null && resolvedUntilMs !== null && resolvedUntilMs < resolvedMs;

    // P-022: state the window that was searched on EVERY zero-row read, not only
    // the subset that is provably wrong. "Nothing there" and "wrong there" are
    // the same bytes until the absolute boundaries are on the result.
    const resolvedWindow: JournalResolvedWindow = {
      sinceUtc: resolvedMs === null ? null : new Date(resolvedMs).toISOString(),
      untilUtc: resolvedUntilMs === null ? null : new Date(resolvedUntilMs).toISOString(),
      untilRequested: requestedUntil !== null,
      hostUtcOffsetMinutes: offsetMinutes,
      invertedHint: inverted
        ? `0 rows because THE WINDOW IS INVERTED, not because nothing was logged: \`until\` ` +
          `resolved to ${new Date(resolvedUntilMs).toISOString()}, which is BEFORE \`since\` ` +
          `(${new Date(resolvedMs).toISOString()}) — no line can fall inside it. journalctl ` +
          `parses BOTH bounds in LOCAL time (this host is ${offsetLabel}) while papercusp ` +
          `reports UTC, so a UTC stamp in one bound and a relative spec in the other cross ` +
          `silently. Re-read with both bounds in the same grammar (a RELATIVE window is safest).`
        : null,
    };
    const withResolved: JournalReadResult = {
      ...result,
      window: { ...result.window, resolved: resolvedWindow },
    };

    if (resolvedMs === null || newestMs === null || resolvedMs <= newestMs) return withResolved;
    const aheadByMs = resolvedMs - newestMs;
    const hours = (aheadByMs / 3_600_000).toFixed(1);
    return {
      ...withResolved,
      windowOutsideJournal: {
        requestedSince,
        resolvedSinceUtc: new Date(resolvedMs).toISOString(),
        newestEntryUtc: new Date(newestMs).toISOString(),
        aheadByMs,
        hostUtcOffsetMinutes: offsetMinutes,
        hint:
          `0 rows because the WINDOW IS EMPTY, not because nothing was logged: \`since\` resolved to ` +
          `${new Date(resolvedMs).toISOString()}, which is ${hours}h AFTER the newest record in this ` +
          `journal (${new Date(newestMs).toISOString()}). journalctl parses \`since\`/\`until\` in LOCAL ` +
          `time (this host is UTC${offsetMinutes < 0 ? '' : '+'}${(offsetMinutes / 60).toFixed(0)}) while ` +
          `papercusp reports UTC — passing a UTC stamp here queries the future. Use a RELATIVE window ` +
          `('-30 min', '2 hours ago'), or convert to local time first.`,
      },
    };
  };

  const slices = backend === 'systemd'
    ? await resolveWideJournalSlices(opts, resolveWindow)
    : [];
  if (slices.length) {
    const sliced = await readJournalSlices(opts, slices, limit, run);
    if (sliced.failure) {
      const { kind, message } = sliced.failure;
      return {
        ...base,
        matched: null,
        entries: [],
        journalAvailable: kind !== 'no-systemd',
        backend: kind === 'no-systemd' ? 'none' : backend,
        journalError: kind === 'no-systemd' ? null : message,
      };
    }

    const records = sliced.records;
    const truncated = records.length > limit;
    const kept = truncated ? records.slice(records.length - limit) : records;
    const { entries, collapsed } = collapseConsecutive(kept);
    return withWindowDiagnosis(
      await withUnknownUnits({
        ...base,
        entries,
        matched: records.length,
        collapsed,
        truncated,
        journalAvailable: true,
        journalError: null,
      }),
    );
  }

  let stdout: string;
  try {
    ({ stdout } = await run(args));
  } catch (err) {
    const { kind, message } = classifyJournalctlFailure(err, commandName);
    if (kind === 'no-match') {
      return withWindowDiagnosis(
        await withUnknownUnits({ ...base, entries: [], journalAvailable: true, journalError: null }),
      );
    }
    // matched:null, not 0 — the scan did not complete (or the journal is
    // unreadable), so there is no honest count to report. See the field's own
    // doc comment (EI-19980767336148101): a failed/timed-out read must never
    // report the same `matched: 0` shape a genuinely clean window reports.
    return {
      ...base,
      matched: null,
      entries: [],
      journalAvailable: kind !== 'no-systemd',
      backend: kind === 'no-systemd' ? 'none' : backend,
      journalError: kind === 'no-systemd' ? null : message,
    };
  }

  const records = backend === 'macos-unified' ? parseMacLogJson(stdout) : parseJournalJson(stdout);
  // `-n` gives us the NEWEST lines; we asked for limit+1 so an over-cap read is
  // detectable rather than assumed. Drop from the OLD end — a tail is what every
  // measured `| tail -N` was reaching for.
  const truncated = records.length > limit;
  const kept = truncated ? records.slice(records.length - limit) : records;
  const { entries, collapsed } = collapseConsecutive(kept);
  return withWindowDiagnosis(
    await withUnknownUnits({
      ...base,
      entries,
      matched: records.length,
      collapsed,
      truncated,
      journalAvailable: true,
      journalError: null,
    }),
  );
}
