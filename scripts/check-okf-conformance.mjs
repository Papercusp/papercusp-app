#!/usr/bin/env node
/**
 * check-okf-conformance.mjs — fail-loud guard for OKF v0.2 frontmatter
 * conformance across BOTH corpora (`okf-frontmatter-adoption-2026-08-08` P-006).
 *
 *   npm run lint:okf-conformance          # verdict + denominators
 *   npm run lint:okf-conformance -- --list  # offenders, one per line, allowlist-seedable
 *   npm run lint:okf-conformance -- --json  # the whole scan, machine-readable
 *
 * Modelled on `check-insight-normative.mjs`, which exists for exactly this shape
 * (a conditional rule Zod cannot express). The RULES live in
 * `@papercusp/docs-engine`'s `okf-conformance.ts` beside the read surface they
 * protect; this file is only the WALKER + the allowlist + the reporting.
 *
 * Four things it does deliberately, each of which is a documented false-green:
 *
 * 1. **It walks the FILESYSTEM, not `git ls-files`** — the superproject's
 *    `git ls-files` does not recurse submodules (WI-6666), so it reports ZERO
 *    knowledge-pack files: a clean-looking verdict for a corpus it never opened.
 *    The walker is imported from the P-001 sweep rather than re-written, so the
 *    census and the lint can never disagree about what they are looking at.
 * 2. **DOT-PATHS ARE EXCLUDED, and reported as excluded.** Astro's content
 *    loader ignores dot-paths, so `agent-insights/.papercusp/memory/raw.md` is
 *    never schema-validated even though it is git-tracked and `isInsightDoc()`
 *    accepts it (plan D-001's denominator discrepancy). Demanding `type:` there
 *    would be an unfixable red — the file is machine-written scratch that no
 *    reader reaches through the docs surface. `walk()` skips them; this script
 *    PRINTS the count, because an unreported exclusion is how a shrinking
 *    denominator stays invisible.
 * 3. **It prints denominators FIRST and exits 2 on a zero** — "0 offenders" and
 *    "0 files examined" are otherwise the same output. Both corpora, plus the
 *    manifests, are checked independently: a lint that silently stops walking
 *    one of them goes green for the wrong reason.
 * 4. **The allowlist is seeded from `--list`, never from a hand-run grep.** This
 *    repo has corrected a measured population upward three times for precisely
 *    that reason (CLAUDE.md, shared-lib singletons: a proxy measurement's
 *    negative covers only the conditions it reproduced). It is also SHRINK-ONLY
 *    — an entry that no longer offends fails the run, so a fixed doc cannot
 *    leave permanent debt behind in this file.
 *
 * Run via `tsx`, not bare `node` — it imports `.ts` modules.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  findOkfDocViolations,
  findOkfManifestViolations,
  formatOkfViolations,
  OKF_CONFORMANCE_RULES,
} from '@papercusp/docs-engine';
import {
  isInsightDoc,
  INSIGHT_DOCS_PREFIX,
} from '../packages/operator-core/lib/content-lint/insight-corpus';
import { walk, PACKS_PREFIX } from './okf-frontmatter-sweep.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The repo-relative roots this lint SCANS — exported so the routing rule in
 * `scripts/affected-tests.mjs` can be asserted equal to them instead of drifting.
 *
 * The router MIRRORS these as literals rather than importing them (the router is
 * every agent's test-loop entry point, and a static import would let a load error
 * here hard-fail everyone's `test:affected`); the mirror is pinned by
 * `affected-tests-repo-wide-invariant-guards.test.ts`. If this scan widens, the
 * mirror must follow, or the guard silently stops firing on the new root — the
 * same "green because it stopped checking" shape as every other bounded guard here.
 */
export const OKF_SCAN_ROOTS = [INSIGHT_DOCS_PREFIX, PACKS_PREFIX];

