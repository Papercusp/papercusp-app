/**
 * pot-git/gc.ts — bounded namespace retention for the per-hive bare repo
 * (cross-machine-coord-parity-and-trust-2026-07-01 / P-042 G-9).
 *
 * The store keeps one shared ODB with many device namespaces. Retention must
 * trim old per-device published refs while preserving the live work line, the
 * signed sigrefs snapshot, and the newest published refs for each namespace.
 * Departed-member namespaces are archived under refs/archive before deletion.
 *
 * Best-effort by design: one bad ref or a failed `git gc` returns an error in
 * the summary instead of throwing away the whole pass.
 */

import {
  defaultRunGit,
  listNamespaces,
  sweepStalePackTmpFiles,
  type NamespaceRef,
  type RunGit,
} from './storage';
import { SIGREFS_REF } from './sigrefs';
import { STAGING_REF, WORK_REF } from './integrator';

const DEFAULT_KEEP_PUBLISHED_REFS = 2;
const NAMESPACE_PREFIX = 'refs/namespaces/';
const ARCHIVE_PREFIX = 'refs/archive/namespaces/';

export interface PotGitGcOptions {
  archiveNamespaces?: string[];
  keepPublishedRefsPerNamespace?: number;
  runGit?: RunGit;
}

export interface PotGitGcResult {
  archivedNamespaces: string[];
  deletedRefs: string[];
  errors: string[];
  keptRefs: string[];
  /** EI-18745600910177355: orphaned `index-pack` temp packs reclaimed. */
  reclaimedTmpPacks: number;
  reclaimedTmpPackBytes: number;
}

