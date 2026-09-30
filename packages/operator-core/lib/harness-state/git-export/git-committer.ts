/**
 * Git-export committer (plan harness-state-storage-unification-2026-06-01, P-003b residue A).
 *
 * The drain loop writes the `sync:'git'` document tables to `.papercusp/state/<…>`
 * files (PG→file). For git to actually be the SYNC AUTHORITY those files must be
 * committed. This module is the real, debounced committer the boot wiring hands to
 * the drain loop's `onChanged` hook.
 *
 * Two deliberate safety properties (the "auto-commit policy" decision):
 *   1. SCOPED — only ever `git add -- .papercusp/state` + `git commit -- .papercusp/state`.
 *      NEVER `git add -A`/`git add .`: this is a SHARED working tree (papercup +
 *      paperclip + the agent fleet); a broad add would sweep peers' in-flight work
 *      into a git-export commit. The pathspec confines the commit to the export dir.
 *   2. NO PUSH — committing is local only (repo convention: agents don't push).
 *   3. FLAG-GATED — default OFF (`PAPERCUSP_GIT_EXPORT_COMMIT` !== '1'): the files
 *      are still written + visible in the working tree, but not committed, so
 *      enabling git-as-sync on the live shared tree is an explicit opt-in (commit
 *      spam every debounce window would fight the shared-commit workflow). Dogfood
 *      / single-engineer harnesses flip it on.
 *
 * `commitHarnessState` is the pure-ish, timer-free unit (inject `runGit` to test);
 * `makeDebouncedGitCommitter` is the thin debounce + coalesce wrapper for the loop.
 */
import { spawn } from 'node:child_process';
import { collectChildOutput } from '../../child-output.js';

export type RunGit = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Spawn `git <args>` in `cwd`, capturing exit code + output (never throws). */
const defaultRunGit: RunGit = (args, cwd) =>
  new Promise((resolve) => {
    const child = spawn('git', args, { cwd });
    const out = collectChildOutput(child);
    child.on('error', (e) =>
      resolve({ code: -1, stdout: out.stdout.text(), stderr: out.stderr.text() + String(e) }),
    );
    child.on('close', (code) =>
      resolve({ code: code ?? -1, stdout: out.stdout.text(), stderr: out.stderr.text() }),
    );
  });

/** The ONLY path this committer ever touches. */
export const GIT_EXPORT_STATE_DIR = '.papercusp/state';

/** Whether git-export auto-commit is enabled (env flag, default OFF). */
export function gitExportCommitEnabled(): boolean {
  return process.env.PAPERCUSP_GIT_EXPORT_COMMIT === '1';
}

export interface CommitHarnessStateOpts {
  harnessRoot: string;
  /** override the env flag (tests). */
  enabled?: boolean;
  /** inject the git runner (tests). */
  runGit?: RunGit;
  log?: (m: string) => void;
  /** commit message (a default scoped subject is used otherwise). */
  message?: string;
}

export type CommitResult =
  | { committed: true }
  | { committed: false; reason: 'disabled' | 'nothing-to-commit' | 'add-failed' | 'commit-failed' };

/**
 * Stage + commit ONLY `.papercusp/state` in `harnessRoot`. No push. When disabled,
 * a no-op that just logs (files remain written + visible). "nothing to commit" is
 * a normal, non-error outcome (the drain may have written an idempotent file).
 */
export async function commitHarnessState(opts: CommitHarnessStateOpts): Promise<CommitResult> {
  const { harnessRoot } = opts;
  const enabled = opts.enabled ?? gitExportCommitEnabled();
  const runGit = opts.runGit ?? defaultRunGit;
  const log = opts.log ?? ((m) => console.log(m));  

  if (!enabled) {
    log(
      `[git-export] commit disabled (set PAPERCUSP_GIT_EXPORT_COMMIT=1) — ${GIT_EXPORT_STATE_DIR} ` +
        `written under ${harnessRoot}, left uncommitted`,
    );
    return { committed: false, reason: 'disabled' };
  }

  const add = await runGit(['add', '--', GIT_EXPORT_STATE_DIR], harnessRoot);
  if (add.code !== 0) {
    log(`[git-export] git add failed (${harnessRoot}): ${add.stderr.trim() || add.stdout.trim()}`);
    return { committed: false, reason: 'add-failed' };
  }

  const message = opts.message ?? 'chore(git-export): sync .papercusp/state [skip ci]';
  const commit = await runGit(
    ['commit', '--no-verify', '-m', message, '--', GIT_EXPORT_STATE_DIR],
    harnessRoot,
  );
  if (commit.code === 0) return { committed: true };

  const out = `${commit.stdout}\n${commit.stderr}`.toLowerCase();
  if (out.includes('nothing to commit') || out.includes('no changes added') || out.includes('working tree clean')) {
    return { committed: false, reason: 'nothing-to-commit' };
  }
  log(`[git-export] git commit failed (${harnessRoot}): ${commit.stderr.trim() || commit.stdout.trim()}`);
  return { committed: false, reason: 'commit-failed' };
}

export interface DebouncedGitCommitterOpts {
  debounceMs?: number;
  enabled?: boolean;
  runGit?: RunGit;
  log?: (m: string) => void;
}

/**
 * Debounced `.papercusp/state` committer for the drain loop's `onChanged`. Coalesces
 * a burst of file changes into one commit (default 1500ms). Commits are serialized
 * + coalesced so passes never overlap (a change arriving mid-commit re-runs once).
 */
export function makeDebouncedGitCommitter(
  harnessRoot: string,
  opts: DebouncedGitCommitterOpts = {},
): (paths: string[]) => void {
  const debounceMs = opts.debounceMs ?? 1500;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const pending = new Set<string>();
  let running = false;
  let runAgain = false;

  async function flush(): Promise<void> {
    if (running) {
      runAgain = true;
      return;
    }
    running = true;
    try {
      do {
        runAgain = false;
        const n = pending.size;
        pending.clear();
        await commitHarnessState({
          harnessRoot,
          enabled: opts.enabled,
          runGit: opts.runGit,
          log: opts.log,
          message: `chore(git-export): sync ${n} file(s) in ${GIT_EXPORT_STATE_DIR} [skip ci]`,
        });
      } while (runAgain);
    } finally {
      running = false;
    }
  }

  return (paths: string[]) => {
    for (const p of paths) pending.add(p);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, debounceMs);
    if (timer && typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
  };
}
