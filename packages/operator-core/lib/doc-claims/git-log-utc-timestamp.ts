/**
 * git-log-utc-timestamp.ts — EI-20687080717457981.
 *
 * THE CLAIM THIS PINS: the `git log` command CLAUDE.md prescribes for "which commit
 * carries your change" must actually print the timestamp in UTC, because every other
 * timestamp an agent compares it against (Papercusp work-items, coord messages,
 * `dev:pipeline_position`) is UTC.
 *
 * WHY THIS NEEDS A MACHINE. `TZ=UTC` looks like it governs the output and does not.
 * MEASURED 2026-08-17 on this box (local offset -0400), against a commit deliberately
 * authored at +09:00:
 *
 *     %cd            (no TZ)                  -> Sun Aug 16 12:00:00 2026 +0900
 *     TZ=UTC %cI                              -> 2026-08-16T12:00:00+09:00   <-- INERT
 *     TZ=UTC --date=iso-strict                -> 2026-08-16T12:00:00+09:00   <-- INERT
 *     TZ=UTC --date=iso-strict-local %cd      -> 2026-08-16T03:00:00+00:00   <-- correct
 *
 * Two separate defects follow, and the doc had BOTH:
 *
 *   1. `TZ=UTC git log ... --format='%cI ...'` — the `TZ=UTC` is inert. `%cI`/`%aI` and
 *      the default `%cd`/`%ad` render the COMMIT'S OWN recorded offset and ignore `TZ`
 *      entirely. Only a `--date=*-local` format is rendered in the `TZ` zone.
 *   2. The prose explained this as "git renders `%ad`/`%cd` in the machine's local
 *      timezone". It does not — it renders the commit's own offset. `--date=local` is
 *      the machine-local form. On THIS repo the two are indistinguishable (all 3000
 *      sampled commits carry -04:00, the box's own offset), which is exactly why the
 *      wrong explanation survived: the repo cannot falsify it, only a foreign-offset
 *      commit can.
 *
 * WHY IT IS DANGEROUS RATHER THAN UNTIDY: the wrong output is well-formed and looks
 * like a UTC ISO-8601 stamp. Reading `2026-08-16T03:25:36-04:00` as UTC is a silent
 * 4-hour error in the direction that matters most — gate triage, where agents compare a
 * commit time against a run's UTC window to decide whether a fix predates a candidate.
 * EI-20687080717457981 was filed after exactly such a comparison produced a confident
 * false conclusion (its own diagnosis — history simplification — was not the cause; the
 * `git log` answer there was correct and the timestamp comparison was not).
 *
 * SCOPE — this judges the DOC TEXT's prescription only. It says nothing about whether
 * `git log` reports the right COMMIT; that is a separate claim with a separate probe
 * (`git rev-parse <sha>:<path>` blob equality), deliberately not conflated here.
 */

/** A prescribed command line, with the properties that decide the verdict. */
export interface CommandSite {
  readonly line: string;
  readonly lineNo: number;
  /** Placeholders/flags that render a timestamp carrying an offset. */
  readonly offsetPlaceholders: readonly string[];
  /** True when a `--date=...-local` format is present (the only TZ-honouring form). */
  readonly hasLocalDateFormat: boolean;
  readonly hasTzUtc: boolean;
}

export interface GitLogUtcVerdict {
  readonly ok: boolean;
  /** `TZ=UTC` paired with an offset-bearing placeholder and no `--date=*-local`. */
  readonly inertTzSites: readonly CommandSite[];
  /** Prose asserting `%ad`/`%cd` render in the MACHINE's local timezone. */
  readonly machineLocalClaimSites: readonly { line: string; lineNo: number }[];
  /** Every `git log` prescription found, whether or not it violates. */
  readonly commandSites: readonly CommandSite[];
  readonly violations: readonly string[];
}

/**
 * Placeholders whose rendering IGNORES `TZ`. `%cI`/`%aI` are strict-ISO with the
 * commit's own offset; bare `%cd`/`%ad` use `--date` (default: the commit's own
 * offset). None of them is UTC unless a `*-local` date format is also supplied.
 */
const OFFSET_PLACEHOLDERS = ['%cI', '%aI', '%cd', '%ad'] as const;

