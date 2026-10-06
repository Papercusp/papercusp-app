/**
 * Conservative argument-sensitive effect classification for capability:bash.
 *
 * This module stays dependency-free so both the tool dispatcher and the
 * always-up MCP proxy can use the exact same safety decision. Unknown shell
 * syntax is a write: a false negative only forgoes a retry, while a false
 * positive could replay a mutation.
 */

export type BashEffect = 'read' | 'write';

/**
 * Split the small shell language we are willing to classify. This is deliberately
 * not a shell parser: anything that could hide another command or redirect output
 * is rejected so the caller keeps capability:bash's normal write classification.
 */
export function splitClassifiableShell(command: string): string[][] | null {
  if (!command.trim() || command.includes('\0')) return null;

  const segments: string[][] = [];
  let words: string[] = [];
  let word = '';
  let quote: "'" | '"' | null = null;

  const flushWord = (): void => {
    if (word) {
      words.push(word);
      word = '';
    }
  };
  const flushSegment = (): boolean => {
    flushWord();
    if (words.length === 0) return false;
    segments.push(words);
    words = [];
    return true;
  };

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;

    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null;
        continue;
      }
      if (char === '$' || char === '`') return null;
      if (char === '\\') {
        const next = command[i + 1];
        if (next === undefined || /[;&|<>`()$`]/.test(next)) return null;
        word += next;
        i += 1;
        continue;
      }
      word += char;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '\\') {
      const next = command[i + 1];
      if (next === undefined || /[;&|<>`()$`]/.test(next)) return null;
      word += next;
      i += 1;
      continue;
    }
    if (char === '`' || char === '$') return null;
    if (char === '<' || char === '>') return null;
    if (char === '&') {
      if (command[i + 1] !== '&') return null;
      if (!flushSegment()) return null;
      i += 1;
      continue;
    }
    if (char === '|') {
      if (command[i + 1] === '&') return null;
      if (!flushSegment()) return null;
      if (command[i + 1] === '|') i += 1;
      continue;
    }
    if (char === ';' || char === '\n') {
      if (!flushSegment()) return null;
      continue;
    }
    if (/\s/.test(char)) {
      flushWord();
      continue;
    }
    if (char === '(' || char === ')' || char === '{' || char === '}') return null;
    word += char;
  }

  if (quote !== null || !flushSegment()) return null;
  return segments;
}

export function commandBase(command: string): string {
  const slash = command.lastIndexOf('/');
  return (slash >= 0 ? command.slice(slash + 1) : command).toLowerCase();
}

const READ_ONLY_COMMANDS = new Set([
  '[',
  'basename',
  'cat',
  'column',
  'cut',
  'date',
  'df',
  'dirname',
  'dmesg',
  'du',
  'echo',
  'file',
  'free',
  'fuser',
  'getconf',
  'findmnt',
  'groups',
  'head',
  'hostname',
  'id',
  'iostat',
  'journalctl',
  'ls',
  'lsof',
  'mpstat',
  'netstat',
  'pgrep',
  'pidof',
  'printf',
  'ps',
  'pwd',
  'readlink',
  'realpath',
  'rg',
  'sed',
  'sleep',
  'sort',
  'ss',
  'stat',
  'strings',
  'tail',
  'test',
  'tr',
  'true',
  'type',
  'uname',
  'uniq',
  'uptime',
  'vmstat',
  'wc',
  'whereis',
  'which',
  'whoami',
]);

const READ_ONLY_SYSTEMCTL_COMMANDS = new Set([
  'cat',
  'help',
  'is-active',
  'is-enabled',
  'is-failed',
  'list-dependencies',
  'list-unit-files',
  'list-units',
  'show',
  'status',
  '--version',
]);

const READ_ONLY_IP_COMMANDS = new Set(['address', 'addr', 'link', 'neigh', 'neighbor', 'route', 'rule']);
// `find` has a read-only default, but several predicates execute commands or
// write files. Keep those action operands write-classified even when every
// surrounding pipeline stage is observational.
const FIND_MUTATING_ACTIONS = new Set([
  '-delete',
  '-exec',
  '-execdir',
  '-fls',
  '-fprint',
  '-fprint0',
  '-fprintf',
  '-ok',
  '-okdir',
]);
const SHELL_MUTATION_WORDS = new Set([
  'add',
  'append',
  'change',
  'clear',
  'del',
  'delete',
  'flush',
  'kill',
  'replace',
  'restart',
  'rm',
  'set',
  'start',
  'stop',
]);

