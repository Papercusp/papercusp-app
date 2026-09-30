/**
 * Agent-insights index — compact title + description list for the
 * session-start prelude.
 *
 * Plan: papercusp-su-memory-2026-05-25 (Phase 3, P-011 + P-012).
 *
 * Why not just use the Starlight-emitted `llms-small.txt`?
 * The Starlight `llms-small.txt` output for the agent-insights section
 * includes the full body of every insight (~50 lines × 35 insights),
 * blowing out the prelude token budget. For the prelude we only want
 * slug + title + 1-line description so the agent knows the surface
 * area; the full body is one `docs:get` call away when needed.
 *
 * This module reads the .mdx files in
 * `apps/operator-docs/src/content/docs/agent-insights/`, parses the
 * YAML frontmatter, filters out `status: retired|superseded`, and
 * emits a markdown list ready to splice into a system prompt.
 *
 * Pure-IO module: only `fs.promises` + a small frontmatter parser.
 * No fumadocs, no starlight runtime dep.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isRetiredDocStatus, normalizeDocStatus } from '@papercusp/docs-engine';

export interface InsightEntry {
  slug: string;
  title: string;
  description: string;
  status: string;
  tags: string[];
}

/**
 * Keep the initialize-time catalog useful without allowing the number of
 * published insights to consume an unbounded share of every session prompt.
 * This is a byte cap because the prompt transport and token budget are both
 * affected by UTF-8 payload size, not just JavaScript code-unit count.
 */
