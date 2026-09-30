/**
 * Pot-membership resolution + enforcement (pot-membership-enforcement-2026-07-20,
 * P-005). Owner directive (VERIFIED — interactive, 2026-07-20 11:21, sess
 * a5e7a6e8): "AUDIT ALL WORK ITEMS THEY SHOULD ALL BE PART OF A REAL POT ...
 * papercusp-workspace ISNT A PART ... WE ADDED SOMETHING TO ENFORCE WORK ITEMS
 * TO BE PART OF A REAL POT, RIGHT?"
 *
 * Every work item's `harness_slug` is meant to name the row's real Pot
 * (`harness_shared.pots.pot_home_slug`). Historically the create paths let a row
 * land under a NON-pot slug — a workspace-global scope label (`operator:<ws>`,
 * `*`, `@singleton`, `papercusp-workspace`, ...) or an outright made-up slug —
 * which is exactly the drift migration 649 had to back-fill away. This module is
 * the WRITE-TIME resolver that stops the drift for good:
 *
 *   1. an explicit slug that IS a real Pot (canonicalized, member→home collapsed)
 *      → use it;
 *   2. no scope / a workspace-global label → home to the workspace PLATFORM pot
 *      (the Pot whose home slug is {@link PLATFORM_POT_SLUG} in that workspace),
 *      so "operator" issues belong to the platform Pot — the owner's model
 *      ("operator bugs and harness:<platform> bugs are the same product");
 *   3. an explicit, non-global slug that is NOT a real Pot → REJECT
 *      ({@link PotMembershipError}) — a typo / made-up Pot is a loud error, not a
 *      silent drift into the catch-all;
 *   4. FAIL-OPEN when the workspace has no platform Pot (isolated test fixtures /
 *      an un-potted tenant) → return the raw slug unchanged, so those tenants are
 *      never broken by enforcement.
 *
 * The resolver is PURE over an injected {@link PotLookup} (no PG) so it unit-tests
 * without a database — the gym:judge / DI pattern used across lib/. The
 * PG-backed lookup ({@link pgPotLookup}) is the production default. The DB-layer
 * backstop (P-006, a trigger on `harness_shared.work_items`) enforces the same
 * invariant for any writer that bypasses this layer.
 */
import { getOrgPg } from '@papercusp/db-org';
import { potHomeSlugForHarness } from './hive-federation';

/**
 * The canonical dogfood / platform Pot slug + its legacy-alias canonicalizer now
 * live in the PG-free {@link ../platform-pot-slug} module, so a PURE classifier can
 * import them without dragging `@papercusp/db-org` in (EI-19370922358009801 — the
 * `improvements/triage.ts` self-scope allowlist hardcoded the pre-rename spelling
 * precisely because it could not import this file). Re-exported here so every
 * existing `pot-membership` import keeps working unchanged.
 */
export { PLATFORM_POT_SLUG, canonicalPotSlug, isPlatformPotScope } from './platform-pot-slug';
import { PLATFORM_POT_SLUG, canonicalPotSlug } from './platform-pot-slug';

/**
 * The workspace-global label classifier now lives in the PG-free
 * {@link ../workspace-global-labels} module, for the same reason `platform-pot-slug`
 * does: a lean consumer (`scout/ungraded-scope`) must express this predicate without
 * importing `@papercusp/db-org` through this file. Re-exported so every existing
 * `pot-membership` import keeps working unchanged.
 */
export {
  isWorkspaceGlobalLabel,
  enumerableWorkspaceGlobalLabels,
  WORKSPACE_GLOBAL_LABEL_PREFIX,
} from './workspace-global-labels';
import { isWorkspaceGlobalLabel } from './workspace-global-labels';

/** Injectable Pot lookup (no PG) so {@link resolveWorkItemPot} unit-tests purely. */
export interface PotLookup {
  /**
   * Resolve a raw slug to a REAL Pot home slug in this workspace, or null if it does
   * not name (nor collapse to) one. Should canonicalize + collapse a member harness
   * to its Pot home before checking membership.
   */
  resolveRealPot(rawSlug: string): Promise<string | null>;
  /** The workspace's platform Pot slug, or null when the workspace has no platform Pot. */
  platformPot(): Promise<string | null>;
}

/** Thrown when an explicit, non-global slug does not name a real Pot (P-005 reject). */
export class PotMembershipError extends Error {
  readonly code = 'pot_not_found';
  constructor(
    readonly rawSlug: string,
    readonly workspaceId: string,
  ) {
    super(
      `pot '${rawSlug}' is not a real Pot in workspace '${workspaceId}' — every work item must belong to a real Pot. ` +
        `Pass a Pot home slug that exists (see pot:list), or omit it to file under the workspace platform Pot.`,
    );
    this.name = 'PotMembershipError';
  }
}

export interface ResolveWorkItemPotArgs {
  /** The caller-supplied Pot/harness slug (null/undefined = operator/workspace-global scope). */
  rawSlug: string | null | undefined;
  /** The workspace the item lands in. '*'/blank ⇒ unscoped SU: nothing to enforce against. */
  workspaceId: string | null | undefined;
  /** Injected for tests; defaults to the PG-backed lookup for `workspaceId`. */
  lookup?: PotLookup;
}