/**
 * What a command's option parser can do that makes it more than an observation. The callers are
 * replay and dry-run safety, so every ambiguity resolves toward "writes".
 *
 * This replaces an exact-token denylist (`token === '-o' || token.startsWith('-o=')`) that could
 * not see an attached short argument (`sort -o/tmp/x`), a short cluster (`fuser -km`, `strace -fo`),
 * or a GNU getopt_long abbreviation (`sort --out=`, `dmesg --cl`) — WI-10005111, the same hole
 * WI-10005084 closed for `sed`.
 */
interface WritingOptionSpec {
  /** Short option letters that write or execute when they appear anywhere in a cluster (`-ro`). */
  readonly shortWriting?: string;
  /**
   * Short option letters that take an argument. getopt gives such a letter the REST of its cluster
   * (`-to` is `-t o`, not `-t -o`), or the next token when nothing follows, so the walk stops there.
   * A letter that also writes belongs in BOTH sets — the writing check runs first.
   */
  readonly shortWithArg?: string;
  /**
   * Short option letters whose argument is OPTIONAL and therefore only ever the rest of the cluster
   * (`date -Iseconds`, `git status -uno`): the walk stops there but the next token stays an operand.
   */
  readonly shortOptionalArg?: string;
  /**
   * Full long option names (with the `--`) that write or execute. A `--name[=value]` token whose
   * name is any PREFIX of one counts as that option: getopt_long accepts every unique
   * abbreviation, and an ambiguous one is a usage error that does nothing, so over-matching is safe.
   */
  readonly longWriting?: readonly string[];
  /** Long options whose argument is the NEXT token (`--date STRING`), so it is not read as an operand. */
  readonly longWithArg?: readonly string[];
  /** Operands (non-option words) that make the command write: `date MMDDhhmm`, `uniq in out`, `hostname NAME`. */
  readonly operandsWrite?: (operands: readonly string[]) => boolean;
}

/**
 * Walk a command's tokens the way getopt does and report whether any option the spec lists as
 * writing is present. Dependency-free on purpose: this module is shared with the always-up MCP proxy.
 */
function hasWritingOption(tokens: readonly string[], spec: WritingOptionSpec): boolean {
  const shortWriting = spec.shortWriting ?? '';
  const shortWithArg = spec.shortWithArg ?? '';
  const shortOptionalArg = spec.shortOptionalArg ?? '';
  const longWriting = spec.longWriting ?? [];
  const longWithArg = spec.longWithArg ?? [];
  const operands: string[] = [];
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token === '--') {
      operands.push(...tokens.slice(i + 1));
      break;
    }
    if (token === '-' || !token.startsWith('-')) {
      operands.push(token);
      continue;
    }
    if (token.startsWith('--')) {
      const equals = token.indexOf('=');
      const name = equals === -1 ? token : token.slice(0, equals);
      if (longWriting.some((option) => option.startsWith(name))) return true;
      if (equals === -1 && longWithArg.some((option) => option.startsWith(name))) i += 1;
      continue;
    }
    for (let c = 1; c < token.length; c += 1) {
      const flag = token[c]!;
      if (shortWriting.includes(flag)) return true;
      if (shortWithArg.includes(flag)) {
        if (c === token.length - 1) i += 1;
        break;
      }
      if (shortOptionalArg.includes(flag)) break;
    }
  }
  return spec.operandsWrite?.(operands) ?? false;
}

