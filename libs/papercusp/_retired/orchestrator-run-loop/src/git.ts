/**
 * Thin wrapper around `git` subprocess invocation. Captures stdout +
 * stderr; returns exit code + first few lines of output (matching bash's
 * `git ... 2>&1 | head -3` pattern used throughout run.sh).
 *
 * Kept narrow on purpose — we don't try to model the full git API. Just
 * "spawn git with these args at this cwd, return what happened."
 */
import { spawnSync } from 'node:child_process';

export interface GitResult {
  exitCode: number;
  /** stdout + stderr combined, trimmed. */
  output: string;
  /** First N lines of output (bash uses `head -3` everywhere). */
  outputHead(n: number): string;
}

export interface GitOptions {
  /** Working directory for the command. */
  cwd: string;
  /** Override env (PATH inheritance is automatic). */
  env?: NodeJS.ProcessEnv;
}

/** Run `git <args>` synchronously. Never throws — caller checks exitCode. */
export function git(args: readonly string[], opts: GitOptions): GitResult {
  const result = spawnSync('git', args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = result.stdout?.toString() ?? '';
  const stderr = result.stderr?.toString() ?? '';
  const merged = (stdout + stderr).trim();
  const exitCode = result.status ?? 1;
  return {
    exitCode,
    output: merged,
    outputHead: (n: number) =>
      merged.split(/\r?\n/).slice(0, n).filter((l) => l.length > 0).join('\n'),
  };
}

/** Whether `git show-ref --quiet refs/heads/<name>` succeeds. */
export function branchExists(branchName: string, opts: GitOptions): boolean {
  return git(['show-ref', '--quiet', `refs/heads/${branchName}`], opts).exitCode === 0;
}

/** Whether the index has any staged changes (true = there are changes). */
export function hasStagedChanges(opts: GitOptions): boolean {
  return git(['diff', '--cached', '--quiet'], opts).exitCode !== 0;
}
