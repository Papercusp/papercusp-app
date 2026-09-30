#!/usr/bin/env node
/**
 * okf-frontmatter-sweep.mjs — READ-ONLY census of OKF v0.2 frontmatter adoption
 * across the two corpora (okf-frontmatter-adoption-2026-08-08 P-001).
 *
 *   npm run okf:sweep            # human-readable report
 *   npm run okf:sweep -- --json  # machine-readable, for diffing two runs
 *
 * WHY THIS EXISTS, and why it must be re-run rather than trusted from memory:
 * the plan's own rule is *sweep first, then declare, then backfill*. Declaring a
 * field in `apps/operator-docs/src/content.config.ts` newly VALIDATES the entire
 * corpus, so the value of this script is the DENOMINATOR — how many files a
 * declaration is about to start judging — not the field counts.
 *
 * Three deliberate choices, each of which is a documented false-green here:
 *
 *  1. It walks the FILESYSTEM, not `git ls-files`. `git ls-files` in the
 *     superproject does not recurse submodules (WI-6666), so it reports ZERO
 *     knowledge-pack files — a clean-looking result for a corpus it never
 *     opened. It is also blind to a brand-new untracked doc.
 *  2. It counts `.mdx` AND `.md`. The agent-insights corpus is ~99% `.mdx`;
 *     an `*.md` glob finds ~7 of 660 and reads identical to a clean sweep.
 *  3. It prints the denominator FIRST and fails (exit 2) if either corpus walks
 *     ZERO files, because "0 offenders" and "0 files examined" are the same
 *     output otherwise.
 *
 * Scope for agent-insights is imported from the shared `insight-corpus` module
 * rather than re-encoded, so this sweep and the lints can never disagree about
 * what the corpus IS. Run via `tsx` — it imports that `.ts` module.
 */
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, dirname, relative, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { isInsightDoc, INSIGHT_DOCS_PREFIX } from '../packages/operator-core/lib/content-lint/insight-corpus';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The four OKF v0.2 fields this plan adopts, plus the manifest-level one. */
export const OKF_DOC_FIELDS = ['type', 'generated', 'verified', 'stale_after'];
export const OKF_MANIFEST_FIELD = 'okf_version';

export const PACKS_PREFIX = 'libs/papercusp/packages/harness/knowledge-packs/';

const SKIP_DIRS = new Set(['node_modules', 'dist', '_retired', '.git']);

/**
 * Recursively list repo-relative file paths under `dir` (absolute).
 *
 * Dot-prefixed entries are skipped, but NOT silently: they are collected into
 * `skipped` and printed with the denominator. Astro's content loader ignores
 * dot-paths, so `agent-insights/.papercusp/memory/raw.md` is NOT schema-validated
 * even though it is git-tracked and `isInsightDoc()` accepts it — i.e. the
 * corpus lints' denominator and the schema's differ by exactly these files.
 * An unreported skip is how that discrepancy stays invisible.
 */
export function walk(absDir, out = [], skipped = []) {
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return { files: out, skipped };
  }
  for (const e of entries) {
    const abs = join(absDir, e.name);
    if (e.name.startsWith('.')) {
      if (e.isDirectory()) collectAll(abs, skipped);
      else skipped.push(relative(ROOT, abs));
      continue;
    }
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(abs, out, skipped);
    } else if (e.isFile()) {
      out.push(relative(ROOT, abs));
    }
  }
  return { files: out, skipped };
}

function collectAll(absDir, into) {
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = join(absDir, e.name);
    if (e.isDirectory()) collectAll(abs, into);
    else into.push(relative(ROOT, abs));
  }
}

/**
 * Split leading YAML frontmatter off a document.
 * Returns { present, raw, body } — `present:false` means the file has no
 * `---`-delimited block at position 0, which is a DIFFERENT finding from
 * "frontmatter present but unparseable" and is reported separately.
 */
