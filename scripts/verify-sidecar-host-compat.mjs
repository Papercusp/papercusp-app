#!/usr/bin/env node
// Verify that a host sidecar bundle's EXTERNALS BOUNDARY is satisfied by a target host.
//
// WHY THIS EXISTS (EI-19313879938405219)
// --------------------------------------
// `serve.mjs` is self-contained by INLINING everything except a small externals set
// (NATIVE_PKGS + HOST_COMMON_EXTERNALS + @embedded-postgres/*, plus the memory-trim
// externals in apps/operator/bin/bundle-host.sh). A target host must therefore have
// EXACTLY that externals set resolvable beside serve.mjs. Until this script existed,
// NOTHING checked that — at deploy time or at any other time.
//
// The measured near-miss: a tree-built bundle externalized the holepunch/hypercore
// stack (hyperbee, hypercore, corestore, hyperswarm) while the mac rig's node_modules
// contained none of them. Shipping it would have produced ERR_MODULE_NOT_FOUND for a
// subsystem whose failure mode is "federation just stops" — not a loud crash at deploy.
//
// The only signal available at the time was a bundle SIZE difference (43MB vs 61MB).
// Size is a terrible proxy: two bundles can match in size and differ structurally, or
// differ in size harmlessly. This is the structural check that replaces that guess.
//
// GROUND TRUTH IS THE BUNDLE, NOT THE STAMP
// -----------------------------------------
// The requirement set is derived from the bare import specifiers the bundle actually
// carries — i.e. exactly what node will try to resolve at runtime. That matters because
// the dangerous artifacts are the UNSTAMPED ones: gitignored, peer-built, carrying no
// provenance about which externals boundary produced them. A stamp-only check would be
// unable to say anything about precisely those. When BUILD-STAMP.txt does declare a
// boundary we additionally cross-check the derived set against it and report drift.
//
// USAGE
//   node scripts/verify-sidecar-host-compat.mjs <bundle-or-dir> <host-dir> [--strict] [--json]
//
//     <bundle-or-dir>  serve.mjs, or a directory containing it
//     <host-dir>       the directory the bundle will run from on the target host
//                      (the one whose node_modules must satisfy the boundary)
//     --strict         also FAIL on boundary drift (a package the bundle externalizes
//                      that the stamp's declared boundary does not cover)
//     --json           emit a machine-readable report on stdout
//
// EXIT CODES
//   0  every externalized package resolves on the target host
//   1  at least one does NOT resolve (this is the shipping-breakage case), or
//      --strict was given and the bundle drifted from its declared boundary
//   2  misuse / unreadable inputs

import { createRequire } from 'node:module';
import { builtinModules } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const BUILTINS = new Set(builtinModules);

/**
 * Extract the bare (non-relative, non-builtin) package specifiers a bundle will ask
 * node to resolve at runtime.
 *
 * esbuild emits externals as real import/require sites, so scanning for them recovers
 * the effective boundary from the artifact itself. Inlined dependencies are rewritten
 * into internal thunks and do not appear as bare specifiers, which is what makes this
 * a boundary probe rather than a dependency listing.
 */
export function extractExternalSpecifiers(source) {
  const found = new Set();
  const patterns = [
    // import ... from "pkg"   /   export ... from "pkg"
    /\bfrom\s*["']([^"'\n]+)["']/g,
    // bare side-effect import "pkg"
    /\bimport\s*["']([^"'\n]+)["']/g,
    // dynamic import("pkg")
    /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
    // require("pkg") — reachable via the bundle banner's createRequire
    /\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(source)) !== null) {
      const spec = m[1];
      if (!spec) continue;
      // Relative and absolute specifiers are the bundle's own internals.
      if (spec.startsWith('.') || spec.startsWith('/')) continue;
      // node:-prefixed and bare builtins always resolve; they are never a host risk.
      if (spec.startsWith('node:')) continue;
      const pkg = packageRootOf(spec);
      if (!pkg) continue;
      if (BUILTINS.has(pkg)) continue;
      found.add(pkg);
    }
  }
  return [...found].sort();
}

/** "@scope/name/sub/path" -> "@scope/name";  "pkg/sub" -> "pkg" */
export function packageRootOf(specifier) {
  const parts = specifier.split('/');
  if (specifier.startsWith('@')) {
    if (parts.length < 2) return null;
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0] || null;
}

/**
 * Does `pkg` resolve from `fromDir`, using node's own walk-up semantics?
 *
 * We deliberately mirror node resolution (walk up through parent node_modules) rather
 * than checking only the sibling directory: a check stricter than the runtime would
 * report failures that do not actually occur, and a check looser than the runtime would
 * miss the breakage it exists to catch.
 */
