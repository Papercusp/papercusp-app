/**
 * pot-git/gate/shards.ts — DG-2: the distributed test gate's shard manifest +
 * per-shard input hash (cross-machine-coord-parity-and-trust-2026-07-01 Phase 8
 * P-045, D-011).
 *
 * THE MODEL (mirrors scripts/affected-tests.mjs, the local affected-set runner):
 *   a SHARD is one (workspace, layer) pair — `layer` is the test-config split:
 *   `unit` (the workspace's `test` script) or `integration`
 *   (`test:integration`). A shard's INPUTS are the workspace's own directory
 *   plus every TRANSITIVE workspace dependency's directory (the same
 *   reverse-deps graph affected-tests walks), plus the root dependency
 *   manifests (package.json + package-lock.json) that pin external dep
 *   versions for everyone.
 *
 * INCREMENTALITY (why inputsHash exists): `shardInputsHash` hashes the GIT TREE
 *   OIDs of the shard's input dirs AT A COMMIT — not the commit sha itself. Two
 *   different staging shas whose trees agree on a shard's inputs produce the
 *   SAME inputsHash, so a prior green verdict for that (shardId, inputsHash) is
 *   reusable and the unchanged shard never re-runs. The hash changes iff some
 *   input's tree changed.
 *
 * HERMETICITY: everything is derived from the COMMITTED tree at `sha` via git
 *   plumbing (`show` / `ls-tree` / `rev-parse`), never the working tree — so
 *   any machine holding the objects computes the identical manifest + hashes
 *   from `(sha)` alone.
 *
 * GITLINK (submodule) BOUNDARIES: several workspaces live inside submodules
 *   (libs/papercusp/*, libs/agent-chat, …). A path INSIDE a gitlink cannot be
 *   resolved from the superproject ODB, so:
 *   - `shardInputsHash` walks UP from an unresolvable input dir to the nearest
 *     resolvable ancestor — the gitlink's commit OID. Coarser than a tree hash
 *     (any submodule change invalidates the shard) but CORRECT: it changes
 *     whenever the submodule pointer changes and never misses a change.
 *   - `discoverWorkspacesAtSha` cannot read a package.json behind a gitlink
 *     from the superproject alone; those workspaces are reported LOUDLY in
 *     `unreadableWorkspaces` (never silently dropped). Pass a
 *     `SubmoduleRepoResolver` (a machine with a checkout has every submodule's
 *     ODB) to make discovery recurse and cover them too.
 *
 * Pure over the injected RunGit seam (storage.ts idiom) — no fs, no network,
 * no policy. Scheduling (DG-3), verdicts (DG-1) and the aggregator (DG-5)
 * build on the shapes exported here.
 */

import { createHash } from 'node:crypto';
import { type RunGit, defaultRunGit } from '../storage';

/** Wire/canonical schema version for manifests + input hashes. */
export const SHARD_SCHEMA_VERSION = 1;

/** Domain-separation tag hashed into every shard inputsHash. */
export const SHARD_INPUTS_HASH_DOMAIN = 'papercusp-pot-git-gate-shard-inputs-v1';

/** Root-level files (repo-relative) hashed into EVERY shard: they pin external
 *  dependency versions / the workspace graph itself for all workspaces. */
export const ROOT_INPUT_FILES: readonly string[] = ['package.json', 'package-lock.json'];

/** The test-config split a shard runs. */
export type ShardLayer = 'unit' | 'integration';

/** The npm script per layer (the affected-tests convention). */
export const LAYER_SCRIPTS: Record<ShardLayer, string> = {
  unit: 'test',
  integration: 'test:integration',
};

/** One workspace as the manifest needs it — the projection of its package.json. */
export interface WorkspaceMeta {
  /** package.json `name`. */
  name: string;
  /** Repo-relative directory (no trailing slash). */
  dir: string;
  /** Declared dependency NAMES (dependencies + devDependencies + peerDependencies). */
  deps: string[];
  /** Has a `test` script (unit layer). */
  hasUnit: boolean;
  /** Has a `test:integration` script (integration layer). */
  hasIntegration: boolean;
}

