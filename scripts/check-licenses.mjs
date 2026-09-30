#!/usr/bin/env node
/**
 * License gate — npm and Rust dependency licenses.
 * Plan open-source-release-2026-09-29, P-017 / D-001, WI-10003906.
 * [owner 2026-09-29, directive #931] "lets run the npm, Rust and installer checks in CI
 * as a gate". The owner chose to BLOCK main on it (green-checkpoint + GitHub CI).
 *
 * WHY THIS EXISTS
 * Papercusp is being prepared for a public source release. A dependency under a license
 * that forbids commercial use, or a strong-copyleft license that would force the whole app
 * under its terms, must never slip in unnoticed. The first audit (2026-09-29) read each
 * package's DECLARED license by hand and found @codesandbox/nodebox (non-commercial) only
 * because someone opened its LICENSE file. This gate makes that check mechanical.
 *
 * WHY LOCKFILES, NOT node_modules
 * Tools like license-checker read the INSTALLED tree, which on this Linux box never
 * contains the macOS/Windows optional packages (sharp's libvips builds, the Claude agent
 * SDK's per-platform binaries). The lockfile records every platform's entry with its
 * declared license, so reading it covers every platform from any host.
 *
 * WHY `cargo metadata`, NOT cargo-deny
 * Cargo.lock carries no license field. `cargo metadata` resolves every crate for every
 * target and reports the crate's declared SPDX license, with nothing to install beyond
 * cargo itself — the same no-extra-binary property check-rust-advisories.mjs chose over
 * `cargo audit`. It tries --offline first and falls back to a normal (networked) resolve.
 *
 * THE POPULATION IS DERIVED, NOT LISTED
 * Lockfiles come from check-lockfile-census.mjs's filesystem walk (censusOrThrow), so a new
 * lockfile anywhere in the tree is scanned automatically. Local path crates (our own code,
 * the vendored tao/wry forks) are skipped: they are source in this repo, not dependencies.
 *
 * POLICY
 *   permissive      MIT, Apache-2.0, BSD, ISC, … — allowed.
 *   weak-copyleft   MPL, LGPL, EPL, CDDL — allowed; obligations apply only to that
 *                   component's own files (listed in the report so notices can be shipped).
 *   denied          everything else: GPL, AGPL, SSPL, BUSL, Elastic, non-commercial,
 *                   proprietary, unknown, missing, "SEE LICENSE IN …".
 * An SPDX `OR` takes the best alternative, `AND` the worst. A denied package passes only
 * through scripts/license-exceptions.json, where each entry was reviewed against the
 * package's real license text. An exception applies only while the lockfile still declares
 * exactly the `declared` value recorded in it, so a license change forces a fresh review.
 *
 * Exit codes: 0 pass · 1 denied package found (with --strict) · 2 not measured (a Cargo
 * resolve failed, or a lockfile yielded nothing) — "re-run", never "clean".
 *
 * Usage:
 *   node scripts/check-licenses.mjs                      # report, both ecosystems
 *   node scripts/check-licenses.mjs --strict             # the gate
 *   node scripts/check-licenses.mjs --ecosystem npm      # npm | cargo | all
 *   node scripts/check-licenses.mjs --list               # every package + effective license
 *   node scripts/check-licenses.mjs --notices <path>     # write THIRD-PARTY-NOTICES.md
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, openSync, readSync, closeSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { censusOrThrow } from './check-lockfile-census.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..');
export const EXCEPTIONS_PATH = join(HERE, 'license-exceptions.json');

export const TIER = Object.freeze({ DENIED: 0, WEAK_COPYLEFT: 1, PERMISSIVE: 2 });
export const TIER_NAME = ['denied', 'weak-copyleft', 'permissive'];

/** Licenses that impose only notice/attribution obligations. */
export const PERMISSIVE = new Set([
  '0BSD', 'AFL-2.1', 'Apache-2.0', 'Artistic-2.0', 'BlueOak-1.0.0', 'BSD-2-Clause',
  'BSD-3-Clause', 'BSL-1.0', 'CC-BY-3.0', 'CC-BY-4.0', 'CC0-1.0', 'CDLA-Permissive-2.0',
  'ISC', 'MIT', 'MIT-0', 'NCSA', 'PSF-2.0', 'Python-2.0', 'Unicode-3.0', 'Unicode-DFS-2016',
  'Unlicense', 'WTFPL', 'X11', 'Zlib',
]);

/** File-level copyleft: usable in a closed or differently-licensed app; changes to the
 *  component's own files must be shared, and its license + source offer shipped. */
export const WEAK_COPYLEFT = new Set([
  'CDDL-1.0', 'CDDL-1.1', 'EPL-1.0', 'EPL-2.0', 'LGPL-2.0-only', 'LGPL-2.0-or-later',
  'LGPL-2.1-only', 'LGPL-2.1-or-later', 'LGPL-3.0-only', 'LGPL-3.0-or-later', 'MPL-1.1',
  'MPL-2.0',
]);

