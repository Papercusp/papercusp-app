'use client';

import React, { useState } from 'react';
import { useQueryState, parseAsString } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { toast } from 'sonner';
import type { PrViewerDetails } from '@papercusp/operator-core/lib/pr-host/pr-viewer';
import { ReportPanel } from './PrRow';
import { COLORS, RADIUS } from './theme';
import { Select } from './Select';

type Action = 'merge' | 'close' | 'send-green';

export function PrDetails({ harnessSlug, number, onChanged }: {
  harnessSlug: string; number: number; onChanged: () => void;
}) {
  const query = useSyncQuery<PrViewerDetails>({
    queryName: 'harnessPrs.detail', args: { harnessSlug, number },
  });
  const [selectedFile, setSelectedFile] = useQueryState('prs_file', parseAsString);
  const [busy, setBusy] = useState<Action | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const details = query.data?.[0];

  async function act(action: Action) {
    if (busy) return;
    setBusy(action);
    setOutcome(null);
    try {
      const response = await fetch(`/api/harness/${encodeURIComponent(harnessSlug)}/prs/${number}/action`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }),
      });
      const result = await response.json() as { action?: string; detail?: string; error?: string };
      if (!response.ok || result.error) throw new Error(result.error ?? `HTTP ${response.status}`);
      if (!result.action) throw new Error('The action returned no confirmed outcome. Refresh the PR.');
      const message = result.detail ?? `PR action: ${result.action}.`;
      setOutcome(message);
      if (result.action === 'merged' || result.action === 'closed' || result.action === 'sent') toast.success(message);
      else if (result.action === 'error' || result.action === 'refused') toast.error(message);
      else toast(message);
    } catch (error) {
      const message = String(error);
      setOutcome(message);
      toast.error(message);
    } finally {
      query.invalidate();
      onChanged();
      setBusy(null);
    }
  }

  if (query.error) return <div role="alert">Could not load PR details: {query.error.message} <button onClick={query.invalidate}>Retry details</button></div>;
  if (query.loading) return <div role="status">Loading PR details…</div>;
  if (!details) return <div role="status">No PR details available. <button onClick={query.invalidate}>Retry details</button></div>;
  const { pr } = details;
  const file = details.files.find(f => f.filename === selectedFile);
  const cannotMerge = pr.state !== 'open' || pr.mergeable_state === 'not_mergeable' ||
    (details.standing && ['running', 'fail', 'unavailable'].includes(details.mergeTestStatus));
  const mergeLabel = details.standing
    ? details.mergeTestStatus === 'pass' ? 'Merge tested commit' : details.mergeTestStatus === 'stale' ? 'Retest and merge' : 'Test and merge'
    : 'Merge PR';
  const buttonStyle: React.CSSProperties = { padding: '4px 8px', border: `1px solid ${COLORS.border}`,
    borderRadius: RADIUS.sm, background: 'transparent', color: COLORS.text };

  return <section aria-label={`PR #${number} details`} data-pr-details={number} style={{ display: 'grid', gap: 12,
    color: COLORS.text, fontSize: 12, minWidth: 0 }}>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <strong>{pr.state} · {pr.mergeable_state}</strong>
      <a href={pr.url} target="_blank" rel="noopener noreferrer" style={{ color: COLORS.accent }}>Open on GitHub</a>
      <button style={buttonStyle} onClick={query.invalidate}>Refresh details</button>
      {details.permissions.review && <button style={buttonStyle} disabled={!!busy || cannotMerge} onClick={() => void act('merge')}>{mergeLabel}</button>}
      {details.permissions.close && <button style={buttonStyle} disabled={!!busy || pr.state !== 'open'} onClick={() => void act('close')}>Close PR</button>}
      {details.permissions.sendGreen && <button style={buttonStyle} disabled={!!busy} onClick={() => void act('send-green')}>Send what’s green now</button>}
      {busy && <span role="status">{busy === 'merge' ? 'Checking merge…' : 'Submitting…'}</span>}
    </div>
    {outcome && <div role="status">{outcome}</div>}
    <div style={{ overflowWrap: 'anywhere' }}>
      <div>PR head: <code>{pr.head_sha}</code></div>
      <div>Target branch: {pr.base_ref} · <code>{details.targetSha}</code></div>
      {details.standing && <div aria-label="Exact merge test">
        <strong>Full suite on merge result: {details.mergeTestStatus}</strong>
        {details.mergeTest && <div>Tested merge commit: <code>{details.mergeTest.mergeSha}</code></div>}
        {details.mergeTestStatus === 'stale' && <div>The head or target changed. The merge result must be tested again.</div>}
        {details.mergeBlocker && <div>{details.mergeBlocker}</div>}
      </div>}
      {!details.standing && details.mergeBlocker && <div>{details.mergeBlocker}</div>}
    </div>
    <section aria-label="PR checks"><strong>Checks: {pr.checks_state}</strong>
      {details.checks.length ? <ul>{details.checks.map((check, i) => <li key={`${check.name}:${i}`}>
        {check.url ? <a href={check.url} target="_blank" rel="noopener noreferrer" style={{ color: COLORS.accent }}>{check.name}</a> : check.name}
        {' — '}{check.conclusion ?? check.status}
      </li>)}</ul> : <div>No check runs reported.</div>}
    </section>
    <section aria-label="Reviewer report"><strong>Reviewer report · {pr.review_decision}</strong>
      {details.row.report ? <><div>{details.row.report.stale ? 'Report is from an earlier commit.' : 'Report matches the current head.'}</div><ReportPanel report={details.row.report} /></>
        : <div>No reviewer report yet.</div>}
    </section>
    <section aria-label="PR commits"><strong>Commits ({details.commits.length})</strong>
      <ul>{details.commits.map(commit => <li key={commit.sha} style={{ overflowWrap: 'anywhere' }}>
        <a href={commit.url} target="_blank" rel="noopener noreferrer" style={{ color: COLORS.accent }}><code>{commit.sha.slice(0, 12)}</code></a>
        {' '}{commit.message} · {commit.author}
      </li>)}</ul>
    </section>
    <section aria-label="Changed files" style={{ minWidth: 0 }}>
      <div><strong>Changed files ({details.files.length})</strong>{' '}
        <Select
          ariaLabel="File diff"
          value={file ? `file:${file.filename}` : 'all'}
          onChange={next => void setSelectedFile(next === 'all' ? null : next.slice('file:'.length))}
          options={[
            { value: 'all', label: 'All changes' },
            ...details.files.map(f => ({ value: `file:${f.filename}`, label: `${f.filename} · ${f.status} +${f.additions} −${f.deletions}` })),
          ]}
          triggerStyle={{ maxWidth: '100%' }}
        />
      </div>
      {file?.previous_filename && <div>Renamed from {file.previous_filename}</div>}
      {details.diffTruncated && <div>The combined diff is truncated. Open on GitHub for the complete diff.</div>}
      <pre aria-label="PR diff" style={{ maxHeight: 360, overflow: 'auto', whiteSpace: 'pre', padding: 8,
        border: `1px solid ${COLORS.border}`, borderRadius: RADIUS.sm, fontSize: 11 }}>
        {file ? file.patch ?? 'GitHub did not provide a patch for this file. Open on GitHub to inspect it.' : details.diff || 'No diff reported.'}
      </pre>
    </section>
  </section>;
}
