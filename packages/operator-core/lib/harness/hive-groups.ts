/**
 * Server-side Hive grouping for the registry API
 * (harnesses-tab-hive-model-2026-06-07 Phase 3 / P-021).
 *
 * Groups workspace harnesses into a Hive → members structure so the client
 * (`buildHarnessSelectOptions`, the member rail, the all-mode cards) stops
 * tree-inferring the grouping itself. This is the "registry exposes the
 * grouping natively" step: the same shape the app's `groupByHive` computed
 * client-side, now produced once on the server and consumed by every surface.
 *
 * MEMBERSHIP PRECEDENCE — the seam D-002 + D-008 anticipated ("swap the
 * grouping source without layout change"; "the Phase-3 hive entity is
 * shared-hive-federation's keypair'd PROJECT Hive, registry face =
 * `harness_kind:'hive'` root + declared membership"):
 *
 *   1. FORMAL (Phase 3, shared-hive-federation D-004/D-010): a
 *      `harness_kind:'hive'` home owns the members whose `hive_slug` equals the
 *      home slug. `hive_slug` is a registry `ProjectEntry` field — it does NOT
 *      depend on the (not-yet-live) `harness_shared.pots` table, so this works
 *      on the live DB today and upgrades cleanly when that entity is wired.
 *   2. LEGACY (Phase 1, D-002): the `parent_slug` sub-harness tree — a root
 *      harness plus the subtree hanging off it (`.papercusp/config.json`).
 *
 * Formal `hive_slug` wins; `parent_slug` fills the gap for harnesses that
 * predate the Hive entity. A `harness_kind:'hive'` home is always its own root.
 *
 * Pure (no PG / fs / React) so the precedence is unit-tested standalone and the
 * module is importable by BOTH the route (operator-core) and the app
 * (`apps/operator/app/adv/harnesses/harness-pot-groups.ts` re-exports it).
 */

/** The `harness_kind` value that marks a project as a Hive home. */
export const HIVE_KIND = 'hive';

/**
 * A repo-LESS Hive home: a `harness_kind:'hive'` coordination home whose repo
 * lives in a SEPARATE member harness (created via pot:create / pot:create_from_repo).
 * These are backend coordination homes, NOT work targets — hide them from harness /
 * work-target selectors (the psu picker, the GUI harness selector). A SELF-hive
 * (`self_repo`, e.g. the papercusp dogfood repo) IS its own checkout and stays
 * selectable. Mirrors the git-sync `hive_home` eligibility discriminator so "what is a
 * real, selectable harness" has ONE definition.
 */
export function isRepoLessHiveHome(
  p: Pick<HiveGroupProject, 'harness_kind' | 'self_repo'>,
): boolean {
  return p.harness_kind === HIVE_KIND && !p.self_repo;
}

/**
 * The structural subset of a registry/lite entry this module groups over — the
 * two membership edges + the card-facing metadata. A superset of what the
 * client passes is fine (extra fields are carried through untouched on `root`
 * and `members`).
 */
export interface HiveGroupProject {
  slug: string;
  /** Formal Hive membership (shared-hive-federation): the home Hive's slug. */
  hive_slug?: string | null;
  /** Legacy sub-harness edge (Phase 1): the parent harness slug. */
  parent_slug?: string | null;
  /** `'hive'` ⇒ this project is a Hive home (its own root). */
  harness_kind?: string | null;
  /**
   * A `harness_kind:'hive'` home that IS its own repo checkout (self-hive, e.g. the
   * papercusp dogfood repo). Such homes stay selectable; a repo-LESS home does not.
   */
  self_repo?: boolean | null;
  is_shared?: boolean;
  /** Whether the harness has state — the rail/cards' zero-new-poller liveness hint. */
  hasState?: boolean;
}

export interface HiveGroup<T extends HiveGroupProject = HiveGroupProject> {
  /** The hive root entry — a real registry harness (or the bucket's first member if the root row is missing). */
  root: T;
  /** Root first, then the remaining members sorted by slug. */
  members: T[];
}

/**
 * Resolve the hive-root slug for `slug`, applying the membership precedence:
 * formal `hive_slug` first (one hop — a member points straight at its home),
 * then the legacy `parent_slug` chain walked to the top-most registered
 * ancestor. A `harness_kind:'hive'` home is its own root and never delegates
 * upward even if a stray edge is present. Cycle-safe; an orphan edge (points at
 * a slug not in the registry) resolves to the current node (mirrors
 * `buildHarnessSelectOptions`' orphans-render-as-roots).
 */
export function hiveRootOf<T extends HiveGroupProject>(
  slug: string,
  bySlug: ReadonlyMap<string, T>,
): string {
  if (!slug) return '';
  let cur = slug;
  const seen = new Set<string>([cur]);
  for (;;) {
    const node = bySlug.get(cur);
    // A Hive home is always its own root (formal Phase-3 root).
    if (node?.harness_kind === HIVE_KIND) return cur;
    // FORMAL membership wins: a member points directly at its Hive home.
    const formal = node?.hive_slug?.trim() || null;
    // LEGACY fallback: the parent_slug sub-harness edge.
    const parent = formal ?? (node?.parent_slug?.trim() || null);
    if (!parent) return cur; // a real root (or an unknown slug → itself)
    if (!bySlug.has(parent)) return cur; // orphan edge → cur is the effective root
    if (seen.has(parent)) return cur; // cycle guard
    seen.add(parent);
    cur = parent;
  }
}

/**
 * Group every project under its hive root. Every project lands under exactly
 * one root; a deep legacy tree collapses to its top root so a grandchild still
 * groups with its hive. Roots are sorted by slug; members are root-first then
 * slug-sorted. Generic over the entry type so callers keep their extra fields.
 */
export function groupByHive<T extends HiveGroupProject>(projects: readonly T[]): HiveGroup<T>[] {
  const bySlug = new Map<string, T>();
  for (const p of projects) bySlug.set(p.slug, p);

  const byRoot = new Map<string, T[]>();
  for (const p of projects) {
    const root = hiveRootOf(p.slug, bySlug);
    let bucket = byRoot.get(root);
    if (!bucket) {
      bucket = [];
      byRoot.set(root, bucket);
    }
    bucket.push(p);
  }

  const groups: HiveGroup<T>[] = [];
  for (const [rootSlug, members] of byRoot) {
    const rootEntry = bySlug.get(rootSlug) ?? members[0];
    const sorted = [...members].sort((a, b) => {
      if (a.slug === rootSlug) return -1;
      if (b.slug === rootSlug) return 1;
      return a.slug.localeCompare(b.slug);
    });
    groups.push({ root: rootEntry, members: sorted });
  }
  groups.sort((a, b) => a.root.slug.localeCompare(b.root.slug));
  return groups;
}
