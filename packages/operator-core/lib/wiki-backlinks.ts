/**
 * Wiki-backlinks scanner — find markdown files in the workspace that
 * reference [[target]] (with or without harness qualifier).
 *
 * Used by both the legacy /api/wiki-backlinks route and the wiki:backlinks
 * MCP tool so they agree on a single implementation.
 *
 * Performance: O(N markdown files × content size). Acceptable for current
 * workspace scale (≤ ~100 .md files). If scale grows, swap for a
 * Postgres-backed backlinks index populated on save.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadHarnessRegistry } from './harness-registry';

const SEARCH_DIRS = ['.papercusp', '', '.claude/skills'] as const;
const MAX_FILE_BYTES = 512 * 1024;

export interface WikiBacklinkHit {
  harness: string;
  filename: string;
  line: number;
  snippet: string;
}

export interface WikiBacklinksResult {
  target: string;
  harness: string | null;
  hits: WikiBacklinkHit[];
}

function listMarkdownFiles(projectPath: string): Array<{ rel: string; abs: string }> {
  const out: Array<{ rel: string; abs: string }> = [];
  for (const dir of SEARCH_DIRS) {
    const baseAbs = dir ? join(projectPath, dir) : projectPath;
    if (!existsSync(baseAbs)) continue;
    try {
      for (const entry of readdirSync(baseAbs, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const abs = join(baseAbs, entry.name);
        try {
          const st = statSync(abs);
          if (st.size > MAX_FILE_BYTES) continue;
        } catch { continue; }
        out.push({ rel: dir ? `${dir}/${entry.name}` : entry.name, abs });
      }
    } catch { /* permission/transient */ }
  }
  return out;
}

function findReferences(
  content: string,
  target: string,
  hintHarness: string | null,
): Array<{ line: number; snippet: string }> {
  const hits: Array<{ line: number; snippet: string }> = [];
  const lines = content.split('\n');
  const re = /\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g;
  for (let i = 0; i < lines.length; i++) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(lines[i])) !== null) {
      const raw = m[1].trim();
      let linkTarget = raw;
      let linkHarness: string | null = null;
      const slash = raw.indexOf('/');
      if (slash > 0) {
        linkHarness = raw.slice(0, slash);
        linkTarget = raw.slice(slash + 1);
      }
      const normalizedTarget = target.replace(/\.md$/, '');
      const normalizedLink = linkTarget.replace(/\.md$/, '');
      if (normalizedLink !== normalizedTarget) continue;
      if (hintHarness && linkHarness && linkHarness !== hintHarness) continue;
      hits.push({ line: i + 1, snippet: lines[i].trim().slice(0, 200) });
    }
  }
  return hits;
}

export async function findWikiBacklinks(
  target: string,
  harness: string | null,
): Promise<WikiBacklinksResult> {
  const reg = await loadHarnessRegistry();
  const projects = reg.projects ?? [];
  const hits: WikiBacklinkHit[] = [];
  for (const p of projects) {
    for (const f of listMarkdownFiles(p.path)) {
      let content: string;
      try { content = readFileSync(f.abs, 'utf8'); } catch { continue; }
      if (!content.includes('[[')) continue;
      const fileHits = findReferences(content, target, harness);
      for (const h of fileHits) {
        hits.push({ harness: p.slug, filename: f.rel, line: h.line, snippet: h.snippet });
      }
    }
  }
  return { target, harness, hits };
}
