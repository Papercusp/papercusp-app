/**
 * Cleanup for a merge-resolver that was terminated before it could finish.
 *
 * A merge-resolver is launched through the synchronous `/invoke` route. When
 * that route's parent kills the child on timeout, the resolver can leave a
 * `MERGE_HEAD` and its owner-scoped git-sync leases behind. The next resolver
 * then fails on the unfinished merge and the stale lease blocks recovery.
 *
 * This helper is deliberately conservative:
 *   - only the explicit `--git-sync-conflict` payload is trusted;
 *   - only declared `superproject`/submodule scopes are considered;
 *   - `git merge --abort` runs only when every dirty path is in that scope's
 *     declared conflict-file allowlist;
 *   - exact owner cleanup runs in a `finally`, even when git inspection fails.
 *
 * All git and lock calls are injectable so the safety boundary is tested
 * without mutating a real checkout or the live coordination store.
 */
import { execFile } from 'node:child_process';
import { relative, resolve } from 'node:path';
import { lockDomainForProjectDir } from '../agent-tools/locks/coordination-domain';
import {
  releaseAllOwnedLocks,
  type ReleaseAllOwnedLocksResult,
} from '../agent-tools/locks/release-all-owned';

const GIT_COMMAND_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

export interface MergeResolverGitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface MergeResolverCleanupInput {
  /** Superproject checkout containing the declared submodule scopes. */
  projectPath: string;
  /** The route-owned PAPERCUSP_SPAWN_ID/PAPERCUSP_SID for this child. */
  ownerId: string;
  /** The exact `extra` array forwarded to the invoke child. */
  extra: readonly string[];
}

export interface MergeResolverCleanupScopeResult {
  scope: string;
  outcome: 'aborted' | 'skipped' | 'failed';
  reason: string;
}

export interface MergeResolverCleanupResult {
  parsed: boolean;
  scopes: MergeResolverCleanupScopeResult[];
  released: boolean;
  releaseError?: string;
  release?: ReleaseAllOwnedLocksResult;
}

export interface MergeResolverCleanupDeps {
  runGit?: (args: string[], cwd: string) => Promise<MergeResolverGitResult>;
  releaseLocks?: typeof releaseAllOwnedLocks;
  lockDomain?: (projectPath: string) => string;
}

type ConflictPayload = {
  scopes: string[];
  files: string;
};

type DeclaredFiles = Map<string, Set<string>>;

