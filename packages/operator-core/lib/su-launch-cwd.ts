/**
 * su-launch-cwd.ts — resolve the working directory a psu superuser session
 * launches in, guarding the prompt-isolation leak EI-202.
 *
 * A no-harness `psu` launch prefers the launcher's OWN cwd (`process.cwd()`, the
 * user's terminal) so the agent's cwd-scoped resume works from where the user is.
 * But Claude Code auto-loads PROJECT-level memory from the cwd — `<cwd>/CLAUDE.md`
 * and `<cwd>/.claude/CLAUDE.md`. When the launcher's cwd is the user's `$HOME`,
 * those "project files" ARE the owner's personal config (`~/CLAUDE.md` +
 * `~/.claude/CLAUDE.md` → the personal memory rules), re-importing exactly what
 * the per-session `CLAUDE_CONFIG_DIR` skip-links out of GLOBAL memory (P-002).
 * The config-dir isolation can't catch this because cwd project-memory is a
 * separate discovery path it doesn't govern.
 *
 * So: a psu session must never run in `$HOME`. The internal workspace root
 * (`envelopeCwd` — `papercuspPathForWorkspace`, always under `~/.papercusp/…`,
 * never `$HOME`) carries no personal memory, so a `$HOME` cwd is relocated there.
 * A cwd one or more levels below `$HOME` (the repo, a project dir, the internal
 * dir) is left untouched — only the exact-`$HOME` case hits the personal
 * `CLAUDE.md` / `.claude/CLAUDE.md` as cwd-level project files.
 *
 * Pure + dependency-free so the deterministic psu prompt-isolation guard
 * (P-005) can assert it without booting the route.
 */
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

/** How the caller's cwd is weighed against the harness repo.
 *  - `harness` (default): a harness launch runs in the harness repo; psu sends
 *    its own cwd on every launch, so this keeps `psu --harness X` from anywhere
 *    running in X's checkout.
 *  - `caller`: run where the user launched from, even for a harness launch —
 *    the Claude Code / Codex contract PUI's chat-first default adopts
 *    (pui-chat-first-ux-2026-09-28 P-001). Only honoured for an absolute path
 *    that is an existing directory on THIS host and is not `$HOME`; anything
 *    else (a remote operator that cannot see the client's filesystem, a
 *    relative path, `$HOME`) falls back to the `harness` rule. */
export type SuLaunchCwdPolicy = 'harness' | 'caller';

function defaultIsDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

export function resolveSuLaunchCwd(opts: {
  /** The chosen harness slug, or null for a no-harness (workspace-root) launch. */
  harnessSlug: string | null;
  /** The launcher's own `process.cwd()` (no-harness launches prefer it). */
  callerCwd: string | null;
  /** The internal workspace-root cwd from the console envelope — never `$HOME`. */
  envelopeCwd: string;
  /** Defaults to `harness`; see {@link SuLaunchCwdPolicy}. */
  policy?: SuLaunchCwdPolicy | null;
  /** Source HOME (testability); defaults to the process home. */
  home?: string;
  /** Directory probe (testability); defaults to a real `stat`. */
  isDirectory?: (path: string) => boolean;
}): string {
  const home = opts.home ?? homedir();
  // EI-202: at $HOME the cwd-level CLAUDE.md / .claude/CLAUDE.md ARE the owner's
  // personal config — never run there, under either policy.
  const atHome = (path: string) => resolve(path) === resolve(home);
  if (opts.policy === 'caller' && opts.callerCwd && isAbsolute(opts.callerCwd)) {
    const caller = resolve(opts.callerCwd);
    if (!atHome(caller) && (opts.isDirectory ?? defaultIsDirectory)(caller)) return caller;
  }
  // A harness launch always runs in the harness repo (envelope.cwd), never the
  // caller's terminal — so it can't be $HOME and needs no guard.
  if (opts.harnessSlug) return opts.envelopeCwd;
  const preferred = opts.callerCwd || opts.envelopeCwd;
  // Relocate a $HOME cwd to the internal workspace root, which has neither file.
  return atHome(preferred) ? opts.envelopeCwd : preferred;
}