/** True for a path this lint would actually open — the routing predicate's subject. */
export function isOkfScannedFile(f) {
  if (!OKF_SCAN_ROOTS.some((r) => f.startsWith(r))) return false;
  // Dot-paths are excluded from the scan itself (see the docblock), so routing on
  // them would attach the guard for a file it will never judge.
  if (f.split('/').some((seg) => seg.startsWith('.'))) return false;
  return f.endsWith('.md') || f.endsWith('.mdx') || /(^|\/)manifest\.ya?ml$/.test(f);
}

/**
 * Files exempted from the rules, with the reason.
 *
 * MEASURED, NOT GUESSED: seed every entry from `npm run lint:okf-conformance --
 * --list`, which prints exactly this format. EMPTY is the correct state and the
 * one the corpus is in as of P-006 — an entry here is real debt, so it carries a
 * reason and is expected to leave again.
 */
export const OKF_CONFORMANCE_ALLOWLIST = new Map([
  // (empty — the P-003/P-004 backfills left both corpora fully conformant)
]);

const isPackDoc = (f) => f.endsWith('.md') || f.endsWith('.mdx');
const isPackManifest = (f) => /(^|\/)manifest\.ya?ml$/.test(f);

function readOrNull(file) {
  try {
    return readFileSync(resolve(ROOT, file), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Walk both corpora and judge every file. Pure: returns the whole picture
 * (denominators, exclusions, offenders) and decides nothing — `main` owns the
 * exit codes so the scan itself stays usable from a test.
 */
export function scanOkfConformance() {
  const insightWalk = walk(resolve(ROOT, INSIGHT_DOCS_PREFIX));
  const packWalk = walk(resolve(ROOT, PACKS_PREFIX));

  const corpora = [
    {
      name: 'agent-insights',
      prefix: INSIGHT_DOCS_PREFIX,
      files: insightWalk.files.filter(isInsightDoc),
      // Dot-paths `isInsightDoc()` WOULD accept but Astro's loader never sees.
      excludedDotPaths: insightWalk.skipped.filter(isInsightDoc),
      check: findOkfDocViolations,
    },
    {
      name: 'knowledge-pack docs',
      prefix: PACKS_PREFIX,
      files: packWalk.files.filter(isPackDoc),
      excludedDotPaths: packWalk.skipped.filter(isPackDoc),
      check: findOkfDocViolations,
    },
    {
      name: 'knowledge-pack manifests',
      prefix: PACKS_PREFIX,
      files: packWalk.files.filter(isPackManifest),
      excludedDotPaths: packWalk.skipped.filter(isPackManifest),
      check: findOkfManifestViolations,
    },
  ];

  const results = [];
  for (const c of corpora) {
    const offenders = [];
    const allowedHits = [];
    let unreadable = 0;
    for (const file of c.files) {
      const text = readOrNull(file);
      if (text === null) {
        unreadable++;
        offenders.push({ file, message: 'unreadable', violations: [{ rule: 'unreadable', detail: 'read failed' }] });
        continue;
      }
      const violations = c.check(text);
      if (violations.length === 0) continue;
      const record = { file, violations, message: formatOkfViolations(violations) };
      if (OKF_CONFORMANCE_ALLOWLIST.has(file)) allowedHits.push(record);
      else offenders.push(record);
    }
    results.push({ ...c, check: undefined, total: c.files.length, files: undefined, offenders, allowedHits, unreadable });
  }

  // Shrink-only: an allowlist entry that no longer offends (fixed, renamed, or
  // deleted) is stale and must go, or the file accumulates permanent debt whose
  // entries nobody can tell from live ones.
  const stillOffending = new Set(results.flatMap((r) => r.allowedHits.map((a) => a.file)));
  const staleAllowlist = [...OKF_CONFORMANCE_ALLOWLIST.keys()].filter((f) => !stillOffending.has(f));

  return { scannedAt: new Date().toISOString(), corpora: results, staleAllowlist };
}

function report(scan) {
  const lines = ['OKF v0.2 conformance — agent-insights + knowledge-packs', ''];
  for (const c of scan.corpora) {
    lines.push(`## ${c.name}  (${c.prefix})`);
    lines.push(`  DENOMINATOR: ${c.total} file(s) judged`);
    if (c.excludedDotPaths.length) {
      lines.push(
        `  NOT JUDGED — dot-path (Astro's loader never sees these, so no reader can act on their metadata): ${c.excludedDotPaths.length}`,
      );
      for (const f of c.excludedDotPaths) lines.push(`      · ${f}`);
    }
    if (c.allowedHits.length) {
      lines.push(`  ALLOWLISTED offenders: ${c.allowedHits.length}`);
      for (const a of c.allowedHits) {
        lines.push(`      ~ ${a.file}  ${a.message}   [${OKF_CONFORMANCE_ALLOWLIST.get(a.file)}]`);
      }
    }
    lines.push(`  OFFENDERS: ${c.offenders.length}`);
    for (const o of c.offenders) lines.push(`      ✗ ${o.file}  ${o.message}`);
    lines.push('');
  }
  return lines.join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  const scan = scanOkfConformance();

  if (argv.includes('--json')) {
    console.log(JSON.stringify(scan, null, 2));
  } else if (argv.includes('--list')) {
    // Allowlist-seedable output: paste these lines into OKF_CONFORMANCE_ALLOWLIST.
    for (const c of scan.corpora) {
      for (const o of c.offenders) console.log(`  ['${o.file}', '${o.message}'],`);
    }
    console.log(
      `# ${scan.corpora.reduce((n, c) => n + c.offenders.length, 0)} offender(s) of ` +
        `${scan.corpora.reduce((n, c) => n + c.total, 0)} file(s) judged.`,
    );
  } else {
    console.log(report(scan));
  }

  // A zero denominator is the failure this guard exists to make loud: it is
  // indistinguishable from a clean result in every other respect.
  const empty = scan.corpora.filter((c) => c.total === 0);
  if (empty.length) {
    console.error(`✗ ZERO files judged for: ${empty.map((c) => `${c.name} (${c.prefix})`).join(', ')} — the lint measured nothing.`);
    process.exit(2);
  }

  const offenders = scan.corpora.flatMap((c) => c.offenders);
  if (offenders.length === 0 && scan.staleAllowlist.length === 0) {
    const judged = scan.corpora.map((c) => `${c.total} ${c.name}`).join(', ');
    console.log(`✓ OKF v0.2 conformance holds — ${judged}.`);
    process.exit(0);
  }

  if (offenders.length > 0) {
    console.error('\n✗ OKF v0.2 frontmatter conformance FAILED.\n');
    console.error('  The rules (see packages/docs-engine/src/okf-conformance.ts):');
    for (const [rule, why] of Object.entries(OKF_CONFORMANCE_RULES)) {
      console.error(`    ${rule.padEnd(30)} ${why}`);
    }
    console.error('');
    for (const o of offenders) console.error(`    ✗ ${o.file}  ${o.message}`);
    console.error(
      `\n  ${offenders.length} offender(s). Fix the frontmatter — do NOT invent a \`verified\`/\`stale_after\`` +
        `\n  value to silence a rule (plan D-002: a fabricated verification is strictly worse than none).` +
        `\n  If a file genuinely cannot conform, add it to OKF_CONFORMANCE_ALLOWLIST in ${'scripts/check-okf-conformance.mjs'}` +
        `\n  with a reason — seeded from \`npm run lint:okf-conformance -- --list\`, never a hand-run grep.`,
    );
  }

  if (scan.staleAllowlist.length > 0) {
    console.error(
      `\n✗ STALE allowlist entries — these files no longer offend (fixed, renamed, or deleted).` +
        `\n  The allowlist is SHRINK-ONLY: delete these lines from OKF_CONFORMANCE_ALLOWLIST.`,
    );
    for (const f of scan.staleAllowlist) console.error(`    - ${f}`);
  }

  process.exit(1);
}

const invokedPath = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '';
if (import.meta.url === invokedPath) main();
