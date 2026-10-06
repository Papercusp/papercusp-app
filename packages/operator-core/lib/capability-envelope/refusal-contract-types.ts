/**
 * The `RefusalContract` SHAPE, as a dependency-free leaf (WI-10005197).
 *
 * It lives apart from `identity-refusal-contract.ts` on purpose: that module imports a
 * type from `blueprint-envelopes`, whose static import chain reaches
 * `operator-state-pg.ts` / `sync-sse.ts`. Light, portal-prebundled modules (the hosted
 * auth/billing runtimes) must be able to attach a contract to a refusal WITHOUT putting
 * that substrate in their bundle cone — `hosted-auth-runtime.bundle-cone.test.ts` walks
 * `import type` edges too, so even an erased type import across the heavy module fails
 * it. Anything that needs only the shape imports it from HERE; the identity-specific
 * lift table and renderers stay in `identity-refusal-contract.ts`, which re-exports
 * these types so existing importers are unchanged.
 *
 * Keep this file import-free: a single import here silently re-widens every light
 * consumer's cone.
 */

/** Who can make a refusal's lift condition true. */
export type RefusalActor = 'self' | 'host' | 'owner' | 'another-agent';

/** What the gate actually compared. Values are short and secret-free (revision prefixes). */
export type RefusalObservation = Readonly<Record<string, string | null>>;

export interface RefusalContract {
  observed: RefusalObservation;
  liftsWhen: string;
  whoCanMakeItTrue: readonly RefusalActor[];
}
