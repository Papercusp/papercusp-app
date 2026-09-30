/**
 * hive-scope — the `hive:<slug>` memory pool (learning-packs-2026-06-11 P-004,
 * D-008/OQ-1: a payload-level scope value, no schema migration).
 *
 * A Hive's shared knowledge — seeded knowledge packs (D-001) + organically
 * recorded conventions (D-002's binding step) — lives in mem0 rows whose scope
 * is `hive:<home-slug>`. Every agent working anywhere in the Hive should
 * recall it, so injection resolves the harness slugs it was given to their
 * owning Hives:
 *
 *   member harness   → its registry `hive_slug` (shared-hive-federation P-004)
 *   hive home        → its own slug (`harness_kind: 'hive'`, incl. remote_hive
 *                      joiner views — recalling an empty pool is harmless)
 *   plain standalone → no hive pool (D-008/OQ-4: hives only in v1)
 *
 * The pure resolution is split from the registry IO so injection tests pin it
 * without PG (same posture as the rest of lib/memory).
 */

import { loadHarnessRegistry } from '../harness-registry';

export const HIVE_SCOPE_PREFIX = 'hive:';

export function hiveScopeKey(potSlug: string): string {
  return `${HIVE_SCOPE_PREFIX}${potSlug}`;
}

/** `hive:<slug>` → `<slug>`, or null when the scope isn't hive-shaped. */
export function potSlugFromScope(scope: string): string | null {
  return scope.startsWith(HIVE_SCOPE_PREFIX) ? scope.slice(HIVE_SCOPE_PREFIX.length) : null;
}

export interface RegistryEntryLite {
  slug: string;
  harness_kind?: string;
  hive_slug?: string;
}

/** Pure member→hive resolution over registry entries. De-duped, input order. */
export function potSlugsForHarnesses(
  entries: readonly RegistryEntryLite[],
  harnessSlugs: readonly string[],
): string[] {
  const bySlug = new Map(entries.map((e) => [e.slug, e]));
  const out: string[] = [];
  for (const slug of harnessSlugs) {
    const entry = bySlug.get(slug);
    if (!entry) continue;
    const hive = entry.harness_kind === 'hive' ? entry.slug : entry.hive_slug;
    if (hive && !out.includes(hive)) out.push(hive);
  }
  return out;
}

/**
 * Registry-backed resolution. One operator-state read per call — callers on
 * hot paths (pre-turn injection) treat it as best-effort and catch failures.
 */
export async function resolvePotSlugsForHarnesses(
  workspaceId: string | undefined,
  harnessSlugs: readonly string[],
): Promise<string[]> {
  if (harnessSlugs.length === 0) return [];
  const reg = await loadHarnessRegistry(workspaceId);
  return potSlugsForHarnesses(reg.projects, harnessSlugs);
}

/**
 * P-018 (scoped-superuser-workspace-clamp-2026-06-18 / D-009 P-016b): confine a
 * DEFAULT memory fan-out to the SESSION's hive subtree.
 *
 * `memory:search`/`memory:list` with no explicit `harness_slug` fan out over the
 * user pool + EVERY workspace harness pool. In a MULTI-hive workspace that bleeds
 * a hive-confined session's recall across SIBLING hives' harness pools (e.g. a
 * papercusp-hive bee/su recalling oddsmith-hive lessons) — the leak this closes.
 * Within a hive, member harness pools stay shared (knowledge-packs seed each
 * member, they aren't cross-recalled), so narrowing to the subtree drops only the
 * cross-hive bleed, never intra-hive sharing.
 *
 * Given the registry entries + the candidate fan-out + the session's PINNED
 * harness (`ctx.harnessSlug`), keep only candidates in the SAME hive. Returns the
 * candidates UNCHANGED when the session has no concrete hive — `sessionHarness`
 * is `'*'`/empty (a workspace-spanning or unscoped session, e.g. the
 * workspace-scoped Queen, which legitimately recalls across the workspace's
 * hives) or resolves to no hive (a plain standalone harness). Pure — the registry
 * IO + flag gate live at the call site. */
export function narrowHarnessSlugsToSessionHive(
  entries: readonly RegistryEntryLite[],
  harnessSlugs: readonly string[],
  sessionHarness: string | null | undefined,
): string[] {
  if (!sessionHarness || sessionHarness === '*') return [...harnessSlugs];
  const scopeHive = potSlugsForHarnesses(entries, [sessionHarness])[0];
  if (!scopeHive) return [...harnessSlugs]; // session not in a hive → no narrowing
  const bySlug = new Map(entries.map((e) => [e.slug, e]));
  return harnessSlugs.filter((slug) => {
    const e = bySlug.get(slug);
    if (!e) return false; // unknown slug → drop from a confined fan-out
    const hive = e.harness_kind === 'hive' ? e.slug : e.hive_slug;
    return hive === scopeHive;
  });
}
