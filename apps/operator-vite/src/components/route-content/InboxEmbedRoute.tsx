import InboxPane from '@/app/_components/inbox/InboxPane';

/**
 * `/inbox` — Direction B's focused portal embed. InboxPane owns the complete
 * canonical attention flow, including selection/detail, discussion, and the
 * explicit InboxBulkStrip resolve/review/settle lifecycle.
 *
 * `layout="split"` (portal-work-two-pane-2026-09-01 D-001): the full page lays
 * the row list out beside the selected item's detail — the ratified Direction B
 * list + detail — while the chat sidebar keeps the pane's stack default.
 *
 * WI-5502: this component lives OUTSIDE `src/routes/inbox.tsx` on purpose. A
 * route module that also exports its component as a named export defeats the
 * router plugin's `autoCodeSplitting` — the splitter must keep every non-route
 * export (and therefore every import it needs) in the route's CRITICAL half, so
 * `InboxPane` and its transitive graph land in the eager boot bundle. Keeping
 * the component in `route-content/` and referencing it through
 * `lazyRouteComponent` is the same shape `routes/dev.tsx` already uses.
 */
export function InboxEmbedRoute() {
  return (
    <div
      className="portal-focused-work-surface"
      data-testid="inbox-portal-embed"
      data-portal-surface="inbox"
    >
      <InboxPane layout="split" />
    </div>
  );
}

export default InboxEmbedRoute;
