#!/usr/bin/env node
/**
 * check-no-identity-literals.mjs — WI-4776, the closing sibling to
 * check-no-box-identity.mjs (the home-PATH class) and
 * check-no-owner-name-tags.mjs (the `[owner:<name>]` TAG class).
 *
 * WHY A THIRD RULE
 * All 4 documented 0.0.9 leaks (QuickPanelHeaderControls.tsx,
 * mac-transport-death-self-diagnosis.mdx, mcp-transport-resilience-2026-07-13.md,
 * mcp-dark-watchdog.ts) were named `[owner:<name> …]` provenance tags — already
 * fully closed by check-no-owner-name-tags.mjs (baseline 0 as of 2026-07-14). But
 * WI-4419's release-cut gate (papercusp-desktop/bin/audit-release-bundle.py
 * :: identity_literals()) hunts a WIDER set than either sibling lint covers:
 * this box's git user.name / user.email and its hostname, matched as BARE
 * literals — e.g. an owner's first name dropped into a comment with no
 * `[owner:]` wrapper at all, or a hostname/email pasted into a debug note —
 * neither of which is a `[owner:` tag nor
 * a `/home/<user>/` path, so neither existing lint would catch it. That gap is
 * real even though it has 0 historical instances yet: the class is "whatever
 * this box's identity is" and the two existing rules only close two of its
 * shapes. This rule closes the rest, at EDIT/STAGE time, before a release cut
 * burns a sidecar build only to discover it later.
 *
 * WHY THIS RULE MUST RUN ON *THIS* BOX (deliberately unlike its siblings)
 * check-no-box-identity.mjs is machine-agnostic BY DESIGN — it matches a path
 * SHAPE, not a value, so it works identically on every contributor's checkout.
 * This rule cannot be: it has to know what "this box's identity" actually IS to
 * search for it, exactly like audit-release-bundle.py's identity_literals()
 * does (both resolve git config / hostname / OS user AT RUN TIME — neither
 * hardcodes a name). Run on a CI runner with a bot/absent git identity, it
 * degrades to a same as a no-op (nothing sensitive to find) — that is expected,
 * not a bug: the box that matters is the one that actually cuts releases
 * (release-local.sh runs THIS rule right after staging the source tree, on
 * THIS box, where git config user.name genuinely resolves to the owner).
 *
 * MUST MIRROR identity_literals() / needs_word_boundary() / is_vendor() from
 * audit-release-bundle.py — memory ef6e21c4 / WI-4419: "the two MUST agree or
 * it's a false-green." Ported 1:1 below; keep them in lockstep if either changes.
 *
 * NEVER hardcodes a real identity (this file itself ships — scripts/ is in the
 * release bundle's allowlist, per stage-source-tree.sh) — every literal here is
 * resolved dynamically, same discipline as check-no-owner-name-tags.mjs's own
 * "this file obeys its own rule" note.
 *
 *   node scripts/check-no-identity-literals.mjs
 *
 * BASELINE is EMPTY and must stay that way. If this fires, remove/derive the
 * literal — never add an exception to make the build pass.
 *
 * SCANS UNTRACKED-BUT-NOT-IGNORED FILES TOO (EI-18676240686848444) — see the
 * matching note in check-no-owner-name-tags.mjs. A brand-new file is invisible to a
 * plain `git ls-files` until it is `git add`-ed, which is exactly the moment a leak
 * is most likely to be typed; `--cached --others --exclude-standard` closes that gap.
 *
 * THE MATCHER LIVES IN scripts/lib/identity-leak-patterns.mjs, NOT HERE (EI-18759401203875869).
 * This file is the TREE-WALKING half — enumerate, read, report. The pattern half is shared with
 * the edit-time advisory hook (apps/operator/scripts/hooks/cc/pretooluse-content-lint.mjs) so an
 * author sees the same verdict seconds after typing it, instead of only when this rule reds the
 * green-checkpoint ~20 minutes later for the whole fleet. That is not hypothetical: this rule
 * caused five consecutive red gates and stranded 60 commits over ONE hardcoded home path in a
 * documentation file, with every one of 40,469 tests passing. Sharing the matcher is also what
 * keeps the two consumers from disagreeing — an advisory that stays silent on what this rule
 * rejects is worse than no advisory at all.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  IDENTITY_LITERAL_FIX_HINT,
  findIdentityLiterals,
  isSidecarCopiedIdentityPath,
  isSkippedPathForIdentityLiterals,
  isVendorPath,
  resolveIdentityLiteralScopes,
} from "./lib/identity-leak-patterns.mjs";

const identityScopes = resolveIdentityLiteralScopes();
const boxEntries = Object.entries(identityScopes.box);
const sidecarEntries = Object.entries(identityScopes.all);
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
if (boxEntries.length === 0 && sidecarEntries.length === 0) {
  console.log(
    "✓ no build-box identity resolved on this host (nothing to hunt) — no-op on a bare/CI box, by design",
  );
  process.exit(0);
}

// Scans untracked-but-not-ignored files too (EI-18676240686848444): a plain
// `git ls-files` misses a brand-new file until it is `git add`-ed, which is exactly
// the moment a leak is most likely to be typed. `--cached --others --exclude-standard`
// widens the enumeration to tracked content PLUS anything git would happily `add`,
// while still respecting .gitignore — a strict superset of what the gate (committed
// content only) later sees.
let files;
try {
  files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { maxBuffer: 1 << 28 })
    .toString()
    .split('\0')
    .filter(Boolean)
    .filter((f) => !isSkippedPathForIdentityLiterals(f));
} catch (e) {
  console.error(`check-no-identity-literals: git ls-files failed: ${e?.message}`);
  process.exit(2);
}
if (boxEntries.length === 0 && sidecarEntries.length > 0) {
  files = files.filter(isSidecarCopiedIdentityPath);
}

const findings = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue; // binary / unreadable / vanished mid-run
  }
  const entries = isSidecarCopiedIdentityPath(file)
    ? sidecarEntries
    : boxEntries;
  for (const hit of findIdentityLiterals(text, entries, { vendor: isVendorPath(file) })) {
    findings.push({ file, ...hit });
  }
}

if (findings.length === 0) {
  console.log(
    `✓ no bare build-box identity literal (${Object.keys(identityScopes.box).join(", ")}) in ${files.length} tracked + untracked-not-ignored source files; explicit owner values were checked only in copied CC hook files`,
  );
  process.exit(0);
}

console.error(
  `\n✗ ${findings.length} bare build-box identity literal(s) in tracked source — these leak this ` +
    `box's own identity (git name/email, hostname) into the release bundle (source.tar.zst / the ` +
    `packaged sidecar) and WILL fail the cut's box-identity audit (bin/audit-release-bundle.py), ` +
    `after real build time has already been spent.\n`,
);
const limit = process.argv.includes('--all') ? findings.length : 40;
for (const f of findings.slice(0, limit)) {
  console.error(`  ${f.file}:${f.line}  [${f.key}]`);
  console.error(`      ${f.text}`);
}
if (findings.length > limit) {
  console.error(`  … and ${findings.length - limit} more (re-run with --all)`);
}
console.error(`\n  ${IDENTITY_LITERAL_FIX_HINT}\n`);
process.exit(1);