export function extractFrontmatter(text) {
  // Tolerate a UTF-8 BOM and CRLF line endings.
  const t = text.replace(/^﻿/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(t);
  if (!m) return { present: false, raw: null };
  return { present: true, raw: m[1] };
}

/** Parse frontmatter; never throws. */
export function parseFrontmatter(text) {
  const fm = extractFrontmatter(text);
  if (!fm.present) return { present: false, ok: false, data: null, error: null };
  try {
    const data = parseYaml(fm.raw);
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return { present: true, ok: false, data: null, error: 'frontmatter is not a mapping' };
    }
    return { present: true, ok: true, data, error: null };
  } catch (err) {
    return { present: true, ok: false, data: null, error: String(err?.message ?? err).split('\n')[0] };
  }
}

/** Census one set of doc files. */
function censusDocs(files, fields) {
  const byExt = {};
  const fieldCounts = Object.fromEntries(fields.map((f) => [f, 0]));
  const fieldExamples = Object.fromEntries(fields.map((f) => [f, []]));
  const noFrontmatter = [];
  const unparseable = [];
  const otherKeys = new Map();

  for (const f of files) {
    const ext = extname(f) || '(none)';
    byExt[ext] = (byExt[ext] ?? 0) + 1;
    let text;
    try {
      text = readFileSync(resolve(ROOT, f), 'utf8');
    } catch (err) {
      unparseable.push(`${f}  (unreadable: ${String(err?.message ?? err)})`);
      continue;
    }
    const fm = parseFrontmatter(text);
    if (!fm.present) {
      noFrontmatter.push(f);
      continue;
    }
    if (!fm.ok) {
      unparseable.push(`${f}  (${fm.error})`);
      continue;
    }
    for (const k of Object.keys(fm.data)) {
      otherKeys.set(k, (otherKeys.get(k) ?? 0) + 1);
    }
    for (const field of fields) {
      if (Object.prototype.hasOwnProperty.call(fm.data, field)) {
        fieldCounts[field]++;
        if (fieldExamples[field].length < 5) fieldExamples[field].push(f);
      }
    }
  }

  return {
    total: files.length,
    byExt,
    fieldCounts,
    fieldExamples,
    noFrontmatter,
    unparseable,
    frontmatterKeys: Object.fromEntries([...otherKeys.entries()].sort((a, b) => b[1] - a[1])),
  };
}

export function sweep() {
  const insightWalk = walk(resolve(ROOT, INSIGHT_DOCS_PREFIX));
  const insightFiles = insightWalk.files.filter(isInsightDoc);
  const insightSkipped = insightWalk.skipped.filter(isInsightDoc);

  const packWalk = walk(resolve(ROOT, PACKS_PREFIX));
  const packAll = packWalk.files;
  const packDocs = packAll.filter((f) => f.endsWith('.md') || f.endsWith('.mdx'));
  const packManifests = packAll.filter((f) => /(^|\/)manifest\.ya?ml$/.test(f));

  const manifestFields = { [OKF_MANIFEST_FIELD]: 0 };
  const manifestUnparseable = [];
  const manifestKeys = new Map();
  for (const f of packManifests) {
    let data;
    try {
      data = parseYaml(readFileSync(resolve(ROOT, f), 'utf8'));
    } catch (err) {
      manifestUnparseable.push(`${f}  (${String(err?.message ?? err).split('\n')[0]})`);
      continue;
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      manifestUnparseable.push(`${f}  (not a mapping)`);
      continue;
    }
    for (const k of Object.keys(data)) manifestKeys.set(k, (manifestKeys.get(k) ?? 0) + 1);
    if (Object.prototype.hasOwnProperty.call(data, OKF_MANIFEST_FIELD)) manifestFields[OKF_MANIFEST_FIELD]++;
  }

  return {
    sweptAt: new Date().toISOString(),
    insights: {
      prefix: INSIGHT_DOCS_PREFIX,
      ...censusDocs(insightFiles, OKF_DOC_FIELDS),
      skippedDotPaths: insightSkipped,
    },
    packDocs: { prefix: PACKS_PREFIX, ...censusDocs(packDocs, OKF_DOC_FIELDS), skippedDotPaths: [] },
    packManifests: {
      prefix: PACKS_PREFIX,
      total: packManifests.length,
      files: packManifests,
      fieldCounts: manifestFields,
      unparseable: manifestUnparseable,
      manifestKeys: Object.fromEntries([...manifestKeys.entries()].sort((a, b) => b[1] - a[1])),
    },
  };
}