/** `--date=iso-strict-local`, `--date=local`, `--date=iso-local`, … */
const LOCAL_DATE_FORMAT = /--date=[a-z0-9-]*\blocal\b/;

const MIN_JUDGEABLE_CHARS = 200;

/**
 * Judge a doc body (CLAUDE.md, AGENTS.md, or the projected corpus).
 *
 * REFUSES a body too short to contain the claim rather than reporting it clean — a
 * failed/moved read must never be indistinguishable from a passing gate.
 */
export function judgeGitLogUtcClaim(docText: string): GitLogUtcVerdict {
  if (!docText || docText.length < MIN_JUDGEABLE_CHARS) {
    throw new Error(
      `Refusing to judge a ${docText?.length ?? 0}-char doc body: too short to contain ` +
        'the git-log prescription. A failed read must not read as a clean verdict.',
    );
  }

  const lines = docText.split('\n');
  const commandSites: CommandSite[] = [];
  const machineLocalClaimSites: { line: string; lineNo: number }[] = [];

  lines.forEach((line, i) => {
    const lineNo = i + 1;

    if (/\bgit\s+log\b/.test(line)) {
      const offsetPlaceholders = OFFSET_PLACEHOLDERS.filter((p) => line.includes(p));
      if (offsetPlaceholders.length > 0) {
        commandSites.push({
          line: line.trim(),
          lineNo,
          offsetPlaceholders,
          hasLocalDateFormat: LOCAL_DATE_FORMAT.test(line),
          hasTzUtc: /\bTZ=UTC\b/.test(line),
        });
      }
    }

    // The false explanation. Matched on the operative pair (a %ad/%cd mention plus
    // "machine's local"), not on exact wording, so a reflow cannot smuggle it back.
    const mentionsPlaceholder = /%[ac]d\b/.test(line);
    const claimsMachineLocal = /machine'?s\s+local\s+time\s*zone|machine'?s\s+local\s+timezone/i.test(
      line,
    );
    if (mentionsPlaceholder && claimsMachineLocal) {
      machineLocalClaimSites.push({ line: line.trim(), lineNo });
    }
  });

  const inertTzSites = commandSites.filter((s) => s.hasTzUtc && !s.hasLocalDateFormat);

  const violations: string[] = [];

  if (commandSites.length === 0) {
    violations.push(
      'No `git log` prescription with a timestamp placeholder was found at all. Either ' +
        'the rule moved or the read is wrong — this is the false-absence shape, not a pass.',
    );
  }

  for (const site of inertTzSites) {
    violations.push(
      `line ${site.lineNo}: \`TZ=UTC\` is INERT here — ${site.offsetPlaceholders.join('/')} ` +
        'renders the commit\'s own offset regardless of TZ. The output looks like an ISO ' +
        'stamp but is not UTC. Use `--date=iso-strict-local` (with TZ=UTC) to get +00:00. ' +
        `Offending line: ${site.line}`,
    );
  }

  for (const site of machineLocalClaimSites) {
    violations.push(
      `line ${site.lineNo}: git does NOT render %ad/%cd in the MACHINE's local timezone — ` +
        'it renders the COMMIT\'s own recorded offset (`--date=local` is the machine-local ' +
        `form). Offending line: ${site.line}`,
    );
  }

  return {
    ok: violations.length === 0,
    inertTzSites,
    machineLocalClaimSites,
    commandSites,
    violations,
  };
}

/**
 * Extract the runnable `git log` invocations a doc prescribes, so a test can EXECUTE
 * them rather than pattern-match them. Returns the command text with surrounding
 * markdown/backticks/blockquote markers stripped.
 */
export function extractGitLogCommands(docText: string): string[] {
  const out: string[] = [];
  for (const raw of docText.split('\n')) {
    const line = raw.replace(/^\s*>\s?/, '');
    // A prescription is delimited by backticks in this doc.
    for (const m of line.matchAll(/`([^`]*\bgit\s+log\b[^`]*)`/g)) {
      const cmd = m[1].trim();
      if (OFFSET_PLACEHOLDERS.some((p) => cmd.includes(p))) out.push(cmd);
    }
  }
  return out;
}