/**
 * Resolve a work item's effective Pot slug at write time (see the module doc for the
 * four-case contract). Returns the real Pot slug to store, or `null` meaning "keep the
 * caller's operator/workspace-global scope" (the fail-open path when the workspace has
 * no platform Pot). Throws {@link PotMembershipError} for an explicit, non-global slug
 * that is not a real Pot.
 */
export async function resolveWorkItemPot(args: ResolveWorkItemPotArgs): Promise<string | null> {
  const ws = args.workspaceId?.trim();
  // Unscoped SU (no concrete workspace) — no per-workspace Pot set to enforce against.
  if (!ws || ws === '*') return args.rawSlug?.trim() || null;

  const lookup = args.lookup ?? pgPotLookup(ws);
  const raw = args.rawSlug?.trim() ? args.rawSlug.trim() : null;
  const isGlobal = isWorkspaceGlobalLabel(raw, ws);

  if (raw && !isGlobal) {
    // (1) explicit, concrete slug → use it iff it resolves to a real Pot.
    const real = await lookup.resolveRealPot(raw);
    if (real) return real;
    // Not a real Pot. Enforce (reject) when this workspace HAS a platform Pot;
    // otherwise fail open (un-potted tenant / test fixture).
    const platform = await lookup.platformPot();
    if (platform) throw new PotMembershipError(raw, ws);
    return raw;
  }

  // (2)/(4) operator / workspace-global / no scope → home to the platform Pot,
  // or fail open (null) when the workspace has no platform Pot.
  return lookup.platformPot();
}

/**
 * The `harness_slug` a ROUTINE's rows are actually STORED under — which is NOT always
 * the routine's own `install_slug` (EI-19298246923137692, generalized by
 * EI-19298972043721870).
 *
 * Pot-membership enforcement canonicalizes the WRITE path: a row written under a
 * {@link isWorkspaceGlobalLabel} slug (`hive-canary`, `@singleton`, `*`, `operator`,
 * `all`, `operator:<ws>`, the bare workspace id) is re-homed to the platform Pot. A
 * READ path that filters `harness_slug = ${installSlug}` verbatim therefore matches
 * **zero rows, forever** — with no error and no warning. For a detector that is
 * indistinguishable from "everything is healthy", which is precisely why it went
 * unnoticed for ~12 days: six canaries sat open with their reported-stamps NULL and
 * the 15-minute SLA sweep reported success on every single tick.
 *
 * Resolving through the SAME resolver the write path uses keeps reads and writes in
 * agreement BY CONSTRUCTION, including for any label added to that set later.
 *
 * ⚠ Scope: this is for addressing DB ROWS ONLY. `installSlug` remains the correct
 * value for registry self-gating, pause resolution, log lines and watchdogKeys (stable
 * alarm identity) — re-homing those would break alarm continuity.
 *
 * ⚠ Not every raw-`installSlug` filter is a bug: a relation that is NOT subject to
 * re-homing (pot-scoped or install-scoped tables) is correctly read by the literal
 * slug. Check the RELATION, never pattern-match the call site.
 *
 * FAILS OPEN to the literal slug: a resolver hiccup must not silently disable a
 * detector — that failure mode is exactly what this function exists to prevent.
 */
export async function routineStorageSlug(installSlug: string, workspaceId: string): Promise<string> {
  try {
    return (await resolveWorkItemPot({ rawSlug: installSlug, workspaceId })) ?? installSlug;
  } catch (e) {
    console.warn(
      `[routine-storage-slug] pot resolve failed for "${installSlug}" — falling back to literal slug: ${e instanceof Error ? e.message : e}`,
    );
    return installSlug;
  }
}

/** Production PG-backed {@link PotLookup} for one workspace. */
export function pgPotLookup(workspaceId: string): PotLookup {
  return {
    async resolveRealPot(rawSlug: string): Promise<string | null> {
      const canon = canonicalPotSlug(rawSlug.trim());
      if (await potExists(workspaceId, canon)) return canon;
      // A member harness is not itself a Pot home — collapse it to its Pot home (D-009).
      try {
        const home = await potHomeSlugForHarness(workspaceId, canon);
        if (home) {
          const canonHome = canonicalPotSlug(home);
          if (await potExists(workspaceId, canonHome)) return canonHome;
        }
      } catch {
        /* no org-PG / resolver miss → not resolvable to a real Pot here */
      }
      return null;
    },
    async platformPot(): Promise<string | null> {
      return (await potExists(workspaceId, PLATFORM_POT_SLUG)) ? PLATFORM_POT_SLUG : null;
    },
  };
}

/**
 * Does a Pot with home slug `slug` exist in `workspaceId`? FAILS OPEN (returns false)
 * on any DB error — an unreadable/absent `harness_shared.pots` (a bare test schema, a
 * transient pool error) must never turn write-time enforcement into a hard create
 * failure. A false here cascades to the fail-open path in {@link resolveWorkItemPot}
 * (platformPot → null ⇒ no reject); the P-006 DB trigger remains the hard guarantee.
 */
async function potExists(workspaceId: string, slug: string): Promise<boolean> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ one: number }[]>`
      SELECT 1 AS one
        FROM harness_shared.pots
       WHERE workspace_id = ${workspaceId} AND pot_home_slug = ${slug}
       LIMIT 1`;
    return rows.length > 0;
  } catch {
    return false;
  }
}
