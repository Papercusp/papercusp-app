/**
 * federated-pot-scope — the FEDERATED pot scope, as a type the COMPILER polices.
 *
 * ── THE BUG THIS EXISTS TO STOP (EI-18777176681958978) ──
 * A Pot carries TWO names on a joiner, and they are both `string`:
 *
 *   LOCAL handle     `pots.pot_home_slug` / the registry slug — a naming AFFORDANCE
 *                    (`join-hive.ts` suffixes it via `freeSlug` on a local collision),
 *                    and a real local key with ~40 consumers (registry lookups,
 *                    getHiveBySlug, swarm binding, tool scope clamps).
 *   FEDERATED scope  the OWNER-authored slug this Pot's rows travel under on the wire —
 *                    `canonicalHiveHomeSlug` (WI-559) / `pots.canonical_pot_home_slug`
 *                    (migration 686). This is the scope EVERY hive-home-grained
 *                    projection PERSISTS under.
 *
 * Since WI-559 the ~16 `hiveScoped` projections WRITE `pot_members` (and revocations,
 * settings, receipts, …) under the FEDERATED scope, while a population of readers still
 * passed the LOCAL handle straight to `listHiveMembers` / `loadRevokedHivePubkeys`. Those
 * readers get an EMPTY set rather than an error, and the security-relevant half is
 * silent: `loadRevokedHivePubkeys(<local handle>)` returns empty, so **a revoked member
 * is never refused** on a joiner — including boot.ts's startup revocation seed, whose
 * entire job is refusing an already-revoked peer on first contact.
 *
 * Both values being `string` is the whole defect: either one type-checks. So the fix is
 * not (only) to correct N call sites — it is to make the WRONG one impossible to pass:
 *
 *   - `listHiveMembers` / `loadRevokedHivePubkeys` take `FederatedPotScope`, not `string`.
 *   - A caller that HOLDS a local handle must go through `resolveFederatedPotScope`
 *     (or the `*ForLocalPot` wrappers below) — an await, but a correct one.
 *   - A caller that legitimately already holds the federated scope (a projection's own
 *     bound slug, the presence topic binding, a self-consistent test fixture) states so
 *     ONCE, in writing, via `unsafeFederatedPotScope(slug, why)` — which is greppable,
 *     so the audit is `grep unsafeFederatedPotScope` rather than a re-derivation.
 *
 * ── WHY THE RESOLVER IS `canonicalHiveHomeSlug`-FIRST ──
 * The invariant that matters is READER SCOPE == WRITER SCOPE. The write scope is
 * boot.ts `resolveHiveHomeProjectionSlug` → `joinerPotHomeSlug` → `canonicalHiveHomeSlug`,
 * so a reader resolving through the SAME function agrees with the writers BY CONSTRUCTION
 * — even mid-reconcile. `pots.canonical_pot_home_slug` (migration 686, kept true by
 * `reconcilePotCanonicalSlug` BY PUBKEY from the signed announce) is consulted second, as
 * an independent corroborating source for the case where the registry/announce read cannot
 * answer in this process but the column already knows.
 *
 * FAIL-OPEN, and deliberately so: when neither source resolves, the local handle is
 * returned — byte-identical to today's behavior. On a Pot's OWNER (and on any joiner whose
 * handle agrees with the owner's) canonical == local, so this whole module is a no-op
 * there; it only changes behavior in exactly the topology that was broken.
 */
import type { Sql } from 'postgres';
import { canonicalHiveHomeSlug } from './hive-federation';
import {
  listHiveMembers,
  loadRevokedHivePubkeys,
  type HiveMemberRecord,
} from './hive-membership-store';

declare const federatedPotScopeBrand: unique symbol;

/**
 * The OWNER-authored pot-home slug a hive-home-grained row travels under — the ONLY
 * value the membership readers accept. Brand-only: at runtime it IS the string.
 *
 * Produce one with `resolveFederatedPotScope` (you hold a local handle) or
 * `unsafeFederatedPotScope` (you already hold the federated scope and can say why).
 */
export type FederatedPotScope = string & { readonly [federatedPotScopeBrand]: true };

/**
 * Certify that `slug` is ALREADY the federated scope. `why` is the audit trail — name the
 * resolver/binding that produced it (e.g. "register-all hiveScoped: harnessSlug IS the
 * projection's federated bind scope"), not a restatement of the type.
 *
 * Use ONLY when the value provably came from the write-side resolution (a projection's
 * bound slug, a presence topic binding resolved via canonicalHiveHomeSlug, a test fixture
 * that writes and reads the same synthetic slug). If you are holding a registry slug, a
 * `potHomeSlugForHarness` result, or anything a joiner could have suffixed locally, this
 * is the WRONG function — use `resolveFederatedPotScope`.
 */
export function unsafeFederatedPotScope(slug: string, why: string): FederatedPotScope {
  if (!slug || !slug.trim()) {
    throw new Error(
      `[federated-pot-scope] refusing to certify an empty pot scope as federated (${why}) — ` +
        `an empty scope reads as "no members", which is exactly the silent-empty failure ` +
        `this type exists to prevent (EI-18777176681958978).`,
    );
  }
  return slug as FederatedPotScope;
}

