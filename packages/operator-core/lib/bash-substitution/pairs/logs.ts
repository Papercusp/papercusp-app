/**
 * Equivalence pairs — the SERVICE-LOG family (plan
 * `bash-to-tool-substitution-2026-07-26`, P-023).
 *
 * Population (D-027, measured over the 7d corpus): 487 journalctl atoms / 428
 * whole commands (420 distinct) across 38 of 86 su sessions, concentrated on six
 * units (oddsmith-sidecar 152, live-federation-gate 91, bg-host 90, dev-api 43,
 * staging-api 20, plus a long tail). Proposed replacement: `logs:read`, built in
 * this same item.
 *
 * ── What measuring the corpus decided ───────────────────────────────────────
 * 413 of 428 commands (96%) pipe the journal into a CLIENT-SIDE filter — `|
 * grep` 292, `| tail` 102 — and NOT ONE uses journalctl's own `--grep`. So the
 * family's real shape is "the matching lines from unit U in window W", paid for
 * by dragging the whole window across a pipe first. The needles are content
 * markers ('[engine] composition audit:', 'oom|killed process', 'git-sync'),
 * never structure. `logs:read` therefore pushes the pattern down to `--grep` and
 * offers NO raw passthrough; the substitution is only faithful because of that.
 *
 * ── Why this family is a pair at all, and P-022's was not ───────────────────
 * D-026 established that a `not-a-substitute` row NEVER reaches an agent
 * (`match.ts` skips negative rows unconditionally, and the routing generator
 * emits only `equivalent` pairs), so for the long-job family the registry was
 * the wrong channel entirely. Here the verdict is genuinely positive and the
 * overlap test is clean — 0 of 487 atoms are claimed by ANY existing pair — so
 * the registry row and its CLAUDE.md routing row both render and both fire.
 *
 * ── The envelope, read from the tool, not assumed ───────────────────────────
 * `logs:read` (lib/agent-tools/logs/read.ts) takes
 * `{ unit?: string | string[1..10], identifier?, since?, until?, grep?(≤500),
 * level?, limit?(≤1000), system? }` and returns distilled entries. Consequences
 * that decide coverage below:
 *  • Output FORMATTING flags are no-ops: the tool always returns
 *    `{ts, unit, level, message}`, which subsumes `-o cat|short-iso|short-unix|
 *    json` (the only `-o` values the corpus actually passes to journalctl) and
 *    `--no-pager`.
 *  • `--since`/`--until` strings pass through VERBATIM to journalctl, so every
 *    grammar the corpus uses ('-3min', '30 min ago', '09:40:00', an absolute
 *    stamp) is expressible without translation.
 *  • A read that is not a WINDOW QUERY is a different request and is excluded by
 *    PATTERN rather than failed by the envelope (D-008): `-f`/`--follow`
 *    (streaming, 4 atoms — the same caveat `capability:read` carries for
 *    `tail -f`), boot selection, `-k` kernel/dmesg, `--reverse`, cursor
 *    navigation, arbitrary `FIELD=value` matches, custom `--output-fields`, and
 *    every journal MAINTENANCE verb (`--vacuum-*`, `--rotate`, `--verify`).
 *  • `sudo journalctl` is excluded: the tool has no elevation, so an elevated
 *    read is not a differently-spelled version of the same request.
 */

import type { CoverageResult, ReplayToolCall, BashSubstitutionPair } from '../types';
import { JOURNAL_LEVELS, JOURNAL_READ_MAX_LIMIT, type JournalScope } from '../../journal-read';

/** Mirrors `logs:read`'s `unit` array bound. Exported so `pairs/model-drift.test.ts`
 *  can pin it to the tool's real zod `.max()` (D-015) — the mirror is deliberate,
 *  the DRIFT is not. */
