import TasksRosterPanel from '../adv/TasksRosterPanel';
import '../adv/adv-header-pills.css';

/**
 * /tasks-roster — chromeless iframe target for the hosted Portal's process pill.
 *
 * This is deliberately only composition. The inventory query, search, resource
 * totals, grouping, kill guard and full-manager link all remain owned by the
 * canonical TasksRosterPanel that the native operator pill renders.
 *
 * WI-5502: this component lives OUTSIDE `src/routes/tasks-roster.tsx` on
 * purpose. A route module that also exports its component as a named export
 * defeats the router plugin's `autoCodeSplitting` — the splitter must keep every
 * non-route export (and therefore every import it needs) in the route's CRITICAL
 * half, so `TasksRosterPanel` AND the `adv-header-pills.css` side-effect import
 * landed in the eager boot bundle (the stylesheet as a render-blocking
 * `<link>`). Keeping the component in `route-content/` and referencing it
 * through `lazyRouteComponent` is the same shape `routes/dev.tsx` already uses.
 */
export function TasksRosterEmbedRoute() {
  return (
    <div className="pc-tasks-roster-embed" data-testid="tasks-roster-embed">
      <TasksRosterPanel active />
    </div>
  );
}

export default TasksRosterEmbedRoute;
