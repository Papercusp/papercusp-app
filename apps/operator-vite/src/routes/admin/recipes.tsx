import { createFileRoute } from '@tanstack/react-router';
import AdminShell from '../../components/admin/AdminShell';
import RecipesClient from '../../components/admin/RecipesClient';

/**
 * /admin/recipes — read-only dashboard over the code:run RECIPE corpus
 * (code-recipes-2026-06-21 P-009). A sibling admin tab to /admin/features +
 * /admin/git: the recipe table + the Queen's deterministic promote/merge
 * worklist, live over the `codeRecipes` + `recipeCandidates` sync queries.
 * Intentionally not flag-gated; reachable by URL only.
 */
export const Route = createFileRoute('/admin/recipes')({
  component: AdminRecipesPage,
});

function AdminRecipesPage() {
  return (
    <AdminShell title="Recipes">
      <RecipesClient />
    </AdminShell>
  );
}
