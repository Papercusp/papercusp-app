/**
 * Equivalence pairs — the AMBIENT-CONTEXT family (plan
 * `bash-to-tool-substitution-2026-07-26`, P-026 + P-027).
 *
 * These are the plan's first pairs whose replacement is NOT A TOOL CALL. The
 * answer has already arrived: `coord:orient` now carries a `host` block
 * (`{ now, cores, load, memFreePct, memTotalGb, psiMemSome60 }` — see
 * lib/host-snapshot.ts), so the shell-out is not merely avoidable, it is
 * redundant. Every advisory here therefore says READ WHAT YOU ALREADY HAVE and
 * must never say "call coord:orient" — orient is a heavyweight compound call,
 * and invoking it to read a clock would cost strictly more than `date` does.
 *
 * ── Why context-folding rather than a `dev:host` verb (D-035/D-036) ──────────
 * A verb still costs the inference round-trip that IS the cost this plan
 * measures. It only pays for itself when the answer VARIES enough that it must
 * be asked for. Measured over the 7d corpus, these do not:
 *
 *   question      atoms  distinct  distinct/atom  top-3 cover
 *   cores            44         2             5%         100%   ← an INVARIANT
 *   load            206        20            10%          86%
 *   mem              33         4            12%          97%
 *   clock           852       161            19%           —    (69% bare)
 *
 * Compare the same statistic for the halves of these families that were
 * DELIBERATELY LEFT AS BASH, because no fixed field can answer them:
 *
 *   du/df            88        73            83%          15%   ← ad-hoc paths
 *
 * ── What these patterns must NOT match ──────────────────────────────────────
 * Both families are half tool-shaped and half irreducibly shell, so an
 * over-broad pattern here produces advisories that are simply WRONG:
 *  • `$(date …)` / `` `date` `` INSIDE another command — 279 atoms. That is
 *    string interpolation building some other command's argument; no context
 *    field removes it. Excluded structurally: every pattern is anchored with
 *    `^` and these pairs match a single NORMALISED ATOM, so a substitution
 *    nested in a larger command never reaches them.
 *  • `date -d @<epoch>` / `-r FILE` / `-s` — converting or SETTING some OTHER
 *    instant, not reading now. Excluded in {@link cover}.
 *  • `uptime -p` / `-s` — pretty-printed uptime and BOOT TIME. A different
 *    question from load; the `host` block carries no boot time.
 *  • `du` / `df` — not represented here at all (D-035): 83% distinct-per-atom
 *    over arbitrary paths and globs is exploration, and a fixed field is not a
 *    substitute for it.
 *
 * ── The atomizer artifact every pattern here has to survive ─────────────────
 * `atomize` splits on `|`, INCLUDING a `|` inside a quoted regex alternation.
 * So `grep -n "MONO_ROOT=\|npm install\|npm ci" bin/build.sh` yields an atom
 * that begins `npm ci" bin/build.sh` — a fragment of a SEARCH STRING that looks
 * exactly like a command. Measured on this family: 9% of `^uptime\b` matches and
 * 1% of `^date\b` matches were such fragments.
 *
 * Two consequences, both handled by pattern shape rather than by `cover()`:
 *  • `\b` is too weak an anchor. `^free\b` matched `free-port-base\.ts" /tmp/…`
 *    — a grep for a FILENAME — because `\b` matches between `free` and `-`. The
 *    zero-argument reads therefore anchor the WHOLE atom (`…$`), and the clock
 *    uses `(?=\s|$)`, which a hyphenated filename cannot satisfy.
 *  • An advisory that fires on someone's grep is worse than one that misses:
 *    the agent learns the guidance is noise. That cost is why this is fixed at
 *    the pattern, not tolerated as a rounding error.
 *
 * ── Deliberately NOT claiming `cat /proc/loadavg` ───────────────────────────
 * The 64 `cat /proc/loadavg` atoms are ALREADY claimed by `file-read.cat-file`
 * (the P-026 overlap test measured exactly this: 75 of 370 family atoms, 20%).
 * Claiming them again would make two pairs match one atom, and the registry has
 * no tie-break — the resulting advisory would depend on list order. One pattern
 * owns one atom; the existing pair keeps these.
 */

import type { CoverageResult, BashSubstitutionPair } from '../types';

