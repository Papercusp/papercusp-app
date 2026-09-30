/**
 * `system:consult-expiry-sweep` — the consult lifecycle expiry sweep's
 * routine-engine registration (get-feedback-relevance-consults-2026-08-16
 * P-005 / D-005).
 *
 * This module is now WIRING ONLY. Two layers sit beneath it, and both are reachable
 * from a test:
 *   - the sweep logic in `../../consult/consult-expiry-core.ts` (pure, integration-
 *     tested against the real migration-834 tables);
 *   - the production adapters in `../../consult/consult-expiry-adapters.ts`, which
 *     bind that core to org PG, the awaited-event engine, the durable requester
 *     alert, and the D-002 fork/convert dispatcher.
 *
 * The adapters used to be lambdas inside the `registerSystemAction` closure below,
 * where no test could execute them — only pin their source text (EI-21559794492221235).
 * They carry real per-row workspace-threading decisions, so that blind spot was load
 * bearing; see the adapters module's header for what each one actually decides.
 *
 * Seeded as a bespoke `tier:'ephemeral'` routine (300s cadence) by
 * `seed-consult-expiry-routine.ts` — an operator-HOME-level substrate concern
 * (one sweep serves every workspace's consult rows), not a per-blueprint-install
 * one; mirrors `supervision-reconcile-action.ts`'s documented deviation.
 */
import { registerSystemAction } from './system-actions';
import { PgThreadStore } from '@papercusp/coordination/capabilities';

registerSystemAction('consult-expiry-sweep', async () => {
  const [
    { getOrgPg },
    { sweepExpiredConsults },
    { emitAwaitedEvent },
    {
      consultExpiryEmitReplyEvent,
      consultExpiryFindSilentResponders,
      consultExpiryNotifyRequester,
      consultExpiryDispatch,
      consultExpiryFileReviewWorkItem,
      consultExpiryStopAnsweringSession,
    },
    { makeConsultReachDispatcher },
    { upsertConditionWorkItem },
    { listLiveTasks },
    { killTask },
  ] = await Promise.all([
    import('@papercusp/db-org'),
    import('../../consult/consult-expiry-core'),
    import('../../events/await/engine'),
    import('../../consult/consult-expiry-adapters'),
    import('../../consult/consult-dispatch'),
    import('../../coord/condition-upsert'),
    import('../../task-manager/store'),
    import('../../task-manager/control'),
  ]);

  await sweepExpiredConsults({
    getSql: () => getOrgPg().sql,
    // P-003 (WI-10003199): a slot whose window closes without a post has its
    // answering session stopped here, at the transition, instead of idling until
    // the task reaper's next pass; the reaper remains the backstop.
    stopAnsweringSession: consultExpiryStopAnsweringSession({
      listLiveTasks: (workspaceId) => listLiveTasks(workspaceId),
      killTask: (taskId) => killTask(taskId),
    }),
    emitReplyEvent: consultExpiryEmitReplyEvent(emitAwaitedEvent),
    notifyRequester: consultExpiryNotifyRequester(async (identity, opts) => {
      const { sendMessage } = await import('../../agent-tools/coordination/messages');
      return sendMessage(identity, opts);
    }),
    // D-002/D-011: the sweep DISPATCHES the next selectee (fork/convert from
    // their transcript) instead of waking them. notifyAgents is no longer on
    // this binding at all, so the sweep cannot silently regain a wake.
    dispatch: consultExpiryDispatch((ctx) => makeConsultReachDispatcher(ctx)),
    // P-014: a silent review consult at half its TTL becomes a pullable work item
    // (filed in the consult's harness, else the workspace's home pot) instead of
    // cascading to another silent responder.
    fileReviewWorkItem: consultExpiryFileReviewWorkItem({
      upsert: upsertConditionWorkItem,
      resolveHarness: async (workspaceId, conversationId) => {
        const rows = (await getOrgPg().sql`
          SELECT harness_slug FROM harness_shared.coord_conversations
           WHERE workspace_id = ${workspaceId} AND id = ${conversationId}
        `) as unknown as Array<{ harness_slug: string | null }>;
        if (rows[0]?.harness_slug) return rows[0].harness_slug;
        const { resolveHomePotSlug } = await import('../../agent-tools/pot/_resolve');
        return resolveHomePotSlug(workspaceId);
      },
    }),
    findSilentResponders: consultExpiryFindSilentResponders({
      getPresence: async (ownerId) => {
        const { getPresence } = await import('../../agent-tools/coordination/presence');
        return getPresence(ownerId);
      },
      resolveSessionStates: async (subjects, opts) => {
        const { resolveSessionStates } = await import('../../agent-tools/coordination/liveness-oracle');
        return resolveSessionStates(subjects, opts);
      },
      getThreadStore: (workspaceId) =>
        new PgThreadStore({
          getSql: () => getOrgPg().sql,
          ensureSchema: async () => {},
          workspaceId,
        }),
    }),
  });
});