/** Options (per each command's man page) that write a file, change system state, or run another program. */
const WRITING_OPTIONS: Readonly<Record<string, WritingOptionSpec>> = {
  // -C/-c clear the ring buffer, -D/-E switch console logging, -n sets the console level.
  dmesg: {
    shortWriting: 'CcDEn',
    shortWithArg: 'FfKlns',
    longWriting: ['--clear', '--read-clear', '--console-off', '--console-on', '--console-level'],
  },
  // -s / --set sets the clock — and so does a bare `MMDDhhmm[[CC]YY][.ss]` operand.
  date: {
    shortWriting: 's',
    shortWithArg: 'dfrs',
    shortOptionalArg: 'I',
    longWriting: ['--set'],
    longWithArg: ['--date', '--file', '--reference', '--rfc-3339', '--resolution'],
    operandsWrite: (operands) => operands.some((operand) => !operand.startsWith('+')),
  },
  fuser: { shortWriting: 'k', shortWithArg: 'n', longWriting: ['--kill'], longWithArg: ['--namespace'] },
  // --pre and --hostname-bin execute the named program.
  rg: { longWriting: ['--pre', '--hostname-bin'] },
  // -K kills sockets; -D / --diag dumps raw socket data to a file.
  ss: { shortWriting: 'KD', shortWithArg: 'ADFfN', longWriting: ['--kill', '--diag'] },
  // -o / --output name the output file; --compress-program executes a program.
  sort: {
    shortWriting: 'o',
    shortWithArg: 'koSTt',
    longWriting: ['--output', '--compress-program'],
    longWithArg: ['--key', '--field-separator', '--buffer-size', '--temporary-directory'],
  },
  // -C / --compile writes a magic.mgc file.
  file: { shortWriting: 'C', shortWithArg: 'fFmeP', longWriting: ['--compile'] },
  journalctl: {
    longWriting: [
      '--flush',
      '--relinquish-var',
      '--smart-relinquish-var',
      '--rotate',
      '--sync',
      '--vacuum-size',
      '--vacuum-time',
      '--vacuum-files',
      '--setup-keys',
      '--update-catalog',
    ],
  },
  // `hostname NAME` and `-F`/`-b` set the hostname.
  hostname: { shortWriting: 'Fb', longWriting: ['--file', '--boot'], operandsWrite: (operands) => operands.length > 0 },
  // `uniq INPUT OUTPUT`: the second operand is a file that gets written.
  uniq: {
    shortWithArg: 'fsw',
    longWithArg: ['--skip-fields', '--skip-chars', '--check-chars'],
    operandsWrite: (operands) => operands.length > 1,
  },
};

const GIT_WRITING_OPTIONS: WritingOptionSpec = {
  shortWriting: 'cCdDfmMo',
  // Attached-argument options (`-n5`, `-Sfoo`, `-uno`): the rest of the cluster is data, not flags.
  shortWithArg: 'USGLOnlB',
  shortOptionalArg: 'u',
  longWriting: [
    '--copy',
    '--delete',
    '--edit-description',
    '--exec-path',
    '--move',
    '--output',
    // Opt-in: runs the program named by diff.external / GIT_EXTERNAL_DIFF.
    '--ext-diff',
    // `git branch` rewrites config without naming a branch operand.
    '--set-upstream-to',
    '--set-upstream',
    '--unset-upstream',
  ],
};

const STRACE_WRITING_OPTIONS: WritingOptionSpec = {
  shortWriting: 'o',
  shortWithArg: 'abeEIoOpPsSuUX',
  longWriting: ['--output', '--kill-on-exit'],
};

function firstNonOption(tokens: readonly string[], start = 1): string | undefined {
  for (let i = start; i < tokens.length; i += 1) {
    if (tokens[i] === '--') return tokens[i + 1];
    if (!tokens[i]!.startsWith('-')) return tokens[i];
  }
  return undefined;
}

function classifiesSystemctlRead(tokens: readonly string[]): boolean {
  if (tokens.some((token) => token.toLowerCase() === '--version')) return true;
  const subcommand = firstNonOption(tokens);
  return subcommand !== undefined && READ_ONLY_SYSTEMCTL_COMMANDS.has(subcommand.toLowerCase());
}

function classifiesIpRead(tokens: readonly string[]): boolean {
  const subcommand = firstNonOption(tokens)?.toLowerCase();
  if (!subcommand || !READ_ONLY_IP_COMMANDS.has(subcommand)) return false;
  return !tokens.slice(1).some((token) => SHELL_MUTATION_WORDS.has(token.toLowerCase()));
}

function classifiesGitRead(tokens: readonly string[]): boolean {
  if (hasWritingOption(tokens, GIT_WRITING_OPTIONS)) return false;
  const subcommand = firstNonOption(tokens)?.toLowerCase();
  if (!subcommand) return false;
  if (subcommand === 'branch') {
    return !tokens.slice(2).some((token) => !token.startsWith('-'));
  }
  if (subcommand === 'remote') {
    const nested = firstNonOption(tokens, 2)?.toLowerCase();
    return nested === undefined || nested === 'get-url' || nested === 'get-branches' || nested === 'show';
  }
  return new Set([
    'branch',
    'cat-file',
    'describe',
    'diff',
    'log',
    'ls-files',
    'ls-tree',
    'rev-parse',
    'show',
    'shortlog',
    'status',
  ]).has(subcommand);
}