/** One runnable unit of the distributed gate. */
export interface ShardSpec {
  /** `<workspaceName>::<layer>` — unique, stable, human-scannable. */
  shardId: string;
  workspaceName: string;
  /** Repo-relative workspace directory. */
  workspaceDir: string;
  layer: ShardLayer;
  /** The npm script a runner executes (`npm run <script> --workspace <dir>`). */
  npmScript: string;
  /**
   * Repo-relative dirs whose content this shard depends on: the workspace's
   * own dir + every transitive workspace dependency's dir. Sorted.
   */
  inputDirs: string[];
}

export interface UnreadableWorkspace {
  /** Repo-relative path of the workspace (or the gitlink shielding it). */
  dir: string;
  reason: string;
}

export interface ShardManifest {
  v: number;
  /** All shards, sorted by shardId — deterministic for identical inputs. */
  shards: ShardSpec[];
  /** Root files hashed into every shard's inputsHash. */
  rootInputFiles: string[];
  /**
   * Workspaces that EXIST at the sha but could not be read (gitlink boundary
   * with no resolver). Loud by design — a gate that silently drops suites
   * reads as "covered everything" when it didn't.
   */
  unreadableWorkspaces: UnreadableWorkspace[];
}

export function shardId(workspaceName: string, layer: ShardLayer): string {
  return `${workspaceName}::${layer}`;
}

/**
 * PURE manifest construction from workspace metas. Deterministic: input order
 * never matters (everything is sorted); identical metas ⇒ byte-identical
 * manifest. Dep names that are not workspaces (external packages) are ignored
 * — they are pinned by the root lockfile, which is in every shard's inputs.
 */
export function buildShardManifest(
  workspaces: readonly WorkspaceMeta[],
  opts: { unreadableWorkspaces?: UnreadableWorkspace[] } = {},
): ShardManifest {
  const byName = new Map<string, WorkspaceMeta>();
  for (const ws of workspaces) byName.set(ws.name, ws);

  /** Transitive workspace-dep closure (own name included), cycle-safe. */
  const closureCache = new Map<string, Set<string>>();
  function closure(name: string): Set<string> {
    const cached = closureCache.get(name);
    if (cached) return cached;
    const seen = new Set<string>([name]);
    closureCache.set(name, seen); // pre-set so cycles terminate
    const queue = [name];
    while (queue.length) {
      const cur = byName.get(queue.shift()!);
      if (!cur) continue;
      for (const dep of cur.deps) {
        if (!byName.has(dep) || seen.has(dep)) continue;
        seen.add(dep);
        queue.push(dep);
      }
    }
    return seen;
  }

  const shards: ShardSpec[] = [];
  for (const ws of workspaces) {
    const inputDirs = [...closure(ws.name)]
      .map((n) => byName.get(n)!.dir)
      .sort();
    const layers: ShardLayer[] = [];
    if (ws.hasUnit) layers.push('unit');
    if (ws.hasIntegration) layers.push('integration');
    for (const layer of layers) {
      shards.push({
        shardId: shardId(ws.name, layer),
        workspaceName: ws.name,
        workspaceDir: ws.dir,
        layer,
        npmScript: LAYER_SCRIPTS[layer],
        inputDirs,
      });
    }
  }
  shards.sort((a, b) => a.shardId.localeCompare(b.shardId));

  return {
    v: SHARD_SCHEMA_VERSION,
    shards,
    rootInputFiles: [...ROOT_INPUT_FILES],
    unreadableWorkspaces: [...(opts.unreadableWorkspaces ?? [])].sort((a, b) =>
      a.dir.localeCompare(b.dir),
    ),
  };
}

/* ------------------------------------------------------------------------ *
 * Tree-based discovery (hermetic: reads the COMMITTED tree at `sha`)
 * ------------------------------------------------------------------------ */

/**
 * Resolve a gitlink to a repo that HOLDS that submodule's objects (e.g. the
 * checked-out submodule dir on a machine with a working tree). Return null
 * when unavailable — the workspace is then reported unreadable, not dropped.
 */
export type SubmoduleRepoResolver = (
  gitlinkPath: string,
  gitlinkOid: string,
) => Promise<{ repoPath: string } | null>;

async function gitShow(repoPath: string, sha: string, path: string, runGit: RunGit): Promise<string | null> {
  const r = await runGit(['show', `${sha}:${path}`], repoPath);
  return r.code === 0 ? r.stdout : null;
}

interface TreeEntry {
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  oid: string;
  name: string;
}