export function resolvesFrom(pkg, fromDir) {
  let dir = path.resolve(fromDir);
  for (;;) {
    const candidate = path.join(dir, 'node_modules', pkg);
    if (fs.existsSync(path.join(candidate, 'package.json')) || fs.existsSync(candidate)) {
      return true;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * Parse a declared boundary out of BUILD-STAMP.txt, if one is stamped.
 * Returns null when the bundle carries no boundary provenance (the dangerous case).
 */
export function readDeclaredBoundary(stampPath) {
  if (!fs.existsSync(stampPath)) return null;
  const text = fs.readFileSync(stampPath, 'utf8');
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('hostExternals='))
    .pop();
  if (!line) return null;
  const value = line.slice('hostExternals='.length).trim();
  if (!value) return [];
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

/** Does a declared boundary entry (possibly a "@scope/*" wildcard) cover `pkg`? */
export function boundaryCovers(declared, pkg) {
  for (const entry of declared) {
    if (entry === pkg) return true;
    if (entry.endsWith('/*')) {
      const prefix = entry.slice(0, -1); // keep trailing slash
      if (pkg.startsWith(prefix)) return true;
    }
    if (entry === '*') return true;
  }
  return false;
}

export function verify({ bundlePath, hostDir, stampPath }) {
  const source = fs.readFileSync(bundlePath, 'utf8');
  const required = extractExternalSpecifiers(source);
  const declared = stampPath ? readDeclaredBoundary(stampPath) : null;

  const missing = [];
  const present = [];
  for (const pkg of required) {
    if (resolvesFrom(pkg, hostDir)) present.push(pkg);
    else missing.push(pkg);
  }

  const drift = declared === null ? [] : required.filter((p) => !boundaryCovers(declared, p));

  return {
    bundlePath,
    hostDir,
    stamped: declared !== null,
    declaredCount: declared === null ? null : declared.length,
    requiredCount: required.length,
    required,
    present,
    missing,
    drift,
    ok: missing.length === 0,
  };
}

function main(argv) {
  const args = argv.filter((a) => !a.startsWith('--'));
  const strict = argv.includes('--strict');
  const asJson = argv.includes('--json');

  if (args.length < 2) {
    console.error(
      'usage: node scripts/verify-sidecar-host-compat.mjs <bundle-or-dir> <host-dir> [--strict] [--json]',
    );
    return 2;
  }

  let bundlePath = path.resolve(args[0]);
  if (fs.existsSync(bundlePath) && fs.statSync(bundlePath).isDirectory()) {
    bundlePath = path.join(bundlePath, 'serve.mjs');
  }
  if (!fs.existsSync(bundlePath)) {
    console.error(`FATAL: no bundle at ${bundlePath}`);
    return 2;
  }
  const hostDir = path.resolve(args[1]);
  if (!fs.existsSync(hostDir)) {
    console.error(`FATAL: no host directory at ${hostDir}`);
    return 2;
  }
  const stampPath = path.join(path.dirname(bundlePath), 'BUILD-STAMP.txt');

  const report = verify({ bundlePath, hostDir, stampPath });

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`sidecar host-compat: ${path.basename(bundlePath)} → ${hostDir}`);
    console.log(
      `  externals required by bundle: ${report.requiredCount}` +
        (report.stamped
          ? `  (stamp declares ${report.declaredCount})`
          : '  (bundle is UNSTAMPED — boundary derived from the artifact)'),
    );
    console.log(`  resolvable on target:         ${report.present.length}`);
    if (report.missing.length) {
      console.log(`  MISSING on target:            ${report.missing.length}`);
      for (const p of report.missing) console.log(`    ✗ ${p}`);
    }
    if (report.drift.length) {
      console.log(`  boundary drift (externalized but not declared): ${report.drift.length}`);
      for (const p of report.drift) console.log(`    ⚠ ${p}`);
    }
  }

  if (!report.ok) {
    if (!asJson) {
      console.error(
        '\nFATAL: this bundle externalizes packages the target host cannot resolve.\n' +
          'Deploying it would produce ERR_MODULE_NOT_FOUND at runtime for those subsystems.\n' +
          'Either install them on the target beside serve.mjs, or rebuild the bundle with\n' +
          'those packages INLINED (drop their --external: entries) for this host.',
      );
    }
    return 1;
  }
  if (strict && report.drift.length) {
    if (!asJson) {
      console.error(
        '\nFATAL (--strict): the bundle externalizes packages its declared boundary does not cover.',
      );
    }
    return 1;
  }
  if (!asJson) console.log('  ✓ host satisfies this bundle\'s externals boundary');
  return 0;
}

const require_ = createRequire(import.meta.url);
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
void require_;
