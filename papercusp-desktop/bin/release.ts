#!/usr/bin/env -S npx tsx
/**
 * Papercusp desktop release CLI — kit-driven (ADDITIVE; runs alongside
 * bin/release-local.sh until Linux parity is signed off).
 *
 *   npx tsx bin/release.ts <version> <channel> [flags]
 *   flags: --plan        print the resolved plan + exit (no build/git/publish)
 *          --with-arm64  also build linux-aarch64 (needs `cross`)
 *          --with-windows  also build windows-x86_64 (VM :2223, owner-gated)
 *          --with-mac    also build macos-universal (VM :2222, owner-gated)
 *          --push-git      OPT-IN: commit/tag/push the version bump (default: skipped)
 *          --publish-github  OPT-IN: create/upload a GitHub release (default: skipped)
 *          --skip-git    (compat no-op — git push is already opt-in by default)
 *          --skip-publish  (compat no-op — GitHub publish is already opt-in by default)
 *
 * ⛔ EI-21871728567327302: releases are LOCAL-only (owner directive 2026-07-08 —
 * "we are no longer using GitHub for our releases, build the installer locally
 * and I'll upload it", the same directive release:cut enforces with
 * PAPERCUSP_PUBLISH_GITHUB=0). Unlike release:cut's `resolveCutRoot`, this CLI
 * has no operator role-gate and no dry-run-by-default write path, so it must
 * make LOCAL-only the DEFAULT rather than an opt-out — a caller who forgets a
 * flag must never end up pushing a tag or creating a GitHub Release. Pass
 * --push-git / --publish-github explicitly to opt back in.
 *
 * ⛔ Also refuses to run from an auto-managed shared checkout (papercusp/
 * papercup and its release/checkpoint/staging siblings) — see
 * `refuseIfAutoManagedRoot` below. `cfg.root` here is wherever this script's
 * own file lives on disk; run from the canonical superproject's
 * papercusp-desktop/ submodule (the common case), this build DIRECTLY MUTATES
 * that submodule's version files (package.json / tauri.conf.json /
 * Cargo.toml) and builds from it while it is live in the tree — exactly the
 * class of risk release:cut's `isAutoManagedCutWorktree` refuses: the git-sync
 * routine sweeps + commits the WHOLE shared tree on a schedule and can land
 * mid-build, and a peer's edit hook can touch the same files concurrently.
 * Prepare a dedicated worktree (setup-release-checkout.sh, or `release:cut`,
 * which already does this) and run from there instead.
 *
 *   npx tsx bin/release.ts publish --platform <linux|darwin|windows> --incremental <version> <channel>
 *     ADD one already-built platform's artifacts onto the LIVE latest.json
 *     without touching any other platform's entry (EI-18683062996592825 —
 *     the durable, kit-shared fix for what used to be hand-work; mirrors
 *     bin/publish-platform-incremental.sh but through the shared TS core, so
 *     oddsmith's `gh release upload --clobber` path can reuse the identical
 *     merge semantics). Requires the release host env
 *     (~/.papercusp/release-host.env, PAPERCUSP_UPDATE_BASE_URL) sourced
 *     first, and the platform already built (bin/build-linux-local.sh /
 *     bin/build-mac-cross.sh / bin/build-windows-cross.sh). Does NOT upload —
 *     run bin/upload-release.sh <version> <channel> afterwards, same as
 *     always.
 */
import { basename, dirname, resolve } from 'node:path';
import {
  CHANNELS,
  assertValidVersion,
  defaultTagFor,
  fetchHttpGetPort,
  isValidChannel,
  nodePorts,
  parsePublishArgs,
  runIncrementalPublish,
  runRelease,
  type Channel,
} from '../../libs/generic/tauri-release-kit/src/index.js';
import { makePapercuspConfig, registerPapercuspDrivers } from './release.config.js';

/**
 * Mirrors `isAutoManagedCutWorktree` in
 * packages/operator-core/lib/agent-tools/release/cut.ts. Duplicated rather
 * than imported: papercusp-desktop is a separate git submodule/npm package
 * (not a root npm workspace member), so it cannot import from operator-core.
 * Keep these two lists in sync if the auto-managed name set ever changes.
 */
const AUTO_MANAGED_CHECKOUT_NAMES = new Set([
  'papercup',
  'papercusp',
  'papercup-release',
  'papercusp-release',
  'papercup-checkpoint',
  'papercusp-checkpoint',
  'papercup-staging',
  'papercusp-staging',
]);

/**
 * Refuse to build+mutate+push from inside the auto-managed shared superproject
 * checkout. `root` is the papercusp-desktop/ submodule directory; its PARENT
 * is the superproject (papercusp/ in the common case). Exits the process —
 * this must run before any file write.
 */
