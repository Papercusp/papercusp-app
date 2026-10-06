/**
 * Run several READ-ONLY git commands from ONE small `sh` — one host fork instead of N.
 *
 * EI-24852529885337741 (measured 2026-10-02 07:41Z): on a 1.7–2.2 GB Node host each
 * child_process spawn costs ~160 ms of SYNCHRONOUS main-thread time (the fork copies the
 * page tables of the whole image before exec). A 10-minute execve census of the request
 * hosts (08:01–08:11Z) counted 918 host forks; ~320 of them were devDeployState's eight
 * one-shot gits per snapshot, which run locally on purpose (the spawner-sidecar hop can
 * wedge a diagnostic read — EI-21307371780991377). Batching keeps the reads local and
 * sidecar-free while cutting the host forks: the shell forks each git from its own ~2 MB
 * image, and the host forks once.
 *
 * Framing: after each command the helper prints `\0<nonce> <tag> <exit>\0`. The nonce is
 * 128 random bits, so no path, ref or subject can forge a frame. Values are passed as
 * positional parameters and referenced as `"${N}"`; they NEVER enter the script text, so
 * a ref like `$(rm -rf ~)` is an argument to git, not shell.
 *
 * First used by release-cut-reclaim (EI-24849983022443070: 1,921 -> 49 host forks on the
 * same plan); lifted here so every caller shares ONE fork gate.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { pinModuleState } from '@papercusp/module-singleton';

// Lazy + memoized, NOT promisified at module scope (EI-10161): under a narrow
// `vi.mock('node:child_process')` `execFile` is undefined, and an eager `promisify` throws at
// IMPORT time — crashing every test file that reaches this module, even one that never calls it.
let execFileAsyncMemo: typeof execFile.__promisify__ | null = null;
const execFileAsync = ((...args: unknown[]) =>
  Reflect.apply((execFileAsyncMemo ??= promisify(execFile)), undefined, args)) as typeof execFile.__promisify__;

/** Shell function that writes one frame: `f <tag> <exit>` (uses `$n`, the nonce). */
export const HELPER_FRAME_FN = "f() { printf '\\000%s %s %d\\000' \"$n\" \"$1\" \"$2\"; }";

export interface HelperSection {
  tag: string;
  exit: number;
  out: string;
}

/** Split a helper's stdout into its framed sections, in emission order. Bytes after the
 * last frame (a helper killed mid-command) belong to no section and are dropped. */
export function parseHelperFrames(stdout: string, nonce: string): HelperSection[] {
  if (!/^[0-9a-f]{16,}$/.test(nonce)) throw new Error('helper nonce must be hex');
  const sections: HelperSection[] = [];
  let start = 0;
  // \x00, never \0: followed by the nonce's leading digit, \0 is a legacy octal escape (\01).
  for (const m of stdout.matchAll(new RegExp(`\\x00${nonce} (\\S+) (\\d+)\\x00`, 'g'))) {
    sections.push({ tag: m[1]!, exit: Number(m[2]), out: stdout.slice(start, m.index) });
    start = m.index! + m[0].length;
  }
  return sections;
}

const forkGateState = pinModuleState('@papercusp/operator-core.git-batch.fork-gate', () => ({
  gate: Promise.resolve() as Promise<void>,
}));

/**
 * One host fork per event-loop turn. Concurrent callers otherwise fork back-to-back in a
 * single tick: 4 x ~160ms at 2GB RSS held the loop 565ms (measured 07:53Z). Each slot opens
 * one setImmediate after the previous one, and an immediate queued while the check phase
 * runs waits for the NEXT turn, so timers and I/O run between consecutive forks.
 */
export function nextForkSlot(): Promise<void> {
  const slot = forkGateState.gate.then(() => new Promise<void>((resolve) => setImmediate(resolve)));
  forkGateState.gate = slot;
  return slot;
}

export interface GitBatchCommand {
  /** `git -C <repo>` */
  repo: string;
  args: readonly string[];
}

export interface GitBatchResult {
  /** git's exit status */
  code: number;
  stdout: string;
  /** this command's own stderr (trailing newlines stripped) */
  stderr: string;
}

/**
 * The helper script and its positional argv for `cmds`. `$1` is the nonce; each command's
 * repo and args follow in order and are referenced only by index. Each command's stdout
 * goes straight to the helper's stdout (fd 3); its stderr is captured and emitted as a
 * separate `e<i>` section so failures stay attributable per command.
 */
export function buildGitBatchScript(cmds: readonly GitBatchCommand[]): { script: string; argv: string[] } {
  const lines = ['n=$1', HELPER_FRAME_FN, 'exec 3>&1'];
  const argv: string[] = [];
  let pos = 2;
  cmds.forEach((cmd, i) => {
    const refs: string[] = [];
    for (const value of [cmd.repo, ...cmd.args]) {
      argv.push(value);
      refs.push(`"\${${pos}}"`);
      pos += 1;
    }
    lines.push(`e=$( { git -C ${refs.join(' ')} >&3; } 2>&1 ); r=$?; f o${i} $r; printf %s "$e"; f e${i} 0`);
  });
  return { script: lines.join('\n'), argv };
}

export interface GitBatchOptions {
  /** Whole-helper wall-clock cap. On expiry the completed commands still return. */
  timeoutMs?: number;
  maxBuffer?: number;
  /** `$0` of the helper — shows up in `ps` and audit logs. */
  label?: string;
}

