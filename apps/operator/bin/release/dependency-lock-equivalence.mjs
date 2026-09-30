#!/usr/bin/env node
// Install-equivalence of an exact ref's dependency inputs vs the LIVE tree's (WI-10004151).
//
// dependency-generation.sh `--ensure-ref <ref>` used to publish ONLY from the live
// integration tree and then re-open by the ref's input key. When the ref's lockfiles differ
// from the live tree's, that re-open is a permanent typed miss (exit 74): no installed tree
// ever had the ref's inputs. The frozen repair queue produces exactly that case — a
// hunk-exact package-lock.json admission yields a lock no checkout has installed — and the
// green-checkpoint verify then stalled with no way forward (2026-09-30, repairHead 5955f82b).
//
// The ref is buildable WITHOUT an install when its lock describes the same installed
// packages as the live lock: every `node_modules/…` entry agrees on version / resolved /
// integrity / link, and the only live-only entries are workspace LINKS (a staging-only
// workspace the ref does not have). The exact generation is then the live trees minus those
// links. This helper decides that, and names the links to drop. Anything else — a version
// or integrity change, a package only the ref has, a live-only real package, a differing
// patch-package patch, a lockfile present on one side only — is NOT equivalent, and the
// caller refuses with the reasons instead of publishing a generation that lies about its key.
//
// Flags that only matter to an --omit install (dev / devOptional / optional / peer) are
// ignored: checkpoint installs reify every entry. Entries without `node_modules/` in their
// key are workspace declarations (sources come from the checkout), not installed content.
//
// Trust model: the live trees are assumed to match the live lockfiles — the same invariant
// the ordinary publish path relies on when it indexes a generation under the live inputs
// (npm-install-safe maintains it, and every caller holds its --exec-under-lock mutex).
//
// Standalone (node:* only) so the release shell scripts can run it with the operator down.
//
// Usage:
//   dependency-lock-equivalence.mjs --ref-root <dir> --ref-manifest <file>
//                                   --live-root <dir> --live-manifest <file>
// Manifests are `rel<TAB>sha256` lines (dependency_generation_input_manifest output).
// Stdout: `DROP_LINK<TAB><repo-relative path>` per live-only workspace link (exit 0), or
//         `NOT_EQUIVALENT<TAB><reason>` lines (exit 3). Exit 2 = misuse / unreadable input.

import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

export const MAX_REASONS = 8;
const COMPARED_FIELDS = ['version', 'resolved', 'integrity', 'link'];

/** Parse `rel<TAB>digest` manifest text into a Map. */
export function parseInputManifest(text) {
  const out = new Map();
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    const tab = line.indexOf('\t');
    if (tab < 1) throw new Error(`malformed manifest line: ${line}`);
    out.set(line.slice(0, tab), line.slice(tab + 1).trim());
  }
  return out;
}

function isLockfile(rel) {
  const base = posix.basename(rel);
  return base === 'package-lock.json' || base === 'npm-shrinkwrap.json';
}

function installedEntries(lock) {
  const out = new Map();
  for (const [key, entry] of Object.entries(lock?.packages ?? {})) {
    if (!key.includes('node_modules/')) continue;
    out.set(key, entry ?? {});
  }
  return out;
}

function fieldDiff(refEntry, liveEntry) {
  for (const field of COMPARED_FIELDS) {
    const a = refEntry[field] ?? null;
    const b = liveEntry[field] ?? null;
    if (a !== b) return `${field} ${JSON.stringify(a)} (ref) vs ${JSON.stringify(b)} (live)`;
  }
  return null;
}

/**
 * Compare one lockfile pair. Returns { drops, reasons } with repo-relative drop paths.
 * `lockRel` is the lockfile's repo-relative path; installed keys are relative to its dir.
 */
