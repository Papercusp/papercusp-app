#!/usr/bin/env node
/**
 * Bundle `psu` for one public PUI release unit from ONE committed source
 * generation (pui-first-party-public-release D-031 / P-018).
 *
 * The recipe is the desktop sidecar's (papercusp-desktop/bin/build-desktop-sidecar.sh):
 * esbuild bundles apps/operator/scripts/psu-launcher.mjs into one ESM file with
 * the shared host banner; only @lydell/* stays external (psu requires node-pty
 * lazily, on the pty-host path), and the two OMP native MCP artifacts psu loads
 * by file URL are built beside it from packages/omp-plugin/build-native.mjs.
 *
 * What makes this a RELEASE build rather than a working-tree build:
 *  - every first-party byte esbuild loads is read from git at --sha (inside a
 *    submodule, at the gitlink that commit pins), never from disk, so an
 *    uncommitted edit cannot reach the bundle;
 *  - the files esbuild consults from disk to RESOLVE modules (package.json,
 *    tsconfig.json and their relative `extends`) must equal their committed blobs,
 *    except package.json scripts, which esbuild never executes or resolves through;
 *  - esbuild and every npm package inlined or copied must be the version
 *    package-lock.json pins at --sha;
 *  - no output may carry the build host's home directory.
 *
 * Writes --summary JSON: the npm packages shipped (with license metadata and the
 * directory holding their license texts) for license-inventory.py, and the
 * digests and source pins for PROVENANCE.json.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { lockedPackageKeyResolver, releaseMinification } from './bundle-psu-dependencies.mjs';

const fail = (message) => {
  console.error(`bundle-psu: ERROR: ${message}`);
  process.exit(1);
};

const REQUIRED = ['root', 'sha', 'target', 'out', 'summary', 'native-builds', 'cache'];
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (!arg.startsWith('--')) fail(`unexpected argument ${arg}`);
  const eq = arg.indexOf('=');
  if (eq > 0) args[arg.slice(2, eq)] = arg.slice(eq + 1);
  else args[arg.slice(2)] = process.argv[++i];
}
for (const key of REQUIRED) if (!args[key]) fail(`--${key} is required`);
const HOST_BANNER = process.env.HOST_BANNER;
if (!HOST_BANNER) fail('HOST_BANNER is not set (source apps/operator/bin/bundle-host-common.sh from the commit)');

const ROOT = realpathSync(args.root);
const SHA = args.sha;
const OUT = path.resolve(args.out);
const PTY_PLATFORM = {
  'linux-x86_64': 'node-pty-linux-x64',
  'macos-aarch64': 'node-pty-darwin-arm64',
  'macos-x86_64': 'node-pty-darwin-x64',
}[args.target] ?? fail(`unsupported target ${args.target}`);

// A caller may point GIT_DIR at another superproject object store; honour it for
// the superproject (as package-release.sh does) but never inside a submodule.
const SUBMODULE_ENV = { ...process.env };
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY']) {
  delete SUBMODULE_ENV[key];
}

/** One repository at one commit; paths inside its submodules resolve through the pinned gitlinks. */
class CommittedTree {
  constructor(dir, commit, env, label) {
    Object.assign(this, { dir, commit, env, label, links: null, subs: new Map() });
    if (this.git(['cat-file', '-e', `${commit}^{commit}`]).status !== 0) {
      fail(`${label} does not have commit ${commit}; fetch it before packaging`);
    }
  }

  git(gitArgs) {
    return spawnSync('git', ['-C', this.dir, ...gitArgs], { env: this.env, maxBuffer: 1 << 30 });
  }

  gitlinks() {
    if (!this.links) {
      const listed = this.git(['ls-tree', '-r', '-z', this.commit]);
      if (listed.status !== 0) fail(`git ls-tree ${this.commit} in ${this.dir}: ${listed.stderr}`);
      this.links = new Map();
      for (const entry of listed.stdout.toString('utf8').split('\0')) {
        const tab = entry.indexOf('\t');
        if (tab < 0) continue;
        const [, type, object] = entry.slice(0, tab).split(' ');
        if (type === 'commit') this.links.set(entry.slice(tab + 1), object);
      }
    }
    return this.links;
  }

  /** [the repository holding `rel`, the path inside it] */
  locate(rel) {
    for (const [prefix, pinned] of this.gitlinks()) {
      if (!rel.startsWith(`${prefix}/`)) continue;
      let sub = this.subs.get(prefix);
      if (!sub) {
        const label = this.label === '.' ? prefix : `${this.label}/${prefix}`;
        sub = new CommittedTree(path.join(this.dir, prefix), pinned, SUBMODULE_ENV, label);
        this.subs.set(prefix, sub);
      }
      return sub.locate(rel.slice(prefix.length + 1));
    }
    return [this, rel];
  }

