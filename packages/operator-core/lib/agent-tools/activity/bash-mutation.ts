/**
 * Attribution-purpose "can this shell change anything?" detector for activity:mix.
 * (EI-23749240882032210)
 *
 * `implement` in an activity mix means the agent CHANGED something. A shell command that
 * only reads (grep / sed -n / ls / cd …) is investigation. The dispatcher already has a
 * read/write classifier (`classifyCapabilityBashEffect`), but it is a REPLAY-SAFETY
 * allowlist: it must never call a mutation "read", and it pays for that by treating
 * `grep`, `cd`, and ANY redirect or substitution (even `2>/dev/null`) as a write. Measured on
 * the real ledger (holder su-6aab097a, 2026-09-19T23:59Z–2026-09-20T03:04Z) that classifier
 * left every one of the holder's real shapes in `implement`, so reusing it as-is fixed nothing.
 *
 * The two purposes have the same failure direction (an unrecognised shell is NOT proven
 * read-only) but a different vocabulary, so this module is a thin attribution layer over
 * the dispatcher's own per-command decision, not a second allowlist:
 *   1. rewrite the constructs that provably cannot change state — `2>/dev/null`, `2>&1`,
 *      a `\|` inside double quotes, a `$(…)` whose body is itself non-mutating, a plain `$NAME`
 *      — into inert placeholders,
 *   2. let `splitClassifiableShell` reject everything it still cannot classify — any
 *      remaining redirect (`> file`, `>> file`, `< file`, heredocs), backticks, other `$`
 *      forms, background `&`, subshells,
 *   3. accept a segment when it is a read per the dispatcher's `classifiesSimpleRead`, a
 *      small attribution-only set of commands with no write mode (`cd`, `grep`, …), a `sed`
 *      whose script is a provably non-writing shape, an `xargs` over a data-only command,
 *      or a bare variable assignment.
 * Anything else — `rm`, `tee`, `npm`, `git commit`, an unknown binary, an unparseable
 * string — can mutate, so it stays `implement`. A false `implement` costs a slightly
 * pessimistic scorecard; a false `investigate` would hide a write, so every gap here
 * resolves toward "can mutate".
 */
import {
  classifiesReadOnlyAwk,
  classifiesSimpleRead,
  commandBase,
  sedIsObservational,
  splitClassifiableShell,
} from '../capability/bash-effect';

/** Inert stand-ins for an analysed `$(…)` and a plain `$NAME`. Only ever allowed as DATA (see below). */
const SUBST_TOKEN = '__pcsubst__';
const VAR_TOKEN = '__pcvar__';
/** Replaces a backslash-escaped shell metacharacter inside double quotes, which is literal data there. */
const ESCAPED_META_TOKEN = '\u00A6';
const MAX_SUBSTITUTION_DEPTH = 2;

/**
 * Redirections that cannot change state: output discarded to /dev/null, fd merging
 * (`2>&1`), and `</dev/null`. Matched sticky at a position OUTSIDE quotes only.
 */
const BENIGN_REDIRECT = /(?:&|\d)?>\s*\/dev\/null(?![\w./-])|\d?>&\d(?!\d)|<\s*\/dev\/null(?![\w./-])/y;
// A NON-nested command substitution whose body has no quotes, escapes, `$`, or backticks.
const SIMPLE_SUBSTITUTION = /\$\(([^()`$"'\\]*)\)/y;
const SIMPLE_VARIABLE = /\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})/y;

function rewriteExpansion(command: string, index: number, depth: number): { text: string; length: number } | null {
  SIMPLE_SUBSTITUTION.lastIndex = index;
  const substitution = SIMPLE_SUBSTITUTION.exec(command);
  if (substitution) {
    // A `$(rm x)` must stay a mutation: only a body that is itself non-mutating becomes inert data.
    if (depth >= MAX_SUBSTITUTION_DEPTH || canMutate(substitution[1]!, depth + 1)) return null;
    return { text: SUBST_TOKEN, length: substitution[0].length };
  }
  SIMPLE_VARIABLE.lastIndex = index;
  const variable = SIMPLE_VARIABLE.exec(command);
  if (variable) return { text: VAR_TOKEN, length: variable[0].length };
  return null;
}

function normalizeShell(command: string, depth: number): string {
  let out = '';
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;
    if (quote === "'") {
      out += char;
      if (char === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (char === '\\' && i + 1 < command.length) {
        const next = command[i + 1]!;
        // `\|` etc. is literal data inside double quotes (a grep alternation), never an operator.
        // `\$` and `\"` are left alone so splitClassifiableShell keeps rejecting `\$`.
        if (/[|;&<>()]/.test(next)) {
          out += ESCAPED_META_TOKEN;
        } else {
          out += char + next;
        }
        i += 1;
        continue;
      }
      if (char === '$') {
        const rewritten = rewriteExpansion(command, i, depth);
        if (rewritten) {
          out += rewritten.text;
          i += rewritten.length - 1;
          continue;
        }
      }
      out += char;
      if (char === '"') quote = null;
      continue;
    }
    if (char === '\\' && i + 1 < command.length) {
      out += char + command[i + 1]!;
      i += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      out += char;
      continue;
    }
    if (char === '$') {
      const rewritten = rewriteExpansion(command, i, depth);
      if (rewritten) {
        out += rewritten.text;
        i += rewritten.length - 1;
        continue;
      }
    }
    if (char === '>' || char === '<' || char === '&' || (char >= '0' && char <= '9')) {
      BENIGN_REDIRECT.lastIndex = i;
      const match = BENIGN_REDIRECT.exec(command);
      if (match) {
        out += ' ';
        i += match[0].length - 1;
        continue;
      }
    }
    out += char;
  }
  return out;
}