const MAX_INSIGHTS_PRELUDE_BYTES = 32 * 1024;

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Strip one layer of matching surrounding quotes from a scalar. */
function unquote(s: string): string {
  return (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
    ? s.slice(1, -1)
    : s;
}

/**
 * Minimal YAML frontmatter parser — handles the shapes the
 * agent-insights files actually use: top-level string scalars, an
 * INLINE array (`tags: [a, b]`), and a BLOCK list (`documents:` followed
 * by `  - item` lines). Not a general YAML parser; explicitly
 * single-purpose so this module has zero deps.
 *
 * Block-list support matters because it is the corpus's DOMINANT list
 * style — a 2026-07-27 sweep found 572/625 docs writing `documents:` and
 * 248 writing `plans:` that way (vs `tags:`, which is always inline). A
 * key parsed without it yields `''`, i.e. silently "absent", which would
 * make any lint keyed on a list field (see content-lint/insight-normative.ts)
 * false-positive on the majority authoring style.
 */
export function parseFrontmatter(
  raw: string,
): Record<string, string | string[]> | null {
  // Frontmatter block is `---\n...\n---\n` at the very start
  if (!raw.startsWith('---\n')) return null;
  const end = raw.indexOf('\n---', 4);
  if (end < 0) return null;
  const block = raw.slice(4, end);

  const out: Record<string, string | string[]> = {};
  const lines = block.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (/^\s/.test(line)) continue; // nested / list item — consumed by its owning key below
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const value = unquote(line.slice(colon + 1).trim());
    if (!key) continue;

    if (value === '') {
      // Block list: collect the following `- item` lines (indented or not).
      const items: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const item = /^\s*-\s+(.*)$/.exec(lines[j]);
        if (item) {
          items.push(unquote(item[1].trim()));
          continue;
        }
        if (!lines[j].trim()) continue; // blank line inside the list
        break; // next top-level key ends the list
      }
      out[key] = items.length ? items : value;
      continue;
    }

    // Inline array: [a, b, c]
    if (value.startsWith('[') && value.endsWith(']')) {
      out[key] = value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map(unquote);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Hidden from the curated index exactly when the read surfaces banner it as
 * retired — ONE definition, imported, not a second copy of the same two strings.
 *
 * These used to be independent: this predicate hid `superseded` docs from the
 * launch-context index while `docs:search`/`docs:get` returned the same doc as an
 * ordinary hit with no label at all, so which agents saw the retirement depended
 * on which surface they happened to use (EI-20057596071021992).
 */
function isVisible(status: string): boolean {
  return !isRetiredDocStatus(status);
}

/**
 * Read one .mdx file and produce its InsightEntry (or null when the
 * file lacks valid frontmatter / is the section index page).
 */
export async function readInsight(
  filePath: string,
): Promise<InsightEntry | null> {
  const slug = path.basename(filePath, '.mdx');
  if (slug === 'index') return null; // section landing page, not an insight

  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }

  const fm = parseFrontmatter(raw);
  if (!fm) return null;

  const title = typeof fm.title === 'string' ? fm.title : '';
  const description = typeof fm.description === 'string' ? fm.description : '';
  const status = normalizeDocStatus(typeof fm.status === 'string' ? fm.status : undefined) ?? 'active';
  const tags = Array.isArray(fm.tags) ? fm.tags : [];

  if (!title) return null;

  return { slug, title, description, status, tags };
}

/**
 * Read the entire insights directory. Filters out retired/superseded.
 */
export async function readInsightsDir(
  dir: string,
): Promise<InsightEntry[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  const out: InsightEntry[] = [];
  for (const name of entries) {
    if (!name.endsWith('.mdx')) continue;
    const entry = await readInsight(path.join(dir, name));
    if (!entry) continue;
    if (!isVisible(entry.status)) continue;
    out.push(entry);
  }
  // Stable order: alpha by slug, so the index doesn't churn run-to-run
  out.sort((a, b) => a.slug.localeCompare(b.slug));
  return out;
}

/**
 * Render the prelude block. Format:
 *
 *   ## Agent insights
 *
 *   Project-specific runbook entries. Drill in with
 *   `docs:get { slugs: ['<slug>'] }` if any look relevant.
 *
 *   - <slug> — <description first sentence>
 *   - …
 *
 * Returns `null` when there are no visible insights — caller can
 * conditionally skip the section.
 */
export function renderInsightsPrelude(entries: InsightEntry[]): string | null {
  if (entries.length === 0) return null;

  const entryLines = entries.map((e) => {
    const oneLine = firstSentence(e.description) || e.title;
    return `- ${e.slug} — ${oneLine}`;
  });

  const header = [
    '## Agent insights',
    '',
    "Project-specific runbook entries. Drill in with `docs:get { slugs: ['<slug>'] }` if any look relevant.",
    '',
  ];

  const included: string[] = [];
  let omitted = 0;
  for (let i = 0; i < entryLines.length; i++) {
    const candidate = [...header, ...included, entryLines[i]].join('\n');
    if (utf8Bytes(candidate) > MAX_INSIGHTS_PRELUDE_BYTES) {
      omitted = entryLines.length - i;
      break;
    }
    included.push(entryLines[i]);
  }

  if (omitted === 0) return [...header, ...included].join('\n');

  const buildNotice = (count: number): string => {
    const noun = count === 1 ? 'insight' : 'insights';
    return (
      `- … ${count} additional ${noun} omitted from this compact index; use ` +
      '`docs:search { query: "<topic>" }` then `docs:get` (or `docs:outline`) ' +
      'to discover the full catalog.'
    );
  };

  // The header + notice are deliberately much smaller than the cap. Keep the
  // marker even when the entry that crossed the boundary was unusually large;
  // if a future header change consumes the budget, drop the oldest entries
  // until the marker still fits rather than returning an over-cap prompt.
  let notice = buildNotice(entryLines.length - included.length);
  while (utf8Bytes([...header, ...included, notice].join('\n')) > MAX_INSIGHTS_PRELUDE_BYTES) {
    if (included.length === 0) break;
    included.pop();
    notice = buildNotice(entryLines.length - included.length);
  }

  return [...header, ...included, notice].join('\n');
}

function firstSentence(text: string): string {
  const s = text.trim();
  if (!s) return '';
  // Match first . / ! / ? followed by whitespace or end-of-string
  const m = s.match(/^(.+?[.!?])(\s|$)/);
  return m ? m[1] : s;
}