export const LOGS_READ_MAX_UNITS = 10;
/** Mirrors `logs:read`'s `grep` length bound, same rationale. */
export const LOGS_READ_MAX_GREP = 500;
/** Mirrors `logs:read`'s `since`/`until` length bound, same rationale. */
export const LOGS_READ_MAX_WINDOW = 100;
/** Mirrors `logs:read`'s `limit` ceiling, sourced from the tool's own constant. */
export const LOGS_READ_MAX_LIMIT = JOURNAL_READ_MAX_LIMIT;

/**
 * journalctl output formats the distilled projection faithfully subsumes.
 *
 * All of these are TEXT RENDERINGS of the same records — the tool returns the
 * fields they render (`ts`, `unit`, `level`, `message`) structurally, so asking
 * for one of them is asking for a formatting of what the tool already gives.
 * Anything else (a field projection, an export stream) is a different request.
 */
const SUBSUMED_OUTPUT_FORMATS = new Set([
  'cat', 'short', 'short-iso', 'short-iso-precise', 'short-precise',
  'short-unix', 'short-full', 'short-monotonic', 'json', 'json-pretty',
]);

/**
 * Atoms this family must never claim, excluded by PATTERN per D-008.
 *
 * The first line is the shared shell-dynamism exclusion every family in this
 * registry uses (`$`/backtick expansion, glob, `find -exec` placeholder, stdout
 * redirect). `2>/dev/null` is NOT a redirect for this purpose — it is stderr
 * plumbing and appears on the majority of these commands, so treating it as a
 * write would empty the family.
 *
 * The rest are journalctl modes that are a DIFFERENT QUESTION, not a differently
 * spelled one. They are listed explicitly rather than left to `cover()` because
 * D-008's standard is that a pattern claims a command only when every token in
 * it is expressible — a pattern that claims `journalctl -f` and then fails it in
 * the envelope reports `needs-widening` for a shape the tool was never meant to
 * serve, which is how a family that is genuinely equivalent gets scored as if it
 * were broken.
 */
const EXCLUDE_UNEXPRESSIBLE =
  String.raw`(?![^\n]*[$\`])(?![^\n]*[*?])(?![^\n]*\{\})(?![^\n]*(?:^|\s)1?>)` +
  // streaming follow — no request/response form
  String.raw`(?![^\n]*(?:^|\s)(?:-\w*f\b|--follow))` +
  // boot selection / kernel ring buffer / reverse ordering / cursor navigation
  String.raw`(?![^\n]*(?:^|\s)(?:-\w*[kbre]\b|--boot|--list-boots|--dmesg|--reverse|--cursor|--after-cursor|--show-cursor|--pager-end))` +
  // field projection, arbitrary field matches, and the merge/namespace/alternate-journal selectors
  String.raw`(?![^\n]*--output-fields)(?![^\n]*(?:^|\s)_?[A-Z][A-Z0-9_]*=)` +
  String.raw`(?![^\n]*(?:^|\s)(?:-\w*[mDNF]\b|--merge|--directory|--file|--root|--machine|--namespace|--field|--fields))` +
  // journal maintenance verbs — writes, not reads
  String.raw`(?![^\n]*--(?:vacuum|rotate|verify|flush|sync|relinquish|setup-keys|disk-usage|header|update-catalog))`;

/**
 * A claimed read must be SCOPED — by a unit, a syslog identifier, or at least a
 * window. `logs:read` refuses a host-wide read with no `since` on purpose: it
 * walks every unit in the journal (measured 25.97s versus 7.58s unit-scoped on
 * the same 1.2GB journal, for a read that returned 17 bytes).
 *
 * That refusal is expressed HERE, in the pattern, and not left to `cover()`,
 * because a shape the tool deliberately declines is not a shape it is missing —
 * failing it in the envelope would score this family `needs-widening` for
 * working exactly as designed. Two corpus atoms fall outside (`journalctl -o cat`,
 * `journalctl --user -n 20`); they keep using bash, and the routing row says so.
 * `coverJournalCommand` still checks the same condition, deliberately: if this
 * lookahead is ever loosened, the envelope refuses honestly instead of silently
 * claiming a read the tool would reject at runtime.
 */
