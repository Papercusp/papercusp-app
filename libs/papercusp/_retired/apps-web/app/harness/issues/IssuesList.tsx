'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertOctagon, AlertTriangle, Info, FileCode, User, Bot,
  ArrowUpRight, CheckCircle, XCircle, Loader2, Hammer, Inbox, Circle,
} from 'lucide-react';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';
import { useQuery } from '@rocicorp/zero/react';
import { queries, slugToIssuesKey, type IssueRow } from '@papercusp/zero-harness';
import type { Issue, IssueSeverity, IssueSource, IssueStatus } from './types';
import { IssueDetail } from './IssueDetail';
import { Tooltip } from '../Tooltip';

function rowToIssue(r: IssueRow): Issue {
  // PG TIMESTAMPTZ → zero-cache → number (epoch ms). Issue.foundAt is ISO
  // string for downstream display compat.
  const foundAtMs = typeof r.foundAt === 'number' ? r.foundAt : Date.parse(String(r.foundAt));
  return {
    id: r.issueId,
    title: r.title,
    severity: r.severity as IssueSeverity,
    source: r.source as IssueSource,
    status: r.status as IssueStatus,
    foundAt: Number.isFinite(foundAtMs) ? new Date(foundAtMs).toISOString() : '',
    foundDuring: r.foundDuring ?? undefined,
    repro: r.repro ?? undefined,
    evidence: r.evidence ?? undefined,
    suggestedFix: r.suggestedFix ?? undefined,
    codePointer: r.codePointer ?? undefined,
    linkedFeatureId: r.linkedFeatureId ?? undefined,
    attempts: Number(r.attempts) || 0,
    notes: Array.isArray(r.notes) ? (r.notes as Issue['notes']) : [],
  };
}

