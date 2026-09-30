/**
 * WI-10004232: lockfile ⇄ workspace-manifest CONSISTENCY at the repair-queue admit door.
 *
 * A hunk-exact admission can land one side of a dependency change without the other. Measured on
 * 90015e13: the `package-lock.json` hunk adding `@papercusp/decision-model` to
 * `packages["packages/operator-core"].dependencies` was admitted, the matching
 * `packages/operator-core/package.json` hunk was not. The gate stayed green (vitest never asks npm),
 * the lineage was promoted, and then EVERY live-certification run failed
 * `certification-source-dirty-at-build-end`: the build's `npm install` rewrote the lock back to what
 * the manifests declare. The pin could never certify, so the only exits were a newer green pin or a
 * forced deploy. WI-10003229 was the same class through the gate's own P-008 convergence (a lock
 * admitted without the gitlink holding its manifest); that path has its own check in
 * `green-checkpoint-lockfile-convergence.ts`. This is the ordinary admit door's equivalent.
 *
 * The check is npm's own: a lock's workspace entry (`packages[<dir>]`, never a `node_modules/` key)
 * copies its manifest's four dependency maps verbatim, and `npm install` rewrites any entry whose
 * maps disagree. Measured against the real tree: 110/110 workspace entries agree at 9a4319b7 and
 * exactly one (the defect above) disagrees at 90015e13, so a disagreement is signal, not noise.
 *
 * Only an inconsistency THIS admission introduced refuses: an entry that disagrees at the proved
 * commit but agreed at repairHead. A disagreement that was already there is not the caller's to fix
 * in this admission, and refusing it would block the very admission that repairs it.
 */
import { posix } from 'node:path';

import {
  realAdmissionGit,
  type AdmissionGitRunner,
  type AdmissionMissingImport,
  type AdmissionPreflightRefusal,
  type AdmitPathsInput,
} from './repair-head-admission';

const LOCKFILE_BASENAMES: ReadonlySet<string> = new Set(['package-lock.json', 'npm-shrinkwrap.json']);

/** The maps npm copies from a workspace manifest into its lock entry. */
export const LOCK_DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;
export type LockDependencyField = (typeof LOCK_DEPENDENCY_FIELDS)[number];

type DependencyMaps = Record<LockDependencyField, Record<string, string>>;

export function isLockfilePath(rel: string): boolean {
  return LOCKFILE_BASENAMES.has(posix.basename(rel));
}

/** The manifest a lock's workspace entry describes (`''` is the lockfile's own directory). */
export function manifestPathForLockKey(lockfile: string, key: string): string {
  const dir = posix.dirname(lockfile);
  return posix.join(dir === '.' ? '' : dir, key, 'package.json');
}

function isWorkspaceKey(key: string): boolean {
  return !key.split('/').includes('node_modules');
}

function pickDependencyMaps(obj: unknown): DependencyMaps {
  const src = obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : {};
  const out = {} as DependencyMaps;
  for (const field of LOCK_DEPENDENCY_FIELDS) {
    const raw = src[field];
    const map: Record<string, string> = {};
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [name, spec] of Object.entries(raw as Record<string, unknown>)) map[name] = String(spec);
    }
    out[field] = map;
  }
  return out;
}

function sameMap(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  return ak.every((k) => Object.prototype.hasOwnProperty.call(b, k) && a[k] === b[k]);
}

/** The dependency fields on which the lock entry and its manifest disagree; empty ⇒ npm leaves it alone. */
export function lockEntryDisagreement(entry: unknown, manifest: unknown): LockDependencyField[] {
  const lockMaps = pickDependencyMaps(entry);
  const manifestMaps = pickDependencyMaps(manifest);
  return LOCK_DEPENDENCY_FIELDS.filter((f) => !sameMap(lockMaps[f], manifestMaps[f]));
}

/** Workspace entries of a parsed lock, by key. A lock that is absent or unparseable yields none. */
export function workspaceLockEntries(lockText: string | null): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (lockText === null) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(lockText);
  } catch {
    return out;
  }
  const packages = (parsed as { packages?: unknown } | null)?.packages;
  if (!packages || typeof packages !== 'object') return out;
  for (const [key, entry] of Object.entries(packages as Record<string, unknown>)) {
    if (isWorkspaceKey(key)) out.set(key, entry);
  }
  return out;
}

class GitProbeError extends Error {
  constructor(readonly step: string, detail: string) {
    super(detail);
  }
}

