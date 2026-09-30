/**
 * Pin a repo-files proof to the commit(s) it was measured at (P-018,
 * review-system-rework-reduction-2026-09-23).
 *
 * WHY. A `repo-files` binding's freshness is a content hash of its measured source
 * and test files, re-computed from the live tree on every read. That verdict is
 * correct and stays unchanged: if a measured file really moved, the proof no longer
 * describes the code (R-7 — no check is removed). What was missing is everything
 * AFTER the stale verdict. The binding recorded one opaque digest per dimension, so a
 * reader could see "source-stale" but not WHICH of up to 32 files moved, WHERE (the
 * superproject or a submodule), or WHETHER the move was a committed peer change or an
 * uncommitted edit still in flight. On turn-start-memory-two-class-2026-09-21 that gap
 * cost ~20 tool calls per BAR, spent reverse-engineering what one peer refactor touched.
 *
 * WHAT. At measurement time each file's content hash, its git blob id, the HEAD of the
 * repository that owns it and the gitlink its parent pins (every migration lives in the
 * `libs/papercusp` submodule, where a superproject-relative `git log` is always empty)
 * are recorded under `details.measurementPin`. On read, the per-file hashes name the
 * moved paths exactly; `explainMovedPaths` turns those into the commits that touched
 * each path since the pin, or flags an uncommitted edit.
 *
 * The pin is DIAGNOSTIC. It never makes a stale proof current and never fails a bind:
 * every git probe is best-effort and records its error instead of throwing. It is
 * excluded from the binding fingerprint (see `specEvidenceBindingFingerprint`) because a
 * HEAD sha is not a property of the proof's content: re-binding identical proof after an
 * unrelated commit must still dedupe to `unchanged`.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

export const MEASUREMENT_PIN_DETAILS_KEY = 'measurementPin';

/** One measured file, hashed from the exact bytes the fingerprint was computed over. */
export interface MeasuredRepoFile {
  path: string;
  dimension: 'source' | 'test';
  sha256: string;
  /** Git blob id of the working-tree bytes (`git hash-object`), sha1 object format. */
  gitBlob: string;
}

const pinnedFileSchema = z.object({
  path: z.string(),
  dimension: z.enum(['source', 'test']),
  sha256: z.string(),
  /** Repo-relative location of the owning repository; `.` is the measurement root. */
  repo: z.string(),
  /** The blob HEAD held for this path when measured; null when untracked or unreadable. */
  headBlob: z.string().nullable(),
  /** Whether the measured bytes equalled HEAD's blob; null when that could not be read. */
  clean: z.boolean().nullable(),
});

const pinnedRepoSchema = z.object({
  repo: z.string(),
  head: z.string().nullable(),
  /** The commit the PARENT repository's HEAD pins for this submodule; null for the root. */
  gitlink: z.string().nullable(),
});

export const measurementPinSchema = z.object({
  schemaVersion: z.literal(1),
  files: z.array(pinnedFileSchema),
  repos: z.array(pinnedRepoSchema),
  errors: z.array(z.string()).optional(),
});

export type MeasurementPin = z.infer<typeof measurementPinSchema>;
export type PinnedFile = z.infer<typeof pinnedFileSchema>;

export type GitRunner = (cwd: string, args: readonly string[]) => Promise<string>;

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 5_000;

export const defaultGitRunner: GitRunner = async (cwd, args) => {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
};

