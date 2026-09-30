/**
 * GET /api/admin/spawn-signing/failures — read the spawn-URL
 * verification audit table for on-call review.
 *
 * Ported from app/api/admin/spawn-signing/failures/route.ts.
 * `auth: { trust: ['trusted'] }`.
 */
import { getOrgPg, generated } from '@papercusp/db-org';
import { and, count, desc, eq, gt, sql as dsql } from 'drizzle-orm';
import { defineTool } from '@papercusp/agent-mcp';

const sf = generated.spawnSigVerificationFailuresInHarnessShared;

export default defineTool({
  method: 'GET',
  path: '/admin/spawn-signing/failures',
  auth: { trust: ['trusted'] },
  async handler(req) {
    const url = new URL(req.url);
    const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') ?? 100) || 100));
    const since = url.searchParams.get('since');
    const reason = url.searchParams.get('reason');

    const { db } = getOrgPg();

    const sinceTs = since ? new Date(since) : null;
    if (since && (!sinceTs || Number.isNaN(sinceTs.getTime()))) {
      return Response.json({ error: 'invalid_since' }, { status: 400 });
    }

    const rowsWhere = and(
      sinceTs ? gt(sf.ts, sinceTs as any) : undefined,
      reason ? eq(sf.reason, reason) : undefined,
    );
    const rows = await db
      .select({
        id: sf.id,
        ts: sf.ts,
        reason: sf.reason,
        claimed_role: sf.claimedRole,
        claimed_harness: sf.claimedHarness,
        claimed_workspace: sf.claimedWorkspace,
        claimed_spawn: sf.claimedSpawn,
        exp_claim: sf.expClaim,
        remote_addr: sf.remoteAddr,
        user_agent: sf.userAgent,
      })
      .from(sf)
      .where(rowsWhere)
      .orderBy(desc(sf.ts))
      .limit(limit);

    const summary = await db
      .select({ reason: sf.reason, count: count() })
      .from(sf)
      .where(sinceTs ? gt(sf.ts, sinceTs as any) : dsql`${sf.ts} > now() - interval '24 hours'`)
      .groupBy(sf.reason)
      .orderBy(desc(count()));

    // Drizzle returns bigserial/bigint as JS BigInt — JSON.stringify can't
    // serialize BigInt, coerce to Number for transport (safe up to 2^53).
    const rowsJson = rows.map((r) => ({
      ...r,
      id: typeof r.id === 'bigint' ? Number(r.id) : r.id,
      exp_claim: typeof r.exp_claim === 'bigint' ? Number(r.exp_claim) : r.exp_claim,
    }));

    return Response.json({
      rows: rowsJson,
      summary: {
        byReason: Object.fromEntries(summary.map((r) => [r.reason, Number(r.count)])),
        window: sinceTs ? sinceTs.toISOString() : 'last 24h',
      },
    });
  },
});