function classifiesStraceRead(tokens: readonly string[]): boolean {
  if (
    hasWritingOption(tokens, STRACE_WRITING_OPTIONS) ||
    tokens.some((token) => /(?:inject|fault|signal|syscall|daemon|detach-on|kill)/i.test(token))
  ) {
    return false;
  }
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if ((token === '-p' || token === '--attach' || token === '--attach-pid') && /^\d+$/.test(tokens[i + 1] ?? '')) {
      return true;
    }
    if (/^-p\d+$/.test(token) || /^--attach(?:-pid)?=\d+$/.test(token)) return true;
  }
  return false;
}

function classifiesFindRead(tokens: readonly string[]): boolean {
  return !tokens.slice(1).some((token) => {
    const action = token.toLowerCase().split('=', 1)[0];
    return FIND_MUTATING_ACTIONS.has(action);
  });
}

function hasNumericPpidSelector(tokens: readonly string[]): boolean {
  let selectorCount = 0;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === '--ppid') {
      selectorCount += 1;
      if (!/^\d+$/.test(tokens[index + 1] ?? '')) return false;
      index += 1;
      continue;
    }
    if (/^--ppid=\d+$/.test(token)) selectorCount += 1;
  }
  return selectorCount === 1;
}

// Exported (EI-23749240882032210) so activity attribution reuses the SAME per-command
// read-only decision instead of forking a second allowlist. Behaviour is unchanged.
export function classifiesReadOnlyAwk(tokens: readonly string[]): boolean {
  if (commandBase(tokens[0] ?? '') !== 'awk' || tokens.length !== 2) return false;
  const program = tokens[1]!;
  // Only permit field-selection/printing programs. In particular, do not widen
  // the general shell classifier to arbitrary awk, whose system/getline/output
  // features can execute commands or mutate files.
  const field = String.raw`(?:\$\d+|[A-Za-z_][A-Za-z0-9_]*)`;
  const print = new RegExp(String.raw`^\{\s*print(?:\s+${field}(?:\s*,\s*${field})*)?\s*\}$`);
  const conditionalPrint = new RegExp(
    String.raw`^${field}\s*\{\s*print(?:\s+${field}(?:\s*,\s*${field})*)?\s*\}$`,
  );
  return print.test(program) || conditionalPrint.test(program);
}

function isReadOnlyPsPpidPipelineSegments(segments: readonly (readonly string[])[]): boolean {
  if (segments.length < 1 || segments.length > 2) return false;
  const ps = segments[0]!;
  if (commandBase(ps[0] ?? '') !== 'ps' || !hasNumericPpidSelector(ps)) return false;
  return segments.length === 1 || classifiesReadOnlyAwk(segments[1]!);
}

function classifiesPsRead(tokens: readonly string[]): boolean {
  const hasPpid = tokens.some((token) => token === '--ppid' || token.startsWith('--ppid='));
  return !hasPpid || hasNumericPpidSelector(tokens);
}

function isReadOnlyHeadPipelineSegments(segments: readonly (readonly string[])[]): boolean {
  if (segments.length < 2 || commandBase(segments.at(-1)?.[0] ?? '') !== 'head') return false;
  return segments.every((segment) => {
    return classifiesSimpleRead(segment) || classifiesReadOnlyAwk(segment);
  });
}

/**
 * A numeric-parent `ps --ppid` probe is an observation even when no children
 * exist. `ps` reports that empty enumeration with exit 1; an optional simple
 * field-printing `awk` consumer keeps the result observational. Keep this
 * separate from the broad `ps` allow-list so variable parents, shell operators,
 * redirects, and arbitrary awk programs remain write-classified.
 */
export function isReadOnlyPsPpidPipeline(command: string): boolean {
  if (/[;&<>\n\r]/.test(command) || command.includes('||')) return false;
  const segments = splitClassifiableShell(command);
  return segments !== null && isReadOnlyPsPpidPipelineSegments(segments);
}

const SED_ADDRESS = String.raw`(?:\d+|\$|\/(?:\\.|[^/\\])*\/)`;
// `200,235p`, `1p`, `$p`, `/re/p`, `/a/,/b/d`, `5q`, `=` — print/delete/quit only. No
// `w`/`W`/`e`/`r`/`R`, which are the commands that write a file or run one.
const SED_SELECT_SCRIPT = new RegExp(String.raw`^\s*(?:${SED_ADDRESS}(?:\s*,\s*${SED_ADDRESS})?)?\s*!?\s*[pPdq=]\s*$`);
// `s/a/b/` with only the harmless flags. `w` (write file) and `e` (execute) are NOT in the set.
const SED_SUBSTITUTE_SCRIPT = /^\s*s(.)(?:\\.|(?!\1).)*?\1(?:\\.|(?!\1).)*?\1[gGpiImM0-9]*\s*$/;