/**
 * Tier of one SPDX license id (a trailing `+` means "or later" and does not change it).
 * The deprecated bare LGPL ids (`LGPL-2.1`, `LGPL-2.1+`) that older packages still declare
 * map to their current `-only` / `-or-later` forms, so they classify as weak-copyleft.
 */
export function tierOfId(id) {
  const plus = id.endsWith('+');
  let bare = id.replace(/\+$/, '');
  if (/^LGPL-(2\.0|2\.1|3\.0)$/.test(bare)) bare = `${bare}-${plus ? 'or-later' : 'only'}`;
  if (PERMISSIVE.has(bare)) return TIER.PERMISSIVE;
  if (WEAK_COPYLEFT.has(bare)) return TIER.WEAK_COPYLEFT;
  return TIER.DENIED;
}

/**
 * Evaluate an SPDX license expression. Returns { tier, ids } where `ids` are the license
 * ids that decided the verdict's worst branch. Legacy separators are accepted because real
 * lockfiles carry them: `MIT/Apache-2.0` (old Cargo style) reads as OR, and lowercase
 * operators read like uppercase. A malformed expression is DENIED, never guessed at.
 */
export function evaluateExpression(expression) {
  if (typeof expression !== 'string' || expression.trim() === '') return { tier: TIER.DENIED, ids: [] };
  const src = expression.replace(/\s*\/\s*/g, ' OR ').replace(/([()])/g, ' $1 ');
  const tokens = src.split(/\s+/).filter(Boolean);
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (t, op) => typeof t === 'string' && t.toUpperCase() === op;
  const fail = () => { throw new Error(`malformed SPDX expression: ${expression}`); };

  function parseOr() {
    let node = parseAnd();
    while (isOp(peek(), 'OR')) { pos++; node = { op: 'OR', left: node, right: parseAnd() }; }
    return node;
  }
  function parseAnd() {
    let node = parseWith();
    while (isOp(peek(), 'AND')) { pos++; node = { op: 'AND', left: node, right: parseWith() }; }
    return node;
  }
  function parseWith() {
    const node = parseAtom();
    if (isOp(peek(), 'WITH')) { pos++; if (!peek() || peek() === ')' || peek() === '(') fail(); pos++; }
    return node;
  }
  function parseAtom() {
    const t = peek();
    if (t === undefined) fail();
    if (t === '(') { pos++; const inner = parseOr(); if (peek() !== ')') fail(); pos++; return inner; }
    if (t === ')' || isOp(t, 'OR') || isOp(t, 'AND') || isOp(t, 'WITH')) fail();
    pos++;
    return { id: t };
  }
  function evalNode(node) {
    if (node.id) return { tier: tierOfId(node.id), ids: [node.id] };
    const a = evalNode(node.left);
    const b = evalNode(node.right);
    if (node.op === 'OR') return a.tier >= b.tier ? a : b;
    const tier = Math.min(a.tier, b.tier);
    return { tier, ids: [...a.ids, ...b.ids].filter((id) => tierOfId(id) === tier) };
  }

  try {
    const tree = parseOr();
    if (pos !== tokens.length) fail();
    return evalNode(tree);
  } catch {
    return { tier: TIER.DENIED, ids: [expression] };
  }
}

/**
 * The license string a lockfile entry declares. npm records `license` as a string, but
 * legacy packages carry an array of ids or of `{ type }` objects; those read as OR.
 * A package with no license field declares the sentinel `<none>`.
 */
export function declaredNpmLicense(entry) {
  const raw = entry?.license ?? entry?.licenses;
  if (raw === undefined || raw === null || raw === '') return '<none>';
  if (typeof raw === 'string') return raw;
  const items = (Array.isArray(raw) ? raw : [raw])
    .map((x) => (typeof x === 'string' ? x : x?.type))
    .filter((x) => typeof x === 'string' && x !== '');
  return items.length ? items.join(' OR ') : '<none>';
}

/** Every third-party package in one npm lockfile: { name, version, declared }. */
export function npmPackagesOf(lockJson) {
  const out = [];
  for (const [key, entry] of Object.entries(lockJson?.packages ?? {})) {
    if (!key.includes('node_modules/') || entry?.link) continue;
    const name = entry.name ?? key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    out.push({ name, version: entry.version ?? '?', declared: declaredNpmLicense(entry) });
  }
  return out;
}

/** Every registry/git crate in `cargo metadata` output (path crates are this repo's source). */
export function cargoPackagesOf(metadata) {
  return (metadata?.packages ?? [])
    .filter((p) => p.source !== null && p.source !== undefined)
    .map((p) => ({
      name: p.name,
      version: p.version,
      declared: p.license ?? (p.license_file ? `<license-file:${p.license_file}>` : '<none>'),
    }));
}

/**
 * Classify packages against the policy and the reviewed exceptions for one ecosystem.
 * Pure: every input is passed in, so the guard test runs on fixtures.
 */
