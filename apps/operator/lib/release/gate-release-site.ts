#!/usr/bin/env npx tsx
/**
 * The publish gate: does any page in this directory carry THIS BOX's identity?
 *
 * Exits 0 (clean) or 1 (leak found). `publish-release-history.sh` runs it twice —
 * once on the bytes it is about to upload, and once on the bytes the host actually
 * serves back — and refuses to publish on any hit.
 *
 * It exists as a separate entry point, rather than as a check inside the renderer,
 * because THE SCRUB AND THE GATE MUST BE ABLE TO DISAGREE. A renderer that
 * certifies its own output can only ever confirm what it already believes; this
 * re-reads the finished bytes with fresh eyes. That is not theoretical — the gate
 * has caught two real leaks the scrub was blind to (a work-item title carrying the
 * owner's home path, and plan frontmatter carrying two of his personal email
 * addresses that were not this box's git identity).
 *
 * It shares findIdentityLeaks() with the scrub deliberately: ONE implementation of
 * "what counts as identity". A gate that re-implements the rule it is checking
 * drifts from it, and a gate that has drifted is guarding nothing. What makes it an
 * independent check is not different code — it is different INPUT: the finished
 * bytes, not the intent.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import {
  defaultIdentityEnvPath,
  describeOwnerIdentityLoad,
  loadOwnerIdentityEnv,
} from './owner-identity-env';
import {
  HOLDING_PAGE_MARKER,
  PUBLISHED_CONTACT_EMAIL,
  findIdentityLeaks,
  hasOwnerNameLiteral,
  identityLiterals,
  OWNER_NAME_ENV,
  type IdentityLiteral,
} from './release-content-scrub';

export interface SiteLeak {
  file: string;
  kind: string;
  count: number;
  /** A short excerpt around the first hit, so the fix is obvious. */
  sample: string;
}

/**
 * Every file we PUBLISH — not just the pages. `history.json` is uploaded to the
 * same host and carries the same agent-written changelog prose, so a gate that only
 * read `.html` would wave through a leak sitting in the feed the app itself fetches.
 * Gate what ships, not what you happened to think of first.
 */
const PUBLISHED = ['.html', '.json', '.js', '.css'];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (PUBLISHED.some((ext) => e.name.endsWith(ext))) out.push(full);
  }
  return out;
}

/**
 * The ONE narrow exception to "no address may ship" — and it is scoped by the
 * BYTES, not by a caller's promise.
 *
 * A file gets the contact-email allowance only if it BOTH is named index.html
 * AND carries the holding-page marker in its own content. So the allowance
 * cannot leak onto a plan page, onto history.json, or onto a normal release
 * index — none of which can carry that marker — and it evaporates by itself the
 * moment the real site is restored. Every other address in every file, holding
 * page included, still fails the gate exactly as before.
 */
export function allowedEmailsFor(file: string, text: string): readonly string[] {
  const isHoldingIndex = path.basename(file) === 'index.html' && text.includes(HOLDING_PAGE_MARKER);
  return isHoldingIndex ? [PUBLISHED_CONTACT_EMAIL] : [];
}

/**
 * Resolve a `--files-from` subset (site-relative paths) to the published files to scan.
 *
 * WI-10003694: an incremental publish uploads only the files that changed, so it gates exactly
 * those — the rest were gated when they were published (release-site-delta re-gates everything
 * when the rules change). A listed path that does not exist, or escapes the site root, is a
 * "could not check" (thrown), never a silent skip: a subset gate that quietly scans less than
 * it was told to is the blind-gate defect again, one layer down.
 */
export function resolveSubset(dir: string, rels: readonly string[]): string[] {
  const root = path.resolve(dir);
  const files: string[] = [];
  for (const rel of rels) {
    const full = path.resolve(root, rel);
    if (full !== root && !full.startsWith(`${root}${path.sep}`)) {
      throw new Error(`listed path escapes the site root: ${rel}`);
    }
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      throw new Error(`listed path is not a file in the site: ${rel}`);
    }
    if (PUBLISHED.some((ext) => full.endsWith(ext))) files.push(full);
  }
  return files;
}

/** Pure — so the gate's own behaviour is testable without a directory of real pages. */
export function gateSite(
  dir: string,
  literals = identityLiterals(),
  subset?: readonly string[],
): SiteLeak[] {
  const leaks: SiteLeak[] = [];
  const files = subset ? resolveSubset(dir, subset) : walk(dir);
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    // Emscripten creates this VIRTUAL filesystem home in Graphviz's WASM
    // runtime. It is executable behavior, not the build machine's identity.
    // Keep the exception local to that vendor file and exact virtual username;
    // every actual home path and every explicit identity literal still gates.
    const relative = path.relative(dir, file).split(path.sep).join('/');
    const vendorGraphviz = relative ===
      'assets/vditor/dist/js/graphviz/full.render.js';
    const graphvizVirtualHome = ['/home', 'web_user'].join('/');
    let scanned = vendorGraphviz ? text.replaceAll(graphvizVirtualHome, '/virtual/web_user') : text;
    if (relative === 'assets/vditor/dist/js/lute/lute.min.js') {
      // Video-format names can coincide with a person's name. This exact
      // neighboring-token sequence is Lute's extension registry, not identity
      // prose. Any occurrence elsewhere in the file remains fully checked.
      scanned = scanned.replaceAll('"mov","avi","wmv"', '"video-formats"');
    }
    const allowEmails = allowedEmailsFor(file, text);
    for (const hit of findIdentityLeaks(scanned, literals, { allowEmails })) {
      // Show the first occurrence in context. Without this the operator knows a page
      // is dirty but not WHERE, and the tempting next move is to hand-edit the HTML —
      // which the next regenerate silently reverts.
      const lines = text.split('\n');
      const line = lines.find((l) =>
        findIdentityLeaks(l, literals, { allowEmails }).some((h) => h.kind === hit.kind),
      );
      leaks.push({
        file: path.relative(dir, file),
        kind: hit.kind,
        count: hit.count,
        sample: (line ?? '').trim().slice(0, 120),
      });
    }
  }
  return leaks;
}