/** `date` flags that mean "a DIFFERENT instant", not "now". Reading any of them
 *  is a conversion or a write, which no ambient field can serve.
 *
 *  Per D-008 these are excluded by PATTERN (the negative lookahead below), not
 *  by failing them in {@link BashSubstitutionPair.cover} — a request for a different
 *  instant is a DIFFERENT QUESTION, not a case the ambient field fails to cover,
 *  and letting it reach `cover()` would drag the verdict to `needs-widening`
 *  over commands this pair never claimed. `cover()` keeps the same test as a
 *  defensive backstop so the two cannot drift. */
const DATE_OTHER_INSTANT = /(?:^|\s)(?:-d\b|--date\b|-r\b|--reference\b|-s\b|--set\b|-f\b|--file\b)/;

/** `^date` MINUS the different-question forms: a different instant (-d/-r/-s/-f)
 *  or nanosecond precision the millisecond field cannot express.
 *
 *  Note `(?=\s|$)` rather than `\b`: `\b` matches between `date` and a hyphen,
 *  so a bare `\b` also claims a FILENAME like `date-utils.ts` appearing at the
 *  head of an atom. See the atomizer-artifact note on {@link AMBIENT_CONTEXT_PAIRS}. */
const DATE_READ_PATTERN =
  /^date(?=\s|$)(?!.*(?:\s-[drsf]\b|\s--(?:date|reference|set|file)\b|%N))/;

/**
 * P-027 — the standalone clock read.
 *
 * 852 atoms across 50 of 86 sessions; 586 of them (69%) are a bare `date` or
 * `date -u` with no format at all. The `host.now` field is an ISO-8601 UTC
 * instant with milliseconds, and every format the corpus actually asks for
 * (`+%s`, `+%FT%TZ`, `+%H:%M:%SZ`, `+%Y-%m-%d %H:%M:%S UTC`, …) is a pure
 * rendering of that same instant — which is what makes this `equivalent`
 * rather than merely related.
 *
 * ⚠ THE SUBSTITUTION IS BOUNDED TO THE TURN THE PAYLOAD ARRIVED IN, and saying
 * so is load-bearing (EI-21333774797481879). `host.now` is a SNAPSHOT stamped
 * when that orient ran, and an agent's turns are separated by arbitrary
 * wall-clock time — measured in one session, two adjacent-in-transcript reads
 * were 1h44m apart, and an earlier pair in the same session ~4h40m. TRANSCRIPT
 * ADJACENCY IS NOT TEMPORAL ADJACENCY.
 *
 * The value is correct when fresh; side-by-side against `db now()` it agreed to
 * the second. The defect is purely CARRY, and it already produced a real error:
 * an agent differenced a `host.now` it was carrying from an earlier turn against
 * a live DB timestamp, concluded the two clocks were skewed ~4h40m, and shipped
 * that as a durable caution to a peer before retracting it. Nothing threw — a
 * carried clock yields a PLAUSIBLE wrong number, which is why the guidance has
 * to draw the line the pattern matcher cannot: `cover()` sees one atom, never
 * how long ago the payload landed.
 *
 * ⚠ SECOND, INDEPENDENT TRAP — THE RENDERING, not the carry (EI-20086558925351815).
 * `host.now` is UTC; this box's TZ is EDT (-04:00) and most shell surfaces render
 * LOCAL by default (`ls -l` mtime, bare `date`, `stat`'s `%y`). Differencing the two
 * manufactures a phantom 4h gap, and the bias is toward the ALARMING reading: the
 * agent-facing stamp looks 4h AHEAD, so a perfectly live artifact reads as STALE.
 * Measured: an agent compared a 17:01 UTC session stamp against a 13:00 EDT file
 * mtime, concluded "the file is stale, the job never wrote to it", and shipped that
 * in a visible response before `date` exposed it — 13:00 EDT IS 17:00 UTC, and the
 * file had been written ~2 minutes earlier. Note this is NOT the carry defect above:
 * both values were fresh. Render the other side in UTC before comparing
 * (`TZ=UTC stat -c '%y %n'`, `date -u`); `TZ=UTC` is INERT on git's `%cI`/`%cd`,
 * which need a `--date=*-local` format to honour it.
 *
 * Why the fix is guidance and not a `host.now` state cell (the other option
 * considered): the cell registry is a VERDICT registry, not a generic re-read
 * handle. Every CellSpec requires an `assessment` naming a closed set of decision
 * meanings — `null` is legal only for event-signalled cells, and a poll cell
 * without one is rejected as `assessment-missing`. A scalar clock carries no
 * verdict to assess, and its admission rule ("a read with 0 calls is never
 * promoted") would refuse it anyway. `date -u` is already the cheap re-read.
 */