interface ResolvedBlob {
  /** Repository (superproject or submodule checkout) holding the blob. */
  root: string;
  blob: string;
  /** Innermost gitlink crossed, superproject-relative; null when the path is in the superproject. */
  gitlink: string | null;
}

function lsTree(git: AdmissionGitRunner, root: string, rev: string, rels: readonly string[]) {
  const r = git(['ls-tree', '-z', rev, '--', ...rels], { cwd: root });
  if (r.status !== 0) {
    throw new GitProbeError(`ls-tree ${rev.slice(0, 12)}`, `in ${root} exited ${r.status}: ${r.stderr.trim().slice(0, 400)}`);
  }
  const entries = new Map<string, { type: string; object: string }>();
  for (const record of r.stdout.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const [, type, object] = record.slice(0, tab).split(/\s+/);
    if (type && object) entries.set(record.slice(tab + 1), { type, object });
  }
  return entries;
}

/**
 * Resolve many paths at `rev`, descending through submodule gitlinks (a superproject `ls-tree`
 * answers nothing for a path under a gitlink, which would read as "manifest absent"). A pin the
 * submodule cannot resolve throws: unverifiable is never silently consistent.
 */
function resolveBlobs(
  git: AdmissionGitRunner,
  root: string,
  rev: string,
  rels: readonly string[],
  gitlinkPrefix = '',
  depth = 0,
): Map<string, ResolvedBlob | null> {
  const out = new Map<string, ResolvedBlob | null>();
  if (rels.length === 0) return out;
  if (depth > 8) throw new GitProbeError('gitlink descent', `nesting too deep under ${root}`);
  const direct = lsTree(git, root, rev, rels);
  const unresolved: string[] = [];
  for (const rel of rels) {
    const hit = direct.get(rel);
    if (hit?.type === 'blob') out.set(rel, { root, blob: hit.object, gitlink: gitlinkPrefix || null });
    else if (hit) out.set(rel, null);
    else unresolved.push(rel);
  }
  if (unresolved.length === 0) return out;
  const prefixes = new Set<string>();
  for (const rel of unresolved) {
    const segs = rel.split('/');
    for (let i = 1; i < segs.length; i += 1) prefixes.add(segs.slice(0, i).join('/'));
  }
  const ancestors = lsTree(git, root, rev, [...prefixes]);
  const bySubmodule = new Map<string, { pin: string; rels: string[] }>();
  for (const rel of unresolved) {
    const segs = rel.split('/');
    let gitlink: string | null = null;
    for (let i = 1; i < segs.length; i += 1) {
      const prefix = segs.slice(0, i).join('/');
      const entry = ancestors.get(prefix);
      if (entry?.type === 'commit') {
        gitlink = prefix;
        const group = bySubmodule.get(prefix) ?? { pin: entry.object, rels: [] };
        group.rels.push(segs.slice(i).join('/'));
        bySubmodule.set(prefix, group);
        break;
      }
      // `ls-tree` omits a tree's own entry when another pathspec descends into it, so an
      // intermediate directory reads as unlisted; only a listed non-tree ends the walk.
      if (entry && entry.type !== 'tree') break;
    }
    if (!gitlink) out.set(rel, null);
  }
  for (const [prefix, group] of bySubmodule) {
    const inner = resolveBlobs(
      git,
      posix.join(root, prefix),
      group.pin,
      group.rels,
      gitlinkPrefix ? `${gitlinkPrefix}/${prefix}` : prefix,
      depth + 1,
    );
    for (const [innerRel, hit] of inner) out.set(`${prefix}/${innerRel}`, hit);
  }
  return out;
}

function readBlob(git: AdmissionGitRunner, root: string, blob: string): string {
  const r = git(['cat-file', 'blob', blob], { cwd: root });
  if (r.status !== 0) {
    throw new GitProbeError(`cat-file ${blob.slice(0, 12)}`, `in ${root} exited ${r.status}: ${r.stderr.trim().slice(0, 400)}`);
  }
  return r.stdout;
}

function readJson(git: AdmissionGitRunner, hit: ResolvedBlob | null | undefined): unknown {
  if (!hit) return null;
  try {
    return JSON.parse(readBlob(git, hit.root, hit.blob));
  } catch (e) {
    if (e instanceof GitProbeError) throw e;
    return null;
  }
}

function readLock(git: AdmissionGitRunner, root: string, rev: string, lockfile: string): Map<string, unknown> {
  const hit = resolveBlobs(git, root, rev, [lockfile]).get(lockfile);
  return workspaceLockEntries(hit ? readBlob(git, hit.root, hit.blob) : null);
}