export function classify(packages, exceptions = {}) {
  const seen = new Map();
  for (const pkg of packages) {
    const key = `${pkg.name}@${pkg.version}`;
    if (!seen.has(key)) seen.set(key, { ...pkg, lockfiles: new Set() });
    if (pkg.lockfile) seen.get(key).lockfiles.add(pkg.lockfile);
  }
  const rows = [];
  const usedExceptions = new Set();
  for (const pkg of seen.values()) {
    const exc = exceptions[pkg.name];
    let effective = pkg.declared;
    let tier;
    let via = 'declared';
    if (exc && exc.declared === pkg.declared) {
      usedExceptions.add(pkg.name);
      via = 'exception';
      if (exc.allow === true) { tier = TIER.PERMISSIVE; effective = `${pkg.declared} (reviewed exception)`; }
      else { effective = exc.license; tier = evaluateExpression(exc.license).tier; }
    } else {
      tier = evaluateExpression(pkg.declared).tier;
    }
    rows.push({ ...pkg, lockfiles: [...pkg.lockfiles].sort(), effective, tier, via,
      exceptionMismatch: exc && exc.declared !== pkg.declared ? exc.declared : null });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const stale = Object.keys(exceptions).filter((n) => !n.startsWith('$') && !usedExceptions.has(n)).sort();
  return {
    rows,
    denied: rows.filter((r) => r.tier === TIER.DENIED),
    weakCopyleft: rows.filter((r) => r.tier === TIER.WEAK_COPYLEFT),
    permissive: rows.filter((r) => r.tier === TIER.PERMISSIVE),
    stale,
  };
}

/** Validate the exceptions file shape; a malformed entry must not silently admit anything. */
export function validateExceptions(file) {
  const problems = [];
  for (const eco of ['npm', 'cargo']) {
    for (const [name, exc] of Object.entries(file?.[eco] ?? {})) {
      if (name.startsWith('$')) continue;
      if (typeof exc?.declared !== 'string') problems.push(`${eco}:${name} has no "declared" string`);
      if (typeof exc?.reason !== 'string' || exc.reason.trim().length < 10) problems.push(`${eco}:${name} has no real "reason"`);
      const hasLicense = typeof exc?.license === 'string';
      if (hasLicense === (exc?.allow === true)) problems.push(`${eco}:${name} needs exactly one of "license" or "allow": true`);
      if (hasLicense && evaluateExpression(exc.license).tier === TIER.DENIED) {
        problems.push(`${eco}:${name} "license" ${exc.license} is itself denied — use "allow": true with a reason if it is deliberately permitted`);
      }
    }
  }
  return problems;
}

// ── Installer leg ───────────────────────────────────────────────────────────────
//
// The lockfile legs above cover the dependency GRAPH. A finished installer also carries
// payloads no lockfile names: the Node runtime, PostgreSQL client tools, gh, kopia, zellij,
// a container root filesystem, WebKitGTK in the AppImage, MinGit on Windows, and AI model
// weights. Syft identifies some of these (Go modules inside gh, Debian packages in the
// rootfs) but, measured on the 0.0.22 Server .deb, names a license for almost none of them.
// So the installer leg does not trust Syft for licenses. Every Syft package and every native
// binary or model file found by walking the tree must be ATTRIBUTED:
//   1. to a reviewed component in scripts/installer-components.json (path globs), or
//   2. to the npm package whose directory contains it (that package's license, already
//      gated by the lockfile leg, covers its bundled binaries — but NEVER a model file), or
//   3. to its own Syft-detected license, evaluated under the same policy.
// Anything left over is UNREVIEWED and fails the gate. Model weights always need an explicit
// `kind: "model"` component, because an npm package's code license says nothing about them.

export const INSTALLER_COMPONENTS_PATH = join(HERE, 'installer-components.json');
export const COMPONENT_KINDS = Object.freeze(['first-party', 'program', 'library', 'model', 'os-image', 'bundle']);
const MODEL_FILE = /\.(onnx|gguf|safetensors|ppn|pv|tflite)$|\.onnx_data(_\d+)?$/i;
const NESTED_ARCHIVE = /\.(tar|tgz|tar\.gz|tar\.xz|tar\.bz2|tar\.zst)$/i;

/** 'model' | 'native' | null for one file, from its path and its first four bytes. */
export function payloadKindOf(relPath, head) {
  if (MODEL_FILE.test(relPath)) return 'model';
  if (!head || head.length < 4) return null;
  if (head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) return 'native'; // ELF
  // 'MZ' alone is common in text, so a PE needs a PE extension too.
  if (head[0] === 0x4d && head[1] === 0x5a && /\.(exe|dll|sys|node|com)$/i.test(relPath)) return 'native';
  const magic = head.readUInt32BE(0);
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic)) return 'native'; // Mach-O
  // Universal Mach-O shares 0xcafebabe with Java class files.
  if (magic === 0xcafebabe && !/\.class$/i.test(relPath)) return 'native';
  return null;
}