function defaultRunGit(args: string[], cwd: string): Promise<MergeResolverGitResult> {
  return new Promise((resolveResult) => {
    try {
      execFile(
        'git',
        args,
        {
          cwd,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
          timeout: GIT_COMMAND_TIMEOUT_MS,
          maxBuffer: GIT_MAX_BUFFER_BYTES,
          encoding: 'utf8',
        },
        (error, stdout, stderr) => {
          const errorCode = error && typeof (error as { code?: unknown }).code === 'number'
            ? (error as { code: number }).code
            : error
              ? 1
              : 0;
          resolveResult({
            code: errorCode,
            stdout: typeof stdout === 'string' ? stdout : String(stdout ?? ''),
            stderr: typeof stderr === 'string' ? stderr : String(stderr ?? ''),
          });
        },
      );
    } catch (error) {
      resolveResult({
        code: 1,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A repo-relative path that can safely be passed to git as a status/allowlist
 * value. Reject backslashes and dot segments so Windows-style or traversal
 * spellings cannot become an alternate path after normalization.
 */
function isSafeRelativePath(value: string): boolean {
  if (!value || value !== value.trim() || value.startsWith('/') || value.includes('\\')) return false;
  const parts = value.split('/');
  return parts.length > 0 && parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function parseConflictPayload(extra: readonly string[]): ConflictPayload | null {
  const markerIndex = extra.indexOf('--git-sync-conflict');
  if (markerIndex < 0) return null;
  const raw = extra[markerIndex + 1];
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 128_000) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.scopes) || typeof parsed.files !== 'string') return null;
  if (parsed.files.length === 0 || parsed.files.length > 128_000) return null;

  const scopes = [...new Set(
    parsed.scopes.filter((scope): scope is string => typeof scope === 'string'),
  )];
  if (
    scopes.length === 0 ||
    scopes.length > 64 ||
    scopes.some(
      (scope) =>
        (scope !== 'superproject' && !isSafeRelativePath(scope)) ||
        scope.length > 4096,
    )
  ) {
    return null;
  }
  return { scopes, files: parsed.files };
}

/**
 * Parse the current git-sync wire format:
 *   `${scope}: ${file1}, ${file2}; ${nextScope}: ${file3}`
 *
 * The parser rejects unknown/duplicate segments instead of guessing. A path
 * containing the delimiter is therefore fail-closed and cannot be aborted.
 */
function parseDeclaredFiles(payload: ConflictPayload): DeclaredFiles | null {
  const expected = new Set(payload.scopes);
  const parsed = new Map<string, Set<string>>();
  const segmentRe = /(?:^|;\s*)([^:;]+):\s*/g;
  const segments: Array<{ scope: string; start: number; index: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = segmentRe.exec(payload.files)) !== null) {
    const scope = match[1]?.trim();
    if (!scope || !expected.has(scope) || parsed.has(scope)) return null;
    segments.push({ scope, start: match.index + match[0].length, index: match.index });
    // Prevent a zero-width match from ever looping if the expression changes.
    if (match[0].length === 0) segmentRe.lastIndex += 1;
  }
  if (segments.length !== expected.size) return null;

  for (let i = 0; i < segments.length; i += 1) {
    const segment = payload.files.slice(
      segments[i]!.start,
      i + 1 < segments.length ? segments[i + 1]!.index : payload.files.length,
    ).trim();
    if (!segment) return null;
    const files = segment.split(',').map((file) => file.trim());
    if (files.length === 0 || files.some((file) => !isSafeRelativePath(file))) return null;
    parsed.set(segments[i]!.scope, new Set(files));
  }
  return parsed;
}

function parseStatusPaths(stdout: string): string[] | null {
  const tokens = stdout.split('\0');
  const paths: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const record = tokens[index] ?? '';
    if (!record) continue;
    if (record.length < 4 || record[2] !== ' ') return null;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    if (!isSafeRelativePath(path)) return null;
    paths.push(path);
    // Porcelain -z emits a second NUL-delimited pathname for renames/copies.
    if (status[0] === 'R' || status[0] === 'C') {
      const previousPath = tokens[++index];
      if (!previousPath || !isSafeRelativePath(previousPath)) return null;
      paths.push(previousPath);
    }
  }
  return paths;
}

function scopePath(projectPath: string, scope: string): string | null {
  if (scope === 'superproject') return projectPath;
  if (!isSafeRelativePath(scope)) return null;
  const projectRoot = resolve(projectPath);
  const candidate = resolve(projectRoot, scope);
  const rel = relative(projectRoot, candidate);
  if (!rel || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) return null;
  return candidate;
}

async function isSuperprojectScope(
  runGit: (args: string[], cwd: string) => Promise<MergeResolverGitResult>,
  projectPath: string,
  scope: string,
  cwd: string,
): Promise<boolean> {
  if (scope === 'superproject') {
    const root = await runGit(['rev-parse', '--show-toplevel'], cwd);
    const rootPath = root.stdout.trim();
    return root.code === 0 && rootPath.length > 0 && resolve(rootPath) === resolve(projectPath);
  }
  // A nested ordinary directory resolves to an empty string here. Requiring a
  // matching superproject root prevents `git merge --abort` from aborting the
  // enclosing superproject when a malformed scope names a normal subdirectory.
  const root = await runGit(['rev-parse', '--show-superproject-working-tree'], cwd);
  const rootPath = root.stdout.trim();
  return root.code === 0 && rootPath.length > 0 && resolve(rootPath) === resolve(projectPath);
}

/**
 * Abort safe, failed merge-resolver work and release the exact child owner.
 *
 * This function never throws. A failed inspection preserves the tree and still
 * attempts owner cleanup, so a malformed/vanished checkout cannot strand the
 * git-sync lease indefinitely.
 */
export async function cleanupMergeResolverAfterFailure(
  input: MergeResolverCleanupInput,
  deps: MergeResolverCleanupDeps = {},
): Promise<MergeResolverCleanupResult> {
  const runGit = deps.runGit ?? defaultRunGit;
  const releaseLocks = deps.releaseLocks ?? releaseAllOwnedLocks;
  const lockDomain = deps.lockDomain ?? lockDomainForProjectDir;
  const result: MergeResolverCleanupResult = {
    parsed: false,
    scopes: [],
    released: false,
  };

  try {
    const payload = parseConflictPayload(input.extra);
    const declaredFiles = payload ? parseDeclaredFiles(payload) : null;
    if (!payload || !declaredFiles) {
      result.scopes.push({
        scope: 'merge-resolver',
        outcome: 'skipped',
        reason: 'missing or invalid --git-sync-conflict allowlist',
      });
      return result;
    }
    result.parsed = true;

    for (const scope of payload.scopes) {
      const cwd = scopePath(input.projectPath, scope);
      const allowed = declaredFiles.get(scope);
      if (!cwd || !allowed) {
        result.scopes.push({ scope, outcome: 'skipped', reason: 'invalid declared scope' });
        continue;
      }
      if (!(await isSuperprojectScope(runGit, input.projectPath, scope, cwd))) {
        result.scopes.push({ scope, outcome: 'skipped', reason: 'scope is not the declared repository' });
        continue;
      }
      const mergeHead = await runGit(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], cwd);
      if (mergeHead.code !== 0) {
        result.scopes.push({ scope, outcome: 'skipped', reason: 'MERGE_HEAD is absent' });
        continue;
      }
      const status = await runGit(['status', '--porcelain=v1', '-z', '-uall'], cwd);
      if (status.code !== 0) {
        result.scopes.push({ scope, outcome: 'skipped', reason: 'git status failed' });
        continue;
      }
      const dirtyPaths = parseStatusPaths(status.stdout);
      if (!dirtyPaths || dirtyPaths.some((path) => !allowed.has(path))) {
        result.scopes.push({
          scope,
          outcome: 'skipped',
          reason: 'dirty path is outside the declared conflict allowlist',
        });
        continue;
      }
      const aborted = await runGit(['merge', '--abort'], cwd);
      if (aborted.code === 0) {
        result.scopes.push({
          scope,
          outcome: 'aborted',
          reason: 'MERGE_HEAD present and all dirty paths were allowlisted',
        });
      } else {
        result.scopes.push({
          scope,
          outcome: 'failed',
          reason: `git merge --abort failed${aborted.stderr.trim() ? `: ${aborted.stderr.trim().slice(0, 300)}` : ''}`,
        });
      }
    }
  } catch (error) {
    result.scopes.push({
      scope: 'merge-resolver',
      outcome: 'failed',
      reason: `cleanup inspection failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  } finally {
    try {
      result.release = await releaseLocks({
        ownerId: input.ownerId,
        primaryCoordinationDomain: lockDomain(input.projectPath),
      });
      result.released = true;
    } catch (error) {
      result.releaseError = error instanceof Error ? error.message : String(error);
    }
  }

  return result;
}

export const __test = {
  isSafeRelativePath,
  parseConflictPayload,
  parseDeclaredFiles,
  parseStatusPaths,
  scopePath,
};
