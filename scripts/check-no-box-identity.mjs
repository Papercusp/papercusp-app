#!/usr/bin/env node
/**
 * check-no-box-identity.mjs — fail-loud guard against a developer's own machine
 * leaking into tracked source (WI-4419).
 *
 * WHY THIS EXISTS
 * Every release bundle ships `sidecar/source.tar.zst`, a tar of the monorepo
 * working tree, straight to whoever we hand a build to. The 0.0.8 cut shipped the
 * owner's home path 53,811 times. bin/audit-release-bundle.py is the GATE that
 * catches that — but it only runs at CUT TIME, on the finished artifact, which is
 * the most expensive possible moment to discover it: the fix is a source change,
 * so the whole build is wasted. This lint catches the same class at EDIT time.
 *
 * Gate vs lint, deliberately different jobs:
 *   - The gate knows THIS box's identity (it resolves the literals at run time) and
 *     is definitive about the artifact we are about to ship.
 *   - This lint cannot know your box's name — and must not, or it would only work
 *     on one machine, which is the bug it is preventing. So it detects the CLASS:
 *     an absolute path into somebody's home directory. That is machine-agnostic:
 *     it fires the same on every contributor's checkout.
 *
 * THE RULE: source must never hardcode `/home/<user>/…` or `/Users/<user>/…`.
 * Derive it instead — `os.homedir()`, `$HOME`, systemd's `%h`, `git rev-parse
 * --show-toplevel`, or a path relative to the file itself. A hardcoded home path is
 * wrong on every machine but one, so this lint is not merely a privacy rail: code it
 * fires on is already broken for everyone else.
 *
 *   node scripts/check-no-box-identity.mjs
 *
 * BASELINE is EMPTY and must stay that way. If this fires, fix the path — do not
 * add an exception to make the build pass.
 *
 * SCANS UNTRACKED-BUT-NOT-IGNORED FILES TOO (EI-18676240686848444). A plain
 * `git ls-files` only enumerates already-tracked content, so a brand-NEW file — the
 * exact moment a leak is most likely to be typed — was invisible to this lint until
 * the next `git add`, which meant a confident green that had scanned zero bytes of
 * the file you actually just wrote. `--cached --others --exclude-standard` widens the
 * enumeration to match: tracked content PLUS anything git would happily `add`, while
 * still respecting .gitignore. This makes a local run a strict superset of what the
 * gate later sees (the gate only ever sees committed content) — the safe direction
 * for a pre-commit-shaped check to err in.
 *
 * THE MATCHER LIVES IN scripts/lib/identity-leak-patterns.mjs, NOT HERE (EI-18759401203875869).
 * This file is the TREE-WALKING half — enumerate, read, report. The pattern half is shared with
 * the edit-time advisory hook (apps/operator/scripts/hooks/cc/pretooluse-content-lint.mjs), which
 * lints the content an author is writing seconds after they type it. That hook covered only the
 * `[owner:<name>]` class until this rule's class was added to it: the leak that cost five
 * consecutive red gates and 60 stranded commits was a home path in a doc, which this rule would
 * have caught at edit time had it been reachable there. One matcher, two consumers — because an
 * advisory that disagrees with the gate green-lights what the gate later rejects.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  BOX_IDENTITY_FIX_HINT,
  findBoxIdentityPaths,
  isSkippedPath,
} from './lib/identity-leak-patterns.mjs';

/**
 * ⚠ SUPERPROJECT-ONLY, DELIBERATELY — do NOT convert this to a submodule-recursing
 * enumerator. WI-6730 swept most scripts/check-*.mjs guards onto
 * scripts/lib/tracked-files.mjs; the three identity guards are a documented
 * EXCEPTION, measured rather than assumed: 29 submodule files carry this box's
 * identity literals, and every one of them is neutralised BY DESIGN at tar time by
 * bin/stage-source-tree.sh (WI-4419 durable /
 * desktop-v0-0-12-release-tri-platform#D-004), which redacts identity literals in a
 * COPY of each must-ship file. The produced bundle carries no real identity, so
 * enforcing here would red the gate on 29 non-leaks and start exactly the per-file
 * "treadmill" D-004 rejects in as many words.
 *
 * Full rationale + the evidence: the scope note at the top of
 * scripts/check-no-owner-name-tags.mjs. The enumerator seam exists if policy ever
 * changes (`listFilesIncludingUntracked()`); the blocker is D-004, not tooling.
 */
const files = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard'],
  { encoding: 'utf8', maxBuffer: 64 << 20 },
)
  .split('\n')
  .filter((f) => f && !isSkippedPath(f));

const findings = [];
for (const f of files) {
  let src;
  try {
    src = readFileSync(f, 'utf8');
  } catch {
    continue; // binary / unreadable
  }
  for (const hit of findBoxIdentityPaths(src)) findings.push({ file: f, ...hit });
}

if (findings.length === 0) {
  // EI-19327204777381001: SAY the scope in the verdict, don't leave it to the reader.
  // The enumeration above is superproject-only BY DESIGN (see the scope note) — but a
  // bare "✓ no box-identity paths in 5,666 files" reads as a repo-wide clean bill of
  // health, and the large count makes it read as a MORE authoritative one. This repo
  // declares 39 submodules whose contents were never opened here, so an unqualified
  // pass renders "I did not look there" identically to "there is nothing there".
  // Qualifying the line costs nothing and keeps the D-004 scope decision honest;
  // mirrors check-no-owner-name-tags.mjs, which already states its scope this way.
  console.log(
    `✓ no box-identity paths in ${files.length} tracked + untracked-not-ignored source files ` +
      `(superproject only — submodule contents are NOT enumerated here, by design: they are ` +
      `redacted at tar time by bin/stage-source-tree.sh. See the scope note above.)`,
  );
  process.exit(0);
}

console.error(`\n✗ ${findings.length} hardcoded home path(s) in tracked source.\n`);
console.error('  These name ONE developer\'s machine. They are wrong on every other');
console.error('  checkout, and they ship to users inside the release source drop.\n');
const limit = process.argv.includes('--all') ? findings.length : 40;
for (const f of findings.slice(0, limit)) {
  console.error(`  ${f.file}:${f.line}  (user "${f.user}")`);
  console.error(`      ${f.text}`);
}
if (findings.length > limit) {
  console.error(`  … and ${findings.length - limit} more (re-run with --all)`);
}
console.error(`\n  ${BOX_IDENTITY_FIX_HINT}\n`);
process.exit(1);
