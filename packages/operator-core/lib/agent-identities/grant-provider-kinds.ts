import type { CapabilityProviderKind } from '../capability-class-registry-store';

/** The provider kinds an identity grant (`grants.requires`/`optional`) binds.
 * Install, the launch compiler and the runtime grant policy resolve this one set,
 * so an identity that installs also compiles and runs (P-020). */
export const IDENTITY_GRANT_PROVIDER_KINDS: readonly CapabilityProviderKind[] = ['tool', 'recipe'];

/** The attested execution evidence a grant provider row carries. A row read
 * before provider kinds existed has no `providerKind` and is a tool provider. */
export interface GrantProviderEvidence {
  verbBindings: Readonly<Record<string, string>>;
  providerKind?: CapabilityProviderKind;
  recipeInspections?: Readonly<Record<string, { recipe: { id: string }; toolNames: readonly string[] }>>;
}

/**
 * P-012 / D-040(e): the exact tools a grant provider reaches, which is what an
 * identity's grant confers and what the ceiling must admit. A tool provider's
 * verbs bind tools directly. A recipe provider's verbs bind recipes, so its reach
 * is the tools each bound recipe's inspection recorded (D-019) — the same
 * evidence rule as `recipeProviderPins`: every bound verb needs an inspection of
 * exactly the recipe it binds. Null means no usable evidence, never "no tools".
 */
export function grantProviderToolReach(provider: GrantProviderEvidence): string[] | null {
  const verbs = Object.keys(provider.verbBindings).sort();
  if (provider.providerKind === undefined || provider.providerKind === 'tool') {
    return [...new Set(verbs.map((verb) => provider.verbBindings[verb]))].sort();
  }
  if (provider.providerKind !== 'recipe' || !provider.recipeInspections || verbs.length === 0) return null;
  const reach = new Set<string>();
  for (const verb of verbs) {
    const inspection = Object.hasOwn(provider.recipeInspections, verb) ? provider.recipeInspections[verb] : undefined;
    if (!inspection || inspection.recipe.id !== provider.verbBindings[verb]) return null;
    for (const toolName of inspection.toolNames) reach.add(toolName);
  }
  return [...reach].sort();
}
