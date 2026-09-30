import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';

/**
 * /tasks-roster — chromeless iframe target for the hosted Portal's process pill.
 * The component itself lives in `components/route-content/TasksRosterEmbedRoute`
 * (WI-5502): a route module that ALSO exports its component keeps that export —
 * and every import it needs — in the route's critical half, which defeated
 * `autoCodeSplitting` and pulled `TasksRosterPanel` plus the
 * `adv-header-pills.css` side-effect import into the eager boot graph (the
 * stylesheet as a render-blocking `<link>`). Same shape as `routes/dev.tsx`.
 */
export const Route = createFileRoute('/tasks-roster')({
  component: lazyRouteComponent(
    () => import('../components/route-content/TasksRosterEmbedRoute'),
  ),
});
