// Committed-source loader (WI-10005764 — residue of WI-10005745, plan
// personal-data-reader-set-labels-2026-10-01, Decisions D-011/D-012).
//
// The restricted-hold census decides whether code a restricted session wrote may run with the
// network. The census itself is ~5,600 operator-core modules in the SAME shared tree, so a held
// restricted write INTO that closure would execute inside the unrestricted census process before
// any refusal could happen. D-011 keeps restricted writes out of every commit, so a file's HEAD
// blob is a source no restricted session can have written. Loaded as
//
//     node --import <this file> --import tsx <entry>      (THIS FIRST — see below)
//
// it makes that process execute only committed bytes for every ES module inside a git checkout:
//   committed    the bytes read equal the file's HEAD blob (git's own blob hash): they run as read;
//   substituted  the bytes differ from HEAD: the HEAD blob runs instead, so a dirty file runs its
//                committed version (one stderr line names it);
//   uncommitted  no HEAD blob and git does not ignore the path: it can only be new, uncommitted
//                code, so loading it throws and the census fails closed;
//   commonjs     a checkout module reached through CommonJS throws: that path never passes the ES
//                load hook, so its bytes cannot be judged. The census closure is ES-only; the
//                committed-source tests pin that by running the real census under this loader.
// Outside every checkout (node's own modules) and under node_modules, bytes run as read: those
// paths are not tracked, so the census could not see a restricted write there either.
//
// Order matters: hooks registered later run FIRST. Registered before tsx, tsx's load hook calls
// this one through nextLoad for the raw bytes and then transforms whatever this one returns.
// Resolution is unchanged (on disk), so a HEAD version importing a path that is gone from disk
// fails to resolve — fail-closed again, never an unjudged run.
//
// Dependency-free (node: builtins only) on purpose. This is defense-in-depth for source identity,
// not the trust root for network permission: it and the door that loads it run from the live tree.
// The already-running operator boundary must decide source holds before it spawns integration-tree
// code; the installed PreToolUse hook applies that same decision to client-native egress.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync } from 'node:fs';
import Module, { register } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { threadId } from 'node:worker_threads';

/** When set to a file path, one JSON line per judged module is appended there (tests, debugging). */
export const COMMITTED_SOURCE_AUDIT_ENV = 'PAPERCUSP_COMMITTED_SOURCE_AUDIT';
/** Prefix of every line this loader writes to stderr. */
export const COMMITTED_SOURCE_MARKER = 'COMMITTED_SOURCE';

const HOOKS_QUERY = 'committed-source-hooks';
const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