// `literals` is injectable for the same reason `gateSite`'s is: the fail-closed path below
// is the one branch that MUST be provable, and resolving identity from the real box would
// make its test pass or fail according to whatever `git config user.name` happens to be —
// including, on this box today, the very bot identity that caused the bug.
export function main(
  argv: string[] = process.argv.slice(2),
  literals: IdentityLiteral[] = identityLiterals(),
): number {
  const dir = argv[0];
  if (!dir || dir.startsWith('--')) {
    console.error('usage: gate-release-site <dir> [--files-from <list>]');
    return 2;
  }
  if (!fs.existsSync(dir)) {
    console.error(`gate-release-site: ${dir} does not exist`);
    return 2;
  }
  const filesFromAt = argv.indexOf('--files-from');
  let subset: string[] | undefined;
  if (filesFromAt >= 0) {
    const listFile = argv[filesFromAt + 1];
    if (!listFile || !fs.existsSync(listFile)) {
      console.error(`gate-release-site: --files-from list ${listFile ?? '<missing>'} does not exist`);
      return 2;
    }
    subset = fs
      .readFileSync(listFile, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  /**
   * FAIL CLOSED when no owner-name literal resolves.
   *
   * This gate's entire value is that a CLEAN verdict is EVIDENCE. Without a name literal
   * it cannot inspect the one identity class that has no shape to fall back on, so its
   * "CLEAN" degrades to "I looked for nothing" while still reading, to every human and
   * every script downstream, as proof. That is strictly worse than no gate: it converts an
   * unverified publish into an apparently-verified one.
   *
   * Measured when this was caught (EI-20583328178472869): git `user.name` had become the
   * git-sync bot, so the scrub redacted the owner's real name 0 times, a fresh regen of the
   * live page carried 38 raw names across 444 files — and this gate printed CLEAN, exit 0.
   *
   * Exit 2 (configuration), not 1 (leaks found). "I cannot check" and "I checked and found
   * nothing" must never share an exit code, or a caller's `|| exit` cannot tell a blind gate
   * from a clean one — the same conflation, one layer up.
   */
  if (!hasOwnerNameLiteral(literals)) {
    console.error(
      '[gate] 🔴 REFUSING TO CERTIFY — no owner-name literal resolved, so the owner\'s name ' +
        'cannot be detected on this page and a CLEAN verdict here would be meaningless.\n' +
        `  Cause: \`git config user.name\` is unset or belongs to an automation (a bot/CI identity).\n` +
        `  Fix:   put ${OWNER_NAME_ENV}=<the owner's name> in ${defaultIdentityEnvPath()} — this\n` +
        '         CLI reads that file automatically — or export it just for this publish, which\n' +
        '         takes precedence. Either way it is read at RUN TIME and never written into a\n' +
        '         source file: doing that would itself be the leak, committed to git forever.',
    );
    return 2;
  }

  let leaks: SiteLeak[];
  let pages: number;
  try {
    leaks = gateSite(dir, literals, subset);
    pages = subset ? resolveSubset(dir, subset).length : walk(dir).length;
  } catch (error) {
    console.error(
      `[gate] 🔴 COULD NOT CHECK — ${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }

  if (leaks.length === 0) {
    // Name what it actually checked. A gate that says only "clean" is indistinguishable
    // from a gate that checked nothing — and a gate with nothing to assert is the exact
    // failure mode that let the dead update-host ship (WI-4389).
    const kinds = [...new Set(literals.map((l) => l.kind))].join(', ');
    const scope = subset
      ? ` (the ${subset.length} changed file(s) listed for upload; every other file was gated when it was published)`
      : '';
    console.log(
      `[gate] CLEAN — ${pages} page(s) scanned for this box's identity ` +
        `(${kinds || 'no machine literals resolved'}) plus any email address or home path${scope}.`,
    );
    return 0;
  }

  console.error(`[gate] 🔴 ${leaks.length} LEAK(S) across ${pages} page(s):\n`);
  for (const l of leaks) {
    console.error(`  ${l.file}`);
    console.error(`    ${l.kind} ×${l.count}:  ${l.sample}`);
  }
  return 1;
}

// `npx tsx gate-release-site.ts <dir>` — the form the publish script calls.
if (isCliEntry(import.meta.url)) {
  /**
   * Resolve the owner identity BEFORE `main()` evaluates its default `literals`.
   *
   * This lives at the process boundary, not inside `identityLiterals()`, on purpose: the
   * fail-closed branch above is the one branch that MUST be provable, and a file read
   * buried in the resolver would make its test pass on a box that happens to have the
   * config file and fail in CI, which is no guard at all.
   *
   * It only fills a gap — an exported value still wins — and a missing file is reported,
   * not fatal, because refusing is `main()`'s job and it does it with a better message.
   */
  console.error(describeOwnerIdentityLoad(loadOwnerIdentityEnv()));
  process.exit(main());
}