async function lsTree(repoPath: string, sha: string, path: string, runGit: RunGit): Promise<TreeEntry[]> {
  const spec = path ? `${sha}:${path}` : sha;
  const r = await runGit(['ls-tree', spec], repoPath);
  if (r.code !== 0) return [];
  const out: TreeEntry[] = [];
  for (const line of r.stdout.split('\n')) {
    // <mode> SP <type> SP <oid> TAB <name>
    const m = line.match(/^(\d{6}) (blob|tree|commit) ([0-9a-f]+)\t(.+)$/);
    if (m) out.push({ mode: m[1], type: m[2] as TreeEntry['type'], oid: m[3], name: m[4] });
  }
  return out;
}

interface PkgJson {
  name?: string;
  workspaces?: string[];
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function parsePkg(raw: string | null): PkgJson | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' ? (v as PkgJson) : null;
  } catch {
    return null;
  }
}

function metaFromPkg(dir: string, pkg: PkgJson): WorkspaceMeta | null {
  if (!pkg.name) return null;
  const scripts = pkg.scripts ?? {};
  return {
    name: pkg.name,
    dir,
    deps: Object.keys({
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
      ...(pkg.peerDependencies ?? {}),
    }),
    hasUnit: typeof scripts.test === 'string',
    hasIntegration: typeof scripts['test:integration'] === 'string',
  };
}

export interface DiscoveredWorkspaces {
  workspaces: WorkspaceMeta[];
  unreadableWorkspaces: UnreadableWorkspace[];
}

/**
 * Enumerate the workspaces of the repo AT `sha` — the root package.json's
 * `workspaces` patterns expanded against the committed tree (never the working
 * tree). A workspace behind a gitlink is read through `submoduleResolver` when
 * provided (recursing with the gitlink's pinned commit), else reported in
 * `unreadableWorkspaces`. Fail-soft: a missing/garbled package.json is skipped
 * (a dir without one is simply not a workspace, matching affected-tests).
 */
export async function discoverWorkspacesAtSha(
  repoPath: string,
  sha: string,
  runGit: RunGit = defaultRunGit,
  submoduleResolver?: SubmoduleRepoResolver,
): Promise<DiscoveredWorkspaces> {
  const root = parsePkg(await gitShow(repoPath, sha, 'package.json', runGit));
  const patterns = Array.isArray(root?.workspaces) ? root.workspaces : [];
  const workspaces: WorkspaceMeta[] = [];
  const unreadable: UnreadableWorkspace[] = [];

  /** Read one candidate workspace dir (repo-relative in the SUPERPROJECT). */
  async function readWorkspace(dir: string): Promise<void> {
    const raw = await gitShow(repoPath, sha, `${dir}/package.json`, runGit);
    if (raw !== null) {
      const meta = metaFromPkg(dir, parsePkg(raw) ?? {});
      if (meta) workspaces.push(meta);
      return;
    }
    // Unreadable — a gitlink on the path? Walk up to the nearest resolvable
    // ancestor; if it is a commit (gitlink), try the resolver / report.
    const anc = await resolveNearestAncestorOid(repoPath, sha, dir, runGit);
    if (anc && anc.isGitlink) {
      if (submoduleResolver) {
        const sub = await submoduleResolver(anc.path, anc.oid);
        if (sub) {
          const rel = dir === anc.path ? '' : dir.slice(anc.path.length + 1);
          const subRaw = await gitShow(sub.repoPath, anc.oid, rel ? `${rel}/package.json` : 'package.json', runGit);
          const meta = subRaw !== null ? metaFromPkg(dir, parsePkg(subRaw) ?? {}) : null;
          if (meta) {
            workspaces.push(meta);
            return;
          }
        }
      }
      unreadable.push({ dir, reason: `behind gitlink ${anc.path}@${anc.oid} (no submodule resolver)` });
    }
    // else: not a workspace at this sha (no package.json) — skip silently,
    // exactly like affected-tests' existsSync check.
  }

  for (const p of patterns) {
    if (p.includes('*')) {
      const base = p.replace(/\/\*$/, '');
      const entries = await lsTree(repoPath, sha, base, runGit);
      for (const e of entries) {
        if (e.type === 'tree' || e.type === 'commit') await readWorkspace(`${base}/${e.name}`);
      }
    } else {
      await readWorkspace(p);
    }
  }

  // Deterministic output independent of pattern order.
  workspaces.sort((a, b) => a.dir.localeCompare(b.dir));
  unreadable.sort((a, b) => a.dir.localeCompare(b.dir));
  return { workspaces, unreadableWorkspaces: unreadable };
}

