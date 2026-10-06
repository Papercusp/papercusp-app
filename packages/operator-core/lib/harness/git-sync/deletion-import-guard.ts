/**
 * The git-sync DELETION-IMPORT guard (EI-17).
 *
 * On 2026-06-05 an agent `rm`-ed ~34 files whose live consumers still imported
 * them. git-sync's auto-commit swept the deletions with no consistency check;
 * the operator then crash-looped fleet-wide on `Cannot find module
 * './operator-last-scan'` — MCP + coord down for the whole fleet, restart
 * counter 32. The existing content guard (./content-guard.ts) never catches
 * this class: it explicitly SKIPS deletions (there is no text to detect on),
 * and its detectors are per-file anyway — this is inherently a CROSS-file
 * check (does any SURVIVING file still import a file this commit deletes?).
 *
 * This module is the sibling of `findOversizedDirtyFiles` (same shape: a pure
 * detector fed by `git status --porcelain -z -uall`, feeding the SAME
 * `contentErrors`/`excludePaths` quarantine pipeline `commitOneRepo` already
 * wires through content-guard) rather than a new parallel mechanism — a
 * deletion whose surviving importer is found is EXCLUDED from `git add -A`
 * (via the same `:(exclude,literal)` pathspec exclusion), so the file stays
 * committed/present in `staging` (never the crash) while the local working
 * tree keeps it dirty-deleted for the content-fixer / a human to resolve
 * (restore the file, or finish the deletion by removing the surviving
 * import) — D-001 quarantine-don't-stall, exactly like an unparseable .mdx.
 *
 * SCOPE (deliberately bounded — a root-cause fix for the DEMONSTRATED bug
 * class, not a full Node/TS module resolver): only RELATIVE import/require
 * specifiers (`./x`, `../x`) are checked, resolved by textual path-join
 * against the importing file's own directory. A bare/aliased specifier
 * (`@papercusp/foo`, a tsconfig `paths` mapping) is NOT resolved — those need
 * per-package resolution config this guard intentionally does not carry.
 * FAILS OPEN throughout: a `git grep`/read error skips that deletion (logged,
 * never blocks the commit) — a guard bug must never wedge the shared tree.
 */
import { posix } from 'node:path';
import type { RunGit } from './run-git-sync';
import type { ContentOffender } from './content-guard';
import { isExcludedPath } from '../../content-lint/registry';

/** Extensions this guard treats as resolvable JS/TS modules. Exported so the sibling
 *  quarantine-import guard (EI-19932544083689229) reuses the SAME resolvable-extension
 *  set rather than a drifting duplicate — same rationale as `isExcludedPath` above. */
export const RESOLVABLE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/** Parent-dir names common enough that searching their bare basename (e.g. "index",
 *  "utils") would `git grep` a huge, mostly-irrelevant candidate set — for these we
 *  search `<parentDir>/<basename>` instead, which is far more specific. Deleted
 *  `index.*` files ALSO get a search on the parent dir name alone, to catch
 *  directory-style imports (`from '../foo'` resolving to `foo/index.ts`) that never
 *  mention "index" at all. */
const GENERIC_BASENAMES = new Set(['index', 'types', 'utils', 'helpers', 'constants', 'config', 'common', 'shared', 'base', 'core']);

/** Repo-relative path deletion worth checking as a potential broken-import TARGET. */
export function isCheckedModuleDeletion(path: string): boolean {
  if (path.endsWith('.d.ts')) return false;
  if (!RESOLVABLE_EXTS.some((ext) => path.endsWith(ext))) return false;
  if (/\.(test|spec)\.[jt]sx?$/.test(path)) return false;
  if (isExcludedPath(path)) return false;
  return true;
}

/** Parse `git status --porcelain -z -uall` into ONLY the deleted repo-relative paths
 *  (the mirror image of content-guard's parseDirtyPaths, which skips deletions). */
export function parseDeletedPaths(porcelainZ: string): string[] {
  const entries = porcelainZ.split('\0').filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.length < 4) continue;
    const xy = e.slice(0, 2);
    const path = e.slice(3);
    if (xy.includes('R') || xy.includes('C')) i++; // -z renames: "XY new\0old" — skip the origin path
    if (xy.includes('D')) out.push(path);
  }
  return out;
}

/** Normalize a module path for exact comparison: strip a resolvable extension, then
 *  collapse a trailing `/index`. `'lib/foo/index.ts'` and `'lib/foo'` both → `'lib/foo'`. */
