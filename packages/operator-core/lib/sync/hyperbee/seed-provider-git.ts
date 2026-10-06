/**
 * seed-provider-git — the git SeedProvider (plan hive-seed-bundle-2026-07-04 P-004;
 * design memo agent-insights/hive-seed-bundle-design).
 *
 * Carries the CODE (the dogfood superproject + its submodules) as `git bundle`s —
 * git's native, content-addressed checkpoint. A fresh install clones from the
 * bundle OFFLINE (pre-positioning the history), re-points `origin` at GitHub, and
 * a subsequent `git fetch` transfers only the delta objects. Auth continues to
 * flow through the user's `gh` credential helper exactly as clone-github.ts
 * documents — this provider never touches tokens.
 *
 * The seed payload is a DIRECTORY holding: `super.bundle`, `submodules/<name>.bundle`
 * for each submodule, and `index.json` mapping bundles → repo-relative paths + origin
 * URLs. `verify` gates on a content hash (the deep git object verification happens
 * natively when `restore`'s clone rejects a corrupt bundle → the restore outcome
 * carries the reason and the host cold-paths git).
 *
 * NOTE: the walkFiles/hashDir/dirSize helpers mirror seed-provider-corestore.ts;
 * a future cleanup can lift them into a shared seed-fs util.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  sealFile,
  openFile,
  SEED_CIPHER,
  type SeedProvider,
  type SeedStoreEntry,
  type SeedCutContext,
  type SeedCutOutput,
  type SeedRestoreContext,
  type SeedPayload,
  type SeedKeyRef,
  type VerifyResult,
} from '@papercusp/seed-bundle';

export const GIT_SEED_KIND = 'git';

/** Max stdout for a git call (bundle listings etc. stay small; blobs go to files). */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

const execFileP = promisify(execFile);

/** Local-file submodule bundles require this on modern git (file protocol is
 *  disabled for submodules by default for security). We only ever point at
 *  bundle files we just wrote, so enabling it for these calls is safe. */
const ALLOW_FILE = ['-c', 'protocol.file.allow=always'];

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileP('git', args, { cwd, env: env ? { ...process.env, ...env } : process.env, maxBuffer: GIT_MAX_BUFFER });
  return stdout.trim();
}

/** Context for {@link createGitSeedProvider}.cut (build/release time). */
export interface GitCutContext {
  /** The source working tree to cut from (the owner's checkout). */
  readonly sourceRepoDir: string;
  /** Directory the bundles are written into — becomes the payload. */
  readonly stagingDir: string;
  /** The canonical origin URL a restored clone should point at (e.g. the GitHub repo). */
  readonly originUrl: string;
  /** `git bundle create` revision selector; default `--all`. Pass `HEAD` to
   *  bundle a single branch's history (smaller than every ref).
   *  ⚠ The bundle is ALWAYS self-contained: it carries the full history reachable
   *  from the selector so a fresh install can `git clone` it OFFLINE. A shallow /
   *  partial bundle is NOT an option — git records omitted commits as
   *  prerequisites, and a clone from a bundle with prerequisites fails ("remote
   *  did not send all necessary objects"). Seed size is therefore dominated by the
   *  tracked TREE, not history depth; shrink it by not tracking scratch/build
   *  cruft. To ship only the current tree snapshot, pair a single commit-ish
   *  `rev` with `depth: 1`; the provider creates an offline-cloneable synthetic
   *  one-commit bundle. */
  readonly rev?: string;
  /** `1` cuts a synthetic one-commit snapshot of `rev` (and its pinned
   *  submodules) instead of the full reachable history. Other depths are refused:
   *  native git shallow/prerequisite bundles cannot be cloned offline. */
  readonly depth?: number;
  /** Encrypt the bundle bytes at rest (required for a PRIVATE repo shipped in a
   *  public installer). The key is delivered to the joiner only post-admission
   *  (via `keyRef`); it is NEVER in the installer. */
  readonly encryption?: { readonly key: Uint8Array; readonly keyRef: SeedKeyRef };
}

/** Context for {@link createGitSeedProvider}.restore (first-boot time). */
export interface GitRestoreContext {
  /** The fresh install's target checkout dir (must not already exist). */
  readonly targetRepoDir: string;
  /** Override the origin URL recorded in the seed (else the seed's own). */
  readonly originUrl?: string;
  /** The decryption key (resolved post-admission). REQUIRED iff the seed was cut
   *  with encryption; restore throws if the seed is encrypted and this is absent. */
  readonly decryptionKey?: Uint8Array;
}

