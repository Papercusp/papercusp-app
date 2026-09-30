/**
 * subject-ref — the typed "what code does this doc document?" anchor.
 *
 * Plan: harness-docs-integration-2026-06-05 (P-001 / D-001). A doc's drift is
 * structural, not vibes: every doc carries a `subject_ref` that always reduces
 * to concrete repo paths (+ optional symbol ranges), so "is this doc stale?" is
 * a plain `git log <baseline>..HEAD -- <paths>` query (see drift.ts).
 *
 * Three strategies (D-001):
 *   - `path`    — one or more globs, used verbatim as git pathspecs.
 *   - `symbol`  — `file :: name`, checked precisely with `git log -L :name:file`
 *                 (so an unrelated edit elsewhere in the same file doesn't
 *                 false-flag), with a file-level fallback when `-L` can't run.
 *   - `feature` — `F-NNN` / `WI-NNN`, resolved to the work-item's already-recorded
 *                 implementing commit(s) (completion_ref.commit_sha) → the files
 *                 those commits touched.
 *
 * This module is PURE + types-only-ish: it parses/serialises subject refs and
 * resolves a `feature` ref to its watched paths through an injected lookup. No
 * PG, no direct git spawning here — drift.ts owns the git execution.
 */

/** A git runner compatible with run-git-sync's `RunGit` (never throws). */
export type GitRunner = (
  args: string[],
  cwd: string,
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** The typed union. A doc may carry an array of these (any-match = drift). */
export type SubjectRef =
  | { kind: 'path'; globs: string[] }
  | { kind: 'symbol'; file: string; name: string }
  | { kind: 'feature'; ref: string };

/**
 * Matches a feature/work-item id: F-001, WI-12, EI-18693907749585513
 * (case-insensitive on the prefix).
 *
 * `EI-` is the improvement/issue id family (`improvements:capture` mints them) and is
 * every bit as much a work-item id as `F-`/`WI-` — the three share one id space. It was
 * missing here, so an `EI-` citation fell through to the path branch and got
 * filesystem-checked as if it were a file, reporting a perfectly valid work-item
 * reference as a "stale citation — path does not exist on disk"
 * (EI-18820414923640246: 3 of the 34 offenders on the red lint:insight-citations leg
 * were exactly this, in capability-edit-dollar-substitution-corruption.mdx and
 * swarm-link-severed-restart-the-wedged-side.mdx).
 */
const FEATURE_RE = /^(?:F|WI|EI)-\d+$/i;

/**
 * Parse one subject-ref token from its compact string form:
 *   - `F-001` / `WI-12` / `EI-42` → feature
 *   - `src/foo.ts :: myFn`        → symbol (whitespace around `::` optional)
 *   - `packages/x/**` / `a/b.ts`  → path glob
 *
 * Returns null for empty/blank input.
 */
export function parseSubjectRef(raw: string): SubjectRef | null {
  const s = raw.trim();
  if (!s) return null;

  if (FEATURE_RE.test(s)) {
    return { kind: 'feature', ref: s.toUpperCase() };
  }

  const dc = s.indexOf('::');
  if (dc !== -1) {
    const file = s.slice(0, dc).trim();
    const name = s.slice(dc + 2).trim();
    if (file && name) return { kind: 'symbol', file, name };
    // A `::` with an empty side is malformed — fall through to path so we never
    // silently drop the anchor (a path-kind "src/foo.ts::" still watches the file
    // prefix sensibly enough, but prefer the clean file part).
    if (file) return { kind: 'path', globs: [file] };
    return null;
  }

  return { kind: 'path', globs: [s] };
}

/**
 * Parse a doc's `documents:` frontmatter value into subject refs. Accepts:
 *   - a string                          → one ref
 *   - a string[]                        → many (path globs collapse into one path ref)
 *   - an object[] of {path|symbol|feature|file,name} → explicit structured refs
 * Unknown/blank entries are dropped. Returns [] when nothing parses (unanchored).
 */
export function parseDocumentsField(value: unknown): SubjectRef[] {
  if (value == null) return [];

  if (typeof value === 'string') {
    const r = parseSubjectRef(value);
    return r ? [r] : [];
  }

  if (Array.isArray(value)) {
    const refs: SubjectRef[] = [];
    const looseGlobs: string[] = [];
    for (const entry of value) {
      if (typeof entry === 'string') {
        const r = parseSubjectRef(entry);
        if (!r) continue;
        if (r.kind === 'path') looseGlobs.push(...r.globs);
        else refs.push(r);
      } else if (entry && typeof entry === 'object') {
        const o = entry as Record<string, unknown>;
        if (typeof o.feature === 'string' && FEATURE_RE.test(o.feature.trim())) {
          refs.push({ kind: 'feature', ref: o.feature.trim().toUpperCase() });
        } else if (typeof o.symbol === 'string' || (typeof o.file === 'string' && typeof o.name === 'string')) {
          if (typeof o.file === 'string' && typeof o.name === 'string' && o.file.trim() && o.name.trim()) {
            refs.push({ kind: 'symbol', file: o.file.trim(), name: o.name.trim() });
          } else if (typeof o.symbol === 'string') {
            const r = parseSubjectRef(o.symbol);
            if (r) refs.push(r);
          }
        } else if (typeof o.path === 'string' && o.path.trim()) {
          looseGlobs.push(o.path.trim());
        } else if (Array.isArray(o.paths)) {
          for (const p of o.paths) if (typeof p === 'string' && p.trim()) looseGlobs.push(p.trim());
        }
      }
    }
    // Collapse all loose path globs into a single path ref (one git pathspec set).
    if (looseGlobs.length) refs.unshift({ kind: 'path', globs: looseGlobs });
    return refs;
  }

  if (typeof value === 'object') return parseDocumentsField([value]);
  return [];
}

/**
 * Extract the raw `documents:` value from a markdown body's YAML frontmatter.
 * PURE regex parse (no YAML lib, no fs) — moved here (from manual-anchor.ts,
 * agent-insight-file-citations-on-disk-migr-2026-06-12 WI-1576) so it lives
 * alongside `parseDocumentsField`/`parseSubjectRef` in the one dependency-light
 * module: any caller that only needs "what does this doc's frontmatter cite" —
 * e.g. a CI lint — can import it without dragging in manual-anchor.ts's PG-backed
 * anchoring machinery (`@papercusp/db-org` via feature-commits.ts). Re-exported
 * from `manual-anchor.ts` unchanged for existing callers.
 */
export function frontmatterDocuments(body: string): unknown {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body);
  if (!m) return undefined;
  const fm = m[1];
  // documents: a single scalar, an inline [a, b], or a block list of "- item".
  const line = /^documents:[ \t]*(.*)$/m.exec(fm);
  if (!line) return undefined;
  const rhs = line[1].trim();
  if (rhs && rhs !== '|' && rhs !== '>') {
    if (rhs.startsWith('[')) {
      // inline flow array
      const inner = rhs.replace(/^\[|\]$/g, '');
      return inner.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    }
    return rhs.replace(/^['"]|['"]$/g, '');
  }
  // block list: collect following "  - foo" lines.
  const after = fm.slice((line.index ?? 0) + line[0].length);
  const items: string[] = [];
  for (const l of after.split('\n')) {
    const li = /^\s*-\s+(.*)$/.exec(l);
    if (li) items.push(li[1].trim().replace(/^['"]|['"]$/g, ''));
    else if (l.trim() && !/^\s/.test(l)) break; // next top-level key ends the list
  }
  return items.length ? items : undefined;
}

/** Human/compact display form (round-trips through parseSubjectRef for path/symbol/feature). */
export function stringifySubjectRef(ref: SubjectRef): string {
  switch (ref.kind) {
    case 'path':
      return ref.globs.join(', ');
    case 'symbol':
      return `${ref.file} :: ${ref.name}`;
    case 'feature':
      return ref.ref;
  }
}

/** Serialise a subject-ref array for the `documents:` frontmatter / display. */
export function stringifySubjectRefs(refs: SubjectRef[]): string {
  return refs.map(stringifySubjectRef).join('; ');
}

/**
 * Resolve a feature ref → its implementing commit SHA(s). Injected so the pure
 * module stays PG-free; the operator supplies a lookup over
 * harness_features_consolidated.completion_ref (commit_sha).
 */
export type FeatureCommitLookup = (ref: string) => Promise<string[]>;

/**
 * Resolve a subject ref to the concrete repo paths it watches — the basis for the
 * denormalised `anchor_paths` reverse index (P-003) and for display. For a
 * `feature` ref this runs git to enumerate the files its implementing commits
 * touched; `path`/`symbol` resolve without git.
 *
 * Returns repo-relative path globs/files. Empty array = could not resolve
 * (unanchored / feature with no recorded commit) → caller treats as not-tracked.
 */
export async function resolveAnchorPaths(
  ref: SubjectRef,
  opts: { runGit: GitRunner; repoRoot: string; resolveFeatureCommits?: FeatureCommitLookup },
): Promise<string[]> {
  switch (ref.kind) {
    case 'path':
      return [...ref.globs];
    case 'symbol':
      return [ref.file];
    case 'feature': {
      const commits = (await opts.resolveFeatureCommits?.(ref.ref)) ?? [];
      if (!commits.length) return [];
      const files = new Set<string>();
      for (const sha of commits) {
        // `git show --name-only --format=` lists just the files the commit touched.
        const r = await opts.runGit(['show', '--name-only', '--format=', sha], opts.repoRoot);
        if (r.code !== 0) continue;
        for (const line of r.stdout.split('\n')) {
          const f = line.trim();
          if (f) files.add(f);
        }
      }
      return [...files];
    }
  }
}

/** Union the resolved anchor paths across many refs — the denormalised reverse index. */
export async function resolveAllAnchorPaths(
  refs: SubjectRef[],
  opts: { runGit: GitRunner; repoRoot: string; resolveFeatureCommits?: FeatureCommitLookup },
): Promise<string[]> {
  const out = new Set<string>();
  for (const ref of refs) {
    for (const p of await resolveAnchorPaths(ref, opts)) out.add(p);
  }
  return [...out];
}
