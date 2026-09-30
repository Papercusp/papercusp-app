'use client';

import { useCallback, useEffect, useState } from 'react';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';
import { Checkbox } from '@/app/harness/Checkbox';
import { statusToneColor } from '@/app/harness/theme';
import { useSyncQuery } from '@papercusp/sync';
import { useWorkspaceId } from '@/lib/use-workspace-id';

/**
 * <AcceptancePanel> — the harness Tests tab's "Acceptance" (Project) view.
 *
 * P-062 / P-063 of harness-tests-tab-and-tester-promotion-2026-05-26. Lists
 * the VAL assertions (`harness_plan_assertions`) for the harness with their
 * status, and lets a human flip `requires_test` per VAL — turning it off for
 * non-testable claims (copy, design-spec, judgement) so the tester/validator
 * gate skips them. Mounted as the `acceptance` custom tab inside
 * <TestingShell> (the Built-in tier still renders via <DomainTestPanel>).
 *
 * Per-VAL covering-test rollup is Phase G; this view is VALs + status + the
 * requires_test toggle.
 */

interface Assertion {
  val_id: string;
  plan_slug: string;
  item_id: string;
  verify_text: string;
  status: string;
  requires_test: boolean;
}

const msg: React.CSSProperties = { padding: '16px 20px', color: 'var(--fg-mute, #7f9bb4)', fontSize: 13 };

export default function AcceptancePanel({ slug }: { slug: string }) {
  const base = `/api/harness/${encodeURIComponent(slug)}/testing`;
  const workspaceId = useWorkspaceId();
  const { data: assertionRows, loading: assertionsLoading, error: assertionsError, invalidate: invalidateAssertions } = useSyncQuery<Assertion>({
    queryName: 'testing.assertionsByHarness',
    args: { harnessSlug: slug, workspaceId },
    enabled: !!slug,
    staleTime: 30_000,
  });
  const [rows, setRows] = useState<Assertion[] | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    if (!assertionsLoading) setRows(assertionRows ?? []);
  }, [assertionRows, assertionsLoading]);

  const toggle = useCallback(
    async (a: Assertion) => {
      const next = !a.requires_test;
      setSaving(a.val_id);
      setRows((cur) => cur?.map((x) => (x.val_id === a.val_id ? { ...x, requires_test: next } : x)) ?? cur);
      try {
        const r = await fetch(`${base}/assertions/${encodeURIComponent(a.val_id)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requires_test: next }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        invalidateAssertions();
      } catch {
        // Revert the optimistic flip on failure.
        setRows((cur) => cur?.map((x) => (x.val_id === a.val_id ? { ...x, requires_test: a.requires_test } : x)) ?? cur);
      } finally {
        setSaving(null);
      }
    },
    [base, invalidateAssertions],
  );

  if (assertionsError) return <div style={msg}>Could not load acceptance criteria: {assertionsError.message}</div>;
  if (!rows) return <div style={msg}>Loading acceptance criteria…</div>;
  if (rows.length === 0) {
    return (
      <div style={msg}>
        No VAL assertions yet — promote a plan with inline <code>[VAL-…]</code> bullets to populate the
        acceptance contract.
      </div>
    );
  }

  const columns: ColumnDef<Assertion>[] = [
    {
      key: 'val',
      header: 'VAL',
      width: 1,
      toCopyText: (a) => a.val_id,
      render: ({ row }) => <span style={{ fontFamily: 'ui-monospace, monospace', whiteSpace: 'nowrap' }}>{row.val_id}</span>,
    },
    { key: 'verify', header: 'Verify', width: 3, toCopyText: (a) => a.verify_text, render: ({ row }) => <span style={{ color: 'var(--fg-dim)' }}>{row.verify_text}</span> },
    {
      key: 'status',
      header: 'Status',
      width: 1,
      toCopyText: (a) => a.status,
      render: ({ row }) => <span style={{ color: statusToneColor(row.status), fontWeight: 700 }}>{row.status}</span>,
    },
    {
      key: 'requires',
      header: 'Requires test',
      width: 1.2,
      toCopyText: (a) => a.requires_test ? 'required' : 'exempt',
      render: ({ row }) => (
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <Checkbox
            checked={row.requires_test}
            disabled={saving === row.val_id}
            onChange={() => void toggle(row)}
          />
          <span style={{ fontSize: 12, color: 'var(--fg-mute)' }}>{row.requires_test ? 'required' : 'exempt'}</span>
        </label>
      ),
    },
  ];

  return (
    <div style={{ padding: '16px 20px' }}>
      <h3 style={{ margin: '0 0 4px', fontSize: 15 }}>Acceptance criteria</h3>
      <p style={{ margin: '0 0 16px', color: 'var(--fg-mute)', fontSize: 12 }}>
        VAL assertions from this harness's plans. Turn <strong>Requires test</strong> off for non-testable
        claims (copy, design-spec, judgement) — the tester / validator gate skips those.
      </p>
      <div style={{ height: Math.min(680, 32 + rows.length * 42 + 4) }}>
        <RichGrid<Assertion>
          columns={columns}
          rows={rows}
          getRowId={(a) => a.val_id}
          rowMinHeight={42}
          headerHeight={32}
        />
      </div>
    </div>
  );
}
