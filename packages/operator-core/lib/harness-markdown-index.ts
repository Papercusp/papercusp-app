/**
 * Builds a compact index of markdown files + heading anchors across the
 * workspace's registered harnesses. Used by `buildOperatorPrompt` so the
 * LLM emits real anchor IDs that match Vditor's renderer instead of
 * hallucinating patterns like `#4-1` that 404 in practice.
 *
 * Vditor anchor rule (verified against rendered DOM):
 *   each non-[A-Za-z0-9] char → '-', preserved 1:1 (no collapse).
 *
 *   "Spec: Spreadsheet Clone — Phase 1 (Local MVP)"
 *   → "Spec--Spreadsheet-Clone---Phase-1--Local-MVP-"
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadHarnessRegistry } from './harness-registry';

import { SCANNED_FILES_FOR_INDEX as SCANNED_FILES } from './harness-state-files';
const MAX_FILE_BYTES = 256 * 1024;
const MAX_HEADINGS_PER_FILE = 60;

export interface HarnessHeading {
  level: number;          // 1..6
  text: string;           // raw heading text without `#`
  anchor: string;         // Vditor-style id; preserves duplicates as-is — Vditor appends _<n> in IR mode but the static preview uses bare ids
}

export interface HarnessMarkdownFile {
  filename: string;       // relative to project root
  headings: HarnessHeading[];
}

export interface HarnessMarkdownEntry {
  slug: string;
  files: HarnessMarkdownFile[];
}

export function slugifyVditorAnchor(text: string): string {
  return text.replace(/[^A-Za-z0-9]/g, '-');
}

function extractHeadings(content: string): HarnessHeading[] {
  const out: HarnessHeading[] = [];
  for (const line of content.split('\n')) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const text = m[2].trim();
    if (!text) continue;
    out.push({ level: m[1].length, text, anchor: slugifyVditorAnchor(text) });
    if (out.length >= MAX_HEADINGS_PER_FILE) break;
  }
  return out;
}

export async function loadHarnessMarkdownIndex(): Promise<HarnessMarkdownEntry[]> {
  const reg = await loadHarnessRegistry();
  const out: HarnessMarkdownEntry[] = [];
  for (const project of reg.projects ?? []) {
    const files: HarnessMarkdownFile[] = [];
    for (const rel of SCANNED_FILES) {
      const abs = join(project.path, rel);
      if (!existsSync(abs)) continue;
      try {
        const st = statSync(abs);
        if (st.size > MAX_FILE_BYTES) continue;
        const content = readFileSync(abs, 'utf8');
        const headings = extractHeadings(content);
        if (headings.length === 0) continue;
        files.push({ filename: rel, headings });
      } catch { /* permission/transient */ }
    }
    if (files.length > 0) out.push({ slug: project.slug, files });
  }
  return out;
}

/**
 * Render the index as a compact prompt section. One harness per stanza,
 * one file per heading group, anchor ids inline so the LLM can copy them
 * verbatim into `target_resource` URLs without having to derive them.
 */
export function renderHarnessMarkdownIndexForPrompt(index: HarnessMarkdownEntry[]): string {
  if (index.length === 0) return '';
  const lines: string[] = ['## Harness markdown index (use these anchor ids verbatim)'];
  for (const entry of index) {
    lines.push('');
    lines.push(`### ${entry.slug}`);
    for (const f of entry.files) {
      lines.push('');
      lines.push(`**${f.filename}**`);
      for (const h of f.headings) {
        const indent = '  '.repeat(Math.max(0, h.level - 1));
        lines.push(`${indent}- ${h.text} → \`#${h.anchor}\``);
      }
    }
  }
  return lines.join('\n');
}