function isNamespaceHex(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function namespacePrefix(namespaceHex: string): string {
  return `${NAMESPACE_PREFIX}${namespaceHex}/`;
}

function archiveRefPath(namespaceHex: string, ref: string): string {
  return `${ARCHIVE_PREFIX}${namespaceHex}/${ref}`;
}

function liveRefPath(namespaceHex: string, ref: string): string {
  return `${namespacePrefix(namespaceHex)}${ref}`;
}

function isAlwaysKeptRef(ref: string): boolean {
  return ref === WORK_REF || ref === SIGREFS_REF || ref === STAGING_REF;
}

async function listNamespaceRefsByHex(
  repoPath: string,
  namespaceHex: string,
  runGit: RunGit,
): Promise<NamespaceRef[]> {
  const prefix = namespacePrefix(namespaceHex);
  const r = await runGit(['for-each-ref', '--format=%(objectname) %(refname)', prefix], repoPath);
  if (r.code !== 0) return [];
  const refs: NamespaceRef[] = [];
  for (const line of r.stdout.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const sp = t.indexOf(' ');
    if (sp < 0) continue;
    const sha = t.slice(0, sp);
    const full = t.slice(sp + 1);
    if (!full.startsWith(prefix)) continue;
    refs.push({ ref: full.slice(prefix.length), sha });
  }
  return refs;
}

async function listPublishedRefsNewestFirst(
  repoPath: string,
  namespaceHex: string,
  runGit: RunGit,
): Promise<string[]> {
  const prefix = namespacePrefix(namespaceHex);
  const r = await runGit(['for-each-ref', '--format=%(committerdate:unix) %(refname)', prefix], repoPath);
  if (r.code !== 0) return [];
  const out: { ref: string; ts: number }[] = [];
  for (const line of r.stdout.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const sp = t.indexOf(' ');
    if (sp < 0) continue;
    const ts = Number(t.slice(0, sp)) || 0;
    const full = t.slice(sp + 1);
    if (!full.startsWith(prefix)) continue;
    const ref = full.slice(prefix.length);
    if (isAlwaysKeptRef(ref)) continue;
    out.push({ ref, ts });
  }
  out.sort((a, b) => b.ts - a.ts || b.ref.localeCompare(a.ref));
  return out.map((entry) => entry.ref);
}

async function deleteRef(repoPath: string, fullRef: string, runGit: RunGit): Promise<string | null> {
  const r = await runGit(['update-ref', '-d', fullRef], repoPath);
  if (r.code === 0 || /does not exist|not found|no such ref/i.test(r.stderr)) return null;
  return `delete ${fullRef}: ${r.stderr.trim() || `exit ${r.code}`}`;
}

export async function archiveNamespace(
  repoPath: string,
  namespaceHex: string,
  runGit: RunGit = defaultRunGit,
): Promise<{ archived: string[]; errors: string[] }> {
  if (!isNamespaceHex(namespaceHex)) {
    return { archived: [], errors: [`archive ${namespaceHex}: invalid namespace hex`] };
  }
  const refs = await listNamespaceRefsByHex(repoPath, namespaceHex, runGit);
  const archived: string[] = [];
  const errors: string[] = [];
  for (const ref of refs) {
    const archiveRef = archiveRefPath(namespaceHex, ref.ref);
    const liveRef = liveRefPath(namespaceHex, ref.ref);
    const write = await runGit(['update-ref', archiveRef, ref.sha], repoPath);
    if (write.code !== 0) {
      errors.push(`archive ${liveRef} -> ${archiveRef}: ${write.stderr.trim() || `exit ${write.code}`}`);
      continue;
    }
    const delErr = await deleteRef(repoPath, liveRef, runGit);
    if (delErr) {
      errors.push(delErr);
      continue;
    }
    archived.push(liveRef);
  }
  return { archived, errors };
}

export async function gcHiveGitRepo(
  repoPath: string,
  opts: PotGitGcOptions = {},
): Promise<PotGitGcResult> {
  const runGit = opts.runGit ?? defaultRunGit;
  const keepPublishedRefsPerNamespace = Math.max(0, opts.keepPublishedRefsPerNamespace ?? DEFAULT_KEEP_PUBLISHED_REFS);
  const archiveNamespaces = new Set((opts.archiveNamespaces ?? []).filter(isNamespaceHex));
  const archivedNamespaces: string[] = [];
  const deletedRefs: string[] = [];
  const keptRefs: string[] = [];
  const errors: string[] = [];
  let reclaimedTmpPacks = 0;
  let reclaimedTmpPackBytes = 0;

  // EI-18745600910177355: `git gc --prune=now` below does NOT touch
  // `index-pack`'s orphaned `tmp_pack_*` files — it only prunes temp names it
  // wrote itself. Every SIGKILLed pot-git fetch leaks one, up to the full repo
  // size each (21 GB observed in a single rig store). A retention pass that
  // leaves the largest garbage on disk isn't retention, so sweep them here too.
  const swept = await sweepStalePackTmpFiles(repoPath).catch(() => null);
  if (swept && swept.removed.length > 0) {
    reclaimedTmpPackBytes = swept.bytesReclaimed;
    reclaimedTmpPacks = swept.removed.length;
  }

  for (const namespaceHex of await listNamespaces(repoPath, runGit)) {
    if (archiveNamespaces.has(namespaceHex)) {
      const archived = await archiveNamespace(repoPath, namespaceHex, runGit);
      archivedNamespaces.push(namespaceHex);
      deletedRefs.push(...archived.archived);
      errors.push(...archived.errors);
      continue;
    }

    const refs = await listNamespaceRefsByHex(repoPath, namespaceHex, runGit);
    const keep = new Set<string>();
    for (const ref of refs) {
      if (isAlwaysKeptRef(ref.ref)) keep.add(ref.ref);
    }
    for (const ref of (await listPublishedRefsNewestFirst(repoPath, namespaceHex, runGit)).slice(0, keepPublishedRefsPerNamespace)) {
      keep.add(ref);
    }

    for (const ref of refs) {
      const full = liveRefPath(namespaceHex, ref.ref);
      if (keep.has(ref.ref)) {
        keptRefs.push(full);
        continue;
      }
      const delErr = await deleteRef(repoPath, full, runGit);
      if (delErr) errors.push(delErr);
      else deletedRefs.push(full);
    }
  }

  const gc = await runGit(['gc', '--prune=now'], repoPath);
  if (gc.code !== 0) {
    errors.push(`git gc: ${gc.stderr.trim() || `exit ${gc.code}`}`);
  }

  return {
    archivedNamespaces,
    deletedRefs,
    errors,
    keptRefs,
    reclaimedTmpPacks,
    reclaimedTmpPackBytes,
  };
}
