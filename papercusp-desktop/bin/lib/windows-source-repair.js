// Exact, committed-path repairs to a frozen Windows native source snapshot.
// This is a derived source, NOT a clean build of the base commit. The existing
// buildSha remains the paired Server/operator identity; sourceRepair identifies
// the changed native code independently. Publication still needs acceptance.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], {
  maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
});
const commit = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const CARGO_PATHS = ['src-tauri/Cargo.toml', 'src-tauri/Cargo.lock'];
const INNO_PATH = 'src-tauri/windows/inno/papercusp.iss';
const SHA2_DECLARATION = '# Already pinned transitively; use the maintained implementation for complete\n' +
  '# Windows runtime payload identity, not a hand-written or serve-only hash.\nsha2 = "=0.10.9"\n';

function replaceOnce(text, before, after) {
  assert.equal(text.split(before).length, 2, 'expected one exact Cargo repair anchor');
  return text.replace(before, () => after);
}

// This is intentionally an exact, bounded edit policy, not a TOML parser or
// permission to resolve/upgrade dependencies. Every other byte must survive.
function cargoPackage(text, relative, transform) {
  const separator = relative.endsWith('.lock') ? '[[package]]\n' : '[package]\n';
  const parts = text.split(separator);
  const indices = parts.flatMap((part, index) =>
    index > 0 && part.startsWith('name = "papercusp-desktop"\n') ? [index] : []);
  assert.equal(indices.length, 1, 'expected one desktop Cargo package');
  parts[indices[0]] = transform(parts[indices[0]]);
  return parts.join(separator);
}