export const clockRead: BashSubstitutionPair = {
  id: 'ambient.date-read',
  intentLabel: 'current-time',
  bashPattern: DATE_READ_PATTERN,
  toolName: 'coord:orient',
  advisoryText:
    'The current time ALREADY ARRIVED — `host.now` on your last coord:orient is an ISO-8601 UTC instant, and every `date` format is a rendering of it. Read it there; do not call anything (calling orient to read a clock costs more than `date` did). ⚠ It is a SNAPSHOT of when that orient ran, not a live clock: if orient was an EARLIER turn, or you are differencing it for an age/duration, run `date -u` — a carried value yields a plausible wrong number, not an error. ⚠ AND it is UTC while this box renders LOCAL (-04:00): if you are reaching for `date` to compare against an `ls -l`/`stat`/`journalctl` stamp, swapping in `host.now` CAUSES a phantom 4h gap that reads as STALE. Put the other side in UTC first (`TZ=UTC stat -c \'%y %n\'`) rather than differencing a UTC instant against a local rendering.',
  routing: {
    want: 'the current date/time',
    // WI-2145714: kept under the 300-char table-cell bound. Both ⚠ clauses are
    // load-bearing and survive the trim — what was dropped is only the worked
    // example of the stamp forms, which the `insteadOf` column already carries.
    use: '`host.now` — already in your coord:orient payload (ISO-8601 UTC). Call nothing. ⚠ SNAPSHOT of when orient ran: on a LATER turn, or for any age/duration, use `date -u`. ⚠ UTC while this box renders LOCAL (-04:00) — put the other side in UTC (`TZ=UTC stat`) or you invent a phantom 4h gap.',
    insteadOf:
      '`date` / `date -u` / `date +%s`. ⚠ a `$(date …)` substitution INSIDE another command is string interpolation — keep using bash; so is `date -d @<epoch>` (a different instant)',
  },
  expectedVerdict: 'equivalent',
  cover(atom: string): CoverageResult {
    if (DATE_OTHER_INSTANT.test(atom)) {
      return {
        covered: false,
        reason: 'converts or sets a DIFFERENT instant (-d/-r/-s/-f), not a read of now',
      };
    }
    if (/\+%N|%N\b/.test(atom)) {
      return { covered: false, reason: 'nanosecond precision; host.now carries milliseconds' };
    }
    // NB every expression here names `coord:orient` (the harness asserts the
    // expression cites its pair's toolName) while saying DO NOT CALL IT — the
    // field is already in context, and calling a compound orient to read a clock
    // would cost strictly more than the `date` it replaces.
    //
    // Coverage is deliberately NOT narrowed here (e.g. declining `+%s` as
    // probable duration arithmetic): the verdict is `equivalent` against a
    // measured corpus, and one atom carries no evidence of how stale the
    // payload is. The staleness bound is guidance the reader applies, not a
    // property this matcher can see — hence the caveat rides the expression.
    return {
      covered: true,
      expression:
        'coord:orient payload → host.now // ISO-8601 UTC, already in context; do not re-call (snapshot of that orient — `date -u` if it was an earlier turn, or if differencing for an age)',
    };
  },
};

/**
 * P-026 — "how loaded is the box", the `uptime` half.
 *
 * 106 atoms of bare `uptime`. `host.load` is the same `loadavg()` triple that
 * `uptime` prints, and `host.cores` is the denominator that makes it readable —
 * which matters more than it looks: the operator runs under a CPUQuota, so a
 * load of ~80 is ~60% of a 128-core box, not the 6x oversubscription it would
 * appear to be against an effective count.
 */
