#!/usr/bin/env node
/**
 * check-github-identity-terms.mjs — fail-loud guard against the
 * papercupai-vs-Papercusp user/org drift (WI-4978).
 *
 * Ground truth (verified live against the GitHub API, 2026-07-20):
 *   - `papercupai` is a GitHub **User** (created 2026-04-25) — the maintainer's
 *     personal admin login. It cannot be an "org" — GitHub has no org-membership
 *     endpoint for a user account, so any code or doc that treats it as one is
 *     either lying to a reader or, worse, silently broken (the first-party
 *     `@papercusp/*` publish gate in papercusp-registry's auth.ts hardcoded
 *     `FIRST_PARTY_ORG = 'papercupai'`, so `GET /orgs/papercupai/members/<login>`
 *     404'd for EVERY publisher, including the real owner — nobody could ever
 *     pass the check).
 *   - `Papercusp` is the real GitHub **Organization** (created 2026-05-28) that
 *     owns the canonical repos (`Papercusp/papercup`, `Papercusp/papercusp-registry`,
 *     `Papercusp/papercusp`, …). `papercupai` has active admin membership in it.
 *
 * This is a doc/prose guard (regex, not a live API call — keep it hermetic and
 * fast): it fails if a doc under the docs root describes `papercupai` as a GitHub
 * org or organization. The canonical explanation lives in ONE place —
 * apps/operator-docs/src/content/docs/spec/distribution.mdx, "Canonical GitHub
 * identity" callout — link to it instead of re-describing the identities.
 *
 * CORPUS: `.md`/`.mdx` under DOCS_PREFIX only — deliberately NOT "every tracked
 * doc", despite what this header said until 2026-08-10. Widening it re-scans
 * apps/operator/public/internal/docs/**, which is BUILD OUTPUT (the rendered
 * projection of these same files), so every offender would be reported twice and
 * "fixed" in a directory whose edits are discarded (EI-18760552901594056).
 *
 * ESCAPE HATCH (WI-37717). A doc that must SAY the wrong phrase in order to
 * correct it is the guard's own phantom-offender class — this guard quotes the
 * banned shape in its own header, which is exactly why its own source is on the
 * exclusion list below. Until 2026-08-10 the only way to write such a doc was to
 * hard-code its path HERE, i.e. prose could only justify itself by editing code.
 * Now it can say so in place, on the line or within 3 lines above:
 *
 *     github-identity-justified: correcting the record — quoting the wrong phrasing
 *
 * A bare marker with no reason after the colon is rejected: "justify" is the whole
 * rule, so an empty marker is just a mute button. (Same convention, and the same
 * reasoning, as `sql-snippet-justified:` in check-sql-guidance-justified.mjs.)
 * The two whole-file exclusions stay: spec/distribution.mdx is the canonical
 * correction end-to-end, so per-line markers there would be noise, and this
 * script cannot annotate itself.
 *
 * The sibling functional guard for the CODE side of this bug (the
 * FIRST_PARTY_ORG constant itself) lives in the papercusp-registry repo:
 * apps/marketplace-api/src/auth.guard.test.ts (separate repo, own test run).
 *
 * Usage: npm run lint:github-identity-terms
 * Exit codes: 0 clean, 1 a doc still calls papercupai an org.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS_PREFIX = 'apps/operator-docs/src/content/docs/';

// Matches "papercupai ... org" / "papercupai ... organization" (either word
// order, small word-gap) case-insensitively — the exact shape of the bug's
// reported symptom ("papercupai GitHub org") and its inverse phrasing.
const BAD_PATTERNS = [
  /papercupai[^\n]{0,40}\borgani[sz]ation\b/i,
  /papercupai[^\n]{0,40}\borg\b/i,
  /\borgani[sz]ation[^\n]{0,40}papercupai\b/i,
  /\borg\b[^\n]{0,40}papercupai\b/i,
];

// The canonical-identity callout itself intentionally discusses both terms
// together to correct the record — exclude it (and this script's own source)
// from the scan rather than trying to make the regex clever enough to allow
// exactly one paragraph.
const isExcluded = (f) =>
  f.includes('/_retired/') ||
  f.includes('/node_modules/') ||
  f.includes('/dist/') ||
  f === 'apps/operator-docs/src/content/docs/spec/distribution.mdx' ||
  f === 'scripts/check-github-identity-terms.mjs';

/** The justification marker; everything after the colon is the reason. */
export const MARKER_RE = /github-identity-justified:[ \t]*(\S.*)$/i;
/** How many lines above the offending line may carry the marker. */
export const MARKER_LOOKBACK = 3;