function renderCargoVersion(bytes, relative, version) {
  assert.match(version, /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/);
  const rendered = cargoPackage(bytes.toString('utf8'), relative, (block) => {
    const matches = [...block.matchAll(/^version = "[^"\n]+"$/gm)];
    assert.equal(matches.length, 1, 'expected one desktop Cargo version');
    return replaceOnce(block, matches[0][0], `version = "${version}"`);
  });
  return Buffer.from(rendered);
}

function validateCargoRepair(before, after, relative) {
  const original = before.toString('utf8');
  let expected;
  if (relative.endsWith('.toml')) {
    const parts = original.split('[dependencies]\n');
    assert.equal(parts.length, 2, 'expected one direct-dependencies section');
    const end = parts[1].search(/^\[/m);
    const deps = end < 0 ? parts[1] : parts[1].slice(0, end);
    assert.doesNotMatch(deps, /^sha2\s*=/m, 'sha2 is already direct');
    const updated = replaceOnce(deps, 'serde_json = "1"\n', 'serde_json = "1"\n' + SHA2_DECLARATION);
    expected = parts[0] + '[dependencies]\n' + updated + (end < 0 ? '' : parts[1].slice(end));
  } else {
    assert.match(original, /^\[\[package\]\]\nname = "sha2"\nversion = "0\.10\.9"\n/m,
      'sha2 0.10.9 must already be locked');
    expected = cargoPackage(original, relative, (block) => {
      assert.doesNotMatch(block, /^ "sha2",$/m, 'sha2 is already direct');
      return replaceOnce(block, ' "serde_json",\n', ' "serde_json",\n "sha2",\n');
    });
  }
  assert.equal(after.toString('utf8'), expected, 'Cargo repair must be only the pinned sha2 direct dependency');
}

function roles(value) {
  assert.ok(Array.isArray(value) && value.length > 0 && value.length <= 2,
    'repair roles must explicitly name gui and/or server');
  assert.ok(value.every((role) => role === 'gui' || role === 'server'), 'invalid repair role');
  assert.equal(new Set(value).size, value.length, 'duplicate repair role');
  return [...value].sort();
}

function manifest(value) {
  assert.ok(value.schemaVersion === 1 || value.schemaVersion === 2, 'unsupported source repair schema');
  const composed = value.schemaVersion === 2;
  const legacy = value.kind === 'windows-gui-source-repair';
  assert.ok(legacy || value.kind === 'windows-native-source-repair', 'unsupported repair kind');
  assert.ok(!composed || !legacy, 'v2 requires explicit native roles');
  if (composed) assert.match(value.releaseVersion, /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/);
  else assert.equal(value.releaseVersion, undefined, 'releaseVersion requires v2');
  // Preserve the legacy GUI manifest's exact serialized shape and hash. Never
  // silently discard a roles field that could look like Server authorization.
  if (legacy) assert.equal(value.roles, undefined, 'legacy repair is GUI-only; use native kind for explicit roles');
  const scopedRoles = legacy ? null : roles(value.roles);
  assert.ok(commit(value.baseDesktopCommit) && commit(value.baseWorkspaceCommit));
  assert.match(value.operatorBuildSha, /^[a-f0-9]{8,40}$/);
  assert.ok(value.baseDesktopCommit.startsWith(value.operatorBuildSha),
    'paired operator identity must identify the frozen desktop base');
  assert.match(value.workItem, /^(?:WI|EI)-\d+$/);
  assert.ok(Array.isArray(value.files) && value.files.length > 0 && value.files.length <= 20);
  const files = value.files.map((file) => {
    // v2 adds precisely the Cargo pair and shipping installer, not arbitrary
    // generated resources, configuration, build scripts, or payloads.
    const cargo = CARGO_PATHS.includes(file.path);
    assert.ok(/^src-tauri\/src\/[A-Za-z0-9_-]+\.rs$/.test(file.path) ||
      (composed && (cargo || file.path === INNO_PATH)), 'unsupported native repair path');
    assert.ok(commit(file.sourceCommit), 'repair bytes must be committed');
    assert.ok(file.beforeSha256 === null || digest(file.beforeSha256));
    if (cargo || file.path === INNO_PATH) assert.ok(digest(file.beforeSha256), 'composition requires a frozen baseline');
    assert.ok(digest(file.afterSha256));
    if (cargo) assert.ok(digest(file.materializedSha256), 'Cargo needs an explicit release-rendered hash');
    else assert.equal(file.materializedSha256, undefined, 'only Cargo may render a release version');
    assert.notEqual(file.beforeSha256, file.afterSha256, 'empty repair');
    return {
      path: file.path, sourceCommit: file.sourceCommit,
      beforeSha256: file.beforeSha256, afterSha256: file.afterSha256,
      ...(cargo ? { materializedSha256: file.materializedSha256 } : {}),
    };
  }).sort((a, b) => a.path.localeCompare(b.path));
  assert.equal(new Set(files.map((f) => f.path)).size, files.length, 'duplicate repair path');
  if (composed) assert.ok(CARGO_PATHS.every((p) => files.some((f) => f.path === p)),
    'v2 requires the complete Cargo pair');
  const result = {
    schemaVersion: value.schemaVersion, kind: value.kind, workItem: value.workItem,
    baseDesktopCommit: value.baseDesktopCommit,
    baseWorkspaceCommit: value.baseWorkspaceCommit,
    operatorBuildSha: value.operatorBuildSha, files,
    ...(legacy ? {} : { roles: scopedRoles }),
    ...(composed ? { releaseVersion: value.releaseVersion } : {}),
  };
  return { ...result, manifestSha256: hash(Buffer.from(JSON.stringify(result))) };
}

function forRoles(input, requested) {
  const repair = manifest(input);
  // Old callers remain GUI-only. New native manifests ALWAYS require the
  // actual requested build roles, including on post-build attestation.
  const fallback = repair.kind === 'windows-gui-source-repair' ? ['gui'] : [];
  // The producer's payload guards use space-delimited membership. Reject
  // alternate whitespace rather than accepting roles those guards could miss.
  const requestedRoles = requested === undefined || requested === ''
    ? roles(fallback) : roles(typeof requested === 'string' ? requested.split(' ') : requested);
  assert.deepEqual(requestedRoles, repair.roles || ['gui'], 'source repair/build roles mismatch');
  return repair;
}

function compileConfig(input, snapshot, role) {
  const repair = manifest(input);
  assert.equal(input.manifestSha256, repair.manifestSha256, 'repair manifest changed');
  assert.ok((repair.roles || ['gui']).includes(role), 'compile role outside source repair');
  const base = JSON.parse(fs.readFileSync(regularPath(snapshot, 'src-tauri/tauri.conf.json')));
  const override = role === 'server'
    ? JSON.parse(fs.readFileSync(regularPath(snapshot, 'src-tauri/tauri.server.conf.json'))) : {};
  assert.equal(override.identifier ?? base.identifier, `com.papercusp.${role}`,
    'source repair compile identifier mismatch');
  return override;
}

function regularPath(root, relative, missing = false) {
  const parts = relative.split('/');
  let current = root;
  for (let i = 0; i < parts.length; i += 1) {
    current = path.join(current, parts[i]);
    if (!fs.existsSync(current) && missing && i === parts.length - 1) {
      // existsSync follows symlinks, so check lstat as well.
      assert.throws(() => fs.lstatSync(current), { code: 'ENOENT' });
      return current;
    }
    const stat = fs.lstatSync(current);
    assert.ok(!stat.isSymbolicLink(), `symlink in repair path: ${relative}`);
    assert.ok(i === parts.length - 1 ? stat.isFile() : stat.isDirectory());
  }
  return current;
}

function changedPaths(snapshot, repair) {
  const scope = repair.schemaVersion === 2
    ? ['src-tauri/src', ...CARGO_PATHS, 'src-tauri/windows/inno'] : ['src-tauri/src'];
  return [...new Set([
    ...git(snapshot, 'diff', '--name-only', 'HEAD', '--', ...scope).toString().trim().split('\n'),
    ...git(snapshot, 'ls-files', '--others', '--exclude-standard', '--', ...scope)
      .toString().trim().split('\n'),
  ].filter(Boolean))].sort();
}

function apply(input, sourceRepo, snapshot, baseDesktopCommit, baseWorkspaceCommit, requestedRoles) {
  const repair = forRoles(input, requestedRoles);
  assert.equal(repair.baseDesktopCommit, baseDesktopCommit, 'wrong desktop base');
  assert.equal(repair.baseWorkspaceCommit, baseWorkspaceCommit, 'wrong workspace base');
  assert.equal(git(snapshot, 'rev-parse', 'HEAD').toString().trim(), baseDesktopCommit);
  const allowedBaselineDelta = repair.schemaVersion === 2 ? CARGO_PATHS.filter((p) => {
    const bytes = git(snapshot, 'show', `${baseDesktopCommit}:${p}`);
    return hash(bytes) !== hash(renderCargoVersion(bytes, p, repair.releaseVersion));
  }).sort() : [];
  assert.deepEqual(changedPaths(snapshot, repair), allowedBaselineDelta,
    'unmanifested native source delta before repair');
  // Validate EVERY byte/path before writing any. A bad second entry must not
  // leave the first applied and look like a valid partial repair on a retry.
  const prepared = repair.files.map((file) => {
    const cargo = CARGO_PATHS.includes(file.path);
    const target = regularPath(snapshot, file.path, file.beforeSha256 === null);
    let before;
    if (file.beforeSha256 === null) {
      assert.ok(!fs.existsSync(target), `new source already exists: ${file.path}`);
      assert.equal(git(snapshot, 'ls-tree', baseDesktopCommit, '--', file.path).length, 0);
    } else {
      before = git(snapshot, 'show', `${baseDesktopCommit}:${file.path}`);
      assert.equal(hash(before), file.beforeSha256, 'before hash is not the frozen source');
      const expected = cargo ? renderCargoVersion(before, file.path, repair.releaseVersion) : before;
      assert.equal(hash(fs.readFileSync(target)), hash(expected), 'snapshot baseline changed');
    }
    const treeEntry = git(sourceRepo, 'ls-tree', file.sourceCommit, '--', file.path).toString();
    assert.match(treeEntry, /^100644 blob /, 'repair must name a regular committed source file');
    const bytes = git(sourceRepo, 'show', `${file.sourceCommit}:${file.path}`);
    assert.equal(hash(bytes), file.afterSha256, 'committed repair hash mismatch');
    if (cargo) {
      validateCargoRepair(before, bytes, file.path);
      const rendered = renderCargoVersion(bytes, file.path, repair.releaseVersion);
      assert.equal(hash(rendered), file.materializedSha256, 'release-rendered Cargo hash mismatch');
      return { target, bytes: rendered };
    }
    return { target, bytes };
  });
  for (const { target, bytes } of prepared) fs.writeFileSync(target, bytes);
  verify(repair, snapshot, requestedRoles);
  return repair;
}

function verify(input, snapshot, requestedRoles) {
  const repair = forRoles(input, requestedRoles);
  assert.equal(input.manifestSha256, repair.manifestSha256, 'repair manifest changed');
  assert.equal(git(snapshot, 'rev-parse', 'HEAD').toString().trim(), repair.baseDesktopCommit);
  assert.deepEqual(changedPaths(snapshot, repair), repair.files.map((f) => f.path).sort(),
    'unmanifested native source delta');
  for (const file of repair.files) {
    assert.equal(hash(fs.readFileSync(regularPath(snapshot, file.path))), file.materializedSha256 || file.afterSha256,
      `repair source changed: ${file.path}`);
  }
  return repair;
}

function attestation(input, snapshot, buildSha, gitHead, requestedRoles, releaseVersion) {
  const repair = verify(input, snapshot, requestedRoles);
  if (repair.schemaVersion === 2) assert.equal(releaseVersion, repair.releaseVersion,
    'repair release version does not match artifact version');
  assert.equal(buildSha, repair.operatorBuildSha, 'repair paired operator identity mismatch');
  assert.equal(gitHead, repair.baseDesktopCommit, 'repair base provenance mismatch');
  for (const role of repair.roles || ['gui']) compileConfig(repair, snapshot, role);
  return repair;
}

if (require.main === module) {
  const [action, inputPath, ...args] = process.argv.slice(2);
  const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const result = action === 'apply' ? apply(input, ...args)
    : action === 'verify' ? verify(input, ...args)
      : action === 'attestation' ? attestation(input, ...args)
        : action === 'roles' ? forRoles(input, ...args)
          : action === 'config' ? compileConfig(input, ...args)
            : (() => { throw new Error(`unknown action: ${action}`); })();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

module.exports = { apply, verify, attestation, manifest, hash, forRoles, compileConfig,
  renderCargoVersion, SHA2_DECLARATION };