export const loadRead: BashSubstitutionPair = {
  id: 'ambient.uptime',
  intentLabel: 'host-load',
  // Whole-command shape only: the verb, optionally with short flags, and nothing
  // else. `-p`/`-s` ask for uptime/boot time (a different question, excluded by
  // pattern per D-008); the `$` anchor drops the atomizer's quote fragments.
  bashPattern: /^uptime(?:\s+-(?!p\b|s\b)[A-Za-z]+)*$/,
  toolName: 'coord:orient',
  advisoryText:
    'Load average ALREADY ARRIVED — `host.load` (1/5/15m) plus `host.cores` as the denominator, on your last coord:orient. Read it there; do not call anything. NB high load is not on its own a reason to wait: the playbook requires a mechanism, not a load number.',
  routing: {
    want: 'the load average / how busy the box is',
    use: '`host.load` + `host.cores` — already in your coord:orient payload. Call nothing',
    insteadOf: '`uptime` (`uptime -p` / `-s` ask for BOOT TIME — a different question, still bash)',
  },
  expectedVerdict: 'equivalent',
  cover(atom: string): CoverageResult {
    if (/(?:^|\s)-(?:p|s)\b|--pretty|--since/.test(atom)) {
      return { covered: false, reason: 'asks for uptime/boot time, not load; host carries no boot time' };
    }
    return {
      covered: true,
      expression:
        'coord:orient payload → host.load // [1m,5m,15m] against host.cores; already in context, do not re-call',
    };
  },
};

/**
 * P-026 — the core count. The purest case in the whole audit: 44 atoms across
 * 27 sessions asking an INVARIANT of the machine, 9 of those sessions asking
 * more than once (max 6 times in one session — the answer could not have
 * changed between asks).
 */
export const coreCountRead: BashSubstitutionPair = {
  id: 'ambient.nproc',
  intentLabel: 'host-cores',
  bashPattern: /^nproc(?:\s+--all)?$/,
  toolName: 'coord:orient',
  advisoryText:
    "Core count ALREADY ARRIVED — `host.cores` on your last coord:orient, and it is the machine's logical core count exactly as `nproc` reports it. This is an invariant of the box; read it there and do not call anything.",
  routing: {
    want: 'how many CPU cores this machine has',
    use: '`host.cores` — already in your coord:orient payload. Call nothing',
    insteadOf: '`nproc` / `nproc --all`',
  },
  expectedVerdict: 'equivalent',
  cover(): CoverageResult {
    // `nproc` and `nproc --all` differ only for a process under CPU affinity;
    // host.cores is os.cpus().length, which is the `--all` sense and matches a
    // normal agent shell's `nproc`.
    return {
      covered: true,
      expression:
        "coord:orient payload → host.cores // the machine's logical core count; already in context, do not re-call",
    };
  },
};

/**
 * P-026 — free memory. 33 atoms over 4 distinct shapes (`free -h` 25, `free -g`
 * 6). `host.memFreePct` + `host.memTotalGb` answer the question in the form it
 * is actually asked ("is this box out of memory?"), and `host.psiMemSome60`
 * answers the follow-up a byte count cannot: whether the box is THRASHING —
 * the same PSI signal the watchdog alarms on.
 */
export const memoryRead: BashSubstitutionPair = {
  id: 'ambient.free',
  intentLabel: 'host-memory',
  // Whole-command shape only. `free -s N` is a continuous poll — a stream, not a
  // reading (D-008). A bare `\b` here also matched `free-port-base…​.ts` inside a
  // grep, which is the artifact documented on {@link AMBIENT_CONTEXT_PAIRS}.
  bashPattern: /^free(?:\s+-(?!s\b)[A-Za-z]+)*$/,
  toolName: 'coord:orient',
  advisoryText:
    'Memory ALREADY ARRIVED — `host.memFreePct` + `host.memTotalGb` on your last coord:orient, plus `host.psiMemSome60` (the PSI pressure the watchdog itself alarms on, which a free-byte count cannot tell you). Read it there; do not call anything.',
  routing: {
    want: 'free memory / whether the box is out of RAM',
    use: '`host.memFreePct` + `host.psiMemSome60` — already in your coord:orient payload. Call nothing',
    insteadOf: '`free -h` / `free -g`',
  },
  expectedVerdict: 'equivalent',
  cover(atom: string): CoverageResult {
    if (/(?:^|\s)-s\b|--seconds/.test(atom)) {
      return { covered: false, reason: 'continuous polling (`free -s N`) — a stream, not a reading' };
    }
    return {
      covered: true,
      expression:
        'coord:orient payload → host.memFreePct // % of host.memTotalGb, + host.psiMemSome60; already in context, do not re-call',
    };
  },
};

export const AMBIENT_CONTEXT_PAIRS: BashSubstitutionPair[] = [clockRead, loadRead, coreCountRead, memoryRead];