const REQUIRE_SCOPE =
  String.raw`(?=[^\n]*(?:^|\s)(?:-[utS]\b|--unit|--user-unit|--identifier|--since))`;

/** One journalctl invocation, parsed into the request it expresses. */
export interface ParsedJournalCommand {
  units: string[];
  identifiers: string[];
  since: string | null;
  until: string | null;
  grep: string | null;
  level: string | null;
  limit: number | null;
  /**
   * Which journal the command asked for. `--user` and `--system` are DIFFERENT
   * JOURNALS and passing neither is a third request (everything visible), so
   * this is three-valued. 18 claimed atoms across 6 sessions pass neither, and
   * every one targets a system unit (`systemd-oomd`, `pgbouncer`,
   * `kopia-snapshots`) — collapsing them onto `--user` would have expressed each
   * as a read of a journal that cannot contain the answer.
   */
  scope: JournalScope;
  outputFormats: string[];
  /** Flags with no `logs:read` argument and no no-op reading. */
  unexpressible: string[];
}

/** Flags that change nothing about the REQUEST (pager/colour/quiet chrome). */
const NOOP_FLAGS = new Set([
  '--no-pager', '--no-hostname', '--no-full', '--full', '--all', '--quiet', '-q',
  '--utc', '--catalog', '-x', '--no-tail', '--case-sensitive',
]);

/** Split a shell atom into tokens, honouring single and double quotes. */
export function tokenizeAtom(atom: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(atom)) !== null) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