export function normalizeModulePath(path: string): string {
  let p = path;
  for (const ext of RESOLVABLE_EXTS) {
    if (p.endsWith(ext)) {
      p = p.slice(0, -ext.length);
      break;
    }
  }
  return p.replace(/\/index$/, '');
}

/** Extract this file's RELATIVE import/export/require specifiers verbatim (unresolved,
 *  deduped). Deliberately simple regex scan (mirrors the other content detectors in this
 *  codebase, e.g. smart-quotes) rather than a full parser — a missed exotic form just means
 *  a missed detection (fails open), never a false positive. */
export function extractRelativeImportSpecifiers(text: string): string[] {
  const specs = new Set<string>();
  const re = /(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]|require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const spec = m[1] ?? m[2];
    if (spec) specs.add(spec);
  }
  return [...specs];
}

/** Resolve a relative specifier as WRITTEN in `fromFile` to a normalized repo-relative
 *  module path, for exact comparison against `normalizeModulePath(deletedPath)`. */
export function resolveRelativeSpecifier(fromFile: string, spec: string): string {
  const dir = posix.dirname(fromFile);
  const joined = posix.normalize(posix.join(dir, spec));
  return normalizeModulePath(joined);
}

/** The `git grep` fixed-string search token(s) for a deleted module — narrowed for common
 *  generic basenames (see GENERIC_BASENAMES) so a single tick can never `grep` the whole
 *  tree for a near-universal substring like "index". */
export function candidateSearchTokens(deletedPath: string): string[] {
  const base = posix.basename(deletedPath).replace(/\.[^.]+$/, '');
  const parentDir = posix.basename(posix.dirname(deletedPath));
  const tokens = new Set<string>();
  if (base.toLowerCase() === 'index') {
    // Directory-style imports (`from '../foo'`) never mention "index" — search the dir name.
    if (parentDir && parentDir !== '.') tokens.add(parentDir);
  } else if (GENERIC_BASENAMES.has(base.toLowerCase()) || base.length < 4) {
    tokens.add(parentDir && parentDir !== '.' ? `${parentDir}/${base}` : base);
  } else {
    tokens.add(base);
  }
  return [...tokens];
}

export interface DeletionGuardDeps {
  runGit: RunGit;
  repoPath: string;
  /** Read a repo-relative file's CURRENT working-tree text; null when unreadable/gone. */
  readText: (relPath: string) => Promise<string | null>;
  log?: (m: string) => void;
}

/** Bounded-concurrency map (avoid a serial fs loop — CLAUDE.md perf anti-patterns). */
async function mapPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

const MAX_READ_CONCURRENCY = 16;
const MAX_IMPORTERS_REPORTED = 5;

/**
 * Detect dirty DELETIONS whose module is still imported (via a relative specifier) by a
 * surviving file. Returns `ContentOffender`-shaped records so `commitOneRepo` can fold them
 * straight into the SAME exclude/quarantine/escalation pipeline as an oversized blob or a
 * broken .mdx — no new commit-path plumbing.
 */