/** git's object id for `bytes` as a blob, in the object format `like` uses (sha1 or sha256). */
export function gitBlobId(bytes, like = '') {
  const algorithm = like.length === 64 ? 'sha256' : 'sha1';
  return createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

const topByDir = new Map();
/** The working-tree root of the innermost checkout (superproject or submodule) holding `file`, or null. */
function checkoutTop(file) {
  const seen = [];
  let dir = dirname(file);
  for (;;) {
    if (topByDir.has(dir)) {
      const top = topByDir.get(dir);
      for (const d of seen) topByDir.set(d, top);
      return top;
    }
    seen.push(dir);
    if (existsSync(join(dir, '.git'))) {
      for (const d of seen) topByDir.set(d, dir);
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      for (const d of seen) topByDir.set(d, null);
      return null;
    }
    dir = parent;
  }
}

function git(top, args, opts = {}) {
  return execFileSync('git', ['-C', top, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
}

const treeByTop = new Map();
/** `relative path -> blob id` for every file in `top`'s HEAD commit. Throws when HEAD is unreadable. */
function headTree(top) {
  let tree = treeByTop.get(top);
  if (tree) return tree;
  tree = new Map();
  const out = git(top, ['ls-tree', '-r', '-z', '--full-tree', 'HEAD']).toString('utf8');
  for (const entry of out.split('\0')) {
    if (!entry) continue;
    const tab = entry.indexOf('\t');
    const [mode, type, id] = entry.slice(0, tab).split(' ');
    if (type === 'blob' && mode !== '120000') tree.set(entry.slice(tab + 1), id);
  }
  treeByTop.set(top, tree);
  return tree;
}

function isIgnored(top, rel) {
  try {
    git(top, ['check-ignore', '-q', '--', rel]);
    return true;
  } catch (error) {
    if (error && error.status === 1) return false;
    throw error;
  }
}

/** Where `file` sits: outside every checkout, under node_modules, or a checkout path. */
function locate(file) {
  const top = checkoutTop(file);
  if (!top) return { place: 'outside' };
  const rel = relative(top, file).split(sep).join('/');
  if (rel.split('/').includes('node_modules')) return { place: 'dependency', top, rel };
  return { place: 'checkout', top, rel };
}

/**
 * Judge the bytes about to run for `file`.
 * @returns {{ kind: 'outside' | 'dependency' | 'committed' | 'ignored', rel?: string, top?: string }
 *   | { kind: 'substituted', rel: string, top: string, head: Buffer }
 *   | { kind: 'uncommitted', rel: string, top: string }}
 */
export function judgeModuleBytes(file, bytes) {
  const where = locate(file);
  if (where.place !== 'checkout') return { kind: where.place, rel: where.rel, top: where.top };
  const { top, rel } = where;
  const id = headTree(top).get(rel);
  if (id === undefined) return { kind: isIgnored(top, rel) ? 'ignored' : 'uncommitted', rel, top };
  if (gitBlobId(bytes, id) === id) return { kind: 'committed', rel, top };
  return { kind: 'substituted', rel, top, head: git(top, ['cat-file', 'blob', id]) };
}

function audit(record) {
  const target = process.env[COMMITTED_SOURCE_AUDIT_ENV];
  if (target) appendFileSync(target, `${JSON.stringify(record)}\n`);
}

function toBuffer(source) {
  if (typeof source === 'string') return Buffer.from(source, 'utf8');
  if (source instanceof ArrayBuffer) return Buffer.from(source);
  return Buffer.from(source.buffer, source.byteOffset, source.byteLength);
}

/** Observe this hook's return boundary only. A later hook (for example tsx)
 * can transform these bytes; this is not the final executed runtime identity.
 * Hash the actual supplied/returned buffers, never disk or a later HEAD read. */
function auditLoad(file, result, verdict, input, returned) {
  // The channel is optional; do not hash an entire module graph when disabled.
  if (!process.env[COMMITTED_SOURCE_AUDIT_ENV]) return;
  audit({
    via: 'esm', kind: verdict.kind, file, rel: verdict.rel ?? null,
    schemaVersion: 'committed-source-load-receipt-v1', boundary: 'node-esm-load-return',
    pid: process.pid, threadId, format: result.format ?? null,
    inputSha256: createHash('sha256').update(input).digest('hex'),
    returnedSha256: returned === null ? null : createHash('sha256').update(returned).digest('hex'),
    returnedByteLength: returned === null ? null : returned.length,
    unresolved: ['later-loader-transforms-unmeasured', 'loader-self-unmeasured'],
  });
}

/** ES `load` hook (hooks thread). */
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.startsWith('file:') || result.source == null) return result;
  const file = fileURLToPath(url);
  const input = toBuffer(result.source);
  const verdict = judgeModuleBytes(file, input);
  const returned = verdict.kind === 'uncommitted' ? null :
    verdict.kind === 'substituted' ? verdict.head : input;
  auditLoad(file, result, verdict, input, returned);
  if (verdict.kind === 'uncommitted') {
    throw new Error(
      `${COMMITTED_SOURCE_MARKER} refused ${verdict.rel}: it has no committed version and git does not ignore it, so it may be a held restricted write (checkout ${verdict.top})`,
    );
  }
  if (verdict.kind === 'substituted') {
    process.stderr.write(`${COMMITTED_SOURCE_MARKER} substituted ${verdict.rel}: the working tree differs from HEAD, so the committed bytes ran\n`);
    return { ...result, source: verdict.head };
  }
  return result;
}

/** Refuse checkout modules compiled through CommonJS (registering thread). */
function guardCommonJs() {
  const compile = Module.prototype._compile;
  Module.prototype._compile = function committedSourceCompile(content, filename) {
    const where = locate(filename);
    if (where.place === 'checkout' && !isIgnored(where.top, where.rel)) {
      audit({ via: 'cjs', kind: 'commonjs', file: filename, rel: where.rel });
      throw new Error(
        `${COMMITTED_SOURCE_MARKER} refused ${where.rel}: a checkout module was loaded through CommonJS, which bypasses the committed-source check`,
      );
    }
    return compile.call(this, content, filename);
  };
}

// The same file serves as the --import entry and as the hooks module; the query string marks
// the hooks-thread instance so it does not register a second time.
if (!new URL(import.meta.url).searchParams.has(HOOKS_QUERY)) {
  const hooks = new URL(import.meta.url);
  hooks.searchParams.set(HOOKS_QUERY, '1');
  register(hooks.href);
  guardCommonJs();
}
