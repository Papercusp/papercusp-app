/**
 * Git history reconstruction for (now-removed) plan files. The sole
 * remaining consumer is the one-shot `revisions-backfill` — plans are
 * PG-canonical (plans-pg-canonical-migration-2026-06-03) and the
 * `docs/plans/*.md` files were git-rm'd, but `git log --follow` + `git
 * show <hash>:<path>` still reconstruct each plan's full pre-removal
 * history, which the backfill replays into `plan_revisions`. (The old
 * `plans:history` / `plans:diff` tools and the `/api/admin/plans/git/:op`
 * route that also used this helper were deleted in that migration.)
 *
 * Security: slug is regex-validated (the canonical VALID_PLAN_SLUG char
 * set, anchored so first/last char is alphanumeric — no leading `-` git
 * would read as a flag, no pure-dot traversal); archived flag picks
 * docs/plans/ vs docs/plans/archive/; nothing else reaches git's argv.
 * execFile is shell-less.
 */

import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// Matches the canonical VALID_PLAN_SLUG char set (source.ts) so non-kebab plan
// slugs (e.g. BRIEF-*/HANDOFF-* with uppercase) backfill too. No `/` → a `..`
// segment can't traverse out of docs/plans/ when joined into git's argv.
export const PLAN_GIT_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$/;
export const PLAN_GIT_HASH_RE = /^[0-9a-f]{4,40}$/i;
const PLANS_DIR_REL = 'apps/operator/docs/plans';
const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 200;

export interface GitCommit {
  hash: string;
  author: string;
  /** ISO-8601 author date. */
  date: string;
  subject: string;
}

/**
 * The shared error codes both surfaces report. Routes/tools may
 * translate to their own envelope, but the codes are stable.
 */
export type PlanGitErrorCode =
  | 'invalid_slug'
  | 'invalid_hash'
  | 'git_error';

export type PlanHistoryResult =
  | { ok: true; commits: GitCommit[] }
  | { ok: false; code: PlanGitErrorCode; message?: string };

export type PlanFileAtCommitResult =
  | { ok: true; content: string }
  | { ok: false; code: PlanGitErrorCode; message?: string };

function resolveRepoRoot(): string {
  // Ask git for the toplevel — the docs/plans dir is NOT a reliable probe
  // anymore: plans are PG-canonical and the committed `docs/plans/*.md` files
  // were removed, so a FRESH checkout (e.g. the green-checkpoint's isolated
  // tree) has no such directory and the old probe fell back to `cwd`
  // (packages/operator-core), silently mis-rooting the pathspec → empty
  // history. (Found by the staging→main pipeline bring-up, 2026-06-06: this
  // was one of the two reds permanently blocking the green gate.)
  const cwd = process.cwd();
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
    if (top) return top;
  } catch {
    /* not a git checkout — fall back to the directory probe */
  }
  if (existsSync(path.join(cwd, PLANS_DIR_REL))) return cwd;
  const up = path.resolve(cwd, '..', '..');
  if (existsSync(path.join(up, PLANS_DIR_REL))) return up;
  return cwd;
}

function planFileRel(slug: string, archived: boolean): string {
  return archived ? `${PLANS_DIR_REL}/archive/${slug}.md` : `${PLANS_DIR_REL}/${slug}.md`;
}

export function parseHistory(stdout: string): GitCommit[] {
  if (!stdout) return [];
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash = '', author = '', date = '', ...subject] = line.split('\x00');
      return { hash, author, date, subject: subject.join('\x00') };
    });
}

export async function readPlanHistory(
  slug: string,
  opts: { archived?: boolean; limit?: number } = {},
): Promise<PlanHistoryResult> {
  if (!PLAN_GIT_SLUG_RE.test(slug)) {
    return { ok: false, code: 'invalid_slug', message: 'slug must be alphanumerics/._- with alphanumeric ends' };
  }
  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_HISTORY_LIMIT), MAX_HISTORY_LIMIT);
  const repoRoot = resolveRepoRoot();
  const relPath = planFileRel(slug, opts.archived === true);
  // No existsSync guard: plans are PG-canonical and the `docs/plans/*.md` files
  // were removed (plans-pg-canonical-migration-2026-06-03), but `git log --follow`
  // still returns a removed file's full history — which is exactly what the
  // revisions-backfill (the sole remaining caller) reconstructs. An untracked /
  // never-committed slug simply yields an empty log.
  try {
    const { stdout } = await exec(
      'git',
      [
        'log',
        '--follow',
        `-n${limit}`,
        `--pretty=format:%H%x00%an%x00%aI%x00%s`,
        '--',
        relPath,
      ],
      { cwd: repoRoot, timeout: 5000, maxBuffer: 512 * 1024 },
    );
    return { ok: true, commits: parseHistory(stdout) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, code: 'git_error', message: message.slice(0, 400) };
  }
}

/**
 * The plan file's content at a specific commit — `git show
 * <hash>:<path>`. Used by P-005's revision backfill to reconstruct a
 * content snapshot per past commit.
 *
 * When the file did not exist at that commit (a pre-creation point,
 * or a pre-rename commit surfaced by `git log --follow`) this returns
 * `{ ok: true, content: '' }` — a normal "skip this commit" outcome
 * for the backfill, not an error. Existence is probed deterministically
 * with `git cat-file -e` rather than by parsing `git show`'s stderr.
 *
 * slug + hash are regex-validated before reaching git's argv;
 * execFile is shell-less.
 */
export async function readPlanFileAtCommit(
  slug: string,
  hash: string,
  opts: { archived?: boolean } = {},
): Promise<PlanFileAtCommitResult> {
  if (!PLAN_GIT_SLUG_RE.test(slug)) {
    return { ok: false, code: 'invalid_slug', message: 'slug must be alphanumerics/._- with alphanumeric ends' };
  }
  if (!PLAN_GIT_HASH_RE.test(hash)) {
    return { ok: false, code: 'invalid_hash', message: 'hash must be 4-40 hex chars' };
  }
  const repoRoot = resolveRepoRoot();
  const relPath = planFileRel(slug, opts.archived === true);
  const rev = `${hash}:${relPath}`;

  // Probe: did the path exist at this commit? `cat-file -e` exits
  // non-zero (cleanly, no parsing) when the blob is absent.
  try {
    await exec('git', ['cat-file', '-e', rev], { cwd: repoRoot, timeout: 5000 });
  } catch {
    return { ok: true, content: '' };
  }
  try {
    const { stdout } = await exec('git', ['show', rev], {
      cwd: repoRoot,
      timeout: 8000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true, content: stdout };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, code: 'git_error', message: message.slice(0, 400) };
  }
}
