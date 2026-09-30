import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';
import AdminShell from '../../components/admin/AdminShell';
import { SubstrateSummaryCardClient } from '@/app/harness/insights/SubstrateSummaryCardClient';
import { BootHistoryTableClient } from '@/app/harness/insights/BootHistoryTableClient';
import { SubstrateHealthPill } from '@/app/harness/insights/SubstrateHealthPill';
import { ClaimAttemptTimelineClient } from '@/app/harness/insights/ClaimAttemptTimelineClient';
import { Select } from '@/app/harness/Select';
import { useLexicon } from '@/lib/useLexicon';

/**
 * /admin/dogfood-substrate — Vite-side mirror of the SSR diagnostic
 * page at `apps/operator/app/admin/dogfood-substrate/page.tsx`.
 *
 * The operator-vite SPA owns admin routes for the live Tauri shell,
 * so the SSR version is unreachable until this route exists.
 *
 * Uses the client wrappers shipped in apps/operator/app/harness/insights/
 * — they self-fetch /api/admin/dogfood-substrate-* so the route is
 * a thin composition.
 */

export const Route = createFileRoute('/admin/dogfood-substrate')({
  component: DogfoodSubstratePage,
});

interface HealthResponse {
  summary?: {
    enabled: boolean;
    totalHarnesses: number;
    healthy: number;
    booting: number;
    degraded: number;
    unhealthy: number;
    disabled: number;
    worstVerdict: 'disabled' | 'booting' | 'healthy' | 'degraded' | 'unhealthy';
  };
  harnesses?: Array<{
    workspaceId: string;
    harnessSlug: string;
    verdict: 'disabled' | 'booting' | 'healthy' | 'degraded' | 'unhealthy';
    reasons?: string[];
  }>;
}

type SubstrateHarnessRow = NonNullable<HealthResponse['harnesses']>[number];

function DogfoodSubstratePage() {
  // Active brand-pack term resolver (the-hive-lexicon). Reactive to the flag.
  const t = useLexicon();
  const [resp, setResp] = useState<HealthResponse | null>(null);
  const [pickedSlug, setPickedSlug] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const r = await fetch('/api/admin/dogfood-substrate-health', { cache: 'no-store' });
        if (!r.ok) return;
        const json = (await r.json()) as HealthResponse;
        if (!cancelled) setResp(json);
      } catch {
        // hold last-known
      }
    };
    void run();
    const t = setInterval(() => void run(), 10_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const rows =
    (resp?.harnesses ?? []).filter(
      (h) => h.workspaceId !== '' && h.harnessSlug !== '',
    );
  const columns: ColumnDef<SubstrateHarnessRow>[] = [
    {
      key: 'workspace',
      header: 'Workspace',
      width: 2,
      toCopyText: (row) => row.workspaceId,
      render: ({ row }) => <code>{row.workspaceId}</code>,
    },
    {
      key: 'harness',
      header: t('pot'),
      width: 2,
      toCopyText: (row) => row.harnessSlug,
      render: ({ row }) => <code>{row.harnessSlug}</code>,
    },
    {
      key: 'health',
      header: 'Health',
      width: 1.4,
      toCopyText: (row) => row.verdict,
      render: ({ row }) => <SubstrateHealthPill verdict={row.verdict} reasons={row.reasons} />,
    },
  ];

  return (
    <AdminShell title="Substrate diagnostic">
      <div style={{ padding: '16px max(24px, calc((100% - 960px) / 2))', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <SubstrateSummaryCardClient diagnosticHref={undefined} />

        <p style={{ fontSize: 13, color: 'var(--fg-dim, #888)', margin: 0 }}>
          Hyperbee substrate boot state for this operator process. The substrate
          always boots — each shared harness joins its swarm in-process.
        </p>

        {rows.length === 0 ? (
          <div style={{ padding: 16, fontSize: 13, color: 'var(--fg-dim, #888)' }} data-testid="dogfood-substrate-empty">
            No shared {t('pot', { plural: true, lower: true })} booted yet.
          </div>
        ) : (
          <div data-testid="dogfood-substrate-table">
            <RichGrid<SubstrateHarnessRow>
              rows={rows}
              columns={columns}
              getRowId={(row) => `${row.workspaceId}::${row.harnessSlug}`}
              rowProps={({ row }) => ({ 'data-testid': `dogfood-substrate-row-${row.harnessSlug}` })}
              rowMinHeight={32}
            />
          </div>
        )}

        <section style={{ marginTop: 12 }} data-testid="dogfood-substrate-boot-history-section">
          <h2 style={{ fontSize: 11, fontWeight: 600, color: 'var(--fg-dim, #888)', textTransform: 'uppercase', marginBottom: 8 }}>
            Boot history
          </h2>
          <BootHistoryTableClient limit={50} />
        </section>

        <section style={{ marginTop: 12 }} data-testid="dogfood-substrate-claim-attempts-section">
          <h2 style={{ fontSize: 11, fontWeight: 600, color: 'var(--fg-dim, #888)', textTransform: 'uppercase', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 12 }}>
            Claim attempts
            {rows.length > 0 && (
              <Select
                testId="claim-attempts-harness-picker"
                value={pickedSlug || rows[0].harnessSlug}
                onChange={setPickedSlug}
                options={rows.map((h) => ({ value: h.harnessSlug, label: h.harnessSlug }))}
                ariaLabel="Claim-attempt harness picker"
                triggerStyle={{ fontSize: 11, fontWeight: 400, minHeight: 24, padding: '2px 6px', textTransform: 'none' }}
              />
            )}
          </h2>
          {rows.length > 0 ? (
            <ClaimAttemptTimelineClient slug={pickedSlug || rows[0].harnessSlug} limit={50} />
          ) : (
            <div style={{ padding: 12, fontSize: 12, color: 'var(--fg-dim, #888)' }}>
              No {t('pot', { plural: true, lower: true })} booted — claim attempts only record under a booted substrate.
            </div>
          )}
        </section>
      </div>
    </AdminShell>
  );
}