/**
 * PURE: the offending lines in one doc's text. Both `main()` and `--self-test`
 * call this, so a control cannot drift from the code it pins.
 *
 * @param {string} text
 * @returns {Array<{ line: number, text: string }>}
 */
export function findOffenders(text) {
  const lines = text.split('\n');
  const offenders = [];
  lines.forEach((line, i) => {
    if (!BAD_PATTERNS.some((re) => re.test(line))) return;
    // Justified in place? The marker may sit on this line or just above it.
    const window = lines.slice(Math.max(0, i - MARKER_LOOKBACK), i + 1);
    if (window.some((l) => MARKER_RE.test(l))) return;
    offenders.push({ line: i + 1, text: line.trim() });
  });
  return offenders;
}

function main() {
  const tracked = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    .split('\n')
    .filter(Boolean);

  const offenders = [];
  for (const f of tracked) {
    if (isExcluded(f)) continue;
    if (!(f.endsWith('.mdx') || f.endsWith('.md'))) continue;
    if (!f.startsWith(DOCS_PREFIX)) continue;
    let text;
    try {
      text = readFileSync(new URL(f, `file://${ROOT}/`), 'utf8');
    } catch {
      continue;
    }
    for (const o of findOffenders(text)) offenders.push({ file: f, ...o });
  }

  if (offenders.length > 0) {
    console.error(`❌ ${offenders.length} doc line(s) describe "papercupai" as a GitHub org/organization.`);
    console.error('   papercupai is a GitHub USER; the real org is `Papercusp`. See the canonical');
    console.error('   identity note in apps/operator-docs/src/content/docs/spec/distribution.mdx');
    console.error('   ("Canonical GitHub identity") and WI-4978.');
    for (const o of offenders) {
      console.error(`   ${o.file}:${o.line}: ${o.text}`);
    }
    process.exit(1);
  }

  console.log('✓ no doc describes papercupai as a GitHub org/organization.');
}

// Import-safe: the scan runs only when this file is the entrypoint, so a test can
// import findOffenders without the scan (and its process.exit) firing on import.
const RUN_AS_MAIN = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (RUN_AS_MAIN && process.argv.includes('--self-test')) {
  // [FALSIFIES] = gives the WRONG answer without the escape hatch this added.
  // [ANCHOR]    = passes before AND after; pins that the hatch did not defeat the
  //               guard. Do not "tidy" the anchors away for looking redundant.
  const cases = [
    ['[ANCHOR] the plain offending phrasing still fails', 'The papercupai org owns the repos.', 1],
    ['[ANCHOR] the inverse word order still fails', 'Members of the organization papercupai can publish.', 1],
    ['[ANCHOR] an innocent mention of the user is clean', 'The `papercupai` user is the maintainer login.', 0],
    [
      '[FALSIFIES] a doc correcting the record can justify itself in place',
      'github-identity-justified: correcting the record — quoting the wrong phrasing\nAny doc calling it the papercupai org is describing something that cannot exist.',
      0,
    ],
    [
      '[FALSIFIES] the marker also counts on the SAME line',
      'Do not say "the papercupai org". github-identity-justified: shows the banned phrasing',
      0,
    ],
    [
      '[ANCHOR] a BARE marker with no reason does not silence it (an empty marker is a mute button)',
      'github-identity-justified:\nThe papercupai org owns the repos.',
      1,
    ],
    [
      '[ANCHOR] a marker further than the lookback does not reach',
      ['github-identity-justified: too far above', '', '', '', 'The papercupai org owns the repos.'].join('\n'),
      1,
    ],
  ];
  let failed = 0;
  for (const [name, text, expected] of cases) {
    const got = findOffenders(text).length;
    const ok = got === expected;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} (expected ${expected}, got ${got})`);
  }
  console.log(`\n--self-test: ${cases.length - failed}/${cases.length} passed`);
  process.exit(failed ? 1 : 0);
}

if (RUN_AS_MAIN) main();