function isSafeSedScript(script: string): boolean {
  if (SED_SELECT_SCRIPT.test(script) || SED_SUBSTITUTE_SCRIPT.test(script)) return true;
  // `1,5p;10q` — a chain of select commands. A `;` inside an address regex never reaches this
  // branch (the whole-script test above already accepted it), and a part that is not itself a
  // select command (`w x`, `s/a/b/`, `N`) rejects the whole chain.
  return script
    .replace(/;\s*$/, '')
    .split(';')
    .every((part) => SED_SELECT_SCRIPT.test(part));
}

// Exact long options that cannot write. GNU getopt_long also accepts any UNIQUE ABBREVIATION
// (`--in-p`, `--in`, `--fi`), so an unlisted `--…` token is unknown and must read as a write, never
// as "an option I do not recognise, so ignore it".
const SED_SAFE_LONG_FLAGS: ReadonlySet<string> = new Set([
  '--binary',
  '--debug',
  '--null-data',
  '--posix',
  '--quiet',
  '--regexp-extended',
  '--sandbox',
  '--separate',
  '--silent',
  '--text',
  '--unbuffered',
  '--zero-terminated',
]);
const SED_SAFE_SHORT_FLAGS: ReadonlySet<string> = new Set(['E', 'b', 'n', 'r', 's', 'u', 'z']);

/**
 * True only when `sed` provably cannot write a file or run a command: every script is a
 * print/delete/quit select or a flag-restricted substitution, and every option is a known
 * non-writing one. `-i`/`--in-place` (and its clusters and abbreviations), `-f`/`--file` (a
 * script file may hold `w`), and an in-script `w`/`e` all fail. ALLOWLIST posture — an option or
 * script this parser does not recognise is a write, because the callers are replay and dry-run
 * safety ("a false positive could replay a mutation").
 *
 * Short options are walked character by character the way getopt does: `e` and `l` take the REST
 * of the cluster as their argument when anything follows (`-ew/tmp/x` carries the script
 * `w/tmp/x`; the next token is then a FILE, not the script) and only otherwise the next token.
 *
 * Dependency-free on purpose: this module is shared with the always-up MCP proxy.
 */
export function sedIsObservational(tokens: readonly string[]): boolean {
  const scripts: string[] = [];
  const positional: string[] = [];
  let scriptFlag = false;
  let optionsEnded = false;
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (optionsEnded || !token.startsWith('-') || token === '-') {
      positional.push(token);
      continue;
    }
    if (token === '--') {
      optionsEnded = true;
      continue;
    }
    if (token.startsWith('--')) {
      if (token === '--expression') {
        scriptFlag = true;
        const next = tokens[i + 1];
        if (next === undefined) return false;
        scripts.push(next);
        i += 1;
      } else if (token.startsWith('--expression=')) {
        scriptFlag = true;
        scripts.push(token.slice('--expression='.length));
      } else if (!SED_SAFE_LONG_FLAGS.has(token) && !/^--line-length=\d+$/.test(token)) {
        return false;
      }
      continue;
    }
    const cluster = token.slice(1);
    for (let c = 0; c < cluster.length; c += 1) {
      const flag = cluster[c]!;
      const attached = cluster.slice(c + 1);
      if (flag === 'e') {
        scriptFlag = true;
        if (attached) {
          scripts.push(attached);
        } else {
          const next = tokens[i + 1];
          if (next === undefined) return false;
          scripts.push(next);
          i += 1;
        }
        break;
      }
      if (flag === 'l') {
        const length = attached || tokens[i + 1] || '';
        if (!/^\d+$/.test(length)) return false;
        if (!attached) i += 1;
        break;
      }
      if (!SED_SAFE_SHORT_FLAGS.has(flag)) return false;
    }
  }
  if (!scriptFlag) {
    const script = positional.shift();
    if (script === undefined) return false;
    scripts.push(script);
  }
  return scripts.length > 0 && scripts.every(isSafeSedScript);
}