  /** The committed bytes of repository-relative `rel`, or null when the commit has no such file. */
  read(rel) {
    const [tree, inner] = this.locate(rel);
    const blob = tree.git(['cat-file', 'blob', `${tree.commit}:${inner}`]);
    return blob.status === 0 ? blob.stdout : null;
  }

  /** Every repository consulted, with the commit it was read at. */
  pins(into = {}) {
    into[this.label] = this.commit;
    for (const sub of this.subs.values()) sub.pins(into);
    return into;
  }
}

const tree = new CommittedTree(ROOT, SHA, process.env, '.');
const lockBytes = tree.read('package-lock.json') ?? fail(`${SHA} has no package-lock.json`);
const LOCK = JSON.parse(lockBytes.toString('utf8')).packages ?? fail('package-lock.json has no packages map');
const operatorManifest = JSON.parse((tree.read('apps/operator/package.json')
  ?? fail(`${SHA} has no apps/operator/package.json`)).toString('utf8'));
if (typeof operatorManifest.name !== 'string' || !operatorManifest.name) {
  fail(`apps/operator/package.json at ${SHA} has no name`);
}
const puiCargoManifest = (tree.read('apps/tui/Cargo.toml')
  ?? fail(`${SHA} has no apps/tui/Cargo.toml`)).toString('utf8');
const puiPackageSection = puiCargoManifest.split(/^\[package\]\s*$/m)[1]
  ?.split(/^\[[^\]]+\]\s*$/m, 1)[0];
const puiVersion = puiPackageSection?.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
if (!puiVersion) fail(`apps/tui/Cargo.toml at ${SHA} has no [package].version`);
const posix = (p) => p.split(path.sep).join('/');
const repoRel = (abs) => {
  const rel = path.relative(ROOT, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) fail(`input outside the repository: ${abs}`);
  return posix(rel);
};
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
// Installed npm packages may be linked into an immutable checkout from its
// shared dependency generation. First-party source still uses strict repoRel.
const packageKey = lockedPackageKeyResolver(ROOT, LOCK);

/** An installed package must be the version the committed lock pins at that exact install path. */
function lockedVersion(dir) {
  let key;
  try {
    key = packageKey(dir);
  } catch (error) {
    fail(error.message);
  }
  const installed = readJson(path.join(dir, 'package.json'));
  const locked = LOCK[key];
  if (!locked) fail(`${key} (${installed.name}@${installed.version}) is not in package-lock.json at ${SHA}`);
  if (locked.version !== installed.version) {
    fail(`${key} is installed at ${installed.version} but package-lock.json at ${SHA} pins ${locked.version}; run npm run install:safe`);
  }
  return { key, installed, locked };
}

const requireFromRoot = createRequire(path.join(ROOT, 'package.json'));
const esbuildDir = path.dirname(requireFromRoot.resolve('esbuild/package.json'));
const ESBUILD_VERSION = lockedVersion(esbuildDir).installed.version;
const esbuild = requireFromRoot('esbuild');

