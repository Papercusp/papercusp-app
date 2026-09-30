#!/usr/bin/env node
// Pinned-lockfile dependency reconcile for the LIVE release tree (WI-10003918).
//
// setup-release-checkout.sh's deploy path copies node_modules from the LIVE
// integration tree, whose dependency set follows staging tip — not the pinned
// target's package-lock.json. With freeze-and-converge, `main` routinely trails
// staging by hours, so a dependency REMOVED (or re-versioned) on staging after the
// pin is simply absent from the copied tree. Measured 2026-09-29: @mdxeditor/editor
// removed at 206e23aa7c broke the SPA build of green pin 9a9473af AND of the rollback
// to the serving d425508f01 — :3070 froze 81 commits behind its green pin.
//
// Only paths where the pinned lock and the integration lock DISAGREE can be affected
// by that drift, so only those are checked (byte-identical locks short-circuit). A
// drifted path that is missing or at the wrong version in the release tree is
// backfilled, at exactly the pinned version, from an immutable dependency generation
// (dependency-generation.sh) that still holds it — a generation is a verified
// snapshot of an earlier integration install, so no network and no re-resolve.
// Whatever cannot be backfilled is NAMED and the exit code says so; the caller
// decides whether that is fatal.
//
// Standalone on purpose (node:* only): setup-release-checkout.sh must be able to
// rebuild the release tree while the operator it deploys is wedged.
//
// Usage:
//   pinned-lock-deps.mjs --pinned-lock <file> --integration-lock <file>
//                        --release <dir> [--generations <dir>] [--backfill]
// Exit: 0 = clean or fully backfilled · 3 = unresolved drift remains · 2 = misuse.

import { cpSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

const MAX_LISTED = 40;

function parseArgs(argv) {
  const opts = { backfill: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--backfill') opts.backfill = true;
    else if (arg === '--pinned-lock') opts.pinnedLock = argv[++i];
    else if (arg === '--integration-lock') opts.integrationLock = argv[++i];
    else if (arg === '--release') opts.release = argv[++i];
    else if (arg === '--generations') opts.generations = argv[++i];
    else throw new Error(`unknown arg: ${arg}`);
  }
  if (!opts.pinnedLock || !opts.integrationLock || !opts.release) {
    throw new Error('--pinned-lock, --integration-lock and --release are required');
  }
  return opts;
}

/**
 * Installed-package entries of a v2/v3 lockfile, keyed by repo-relative path.
 * Workspace links and optional packages are excluded: a link is not a package
 * payload, and an optional (platform-specific) package is legitimately absent.
 */
export function installedEntries(lock) {
  const out = new Map();
  for (const [path, entry] of Object.entries(lock?.packages ?? {})) {
    if (!path.includes('node_modules/')) continue;
    if (!entry || entry.link || entry.optional || entry.devOptional) continue;
    if (typeof entry.version !== 'string') continue;
    out.set(path, entry.version);
  }
  return out;
}

/** Pinned entries the integration lock does not declare at the same version. */
export function driftedPaths(pinned, integration) {
  const drift = [];
  for (const [path, version] of pinned) {
    if (integration.get(path) !== version) drift.push(path);
  }
  // Parents before children: backfilling a package dir replaces its nested
  // node_modules too, so nested paths must be re-checked after their parent.
  return drift.sort((a, b) => a.split('node_modules/').length - b.split('node_modules/').length || a.localeCompare(b));
}

function installedVersion(root, path) {
  try {
    return JSON.parse(readFileSync(join(root, path, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

/** Published generation trees, newest first (dot-prefixed entries are staging/metadata). */
function generationTrees(dir) {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^v\d+-[0-9a-f]+$/.test(name))
    .map((name) => ({ name, tree: join(dir, name, 'tree') }))
    .filter(({ tree }) => existsSync(tree))
    .sort((a, b) => statSync(b.tree).mtimeMs - statSync(a.tree).mtimeMs);
}

/** Replace <release>/<path> with an independent copy of <tree>/<path> (sibling-temp swap). */
function backfillFrom(tree, release, path) {
  const dest = join(release, path);
  const tmp = `${dest}.pinned-backfill.${process.pid}`;
  const old = `${dest}.pinned-backfill-old.${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  // Independent files, never hardlinks: generations are frozen read-only and a later
  // patch-package / native rebuild must not be able to reach one through a shared inode.
  cpSync(join(tree, path), tmp, { recursive: true, verbatimSymlinks: true });
  chmodRecursiveWritable(tmp);
  if (existsSync(dest)) renameSync(dest, old);
  renameSync(tmp, dest);
  rmSync(old, { recursive: true, force: true });
}

function chmodRecursiveWritable(dir) {
  const st = statSync(dir, { throwIfNoEntry: false });
  if (!st) return;
  chmodSync(dir, st.mode | 0o200);
  if (!st.isDirectory()) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const child = join(dir, entry.name);
    if (entry.isDirectory()) chmodRecursiveWritable(child);
    else chmodSync(child, statSync(child).mode | 0o200);
  }
}

export function reconcile({ pinnedLock, integrationLock, release, generations, backfill }) {
  const lines = [];
  const pinnedText = readFileSync(pinnedLock, 'utf8');
  const integrationText = existsSync(integrationLock) ? readFileSync(integrationLock, 'utf8') : '';
  if (pinnedText === integrationText) {
    lines.push('PINNED_LOCK_DEPS status=clean drifted=0 reason=locks-identical');
    return { code: 0, lines, unresolved: [], backfilled: [] };
  }
  const pinned = installedEntries(JSON.parse(pinnedText));
  const integration = integrationText ? installedEntries(JSON.parse(integrationText)) : new Map();
  const drifted = driftedPaths(pinned, integration);
  const trees = backfill ? generationTrees(generations) : [];
  const backfilled = [];
  const unresolved = [];
  for (const path of drifted) {
    const expected = pinned.get(path);
    const found = installedVersion(release, path);
    if (found === expected) continue;
    const source = trees.find(({ tree }) => installedVersion(tree, path) === expected);
    if (source) {
      backfillFrom(source.tree, release, path);
      if (installedVersion(release, path) === expected) {
        backfilled.push(path);
        lines.push(`PINNED_LOCK_DEPS_BACKFILL ${path} version=${expected} from=${source.name}`);
        continue;
      }
    }
    unresolved.push({ path, expected, found: found ?? 'missing' });
  }
  for (const u of unresolved.slice(0, MAX_LISTED)) {
    lines.push(`PINNED_LOCK_DEPS_UNRESOLVED ${u.path} expected=${u.expected} found=${u.found}`);
  }
  if (unresolved.length > MAX_LISTED) {
    lines.push(`PINNED_LOCK_DEPS_UNRESOLVED … ${unresolved.length - MAX_LISTED} more`);
  }
  const status = unresolved.length ? 'unresolved' : backfilled.length ? 'backfilled' : 'clean';
  lines.push(
    `PINNED_LOCK_DEPS status=${status} drifted=${drifted.length} backfilled=${backfilled.length} unresolved=${unresolved.length} generations=${trees.length}`,
  );
  return { code: unresolved.length ? 3 : 0, lines, unresolved, backfilled };
}

// Basename pin, not an import.meta.url comparison: this file must stay importable
// by tests without running, and must not import operator-core (standalone, above).
function isDirectCliInvocation(entryPath = process.argv[1]) {
  return typeof entryPath === 'string' && /(?:^|[\\/])pinned-lock-deps\.mjs$/.test(entryPath);
}

if (isDirectCliInvocation()) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[pinned-lock-deps] ${err.message}`);
    process.exit(2);
  }
  const result = reconcile(opts);
  for (const line of result.lines) console.log(line);
  // End naturally so a piped stdout drains before exit (undrained-stdout-exit-guard).
  process.exitCode = result.code;
}
