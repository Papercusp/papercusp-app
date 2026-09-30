#!/usr/bin/env node
/**
 * okf-backfill-insights.mjs — one-shot, idempotent codemod that adds the OKF v0.2
 * PROVENANCE fields to the agent-insights corpus
 * (okf-frontmatter-adoption-2026-08-08 P-003).
 *
 *   npm run okf:backfill -- --dry-run          # report only, writes nothing
 *   npm run okf:backfill -- --limit 5          # canary batch
 *   npm run okf:backfill                       # the whole corpus
 *
 * It writes exactly TWO keys, and deliberately never a third:
 *
 *   type: Insight | Convention   — Convention iff the doc already declares
 *                                  `normative: true`. That is not a new judgement
 *                                  about the prose: it reuses a distinction the
 *                                  corpus already curates and a lint already
 *                                  enforces. Classifying 659 docs as
 *                                  Insight-vs-Runbook by reading them is a
 *                                  guess dressed as metadata.
 *   generated: { by, at }        — `at` is the doc's FIRST commit date.
 *
 * ⛔ It never writes `verified` or `stale_after`. There is no source of truth for
 * either: nobody has re-verified these docs, and no author declared an expiry. A
 * fabricated verification is strictly worse than an absent one — it is the exact
 * failure this plan exists to make visible — so absence is the correct value and
 * both fields populate going forward, per-doc, by whoever actually does the work.
 *
 * ⚠ `generated.at` is the first commit that ADDED the file, which on this repo is
 * a git-sync sweep minutes-to-an-hour after authoring, not the author's own
 * commit (git-sync owns commit/push here, so no commit is ever scoped to one
 * agent's edit). It is therefore an upper bound on authoring time, accurate to
 * about an hour — honest as provenance, NOT precise enough to reason about
 * ordering between two docs added the same day. Where git has no add commit
 * (a brand-new untracked doc), it falls back to the existing `discovered:` value,
 * and if that is missing too it omits `at` rather than inventing one.
 *
 * BYTES: the frontmatter is edited TEXTUALLY, never round-tripped through a YAML
 * serializer. A serializer would reflow quoting, block scalars and list styles
 * across 659 files, burying the two real added lines in thousands of cosmetic
 * ones and making the diff unreviewable.
 */
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { isInsightDoc, INSIGHT_DOCS_PREFIX } from '../packages/operator-core/lib/content-lint/insight-corpus';
import { walk, extractFrontmatter } from './okf-frontmatter-sweep.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const GENERATED_BY = 'agent';

/**
 * Map every insight-doc path to the ISO date of the commit that first ADDED it,
 * in ONE `git log` pass. Per-file `git log` would be 659 subprocesses.
 */
export function firstCommitDates() {
  const out = execFileSync(
    'git',
    [
      'log',
      '--diff-filter=A',
      '--format=__C__%cI',
      '--name-only',
      '--reverse',
      '--',
      INSIGHT_DOCS_PREFIX,
    ],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  const dates = new Map();
  let current = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('__C__')) {
      current = line.slice(5).trim();
      continue;
    }
    const f = line.trim();
    if (!f || !current) continue;
    // --reverse walks oldest-first, so the FIRST sighting is the add. Never
    // overwrite: a later rename/re-add must not clobber the original date.
    if (!dates.has(f)) dates.set(f, current);
  }
  return dates;
}

/** `2026-05-20T12:33:59-04:00` / a YAML Date / `2026-05-20` → `2026-05-20`. */
export function toDay(value) {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  const s = String(value).trim();
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1] : null;
}

/**
 * Insert top-level `lines` immediately before the frontmatter's closing `---`.
 *
 * Column-0 insertion at the end of the block is valid regardless of what the
 * block contains (nested maps, block scalars, flow lists), which is why the
 * position is the end rather than "after key X".
 */
export function insertIntoFrontmatter(text, lines) {
  if (lines.length === 0) return text;
  const m = /^(---\r?\n[\s\S]*?\r?\n)(---)(\r?\n|$)/.exec(text.replace(/^﻿/, ''));
  if (!m) return null;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const head = text.slice(0, m[1].length);
  const tail = text.slice(m[1].length);
  return head + lines.join(eol) + eol + tail;
}