/** A path glob → RegExp over '/'-separated relative paths: `**` spans dirs, `*` and `?` do not. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\!]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** The node_modules/<pkg> (or node_modules/@scope/pkg) directory containing a path, if any. */
export function npmPackageRootOf(relPath) {
  const marker = 'node_modules/';
  const i = relPath.lastIndexOf(marker);
  if (i < 0) return null;
  const rest = relPath.slice(i + marker.length).split('/');
  const n = rest[0]?.startsWith('@') ? 2 : 1;
  if (rest.length <= n) return null; // the path IS the package directory, not inside it
  return relPath.slice(0, i) + marker + rest.slice(0, n).join('/');
}

/** Validate the installer component manifest; a malformed entry must not cover anything. */
export function validateComponents(file) {
  const problems = [];
  const list = file?.components;
  if (!Array.isArray(list) || list.length === 0) return ['installer-components.json has no "components" array'];
  list.forEach((c, i) => {
    const id = `components[${i}]${typeof c?.name === 'string' ? ` (${c.name})` : ''}`;
    if (typeof c?.name !== 'string' || !c.name.trim()) problems.push(`${id} has no "name"`);
    if (!COMPONENT_KINDS.includes(c?.kind)) problems.push(`${id} "kind" must be one of ${COMPONENT_KINDS.join(', ')}`);
    if (!Array.isArray(c?.paths) || c.paths.length === 0 || c.paths.some((p) => typeof p !== 'string' || !p)) problems.push(`${id} needs a non-empty "paths" array of globs`);
    if (typeof c?.reason !== 'string' || c.reason.trim().length < 10) problems.push(`${id} has no real "reason"`);
    const hasLicense = typeof c?.license === 'string';
    if (hasLicense === (c?.allow === true)) problems.push(`${id} needs exactly one of "license" or "allow": true`);
    if (c?.aggregate === true && !['program', 'os-image'].includes(c?.kind)) problems.push(`${id} "aggregate" applies only to a separate program or an OS image`);
    if (hasLicense && evaluateExpression(c.license).tier === TIER.DENIED && c?.aggregate !== true) {
      problems.push(`${id} license ${c.license} is denied — mark "aggregate": true only if it ships as a separate program, or "allow": true with a reason`);
    }
  });
  return problems;
}

/** Verdict for one reviewed component: { tier, label }. 'aggregate' = a denied-tier license
 *  on a separate program, allowed with its obligations (source offer) and listed. */
function componentVerdict(c) {
  if (c.allow === true) return { tier: TIER.PERMISSIVE, label: 'reviewed exception' };
  const t = evaluateExpression(c.license).tier;
  if (t === TIER.DENIED && c.aggregate === true) return { tier: TIER.WEAK_COPYLEFT, label: 'aggregate' };
  return { tier: t, label: TIER_NAME[t] };
}

/**
 * Attribute every installer item. Pure over its inputs so the guard test runs on fixtures.
 *   payloads       [{ path, kind: 'native'|'model' }]         from the tree walk
 *   syftArtifacts  [{ type, name, version, licenses: [], path }]
 *   components     parsed installer-components.json `components`
 *   npmExceptions  license-exceptions.json `npm` (npm packages use the lockfile leg's rules)
 *
 * @param {{
 *   payloads?: Array<{ path: string, kind: string }>,
 *   syftArtifacts?: Array<{ type: string, name: string, version: string, licenses: string[], path: string }>,
 *   components?: Array<{ name: string, kind: string, paths: string[], license?: string, allow?: boolean, aggregate?: boolean, reason?: string, obligations?: string }>,
 *   npmExceptions?: Record<string, { declared: string, license?: string, allow?: boolean, reason?: string }>,
 * }} input
 */