// ── the committed-source loader ─────────────────────────────────────────────
const LOADERS = { '.ts': 'ts', '.mts': 'ts', '.cts': 'ts', '.tsx': 'tsx', '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'jsx', '.json': 'json' };
const NODE_MODULES = `${path.sep}node_modules${path.sep}`;
const firstParty = new Set(['apps/operator/package.json', 'apps/tui/Cargo.toml']);
const npmDirs = new Set();

const committedSource = {
  name: 'committed-source',
  setup(build) {
    build.onLoad({ filter: /.*/ }, (loaded) => {
      if (loaded.namespace !== 'file') return undefined;
      const at = loaded.path.lastIndexOf(NODE_MODULES);
      if (at >= 0) {
        const rest = loaded.path.slice(at + NODE_MODULES.length).split(path.sep);
        const name = rest[0].startsWith('@') ? `${rest[0]}${path.sep}${rest[1]}` : rest[0];
        npmDirs.add(loaded.path.slice(0, at + NODE_MODULES.length) + name);
        return undefined; // verified against the lock below; esbuild reads it from disk
      }
      const rel = repoRel(loaded.path);
      const loader = LOADERS[path.extname(loaded.path)] ?? fail(`first-party input ${rel} has no known loader`);
      const contents = tree.read(rel);
      if (contents === null) fail(`${rel} is in psu's module graph but does not exist at ${SHA}; commit it first`);
      firstParty.add(rel);
      return { contents, loader, resolveDir: path.dirname(loaded.path) };
    });
  },
};

// ── build ───────────────────────────────────────────────────────────────────
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

await esbuild.build({
  absWorkingDir: path.join(ROOT, 'apps/operator'),
  entryPoints: [path.join(ROOT, 'apps/operator/scripts/psu-launcher.mjs')],
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  ...releaseMinification,
  outfile: path.join(OUT, 'psu.mjs'),
  banner: { js: HOST_BANNER },
  external: ['@lydell/*'],
  plugins: [committedSource],
  logLevel: 'warning',
});
// Preserve the package identity the launcher's --version reads when the source
// checkout and build environment are absent. Do not ship source dependencies.
writeFileSync(path.join(OUT, 'package.json'), `${JSON.stringify({
  name: operatorManifest.name, version: puiVersion, type: 'module', private: true,
}, null, 2)}\n`);

const { nativeBuilds } = await import(pathToFileURL(path.resolve(args['native-builds'])).href);
if (typeof nativeBuilds !== 'function') fail(`${args['native-builds']} does not export nativeBuilds(root, outDir)`);
const nativeOutputs = [];
for (const options of nativeBuilds(`${ROOT}/`, `${OUT}/`)) {
  await esbuild.build({ ...options, ...releaseMinification, absWorkingDir: ROOT, plugins: [committedSource] });
  nativeOutputs.push(path.basename(options.outfile));
}
for (const name of ['native-client.cjs', 'native-extension.mjs']) {
  if (!nativeOutputs.includes(name)) fail(`nativeBuilds did not produce ${name}, which psu loads by file URL`);
}

// ── the files esbuild resolved against must be the committed ones ───────────
const RESOLUTION_FILES = ['package.json', 'tsconfig.json', 'jsconfig.json'];
const consulted = new Set();
for (const rel of firstParty) {
  for (let dir = path.posix.dirname(rel); ; dir = path.posix.dirname(dir)) {
    for (const name of RESOLUTION_FILES) {
      const candidate = dir === '.' ? name : `${dir}/${name}`;
      if (existsSync(path.join(ROOT, candidate)) || tree.read(candidate) !== null) consulted.add(candidate);
    }
    if (dir === '.') break;
  }
}
const pending = [...consulted].filter((rel) => rel.endsWith('tsconfig.json'));
while (pending.length) {
  const rel = pending.pop();
  const text = existsSync(path.join(ROOT, rel)) ? readFileSync(path.join(ROOT, rel), 'utf8') : '';
  for (const [, target] of text.matchAll(/"extends"\s*:\s*"(\.[^"]+)"/g)) {
    let extended = posix(path.normalize(path.join(path.dirname(rel), target)));
    if (!extended.endsWith('.json')) extended += '.json';
    if (!consulted.has(extended)) {
      consulted.add(extended);
      pending.push(extended);
    }
  }
}
const drifted = [...consulted].filter((rel) => {
  const disk = existsSync(path.join(ROOT, rel)) ? readFileSync(path.join(ROOT, rel)) : null;
  const committed = tree.read(rel);
  if (disk === null || committed === null) return true;
  if (disk.equals(committed)) return false;
  if (path.posix.basename(rel) === 'package.json') {
    // A historical release must not be invalidated by unrelated lint/test
    // scripts added since its commit. esbuild reads resolution metadata but
    // never executes npm scripts. Preserve EVERY other field (including
    // unknown future resolution fields) instead of maintaining an allowlist.
    // If the manifest itself is imported, onLoad still supplies committed bytes.
    const fromDisk = JSON.parse(disk.toString('utf8'));
    const fromCommit = JSON.parse(committed.toString('utf8'));
    delete fromDisk.scripts;
    delete fromCommit.scripts;
    return !isDeepStrictEqual(fromDisk, fromCommit);
  }
  return true;
});
if (drifted.length) {
  fail(`module resolution read files that differ from ${SHA}: ${drifted.sort().join(', ')}; commit them or package an older sha`);
}

// ── npm packages: inlined ones and the node-pty closure ─────────────────────
const shipped = new Map();
const record = (dir, how) => {
  const { key, installed } = lockedVersion(dir);
  const license = typeof installed.license === 'string' ? installed.license
    : installed.license?.type ?? installed.licenses?.map((entry) => entry.type ?? entry).join(' OR ');
  const repository = typeof installed.repository === 'string' ? installed.repository : installed.repository?.url;
  const id = `${installed.name}@${installed.version}`;
  if (!shipped.has(id)) {
    shipped.set(id, {
      name: installed.name, version: installed.version, license: license ?? null,
      source: repository ?? `https://www.npmjs.com/package/${installed.name}`, dir, lockKey: key, how,
    });
  }
};
for (const dir of [...npmDirs].sort()) record(dir, 'inlined into lib/psu/psu.mjs');

