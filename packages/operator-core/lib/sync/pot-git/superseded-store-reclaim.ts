/**
 * Reclaim pot-git bare stores left behind by a repoKey re-key (WI-10003689).
 *
 * A re-key moves a pot's writes from one store to another (the bare slug
 * `papercusp.git` -> `gh-1223568103.git` when the entry gains its GitHub id). WI-6364
 * fix C stopped the abandoned store from ANSWERING fetches, but nothing ever removed
 * it, so every re-key left a full-size frozen copy of the repo on disk. Measured on the
 * Mac rig VM 2026-09-28: `papercusp.git` (5.1G, last fetched the day before) sat beside
 * the live `gh-1223568103.git` (5.4G) on the system volume.
 *
 * A superseded store is deleted only when ALL of these hold:
 *   1. its key is a lower rung of some entry's own ladder and the canonical key of NO
 *      entry in the pot (the same two guards as `findSupersededRepoKey`);
 *   2. the canonical store exists;
 *   3. nothing has written to it for the grace period (refs, packed-refs, FETCH_HEAD,
 *      HEAD, pack dir), so a key that is still flapping is left alone;
 *   4. every object id its refs point at already exists in the canonical store, so no
 *      published tip is lost.
 * Otherwise it is retained and the reason is reported, which is itself the disk-budget
 * signal an operator needs.
 */
import { existsSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultRunGit, hiveGitRepoPath, type RunGit } from './storage';
import { canonicalRepoKey, supersededRepoKeys, type RepoIdentityEntry } from './repo-identity';

/** How long a superseded store must be untouched before it may be reclaimed. */
export const SUPERSEDED_STORE_GRACE_MS = 48 * 60 * 60 * 1000;

export interface SupersededStoreCandidate {
  repoKey: string;
  canonicalKey: string;
  entrySlug: string;
}

export interface SupersededStoreOutcome extends SupersededStoreCandidate {
  path: string;
  action: 'reclaimed' | 'retained';
  /** `reclaimed`, or why it was kept: `canonical-store-missing`, `within-grace`,
   *  `ref-list-failed`, `tips-missing:<n>/<total>`, `rm-failed:<msg>`. */
  reason: string;
  bytes: number | null;
}

/**
 * Every abandoned alias in one pot's entry set that is not ANY entry's live key.
 * Pure. Mirrors `findSupersededRepoKey`'s guard 1: an adopted pin need not be on its
 * own entry's ladder, so one entry's abandoned alias can be another entry's live key.
 */
export function supersededStoreCandidates(entries: readonly RepoIdentityEntry[]): SupersededStoreCandidate[] {
  const live = new Set(entries.map((e) => canonicalRepoKey(e)));
  const seen = new Set<string>();
  const out: SupersededStoreCandidate[] = [];
  for (const entry of entries) {
    const canonicalKey = canonicalRepoKey(entry);
    for (const repoKey of supersededRepoKeys(entry)) {
      if (live.has(repoKey) || seen.has(repoKey)) continue;
      seen.add(repoKey);
      out.push({ repoKey, canonicalKey, entrySlug: entry.slug });
    }
  }
  return out;
}

export interface ReclaimDeps {
  runGit?: RunGit;
  now?: () => number;
  graceMs?: number;
  repoPath?: (potHomeSlug: string, repoKey: string) => string;
}

/** Reclaim (or report) every superseded store under one pot home. Never throws. */
export async function reclaimSupersededStores(
  potHomeSlug: string,
  entries: readonly RepoIdentityEntry[],
  deps: ReclaimDeps = {},
): Promise<SupersededStoreOutcome[]> {
  const runGit = deps.runGit ?? defaultRunGit;
  const now = (deps.now ?? Date.now)();
  const graceMs = deps.graceMs ?? SUPERSEDED_STORE_GRACE_MS;
  const repoPath = deps.repoPath ?? hiveGitRepoPath;
  const out: SupersededStoreOutcome[] = [];

  for (const c of supersededStoreCandidates(entries)) {
    let path: string;
    let canonicalPath: string;
    try {
      path = repoPath(potHomeSlug, c.repoKey);
      canonicalPath = repoPath(potHomeSlug, c.canonicalKey);
    } catch {
      continue; // an unsafe path component is never a store this pot wrote
    }
    if (!existsSync(path)) continue;
    const bytes = await treeBytes(path).catch(() => null);
    const retain = (reason: string) => out.push({ ...c, path, action: 'retained', reason, bytes });

    if (!existsSync(canonicalPath)) {
      retain('canonical-store-missing');
      continue;
    }
    const lastWrite = await lastWriteMs(path);
    if (now - lastWrite < graceMs) {
      retain('within-grace');
      continue;
    }
    const refs = await runGit(['for-each-ref', '--format=%(objectname)'], path);
    if (refs.code !== 0) {
      retain('ref-list-failed');
      continue;
    }
    const tips = [...new Set(refs.stdout.split('\n').map((l) => l.trim()).filter(Boolean))];
    let missing = 0;
    for (const tip of tips) {
      const has = await runGit(['cat-file', '-e', tip], canonicalPath);
      if (has.code !== 0) missing += 1;
    }
    if (missing > 0) {
      retain(`tips-missing:${missing}/${tips.length}`);
      continue;
    }
    try {
      await rm(path, { recursive: true, force: true });
      out.push({ ...c, path, action: 'reclaimed', reason: 'reclaimed', bytes });
    } catch (e) {
      retain(`rm-failed:${(e as Error)?.message ?? String(e)}`);
    }
  }
  return out;
}

/**
 * The gc routine's `repo_key` is written once, at the mode flip. A later re-key leaves
 * it naming the abandoned store, so the tick would keep repacking a store nothing
 * writes to, bumping its mtimes and holding it inside the reclaim grace forever. Map a
 * superseded key to the live one; any other key passes through unchanged.
 */
export function liveGcRepoKey(configuredKey: string, entries: readonly RepoIdentityEntry[]): string {
  const hit = supersededStoreCandidates(entries).find((c) => c.repoKey === configuredKey);
  return hit ? hit.canonicalKey : configuredKey;
}

/** The registry entries whose stores live under `potHomeSlug` (serve-wiring's scope). */
export async function loadPotRepoEntries(workspaceId: string, potHomeSlug: string): Promise<RepoIdentityEntry[]> {
  const { loadHarnessRegistry } = await import('../../harness-registry');
  const { projects } = await loadHarnessRegistry(workspaceId);
  return projects.filter((p) => p.slug === potHomeSlug || p.hive_slug === potHomeSlug);
}

async function lastWriteMs(repo: string): Promise<number> {
  let latest = 0;
  const bump = async (p: string) => {
    try {
      latest = Math.max(latest, (await stat(p)).mtimeMs);
    } catch {
      /* absent */
    }
  };
  for (const f of ['HEAD', 'packed-refs', 'FETCH_HEAD', join('objects', 'pack')]) await bump(join(repo, f));
  const walk = async (dir: string): Promise<void> => {
    let ents;
    try {
      ents = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await bump(dir);
    for (const e of ents) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else await bump(p);
    }
  };
  await walk(join(repo, 'refs'));
  return latest;
}

async function treeBytes(dir: string): Promise<number> {
  let total = 0;
  const ents = await readdir(dir, { withFileTypes: true });
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += await treeBytes(p);
    else if (e.isFile()) total += (await stat(p)).size;
  }
  return total;
}
