/**
 * POST /api/agent-mcp/autonomy-tripwire-revert — the owner's one-click undo of a
 * Queen auto-decision from the settings recent-auto-decisions feed
 * (queen-autonomy-policy-2026-06-13 P-031; backs RecentAutoDecisions.tsx's Undo
 * button).
 *
 * Mirrors `autonomy-policy-set.ts`: the MCP tool `autonomy:tripwire_revert`
 * REQUIRES args, so it's excluded from the command-palette `run-tool` path
 * (safety-filter §3 → 403); the settings feed writes through this dedicated
 * loopback route instead. Same trip+demote semantics as the tool — trip the
 * armed tripwire as `owner-thumbs-down` (the strongest counter-signal) and demote
 * the category one graduated step (honoring lock/pin, D-005) — composed from the
 * same exported store primitives the tool uses, plus the sync invalidations the
 * feed needs.
 *
 * The LITERAL action auto-revert executor is dark until D-020 (queen-autonomous-
 * execution); today this records the trip + demotes + returns the handle. That is
 * already a real owner action: it tells the graduation engine this category was
 * too aggressive and steps it back.
 *
 * Loopback-only: the desktop owner surface is the only caller. Never ARMS autonomy
 * (it only ever demotes / counter-signals).
 */
import { defineTool } from '@papercusp/agent-mcp';
import { isLoopbackRequest } from '../../../superuser-token';

interface Body {
  tripwireId?: unknown;
  reason?: unknown;
}

export default defineTool({
  method: 'POST',
  path: '/agent-mcp/autonomy-tripwire-revert',
  auth: 'loopback',
  async handler(req) {
    if (!isLoopbackRequest(req.headers)) {
      return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
    }
    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
    }

    const tripwireId = typeof body.tripwireId === 'string' ? body.tripwireId.trim() : '';
    if (!tripwireId) {
      return Response.json({ ok: false, error: 'missing_tripwireId' }, { status: 400 });
    }
    const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : undefined;

    const { getOrgPg } = await import('@papercusp/db-org');
    const { activeWorkspaceId } = await import('../../../workspace-registry');
    const { getTripwire, markTripwireTripped, markTripwireReverted } = await import('../../../autonomy/tripwire/store');
    const { getAutonomyCategoryPolicy, setAutonomyPolicy } = await import('../../../autonomy/policy-store');
    const { demoteGraduatedLevel } = await import('../../../autonomy/tripwire/core');

    const ws = activeWorkspaceId();
    const { sql } = getOrgPg();
    const nowMs = Date.now();
    // The desktop owner surface IS the owner — the audited authority actor (D-005).
    const actor = 'owner';

    const row = await getTripwire(sql, ws, tripwireId);
    if (!row) {
      return Response.json({ ok: false, error: 'not_found', tripwireId }, { status: 404 });
    }
    if (row.status !== 'armed') {
      // Already cleared / tripped / reverted — nothing to undo (idempotent-friendly).
      return Response.json({ ok: false, error: 'already_resolved', status: row.status, tripwireId }, { status: 409 });
    }

    // Trip it (owner thumbs-down — the strongest counter-signal).
    await markTripwireTripped(sql, ws, row.id, 'owner-thumbs-down', nowMs, actor);

    // Demote the category one graduated step (honors lock/pin — same as the tool).
    const policy = await getAutonomyCategoryPolicy(sql, ws, row.category);
    const from = policy.graduatedLevel;
    const to = demoteGraduatedLevel(from);
    const pinned = policy.ownerOverride != null && (policy.ownerOverride as { pinned?: unknown }).pinned === true;
    let demoted = false;
    if (!policy.locked && !pinned && to !== from) {
      await setAutonomyPolicy(
        sql,
        ws,
        { category: row.category, graduatedLevel: to, reason: reason ?? `owner undo of ${row.id}` },
        actor,
      );
      demoted = true;
    }

    const { executeRevertVia, makeRevertRegistry, defaultRevertHelpers } =
      await import('../../../autonomy/tripwire/revert-executor');
    const revertOutcome = await executeRevertVia(row, makeRevertRegistry(), defaultRevertHelpers());
    if (revertOutcome.reverted) {
      await markTripwireReverted(sql, ws, row.id, nowMs);
    }

    // The feed (decision.ledger), the policy table's graduated chip (autonomy.policy),
    // and the graduation surface (autonomy.graduation) all reflect a demotion.
    const { notifySyncInvalidate } = await import('../../../sync-sse');
    // Name-only (no args): these resolvers/subscriptions aren't keyed on workspaceId
    // (the settings feeds subscribe with no workspaceId arg — decision.ledger uses
    // {layer,limit}), so an args-scoped invalidate would do an exact-key match that
    // never fires and the feed/table wouldn't refetch. See the autonomy-policy-set
    // route for the full note.
    await notifySyncInvalidate('decision.ledger').catch(() => {});
    await notifySyncInvalidate('autonomy.policy').catch(() => {});
    await notifySyncInvalidate('autonomy.graduation').catch(() => {});

    return Response.json({
      ok: true,
      workspaceId: ws,
      tripwireId: row.id,
      category: row.category,
      tripped: true,
      demoted,
      demotion: demoted ? { from, to } : { skipped: policy.locked ? 'locked' : pinned ? 'pinned' : 'no-change' },
      reverted: revertOutcome.reverted,
      note: revertOutcome.note,
    });
  },
});
