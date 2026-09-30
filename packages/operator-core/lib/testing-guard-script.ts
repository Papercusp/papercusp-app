/**
 * testing-guard-script.ts — run a repo guard/lint script from a test so that a RED
 * carries the script's own report. EI-20692923474318761.
 *
 * ── THE DEFECT THIS EXISTS TO PREVENT ───────────────────────────────────────
 * A ratchet guard test execs its script over the real tree and asserts the tree is
 * clean. Written with `execFileSync`, that is one line and looks complete — but
 * `execFileSync` THROWS on a non-zero exit, and its Error carries the output only as an
 * unrendered `.stdout` PROPERTY: the `message`, which is the one string a test runner
 * shows, names just the command. Our guard scripts print their findings to stdout and
 * only THEN set `process.exitCode`, so on a red the report exists and is even attached
 * to the thrown error — yet nothing surfaces it unless every caller remembers to catch
 * and re-render it. None did. What vitest reports instead is:
 *
 *     Command failed: node scripts/check-undrained-stdout-exit.mjs --json
 *
 * Measured cost of that one line (EI-20692923474318761): the undrained-stdout guard
 * went red 8× over 6h across 4 commits, every red carrying that identical tail. The
 * offender — one file, one line — was recoverable only by hand-running the script,
 * which three separate agent wakes each did from scratch. The red was legitimate and
 * the fix was small; the diagnosis was the whole cost.
 *
 * It is worse than a plain missing message, because the tree here is SHARED and swept:
 * any peer landing an offending script reds the guard for every other agent and for
 * the green-checkpoint gate. The report has to survive the failure, or each occurrence
 * re-buys the same investigation.
 *
 * ── WHY spawnSync, AND WHAT `status: null` MEANS ─────────────────────────────
 * `spawnSync` does not throw on a non-zero exit, so the caller can read the report and
 * the status together and assert on whichever is more informative. But it reports three
 * DIFFERENT failures and two of them leave `status === null`: a spawn error (ENOENT — a
 * missing interpreter), and death by signal (which is how `timeout` surfaces). A caller
 * comparing only `status` therefore sees `null` with nothing to explain it — the same
 * "an absence reads exactly like data" shape the guards themselves exist to catch. So
 * every one of those is folded into `output` as an explicit ⚠ note, and `status` stays
 * nullable rather than being coerced to a number that would read as a real exit code.
 *
 * Usage — pass `output` as expect()'s message so the report lands in the failure:
 *
 *     const guard = runGuardScript('node', ['scripts/check-thing.mjs'], { cwd: REPO_ROOT });
 *     expect(guard.status, guard.output).toBe(0);
 */
import { spawnSync } from 'node:child_process';

/** Default budget for a whole-tree guard run — these walk ~14k files. */
const DEFAULT_TIMEOUT_MS = 180_000;
/** A guard's `--json` report over the whole tree can be megabytes; truncation would parse as fewer findings. */
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

export interface GuardScriptRun {
  /** Exit status, or `null` when the process died by signal or never spawned — see `output` for which. */
  status: number | null;
  stdout: string;
  stderr: string;
  /**
   * The invocation, any spawn/signal note, and both streams — pass THIS as expect()'s
   * second argument so a red names the offender instead of naming the command.
   */
  output: string;
}

export interface GuardScriptOptions {
  cwd: string;
  timeoutMs?: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
}

export function runGuardScript(
  cmd: string,
  args: readonly string[],
  opts: GuardScriptOptions,
): GuardScriptRun {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const res = spawnSync(cmd, [...args], {
    cwd: opts.cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
    ...(opts.env ? { env: opts.env } : {}),
  });

  const stdout = res.stdout ?? '';
  const stderr = res.stderr ?? '';

  // Each of these leaves `status` unusable, so say so in words rather than letting the
  // caller infer a verdict from a null.
  const notes: string[] = [];
  if (res.error) notes.push(`⚠ spawn failed: ${(res.error as Error).message}`);
  if (res.signal) notes.push(`⚠ killed by signal ${res.signal} (timeout budget was ${timeoutMs}ms)`);
  if (res.status === null && !res.error && !res.signal) {
    notes.push('⚠ exited with neither a status nor a signal');
  }

  const output = [`$ ${[cmd, ...args].join(' ')}`, ...notes, stdout.trim(), stderr.trim()]
    .filter((part) => part !== '')
    .join('\n');

  return { status: res.status, stdout, stderr, output };
}
