/**
 * The operator's single coord ENTITY-SUBSCRIPTION store seam.
 *
 * `coord_entity_subscriptions` (the Subscribable capability backend — who follows
 * which object) was being instantiated inline at every reach/fan-out call site
 * (`new PgEntitySubscriptionStore({ getSql, ensureSchema })` in notify-agents,
 * message-agent, prod-caps) with NO workspace scoping, while the fan-out path
 * pinned `DEFAULT_COORD_WORKSPACE`. Under the `COORD_PER_WORKSPACE` flag those
 * diverge — a subscribe/notify written to one workspace while the inbox reads
 * another → silently undelivered (coordination-unification-data-sync-hardening
 * P-002/P-004).
 *
 * This is the one shared, workspace-RESOLVING singleton (mirrors `coordLog`):
 * `getWorkspaceId` resolves per-operation via `coordScopeWorkspace()` (the SAME
 * flag-gated resolver coordLog uses), so every reach path + the fan-out share one
 * consistently-scoped store.
 */
import { PgEntitySubscriptionStore } from '@papercusp/coordination/capabilities';
import { getOrgPg } from '@papercusp/db-org';
import { coordScopeWorkspace } from './log';

let _store: PgEntitySubscriptionStore | undefined;

/** The shared, workspace-scoped coord entity-subscription store (singleton). */
export function getCoordSubscriptionStore(): PgEntitySubscriptionStore {
  return (_store ??= new PgEntitySubscriptionStore({
    getSql: () => getOrgPg().sql,
    ensureSchema: async () => {},
    getWorkspaceId: () => coordScopeWorkspace(),
  }));
}