async function callIssue(slug: string, id: string, action: string, body: any) {
  const res = await fetch(`/api/harness/${slug}/issues/${id}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

const SEVERITY_CLASS: Record<IssueSeverity, string> = {
  critical: 'sev-critical',
  major: 'sev-major',
  minor: 'sev-minor',
  nit: 'sev-nit',
};
const SEVERITY_ICON: Record<IssueSeverity, typeof AlertOctagon> = {
  critical: AlertOctagon,
  major: AlertTriangle,
  minor: Info,
  nit: Info,
};

const STATUS_ICON: Record<IssueStatus, typeof CheckCircle> = {
  open: AlertTriangle,
  acknowledged: Info,
  fixing: Hammer,
  closed: CheckCircle,
  wontfix: XCircle,
};

const SOURCE_ICON: Record<IssueSource, typeof User> = {
  validator: Bot,
  worker: Bot,
  human: User,
};

export function IssuesList({ slug, onCount }: { slug: string; onCount?: (n: number) => void }) {
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [pending, setPending] = useState<Issue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'active' | 'closed'>('active');
  const [reloadTick, setReloadTick] = useState(0);
  const [triaging, setTriaging] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  // Issues stream live from Zero (`harness_<slug>.harness_issues` via
  // `useQuery`). The legacy `/api/harness/<slug>/issues-list` endpoint still
  // exists and dual-writes JSON↔PG, but reads come straight from the replica.
  // `pending` (validator findings awaiting curation) still lives in
  // `pending-issues.jsonl` and is fetched separately until that file is also
  // migrated to PG.
  const issuesQuery = useMemo(() => {
    if (!slug) return null;
    const ns = (queries as Record<string, { all?: () => unknown }>)[slugToIssuesKey(slug)];
    return ns?.all?.() ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);
  const [zeroRows, zeroInfo] = useQuery(
    (issuesQuery ?? (queries.issuesSheets.all() as unknown)) as never,
  );

  useEffect(() => {
    if (!issuesQuery) return;
    const info = zeroInfo as { type?: string } | undefined;
    if (info?.type !== 'complete') return;
    if (!Array.isArray(zeroRows)) return;
    const adapted = (zeroRows as IssueRow[]).map(rowToIssue);
    setIssues(adapted);
    setError(null);
  }, [issuesQuery, zeroRows, zeroInfo]);

  // Pending findings are file-system only; keep polling them.
  useEffect(() => {
    if (!slug) return;
    let aborted = false;
    const fetchPending = () => {
      fetch(`/api/harness/${slug}/issues-list`)
        .then((r) => r.json())
        .then((d) => {
          if (aborted) return;
          if (d.error) return;
          setPending(d.pending ?? []);
        })
        .catch(() => {});
    };
    fetchPending();
    const interval = setInterval(fetchPending, 5000);
    return () => { aborted = true; clearInterval(interval); };
  }, [slug, reloadTick]);

  useEffect(() => {
    onCount?.((issues?.length ?? 0) + pending.length);
  }, [issues, pending, onCount]);

  const runTriage = async () => {
    setTriaging(true);
    try {
      const res = await fetch(`/api/harness/${slug}/triage`, { method: 'POST' });
      const d = await res.json();
      if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
      toast.success(`Triage: +${d.merged} new, ${d.deduped} deduped`);
      setReloadTick((t) => t + 1);
    } catch (e: any) {
      toast.error(`Triage failed: ${e.message ?? e}`);
    } finally {
      setTriaging(false);
    }
  };

  const filtered = (issues ?? []).filter((i) => {
    if (filter === 'all') return true;
    if (filter === 'closed') return i.status === 'closed' || i.status === 'wontfix';
    return i.status !== 'closed' && i.status !== 'wontfix';
  });

  const selected = issues?.find((i) => i.id === selectedId);
  const activeCount = issues?.filter((i) => i.status !== 'closed' && i.status !== 'wontfix').length ?? 0;
  const closedCount = issues?.filter((i) => i.status === 'closed' || i.status === 'wontfix').length ?? 0;
  const openCount = issues?.filter((i) => i.status === 'open').length ?? 0;
  const fixingCount = issues?.filter((i) => i.status === 'fixing').length ?? 0;


  const runIssueAction = useCallback(async (row: Issue, action: 'promote' | 'acknowledge' | 'close' | 'wontfix') => {
    const key = `${row.id}:${action}`;
    setBusyAction(key);
    try {
      if (action === 'promote') {
        const res = await callIssue(slug, row.id, 'promote', {});
        const next = (res.issue ?? res) as Issue;
        setIssues((prev) => prev?.map((i) => (i.id === row.id ? next : i)) ?? null);
        if (next.linkedFeatureId) toast.success(`Promoted to ${next.linkedFeatureId}`);
        setReloadTick((t) => t + 1);
        return;
      }
      const status: IssueStatus = action === 'acknowledge' ? 'acknowledged' : action === 'close' ? 'closed' : 'wontfix';
      const next = (await callIssue(slug, row.id, 'update', { status })) as Issue;
      setIssues((prev) => prev?.map((i) => (i.id === row.id ? next : i)) ?? null);
    } catch (e: any) {
      toast.error(`Issue action failed: ${e.message ?? e}`);
    } finally {
      setBusyAction(null);
    }
  }, [slug]);

  const columns: ColumnDef<Issue>[] = useMemo(
    () => [
      {
        key: 'sev',
        header: 'sev',
        width: 0.52,
        render: ({ row }) => {
          const SevIcon = SEVERITY_ICON[row.severity] ?? Circle;
          return (
            <span className={`h-issue-sev ${SEVERITY_CLASS[row.severity]}`}>
              <SevIcon size={11} />
              {row.severity}
            </span>
          );
        },
      },
      {
        key: 'body',
        header: 'issue',
        width: 5.6,
        sortKey: 'title',
        render: ({ row }) => {
          const SrcIcon = SOURCE_ICON[row.source] ?? Circle;
          return (
            <div className="h-issue-body">
              <div className="h-issue-title" title={row.title}>
                {row.title}
              </div>
              <div className="h-issue-meta">
                <span className="h-issue-source"><SrcIcon size={10} /> {row.source}</span>
                <span className="h-issue-id">{row.id}</span>
                {row.foundDuring && <span className="h-issue-feat">found in {row.foundDuring}</span>}
                {row.codePointer && (
                  <span className="h-issue-code" title={row.codePointer}>
                    <FileCode size={10} /> {row.codePointer}
                  </span>
                )}
              </div>
            </div>
          );
        },
      },
      {
        key: 'right',
        header: '',
        width: 2.45,
        align: 'right',
        render: ({ row }) => {
          const StatusIcon = STATUS_ICON[row.status] ?? Circle;
          const isBusy = (action: string) => busyAction === `${row.id}:${action}`;
          return (
            <div className="h-issue-right" onClick={(e) => e.stopPropagation()}>
              <div className="h-issue-right-top">
                {row.linkedFeatureId && (
                  <span className="h-issue-linked" title={`Fix in progress: ${row.linkedFeatureId}`}>
                    <ArrowUpRight size={10} /> {row.linkedFeatureId}
                  </span>
                )}
                <span className={`h-issue-status st-${row.status}`}>
                  <StatusIcon size={10} className={row.status === 'fixing' ? 'h-spin' : ''} />
                  {row.status}
                </span>
              </div>
              <div className="h-issue-row-actions">
                {!row.linkedFeatureId && row.status !== 'closed' && row.status !== 'wontfix' && (
                  <Tooltip label="Promote this issue into a feature fix">
                    <button type="button" className="h-issue-row-action primary" disabled={isBusy('promote')} onClick={() => void runIssueAction(row, 'promote')}>promote</button>
                  </Tooltip>
                )}
                {row.status !== 'acknowledged' && row.status !== 'closed' && (
                  <Tooltip label="Acknowledge this issue without closing it">
                    <button type="button" className="h-issue-row-action" disabled={isBusy('acknowledge')} onClick={() => void runIssueAction(row, 'acknowledge')}>ack</button>
                  </Tooltip>
                )}
                {row.status !== 'closed' && (
                  <Tooltip label="Mark this issue closed">
                    <button type="button" className="h-issue-row-action success" disabled={isBusy('close')} onClick={() => void runIssueAction(row, 'close')}>close</button>
                  </Tooltip>
                )}
                {row.status !== 'wontfix' && (
                  <Tooltip label="Mark this issue as won't fix">
                    <button type="button" className="h-issue-row-action danger" disabled={isBusy('wontfix')} onClick={() => void runIssueAction(row, 'wontfix')}>won't fix</button>
                  </Tooltip>
                )}
              </div>
            </div>
          );
        },
      },
    ],
    [busyAction, runIssueAction],
  );

  // Preserve the legacy h-issue / h-issue-{severity} / h-issue-{status} row classes
  // so existing CSS (severity-tinted left border, status fade, hover bg) keeps applying.
  // The legacy .h-issue rule sets `display: grid` with its own auto/1fr/auto
  // column template, which fights RichGrid's inner CSS-grid cell layout
  // (and squashed the title+meta into column 1's auto width). Override with
  // `display: block` here so the inner grid fills full row width. The visual
  // styling (border, ::before accent bar, hover gradient) still applies.
  const richRowProps = useMemo(
    () => (ctx: { row: Issue }) => ({
      className: `h-issue h-issue-${ctx.row.severity} h-issue-${ctx.row.status}`,
      tabIndex: 0,
      'aria-label': `Open ${ctx.row.severity} ${ctx.row.status} issue ${ctx.row.id}: ${ctx.row.title}`,
      style: { display: 'block' } as const,
    }),
    [],
  );

  if (error) {
    return <div className="h-empty"><span style={{ color: 'var(--bad)' }}>{error}</span></div>;
  }
  if (!issues) {
    return <div className="h-empty"><Loader2 size={16} className="h-empty-icon h-spin" /><span>loading issues…</span></div>;
  }

  return (
    <>
      <div className="h-issues-toolbar" aria-label="Issue filters">
        <div className="h-issues-toolbar-main">
          {(['active', 'all', 'closed'] as const).map((f) => {
            const count = f === 'all' ? issues.length : f === 'closed' ? closedCount : activeCount;
            return (
              <button
                key={f}
                className={`h-chip h-issues-filter h-issues-filter--${f}${filter === f ? ' on' : ''}`}
                onClick={() => setFilter(f)}
                aria-pressed={filter === f}
              >
                <span>{f}</span>
                <strong>{count}</strong>
              </button>
            );
          })}
        </div>
        <div className="h-issues-toolbar-side">
          <span className="h-issue-mini-stat"><strong>{openCount}</strong> open</span>
          <span className="h-issue-mini-stat"><strong>{fixingCount}</strong> fixing</span>
          {pending.length > 0 && (
            <Tooltip label="Merge pending validator findings into the tracker">
              <button
                className="h-chip h-chip-pending"
                disabled={triaging}
                onClick={runTriage}
              >
                <Inbox size={10} />
                triage <strong>{pending.length}</strong>
              </button>
            </Tooltip>
          )}
        </div>
      </div>
      {pending.length > 0 && (
        <div className="h-pending-banner">
          <Inbox size={11} />
          {pending.length} pending validator finding{pending.length === 1 ? '' : 's'} — click triage to merge
        </div>
      )}
      {filtered.length === 0 ? (
        <div className="h-empty">
          <Info size={18} className="h-empty-icon" />
          <span>no {filter === 'all' ? '' : filter} issues</span>
        </div>
      ) : (
        <RichGrid<Issue>
          rows={filtered}
          columns={columns}
          getRowId={(i) => i.id}
          onRowClick={(i) => setSelectedId(i.id)}
          rowProps={richRowProps}
          inline
          rowMinHeight={58}
        />
      )}
      {selected && (
        <IssueDetail
          slug={slug}
          issue={selected}
          onClose={() => setSelectedId(null)}
          onChange={(next) => {
            setIssues((prev) => prev?.map((i) => (i.id === next.id ? next : i)) ?? null);
            if (next.linkedFeatureId) toast.success(`Promoted to ${next.linkedFeatureId}`);
          }}
        />
      )}
    </>
  );
}
