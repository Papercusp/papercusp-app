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

function hasOption(tokens: readonly string[], options: readonly string[]): boolean {
  return tokens.some((token) => options.some((option) => token === option || token.startsWith(`${option}=`)));
}

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
  const dangerousFlags = [
    '-c',
    '-C',
    '-d',
    '-D',
    '-f',
    '-m',
    '-M',
    '--copy',
    '--delete',
    '--edit-description',
    '--exec-path',
    '--move',
  ];
  if (hasOption(tokens, dangerousFlags) || hasOption(tokens, ['-o', '--output'])) return false;
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
    hasOption(tokens, ['-o', '--output', '--kill-on-exit']) ||
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

function classifiesReadOnlyAwk(tokens: readonly string[]): boolean {
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

function classifiesSimpleRead(tokens: readonly string[], depth = 0): boolean {
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
  if (base === 'dmesg' && hasOption(tokens, ['--clear', '-C'])) return false;
  if (base === 'date' && hasOption(tokens, ['-s', '--set'])) return false;
  if (base === 'fuser' && hasOption(tokens, ['-k', '--kill'])) return false;
  if (base === 'journalctl' && tokens.some((token) => /^--(?:flush|relinquish-var|rotate|sync|vacuum)/.test(token))) {
    return false;
  }
  if (base === 'rg' && hasOption(tokens, ['--pre'])) return false;
  if (base === 'sed' && hasOption(tokens, ['-i', '--in-place'])) return false;
  if (base === 'ss' && hasOption(tokens, ['-K', '--kill'])) return false;
  if (base === 'sort' && hasOption(tokens, ['-o', '--output'])) return false;
  return true;
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
