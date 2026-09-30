import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * /admin — redirects to /admin/run. Admin index is intentionally not
 * flag-gated; reachable by URL only. Translated from
 * `apps/operator/app/admin/page.tsx`.
 */
export const Route = createFileRoute('/admin/')({
  beforeLoad: () => {
    throw redirect({ to: '/admin/run' });
  },
});
