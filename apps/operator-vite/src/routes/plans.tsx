import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';

/**
 * `/plans` — Direction B's focused portal embed. The component itself lives in
 * `components/route-content/PlansEmbedRoute` (WI-5502): a route module that
 * ALSO exports its component keeps that export — and every import it needs — in
 * the route's critical half, which defeated `autoCodeSplitting` and pulled
 * `PlansPane` (and, through it, `SessionChatModal`) plus their stylesheets into
 * the eager boot graph. Same shape as `routes/dev.tsx`.
 */
export const Route = createFileRoute('/plans')({
  component: lazyRouteComponent(() => import('../components/route-content/PlansEmbedRoute')),
});
