/**
 * /admin/dogfood-substrate — substrate boot diagnostic page.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24.
 *
 * Composes the substrate-status JSON endpoint with the per-harness
 * claim-attempts stats. Useful for verifying:
 *
 *   1. The substrate is up (top badge — it always boots as of Stage 4d).
 *   2. Each expected harness successfully booted (rows below).
 *   3. The claim-audit table has rows for each harness (won/lost/error).
 *
 * Server-rendered: every metric is fetched on render via the in-process
 * sql + loaders so the page is always fresh and never depends on a
 * separate client-side fetch.
 */

import { getOrgPg } from '@papercusp/db-org';
import { term } from '@papercusp/operator-core/lib/lexicon';
import { listBootedHandles } from '@papercusp/operator-core/lib/sync/hyperbee/boot-all';
import { listBootstrapProgress } from '@papercusp/operator-core/lib/sync/hyperbee/bootstrap-progress';
import { listBootHistory } from '@papercusp/operator-core/lib/sync/hyperbee/boot-history';
import { loadClaimAttemptStats } from '@papercusp/operator-core/lib/orchestrator/load-claim-attempts';
import { assessHarnessSubstrateHealth } from '@papercusp/operator-core/lib/sync/hyperbee/health';
import { summariseWorkspaceSubstrate } from '@papercusp/operator-core/lib/sync/hyperbee/summary';
import { SubstrateStatusBadge } from '../../harness/insights/SubstrateStatusBadge';
import { ClaimAttemptStatsPill } from '../../harness/insights/ClaimAttemptStatsPill';
import { BootstrapProgressIndicator } from '../../harness/insights/BootstrapProgressIndicator';
import { SubstrateHealthPill } from '../../harness/insights/SubstrateHealthPill';
import { BootHistoryTable } from '../../harness/insights/BootHistoryTable';

export const dynamic = 'force-dynamic';

const PAGE_STYLE = {
  padding: '32px max(24px, calc((100% - 960px) / 2))',
  fontFamily: 'inherit',
  color: 'var(--fg, #ddd)',
} as const;

const HEADER_ROW = {
  display: 'flex',
  alignItems: 'center',
  gap: 16,
  marginBottom: 24,
} as const;

const TITLE = {
  fontSize: 22,
  fontWeight: 600,
} as const;

const GRID = {
  display: 'grid',
  gridTemplateColumns: 'minmax(120px, 1fr) minmax(120px, 1fr) minmax(160px, 1.3fr) minmax(140px, 1fr) minmax(140px, 1fr)',
  fontSize: 13,
  overflowX: 'auto' as const,
};

const GRID_HEADER = {
  borderBottom: '1px solid var(--border, #2a2a2a)',
  padding: '8px 12px',
  fontWeight: 600,
  color: 'var(--fg-dim, #888)',
  fontSize: 11,
  textTransform: 'uppercase' as const,
};

const GRID_CELL = {
  padding: '10px 12px',
  borderBottom: '1px solid var(--border-subtle, #222)',
};

const EMPTY = {
  fontSize: 13,
  color: 'var(--fg-dim, #888)',
  padding: '24px 0',
};