export function classifiesSimpleRead(tokens: readonly string[], depth = 0): boolean {
  if (depth > 2 || tokens.length === 0) return false;
  const base = commandBase(tokens[0]!);
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!)) return false;

  if (base === 'timeout') {
    let durationIndex = 1;
    while (durationIndex < tokens.length && tokens[durationIndex]!.startsWith('-')) {
      durationIndex += tokens[durationIndex] === '-k' ? 2 : 1;
    }
    if (durationIndex >= tokens.length || !/^\d+(?:\.\d+)?[smhd]?$/.test(tokens[durationIndex]!)) {
      return false;
    }
    return classifiesSimpleRead(tokens.slice(durationIndex + 1), depth + 1);
  }
  if (base === 'systemctl') return classifiesSystemctlRead(tokens);
  if (base === 'ip') return classifiesIpRead(tokens);
  if (base === 'git') return classifiesGitRead(tokens);
  if (base === 'strace') return classifiesStraceRead(tokens);
  if (base === 'find') return classifiesFindRead(tokens);
  if (base === 'ps' && !classifiesPsRead(tokens)) return false;
  if (base === 'command') return tokens.length === 3 && (tokens[1] === '-v' || tokens[1] === '-V');
  if (base === 'docker') {
    return new Set(['info', 'inspect', 'ps', 'stats', 'version']).has(firstNonOption(tokens)?.toLowerCase() ?? '');
  }
  if (!READ_ONLY_COMMANDS.has(base)) return false;
  if (base === 'sed') return sedIsObservational(tokens);
  const writing = WRITING_OPTIONS[base];
  return writing === undefined || !hasWritingOption(tokens, writing);
}

/**
 * Resolve capability:bash's effect for one call. The tool's capability remains a
 * write-capability, but a shell is a read only when every command segment is a
 * recognized observation and the shell has no hidden execution or redirection.
 * Unknown syntax intentionally falls back to write for dry-run and replay safety.
 */
export function classifyCapabilityBashEffect(args: unknown): BashEffect {
  if (!args || typeof args !== 'object') return 'write';
  const record = args as { command?: unknown; cmd?: unknown };
  const command = typeof record.command === 'string' ? record.command : record.cmd;
  if (typeof command !== 'string') return 'write';
  const segments = splitClassifiableShell(command);
  if (!segments) return 'write';
  const allReadOnly = segments.every((segment) => classifiesSimpleRead(segment));
  return allReadOnly || isReadOnlyHeadPipelineSegments(segments) || isReadOnlyPsPpidPipelineSegments(segments)
    ? 'read'
    : 'write';
}

/**
 * A bounded read-only pipeline ending in `head` may intentionally close its
 * input before a producer finishes. With the wrapper's mandatory pipefail,
 * that producer reports SIGPIPE (141) even though the requested bounded read
 * completed. Keep this predicate deliberately narrow: shell operators,
 * redirects, unknown commands, and non-`head` consumers must retain the real
 * failure status.
 */
export function isReadOnlyHeadPipeline(command: string): boolean {
  if (/[;&<>\n\r]/.test(command)) return false;
  const segments = splitClassifiableShell(command);
  if (!segments || segments.length < 2) return false;
  return isReadOnlyHeadPipelineSegments(segments);
}

/**
 * A read-only ripgrep count pipeline has a meaningful zero result when rg finds
 * no matches. With pipefail enabled, rg's conventional exit code 1 otherwise
 * makes the whole pipeline look failed even though the downstream wc consumed
 * the valid zero-count stream. Keep this predicate narrow: a bare rg no-match,
 * a pipeline without a count consumer, or any shell syntax outside the small
 * classifier remains a real failure.
 */
export function isReadOnlyRgCountPipeline(command: string): boolean {
  if (/[;&<>\n\r]/.test(command) || command.includes('||')) return false;
  const segments = splitClassifiableShell(command);
  if (!segments || segments.length < 2) return false;

  const final = segments.at(-1);
  if (
    !final ||
    commandBase(final[0] ?? '') !== 'wc' ||
    final.length !== 2 ||
    !['-l', '--lines'].includes(final[1] ?? '')
  ) {
    return false;
  }

  const rgIndexes = segments
    .map((segment, index) => (commandBase(segment[0] ?? '') === 'rg' ? index : -1))
    .filter((index) => index >= 0);
  if (rgIndexes.length === 0) return false;

  const hasDownstreamCount = rgIndexes.some((rgIndex) =>
    segments.slice(rgIndex + 1).some((segment) => commandBase(segment[0] ?? '') === 'wc'),
  );
  return hasDownstreamCount && classifyCapabilityBashEffect({ command }) === 'read';
}
