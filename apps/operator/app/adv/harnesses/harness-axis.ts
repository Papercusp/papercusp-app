/**
 * Harnesses-tab member axis — the pure logic behind the `?harness=` param
 * (harnesses-tab-hive-model-2026-06-07 Phase 1, P-001).
 *
 * The /adv shell selector owns `?slug=` — the HIVE / root scope. The
 * Harnesses tab adds an orthogonal `?harness=` axis: which MEMBER harness of
 * that hive is focused in the dock. A single param can't express "hive X,
 * member Y", which is why the tab had no place to select among a hive's
 * members (the plan's root cause).
 *
 * Phase 1 infers the hive grouping from `parent_slug` only — no schema work
 * (D-002). Phase 3 (D-004) swaps the source for a registry-native grouping
 * without changing these signatures; keep this module the single seam so the
 * member rail (P-002), the dock keying (P-001), and the unit tests (P-005)
 * all agree.
 *
 * Pure + standalone (no React) so the precedence is unit-tested without
 * mounting the tab — mirrors the sibling `adv-harness-selection.ts` seam.
 */

/** The slice of a projects/lite entry the member axis needs. */
export interface HarnessProjectLite {
  slug: string;
  parent_slug?: string | null;
  /** Formal hive membership (shared-hive-federation): the home hive's slug. */
  hive_slug?: string | null;
  harness_kind?: string | null;
  is_shared?: boolean;
}

/** One member of a hive, as the rail + dock keying consume it. */
export interface HiveMember {
  slug: string;
  harness_kind: string | null;
  is_shared: boolean;
  /** True for the hive's root harness (the `?slug=` scope itself). */
  isRoot: boolean;
}

/** Normalize a possibly-blank parent_slug to a real slug or null. */
function parentOf(p: HarnessProjectLite): string | null {
  return p.parent_slug?.trim() || null;
}

/** The hive this project formally belongs to (shared-hive-federation), or null.
 *  Formal `hive_slug` wins over the legacy `parent_slug` edge (mirrors the
 *  server-side groupByHive precedence). */
function hiveOf(p: HarnessProjectLite): string | null {
  return p.hive_slug?.trim() || parentOf(p);
}

function toMember(p: HarnessProjectLite, isRoot: boolean): HiveMember {
  return {
    slug: p.slug,
    harness_kind: p.harness_kind ?? null,
    is_shared: !!p.is_shared,
    isRoot,
  };
}

/**
 * The members of the hive rooted at `potSlug`. Membership precedence mirrors
 * the server `groupByHive`: a child belongs to the hive when its formal
 * `hive_slug` (shared-hive-federation) OR its legacy `parent_slug` equals
 * `potSlug`. Order: the root harness itself FIRST (only when it is a real
 * harness — a FORMAL `harness_kind:'hive'` home is the group, not a member, so
 * it is skipped), then the children sorted by slug.
 *
 * A solo harness (no children) yields a single-member list `[root]` — the
 * rail renders collapsed and the dock is unchanged (zero regression).
 *
 * Returns `[]` when there is no hive selected.
 */
export function hiveMembers(
  projects: readonly HarnessProjectLite[],
  potSlug: string | null,
): HiveMember[] {
  if (!potSlug) return [];
  const members: HiveMember[] = [];
  const seen = new Set<string>();

  const root = projects.find((p) => p.slug === potSlug);
  // A FORMAL hive home (`harness_kind:'hive'`) is the GROUP itself, not a
  // selectable member — list only its real member harnesses under it (so the
  // dock/rail focus a real harness, not the empty hive entity). A LEGACY root (a
  // real harness that is its own hive) stays a member: it has its own content.
  if (root && root.harness_kind !== 'hive') {
    members.push(toMember(root, true));
    seen.add(root.slug);
  }

  const children = projects
    .filter((p) => p.slug !== potSlug && hiveOf(p) === potSlug)
    .sort((a, b) => a.slug.localeCompare(b.slug));
  for (const child of children) {
    if (seen.has(child.slug)) continue;
    seen.add(child.slug);
    members.push(toMember(child, false));
  }

  return members;
}

/**
 * Resolve which member dock is focused, given the URL `?harness=` value.
 *
 * Precedence (D-001):
 *   1. An explicit, valid `?harness=` that names a current member wins —
 *      a deep link / refresh restores exactly (`?slug=X&harness=Y`).
 *   2. Else the hive root, if it is a real harness.
 *   3. Else the first member.
 *   4. Else `null` — nothing to show (no hive / empty registry).
 *
 * Because `hiveMembers` lists the root first, (2) and (3) collapse to
 * "members[0]"; the explicit checks keep the precedence legible if the
 * ordering ever changes.
 */
export function resolveFocusedMember(opts: {
  members: readonly HiveMember[];
  urlHarness: string | null;
}): string | null {
  const { members, urlHarness } = opts;
  if (members.length === 0) return null;
  if (urlHarness && members.some((m) => m.slug === urlHarness)) return urlHarness;
  const root = members.find((m) => m.isRoot);
  if (root) return root.slug;
  return members[0]?.slug ?? null;
}

/**
 * Which harness the Harnesses dock + work-items panel actually target for the
 * current selection — distinct from resolveFocusedMember because it must also
 * honor the SELECTED hive's OWN content.
 *
 * A FORMAL hive home (`harness_kind:'hive'`) is excluded from its own member
 * list by hiveMembers (it is the group, not a member). But such a home can
 * still OWN work items (e.g. `papercusp` owns ~317). Without this, selecting a
 * hive home with no explicit `?harness=` falls through resolveFocusedMember to
 * members[0] — its first child (e.g. `hive-canary`) — so the work-items panel
 * queries the WRONG harness ("papercusp parent still shows hive-canary items").
 *
 * Precedence:
 *   1. An explicit `?harness=` that names a CURRENT member (deep-link / drill-in).
 *   2. The selected `slug` itself when it is a registered project — a hive home
 *      or harness shows ITS OWN content (the fix for the parent-select case).
 *   3. The resolved focused member (a ghost/unregistered root → its first child).
 *   4. The raw `slug` (projects/lite still loading: members empty) so the common
 *      solo case mounts instantly with no flash.
 */
export function resolveDockSlug(opts: {
  slug: string | null;
  urlHarness: string | null;
  members: readonly HiveMember[];
  projects: readonly HarnessProjectLite[];
  focusedMember: string | null;
}): string | null {
  const { slug, urlHarness, members, projects, focusedMember } = opts;
  if (urlHarness && members.some((m) => m.slug === urlHarness)) return urlHarness;
  if (slug && projects.some((proj) => proj.slug === slug)) return slug;
  return focusedMember ?? (slug || null);
}

/**
 * Whether a URL `?harness=` value is stale for the current hive — set but
 * not a member (e.g. the shell selector just switched `?slug=` to a
 * different hive). The tab drops it so the dock falls back to the new
 * hive's default member. Guarded on `members.length > 0` by the caller so a
 * valid deep-link value isn't cleared before projects/lite has loaded.
 */
export function isHarnessParamStale(
  members: readonly HiveMember[],
  urlHarness: string | null,
): boolean {
  if (!urlHarness) return false;
  if (members.length === 0) return false;
  return !members.some((m) => m.slug === urlHarness);
}