/** Strip surrounding quotes a token kept from a `--flag="value"` form. */
function unquote(value: string): string {
  return value.replace(/^(['"])(.*)\1$/s, '$2');
}

/**
 * PURE — parse a journalctl atom into the request it expresses.
 *
 * Handles both `--flag value` and `--flag=value` spellings, and the short forms
 * the corpus actually uses (`-u`, `-t`, `-p`, `-n`, `-o`). An unrecognised flag
 * lands in `unexpressible`, which is what makes coverage a whitelist rather than
 * an optimistic guess.
 */
export function parseJournalctlAtom(atom: string): ParsedJournalCommand {
  const tokens = tokenizeAtom(atom).slice(1); // drop the `journalctl` verb
  const parsed: ParsedJournalCommand = {
    units: [], identifiers: [], since: null, until: null, grep: null,
    // `all` is the correct INITIAL value, not a default we picked: it is what
    // journalctl does when neither --user nor --system is passed.
    level: null, limit: null, scope: 'all', outputFormats: [], unexpressible: [],
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    // Shell plumbing that is not an operand: stderr redirection, backgrounding,
    // and a trailing `\` line-continuation (8 atoms in the corpus end with one,
    // because `atomize` normalises a multi-line command and keeps the marker).
    if (!token || /^2>/.test(token) || token === '&' || token === '2>&1' || token === '\\') continue;

    const eq = token.indexOf('=');
    const isLong = token.startsWith('--');
    const name = isLong && eq > -1 ? token.slice(0, eq) : token;
    const inlineValue = isLong && eq > -1 ? unquote(token.slice(eq + 1)) : null;
    /** Value for a flag: the inline `=` form, else the next token. */
    const takeValue = (): string => {
      if (inlineValue !== null) return inlineValue;
      const next = tokens[i + 1];
      i += 1;
      return next === undefined ? '' : unquote(next);
    };

    switch (name) {
      case '-u': case '--unit': case '--user-unit': parsed.units.push(takeValue()); break;
      case '-t': case '--identifier': parsed.identifiers.push(takeValue()); break;
      case '--since': case '-S': parsed.since = takeValue(); break;
      case '--until': case '-U': parsed.until = takeValue(); break;
      case '--grep': parsed.grep = takeValue(); break;
      case '-p': case '--priority': parsed.level = takeValue(); break;
      case '-n': case '--lines': {
        // `-n` with no numeric operand is journalctl's own default of 10.
        const next = tokens[i + 1];
        if (inlineValue !== null) parsed.limit = Number(inlineValue);
        else if (next !== undefined && /^\d+$/.test(next)) { parsed.limit = Number(next); i += 1; }
        else parsed.limit = 10;
        break;
      }
      case '-o': case '--output': parsed.outputFormats.push(takeValue()); break;
      case '--user': parsed.scope = 'user'; break;
      case '--system': parsed.scope = 'system'; break;
      default:
        if (NOOP_FLAGS.has(name)) break;
        // A bare non-flag operand is a journalctl MATCH expression (a unit path
        // or an executable), which the tool has no argument for.
        parsed.unexpressible.push(name);
    }
  }
  return parsed;
}

/** Render the `logs:read` call that reproduces a parsed command. */
function expressionFor(parsed: ParsedJournalCommand): string {
  const args: string[] = [];
  if (parsed.units.length === 1) args.push(`unit:'${parsed.units[0]}'`);
  else if (parsed.units.length > 1) args.push(`unit:[${parsed.units.map((u) => `'${u}'`).join(', ')}]`);
  if (parsed.identifiers.length) args.push(`identifier:'${parsed.identifiers[0]}'`);
  if (parsed.since) args.push(`since:'${parsed.since}'`);
  if (parsed.until) args.push(`until:'${parsed.until}'`);
  if (parsed.grep) args.push(`grep:'${parsed.grep}'`);
  if (parsed.level) args.push(`level:'${parsed.level}'`);
  if (parsed.limit !== null) args.push(`limit:${parsed.limit}`);
  // `user` is the tool's default, so only a non-default scope needs stating.
  if (parsed.scope !== 'user') args.push(`scope:'${parsed.scope}'`);
  return `logs:read { ${args.join(', ')} }`;
}

/** PURE — can `logs:read` express this parsed command? */
export function coverJournalCommand(parsed: ParsedJournalCommand): CoverageResult {
  if (parsed.unexpressible.length) {
    return { covered: false, reason: `passes \`${parsed.unexpressible[0]}\`, which logs:read has no argument for` };
  }
  if (parsed.units.length > LOGS_READ_MAX_UNITS) {
    return { covered: false, reason: `names ${parsed.units.length} units; logs:read caps \`unit\` at ${LOGS_READ_MAX_UNITS}` };
  }
  if (parsed.identifiers.length > 1) {
    return { covered: false, reason: `names ${parsed.identifiers.length} syslog identifiers; logs:read takes one` };
  }
  if (parsed.level !== null && !(JOURNAL_LEVELS as readonly string[]).includes(parsed.level)) {
    // A numeric or ranged priority (`-p 0..3`) is a real journalctl form the
    // tool's enum cannot express — name it rather than silently mapping it.
    return { covered: false, reason: `priority \`${parsed.level}\` is not one of logs:read's level names (${JOURNAL_LEVELS.join('|')})` };
  }
  if (parsed.limit !== null && (!Number.isFinite(parsed.limit) || parsed.limit > LOGS_READ_MAX_LIMIT)) {
    return { covered: false, reason: `asks for ${parsed.limit} lines; logs:read caps \`limit\` at ${LOGS_READ_MAX_LIMIT}` };
  }
  if (parsed.grep !== null && parsed.grep.length > LOGS_READ_MAX_GREP) {
    return { covered: false, reason: `--grep pattern is ${parsed.grep.length} chars; logs:read caps \`grep\` at ${LOGS_READ_MAX_GREP}` };
  }
  for (const [label, value] of [['since', parsed.since], ['until', parsed.until]] as const) {
    if (value !== null && value.length > LOGS_READ_MAX_WINDOW) {
      return { covered: false, reason: `\`${label}\` is ${value.length} chars; logs:read caps it at ${LOGS_READ_MAX_WINDOW}` };
    }
  }
  const oddFormat = parsed.outputFormats.find((f) => !SUBSUMED_OUTPUT_FORMATS.has(f));
  if (oddFormat) {
    return { covered: false, reason: `asks for \`-o ${oddFormat}\`, which is not a rendering of the fields logs:read returns` };
  }
  // A read with NO unit, NO identifier and NO window is a host-wide unbounded
  // scan; the tool refuses that shape by design (it walks every unit in the
  // journal), so it is genuinely not expressible rather than merely discouraged.
  if (!parsed.units.length && !parsed.identifiers.length && !parsed.since) {
    return { covered: false, reason: 'host-wide read with no window; logs:read requires `since` when neither unit nor identifier scopes the read' };
  }
  return { covered: true, expression: expressionFor(parsed) };
}

/**
 * P-023 — `journalctl --user -u <unit> --since <w>`: the window read, 91% of the
 * family. The substitution's value is the SERVER-SIDE filter: the `| grep` that
 * followed 70% of these commands becomes `grep`, so the non-matching lines are
 * never read at all rather than read and discarded.
 */
export const unitJournalRead: BashSubstitutionPair = {
  id: 'logs.unit-journal',
  intentLabel: 'service-log-read',
  bashPattern: new RegExp(`^${EXCLUDE_UNEXPRESSIBLE}${REQUIRE_SCOPE}journalctl\\b`),
  toolName: 'logs:read',
  advisoryText:
    'logs:read { unit, since, grep } pushes the filter down to `journalctl --grep`, so only matching lines are ever read, and collapses repeated identical lines — no `| grep … | tail -n` afterwards. It also names a unit systemd does not know, which a raw journalctl reports as an empty (clean-looking) window.',
  routing: {
    want: "a service's log lines in a time window, filtered",
    use: '`logs:read { unit, since, grep?, level?, limit? }` (filter pushed down to `journalctl --grep`; repeats collapsed)',
    insteadOf: '`journalctl --user -u <unit> --since <w> | grep <pat> | tail -n` (a streaming `-f` follow, a boot/cursor selection, or `sudo` elevation has no tool form — keep using bash for those)',
  },
  expectedVerdict: 'equivalent',
  cover(atom: string): CoverageResult {
    return coverJournalCommand(parseJournalctlAtom(atom));
  },
  /**
   * P-009 — the executable form of {@link expressionFor}, gated on `cover()`.
   *
   * `unit` mirrors the display form's shape rather than always emitting an
   * array: one unit is a string, several are a list. That is the tool's own
   * argument shape, and emitting `["x"]` for the single-unit case — 91% of this
   * family — would make the commonest envelope read as the rarer request.
   *
   * `scope` is emitted ONLY when non-default, again mirroring `expressionFor`:
   * `user` is `logs:read`'s default, and spelling a default back out makes the
   * call look like it is asserting something it is not.
   *
   * No `replayEnvelope`: `journalctl` is off REPLAYABLE_VERBS (D-060 untouched).
   */
  rewrite(atom: string): ReplayToolCall | null {
    const parsed = parseJournalctlAtom(atom);
    if (!coverJournalCommand(parsed).covered) return null;

    const args: Record<string, unknown> = {};
    if (parsed.units.length === 1) args.unit = parsed.units[0];
    else if (parsed.units.length > 1) args.unit = [...parsed.units];
    if (parsed.identifiers.length) args.identifier = parsed.identifiers[0];
    if (parsed.since) args.since = parsed.since;
    if (parsed.until) args.until = parsed.until;
    if (parsed.grep) args.grep = parsed.grep;
    if (parsed.level) args.level = parsed.level;
    if (parsed.limit !== null) args.limit = parsed.limit;
    if (parsed.scope !== 'user') args.scope = parsed.scope;

    return { toolName: 'logs:read', args };
  },
};

/** Every pair in the service-log family, in registry order. */
export const LOGS_PAIRS: BashSubstitutionPair[] = [unitJournalRead];