export function compareLockfile(lockRel, refLock, liveLock) {
  const reasons = [];
  const drops = [];
  if (!refLock?.packages || !liveLock?.packages) {
    reasons.push(`${lockRel}: no packages map (lockfileVersion < 2) — cannot prove equivalence`);
    return { drops, reasons };
  }
  const lockDir = posix.dirname(lockRel);
  const at = (key) => (lockDir === '.' ? key : `${lockDir}/${key}`);
  const ref = installedEntries(refLock);
  const live = installedEntries(liveLock);
  for (const [key, refEntry] of ref) {
    const liveEntry = live.get(key);
    if (!liveEntry) {
      reasons.push(`${at(key)}: installed by the ref's lock but not by the live lock (needs an install)`);
      continue;
    }
    const diff = fieldDiff(refEntry, liveEntry);
    if (diff) reasons.push(`${at(key)}: ${diff}`);
  }
  for (const [key, liveEntry] of live) {
    if (ref.has(key)) continue;
    if (liveEntry.link === true) drops.push(at(key));
    else reasons.push(`${at(key)}: installed by the live lock but absent from the ref's lock (not a workspace link)`);
  }
  return { drops, reasons };
}

/**
 * Decide install-equivalence across every dependency input.
 * `readRef(rel)` / `readLive(rel)` return a file's text.
 */
export function compareDependencyInputs({ refManifest, liveManifest, readRef, readLive }) {
  const reasons = [];
  const drops = [];
  const rels = [...new Set([...refManifest.keys(), ...liveManifest.keys()])].sort();
  for (const rel of rels) {
    const refDigest = refManifest.get(rel);
    const liveDigest = liveManifest.get(rel);
    if (refDigest === liveDigest) continue;
    if (refDigest === undefined) {
      reasons.push(`${rel}: dependency input exists only in the live tree`);
      continue;
    }
    if (liveDigest === undefined) {
      reasons.push(`${rel}: dependency input exists only at the ref`);
      continue;
    }
    if (!isLockfile(rel)) {
      reasons.push(`${rel}: patch differs between the ref and the live tree`);
      continue;
    }
    let refLock;
    let liveLock;
    try {
      refLock = JSON.parse(readRef(rel));
      liveLock = JSON.parse(readLive(rel));
    } catch (error) {
      reasons.push(`${rel}: unreadable lockfile (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    const result = compareLockfile(rel, refLock, liveLock);
    reasons.push(...result.reasons);
    drops.push(...result.drops);
  }
  return { equivalent: reasons.length === 0, drops: drops.sort(), reasons };
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--ref-root') opts.refRoot = argv[++i];
    else if (arg === '--ref-manifest') opts.refManifest = argv[++i];
    else if (arg === '--live-root') opts.liveRoot = argv[++i];
    else if (arg === '--live-manifest') opts.liveManifest = argv[++i];
    else throw new Error(`unknown arg: ${arg}`);
  }
  for (const key of ['refRoot', 'refManifest', 'liveRoot', 'liveManifest']) {
    if (!opts[key]) throw new Error('--ref-root, --ref-manifest, --live-root and --live-manifest are required');
  }
  return opts;
}

function main(argv) {
  let opts;
  let refManifest;
  let liveManifest;
  try {
    opts = parseArgs(argv);
    refManifest = parseInputManifest(readFileSync(opts.refManifest, 'utf8'));
    liveManifest = parseInputManifest(readFileSync(opts.liveManifest, 'utf8'));
  } catch (error) {
    process.stderr.write(`dependency-lock-equivalence: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const result = compareDependencyInputs({
    refManifest,
    liveManifest,
    readRef: (rel) => readFileSync(join(opts.refRoot, rel), 'utf8'),
    readLive: (rel) => readFileSync(join(opts.liveRoot, rel), 'utf8'),
  });
  if (!result.equivalent) {
    const shown = result.reasons.slice(0, MAX_REASONS);
    for (const reason of shown) process.stdout.write(`NOT_EQUIVALENT\t${reason}\n`);
    if (result.reasons.length > shown.length) {
      process.stdout.write(`NOT_EQUIVALENT\t(+${result.reasons.length - shown.length} more)\n`);
    }
    return 3;
  }
  for (const drop of result.drops) process.stdout.write(`DROP_LINK\t${drop}\n`);
  return 0;
}

// Basename pin, not an import.meta.url comparison: this file must stay importable by
// tests without running, and must not import operator-core (standalone, above).
function isDirectCliInvocation(entryPath = process.argv[1]) {
  return typeof entryPath === 'string' && /(?:^|[\\/])dependency-lock-equivalence\.mjs$/.test(entryPath);
}

if (isDirectCliInvocation()) {
  // End naturally so a piped stdout drains before exit (undrained-stdout-exit-guard).
  process.exitCode = main(process.argv.slice(2));
}
