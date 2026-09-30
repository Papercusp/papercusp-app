/**
 * Pure scope resolver for sub-harness UNION + SWITCH operations.
 *
 * Per `plans-newbutton-and-subharness-scope-2026-05-25` P-013 / D-004:
 * the canonical parent→child tree lives on disk as
 * `.papercusp/config.json:parent_slug` per project. We do NOT denormalize
 * a `descendants` column anywhere; consumers call this helper with the
 * current registry snapshot (the `/api/harness/projects` payload) to
 * walk the tree on demand.
 *
 * Cycle-safe: visited set prevents revisiting a slug if a malformed
 * registry produces a back-edge. Depth-capped at 4 by default to match
 * `classify-tree`'s walk limit.
 */

/**
 * The harness scope axis for the /adv shell. Orthogonal to `?slug=`
 * (WHICH harness is active); `?scope=` decides HOW WIDE list views read:
 *   - `expanded` (default): UNION the active slug + its sub-harnesses.
 *   - `self`: just the active slug.
 *   - `all`: every harness in the workspace. The active `?slug=` is
 *     ignored by list views (Plans, Sessions); single-harness editor
 *     views show a per-harness empty state. This backs the harness
 *     selector's "All harnesses" option.
 *
 * Single source of truth so every `?scope=` consumer (AdvShell writer,
 * Plans + Sessions readers) parses the SAME enum. Adding a value here
 * can't silently coerce-to-default in a consumer that forgot to list it.
 */
export const HARNESS_SCOPE_MODES = ['expanded', 'self', 'all'] as const;
export type HarnessScopeMode = (typeof HARNESS_SCOPE_MODES)[number];

export interface HarnessNodeForScope {
  slug: string;
  parent_slug?: string | null;
}

export interface ResolveHarnessScopeOpts {
  /** Walk depth from the root, default 4. */
  maxDepth?: number;
}

/**
 * Return `[slug, ...descendants where parent_slug → slug transitively]`.
 * Returns just `[slug]` when the slug isn't in `allProjects` (the
 * lookup is for descendants; the input slug is always included).
 */
export function resolveHarnessScope(
  slug: string,
  allProjects: HarnessNodeForScope[],
  opts: ResolveHarnessScopeOpts = {},
): string[] {
  if (!slug) return [];
  const maxDepth = Math.max(1, Math.min(opts.maxDepth ?? 4, 10));

  // Build a parent_slug → children[] index once.
  const childrenByParent = new Map<string, string[]>();
  for (const p of allProjects) {
    const parent = p.parent_slug?.trim() || null;
    if (!parent) continue;
    let bucket = childrenByParent.get(parent);
    if (!bucket) {
      bucket = [];
      childrenByParent.set(parent, bucket);
    }
    bucket.push(p.slug);
  }

  const out: string[] = [slug];
  const visited = new Set<string>([slug]);
  let frontier: string[] = [slug];
  for (let depth = 1; depth <= maxDepth; depth++) {
    const next: string[] = [];
    for (const parent of frontier) {
      const kids = childrenByParent.get(parent);
      if (!kids) continue;
      for (const k of kids) {
        if (visited.has(k)) continue;
        visited.add(k);
        out.push(k);
        next.push(k);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }

  return out;
}

/**
 * True iff the given slug has at least one direct child in
 * `allProjects`. Cheap predicate for "show a sub-strip" decisions in
 * SWITCH-policy tabs.
 */
export function harnessHasSubs(slug: string, allProjects: HarnessNodeForScope[]): boolean {
  if (!slug) return false;
  return allProjects.some((p) => (p.parent_slug?.trim() || null) === slug);
}
