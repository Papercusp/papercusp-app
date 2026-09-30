import type { CapabilityProviderKind } from '../capability-class-registry-store';

/** The provider kinds an identity grant (`grants.requires`/`optional`) binds.
 * Install, the launch compiler and the runtime grant policy resolve this one set,
 * so an identity that installs also compiles and runs (P-020). */
export const IDENTITY_GRANT_PROVIDER_KINDS: readonly CapabilityProviderKind[] = ['tool', 'recipe'];