export default async function DogfoodSubstratePage() {
  // Stage 4d: the substrate always boots (the opt-in gate was removed).
  const enabled = true;
  const booted = listBootedHandles();
  const { sql } = getOrgPg();
  const runQuery = async <T,>(
    query: string,
    paramsArr: unknown[],
  ): Promise<T[]> => {
    return (await sql.unsafe(query, paramsArr as never)) as unknown as T[];
  };
  const statsBySlug = new Map<string, Awaited<ReturnType<typeof loadClaimAttemptStats>>>();
  await Promise.all(
    booted.map(async (h) => {
      const stats = await loadClaimAttemptStats({
        workspace_id: h.workspaceId,
        harness_slug: h.harnessSlug,
        runQuery,
      });
      statsBySlug.set(`${h.workspaceId}::${h.harnessSlug}`, stats);
    }),
  );

  const progressBySlug = new Map<
    string,
    ReturnType<typeof listBootstrapProgress>[number]
  >();
  for (const snap of listBootstrapProgress()) {
    progressBySlug.set(`${snap.workspaceId}::${snap.harnessSlug}`, snap);
  }

  const topStatus = !enabled ? 'disabled' : booted.length > 0 ? 'booted' : 'booting';
  const hint = !enabled
    ? null
    : booted.length > 0
      ? `${booted.length} ${term('pot', { count: booted.length })}`
      : null;

  // Compute the workspace-level health summary for the top bar.
  const healthRows = booted.map((h) => {
    const key = `${h.workspaceId}::${h.harnessSlug}`;
    const stats = statsBySlug.get(key);
    const progress = progressBySlug.get(key);
    const { verdict } = assessHarnessSubstrateHealth({
      flagEnabled: enabled,
      handlePresent: true,
      claimStats: stats,
      bootstrapProgress: progress ?? null,
    });
    return {
      workspaceId: h.workspaceId,
      harnessSlug: h.harnessSlug,
      verdict,
    };
  });
  const summary = summariseWorkspaceSubstrate(enabled, healthRows);

  return (
    <div style={PAGE_STYLE} data-testid="dogfood-substrate-page">
      <div style={HEADER_ROW}>
        <span style={TITLE}>Substrate diagnostic</span>
        <SubstrateStatusBadge status={topStatus} hint={hint} />
        {summary.totalHarnesses > 0 ? (
          <SubstrateHealthPill
            verdict={summary.worstVerdict}
            reasons={[
              `${summary.healthy}✓ ${summary.booting}⏳ ${summary.degraded}! ${summary.unhealthy}✗`,
            ]}
          />
        ) : null}
      </div>

      <p
        style={{
          fontSize: 13,
          color: 'var(--fg-dim, #888)',
          marginBottom: 16,
        }}
      >
        Model B sync substrate boot state for the local process. The substrate
        always boots; PG remains the canonical store and each{' '}
        {term('pot', { lower: true })} federates over its own per-peer log when
        shared.
      </p>

      {booted.length === 0 ? (
        <div style={EMPTY}>
          No {term('pot', { plural: true, lower: true })} have booted yet. Watch
          this page; the orchestrator boots each {term('pot', { lower: true })} on
          its own.
        </div>
      ) : (
        <div style={GRID} data-testid="dogfood-substrate-table" role="grid">
          <div style={GRID_HEADER} role="columnheader">Workspace</div>
          <div style={GRID_HEADER} role="columnheader">{term('pot')}</div>
          <div style={GRID_HEADER} role="columnheader">Health</div>
          <div style={GRID_HEADER} role="columnheader">Bootstrap</div>
          <div style={GRID_HEADER} role="columnheader">Claim audit</div>
          {booted.map((h) => {
            const key = `${h.workspaceId}::${h.harnessSlug}`;
            const stats = statsBySlug.get(key);
            const progress = progressBySlug.get(key);
            const health = assessHarnessSubstrateHealth({
              flagEnabled: enabled,
              handlePresent: true,
              claimStats: stats,
              bootstrapProgress: progress ?? null,
            });
            return (
              <div
                key={key}
                data-testid={`dogfood-substrate-row-${h.harnessSlug}`}
                role="row"
                style={{ display: 'contents' }}
              >
                <div style={GRID_CELL} role="gridcell">
                  <code>{h.workspaceId}</code>
                </div>
                <div style={GRID_CELL} role="gridcell">
                  <code>{h.harnessSlug}</code>
                </div>
                <div style={GRID_CELL} role="gridcell">
                  <SubstrateHealthPill
                    verdict={health.verdict}
                    reasons={health.reasons}
                  />
                </div>
                <div style={GRID_CELL} role="gridcell">
                  {progress ? (
                    <BootstrapProgressIndicator
                      totalOps={Math.max(
                        progress.highestSeen,
                        progress.mergedOps,
                      )}
                      mergedOps={progress.mergedOps}
                    />
                  ) : (
                    <span style={{ color: 'var(--fg-dim, #888)' }}>—</span>
                  )}
                </div>
                <div style={GRID_CELL} role="gridcell">
                  {stats && stats.total > 0 ? (
                    <ClaimAttemptStatsPill
                      total={stats.total}
                      won={stats.won}
                      lost={stats.lost}
                      error={stats.error}
                    />
                  ) : (
                    <span style={{ color: 'var(--fg-dim, #888)' }}>—</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ marginTop: 28 }}>
        <h2
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--fg-dim, #888)',
            textTransform: 'uppercase',
            marginBottom: 8,
          }}
        >
          Boot history
        </h2>
        <BootHistoryTable entries={listBootHistory({ limit: 50 })} />
      </div>
    </div>
  );
}