function pct(n, d) {
  return d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`;
}

function report(r) {
  const lines = [];
  lines.push('OKF v0.2 frontmatter sweep — READ-ONLY census');
  lines.push(`  swept at ${r.sweptAt}`);
  lines.push('');

  for (const [label, c] of [
    ['agent-insights', r.insights],
    ['knowledge-pack docs', r.packDocs],
  ]) {
    lines.push(`## ${label}  (${c.prefix})`);
    lines.push(`  DENOMINATOR: ${c.total} file(s)  [${Object.entries(c.byExt).map(([e, n]) => `${e}:${n}`).join('  ') || 'none'}]`);
    if (c.skippedDotPaths?.length) {
      lines.push(`  NOT COUNTED — dot-path (Astro's loader ignores these, so the schema never sees them): ${c.skippedDotPaths.length}`);
      for (const f of c.skippedDotPaths) lines.push(`      · ${f}`);
    }
    for (const f of OKF_DOC_FIELDS) {
      const n = c.fieldCounts[f];
      const ex = n > 0 ? `  e.g. ${c.fieldExamples[f].slice(0, 2).join(', ')}` : '';
      lines.push(`    ${f.padEnd(12)} ${String(n).padStart(4)} / ${c.total}  (${pct(n, c.total)})${ex}`);
    }
    lines.push(`    no frontmatter block: ${c.noFrontmatter.length}`);
    for (const f of c.noFrontmatter.slice(0, 10)) lines.push(`      - ${f}`);
    if (c.noFrontmatter.length > 10) lines.push(`      … ${c.noFrontmatter.length - 10} more`);
    lines.push(`    UNPARSEABLE frontmatter: ${c.unparseable.length}`);
    for (const f of c.unparseable) lines.push(`      ✗ ${f}`);
    const keys = Object.entries(c.frontmatterKeys);
    lines.push(`    existing frontmatter keys (${keys.length}): ${keys.map(([k, n]) => `${k}(${n})`).join('  ')}`);
    lines.push('');
  }

  const m = r.packManifests;
  lines.push(`## knowledge-pack manifests  (${m.prefix})`);
  lines.push(`  DENOMINATOR: ${m.total} manifest(s)`);
  for (const f of m.files) lines.push(`    - ${f}`);
  lines.push(`    ${OKF_MANIFEST_FIELD.padEnd(12)} ${m.fieldCounts[OKF_MANIFEST_FIELD]} / ${m.total}  (${pct(m.fieldCounts[OKF_MANIFEST_FIELD], m.total)})`);
  lines.push(`    UNPARSEABLE: ${m.unparseable.length}`);
  for (const f of m.unparseable) lines.push(`      ✗ ${f}`);
  lines.push(`    manifest keys: ${Object.entries(m.manifestKeys).map(([k, n]) => `${k}(${n})`).join('  ')}`);
  return lines.join('\n');
}

function main() {
  const json = process.argv.includes('--json');
  const r = sweep();
  console.log(json ? JSON.stringify(r, null, 2) : report(r));

  // A zero denominator is the failure this script exists to make loud: it is
  // indistinguishable from a clean result in every other respect.
  const empties = [];
  if (r.insights.total === 0) empties.push(`agent-insights (${r.insights.prefix})`);
  if (r.packDocs.total === 0) empties.push(`knowledge-pack docs (${r.packDocs.prefix})`);
  if (r.packManifests.total === 0) empties.push(`knowledge-pack manifests (${r.packManifests.prefix})`);
  if (empties.length) {
    console.error(`\n✗ ZERO files walked for: ${empties.join(', ')} — the sweep measured nothing.`);
    process.exit(2);
  }

  const bad = r.insights.unparseable.length + r.packDocs.unparseable.length + r.packManifests.unparseable.length;
  if (bad > 0) {
    console.error(`\n⚠ ${bad} file(s) have unparseable frontmatter — declaring a schema field will red the build on these first.`);
    process.exit(1);
  }
  process.exit(0);
}

const invokedPath = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '';
if (import.meta.url === invokedPath) main();
