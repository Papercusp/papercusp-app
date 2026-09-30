#!/usr/bin/env node
/**
 * check-mac-bash-portability.mjs — durable recurrence guard for EI-18093921841116426.
 *
 * WHAT HAPPENED (2026-07-19, v0.0.12 release cut; recurred 2026-07-25, WI-5769):
 * a bash-4+ builtin (`mapfile`) landed in a script on the mac build path.
 * macOS ships /bin/bash 3.2.57 system-wide (no Homebrew bash, GPLv2→v3
 * license freeze — Apple never upgraded it) — bash 4.0 added
 * `mapfile`/`readarray`, associative arrays (`declare -A`), and the
 * `${var,,}` / `${var^^}` case-conversion expansions. Every other build leg
 * (Linux, Windows-cross) runs a modern bash, so the breakage is MAC-ONLY and
 * was only ever caught ~1hr into an actual mac VM build — twice now.
 *
 * This lint greps the MAC BUILD PATH ONLY (the entry points below + their
 * statically-resolvable `source`/`.`/`bash`/`sh` closure) for those bash-4+
 * constructs and fails at commit time instead of an hour into a release VM
 * build. It deliberately does NOT scan all of bin/ — many OTHER scripts
 * legitimately use these builtins on Linux/Windows-cross legs that run a
 * modern bash, and flagging those would be a false positive this lint must
 * not produce.
 *
 *   node scripts/check-mac-bash-portability.mjs [--verbose]
 *
 * See also: papercusp-desktop/bin/build-desktop-sidecar.sh (has hand-written
 * "no mapfile on macOS" comments this lint makes MECHANICALLY enforced),
 * verify-sidecar-bundle.sh, stage-source-tree.sh.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const verbose = process.argv.includes('--verbose');

// The scripts that actually RUN on (or drive a build targeting) the mac VM.
// Everything else these source/invoke is discovered below via static
// analysis of the closure — kept explicit here rather than a glob so a
// script that has nothing to do with the mac leg never gets swept in.
const ENTRY_POINTS = [
  'papercusp-desktop/bin/mac-vm-build.sh', // runs ON the mac VM
  'papercusp-desktop/bin/mac-vm-verify-build.sh', // drives mac-vm-build.sh remotely
  'papercusp-desktop/bin/build-mac-cross.sh', // the mac leg of a cross release build
];

// Known path-variable idioms this repo's build scripts use, resolved
// statically (best-effort — an unresolvable path is reported, not fatal).
function resolveVar(varName, currentFileAbs) {
  if (varName === 'HERE' || varName === 'SCRIPT_DIR') return dirname(currentFileAbs);
  if (varName === 'REPO_ROOT') return ROOT;
  if (varName === 'WEB_DIR') return resolve(ROOT, 'apps/operator');
  return null;
}

const INVOKE_RE = /(?:^|;|&&|\|\|)\s*(?:source|\.|bash|sh)\s+"?(\$\{?[A-Za-z_][A-Za-z0-9_]*\}?)?([A-Za-z0-9_./-]*\.sh)"?/g;

function isCommentLine(line) {
  return /^\s*#/.test(line);
}

/** Resolve a raw (possibly $VAR-prefixed) .sh reference found in `currentFileAbs` to an absolute path, or null if unresolvable/nonexistent. */
function resolveTarget(varPart, tailPart, currentFileAbs) {
  let base = '';
  if (varPart) {
    const varName = varPart.replace(/[${}]/g, '');
    const resolved = resolveVar(varName, currentFileAbs);
    if (!resolved) return { unresolved: `${varPart}${tailPart}` };
    base = resolved;
  }
  let candidatePaths = [];
  if (base) {
    candidatePaths.push(resolve(base, tailPart.replace(/^\//, '')));
  } else if (isAbsolute(tailPart)) {
    candidatePaths.push(tailPart);
  } else {
    // Bare relative reference (no $VAR prefix) — try, in order: same dir as
    // the sourcing file, then papercusp-desktop/ (many invocations run with
    // that as cwd, e.g. `bash bin/verify-sidecar-bundle.sh`), then repo root.
    candidatePaths.push(resolve(dirname(currentFileAbs), tailPart));
    candidatePaths.push(resolve(ROOT, 'papercusp-desktop', tailPart));
    candidatePaths.push(resolve(ROOT, tailPart));
  }
  const hit = candidatePaths.find((p) => existsSync(p) && p.endsWith('.sh'));
  return hit ? { path: hit } : { unresolved: `${varPart ?? ''}${tailPart}` };
}

function findInvokedScripts(fileAbs) {
  const text = readFileSync(fileAbs, 'utf8');
  const found = [];
  const unresolved = [];
  for (const rawLine of text.split('\n')) {
    if (isCommentLine(rawLine)) continue;
    for (const m of rawLine.matchAll(INVOKE_RE)) {
      const [, varPart, tailPart] = m;
      if (!tailPart) continue;
      const r = resolveTarget(varPart, tailPart, fileAbs);
      if (r.path) found.push(r.path);
      else unresolved.push(r.unresolved);
    }
  }
  return { found, unresolved };
}

// BFS the closure from the entry points.
const visited = new Set();
const queue = ENTRY_POINTS.map((p) => resolve(ROOT, p));
const allUnresolved = [];
while (queue.length) {
  const fileAbs = queue.shift();
  if (visited.has(fileAbs)) continue;
  if (!existsSync(fileAbs)) {
    console.error(`✗ mac-build-path entry point missing: ${relative(ROOT, fileAbs)}`);
    process.exit(1);
  }
  visited.add(fileAbs);
  const { found, unresolved } = findInvokedScripts(fileAbs);
  for (const u of unresolved) allUnresolved.push(`${relative(ROOT, fileAbs)}: ${u}`);
  for (const f of found) if (!visited.has(f)) queue.push(f);
}

if (verbose) {
  console.log(`mac build-path closure (${visited.size} file(s)):`);
  for (const f of [...visited].sort()) console.log(`  ${relative(ROOT, f)}`);
  if (allUnresolved.length) {
    console.log(`\n${allUnresolved.length} unresolved reference(s) (not followed, not failed on):`);
    for (const u of allUnresolved) console.log(`  ${u}`);
  }
}

// The forbidden bash-4+ constructs (exactly EI-18093921841116426's list —
// deliberately not a broader set, to keep this a precise, low-false-positive
// guard rather than a general shellcheck).
const FORBIDDEN = [
  { re: /\bmapfile\b/, name: 'mapfile (bash 4.0+ builtin)' },
  { re: /\breadarray\b/, name: 'readarray (bash 4.0+ builtin, alias of mapfile)' },
  // Capital `A` only — `declare -a` (lowercase, indexed array) is bash-3.2-safe;
  // only the associative-array flag `-A` (bash 4.0+) is forbidden here.
  { re: /\bdeclare\s+-[a-zA-Z]*A[a-zA-Z]*\b/, name: 'declare -A/-gA (bash 4.0+ associative arrays)' },
  { re: /\$\{[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?,,?\}/, name: '${var,} / ${var,,} (bash 4.0+ case-conversion expansion)' },
  { re: /\$\{[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\^\^?\}/, name: '${var^} / ${var^^} (bash 4.0+ case-conversion expansion)' },
];

const offenders = [];
for (const fileAbs of visited) {
  const text = readFileSync(fileAbs, 'utf8');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (isCommentLine(lines[i])) continue;
    for (const { re, name } of FORBIDDEN) {
      if (re.test(lines[i])) {
        offenders.push(`${relative(ROOT, fileAbs)}:${i + 1}  ${name}\n      ${lines[i].trim()}`);
      }
    }
  }
}

if (offenders.length === 0) {
  console.log(`✓ mac build-path (${visited.size} script(s), rooted at ${ENTRY_POINTS.length} entry point(s)) is bash-3.2-portable — no mapfile/readarray/assoc-array/case-conversion found.`);
  process.exit(0);
}

console.error('✗ bash-4+ construct(s) found on the MAC BUILD PATH — macOS system bash is 3.2 and does not have these (EI-18093921841116426 / WI-5769):\n');
for (const o of offenders) console.error('    ' + o);
console.error(`\n  ${offenders.length} offender(s) across ${visited.size} scanned file(s). Fix: use a portable equivalent`);
console.error('  (e.g. `while IFS= read -r x; do ...; done < <(cmd)` instead of `mapfile -t arr < <(cmd)`).');
console.error('  See papercusp-desktop/bin/build-desktop-sidecar.sh:1265-1275 for a worked example + rationale.');
process.exit(1);