export interface GitBatchInvocation {
  /** `$0` for `sh -c`, visible in `ps` and audit logs. */
  label: string;
  /** Random nonce used to distinguish helper frames from command output. */
  nonce: string;
  /** argv passed to `sh`, after the executable name. */
  args: string[];
}

/** Build the exact `sh -c` invocation used by both local and sidecar batches. */
export function buildGitBatchInvocation(
  cmds: readonly GitBatchCommand[],
  label = 'git-batch',
): GitBatchInvocation {
  const nonce = randomBytes(16).toString('hex');
  const { script, argv } = buildGitBatchScript(cmds);
  return { label, nonce, args: ['-c', script, label, nonce, ...argv] };
}

/**
 * Strict recognizer for the only `sh` batch that may defer sidecar admission.
 * The recognizer intentionally covers the dev-deploy-state command shapes only:
 * `git log -1 --format=%H%n%ct%n%s <ref>^{commit}` and
 * `git rev-list --count <from>..<to>`. Merely looking like a generated helper is
 * not enough; each command must also be one of those read-only forms.
 */
export function isReadOnlyGitBatchExec(params: {
  command: string;
  args?: readonly string[];
}): boolean {
  if (params.command !== 'sh') return false;
  const args = params.args ?? [];
  if (
    args[0] !== '-c' ||
    args[2] !== 'dev-deploy-state' ||
    !/^[0-9a-f]{32}$/.test(args[3] ?? '') ||
    args.length < 6
  ) return false;

  const script = args[1] ?? '';
  const lines = script.split('\n');
  if (
    lines.length < 4 ||
    lines[0] !== 'n=$1' ||
    lines[1] !== HELPER_FRAME_FN ||
    lines[2] !== 'exec 3>&1'
  ) return false;

  const commands: GitBatchCommand[] = [];
  let nextParameter = 2;
  for (let index = 0; index < lines.length - 3; index += 1) {
    const match = /^e=\$\( \{ git -C (.+) >&3; \} 2>&1 \); r=\$\?; f o(\d+) \$r; printf %s "\$e"; f e(\d+) 0$/.exec(lines[index + 3]!);
    if (!match || match[2] !== String(index) || match[3] !== String(index)) return false;
    const refsText = match[1]!;
    const refs = [...refsText.matchAll(/"\$\{(\d+)\}"/g)].map((ref) => Number(ref[1]));
    if (
      refs.length < 2 ||
      refsText !== refs.map((ref) => '"${' + ref + '}"').join(' ') ||
      refs.some((ref, offset) => ref !== nextParameter + offset)
    ) return false;
    const values = refs.map((ref) => args[ref + 2]);
    if (values.some((value) => typeof value !== 'string')) return false;
    const [repo, ...gitArgs] = values as string[];
    const safeShape =
      (gitArgs.length === 4 &&
        gitArgs[0] === 'log' &&
        gitArgs[1] === '-1' &&
        gitArgs[2] === '--format=%H%n%ct%n%s' &&
        gitArgs[3] !== '' &&
        !gitArgs[3]!.startsWith('-')) ||
      (gitArgs.length === 3 &&
        gitArgs[0] === 'rev-list' &&
        gitArgs[1] === '--count' &&
        gitArgs[2] !== '' &&
        !gitArgs[2]!.startsWith('-'));
    if (!safeShape) return false;
    commands.push({ repo: repo!, args: gitArgs });
    nextParameter += refs.length;
  }

  if (commands.length === 0 || args.length !== nextParameter + 2) return false;
  const rebuilt = buildGitBatchScript(commands);
  return rebuilt.script === script && rebuilt.argv.every((value, index) => value === args[index + 4]);
}

/** Parse the framed helper stdout; null marks a command with no complete frame. */
export function parseGitBatchResults(
  cmds: readonly GitBatchCommand[],
  stdout: string,
  nonce: string,
): Array<GitBatchResult | null> {
  const byTag = new Map(parseHelperFrames(stdout, nonce).map((section) => [section.tag, section]));
  return cmds.map((_, index) => {
    const out = byTag.get(`o${index}`);
    if (!out) return null;
    return { code: out.exit, stdout: out.out, stderr: byTag.get(`e${index}`)?.out ?? '' };
  });
}

/**
 * Run `cmds` in one `sh`. Returns one entry per command, in order; `null` means the
 * command never completed (helper killed, timed out, or failed to start) — treat it as
 * a failed read, never as an empty one.
 */
export async function runGitBatch(
  cmds: readonly GitBatchCommand[],
  opts: GitBatchOptions = {},
): Promise<Array<GitBatchResult | null>> {
  if (cmds.length === 0) return [];
  await nextForkSlot();
  const { nonce, args } = buildGitBatchInvocation(cmds, opts.label ?? 'git-batch');
  let stdout = '';
  try {
    const out = await execFileAsync('sh', args, {
      encoding: 'utf8',
      maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024,
      timeout: opts.timeoutMs ?? 30_000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    stdout = String(out.stdout);
  } catch (error) {
    // Timeout / maxBuffer / signal: keep whatever commands finished before it.
    stdout = String((error as { stdout?: unknown }).stdout ?? '');
  }
  return parseGitBatchResults(cmds, stdout, nonce);
}
