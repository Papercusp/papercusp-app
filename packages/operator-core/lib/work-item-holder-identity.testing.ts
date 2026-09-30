/**
 * Test-only wrapper for `work-item-holder-identity` (EI-23701433507513915).
 *
 * The site suites (claim, complete, create, release-force-guard, _create-core) mock
 * `@papercusp/db-org` with their own fakes, so the default coord-presence lookup cannot run
 * there. Instead of stubbing the three helpers with canned answers — which would test the
 * mock, not the rules — a suite `vi.mock`s the module through this wrapper. The REAL
 * expand/resolve/compare rules then run against an in-memory owner registry the test owns:
 *
 *   const OWNER_REGISTRY = vi.hoisted(() => ({ ids: [] as string[] }));
 *   vi.mock('../../work-item-holder-identity', async (importOriginal) => {
 *     const { registryBackedHolderIdentity } = await import('../../work-item-holder-identity.testing');
 *     return registryBackedHolderIdentity(await importOriginal(), OWNER_REGISTRY);
 *   });
 *
 * A caller-supplied `lookup` still wins, so the helper's own unit tests are unaffected.
 */
import type * as HolderIdentity from './work-item-holder-identity';

type Module = typeof HolderIdentity;

export function registryBackedHolderIdentity(
  real: Module,
  registry: { readonly ids: readonly string[] },
): Module {
  const lookup: HolderIdentity.OwnerIdPrefixLookup = async ({ prefix, limit }) =>
    registry.ids.filter((id) => id.startsWith(prefix)).slice(0, limit);
  return {
    ...real,
    canonicalizeAssigneeOwnerId: (raw, opts = {}) => real.canonicalizeAssigneeOwnerId(raw, { lookup, ...opts }),
    resolveHolderOwnerId: (stored, opts = {}) => real.resolveHolderOwnerId(stored, { lookup, ...opts }),
    holderIsCaller: (stored, caller, opts = {}) => real.holderIsCaller(stored, caller, { lookup, ...opts }),
  };
}