function refuseIfAutoManagedRoot(root: string): void {
  const parent = basename(resolve(dirname(root)));
  if (AUTO_MANAGED_CHECKOUT_NAMES.has(parent)) {
    console.error(
      `ERROR: refusing to release from '${root}' — its parent checkout '${parent}' is an ` +
        'auto-managed shared tree (git-sync sweeps + commits it on a schedule, and peer agents ' +
        'edit it concurrently). A version bump written here mid-build can be committed by a ' +
        'sweep, or overwritten by a peer edit, before the cut finishes.',
    );
    console.error(
      '       Prepare a dedicated, isolated worktree instead (setup-release-checkout.sh), or use ' +
        'the release:cut MCP tool, which already resolves an isolated root via resolveCutRoot().',
    );
    process.exit(1);
  }
}

async function runPublishSubcommand(argv: string[]): Promise<void> {
  const args = parsePublishArgs(argv);
  const base = (process.env.PAPERCUSP_UPDATE_BASE_URL ?? '').replace(/\/+$/, '');
  if (!base) {
    console.error(
      'ERROR: PAPERCUSP_UPDATE_BASE_URL is not set — source ~/.papercusp/release-host.env first' +
        ' (see bin/lib/release-host.sh); an incremental publish must merge onto the genuinely' +
        ' LIVE manifest, so it cannot guess where that is.',
    );
    process.exit(1);
  }

  registerPapercuspDrivers();
  const cfg = makePapercuspConfig({ version: args.version, channel: args.channel, targets: [args.targetKey] });
  refuseIfAutoManagedRoot(cfg.root);

  const ports = nodePorts();
  const res = await runIncrementalPublish(cfg, args.targetKey, ports, {
    liveManifestUrl: `${base}/latest.json`,
    http: fetchHttpGetPort,
  });
  console.log(
    `\n✓ incremental publish ${res.tag} platform=${args.platform} (merged from: ${res.mergedFrom}) — ` +
      `${res.artifacts.length} artifact(s)`,
  );
  console.log(`  manifest: ${res.latestJsonPath}`);
  console.log(`  next:     bin/upload-release.sh ${args.version} ${args.channel}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === 'publish') {
    await runPublishSubcommand(argv);
    return;
  }
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const [version, channel = 'stable'] = argv.filter((a) => !a.startsWith('--'));

  if (!version) {
    console.error(`usage: release.ts <version> <channel: ${CHANNELS.join('|')}> [--plan] [--with-arm64] [--with-windows] [--with-mac] [--push-git] [--publish-github]`);
    console.error('   or: release.ts publish --platform <linux|darwin|windows> --incremental <version> <channel>');
    process.exit(1);
  }
  assertValidVersion(version);
  if (!isValidChannel(channel)) {
    console.error(`ERROR: channel must be ${CHANNELS.join('|')} (got "${channel}")`);
    process.exit(1);
  }

  const targets = ['linux-x86_64'];
  if (flags.has('--with-arm64') || process.env.WITH_ARM64 === '1') targets.push('linux-aarch64');
  if (flags.has('--with-windows') || process.env.WITH_WINDOWS === '1') targets.push('windows-x86_64');
  if (flags.has('--with-mac') || process.env.WITH_MAC === '1') targets.push('macos-universal');

  registerPapercuspDrivers();
  const cfg = makePapercuspConfig({ version, channel: channel as Channel, targets });

  if (flags.has('--plan')) {
    const tag = defaultTagFor(version, channel);
    console.log(
      JSON.stringify(
        {
          mode: 'plan',
          appName: cfg.appName,
          appId: cfg.appId,
          version,
          channel,
          tag,
          targets,
          versionFiles: cfg.versionFiles.map((v) => `${v.path} (${v.kind})`),
          signingKey: cfg.signing.keyPath,
          repo: `${cfg.repo.owner}/${cfg.repo.name}`,
          latestJsonUrlSample: cfg.latestJsonUrl({ tag, name: `Papercusp_${version}_amd64.AppImage` }),
        },
        null,
        2,
      ),
    );
    return;
  }

  // Every remaining path below actually writes: version-bump files, a build,
  // and (unless the caller opted OUT — see the flag flip below) a git push /
  // GitHub release. Refuse the shared-tree hazard before any of that.
  refuseIfAutoManagedRoot(cfg.root);

  const ports = nodePorts();
  const res = await runRelease(cfg, ports, {
    // LOCAL-only by default (owner directive 2026-07-08): a caller must
    // explicitly opt IN with --push-git / --publish-github. --skip-git /
    // --skip-publish are accepted as harmless no-ops for back-compat.
    skipGit: !flags.has('--push-git'),
    skipPublish: !flags.has('--publish-github'),
  });
  console.log(
    `\n✓ released ${res.tag} — ${res.artifacts.length} artifact(s), ${res.published?.action ?? 'not published'}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
