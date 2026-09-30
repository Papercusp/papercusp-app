#!/usr/bin/env node
/**
 * okf-backfill-packs.mjs — idempotent codemod that brings the knowledge-pack
 * corpus onto OKF v0.2 (okf-frontmatter-adoption-2026-08-08 P-004).
 *
 *   npm run okf:backfill:packs -- --dry-run     # report only, writes nothing
 *   npm run okf:backfill:packs -- --limit 5     # canary batch (docs only)
 *   npm run okf:backfill:packs                  # the whole corpus
 *
 * Two writes, and deliberately never a third:
 *
 *   docs      `type: <the doc's own kind, verbatim>`, added ALONGSIDE `kind`,
 *             never replacing it. `kind` is load-bearing — the pack loader maps
 *             it onto the seeded memory row's kind — so this is additive.
 *   manifests `okf_version: "0.2"`.
 *
 * ⛔ It never writes `verified` or `stale_after`, for the same reason the
 * agent-insights backfill does not (D-002): no one has re-verified these
 * learnings and no author declared an expiry. A fabricated verification is
 * strictly worse than an absent one. It also never writes `generated:` — the
 * insights corpus derives `generated.at` from the first ADD commit, and these
 * files live in the `libs/papercusp` SUBMODULE, where the superproject's git log
 * returns an empty result that looks exactly like "never committed" (WI-6666).
 * Rather than mint a wrong provenance date from the wrong repo, this codemod
 * omits the field; a later pass can add it running from inside the submodule.
 *
 * WHY `type` IS A VERBATIM COPY, not a mapping table: all 70 docs are
 * `kind: feedback` today, so any hand-written map would be a one-entry constant
 * that silently mis-labels the first doc a pack author writes with a different
 * kind. Copying the value keeps it correct for kinds that do not exist yet.
 *
 * BYTE DISCIPLINE — two invariants this script must not break:
 *  1. Frontmatter is edited TEXTUALLY, never round-tripped through a YAML
 *     serializer, which would reflow quoting and list styles across 70 files and
 *     bury the one real added line.
 *  2. sync-map.json keeps 11 `work/` items BYTE-IDENTICAL to their `coding/`
 *     source (pack-sync.test.ts turns drift into a red). A uniform additive edit
 *     to every doc preserves that; a selective one would break it. This script
 *     therefore has no per-pack or per-item filtering, and `--limit` is a canary
 *     knob whose partial state is expected to be finished by a full run.
 */
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { walk, extractFrontmatter, PACKS_PREFIX } from './okf-frontmatter-sweep.mjs';
import { insertIntoFrontmatter } from './okf-backfill-insights.mjs';
import {
  OKF_VERSION,
  OKF_MANIFEST_KEY,
} from '../packages/operator-core/lib/knowledge-packs/pack-format';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const isPackDoc = (f) => f.endsWith('.md');
const isPackManifest = (f) => /(^|\/)manifest\.ya?ml$/.test(f);

/** Parse a frontmatter/YAML block into a mapping, or return a skip reason. */
function readMapping(raw) {
  let data;
  try {
    data = parseYaml(raw);
  } catch {
    return { skipped: 'unparseable-yaml' };
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { skipped: 'not-a-mapping' };
  }
  return { data };
}

/** Decide the addition for one pack DOC. Returns { lines, skipped }. */
export function planDocAddition(text) {
  const fm = extractFrontmatter(text);
  if (!fm.present) return { lines: [], skipped: 'no-frontmatter' };
  const { data, skipped } = readMapping(fm.raw);
  if (skipped) return { lines: [], skipped };

  const has = (k) => Object.prototype.hasOwnProperty.call(data, k);
  if (has('type')) return { lines: [], skipped: 'already-backfilled' };
  // `kind` is optional in the pack format (parseLearningFile defaults it to
  // 'feedback'). Mirror that default rather than skipping, so a doc that relies
  // on the default still gets the type the loader will actually give it.
  if (data.kind !== undefined && typeof data.kind !== 'string') {
    return { lines: [], skipped: 'kind-not-a-string' };
  }
  const kind = data.kind ?? 'feedback';
  return { lines: [`type: ${kind}`], kind };
}

/**
 * Decide the addition for one manifest.yaml. A manifest has NO `---` fences, so
 * the field is appended as a plain trailing line rather than inserted into a
 * frontmatter block.
 */