export async function detectUnsafeDeletions(deps: DeletionGuardDeps): Promise<ContentOffender[]> {
  const { runGit, repoPath, readText, log } = deps;
  const statusRes = await runGit(['status', '--porcelain', '-z', '-uall'], repoPath);
  if (statusRes.code !== 0) return []; // can't list — fail open, exactly like content-guard

  const deletedPaths = parseDeletedPaths(statusRes.stdout).filter(isCheckedModuleDeletion);
  if (deletedPaths.length === 0) return [];
  const deletedNormalized = new Set(deletedPaths.map(normalizeModulePath));

  const offenders: ContentOffender[] = [];
  await mapPool(deletedPaths, MAX_READ_CONCURRENCY, async (deletedPath) => {
    const tokens = candidateSearchTokens(deletedPath);
    const candidates = new Set<string>();
    for (const token of tokens) {
      if (!token) continue;
      let grep: { code: number; stdout: string; stderr: string };
      try {
        grep = await runGit(
          ['grep', '-zIl', '-F', token, '--untracked', '--', ...RESOLVABLE_EXTS.map((ext) => `*${ext}`)],
          repoPath,
        );
      } catch (e) {
        log?.(`[deletion-guard] git grep threw scanning for "${token}" — skipping (fail open): ${errMsg(e)}`);
        continue;
      }
      // git grep exits 1 for "no matches" — not an error; anything else (>1) is a real
      // failure and this token's candidates are skipped (fail open), never blocking.
      if (grep.code !== 0 && grep.code !== 1) {
        log?.(`[deletion-guard] git grep errored scanning for "${token}" — skipping (fail open): ${grep.stderr || grep.stdout}`);
        continue;
      }
      for (const f of grep.stdout.split('\0').filter(Boolean)) candidates.add(f);
    }
    // Never flag against the deleted file itself, or a peer ALSO deleted this same
    // commit (both sides going away together is a consistent, safe deletion set).
    for (const c of [...candidates]) {
      if (c === deletedPath || deletedNormalized.has(normalizeModulePath(c))) candidates.delete(c);
    }
    if (candidates.size === 0) return;

    const deletedNorm = normalizeModulePath(deletedPath);
    const importedBy: string[] = [];
    for (const candidate of candidates) {
      let text: string | null;
      try {
        text = await readText(candidate);
      } catch (e) {
        log?.(`[deletion-guard] could not read candidate ${candidate} — skipping (not blocking): ${errMsg(e)}`);
        continue;
      }
      if (text == null) continue;
      for (const spec of extractRelativeImportSpecifiers(text)) {
        if (resolveRelativeSpecifier(candidate, spec) === deletedNorm) {
          importedBy.push(candidate);
          break;
        }
      }
    }
    if (importedBy.length === 0) return;

    const shown = importedBy.slice(0, MAX_IMPORTERS_REPORTED);
    const more = importedBy.length > shown.length ? ` (+${importedBy.length - shown.length} more)` : '';
    offenders.push({
      file: deletedPath,
      detectorKey: 'unsafe-deletion',
      error:
        `deleting this file would break a still-live import — still imported (relative) by: ${shown.join(', ')}${more}. ` +
        `Either restore this file, or finish the deletion by removing the import(s) from the listed file(s) first.`,
      fixerRole: 'content-fixer',
    });
  });
  return offenders;
}

/** A staged deletion the commit's own tree still imports (WI-10006352). */
export interface StagedDeletionHold {
  path: string;
  /** Index paths whose STAGED text still imports `path` (relative specifier). */
  importedBy: string[];
  /** Set when the index could not be scanned for this deletion — held conservatively. */
  scanError?: string;
}

/**
 * WI-10006352: the INDEX-level backstop for `detectUnsafeDeletions`, run immediately before
 * each git-sync commit (see `guardStagedIndexBeforeCommit` in run-git-sync.ts).
 *
 * `detectUnsafeDeletions` judges importers by their WORKING-TREE text, before the commit's
 * exclusion set is final. Every later exclusion — a quarantined or live-lock importer, a
 * Cargo/npm closure, a late lock or drift unstaged after `git add` — leaves that importer's
 * HEAD text in the commit. If the working-tree edit dropped an import but the edit is held
 * back, the deletion it made safe still commits, and HEAD imports a module that no longer
 * exists. MEASURED 2026-10-06: e7b60f03fe deleted `agent-tools/gmail/*` while the
 * `agent-tools/index.ts` edit removing `import './gmail/create-draft'` was held as
 * `[quarantined-importer]`; every isolated build of staging failed on the unresolved import.
 *
 * The index IS the tree `git commit` records, so this reads only the index: staged deletions
 * (`git diff --cached --diff-filter=D`), candidate importers (`git grep --cached`), and their
 * staged text (`git show :<path>`). Unlike the pre-stage guard it never fails open: a deletion
 * whose index scan fails is held, because holding a deletion only defers it one tick, while
 * committing a broken one red-pins every isolated checkout.
 */
