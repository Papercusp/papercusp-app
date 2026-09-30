#!/usr/bin/env node
// EI-18891305951810001 — `prebuild` gate: refuse to package a frontend that is not the
// one last built. Rationale, and why content rather than mtime, in ./lib/spa-freshness.js.
//
// Deliberately wired to the npm `prebuild` lifecycle rather than to the archive wrapper:
// the pre-existing stale-sidecar guard lives in bin/build-and-archive-deb.sh, which
// `npm run build` — the entrypoint in README.md, SHIPPING.md, and the one an agent
// reaches for — never invokes. A guard the documented entrypoint skips is not a guard.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { inspectSpaFreshness, blocksBuild, describe } = require('./lib/spa-freshness.js');

const desktopDir = path.resolve(__dirname, '..');
const repoRoot = process.env.PAPERCUSP_REPO_DIR || path.resolve(desktopDir, '..');

const SIDECAR_INDEX = path.join(desktopDir, 'src-tauri/sidecar/spa/index.html');
const DIST_INDEX = path.join(repoRoot, 'apps/operator-vite/dist/index.html');

function readOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

const result = inspectSpaFreshness({
  sidecarHtml: readOrNull(SIDECAR_INDEX),
  distHtml: readOrNull(DIST_INDEX),
});
const message = describe(result);

if (blocksBuild(result.verdict) && process.env.PAPERCUSP_ALLOW_STALE_SPA === '1') {
  console.warn(`[spa-freshness] OVERRIDDEN by PAPERCUSP_ALLOW_STALE_SPA=1:\n${message}`);
  process.exit(0);
}

if (blocksBuild(result.verdict)) {
  console.error(`[spa-freshness] ${message}`);
  // 4 matches the sibling stale-sidecar guard's exit code, so a wrapper can treat
  // "refused for staleness" as one condition regardless of which guard caught it.
  process.exit(4);
}

console.log(`[spa-freshness] ${message}`);