export function attributeInstaller({ payloads = [], syftArtifacts = [], components = [], npmExceptions = {} }) {
  const compiled = components.map((c) => ({ c, res: c.paths.map(globToRegExp), verdict: componentVerdict(c), hits: 0 }));
  const componentFor = (p) => compiled.find((x) => x.res.some((re) => re.test(p))) ?? null;
  const denied = [];
  const unreviewed = [];
  let covered = 0;

  const npm = [];
  for (const a of syftArtifacts) {
    const comp = componentFor(a.path);
    if (a.type === 'npm' && !comp) {
      // A package.json that is not node_modules/<pkg>/package.json but sits INSIDE an npm
      // package (resolve's test fixtures, web-streams-polyfill's es6/ entry stubs) is a file
      // of that package, covered by its license — not a separately installed package.
      const root = npmPackageRootOf(a.path);
      if (root && a.path !== `${root}/package.json`) { covered++; continue; }
      npm.push(a);
      continue;
    }
    if (comp) { comp.hits++; covered++; continue; }
    if (npmPackageRootOf(a.path)) { covered++; continue; }
    if (a.licenses.length) {
      const expr = a.licenses.join(' OR ');
      if (evaluateExpression(expr).tier === TIER.DENIED) denied.push({ what: `${a.type}:${a.name}@${a.version}`, path: a.path, why: `license "${expr}"` });
      else covered++;
      continue;
    }
    unreviewed.push({ what: `${a.type}:${a.name}@${a.version}`, path: a.path, why: 'no license detected and no reviewed component covers it' });
  }

  const npmResult = classify(
    npm.map((a) => ({ name: a.name, version: a.version, declared: a.licenses.length ? a.licenses.join(' OR ') : '<none>', lockfile: a.path })),
    npmExceptions,
  );
  covered += npmResult.permissive.length + npmResult.weakCopyleft.length;
  for (const r of npmResult.denied) denied.push({ what: `npm:${r.name}@${r.version}`, path: r.lockfiles[0], why: `license "${r.declared}"` });

  for (const p of payloads) {
    const comp = componentFor(p.path);
    if (p.kind === 'model') {
      if (comp && comp.c.kind === 'model') { comp.hits++; covered++; }
      else unreviewed.push({ what: 'model', path: p.path, why: 'model weights need a reviewed kind:"model" component (a package code license does not cover them)' });
      continue;
    }
    if (comp) { comp.hits++; covered++; continue; }
    if (npmPackageRootOf(p.path)) { covered++; continue; }
    unreviewed.push({ what: 'native binary', path: p.path, why: 'no reviewed component or containing npm package' });
  }

  const used = compiled.filter((x) => x.hits > 0);
  for (const x of used) if (x.verdict.tier === TIER.DENIED) denied.push({ what: `component:${x.c.name}`, path: x.c.paths[0], why: `license "${x.c.license}"` });
  return {
    covered,
    denied,
    unreviewed,
    npmWeakCopyleft: npmResult.weakCopyleft,
    components: used.map((x) => ({ name: x.c.name, kind: x.c.kind, license: x.c.license ?? '(reviewed exception)', verdict: x.verdict.label, hits: x.hits, obligations: x.c.obligations ?? null })),
    unusedComponents: compiled.filter((x) => x.hits === 0).map((x) => x.c.name),
  };
}

function readHead(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(4);
    const n = readSync(fd, buf, 0, 4, 0);
    return n === 4 ? buf : null;
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}

function runSyft(dir) {
  const out = join(mkdtempSync(join(tmpdir(), 'papercusp-license-syft-')), 'syft.json');
  execFileSync('syft', [`dir:${dir}`, '--select-catalogers', '+javascript-package-cataloger', '-q', '-o', `syft-json=${out}`], {
    stdio: ['ignore', 'ignore', 'pipe'], timeout: 1_800_000, env: { ...process.env, SYFT_CHECK_FOR_APP_UPDATE: 'false' },
  });
  return (readJson(out).artifacts ?? []).map((a) => ({
    type: a.type,
    name: a.name,
    version: a.version ?? '?',
    licenses: [...new Set((a.licenses ?? []).map((l) => l.spdxExpression || l.value).filter(Boolean))],
    path: String(a.locations?.[0]?.path ?? '').replace(/^\/+/, ''),
  }));
}

/**
 * Walk one unpacked installer tree: native/model payloads + Syft artifacts, with nested
 * tarballs expanded (members addressed as `<archive>!/<member>`) unless a reviewed
 * component already covers the archive whole.
 */
export function collectInstallerTree(root, components, prefix = '', depth = 0) {
  const compiled = components.map((c) => c.paths.map(globToRegExp));
  const coveredWhole = (p) => compiled.some((res) => res.some((re) => re.test(p)));
  const payloads = [];
  let files = 0;
  let npmPackageDirs = 0;
  const nested = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    for (const ent of readdirSync(join(root, rel), { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (basename(rel) === 'node_modules' && !ent.name.startsWith('.')) npmPackageDirs++;
        stack.push(childRel);
        continue;
      }
      if (!ent.isFile()) continue;
      files++;
      const full = prefix + childRel;
      if (NESTED_ARCHIVE.test(ent.name) && !full.includes('node_modules/') && !coveredWhole(full)) { nested.push(childRel); continue; }
      const kind = payloadKindOf(full, readHead(join(root, childRel)));
      if (kind) payloads.push({ path: full, kind });
    }
  }
  const syftArtifacts = runSyft(root).map((a) => ({ ...a, path: prefix + a.path }));
  const undetermined = [];
  if (files === 0) undetermined.push(`${prefix || root}: tree has no files`);
  if (npmPackageDirs > 0 && !syftArtifacts.some((a) => a.type === 'npm')) {
    undetermined.push(`${prefix || root}: ${npmPackageDirs} installed npm package dirs but Syft catalogued 0 npm packages (check \`syft cataloger list | grep javascript\`)`);
  }
  for (const rel of nested) {
    if (depth >= 2) { undetermined.push(`${prefix}${rel}: nested archive deeper than 2 levels`); continue; }
    const dest = mkdtempSync(join(tmpdir(), 'papercusp-license-nested-'));
    try {
      execFileSync('tar', ['-xf', join(root, rel), '-C', dest, '--no-same-owner'], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 1_800_000 });
    } catch (err) {
      undetermined.push(`${prefix}${rel}: could not expand — ${String(err.stderr || err.message).trim().split('\n').pop()}`);
      rmSync(dest, { recursive: true, force: true });
      continue;
    }
    const inner = collectInstallerTree(dest, components, `${prefix}${rel}!/`, depth + 1);
    payloads.push(...inner.payloads);
    syftArtifacts.push(...inner.syftArtifacts);
    undetermined.push(...inner.undetermined);
    rmSync(dest, { recursive: true, force: true });
  }
  return { payloads, syftArtifacts, undetermined, files };
}