export async function detectStagedDeletionsStillImported(deps: {
  runGit: RunGit;
  repoPath: string;
  /** The caller's own CURRENT `git diff --cached --diff-filter=D` listing, to skip re-reading it.
   *  Omit after anything has changed the index since that listing was taken. */
  stagedDeletions?: readonly string[];
  log?: (m: string) => void;
}): Promise<{ ok: true; holds: StagedDeletionHold[] } | { ok: false; error: string }> {
  const { runGit, repoPath, log } = deps;
  let listed = deps.stagedDeletions;
  if (!listed) {
    const deletedRes = await runGit(
      ['diff', '--cached', '--name-only', '--no-renames', '-z', '--diff-filter=D'],
      repoPath,
    );
    if (deletedRes.code !== 0) {
      return { ok: false, error: `could not list staged deletions: ${(deletedRes.stderr || deletedRes.stdout).trim()}` };
    }
    listed = deletedRes.stdout.split('\0').filter(Boolean);
  }
  const deleted = listed.filter(isCheckedModuleDeletion);
  if (deleted.length === 0) return { ok: true, holds: [] };

  // A module path still provided by another indexed file (x.js -> x.ts, foo.ts <-> foo/index.ts)
  // is not a broken import target, so its importers need no check.
  const providedTargets = await indexedModuleTargets(runGit, repoPath, deleted, log);

  const holds: StagedDeletionHold[] = [];
  await mapPool(deleted, MAX_READ_CONCURRENCY, async (deletedPath) => {
    const deletedNorm = normalizeModulePath(deletedPath);
    if (providedTargets.has(deletedNorm)) return;
    const candidates = new Set<string>();
    for (const token of candidateSearchTokens(deletedPath)) {
      if (!token) continue;
      let grep: { code: number; stdout: string; stderr: string };
      try {
        grep = await runGit(
          ['grep', '--cached', '-zIl', '-F', token, '--', ...RESOLVABLE_EXTS.map((ext) => `*${ext}`)],
          repoPath,
        );
      } catch (e) {
        holds.push({ path: deletedPath, importedBy: [], scanError: `git grep --cached threw: ${errMsg(e)}` });
        return;
      }
      if (grep.code !== 0 && grep.code !== 1) {
        holds.push({
          path: deletedPath,
          importedBy: [],
          scanError: `git grep --cached exited ${grep.code}: ${(grep.stderr || grep.stdout).trim()}`,
        });
        return;
      }
      for (const f of grep.stdout.split('\0').filter(Boolean)) candidates.add(f);
    }
    const importedBy: string[] = [];
    for (const candidate of candidates) {
      let show: { code: number; stdout: string; stderr: string };
      try {
        show = await runGit(['show', `:${candidate}`], repoPath);
      } catch (e) {
        holds.push({ path: deletedPath, importedBy, scanError: `could not read staged ${candidate}: ${errMsg(e)}` });
        return;
      }
      if (show.code !== 0) {
        holds.push({
          path: deletedPath,
          importedBy,
          scanError: `could not read staged ${candidate}: ${(show.stderr || show.stdout).trim()}`,
        });
        return;
      }
      for (const spec of extractRelativeImportSpecifiers(show.stdout)) {
        if (resolveRelativeSpecifier(candidate, spec) === deletedNorm) {
          importedBy.push(candidate);
          break;
        }
      }
    }
    if (importedBy.length > 0) holds.push({ path: deletedPath, importedBy: importedBy.slice(0, MAX_IMPORTERS_REPORTED) });
  });
  if (holds.length > 0) {
    log?.(
      `[deletion-guard] staged deletion(s) still imported by the index: ` +
        holds.map((h) => `${h.path} <- ${h.scanError ?? h.importedBy.join(', ')}`).join('; '),
    );
  }
  return { ok: true, holds };
}

/** Normalized module paths that some INDEXED file still provides, for each deletion's candidates. */
async function indexedModuleTargets(
  runGit: RunGit,
  repoPath: string,
  deleted: string[],
  log?: (m: string) => void,
): Promise<Set<string>> {
  const specs = new Set<string>();
  for (const path of deleted) {
    const norm = normalizeModulePath(path);
    for (const ext of RESOLVABLE_EXTS) {
      specs.add(`:(literal)${norm}${ext}`);
      specs.add(`:(literal)${norm}/index${ext}`);
    }
  }
  const out = new Set<string>();
  let res: { code: number; stdout: string; stderr: string };
  try {
    res = await runGit(['ls-files', '--cached', '-z', '--', ...specs], repoPath);
  } catch (e) {
    log?.(`[deletion-guard] ls-files --cached threw — treating no deleted module as still provided: ${errMsg(e)}`);
    return out;
  }
  if (res.code !== 0) {
    log?.(`[deletion-guard] ls-files --cached failed — treating no deleted module as still provided: ${res.stderr || res.stdout}`);
    return out;
  }
  for (const f of res.stdout.split('\0').filter(Boolean)) out.add(normalizeModulePath(f));
  return out;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
