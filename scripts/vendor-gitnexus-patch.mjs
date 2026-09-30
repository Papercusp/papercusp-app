#!/usr/bin/env node
/**
 * Apply (or verify) the papercusp patch set for the VENDORED gitnexus install.
 *
 * WHY THIS EXISTS. gitnexus lives outside the repo (`~/.papercusp/vendor/gitnexus`, pinned at
 * 1.6.9 by plan code-intelligence-routing-lsp-gitnexus-2026-08-20 D-048), so `patch-package`
 * never sees it and a re-provision (`npm install --prefix ~/.papercusp/vendor/gitnexus
 * gitnexus@1.6.9`) silently drops any local fix. This script is the ONE place that re-applies
 * them, and the doc-claim test named in each patch fails the build when the vendored file no
 * longer carries the patch marker.
 *
 * Patches (patches/gitnexus-vendor+<version>-<slug>.patch, unified diff rooted at the package):
 *   - 1.6.9-embedding-upsert (WI-39394): backport of gitnexus 1.6.11's batchInsertEmbeddings —
 *     DELETE by embedding id before CREATE. Without it `analyze --force --embeddings` on an index
 *     that already carries embeddings aborts on the first changed node with "Found duplicated
 *     primary key value" (measured 2026-09-05, /tmp/wi39394/run3-embed-run.log), i.e. every
 *     hourly gitnexus-reindex tick after the bootstrap. Retire it when the vendor pin moves to
 *     ≥ 1.6.11 (that release also bumps @ladybugdb/core to 0.19 — a full re-index).
 *
 * Usage:
 *   node scripts/vendor-gitnexus-patch.mjs            # apply anything missing (idempotent)
 *   node scripts/vendor-gitnexus-patch.mjs --check    # exit 1 if any patch for this version is missing
 *   GITNEXUS_VENDOR_ROOT=<dir> …                      # override the package root (tests / other boxes)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_VENDOR_ROOT = join(homedir(), '.papercusp/vendor/gitnexus/node_modules/gitnexus');

/** Every patch, keyed by the exact vendored version it targets. */
export const GITNEXUS_VENDOR_PATCHES = [
  {
    version: '1.6.9',
    file: 'patches/gitnexus-vendor+1.6.9-embedding-upsert.patch',
    /** Relative to the package root — the file the patch rewrites. */
    target: 'dist/core/embeddings/embedding-pipeline.js',
    /** Literal the patched file MUST contain; its absence is the drift signal. */
    marker: 'papercusp-patch:gitnexus-1.6.9-embedding-upsert',
  },
];

export function vendorRoot() {
  return process.env.GITNEXUS_VENDOR_ROOT || DEFAULT_VENDOR_ROOT;
}

export function vendoredVersion(root = vendorRoot()) {
  const pkg = join(root, 'package.json');
  if (!existsSync(pkg)) return null;
  return JSON.parse(readFileSync(pkg, 'utf8')).version ?? null;
}

/** Pure: which patches apply to `version`, and whether each is present in `root`. */
export function patchStatus(root = vendorRoot(), version = vendoredVersion(root)) {
  return GITNEXUS_VENDOR_PATCHES.filter((p) => p.version === version).map((p) => {
    const targetPath = join(root, p.target);
    const present = existsSync(targetPath) && readFileSync(targetPath, 'utf8').includes(p.marker);
    return { ...p, targetPath, present };
  });
}

function main(argv) {
  const check = argv.includes('--check');
  const root = vendorRoot();
  const version = vendoredVersion(root);
  if (!version) {
    console.log(`VENDOR_GITNEXUS_PATCH status=no-vendor root=${root}`);
    return 0;
  }
  const rows = patchStatus(root, version);
  if (rows.length === 0) {
    console.log(`VENDOR_GITNEXUS_PATCH status=none-for-version version=${version}`);
    return 0;
  }
  let failed = 0;
  for (const p of rows) {
    if (p.present) {
      console.log(`VENDOR_GITNEXUS_PATCH status=present ${p.file}`);
      continue;
    }
    if (check) {
      console.log(`VENDOR_GITNEXUS_PATCH status=MISSING ${p.file} target=${p.targetPath}`);
      failed += 1;
      continue;
    }
    execFileSync('patch', ['-p1', '--forward', '--input', join(REPO_ROOT, p.file)], {
      cwd: root,
      stdio: 'inherit',
    });
    const now = patchStatus(root, version).find((r) => r.file === p.file);
    if (!now?.present) {
      console.log(`VENDOR_GITNEXUS_PATCH status=APPLY-FAILED ${p.file} (marker still absent)`);
      failed += 1;
    } else {
      console.log(`VENDOR_GITNEXUS_PATCH status=applied ${p.file}`);
    }
  }
  return failed ? 1 : 0;
}

if (isCliEntry(import.meta.url)) process.exit(main(process.argv.slice(2)));
