/**
 * Anchor extraction for mem0 memories.
 *
 * Plan: papercusp-su-memory-2026-05-25 (Phase 4, P-014/P-015).
 *
 * Given the text body of a memory, extract structural references that can
 * be cheaply validated later by Layer 1 of the audit pipeline (P-019).
 * The categories are deliberately conservative — every false positive
 * costs zero (we just check it and it passes), but every false negative
 * is one less anchor we can validate against.
 *
 * Categories:
 *   - `file`        repo-relative paths like `apps/operator/lib/foo.ts`
 *   - `feature`     feature ids like `F-001`, `F-FIX-024`, `F-AUTH-002`
 *   - `plan`        plan slugs like `memory-harness-scope-2026-05-24`
 *   - `migration`   numbered SQL migrations like `081-memory-canonical.sql`
 *                   or `migration 081`
 *   - `symbol`      code identifiers, ONLY when wrapped in backticks
 *                   (`getHarnessAdminUrl`, `buildMemoryContextBlock`)
 *
 * Output is a small structured array suitable for round-tripping into
 * mem0 metadata. Empty array is the no-op case (most short memories
 * won't have any anchors and that's fine).
 */

export type AnchorKind = 'file' | 'feature' | 'plan' | 'migration' | 'symbol';

export interface Anchor {
  kind: AnchorKind;
  value: string;
}

/**
 * Repo-relative file path. Two segments minimum, ends in a known source
 * extension, no leading slash, no spaces. Avoids matching `package.json`
 * one-word paths (intentional — too noisy alone; users say "in
 * apps/operator/package.json" if they mean it).
 */
const FILE_PATH_RE =
  /\b([a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+){1,8}\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|json|md|mdx|sql|sh|yaml|yml|toml|rs|go|py|astro|css|html))\b/g;

/**
 * Feature id. `F-NNN` form, optionally prefixed by a subsystem tag:
 *   F-001, F-AUTH-001, F-FIX-024, F-AUTO-15
 * The body is uppercase letters/digits/dashes; 3+ chars total after `F-`.
 */
const FEATURE_ID_RE = /\bF-[A-Z0-9][A-Z0-9-]{1,40}\b/g;

/**
 * Plan slug. `<topic>-YYYY-MM-DD` where topic is kebab-case. We pin on
 * the dated suffix to avoid matching arbitrary kebab-case identifiers.
 */
const PLAN_SLUG_RE =
  /\b([a-z0-9][a-z0-9-]*-\d{4}-\d{2}-\d{2})\b/g;

/**
 * Migration reference. Two shapes:
 *   1. `081-memory-canonical.sql` — file form
 *   2. `migration 081` / `migration #081` — prose form
 * Either way we yield the 3-digit number as the canonical value.
 */
const MIGRATION_FILE_RE = /\b(\d{3})-[a-z0-9-]+\.sql\b/g;
const MIGRATION_PROSE_RE = /\bmigration[s]?\s+#?(\d{3,4})\b/gi;

/**
 * Symbol identifier — only inside backticks. Camel/Pascal case OR
 * snake_case, 3+ chars, must contain at least one letter. Backticks
 * are the disambiguator; bare prose mentions are too ambiguous.
 */
const BACKTICK_SYMBOL_RE =
  /`([A-Za-z_][A-Za-z0-9_]{2,60})`/g;

/** Words that look like symbols but are common English. Filtered out. */
const SYMBOL_STOPLIST = new Set([
  'true',
  'false',
  'null',
  'undefined',
  'this',
  'that',
  'todo',
  'wip',
  'done',
  'now',
  'next',
  'yes',
  'no',
  'main',
  'master',
  'origin',
  'head',
  'fix',
  'feat',
  'chore',
  'refactor',
  'test',
  'docs',
  'note',
  'tldr',
  'tl_dr',
  'fyi',
  'imo',
  'idk',
]);

function dedupeAnchors(anchors: Anchor[]): Anchor[] {
  const seen = new Set<string>();
  const out: Anchor[] = [];
  for (const a of anchors) {
    const key = `${a.kind}:${a.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

function collectMatches(re: RegExp, text: string, groupIdx = 1): string[] {
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    const v = m[groupIdx];
    if (v) matches.push(v);
  }
  return matches;
}

/**
 * Extract all anchor references from a memory body.
 *
 * Pure function: no I/O, no validation against the actual filesystem
 * or PG. That's Layer 1's job (P-019). This is just structural
 * extraction — what to check, not whether it passes.
 *
 * Returns a deduplicated list (same anchor mentioned twice in the body
 * collapses to one entry).
 */
export function extractAnchors(text: string): Anchor[] {
  if (!text || typeof text !== 'string') return [];

  const anchors: Anchor[] = [];

  for (const file of collectMatches(FILE_PATH_RE, text)) {
    anchors.push({ kind: 'file', value: file });
  }

  for (const feature of collectMatches(FEATURE_ID_RE, text, 0)) {
    anchors.push({ kind: 'feature', value: feature });
  }

  for (const plan of collectMatches(PLAN_SLUG_RE, text)) {
    anchors.push({ kind: 'plan', value: plan });
  }

  for (const mig of collectMatches(MIGRATION_FILE_RE, text)) {
    anchors.push({ kind: 'migration', value: mig });
  }

  for (const mig of collectMatches(MIGRATION_PROSE_RE, text)) {
    anchors.push({ kind: 'migration', value: mig });
  }

  for (const sym of collectMatches(BACKTICK_SYMBOL_RE, text)) {
    const lower = sym.toLowerCase();
    if (SYMBOL_STOPLIST.has(lower)) continue;
    if (/^\d+$/.test(sym)) continue;
    anchors.push({ kind: 'symbol', value: sym });
  }

  return dedupeAnchors(anchors);
}

/**
 * Convenience: produce the metadata-ready shape mem0 stores. Returns
 * `null` when there are no anchors so callers can `if (anchors)` cheaply.
 */
export function anchorMetadata(
  text: string,
): { anchors: Anchor[]; anchor_count: number } | null {
  const anchors = extractAnchors(text);
  if (anchors.length === 0) return null;
  return { anchors, anchor_count: anchors.length };
}
