#!/usr/bin/env node
/**
 * Build-time recurrence guard for EI-21271940404773459.
 *
 * `bundle-host.sh` supplies esbuild's metafile for the just-built temporary
 * bundle. Every repo-owned input is checked for a hand-rolled ESM CLI-entry
 * guard. A raw guard that is harmless in a source-file CLI becomes a boot-time
 * `main()`/`process.exit()` hazard once esbuild inlines it, so the bundle path
 * is stricter than the shrink-only source census: zero bundled occurrences is
 * the contract. The source lint baseline records migration debt; this check
 * prevents that debt from reaching a host artifact.
 */
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findGuards } from './check-no-hand-rolled-cli-entry.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOTS = new Set(['apps', 'libs', 'packages', 'scripts']);

function arg(name) {
  const idx = process.argv.indexOf(name);
  return idx === -1 ? null : process.argv[idx + 1] ?? null;
}

function isRepoSource(file) {
  const rel = relative(REPO_ROOT, file).replaceAll('\\', '/');
  const [root, ...rest] = rel.split('/');
  return root && SOURCE_ROOTS.has(root) && rest.length > 0 && !rel.startsWith('../');
}

/**
 * Resolve an esbuild metafile input relative to the directory where the
 * bundler ran (bundle-host.sh runs from apps/operator).
 */
export class MissingMetafileError extends Error {
  constructor(metafilePath, cause) {
    super(
      `esbuild metafile is missing or unreadable: ${metafilePath}\n` +
        'This check did NOT fail — the bundle step never produced a metafile, which means the ' +
        'esbuild run before it failed, was killed, or was never reached. Look ABOVE this message ' +
        "for the real error; do not read this as a CLI-entry guard finding.",
      { cause },
    );
    this.name = 'MissingMetafileError';
    this.code = 'METAFILE_UNREADABLE';
    this.metafilePath = metafilePath;
  }
}

export function bundledInputPaths(metafilePath, baseDir) {
  // WI-55467: an unhandled ENOENT here printed a raw Node traceback into the host boot
  // log and buried the actual esbuild failure that caused the metafile to be absent —
  // then bundle-host.sh reported it as "bundling FAILED — the esbuild error is above".
  // Fail with a message that says which of the two it actually is.
  let raw;
  try {
    raw = readFileSync(metafilePath, 'utf8');
  } catch (error) {
    throw new MissingMetafileError(metafilePath, error);
  }
  let metafile;
  try {
    metafile = JSON.parse(raw);
  } catch (error) {
    throw new MissingMetafileError(metafilePath, error);
  }
  const inputs = Object.keys(metafile?.inputs ?? {});
  return inputs
    .map((input) => (isAbsolute(input) ? input : resolve(baseDir, input)))
    .filter((file) => isRepoSource(file));
}

export function findBundledCliEntryGuards({ metafilePath, baseDir }) {
  const findings = [];
  for (const file of bundledInputPaths(metafilePath, baseDir)) {
    let source;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const rel = relative(REPO_ROOT, file).replaceAll('\\', '/');
    for (const hit of findGuards(source, rel)) findings.push({ file: rel, ...hit });
  }
  return findings;
}

function isDirectCliInvocation(entryPath = process.argv[1]) {
  return typeof entryPath === 'string' && /(?:^|[\\/])check-bundled-cli-entry-guards\.mjs$/.test(entryPath);
}

function main() {
  const metafilePath = arg('--metafile');
  const baseDir = arg('--base-dir');
  if (!metafilePath || !baseDir) {
    console.error('usage: check-bundled-cli-entry-guards.mjs --metafile <path> --base-dir <dir>');
    process.exitCode = 2;
    return;
  }
  let findings;
  try {
    findings = findBundledCliEntryGuards({ metafilePath, baseDir: resolve(baseDir) });
  } catch (error) {
    if (error instanceof MissingMetafileError) {
      // Exit 2 (usage/precondition), never 1 (= real guard findings), so a caller can tell
      // "the bundle step upstream broke" from "a raw ESM self-exec guard reached the bundle".
      console.error(`✖ ${error.message}`);
      process.exitCode = 2;
      return;
    }
    throw error;
  }
  if (findings.length > 0) {
    console.error(`✖ bundled CLI-entry guard check failed: ${findings.length} raw guard(s) reached the bundle graph.`);
    for (const finding of findings) console.error(`  ${finding.file}:${finding.line}  ${finding.kind}`);
    console.error(
      '\nA hand-rolled ESM entry check can run an inlined CLI main() and process.exit() during host boot. ' +
        'Migrate the source to isCliEntry(import.meta.url) before bundling.',
    );
    process.exitCode = 1;
    return;
  }
  console.log('✓ bundled CLI-entry guard check passed: no repo-owned raw ESM self-exec guard reached the bundle graph.');
}

if (isDirectCliInvocation()) main();