function installerMain(args, exceptionsFile) {
  const componentsFile = readJson(INSTALLER_COMPONENTS_PATH);
  const problems = validateComponents(componentsFile);
  if (problems.length) {
    for (const p of problems) console.error(`LICENSE_GATE_COMPONENT_INVALID ${p}`);
    console.log('LICENSE_GATE_RESULT status=fail reason=invalid-installer-components');
    return 1;
  }
  let failed = false;
  let undetermined = false;
  for (const tree of args.installerTrees) {
    if (!existsSync(tree)) { console.log(`  UNDETERMINED ${tree}: does not exist`); undetermined = true; continue; }
    let collected;
    try { collected = collectInstallerTree(tree, componentsFile.components); } catch (err) {
      console.log(`  UNDETERMINED ${tree}: ${String(err.stderr || err.message).trim().split('\n').pop()}`);
      undetermined = true;
      continue;
    }
    const r = attributeInstaller({ payloads: collected.payloads, syftArtifacts: collected.syftArtifacts, components: componentsFile.components, npmExceptions: exceptionsFile.npm ?? {} });
    console.log(`LICENSE_GATE ecosystem=installer tree=${tree} files=${collected.files} syftPackages=${collected.syftArtifacts.length} ` +
      `payloads=${collected.payloads.length} covered=${r.covered} denied=${r.denied.length} unreviewed=${r.unreviewed.length}`);
    for (const c of r.components) {
      if (c.verdict !== 'permissive' || args.list) console.log(`  component ${c.verdict.padEnd(18)} ${c.name} — ${c.license} (${c.hits} item(s))${c.obligations ? ` — ${c.obligations}` : ''}`);
    }
    for (const d of r.denied) console.log(`  DENIED ${d.what}  ${d.path} — ${d.why}`);
    for (const u of r.unreviewed) console.log(`  UNREVIEWED ${u.what}  ${u.path} — ${u.why}; add a component to scripts/installer-components.json after reading its license`);
    for (const u of collected.undetermined) console.log(`  UNDETERMINED ${u}`);
    if (r.denied.length || r.unreviewed.length) failed = true;
    if (collected.undetermined.length) undetermined = true;
  }
  if (undetermined) {
    console.log('LICENSE_GATE_RESULT status=undetermined — part of the installer was not measured; re-run');
    return 2;
  }
  console.log(`LICENSE_GATE_RESULT status=${failed ? 'fail' : 'pass'}`);
  return failed && args.strict ? 1 : 0;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function collectNpm(root, lockfiles) {
  const packages = [];
  const empty = [];
  for (const rel of lockfiles) {
    const pkgs = npmPackagesOf(readJson(join(root, rel)));
    // A lockfile whose package has no dependencies legitimately yields zero rows, so only
    // the ROOT lockfile is a positive control: it structurally carries the whole tree.
    if (rel === 'package-lock.json' && pkgs.length === 0) empty.push(rel);
    for (const p of pkgs) packages.push({ ...p, lockfile: rel });
  }
  return { packages, undetermined: empty.map((f) => `${f}: parsed 0 packages`) };
}

function cargoMetadata(dir) {
  const base = ['metadata', '--format-version', '1', '--locked'];
  const opts = { cwd: dir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000 };
  try {
    return JSON.parse(execFileSync('cargo', [...base, '--offline'], opts));
  } catch {
    return JSON.parse(execFileSync('cargo', base, opts));
  }
}

function collectCargo(root, lockfiles) {
  const packages = [];
  const undetermined = [];
  for (const rel of lockfiles) {
    const dir = join(root, dirname(rel));
    if (!existsSync(join(dir, 'Cargo.toml'))) { undetermined.push(`${rel}: no Cargo.toml beside it`); continue; }
    let meta;
    try { meta = cargoMetadata(dir); } catch (err) {
      undetermined.push(`${rel}: cargo metadata failed — ${String(err.stderr || err.message).split('\n').filter(Boolean).slice(-1)[0]}`);
      continue;
    }
    if (!Array.isArray(meta?.packages) || meta.packages.length === 0) { undetermined.push(`${rel}: cargo metadata returned no packages`); continue; }
    for (const p of cargoPackagesOf(meta)) packages.push({ ...p, lockfile: rel });
  }
  return { packages, undetermined };
}

// ── THIRD-PARTY-NOTICES (P-017 step 5) ──────────────────────────────────────────
// The public export ships a notices file generated from ITS OWN lockfiles by the same
// census + collectors + classifier the gate uses, so the file can never list a different
// dependency set from the one the gate judged, and it needs no committed copy to drift.

export const NOTICES_FILE = 'THIRD-PARTY-NOTICES.md';

/**
 * Render the notices document. Pure over its inputs so the guard test runs on fixtures.
 * @param {{ npm?: Array<{name:string,version:string,effective:string,tier:number}>, cargo?: Array<{name:string,version:string,effective:string,tier:number}> }} rowsByEco
 * @param {{ installerComponents?: Array<{ name: string, license?: string, allow?: boolean, obligations?: string }>, sourceOfferRepo?: string }} [opts]
 */
export function renderThirdPartyNotices(rowsByEco, { installerComponents = [], sourceOfferRepo = 'Papercusp/papercusp-app' } = {}) {
  const lines = [
    '# Third-party notices',
    '',
    'Papercusp depends on the third-party packages listed below. Each keeps its own license;',
    'the Elastic License 2.0 in LICENSE covers only Papercusp\'s own code. This file is',
    'generated from the lockfiles in this tree by scripts/check-licenses.mjs (the same',
    'classifier the license gate runs), so it lists exactly the dependency set that was checked.',
    '',
    'Packages under a weak-copyleft license (MPL, LGPL, EPL) are used unmodified; their',
    'source is available from the registry named by each ecosystem, and their license terms',
    'apply only to their own files.',
  ];
  for (const [eco, title] of [['npm', 'npm packages'], ['cargo', 'Rust crates']]) {
    const rows = rowsByEco[eco] ?? [];
    if (rows.length === 0) continue;
    const byLicense = new Map();
    for (const r of rows) {
      const lic = r.effective || 'UNKNOWN';
      if (!byLicense.has(lic)) byLicense.set(lic, new Set());
      byLicense.get(lic).add(`${r.name}@${r.version}`);
    }
    const uniq = new Set(rows.map((r) => `${r.name}@${r.version}`)).size;
    lines.push('', `## ${title} (${uniq})`);
    for (const lic of [...byLicense.keys()].sort()) {
      const pkgs = [...byLicense.get(lic)].sort();
      lines.push('', `### ${lic} (${pkgs.length})`, '', pkgs.join(', '));
    }
  }
  // P-015: the desktop installers carry components beyond the lockfiles (runtime libraries,
  // tools, models). Each reviewed component and the obligation its license imposes is listed
  // here, and GPL/LGPL components get a written source offer.
  const components = (installerComponents ?? []).filter((c) => c && c.name);
  if (components.length > 0) {
    lines.push(
      '',
      `## Components shipped in the desktop installers (${components.length})`,
      '',
      'The desktop installers (AppImage, .deb, macOS and Windows bundles) also contain the',
      'components below. They are reviewed in scripts/installer-components.json and checked by',
      'the installer license gate (scripts/check-licenses.mjs --installer-tree).',
    );
    for (const c of [...components].sort((a, b) => a.name.localeCompare(b.name))) {
      const license = c.license || (c.allow ? 'reviewed exception' : 'see component');
      lines.push('', `### ${c.name}`, '', `License: ${license}`);
      if (c.obligations) lines.push('', c.obligations);
    }
    const copyleft = components.filter((c) => /\b(?:L?GPL|AGPL)/.test(c.license ?? '') || /\bsource\b/i.test(c.obligations ?? ''));
    if (copyleft.length > 0) {
      lines.push(
        '',
        '## Written offer for corresponding source',
        '',
        'Some installer components are licensed under the GNU GPL or LGPL:',
        '',
        ...copyleft.map((c) => `- ${c.name}`),
        '',
        'They are shipped unmodified. For at least three years after each release, anyone may',
        'request the complete corresponding source of these components, for that release, by',
        `opening an issue at https://github.com/${sourceOfferRepo}/issues. Most of them are`,
        'unmodified distribution packages whose source is also available from the distribution',
        'archive named in the component entry (for example the Ubuntu archive).',
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Collect every package under `root` (lockfile census) and render the notices file.
 * `undetermined` non-empty means part of the graph was not measured — callers must not
 * publish the text as complete.
 */
export function collectThirdPartyNotices(root, { ecosystems = ['npm', 'cargo'] } = {}) {
  const exceptionsFile = readJson(EXCEPTIONS_PATH);
  const census = censusOrThrow(root);
  const rowsByEco = {};
  const undetermined = [];
  for (const eco of ecosystems) {
    const lockfiles = census.filter((f) => basename(f) === (eco === 'npm' ? 'package-lock.json' : 'Cargo.lock'));
    const collected = eco === 'npm' ? collectNpm(root, lockfiles) : collectCargo(root, lockfiles);
    rowsByEco[eco] = classify(collected.packages, exceptionsFile[eco] ?? {}).rows;
    undetermined.push(...collected.undetermined.map((u) => `${eco}: ${u}`));
    if (eco === 'npm' && rowsByEco[eco].length === 0) undetermined.push('npm: no packages collected');
  }
  const installerComponents = readJson(INSTALLER_COMPONENTS_PATH).components ?? [];
  return { text: renderThirdPartyNotices(rowsByEco, { installerComponents }), undetermined, rowsByEco };
}

function parseArgs(argv) {
  const args = { strict: false, list: false, ecosystem: 'all', installerTrees: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--strict') args.strict = true;
    else if (a === '--list') args.list = true;
    else if (a === '--installer-tree') args.installerTrees.push(argv[++i]);
    else if (a === '--notices') args.notices = argv[++i];
    else if (a === '--ecosystem') args.ecosystem = argv[++i];
    else if (a.startsWith('--ecosystem=')) args.ecosystem = a.slice('--ecosystem='.length);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!['all', 'npm', 'cargo'].includes(args.ecosystem)) throw new Error(`--ecosystem must be npm, cargo or all (got ${args.ecosystem})`);
  return args;
}

export function main(argv = process.argv.slice(2), root = ROOT) {
  const args = parseArgs(argv);
  const exceptionsFile = readJson(EXCEPTIONS_PATH);
  const problems = validateExceptions(exceptionsFile);
  if (problems.length) {
    for (const p of problems) console.error(`LICENSE_GATE_EXCEPTION_INVALID ${p}`);
    console.log('LICENSE_GATE_RESULT status=fail reason=invalid-exceptions');
    return 1;
  }
  if (args.installerTrees.length) return installerMain(args, exceptionsFile);
  if (args.notices) {
    const { text, undetermined: missing } = collectThirdPartyNotices(root, {
      ecosystems: args.ecosystem === 'all' ? ['npm', 'cargo'] : [args.ecosystem],
    });
    for (const u of missing) console.log(`  UNDETERMINED ${u}`);
    if (missing.length) { console.log('LICENSE_NOTICES_RESULT status=undetermined'); return 2; }
    writeFileSync(args.notices, text);
    console.log(`LICENSE_NOTICES_RESULT status=written path=${args.notices}`);
    return 0;
  }

  const census = censusOrThrow(root);
  const ecosystems = args.ecosystem === 'all' ? ['npm', 'cargo'] : [args.ecosystem];
  let failed = false;
  let undetermined = false;

  for (const eco of ecosystems) {
    const lockfiles = census.filter((f) => basename(f) === (eco === 'npm' ? 'package-lock.json' : 'Cargo.lock'));
    const collected = eco === 'npm' ? collectNpm(root, lockfiles) : collectCargo(root, lockfiles);
    const result = classify(collected.packages, exceptionsFile[eco] ?? {});

    console.log(`LICENSE_GATE ecosystem=${eco} lockfiles=${lockfiles.length} packages=${result.rows.length} ` +
      `permissive=${result.permissive.length} weakCopyleft=${result.weakCopyleft.length} denied=${result.denied.length} ` +
      `viaException=${result.rows.filter((r) => r.via === 'exception').length}`);

    if (args.list) for (const r of result.rows) console.log(`  ${TIER_NAME[r.tier].padEnd(13)} ${r.name}@${r.version}  ${r.effective}`);

    if (result.weakCopyleft.length) {
      const byLicense = new Map();
      for (const r of result.weakCopyleft) byLicense.set(r.effective, [...(byLicense.get(r.effective) ?? []), r.name]);
      console.log(`  weak-copyleft (allowed; ship each license + honour file-level terms):`);
      for (const [lic, names] of [...byLicense].sort()) console.log(`    ${lic}: ${[...new Set(names)].join(', ')}`);
    }
    for (const r of result.denied) {
      const hint = r.exceptionMismatch
        ? `declared license changed from the reviewed "${r.exceptionMismatch}" — re-review it`
        : `remove the dependency, or review its license text and add it to scripts/license-exceptions.json`;
      console.log(`  DENIED ${r.name}@${r.version}  "${r.declared}"  (${r.lockfiles.join(', ')}) — ${hint}`);
    }
    for (const n of result.stale) console.log(`  STALE exception ${eco}:${n} — no longer in any lockfile; delete the entry`);
    for (const u of collected.undetermined) console.log(`  UNDETERMINED ${u}`);

    if (result.denied.length) failed = true;
    if (collected.undetermined.length || (eco === 'npm' && result.rows.length === 0)) undetermined = true;
  }

  if (undetermined) {
    console.log('LICENSE_GATE_RESULT status=undetermined — part of the dependency graph was not measured; re-run');
    return 2;
  }
  console.log(`LICENSE_GATE_RESULT status=${failed ? 'fail' : 'pass'}`);
  return failed && args.strict ? 1 : 0;
}

// Basename pin (symlink-robust), matching check-lockfile-census.mjs.
if (basename(process.argv[1] ?? '') === 'check-licenses.mjs') {
  process.exitCode = main();
}
