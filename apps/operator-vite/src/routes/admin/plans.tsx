import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';

/**
 * /admin/plans — the markdown-canonical plan browser/editor. Translated
 * from `apps/operator/app/admin/plans/page.tsx`.
 *
 * The page body (`AdminShell` + `PlansClient`) and its `plans.css` import
 * live in `AdminPlansPageContent`, reached only through this route's
 * `lazyRouteComponent` dynamic-import boundary (WI-5502 item 2 — see that
 * file's comment).
 *
 * The data layer is unaffected by the framework move: PlansClient
 * fetches the `/api/admin/plans/*` route handlers, which are
 * `defineTool`s mounted on the shared Hono app — same backend for the
 * Next operator and the Vite operator.
 *
 * AdminShell already lists the Plans tab; without this route file the
 * tab would 404 in the Vite build.
 */
export const Route = createFileRoute('/admin/plans')({
  component: lazyRouteComponent(() => import('../../components/route-content/AdminPlansPageContent')),
});