/**
 * Commands with NO way to write a file or run another command, that the dispatcher's
 * replay-safety allowlist omits only because they were never needed there. `cd` and
 * `grep` are the measured ones; the rest are the same shape. Deliberately excluded:
 * `tree` (`-o` writes), `find` (handled by the dispatcher, `-delete`/`-exec`), `env`
 * (runs other commands), `awk`/`perl` (arbitrary programs).
 */
const NO_WRITE_COMMANDS = new Set(['cd', 'grep', 'egrep', 'fgrep', 'jq', 'diff', 'cmp']);

/**
 * The only commands that may receive a `$(…)` / `$VAR` ARGUMENT or be the inner command of an
 * `xargs`. An expanded value is not visible to this analysis, so it must not be able to turn the
 * command into a writer: a `$F` handed to `find` could be `-delete`, to `sed` a script, to `git` a
 * subcommand. These take only file names / patterns / text and have no write or exec option.
 */
const DATA_ONLY_COMMANDS = new Set([
  '[',
  'basename',
  'cat',
  'cd',
  'cmp',
  'diff',
  'dirname',
  'echo',
  'egrep',
  'fgrep',
  'file',
  'grep',
  'head',
  'jq',
  'ls',
  'printf',
  'readlink',
  'realpath',
  'stat',
  'tail',
  'test',
  'wc',
]);

const XARGS_FLAGS = new Set(['-r', '--no-run-if-empty', '-0', '--null', '-t', '--verbose', '-x', '--exit']);
const XARGS_FLAGS_WITH_ARGUMENT = new Set(['-n', '-P', '-L', '-s', '-d', '-E', '-I', '-l']);

/**
 * `xargs <opts> <cmd> …` is only as dangerous as `<cmd>`, but stdin supplies EXTRA arguments the
 * analysis cannot see, so the inner command must be a data-only one (a `find`/`sed`/`git` could be
 * handed `-delete`/`-i`/a subcommand by the stream). An option this layer does not know is a mutation.
 */
function xargsIsObservational(tokens: readonly string[]): boolean {
  let i = 1;
  for (; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (!token.startsWith('-')) break;
    if (XARGS_FLAGS.has(token)) continue;
    if (XARGS_FLAGS_WITH_ARGUMENT.has(token)) {
      i += 1;
      continue;
    }
    if (/^-[nPLsdEIl]\S+$/.test(token) || /^--(?:max-args|max-procs|max-lines|max-chars|delimiter|eof|replace)=/.test(token)) {
      continue;
    }
    return false;
  }
  const inner = tokens.slice(i);
  if (inner.length === 0 || !DATA_ONLY_COMMANDS.has(commandBase(inner[0]!))) return false;
  return segmentIsObservational(inner);
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// Assignments that change what a LATER command resolves or how it runs — never inert.
const HOSTILE_ASSIGNMENT = /^(?:PATH|LD_[A-Z_]*|IFS|BASH_ENV|ENV|SHELL|PS4|PROMPT_COMMAND)=/;

function isExpanded(token: string): boolean {
  return token.includes(SUBST_TOKEN) || token.includes(VAR_TOKEN);
}

function segmentIsObservational(tokens: readonly string[]): boolean {
  // `f=$(ls …)` on its own only sets a shell variable.
  if (tokens.every((token) => ASSIGNMENT.test(token) && !HOSTILE_ASSIGNMENT.test(token))) return true;
  if (isExpanded(tokens[0] ?? '')) return false;
  const base = commandBase(tokens[0] ?? '');
  if (tokens.slice(1).some(isExpanded) && !DATA_ONLY_COMMANDS.has(base)) return false;
  if (base === 'sed') return sedIsObservational(tokens);
  if (base === 'xargs') return xargsIsObservational(tokens);
  if (NO_WRITE_COMMANDS.has(base)) return true;
  return classifiesSimpleRead(tokens) || classifiesReadOnlyAwk(tokens);
}

function canMutate(command: string, depth: number): boolean {
  const segments = splitClassifiableShell(normalizeShell(command, depth));
  if (segments === null) return true;
  return !segments.every((segment) => segmentIsObservational(segment));
}

/**
 * True when running `command` could change state (or when that cannot be ruled out).
 * Non-string input is a mutation: only a command we fully understood is called a read.
 */
export function bashCanMutate(command: unknown): boolean {
  if (typeof command !== 'string') return true;
  return canMutate(command, 0);
}

/** The command string of a `capability:bash` call — `command` wins over `cmd`, as in the dispatcher. */
export function capabilityBashCommand(args: unknown): unknown {
  if (!args || typeof args !== 'object') return undefined;
  const record = args as { command?: unknown; cmd?: unknown };
  return typeof record.command === 'string' ? record.command : record.cmd;
}