/** Injection seams — the two independent sources, so the resolution rules are unit-testable
 *  without a booted joiner. Production leaves both unset. */
export interface FederatedPotScopeSeams {
  canonicalHiveHomeSlug?: (
    workspaceId: string,
    harnessSlug: string,
    opts?: { fresh?: boolean },
  ) => Promise<string | null>;
  getHiveBySlug?: (
    workspaceId: string,
    homeSlug: string,
    sql?: Sql,
  ) => Promise<{ canonicalHomeSlug: string } | null>;
}

export interface ResolveFederatedPotScopeOpts {
  /** Forwarded to canonicalHiveHomeSlug → loadHarnessRegistry: bypass the registry cache
   *  (WI-1378 — required on an in-place-rekey resolve). */
  fresh?: boolean;
  /** Integration tests pass a per-file-schema client; forwarded to the `pots` read only. */
  sql?: Sql;
  seams?: FederatedPotScopeSeams;
}

/**
 * Resolve a LOCAL pot handle to the FEDERATED scope its hive-home rows are written under.
 * Never throws; falls open to the local handle (today's behavior) when neither source
 * can answer.
 */
export async function resolveFederatedPotScope(
  workspaceId: string,
  localPotHomeSlug: string,
  opts?: ResolveFederatedPotScopeOpts,
): Promise<FederatedPotScope> {
  const local = localPotHomeSlug;
  const resolveByAnnounce = opts?.seams?.canonicalHiveHomeSlug ?? canonicalHiveHomeSlug;
  // SOURCE 1 — AUTHORITATIVE, and authoritative even when it answers `local`. This is the
  // same function the WRITE scope resolves through, so whatever it says here is the scope the
  // projections actually persisted under: an answer of `local` means the writers wrote under
  // `local`, and reading `local` is then CORRECT. Returning it immediately is what keeps
  // reader == writer, and it also keeps the owner path (the overwhelmingly common case) at
  // ZERO extra PG reads — an unconditional second read would add one per git-sync tick.
  const announced = await resolveByAnnounce(
    workspaceId,
    local,
    opts?.fresh ? { fresh: true } : undefined,
  ).catch(() => null);
  if (announced) return announced as FederatedPotScope;
  // SOURCE 2 — only reached when source 1 could not answer AT ALL (null: no registry entry /
  // no resolvable home in this process, or it threw). Migration 686's column is reconciled BY
  // PUBKEY from the signed announce (`reconcilePotCanonicalSlug`), so it can still know the
  // owner's slug when the registry/announce read here cannot.
  //
  // DYNAMICALLY IMPORTED, deliberately. A static `import { getHiveBySlug } from './hive-store'`
  // makes hive-store (and its db-org chain) a hard dependency of EVERY module that resolves a
  // pot scope — which promptly broke a unit test three modules away that legitimately
  // partial-mocks hive-store ("No getHiveBySlug export is defined on the mock"). Loading it
  // lazily, inside the try, means: not loaded at all on the common path (source 1 answers), and
  // a caller's partial mock degrades to the documented fail-open instead of throwing. Same
  // reasoning as hive-federation.ts's own dynamic import of hive-membership-store.
  try {
    const readPot =
      opts?.seams?.getHiveBySlug ?? (await import('./hive-store')).getHiveBySlug;
    const pot = await readPot(workspaceId, local, opts?.sql);
    if (pot?.canonicalHomeSlug) return pot.canonicalHomeSlug as FederatedPotScope;
  } catch {
    /* fail-open to the local handle below — never let scope resolution break a caller */
  }
  return local as FederatedPotScope;
}

/**
 * `listHiveMembers` for a caller that holds a LOCAL pot handle (git-sync's registry entry,
 * a routine's install slug, the epoch reconcile's `pots` scan). Resolves the federated
 * scope first — a no-op on an owner, the fix on a joiner.
 */
export async function listHiveMembersForLocalPot(
  workspaceId: string,
  localPotHomeSlug: string,
  sql?: Sql,
): Promise<HiveMemberRecord[]> {
  const scope = await resolveFederatedPotScope(workspaceId, localPotHomeSlug, { sql });
  // Forward `sql` only when the caller supplied one, so the underlying call ARITY is
  // byte-identical to the pre-fix direct call. On a shared tree that matters: mocks across
  // the suite assert `toHaveBeenCalledWith(ws, slug)`, and an appended explicit `undefined`
  // would red them for a difference that does not exist at runtime.
  return sql === undefined
    ? listHiveMembers(workspaceId, scope)
    : listHiveMembers(workspaceId, scope, sql);
}

/**
 * `loadRevokedHivePubkeys` for a caller that holds a LOCAL pot handle. This is the
 * security-relevant half: an unresolved local handle returns an EMPTY revocation set, so a
 * revoked device is admitted rather than refused.
 */
export async function loadRevokedHivePubkeysForLocalPot(
  workspaceId: string,
  localPotHomeSlug: string,
  sql?: Sql,
): Promise<Set<string>> {
  const scope = await resolveFederatedPotScope(workspaceId, localPotHomeSlug, { sql });
  return sql === undefined
    ? loadRevokedHivePubkeys(workspaceId, scope)
    : loadRevokedHivePubkeys(workspaceId, scope, sql);
}