const ptyDest = path.join(OUT, 'node_modules', '@lydell');
mkdirSync(ptyDest, { recursive: true });
const ptyDir = realpathSync(path.join(ROOT, 'node_modules', '@lydell', 'node-pty'));
const pty = lockedVersion(ptyDir);
cpSync(ptyDir, path.join(ptyDest, 'node-pty'), { recursive: true, dereference: true });
record(ptyDir, 'lib/psu/node_modules/@lydell/node-pty');

const platformKey = `node_modules/@lydell/${PTY_PLATFORM}`;
const platformLock = LOCK[platformKey] ?? fail(`package-lock.json at ${SHA} has no ${platformKey}`);
const wanted = pty.installed.optionalDependencies?.[`@lydell/${PTY_PLATFORM}`];
if (wanted !== platformLock.version) {
  fail(`@lydell/node-pty ${pty.installed.version} wants @lydell/${PTY_PLATFORM} ${wanted}, the lock pins ${platformLock.version}`);
}
const installedPlatform = path.join(ROOT, platformKey);
let platformDir;
if (existsSync(path.join(installedPlatform, 'package.json'))
    && readJson(path.join(installedPlatform, 'package.json')).version === platformLock.version) {
  platformDir = realpathSync(installedPlatform);
} else {
  // Another platform's addon: fetch the exact tarball the lock records and check its integrity.
  if (!platformLock.resolved || !platformLock.integrity) fail(`${platformKey} has no resolved/integrity in the lock to fetch`);
  const tarball = path.join(path.resolve(args.cache), `${PTY_PLATFORM}-${platformLock.version}.tgz`);
  const [algorithm, expected] = [platformLock.integrity.slice(0, platformLock.integrity.indexOf('-')),
    platformLock.integrity.slice(platformLock.integrity.indexOf('-') + 1)];
  const intact = (bytes) => createHash(algorithm).update(bytes).digest('base64') === expected;
  if (!existsSync(tarball) || !intact(readFileSync(tarball))) {
    const response = await fetch(platformLock.resolved);
    if (!response.ok) fail(`fetching ${platformLock.resolved}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!intact(bytes)) fail(`${platformLock.resolved} does not match the lock's integrity ${platformLock.integrity}`);
    mkdirSync(path.dirname(tarball), { recursive: true });
    writeFileSync(`${tarball}.tmp`, bytes);
    renameSync(`${tarball}.tmp`, tarball);
  }
  const unpacked = mkdtempSync(path.join(tmpdir(), 'bundle-psu-pty-'));
  const extracted = spawnSync('tar', ['-xzf', tarball, '-C', unpacked]);
  if (extracted.status !== 0) fail(`extracting ${tarball}: ${extracted.stderr}`);
  platformDir = path.join(path.resolve(args.cache), `${PTY_PLATFORM}-${platformLock.version}`);
  rmSync(platformDir, { recursive: true, force: true });
  renameSync(path.join(unpacked, 'package'), platformDir);
  rmSync(unpacked, { recursive: true, force: true });
}
cpSync(platformDir, path.join(ptyDest, PTY_PLATFORM), { recursive: true, dereference: true });
const platformPkg = readJson(path.join(platformDir, 'package.json'));
const platformLicense = platformPkg.license ?? platformLock.license ?? null;
shipped.set(`${platformPkg.name}@${platformPkg.version}`, {
  name: platformPkg.name, version: platformPkg.version, license: platformLicense,
  source: `https://www.npmjs.com/package/${platformPkg.name}`, dir: platformDir, lockKey: platformKey,
  how: `lib/psu/node_modules/@lydell/${PTY_PLATFORM}`,
});

// ── outputs must not name the build host ────────────────────────────────────
const home = homedir();
const outputs = {};
for (const name of ['psu.mjs', 'native-client.cjs', 'native-extension.mjs', 'package.json']) {
  const bytes = readFileSync(path.join(OUT, name));
  for (const hostPath of [ROOT, home].filter((p) => p.length > 4)) {
    const at = bytes.indexOf(hostPath);
    if (at >= 0) fail(`${name} embeds the build host path ${hostPath}: …${bytes.subarray(Math.max(0, at - 80), at + 120)}…`);
  }
  outputs[name] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

const summary = {
  entry: 'apps/operator/scripts/psu-launcher.mjs',
  esbuild: ESBUILD_VERSION,
  sourcePins: tree.pins(),
  firstPartyInputs: firstParty.size,
  outputs,
  nodePty: pty.installed.version,
  npmPackages: [...shipped.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)),
};
writeFileSync(args.summary, `${JSON.stringify(summary, null, 2)}\n`);
console.log(`bundle-psu: psu.mjs ${outputs['psu.mjs'].bytes} bytes from ${firstParty.size} committed files`
  + ` and ${summary.npmPackages.length} locked npm packages (esbuild ${ESBUILD_VERSION})`);