export interface LockfileInconsistency {
  lockfile: string;
  /** The workspace key in `packages{}` (`''` = the lockfile's own directory). */
  key: string;
  manifest: string;
  fields: LockDependencyField[];
  /** What the caller must admit alongside: the manifest (or the gitlink holding it) or the lockfile. */
  wanted: string;
  atProbeRef: AdmissionMissingImport['atProbeRef'];
}

export type LockfileConsistencyOutcome =
  | { ok: true; checked: number }
  | { ok: false; code: 'inconsistent'; inconsistencies: LockfileInconsistency[] }
  | { ok: false; code: 'git-failed'; step: string; detail: string };

export interface LockfileConsistencyInput {
  root: string;
  /** The proved admission commit. */
  commit: string;
  /** Its parent: the queue's repairHead before this admission. */
  repairHead: string;
  /** The proved admitted path set. */
  admitted: readonly string[];
  /** The shared tip, consulted only to say whether admitting `wanted` from it closes the gap. */
  probeRef?: string;
  git?: AdmissionGitRunner;
}

/**
 * Every lock workspace entry this admission put out of agreement with its manifest. Scope is what
 * the admission could have changed: entries of an admitted lockfile whose dependency maps moved,
 * plus the entry of any admitted manifest or of any manifest under an admitted gitlink.
 */
export function checkLockfileManifestConsistency(input: LockfileConsistencyInput): LockfileConsistencyOutcome {
  const git = input.git ?? realAdmissionGit;
  const admitted = new Set(input.admitted);
  const admittedLocks = input.admitted.filter(isLockfilePath);
  const admittedManifests = input.admitted.filter((p) => posix.basename(p) === 'package.json');
  // A gitlink bump can move every manifest under it; gitlink paths carry no extension.
  const maybeGitlinks = input.admitted.filter((p) => !posix.extname(p));
  if (admittedLocks.length === 0 && admittedManifests.length === 0 && maybeGitlinks.length === 0) {
    return { ok: true, checked: 0 };
  }
  try {
    const admittedGitlinks =
      maybeGitlinks.length > 0
        ? [...lsTree(git, input.root, input.commit, maybeGitlinks)].filter(([, e]) => e.type === 'commit').map(([p]) => p)
        : [];
    const touchesManifests = admittedManifests.length > 0 || admittedGitlinks.length > 0;
    if (admittedLocks.length === 0 && !touchesManifests) return { ok: true, checked: 0 };
    const lockfiles = new Set(admittedLocks);
    if (touchesManifests) {
      const rootLocks = resolveBlobs(git, input.root, input.commit, [...LOCKFILE_BASENAMES]);
      for (const [lock, hit] of rootLocks) if (hit) lockfiles.add(lock);
      for (const p of admittedManifests) {
        if (posix.dirname(p) === '.') continue;
        const sibling = posix.join(posix.dirname(p), 'package-lock.json');
        if (resolveBlobs(git, input.root, input.commit, [sibling]).get(sibling)) lockfiles.add(sibling);
      }
    }
    const inconsistencies: LockfileInconsistency[] = [];
    let checked = 0;
    for (const lockfile of lockfiles) {
      const atCommit = readLock(git, input.root, input.commit, lockfile);
      const atHead = readLock(git, input.root, input.repairHead, lockfile);
      const scope: string[] = [];
      for (const [key, entry] of atCommit) {
        const manifest = manifestPathForLockKey(lockfile, key);
        const lockMoved =
          admitted.has(lockfile) &&
          (!atHead.has(key) || lockEntryDisagreement(entry, atHead.get(key)).length > 0);
        const manifestAdmitted =
          admitted.has(manifest) || admittedGitlinks.some((p) => manifest.startsWith(`${p}/`));
        if (lockMoved || manifestAdmitted) scope.push(key);
      }
      if (scope.length === 0) continue;
      checked += scope.length;
      const manifestsAtCommit = resolveBlobs(
        git,
        input.root,
        input.commit,
        scope.map((k) => manifestPathForLockKey(lockfile, k)),
      );
      const disagreeing: Array<{ key: string; manifest: string; fields: LockDependencyField[]; gitlink: string | null }> = [];
      for (const key of scope) {
        const manifest = manifestPathForLockKey(lockfile, key);
        const hit = manifestsAtCommit.get(manifest);
        const fields = lockEntryDisagreement(atCommit.get(key), readJson(git, hit));
        if (fields.length > 0) disagreeing.push({ key, manifest, fields, gitlink: hit?.gitlink ?? null });
      }
      if (disagreeing.length === 0) continue;
      // Introduced vs pre-existing: only an entry that AGREED at repairHead is this admission's doing.
      const manifestsAtHead = resolveBlobs(git, input.root, input.repairHead, disagreeing.map((d) => d.manifest));
      const introduced = disagreeing.filter((d) => {
        if (!atHead.has(d.key)) return true;
        return lockEntryDisagreement(atHead.get(d.key), readJson(git, manifestsAtHead.get(d.manifest))).length === 0;
      });
      if (introduced.length === 0) continue;
      let atProbe: { lock: Map<string, unknown>; manifests: Map<string, ResolvedBlob | null> } | null = null;
      if (input.probeRef) {
        atProbe = {
          lock: readLock(git, input.root, input.probeRef, lockfile),
          manifests: resolveBlobs(git, input.root, input.probeRef, introduced.map((d) => d.manifest)),
        };
      }
      for (const d of introduced) {
        const wanted = admitted.has(lockfile) ? (d.gitlink ?? d.manifest) : lockfile;
        let atProbeRef: AdmissionMissingImport['atProbeRef'] = 'unknown';
        if (atProbe?.lock.has(d.key)) {
          const agrees =
            lockEntryDisagreement(atProbe.lock.get(d.key), readJson(git, atProbe.manifests.get(d.manifest))).length === 0;
          if (agrees) atProbeRef = 'present';
        }
        inconsistencies.push({ lockfile, key: d.key, manifest: d.manifest, fields: d.fields, wanted, atProbeRef });
      }
    }
    return inconsistencies.length > 0 ? { ok: false, code: 'inconsistent', inconsistencies } : { ok: true, checked };
  } catch (e) {
    if (e instanceof GitProbeError) return { ok: false, code: 'git-failed', step: e.step, detail: e.message };
    throw e;
  }
}