/* ------------------------------------------------------------------------ *
 * Input hashing
 * ------------------------------------------------------------------------ */

interface AncestorOid {
  /** The path that actually resolved. */
  path: string;
  oid: string;
  /** True when the resolved object is a commit (a gitlink pointer). */
  isGitlink: boolean;
}

/**
 * OID of `<sha>:<path>`, or of the nearest resolvable ANCESTOR when the path
 * crosses a gitlink boundary (the ancestor's commit OID pins the whole
 * submodule — coarse but change-complete). Null when nothing on the path
 * exists at the sha.
 */
async function resolveNearestAncestorOid(
  repoPath: string,
  sha: string,
  path: string,
  runGit: RunGit,
): Promise<AncestorOid | null> {
  let probe = path;
  for (;;) {
    const r = await runGit(['rev-parse', '-q', '--verify', `${sha}:${probe}`], repoPath);
    const oid = r.stdout.trim();
    if (r.code === 0 && oid) {
      // The hit can be the gitlink ITSELF (the workspace dir is the submodule
      // root) or an ancestor shielding an inner path — check the type either
      // way. NOTE: `cat-file -t` on a gitlink OID whose commit object is absent
      // from this ODB (the normal superproject case) fails — that failure IS
      // the gitlink signal, since a resolvable tree/blob is always present.
      const t = await runGit(['cat-file', '-t', oid], repoPath);
      const isGitlink = t.code !== 0 || t.stdout.trim() === 'commit';
      return { path: probe, oid, isGitlink };
    }
    const cut = probe.lastIndexOf('/');
    if (cut <= 0) return null;
    probe = probe.slice(0, cut);
  }
}

/** A directory that resolved to nothing at the sha hashes as this marker —
 *  absence is an input state too (a dir APPEARING must change the hash). */
const ABSENT = 'absent';

/**
 * The shard's input hash at `sha` — sha256 over a domain-tagged canonical
 * string of `<path>=<oid>` lines: every input dir's tree OID (or enclosing
 * gitlink commit OID) plus the root input files' blob OIDs. Deterministic from
 * `(sha, shard)`; equal across shas whose trees agree on the inputs; changes
 * iff an input's OID changes. Never throws — a missing dir hashes as absent.
 */
export async function shardInputsHash(
  repoPath: string,
  sha: string,
  shard: Pick<ShardSpec, 'shardId' | 'inputDirs'>,
  runGit: RunGit = defaultRunGit,
  rootInputFiles: readonly string[] = ROOT_INPUT_FILES,
): Promise<string> {
  const lines: string[] = [];
  const paths = [...new Set([...shard.inputDirs, ...rootInputFiles])].sort();
  for (const p of paths) {
    const resolved = await resolveNearestAncestorOid(repoPath, sha, p, runGit);
    lines.push(`${p}=${resolved ? resolved.oid : ABSENT}`);
  }
  const canonical = `${SHARD_INPUTS_HASH_DOMAIN}\n${shard.shardId}\n${lines.join('\n')}`;
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Convenience: manifest + per-shard input hashes at one sha — what a runner /
 * the aggregator (DG-5) needs to decide which shards are stale for `sha`.
 */
export async function buildShardManifestAtSha(
  repoPath: string,
  sha: string,
  runGit: RunGit = defaultRunGit,
  submoduleResolver?: SubmoduleRepoResolver,
): Promise<{ manifest: ShardManifest; inputsHashByShardId: Record<string, string> }> {
  const { workspaces, unreadableWorkspaces } = await discoverWorkspacesAtSha(
    repoPath,
    sha,
    runGit,
    submoduleResolver,
  );
  const manifest = buildShardManifest(workspaces, { unreadableWorkspaces });
  const inputsHashByShardId: Record<string, string> = {};
  for (const shard of manifest.shards) {
    inputsHashByShardId[shard.shardId] = await shardInputsHash(
      repoPath,
      sha,
      shard,
      runGit,
      manifest.rootInputFiles,
    );
  }
  return { manifest, inputsHashByShardId };
}
