/**
 * runRelease — the orchestrator. Wires the pure core + drivers + gh over the
 * injected ports. This is the generic equivalent of bin/release-local.sh's body:
 *   validate → bump versions → buildSidecar → build targets → collect sigs →
 *   write latest.json → git commit/tag/push → gh release.
 * Every step is a port call, so the whole thing is testable with in-memory fakes.
 */
import type {
  Artifact,
  LatestManifest,
  ReleasePorts,
  TargetKey,
  TauriReleaseConfig,
} from './types.js';
import { assertValidChannel, assertValidVersion, defaultTagFor } from './tag.js';
import { applyVersionBump } from './version.js';
import { resolveTargetDriver } from './registry.js';
import { buildLatestManifest, type ManifestArtifact } from './latest-json.js';
import { publishRelease } from './gh.js';
import { joinPath } from './path.js';

/**
 * Build + sign every target in `targets`. Factored out of `runRelease` so
 * `runIncrementalPublish` (incremental-publish.ts) can build just ONE
 * platform's artifacts through the exact same path — no drift between a full
 * multi-target cut and a single-platform incremental one.
 */
export async function buildAndSignTargets(
  cfg: TauriReleaseConfig,
  ports: ReleasePorts,
  targets: TargetKey[],
): Promise<{ artifacts: Artifact[]; signed: ManifestArtifact[] }> {
  const artifacts: Artifact[] = [];
  for (const t of targets) {
    const driver = resolveTargetDriver(t);
    ports.log.info(`building target ${t}`);
    artifacts.push(...(await driver.build(cfg, ports)));
  }
  if (artifacts.length === 0) ports.log.warn('no artifacts produced');

  const signed: ManifestArtifact[] = [];
  for (const a of artifacts) {
    if (!a.platformKey) continue;
    let signature = '';
    if (a.sigPath && (await ports.fs.exists(a.sigPath))) {
      signature = (await ports.fs.readText(a.sigPath)).trim();
    } else {
      ports.log.warn(`no signature for ${a.name} (${a.platformKey})`);
    }
    signed.push({ name: a.name, platformKey: a.platformKey, signature });
  }
  return { artifacts, signed };
}

export interface RunReleaseOptions {
  /** Skip git commit/tag/push (e.g. a parity dry-run). Default false. */
  skipGit?: boolean;
  /** Skip the gh release publish. Default false. */
  skipPublish?: boolean;
  /** Where to write latest.json (default <root>/latest.json). */
  latestJsonPath?: string;
  /** Release-notes file path passed to `gh release create`. */
  notesFile?: string;
}

export interface RunReleaseResult {
  tag: string;
  artifacts: Artifact[];
  manifest: LatestManifest;
  latestJsonPath: string;
  published?: { action: 'created' | 'uploaded' };
}

export async function runRelease(
  cfg: TauriReleaseConfig,
  ports: ReleasePorts,
  opts: RunReleaseOptions = {},
): Promise<RunReleaseResult> {
  assertValidVersion(cfg.version);
  assertValidChannel(cfg.channel);
  const tagFor = cfg.tagFor ?? defaultTagFor;
  const tag = tagFor(cfg.version, cfg.channel);
  ports.log.info(`release ${cfg.appName} ${cfg.version} (${cfg.channel}) — tag ${tag}`);

  // 1. version bump
  for (const vf of cfg.versionFiles) {
    const p = joinPath(cfg.root, vf.path);
    if (!(await ports.fs.exists(p))) {
      ports.log.warn(`version file missing, skipped: ${vf.path}`);
      continue;
    }
    const text = await ports.fs.readText(p);
    await ports.fs.writeText(p, applyVersionBump(vf, text, cfg.version));
    ports.log.info(`  bumped ${vf.path} → ${cfg.version}`);
  }

  // 2. sidecar (the injected per-app seam)
  await cfg.buildSidecar({
    root: cfg.root,
    version: cfg.version,
    channel: cfg.channel,
    ports,
  });

  // 3. build each target + 4. read signatures for updater targets
  const { artifacts, signed } = await buildAndSignTargets(cfg, ports, cfg.targets);

  // 5. latest.json updater manifest
  const manifest = buildLatestManifest({
    version: cfg.version,
    channel: cfg.channel,
    tag,
    artifacts: signed,
    urlFor: cfg.latestJsonUrl,
    pubDate: ports.now(),
    appName: cfg.appName,
  });
  const latestJsonPath = opts.latestJsonPath ?? joinPath(cfg.root, 'latest.json');
  await ports.fs.writeText(latestJsonPath, JSON.stringify(manifest, null, 2) + '\n');

  // 6. git commit/tag/push (the desktop repo, not this monorepo)
  if (!opts.skipGit) {
    await gitCommitTagPush(ports, cfg, tag);
  }

  // 7. publish to GitHub releases
  const assets = [latestJsonPath];
  for (const a of artifacts) {
    assets.push(a.path);
    if (a.sigPath && (await ports.fs.exists(a.sigPath))) assets.push(a.sigPath);
  }
  let published: { action: 'created' | 'uploaded' } | undefined;
  if (!opts.skipPublish) {
    published = await publishRelease(ports, {
      tag,
      repo: cfg.repo,
      title: `${cfg.appName} ${cfg.version} (${cfg.channel})`,
      notesFile: opts.notesFile,
      channel: cfg.channel,
      assets,
    });
  }

  return { tag, artifacts, manifest, latestJsonPath, published };
}