export function renderLockfileInconsistencies(list: readonly LockfileInconsistency[]): string {
  return list
    .map(
      (i) =>
        `${i.lockfile} packages[${JSON.stringify(i.key)}] ${i.fields.join('/')} disagree with ${i.manifest} → admit ${i.wanted}` +
        (i.atProbeRef === 'present' ? ' (the shared tip agrees — admit it from there)' : ''),
    )
    .join('; ');
}

/** The admit door's preflight form. `git-failed` fails CLOSED, like every door check. */
export function lockfileManifestConsistencyPreflight(opts: {
  root: string;
  probeRef?: string;
  git?: AdmissionGitRunner;
}): NonNullable<AdmitPathsInput['preflight']> {
  return (built): AdmissionPreflightRefusal | null => {
    const r = checkLockfileManifestConsistency({
      root: opts.root,
      commit: built.commit,
      repairHead: built.repairHead,
      admitted: built.admitted,
      probeRef: opts.probeRef,
      git: opts.git,
    });
    if (r.ok) return null;
    if (r.code === 'git-failed') {
      return { code: 'git-failed', step: `lockfile consistency preflight: ${r.step}`, detail: r.detail };
    }
    return {
      code: 'admission-incomplete',
      missing: r.inconsistencies.map((i) => ({
        from: i.lockfile,
        specifier: `packages[${JSON.stringify(i.key)}].${i.fields.join('/')}`,
        wanted: i.wanted,
        tried: [i.manifest],
        atProbeRef: i.atProbeRef,
      })),
      detail:
        `REFUSED: admission ${built.commit.slice(0, 12)} leaves ${r.inconsistencies.length} lockfile workspace ` +
        `entr${r.inconsistencies.length === 1 ? 'y' : 'ies'} out of agreement with its manifest ` +
        `(${renderLockfileInconsistencies(r.inconsistencies)}). npm install would rewrite the lock, so a pin ` +
        'promoted from this lineage fails every live certification (certification-source-dirty-at-build-end, ' +
        'WI-10004232). It was NOT published and repairHead did not move; admit the named path(s) alongside yours.',
    };
  };
}

/** Run preflights in order; the first refusal stops the admission. */
export function chainAdmissionPreflights(
  ...hooks: ReadonlyArray<NonNullable<AdmitPathsInput['preflight']>>
): NonNullable<AdmitPathsInput['preflight']> {
  return (built) => {
    for (const hook of hooks) {
      const stop = hook(built);
      if (stop) return stop;
    }
    return null;
  };
}
