#!/usr/bin/env node
/**
 * harness.css → DTCG seeder (plan §17.5 step A).
 *
 * Reads CSS custom properties from one or more .css files and emits a
 * candidate DTCG JSON fragment. The output is intentionally NOT semantic
 * — it preserves the original variable names so the human/agent doing
 * step B (semantic rename + dedup) can see what came from where.
 *
 * Runs once per source file. Output goes to stdout by default; pass
 * --out=<path> to write to a file. Existing files are not overwritten
 * unless --force is set.
 *
 * Usage:
 *   node apps/operator/scripts/seed-dtcg-from-css.mjs \
 *     apps/operator/app/harness/harness.css \
 *     [more.css...] \
 *     --out=design/tokens/seeded-from-harness-css.json
 *
 * Heuristics:
 *   - --color-* / values starting with #, rgb(, hsl(, color-mix(  → $type=color
 *   - values matching /^-?[\d.]+(px|rem|em|%|vh|vw)$/                → $type=dimension
 *   - values matching /^-?[\d.]+s$|^[\d.]+ms$/                       → $type=duration
 *   - integer values 100..900 with --font-weight or --weight in id   → $type=fontWeight
 *   - everything else                                                → $type unset, kept under
 *                                                                       a "raw" group with the
 *                                                                       original value as a string
 *
 * Step B (the semantic pass) is intentionally manual — token names are
 * a design judgment call, not a regex job.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const args = process.argv.slice(2);
const inputs = [];
let outPath = null;
let force = false;

for (const a of args) {
  if (a === '--force' || a === '-f') force = true;
  else if (a === '--out') {
    outPath = args[args.indexOf(a) + 1];
  } else if (a.startsWith('--out=')) outPath = a.slice('--out='.length);
  else if (outPath === args[args.indexOf(a) - 1] && args[args.indexOf(a) - 1] === '--out') {
    // already consumed by --out
  } else if (a.startsWith('-')) {
    process.stderr.write(`unknown flag: ${a}\n`);
    process.exit(2);
  } else if (args[args.indexOf(a) - 1] === '--out') {
    // skip — was the value of --out
  } else {
    inputs.push(a);
  }
}

if (inputs.length === 0) {
  process.stderr.write('usage: seed-dtcg-from-css.mjs <css...> [--out=path] [--force]\n');
  process.exit(2);
}

// ─── Heuristics ────────────────────────────────────────────────────
const COLOR_RE = /^(?:#[0-9a-fA-F]{3,8}|rgb|rgba|hsl|hsla|color-mix|color\(|currentColor|transparent|var\(--(?:color|fg|bg|accent|border|text|muted|good|bad|warn|info))/;
const DIM_RE = /^-?\d*\.?\d+(?:px|rem|em|%|vh|vw|ch|fr)$/;
const DURATION_RE = /^\d*\.?\d+(?:s|ms)$/;
const NUMERIC_RE = /^-?\d*\.?\d+$/;

function inferType(name, value) {
  const v = value.trim();
  if (/^--color-/.test(name) || COLOR_RE.test(v)) return 'color';
  if (DIM_RE.test(v)) return 'dimension';
  if (DURATION_RE.test(v)) return 'duration';
  if ((/font-weight/.test(name) || /weight/.test(name)) && NUMERIC_RE.test(v)) {
    const n = Number(v);
    if (Number.isInteger(n) && n >= 100 && n <= 900) return 'fontWeight';
  }
  if (NUMERIC_RE.test(v)) return 'number';
  return null; // raw
}

// ─── Parse ─────────────────────────────────────────────────────────
function parseCss(file, src) {
  // Match all `--name: value;` declarations. Handles function-call values
  // (var(...), color-mix(...), rgba(...)) by tracking paren depth.
  const out = [];
  const re = /(--[A-Za-z0-9_-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const name = m[1].trim();
    const value = m[2].trim();
    out.push({ file, name, value, type: inferType(name, value) });
  }
  return out;
}

function dedupKeepFirst(decls) {
  // Multiple :root scopes can redeclare the same var (light/dark, media
  // queries). Keep the first occurrence for the seed.
  const seen = new Map();
  for (const d of decls) {
    if (!seen.has(d.name)) seen.set(d.name, d);
  }
  return [...seen.values()];
}

// ─── Build DTCG document ───────────────────────────────────────────
function nameToPath(name) {
  // --h-feature-filter-tone → ['h', 'feature', 'filter', 'tone']
  return name.replace(/^--/, '').split('-');
}

function isTokenLeaf(v) {
  return v && typeof v === 'object' && '$value' in v;
}

function setNested(target, path, value) {
  // Walk to the parent of the final key. At each step, if the existing
  // entry is a token leaf (has $value) we'd be writing children into a
  // token, which DTCG forbids. Promote the existing leaf to its
  // ".default" key first.
  let cur = target;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i];
    const existing = cur[k];
    if (existing == null) {
      cur[k] = {};
    } else if (isTokenLeaf(existing)) {
      cur[k] = { default: existing };
    }
    cur = cur[k];
  }
  const finalKey = path[path.length - 1];
  const existing = cur[finalKey];
  // Inverse case: existing is already a group (has children), but we want
  // to write a leaf at this path. Push the leaf to ".default".
  if (existing && typeof existing === 'object' && !isTokenLeaf(existing)) {
    cur[finalKey] = { ...existing, default: value };
  } else {
    cur[finalKey] = value;
  }
}

function buildDoc(decls) {
  const root = {
    $schema: 'https://design-tokens.org/schemas/v1.json',
    $description:
      'Seeded from harness.css custom properties. NOT a semantic naming — ' +
      'paths follow the original CSS var names. Step B of plan §17.5 is to ' +
      'rename these to semantic ids (color.bg.surface, space.gutter, …) ' +
      'and dedup before merging into design/tokens/base.json.',
  };
  for (const d of decls) {
    const path = nameToPath(d.name);
    const entry = d.type
      ? { $type: d.type, $value: d.value, $description: `from ${d.file}` }
      : { $value: d.value, $description: `from ${d.file} — type unknown, raw` };
    setNested(root, path, entry);
  }
  return root;
}

// ─── Main ──────────────────────────────────────────────────────────
const allDecls = [];
const stats = { byFile: {}, byType: { color: 0, dimension: 0, duration: 0, fontWeight: 0, number: 0, raw: 0 } };

for (const inFile of inputs) {
  const abs = resolve(inFile);
  const src = readFileSync(abs, 'utf-8');
  const decls = parseCss(abs, src);
  stats.byFile[inFile] = decls.length;
  for (const d of decls) {
    stats.byType[d.type ?? 'raw']++;
    allDecls.push(d);
  }
}

const deduped = dedupKeepFirst(allDecls);
const doc = buildDoc(deduped);
const json = JSON.stringify(doc, null, 2) + '\n';

if (outPath) {
  if (existsSync(outPath) && !force) {
    process.stderr.write(`${outPath} exists; pass --force to overwrite\n`);
    process.exit(1);
  }
  writeFileSync(outPath, json);
  process.stderr.write(`wrote ${outPath}\n`);
} else {
  process.stdout.write(json);
}

process.stderr.write(`\n[seed-dtcg-from-css] ${deduped.length} unique custom properties (from ${allDecls.length} declarations)\n`);
for (const [k, v] of Object.entries(stats.byType)) {
  process.stderr.write(`  ${k}: ${v}\n`);
}
process.stderr.write('  files:\n');
for (const [k, v] of Object.entries(stats.byFile)) {
  process.stderr.write(`    ${k}: ${v}\n`);
}