async function gitCommitTagPush(
  ports: ReleasePorts,
  cfg: TauriReleaseConfig,
  tag: string,
): Promise<void> {
  const addPaths = new Set<string>(cfg.versionFiles.map((v) => v.path));
  // a Cargo.toml bump also dirties the sibling Cargo.lock
  for (const v of cfg.versionFiles) {
    if (v.kind === 'cargo-toml') {
      addPaths.add(v.path.replace(/Cargo\.toml$/, 'Cargo.lock'));
    }
  }
  await ports.exec.run('git', ['-C', cfg.root, 'add', ...addPaths]);
  const commit = await ports.exec.run('git', ['-C', cfg.root, 'commit', '-m', `release: ${tag}`]);
  if (commit.code !== 0) {
    ports.log.warn(`git commit: ${commit.stderr || commit.stdout || '(nothing to commit)'}`);
  }
  const tagged = await ports.exec.run('git', ['-C', cfg.root, 'tag', '-f', tag]);
  if (tagged.code !== 0) throw new Error(`git tag failed: ${tagged.stderr || tagged.stdout}`);

  // Push to an EXPLICIT destination ref, never a bare `HEAD`. A release cut
  // routinely runs in an ephemeral clone checked out at a pinned sha, where
  // HEAD is DETACHED — and `git push origin HEAD` cannot derive a destination
  // branch from a detached HEAD, so the version-bump commit reaches no branch
  // in the canonical repo and dies with the throwaway clone. That is exactly
  // how desktop 0.0.18 shipped while every canonical versionFile stayed on
  // 0.0.17 and no source build could ever report the shipped version.
  const branchProbe = await ports.exec.run('git', [
    '-C',
    cfg.root,
    'symbolic-ref',
    '--quiet',
    '--short',
    'HEAD',
  ]);
  const branch =
    (branchProbe.code === 0 ? branchProbe.stdout.trim() : '') || cfg.releaseBranch || 'main';
  const push = await ports.exec.run('git', [
    '-C',
    cfg.root,
    'push',
    'origin',
    `HEAD:refs/heads/${branch}`,
    `refs/tags/${tag}`,
  ]);
  if (push.code !== 0) throw new Error(`git push failed: ${push.stderr || push.stdout}`);

  await assertPushLanded(ports, cfg, tag, branch);
}

/**
 * Recurrence guard for the lost-version-bump class: a push reporting success is
 * not proof the canonical repo received it. Re-read the REMOTE and require the
 * release tag to resolve there to exactly the commit just made, on a real
 * branch. Without this the loss is invisible until a release later, when every
 * source build still reports the previous version.
 */
async function assertPushLanded(
  ports: ReleasePorts,
  cfg: TauriReleaseConfig,
  tag: string,
  branch: string,
): Promise<void> {
  const head = await ports.exec.run('git', ['-C', cfg.root, 'rev-parse', 'HEAD']);
  const localSha = head.stdout.trim();
  if (head.code !== 0 || !localSha) {
    throw new Error(
      `release push verification failed: cannot resolve local HEAD (${head.stderr || head.stdout})`,
    );
  }
  const ls = await ports.exec.run('git', [
    '-C',
    cfg.root,
    'ls-remote',
    'origin',
    `refs/heads/${branch}`,
    `refs/tags/${tag}`,
  ]);
  if (ls.code !== 0) {
    throw new Error(
      `release push verification failed: git ls-remote origin errored (${ls.stderr || ls.stdout})`,
    );
  }
  const refs = new Map<string, string>();
  for (const line of ls.stdout.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (sha && ref) refs.set(ref, sha);
  }
  const remoteTag = refs.get(`refs/tags/${tag}`) ?? refs.get(`refs/tags/${tag}^{}`);
  if (!remoteTag) {
    throw new Error(
      `release push verification failed: refs/tags/${tag} is absent from origin after the push — ` +
        `the version bump never reached the canonical repo, so every source build will keep ` +
        `reporting the previous version`,
    );
  }
  if (remoteTag !== localSha) {
    throw new Error(
      `release push verification failed: origin refs/tags/${tag} is ${remoteTag}, ` +
        `expected the release commit ${localSha}`,
    );
  }
  if (!refs.has(`refs/heads/${branch}`)) {
    throw new Error(
      `release push verification failed: origin has no refs/heads/${branch} after the push — ` +
        `the release commit is not on any branch`,
    );
  }
  ports.log.info(`  push verified on origin: ${branch} + ${tag} → ${localSha.slice(0, 12)}`);
}
