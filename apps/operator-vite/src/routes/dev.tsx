import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';

/**
 * /dev layout — translated from `apps/operator/app/dev/layout.tsx`.
 * The original just imported `dev.css` for side-effect and rendered
 * children; that CSS import now lives in `DevLayoutContent`, reached only
 * through this route's dynamic-import boundary (WI-5502 item 2 — see that
 * file's comment for why a bare side-effect import can't just stay here).
 */
export const Route = createFileRoute('/dev')({
  component: lazyRouteComponent(() => import('../components/route-content/DevLayoutContent')),
});