export function planManifestAddition(text) {
  const { data, skipped } = readMapping(text);
  if (skipped) return { next: null, skipped };
  if (Object.prototype.hasOwnProperty.call(data, OKF_MANIFEST_KEY)) {
    return { next: null, skipped: 'already-backfilled' };
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const body = text.endsWith(eol) ? text : text + eol;
  // Quoted on purpose: unquoted `0.2` is a YAML NUMBER, and `0.20` would then
  // round-trip as 0.2. parseManifest tolerates both, but the file should say
  // what it means.
  return { next: `${body}${OKF_MANIFEST_KEY}: "${OKF_VERSION}"${eol}` };
}

function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const limitIdx = argv.indexOf('--limit');
  const limit = limitIdx >= 0 ? Number(argv[limitIdx + 1]) : Infinity;

  const { files: walked } = walk(resolve(ROOT, PACKS_PREFIX));
  const docs = walked.filter(isPackDoc).sort();
  const manifests = walked.filter(isPackManifest).sort();

  // The same zero-denominator refusal the sweep makes: this corpus lives in a
  // submodule, and every wrong way to enumerate it (git ls-files, an *.mdx glob)
  // returns an empty set that is indistinguishable from a clean result.
  if (docs.length === 0 || manifests.length === 0) {
    console.error(
      `✗ ZERO ${docs.length === 0 ? 'pack docs' : 'manifests'} walked under ${PACKS_PREFIX} — ` +
        'the codemod measured nothing. Refusing.',
    );
    process.exit(2);
  }

  const counts = { docsChanged: 0, docsAlready: 0, docsSkipped: 0, typeByKind: {} };
  const problems = [];
  let touched = 0;

  for (const f of docs) {
    if (touched >= limit) break;
    const abs = resolve(ROOT, f);
    const text = readFileSync(abs, 'utf8');
    const { lines, kind, skipped } = planDocAddition(text);

    if (skipped === 'already-backfilled') {
      counts.docsAlready++;
      continue;
    }
    if (skipped) {
      counts.docsSkipped++;
      problems.push(`${f}  (${skipped})`);
      continue;
    }

    const next = insertIntoFrontmatter(text, lines);
    if (next === null) {
      counts.docsSkipped++;
      problems.push(`${f}  (frontmatter delimiters not matched on write)`);
      continue;
    }
    if (!dryRun) writeFileSync(abs, next, 'utf8');
    counts.typeByKind[kind] = (counts.typeByKind[kind] ?? 0) + 1;
    counts.docsChanged++;
    touched++;
  }

  const mCounts = { changed: 0, already: 0, skipped: 0 };
  for (const f of manifests) {
    const abs = resolve(ROOT, f);
    const text = readFileSync(abs, 'utf8');
    const { next, skipped } = planManifestAddition(text);
    if (skipped === 'already-backfilled') {
      mCounts.already++;
      continue;
    }
    if (skipped || next === null) {
      mCounts.skipped++;
      problems.push(`${f}  (${skipped ?? 'no-write'})`);
      continue;
    }
    if (!dryRun) writeFileSync(abs, next, 'utf8');
    mCounts.changed++;
  }

  console.log(`${dryRun ? '[dry-run] ' : ''}OKF backfill — knowledge packs  (${PACKS_PREFIX})`);
  console.log(`  docs DENOMINATOR: ${docs.length} file(s)`);
  console.log(`    ${dryRun ? 'would change' : 'changed'}: ${counts.docsChanged}`);
  console.log(`    already backfilled (untouched): ${counts.docsAlready}`);
  console.log(
    `    type: ${Object.entries(counts.typeByKind).map(([k, n]) => `${k}=${n}`).join('  ') || 'none'}`,
  );
  console.log(`    skipped/problem: ${counts.docsSkipped}`);
  console.log(`  manifest DENOMINATOR: ${manifests.length} file(s)`);
  console.log(`    ${dryRun ? 'would change' : 'changed'}: ${mCounts.changed}   already: ${mCounts.already}   skipped: ${mCounts.skipped}`);
  for (const p of problems.slice(0, 20)) console.log(`      · ${p}`);
  if (problems.length > 20) console.log(`      … ${problems.length - 20} more`);

  if (!dryRun && counts.docsChanged > 0) {
    console.log(
      '\n  ⚠ NEXT: run `npm run gen:knowledge-packs:check` — the 11 synced work/ items must ' +
        'still be byte-identical to coding/ (pack-sync.test.ts enforces it).',
    );
  }

  process.exit(counts.docsSkipped + mCounts.skipped > 0 ? 1 : 0);
}

const invokedPath = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '';
if (import.meta.url === invokedPath) main();
