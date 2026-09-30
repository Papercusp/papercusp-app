/**
 * Insight-doc citation detector — verifies a doc's `documents:` frontmatter
 * citations still resolve to a real file on disk (WI-1576, first slice of
 * scout-declared-artifacts-agent-insight-file-citations-on-disk-migr-2026-06-12).
 *
 * A `documents:` entry is the doc's declared "what this documents" anchor
 * (parsed the same way the harness-docs drift/anchor system parses it —
 * `frontmatterDocuments` + `parseDocumentsField`, subject-ref.ts — so a CI lint,
 * this detector, and the DB-backed anchor tracker never disagree on what a doc
 * cites). Unlike that DB-backed system (which tracks drift SINCE a verified git
 * baseline), this is the cheaper, DB-free check: does the cited PATH still
 * EXIST at all — the symptom that shows up when a cited file is renamed/moved/
 * deleted and nobody updated the doc that named it.
 *
 * Only `path`-kind subject refs are checked against the filesystem: a `symbol`
 * ref's file part is checked the same way (existence, not the symbol itself —
 * confirming a renamed *function* moved is a follow-on, out of scope here), and
 * a `feature` ref (`F-NNN`/`WI-NNN`) is skipped (it names a work item, not a
 * path). A glob-bearing path entry (contains `*`/`?`/`[`) is also skipped — it
 * intentionally matches a set, not one file, so "does it resolve" doesn't apply
 * the same way.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { frontmatterDocuments, parseDocumentsField, type SubjectRef } from '../harness/docs/subject-ref';

/** One stale citation: the declared path + how it was declared (raw doc entry). */
export interface StaleCitation {
  /** The repo-relative path that does not resolve on disk. */
  path: string;
  /** The raw subject-ref kind this path came from ('path' | 'symbol'). */
  kind: 'path' | 'symbol';
}

const GLOB_CHARS = /[*?[]/;

/** True for a `F-NNN`/`WI-NNN`-shaped feature ref — never filesystem-checked. */
function isPathLike(ref: SubjectRef): ref is Extract<SubjectRef, { kind: 'path' | 'symbol' }> {
  return ref.kind === 'path' || ref.kind === 'symbol';
}

/**
 * Pure detector: the doc's stale citations, or `[]` when every declared path
 * resolves (including "no `documents:` field at all" — nothing to check).
 * `repoRoot` is the absolute directory citations are resolved relative to
 * (repo-relative paths, exactly as `documents:` declares them).
 */
export function findStaleInsightCitations(body: string, repoRoot: string): StaleCitation[] {
  const raw = frontmatterDocuments(body);
  if (raw == null) return [];
  const refs = parseDocumentsField(raw);
  const stale: StaleCitation[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (!isPathLike(ref)) continue; // feature refs (F-/WI-) name a work item, not a path
    const paths = ref.kind === 'path' ? ref.globs : [ref.file];
    for (const p of paths) {
      const path = p.trim();
      if (!path || GLOB_CHARS.test(path)) continue; // a glob matches a set — not a single-file existence check
      // An ABSOLUTE path is not a repo-relative citation, and this detector's whole
      // contract is repo-relative (see the doc comment above). `join(repoRoot, '/etc/x')`
      // silently yields `<repoRoot>/etc/x`, so such a ref was checked at a path that was
      // never meant to exist and could NEVER pass — a permanent red the fleet learns to
      // ignore. Docs legitimately cite files outside the tree (an installed global CLI, a
      // systemd drop-in); they are simply not ours to verify from here.
      if (path.startsWith('/')) continue;
      if (seen.has(path)) continue;
      seen.add(path);
      if (!existsSync(join(repoRoot, path))) {
        stale.push({ path, kind: ref.kind });
      }
    }
  }
  return stale;
}

/** Render a `StaleCitation[]` as the single human-readable error string the CI lint / guard report. */
export function formatStaleCitations(stale: StaleCitation[]): string | null {
  if (stale.length === 0) return null;
  return `stale documents: citation(s) — path does not exist on disk: ${stale.map((s) => s.path).join(', ')}`;
}
