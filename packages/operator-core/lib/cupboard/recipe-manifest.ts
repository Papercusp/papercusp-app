/**
 * recipe-manifest — the shareable recipe manifest's TYPES, as a dependency-free leaf.
 *
 * Split out of `recipe-export.ts` (WI-10004876) so the filesystem side of the recipe kind
 * (`recipe-store.ts`, `install-recipe-core.ts`) can name these shapes without pulling the
 * export sanitizer's own imports (`recipe-authority`, `code-recipes-store`) into every
 * program that reads a recipe dir. A type-only import still adds the imported FILE to a tsc
 * program, so the Cupboard Worker's stricter typecheck compiled the whole agent-tools graph
 * through `recipe-store -> recipe-export -> recipe-authority`. Keep this file import-free.
 */

/** The self-describing manifest written as `recipe.json`. Deliberately a SUBSET of
 *  CodeRecipeRow — the fields an installing workspace can meaningfully adopt. */
export interface ExportedRecipeManifest {
  /** The recipe's stable kebab id — also the install target's primary key. */
  id: string;
  title: string;
  description: string;
  script: string;
  toolsUsed: string[];
  tags: string[];
  /** True when the authority analyzer could not statically prove the script's
   *  effects. Carried so the installer can say so; never a publish blocker. */
  authorityUnresolved: boolean;
  /** Which construct made it unresolved, when the analyzer named one. */
  authorityUnresolvedCause?: string;
}

export interface RecipeExport {
  manifest: ExportedRecipeManifest;
  /** Storefront description — the recipe's own, else its title. */
  description: string;
  /** Fields dropped as usage/attribution, reported so a publisher can see the
   *  sanitizer ran rather than assume it. */
  strippedFields: string[];
}