/** Git's sha1 blob id for `content`, identical to `git hash-object`. */
export function gitBlobId(content: Buffer): string {
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

async function hasGitEntry(root: string, repo: string): Promise<boolean> {
  try {
    await lstat(join(root, repo, '.git'));
    return true;
  } catch {
    return false;
  }
}

/**
 * The innermost repository that owns `path`, as a root-relative directory (`.` for the
 * root). A submodule's working directory carries a `.git` FILE, so the deepest ancestor
 * holding a `.git` entry is the owner. Pure filesystem, no git process.
 */
export async function owningRepo(
  root: string,
  path: string,
  exists: (repo: string) => Promise<boolean> = (repo) => hasGitEntry(root, repo),
): Promise<string> {
  const segments = path.split('/');
  for (let depth = segments.length - 1; depth >= 1; depth -= 1) {
    const candidate = segments.slice(0, depth).join('/');
    if (await exists(candidate)) return candidate;
  }
  return '.';
}

const relativeTo = (repo: string, path: string) => (repo === '.' ? path : path.slice(repo.length + 1));

function parseLsTree(output: string): Map<string, { type: string; object: string }> {
  const entries = new Map<string, { type: string; object: string }>();
  for (const line of output.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const [, type, object] = line.slice(0, tab).split(' ');
    if (type && object) entries.set(line.slice(tab + 1), { type, object });
  }
  return entries;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 200);

/**
 * Record, for each measured file, the repository and commit it was measured against.
 * Never throws: a probe that fails leaves a null field and an entry in `errors`.
 */
export async function buildMeasurementPin(
  root: string,
  files: readonly MeasuredRepoFile[],
  options: { git?: GitRunner; exists?: (repo: string) => Promise<boolean> } = {},
): Promise<MeasurementPin> {
  const git = options.git ?? defaultGitRunner;
  const exists = options.exists ?? ((repo: string) => hasGitEntry(root, repo));
  const errors: string[] = [];
  const repoOf = new Map<string, string>();
  for (const file of files) repoOf.set(file.path, await owningRepo(root, file.path, exists));

  const repos = [...new Set(repoOf.values())].sort();
  const heads = new Map<string, string | null>();
  const blobs = new Map<string, Map<string, { type: string; object: string }>>();
  await Promise.all(
    repos.map(async (repo) => {
      const cwd = join(root, repo);
      try {
        heads.set(repo, (await git(cwd, ['rev-parse', 'HEAD'])).trim() || null);
      } catch (error) {
        heads.set(repo, null);
        errors.push(`head:${repo}:${errorText(error)}`);
        return;
      }
      const paths = files.filter((file) => repoOf.get(file.path) === repo).map((file) => relativeTo(repo, file.path));
      try {
        blobs.set(repo, parseLsTree(await git(cwd, ['ls-tree', 'HEAD', '--', ...new Set(paths)])));
      } catch (error) {
        errors.push(`ls-tree:${repo}:${errorText(error)}`);
      }
    }),
  );

  const pinnedRepos = await Promise.all(
    repos.map(async (repo) => {
      if (repo === '.') return { repo, head: heads.get(repo) ?? null, gitlink: null };
      const parent = await owningRepo(root, repo, exists);
      let gitlink: string | null = null;
      try {
        const entry = parseLsTree(await git(join(root, parent), ['ls-tree', 'HEAD', '--', relativeTo(parent, repo)])).get(
          relativeTo(parent, repo),
        );
        gitlink = entry?.type === 'commit' ? entry.object : null;
      } catch (error) {
        errors.push(`gitlink:${repo}:${errorText(error)}`);
      }
      return { repo, head: heads.get(repo) ?? null, gitlink };
    }),
  );

  const pinnedFiles = files.map((file) => {
    const repo = repoOf.get(file.path)!;
    const tree = blobs.get(repo);
    const entry = tree?.get(relativeTo(repo, file.path));
    const headBlob = entry?.type === 'blob' ? entry.object : null;
    // Only a sha1 repository's blob id is comparable with `gitBlobId`; a sha256 object
    // format would read as permanently dirty, which is a wrong answer, so say unknown.
    const clean = tree === undefined ? null : headBlob === null ? false : headBlob.length === 40 ? headBlob === file.gitBlob : null;
    return { path: file.path, dimension: file.dimension, sha256: file.sha256, repo, headBlob, clean };
  });

  return {
    schemaVersion: 1,
    files: pinnedFiles,
    repos: pinnedRepos,
    ...(errors.length > 0 ? { errors: errors.sort() } : {}),
  };
}

export function readMeasurementPin(details: Record<string, unknown> | null | undefined): MeasurementPin | null {
  const parsed = measurementPinSchema.safeParse(details?.[MEASUREMENT_PIN_DETAILS_KEY]);
  return parsed.success ? parsed.data : null;
}

export interface MovedPath {
  path: string;
  dimension: 'source' | 'test';
  /** `changed` = bytes differ; `added` = measured now but absent from the pin; `removed` = pinned but no longer measured. */
  change: 'changed' | 'added' | 'removed';
}

/**
 * Exactly which measured files differ from what the proof was measured against.
 * `pinned:false` means the binding predates the pin, so only the aggregate stale
 * verdict is available for it — never read that as "nothing moved".
 */
export function diffMeasuredFiles(
  pin: MeasurementPin | null,
  current: readonly Pick<MeasuredRepoFile, 'path' | 'dimension' | 'sha256'>[],
): { pinned: false } | { pinned: true; moved: MovedPath[] } {
  if (!pin) return { pinned: false };
  const key = (file: { path: string; dimension: string }) => `${file.dimension}\0${file.path}`;
  const before = new Map(pin.files.map((file) => [key(file), file]));
  const after = new Map(current.map((file) => [key(file), file]));
  const moved: MovedPath[] = [];
  for (const [id, file] of after) {
    const prior = before.get(id);
    if (!prior) moved.push({ path: file.path, dimension: file.dimension, change: 'added' });
    else if (prior.sha256 !== file.sha256) moved.push({ path: file.path, dimension: file.dimension, change: 'changed' });
  }
  for (const [id, file] of before) {
    if (!after.has(id)) moved.push({ path: file.path, dimension: file.dimension, change: 'removed' });
  }
  return { pinned: true, moved: moved.sort((a, b) => a.path.localeCompare(b.path) || a.dimension.localeCompare(b.dimension)) };
}

export interface MovedPathExplanation extends MovedPath {
  repo: string;
  pinnedHead: string | null;
  /** Commits in the owning repo that touched the path since the pin, newest first (bounded). */
  commits: Array<{ sha: string; committedAt: string; subject: string }>;
  /** True when the live bytes differ from the owning repo's CURRENT HEAD blob: an edit still in flight. */
  uncommitted: boolean | null;
  errors?: string[];
}

const MAX_COMMITS_PER_PATH = 5;

/**
 * Attribute each moved path to the commits that changed it since the pin, per owning
 * repository — so a submodule path is logged INSIDE the submodule, where its history
 * actually lives. Bounded and best-effort; used on the re-measure path, not every read.
 */
export async function explainMovedPaths(
  root: string,
  pin: MeasurementPin,
  moved: readonly MovedPath[],
  current: ReadonlyMap<string, Pick<MeasuredRepoFile, 'gitBlob'>>,
  options: { git?: GitRunner; exists?: (repo: string) => Promise<boolean> } = {},
): Promise<MovedPathExplanation[]> {
  const git = options.git ?? defaultGitRunner;
  const exists = options.exists ?? ((repo: string) => hasGitEntry(root, repo));
  const pinnedHead = new Map(pin.repos.map((repo) => [repo.repo, repo.head]));
  const pinnedRepoOf = new Map(pin.files.map((file) => [file.path, file.repo]));
  return Promise.all(
    moved.map(async (entry) => {
      const repo = pinnedRepoOf.get(entry.path) ?? (await owningRepo(root, entry.path, exists));
      const head = pinnedHead.get(repo) ?? null;
      const rel = relativeTo(repo, entry.path);
      const cwd = join(root, repo);
      const errors: string[] = [];
      let commits: MovedPathExplanation['commits'] = [];
      if (head) {
        try {
          const log = await git(cwd, ['log', `-n${MAX_COMMITS_PER_PATH}`, '--format=%H%x09%cI%x09%s', `${head}..HEAD`, '--', rel]);
          commits = log
            .split('\n')
            .filter((line) => line.trim() !== '')
            .map((line) => {
              const [sha = '', committedAt = '', ...subject] = line.split('\t');
              return { sha, committedAt, subject: subject.join('\t').slice(0, 160) };
            });
        } catch (error) {
          errors.push(`log:${errorText(error)}`);
        }
      }
      let uncommitted: boolean | null = null;
      const live = current.get(entry.path);
      if (live && entry.change !== 'removed') {
        try {
          const tree = parseLsTree(await git(cwd, ['ls-tree', 'HEAD', '--', rel]));
          const blob = tree.get(rel);
          uncommitted = blob?.type === 'blob' && blob.object.length === 40 ? blob.object !== live.gitBlob : blob ? null : true;
        } catch (error) {
          errors.push(`ls-tree:${errorText(error)}`);
        }
      }
      return { ...entry, repo, pinnedHead: head, commits, uncommitted, ...(errors.length > 0 ? { errors } : {}) };
    }),
  );
}