interface GitSeedSubmodule {
  readonly path: string;
  readonly url: string;
  readonly bundle: string;
}
interface GitSeedIndex {
  readonly super: string;
  readonly originUrl: string;
  readonly submodules: GitSeedSubmodule[];
  /** True ⇒ every bundle file is encrypted at rest (decrypt before clone). */
  readonly encrypted: boolean;
  /** Advertised ref for a pinned full-history bundle (not necessarily HEAD). */
  readonly branch?: string;
  /** Present when bundles contain synthetic one-commit snapshots. */
  readonly snapshot?: { readonly depth: 1; readonly branch: string };
}

async function walkFiles(root: string, dir: string = root, acc: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await walkFiles(root, full, acc);
    else if (e.isFile()) acc.push(relative(root, full));
  }
  return acc;
}

async function hashDir(root: string): Promise<string> {
  const h = createHash('sha256');
  const rels = (await walkFiles(root)).sort();
  for (const rel of rels) {
    h.update(rel + '\0');
    for await (const chunk of createReadStream(join(root, rel))) h.update(chunk as Buffer);
  }
  return h.digest('hex');
}

async function dirSize(root: string): Promise<number> {
  let total = 0;
  for (const rel of await walkFiles(root)) total += (await stat(join(root, rel))).size;
  return total;
}

/** Enumerate submodules from the selected commit's `.gitmodules` and gitlinks.
 *  SKIPS any submodule whose working tree is not checked out (no `<path>/.git`):
 *  `.gitmodules` can declare a submodule the source tree never initialized — e.g. a
 *  RETIRED one (`libs/zero-harness`) — and blindly `git bundle`-ing in a nonexistent
 *  cwd throws `spawn git ENOENT`, aborting the whole cut. An uninitialized submodule
 *  simply isn't seeded (a fresh member cold-clones it); data-safe by construction. */
async function readSubmodules(repoDir: string, rev: string): Promise<Array<{ name: string; path: string; url: string; commit: string }>> {
  if (!(await git(repoDir, ['ls-tree', rev, '--', '.gitmodules']))) return [];
  const config = ['config', '--blob', `${rev}:.gitmodules`];
  const pathLines = await git(repoDir, [...config, '-z', '--get-regexp', '^submodule[.].*[.]path$']).catch((error) => {
    if (error.code === 1) return ''; // a valid config with no submodule paths
    throw error;
  });
  const out: Array<{ name: string; path: string; url: string; commit: string }> = [];
  for (const line of pathLines.split('\0').filter(Boolean)) {
    const split = line.indexOf('\n');
    const key = line.slice(0, split);
    const p = line.slice(split + 1);
    const name = key.slice('submodule.'.length, -'.path'.length);
    // A checked-out submodule has a `.git` gitlink (file) or dir at its path; an
    // uninitialized/retired one has a missing or empty dir → skip it (with a warning)
    // rather than spawn git in a cwd that doesn't exist.
    if (!existsSync(join(repoDir, p, '.git'))) {
      console.warn(`[seed:git] skipping submodule '${name}' (${p}) — not checked out in ${repoDir}; a fresh member will cold-clone it.`);
      continue;
    }
    const url = await git(repoDir, [...config, `submodule.${name}.url`]);
    const gitlink = await git(repoDir, ['ls-tree', '-z', rev, '--', `:(literal)${p}`]);
    const match = /^160000 commit ([0-9a-f]+)\t/.exec(gitlink);
    if (!match) throw new Error(`git seed submodule '${p}' has no gitlink at ${rev}`);
    out.push({ name, path: p, url, commit: match[1] });
  }
  return out;
}

function normalizeDepth(depth: unknown): 1 | undefined {
  if (depth === undefined || depth === null) return undefined;
  if (depth !== 1) {
    throw new Error(`git seed depth currently supports only depth=1 snapshots; got ${String(depth)}`);
  }
  return 1;
}

