/**
 * agent-orders-notify — the PRODUCER-side push for `agentOrders.byOwner` (WI-6974).
 *
 * ── Why a producer push and not a table trigger ──────────────────────────────
 * `agentOrders.byOwner` (the session popup's Orders panel) gathers from six
 * tables. Only `harness_shared.work_items` is reachable through the
 * `TABLE_TO_QUERY_NAMES` bridge; the other five are NOT, and WI-6974 originally
 * read that as "wire them the same way". Measuring the writers says otherwise —
 * every one of the five is written far more often by something that is NOT an
 * orders change:
 *
 *   - `plan_item_claims`  — `renewOwnerActivityClaims` rewrites `last_activity_ts`
 *                           on EVERY TURN of every owner holding a claim. That is a
 *                           heartbeat, not a lane change. (A point-in-time write-rate
 *                           sample cannot see this; you have to read the writer. The
 *                           earlier triage classified this table "✅ safe as a bare
 *                           string" off a 2-rows/5min sample — see WI-6974.)
 *   - `carry_notes`       — every agent's `loop:checkpoint` (~26/hr fleet-wide here).
 *   - `session_briefs`    — the row moves on intent/current_files/presence writes;
 *                           only the `control_*` columns are orders.
 *   - `agent_modes` /
 *     `agent_mode_changes`— genuinely event-driven, but they carry no owner-scoped
 *                           key the bridge could use, so a trigger would full-bust
 *                           every open panel for a mode set on an unrelated agent.
 *
 * A row trigger cannot tell those apart — it fires on the write, not on the
 * meaning of the write. Wiring them would trade WI-6974's defect (panel refreshes
 * on remount only) for its mirror image: a panel pushed on a timer, which is
 * WORSE because it looks live. That is precisely the reasoning that already keeps
 * `coord_presence` out of the declaration (see the resolver entry's comment) and
 * that `sidebar.hives :: harness_shared.shared_presence` is PUSH_EXEMPT for.
 *
 * So the push lives at the PRODUCER, which knows both things a trigger cannot:
 * WHETHER the write changed the agent's orders, and WHICH owner it changed them
 * for. This is the same shape the derived-reads precompute substrate already uses
 * (`notifySyncInvalidate(producer.key)` only on a real payload change), and which
 * `resolver-backing-table-coverage.test.ts` documents as "strictly better than a
 * table trigger, which would also fire on the no-op refreshes".
 *
 * ── Owner-scoped, never a full bust ─────────────────────────────────────────
 * `agentOrders.byOwner`'s args are exactly `{ ownerId }`, and client-side
 * invalidation is a DEEP-PARTIAL key match (verified against @tanstack/query-core
 * 5.100.5 — no-http-anywhere-2026-07-28 D-018), so emitting `{ ownerId }` refetches
 * only the panel viewing THAT agent. Every other open panel is untouched.
 *
 * Best-effort by construction: a push failure must never fail the write it
 * follows. Mirrors `notifyOperatorStateSync`'s dynamic import + swallow, which
 * also keeps this module free of a static `sync-sse` edge.
 */

/** The one query name this module pushes. Exported so tests can assert on it
 *  rather than re-typing the string (a typo'd name is a silent no-push). */
export const AGENT_ORDERS_QUERY_NAME = 'agentOrders.byOwner';

/**
 * Push `agentOrders.byOwner` for ONE owner, after a write that genuinely changed
 * what that agent was TOLD.
 *
 * Call this ONLY on a real orders change. Do NOT call it from a liveness
 * heartbeat (`heartbeatClaim`, `renewOwnerActivityClaims`,
 * `extendOwnerClaimsForAwait`) or from a no-op re-persist — the whole reason this
 * is a producer push rather than a table trigger is that the producer can tell
 * the difference.
 */
export async function notifyAgentOrdersChanged(ownerId: string | null | undefined): Promise<void> {
  if (!ownerId) return;
  try {
    const { notifySyncInvalidate } = await import('./sync-sse');
    await notifySyncInvalidate(AGENT_ORDERS_QUERY_NAME, { ownerId });
  } catch {
    /* best-effort: a stale panel is never worth failing the write that preceded it */
  }
}
