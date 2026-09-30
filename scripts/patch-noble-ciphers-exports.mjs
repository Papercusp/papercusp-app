#!/usr/bin/env node
/**
 * Patch @noble/ciphers/package.json to expose every "./X.js" subpath also
 * under the bare-name "./X" alias.
 *
 * Why: @ecies/ciphers (transitively pulled in by @dotenvx/dotenvx) does
 *      `require('@noble/ciphers/utils')` — without the .js extension. Versions
 *      ≥2.0.0 of @noble/ciphers tightened their `exports` map to only allow
 *      `./utils.js` (with extension), so the bare import throws
 *      ERR_PACKAGE_PATH_NOT_EXPORTED.
 *
 *      This blocks zero-cache 1.4 from booting from this workspace's
 *      node_modules (eciesjs is in @rocicorp/zero's tree). Without this
 *      patch zero-cache must run from a different workspace whose
 *      @noble/ciphers happens to be 1.x.
 *
 *      The .js file is right there on disk — we just need to expose it
 *      under the bare-name alias too. Idempotent: skips entries that
 *      already exist.
 *
 * Run automatically post-install by package.json's `postinstall` script.
 * Re-run any time after `npm install` if the patch is reverted.
 */

import fs from 'node:fs';
import path from 'node:path';

const TARGET = path.join(
  process.cwd(),
  'node_modules',
  '@noble',
  'ciphers',
  'package.json',
);

if (!fs.existsSync(TARGET)) {
  // Module not installed at the root — nothing to do (it may live nested
  // under another package's node_modules; that copy isn't the one with the
  // missing export, the root copy is).
  process.exit(0);
}

const pkg = JSON.parse(fs.readFileSync(TARGET, 'utf8'));
if (!pkg.exports || typeof pkg.exports !== 'object') process.exit(0);

let added = 0;
for (const [key, val] of Object.entries(pkg.exports)) {
  if (key.endsWith('.js')) {
    const bare = key.slice(0, -'.js'.length);
    if (!(bare in pkg.exports)) {
      pkg.exports[bare] = val;
      added += 1;
    }
  }
}
if (added > 0) {
  fs.writeFileSync(TARGET, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`patched @noble/ciphers/package.json: added ${added} bare-name aliases`);
}