async function snapshotCommit(
  repoDir: string,
  rev: string,
  stagingDir: string,
  submoduleCommits: Map<string, string> = new Map(),
): Promise<string> {
  // Use an isolated index so we can rewrite submodule gitlinks to synthetic
  // snapshot commits without touching the source checkout or its real index.
  const indexFile = join(stagingDir, `.snapshot-index-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    await git(repoDir, ['rev-parse', '--verify', `${rev}^{tree}`]);
    await git(repoDir, ['read-tree', `${rev}^{tree}`], env);
    for (const [path, commit] of submoduleCommits) {
      await git(repoDir, ['update-index', '--cacheinfo', '160000', commit, path], env);
    }
    const tree = await git(repoDir, ['write-tree'], env);
    return await git(repoDir, ['commit-tree', tree, '-m', `papercusp seed snapshot ${rev}`], env);
  } finally {
    await rm(indexFile, { force: true }).catch(() => {});
  }
}

async function bundleCommit(repoDir: string, bundlePath: string, commit: string, branch: string): Promise<void> {
  // `git bundle create <raw-sha>` refuses to advertise a ref, so a fresh clone
  // cannot check it out. Publish the snapshot through a transient branch ref
  // while writing the bundle, then remove the ref immediately.
  const ref = `refs/heads/${branch}`;
  try {
    await git(repoDir, ['update-ref', ref, commit]);
    await git(repoDir, ['bundle', 'create', bundlePath, ref]);
  } finally {
    await git(repoDir, ['update-ref', '-d', ref]).catch(() => {});
  }
}

export function createGitSeedProvider(): SeedProvider {
  return {
    kind: GIT_SEED_KIND,

    async cut(ctx: SeedCutContext): Promise<SeedCutOutput> {
      const { sourceRepoDir, stagingDir, originUrl, rev, depth: rawDepth, encryption } = ctx as unknown as GitCutContext;
      const depth = normalizeDepth(rawDepth);
      await mkdir(join(stagingDir, 'submodules'), { recursive: true });
      const revSel = rev ?? '--all';
      if (depth && revSel === '--all') {
        throw new Error('git seed depth requires a single commit-ish --rev; --all cannot be depth-limited');
      }
      const snapshotBranch = depth ? `papercusp-seed-snapshot-${randomUUID()}` : undefined;
      // Resolve once so moving refs cannot produce a mixed-revision seed. A
      // parent's SHA has no meaning in a child's independent object database.
      const selectedCommit = await git(sourceRepoDir, ['rev-parse', '--verify', `${revSel === '--all' ? 'HEAD' : revSel}^{commit}`]);
      const bundleBranch = snapshotBranch ?? `papercusp-seed-${randomUUID()}`;

      const submodules: GitSeedSubmodule[] = [];
      const submoduleCommits = new Map<string, string>();
      for (const sub of await readSubmodules(sourceRepoDir, selectedCommit)) {
        const bundleRel = join('submodules', sub.name.replace(/[/\\]/g, '__') + '.bundle');
        const subRepo = join(sourceRepoDir, sub.path);
        if (depth) {
          const commit = await snapshotCommit(subRepo, sub.commit, stagingDir);
          await bundleCommit(subRepo, join(stagingDir, bundleRel), commit, snapshotBranch!);
          submoduleCommits.set(sub.path, commit);
        } else if (revSel === '--all') {
          await git(subRepo, ['bundle', 'create', join(stagingDir, bundleRel), revSel]);
        } else {
          await bundleCommit(subRepo, join(stagingDir, bundleRel), sub.commit, bundleBranch);
        }
        submodules.push({ path: sub.path, url: sub.url, bundle: bundleRel });
      }
      if (depth) {
        const commit = await snapshotCommit(sourceRepoDir, selectedCommit, stagingDir, submoduleCommits);
        await bundleCommit(sourceRepoDir, join(stagingDir, 'super.bundle'), commit, snapshotBranch!);
      } else if (revSel === '--all') {
        await git(sourceRepoDir, ['bundle', 'create', join(stagingDir, 'super.bundle'), revSel]);
      } else {
        await bundleCommit(sourceRepoDir, join(stagingDir, 'super.bundle'), selectedCommit, bundleBranch);
      }

      // Encrypt every bundle file in place (the CODE is the secret). index.json
      // stays plaintext — it holds only bundle filenames + the public origin URL.
      const bundleRels = ['super.bundle', ...submodules.map((s) => s.bundle)];
      if (encryption) {
        for (const rel of bundleRels) {
          const p = join(stagingDir, rel);
          await sealFile(encryption.key, p, p);
        }
      }

      const index: GitSeedIndex = {
        super: 'super.bundle',
        originUrl,
        submodules,
        encrypted: Boolean(encryption),
        ...(!depth && revSel !== '--all' ? { branch: bundleBranch } : {}),
        ...(depth ? { snapshot: { depth, branch: snapshotBranch! } } : {}),
      };
      await writeFile(join(stagingDir, 'index.json'), JSON.stringify(index, null, 2));

      const hash = await hashDir(stagingDir);
      const sizeBytes = await dirSize(stagingDir);
      const entry: SeedStoreEntry = {
        kind: GIT_SEED_KIND,
        hash,
        sizeBytes,
        source: { type: 'resource', path: stagingDir },
        ...(encryption ? { encryption: { scheme: SEED_CIPHER, keyRef: encryption.keyRef } } : {}),
        meta: { originUrl, submodulePaths: submodules.map((s) => s.path), encrypted: Boolean(encryption), ...(depth ? { depth } : {}) },
      };
      return { entry, payload: { path: stagingDir } };
    },

    async verify(entry: SeedStoreEntry, payload: SeedPayload): Promise<VerifyResult> {
      const path = (payload as { path?: string })?.path;
      if (!path || !existsSync(path)) return { ok: false, reason: `payload path missing: ${String(path)}` };
      if (!existsSync(join(path, 'index.json')) || !existsSync(join(path, 'super.bundle'))) {
        return { ok: false, reason: 'seed missing index.json or super.bundle' };
      }
      const hash = await hashDir(path);
      if (hash !== entry.hash) {
        return { ok: false, reason: `hash mismatch (expected ${entry.hash.slice(0, 12)}…, got ${hash.slice(0, 12)}…)` };
      }
      return { ok: true };
    },

    async restore(entry: SeedStoreEntry, payload: SeedPayload, ctx: SeedRestoreContext): Promise<void> {
      const { targetRepoDir, originUrl: originOverride, decryptionKey } = ctx as unknown as GitRestoreContext;
      const seedPath = (payload as { path: string }).path;
      const index = JSON.parse(await readFile(join(seedPath, 'index.json'), 'utf8')) as GitSeedIndex;
      const origin = originOverride ?? index.originUrl;
      const checkoutBranch = index.snapshot?.branch ?? index.branch;

      if (index.encrypted && !decryptionKey) {
        throw new Error('git seed is encrypted but no decryption key was provided (resolve it post-admission)');
      }

      // Decrypt a bundle to a plaintext temp path OUTSIDE the seed dir (or return
      // it as-is when unencrypted). git can only clone from a plaintext bundle.
      // ⚠ Never write into the seed dir itself: on a packaged install it is a
      // root-owned read-only resource (/usr/lib/<Product>/seed — every offline
      // restore EACCES'd there, WI-5179), and a private repo's plaintext must not
      // persist at rest next to the installer payload anyway.
      const decryptDir = index.encrypted ? await mkdtemp(join(tmpdir(), 'papercusp-seed-git-')) : null;
      const materialize = async (bundleRel: string): Promise<string> => {
        const sealedPath = join(seedPath, bundleRel);
        if (!decryptDir) return sealedPath;
        const outPath = join(decryptDir, bundleRel);
        await mkdir(dirname(outPath), { recursive: true });
        await openFile(decryptionKey!, sealedPath, outPath);
        return outPath;
      };

      try {
        // Clone the superproject from its bundle (offline), then re-point origin.
        await execFileP('git', [...ALLOW_FILE, 'clone', ...(checkoutBranch ? ['--branch', checkoutBranch] : []), await materialize(index.super), targetRepoDir], {
          maxBuffer: GIT_MAX_BUFFER,
        });
        if (checkoutBranch) await git(targetRepoDir, ['branch', '-M', 'main']);
        if (origin) await git(targetRepoDir, ['remote', 'set-url', 'origin', origin]);

        // Restore each submodule from its bundle into the submodule working path.
        for (const sub of index.submodules) {
          const subTarget = join(targetRepoDir, sub.path);
          await execFileP('git', [...ALLOW_FILE, 'clone', ...(checkoutBranch ? ['--branch', checkoutBranch] : []), await materialize(sub.bundle), subTarget], {
            maxBuffer: GIT_MAX_BUFFER,
          });
          if (checkoutBranch) await git(subTarget, ['branch', '-M', 'main']);
          if (sub.url) await git(subTarget, ['remote', 'set-url', 'origin', sub.url]);
        }
      } finally {
        if (decryptDir) await rm(decryptDir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}