/** Decide the additions for one doc. Returns { lines, reason, skipped }. */
export function planAdditions(file, text, addDate) {
  const fm = extractFrontmatter(text);
  if (!fm.present) return { lines: [], skipped: 'no-frontmatter' };
  let data;
  try {
    data = parseYaml(fm.raw);
  } catch {
    return { lines: [], skipped: 'unparseable-frontmatter' };
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { lines: [], skipped: 'frontmatter-not-a-mapping' };
  }

  const lines = [];
  const has = (k) => Object.prototype.hasOwnProperty.call(data, k);

  if (!has('type')) {
    lines.push(`type: ${data.normative === true ? 'Convention' : 'Insight'}`);
  }
  if (!has('generated')) {
    const at = toDay(addDate) ?? toDay(data.discovered);
    lines.push('generated:');
    lines.push(`  by: ${GENERATED_BY}`);
    if (at) lines.push(`  at: ${at}`);
  }

  return { lines, skipped: lines.length === 0 ? 'already-backfilled' : null };
}

function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const limitIdx = argv.indexOf('--limit');
  const limit = limitIdx >= 0 ? Number(argv[limitIdx + 1]) : Infinity;

  const { files: walked, skipped: dotPaths } = walk(resolve(ROOT, INSIGHT_DOCS_PREFIX));
  const files = walked.filter(isInsightDoc).sort();

  if (files.length === 0) {
    console.error('✗ ZERO insight docs walked — the codemod measured nothing. Refusing.');
    process.exit(2);
  }

  const dates = firstCommitDates();
  const counts = { changed: 0, alreadyBackfilled: 0, skipped: 0, noAddDate: 0, typeByKind: {} };
  const problems = [];
  let touched = 0;

  for (const f of files) {
    if (touched >= limit) break;
    const abs = resolve(ROOT, f);
    const text = readFileSync(abs, 'utf8');
    const { lines, skipped } = planAdditions(f, text, dates.get(f));

    if (skipped === 'already-backfilled') {
      counts.alreadyBackfilled++;
      continue;
    }
    if (skipped) {
      counts.skipped++;
      problems.push(`${f}  (${skipped})`);
      continue;
    }

    const typeLine = lines.find((l) => l.startsWith('type: '));
    if (typeLine) {
      const t = typeLine.slice(6);
      counts.typeByKind[t] = (counts.typeByKind[t] ?? 0) + 1;
    }
    if (lines.some((l) => l.startsWith('generated:')) && !lines.some((l) => l.trim().startsWith('at: '))) {
      counts.noAddDate++;
      problems.push(`${f}  (no add-commit date and no discovered: — 'at' omitted)`);
    }

    const next = insertIntoFrontmatter(text, lines);
    if (next === null) {
      counts.skipped++;
      problems.push(`${f}  (frontmatter delimiters not matched on write)`);
      continue;
    }
    if (!dryRun) writeFileSync(abs, next, 'utf8');
    counts.changed++;
    touched++;
  }

  console.log(`${dryRun ? '[dry-run] ' : ''}OKF backfill — agent-insights`);
  console.log(`  corpus DENOMINATOR: ${files.length} file(s)  (+${dotPaths.filter(isInsightDoc).length} dot-path, not part of the Astro collection)`);
  console.log(`  ${dryRun ? 'would change' : 'changed'}: ${counts.changed}`);
  console.log(`  already backfilled (untouched): ${counts.alreadyBackfilled}`);
  console.log(`  type: ${Object.entries(counts.typeByKind).map(([k, n]) => `${k}=${n}`).join('  ') || 'none'}`);
  console.log(`  generated.at omitted (no git add commit, no discovered:): ${counts.noAddDate}`);
  console.log(`  skipped/problem: ${counts.skipped}`);
  for (const p of problems.slice(0, 20)) console.log(`      · ${p}`);
  if (problems.length > 20) console.log(`      … ${problems.length - 20} more`);

  process.exit(counts.skipped > 0 ? 1 : 0);
}

const invokedPath = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '';
if (import.meta.url === invokedPath) main();
