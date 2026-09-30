import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';

/**
 * `/inbox` — Direction B's focused portal embed. The component itself lives in
 * `components/route-content/InboxEmbedRoute` (WI-5502): a route module that
 * ALSO exports its component keeps that export — and every import it needs — in
 * the route's critical half, which defeated `autoCodeSplitting` and pulled
 * `InboxPane` + `InboxBulkRecommendation` into the eager boot graph. Same shape
 * as `routes/dev.tsx`.
 */
export const Route = createFileRoute('/inbox')({
  component: lazyRouteComponent(() => import('../components/route-content/InboxEmbedRoute')),
});
