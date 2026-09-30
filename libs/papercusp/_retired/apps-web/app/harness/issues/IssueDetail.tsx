'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { Drawer } from 'vaul';
import { X, ArrowUpRight, MessageSquarePlus } from 'lucide-react';
import { toast } from 'sonner';
import type { Issue } from './types';
import { useSyncQuery } from '@papercusp/sync';
import { KbdHint, RolePill } from '../primitives';
import { HarnessMarkdownView } from '../HarnessMarkdownView';

const FeatureTimelinePanel = dynamic(() => import('../FeatureTimelinePanel'), { ssr: false });

interface IssueAgentRun {
  harnessSlug: string;
  runId: string;
  role: string;
  featureId?: string | null;
  ts: number;
}

async function call(slug: string, id: string, action: string, body: any) {
  const res = await fetch(`/api/harness/${slug}/issues/${id}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export function IssueDetail({
  slug, issue, onClose, onChange,
}: {
  slug: string;
  issue: Issue;
  onClose: () => void;
  onChange: (next: Issue) => void;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [showTimeline, setShowTimeline] = useState(false);
  const { data: agentRows } = useSyncQuery<IssueAgentRun>({
    queryName: 'agentRunsConsolidated.bySlug',
    args: { harnessSlug: slug },
    enabled: !!slug,
  });
  const recentIssueRuns = Array.isArray(agentRows) && issue.linkedFeatureId
    ? agentRows.filter((r) => r.featureId === issue.linkedFeatureId).slice(0, 8)
    : [];


  const addNote = async () => {
    if (!note.trim()) return;
    setBusy(true);
    try {
      const next = await call(slug, issue.id, 'update', { note, by: 'human' });
      onChange(next);
      setNote('');
    } catch (e: any) { toast.error(`Add note failed: ${e.message ?? e}`); }
    finally { setBusy(false); }
  };

  return (
    <>
    <Drawer.Root open onOpenChange={(o) => { if (!o) onClose(); }} direction="right">
      <Drawer.Portal>
        <Drawer.Overlay
          className="h-issue-detail-overlay"
          data-anim="fade"
          style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(0,0,0,0.65)' }}
        />
        <Drawer.Content
          className="h-issue-detail-drawer"
          data-anim="slide-right"
          aria-describedby={undefined}
          aria-modal="true"
          style={{
            position: 'fixed', top: 0, right: 0, bottom: 0,
            width: 'min(720px, 72vw)',
            background: '#17131f', borderLeft: '1px solid var(--border)',
            display: 'flex', flexDirection: 'column',
            zIndex: 81, outline: 'none',
          }}
        >
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px',
          borderBottom: '1px solid var(--border)', flexShrink: 0,
          background: '#17131f',
        }}>
          <span className="h-drawer-topbar-label">Issue detail</span>
          <button
            type="button"
            className="h-btn-icon"
            onClick={onClose}
            aria-label="Close issue details"
            title="Close (Esc)"
            style={{ marginLeft: 'auto' }}
          >
            <X size={14} />
          </button>
        </div>

        <div className="h-drawer-body" style={{ flex: 1, overflow: 'auto', padding: '16px 18px', background: '#17131f' }}>
          <div className="h-drawer-title-card" style={{
            marginBottom: 16,
            padding: '14px 14px 12px',
            border: '1px solid var(--border)',
            borderRadius: 14,
            background: '#1d1826',
            boxShadow: '0 16px 34px rgba(0,0,0,0.28), inset 0 1px 0 rgba(255,255,255,0.02)',
          }}>
            <div className="h-drawer-eyebrow" aria-label={`Issue ${issue.id}, severity ${issue.severity}, status ${issue.status}${issue.linkedFeatureId ? `, linked feature ${issue.linkedFeatureId}` : ''}`} style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
              marginBottom: 10,
            }}>
              <span>Issue</span>
              <span aria-hidden>·</span>
              <span className="h-issue-id">{issue.id}</span>
              <span className="h-drawer-eyebrow-separator" aria-hidden="true">·</span>
              <span className={`h-issue-sev sev-${issue.severity}`}>{issue.severity}</span>
              <span className="h-drawer-eyebrow-separator" aria-hidden="true">·</span>
              <span className={`h-issue-status st-${issue.status}`}>{issue.status}</span>
              {issue.linkedFeatureId && <span className="h-drawer-eyebrow-separator" aria-hidden="true">·</span>}
              {issue.linkedFeatureId && (
                <span className="h-issue-linked"><ArrowUpRight size={11} /> {issue.linkedFeatureId}</span>
              )}
            </div>
            <Drawer.Title style={{ fontSize: 17, fontWeight: 700, margin: '0 0 10px', color: 'var(--fg)', lineHeight: 1.35 }}>
              {issue.title}
            </Drawer.Title>
            <div className="h-drawer-meta-strip" aria-label={`${issue.source === 'human' ? 'filed by human' : `found by ${issue.source}`}${issue.foundDuring ? ` during ${issue.foundDuring}` : ''}; ${new Date(issue.foundAt).toLocaleString()}${typeof issue.attempts === 'number' ? `; ${issue.attempts} fix attempt${issue.attempts === 1 ? '' : 's'}` : ''}${issue.codePointer ? `; ${issue.codePointer}` : ''}`} style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
              <span>{issue.source === 'human' ? 'filed by human' : `found by ${issue.source}`}</span>
              {issue.foundDuring && <span>during {issue.foundDuring}</span>}
              <span>{new Date(issue.foundAt).toLocaleString()}</span>
              {typeof issue.attempts === 'number' && <span>{issue.attempts} fix attempt{issue.attempts === 1 ? '' : 's'}</span>}
              {issue.codePointer && <code style={{ color: 'var(--counter)' }}>{issue.codePointer}</code>}
            </div>
          </div>

          {issue.evidence && (
            <Section title="Evidence">
              <HarnessMarkdownView value={issue.evidence} className="h-issue-markdown" />
            </Section>
          )}
          {issue.repro && (
            <Section title="Reproduction">
              <HarnessMarkdownView value={issue.repro} className="h-issue-markdown" />
            </Section>
          )}
          {issue.suggestedFix && (
            <Section title="Suggested fix">
              <HarnessMarkdownView value={issue.suggestedFix} className="h-issue-markdown" />
            </Section>
          )}

          {issue.notes.length > 0 && (
            <Section title="Notes">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {issue.notes.map((n, i) => (
                  <div key={i} style={{ fontSize: 12, color: 'var(--fg)', borderLeft: '2px solid var(--border)', paddingLeft: 10 }}>
                    <div style={{ fontSize: 10, color: 'var(--fg-dim)', marginBottom: 2 }}>
                      {n.by} · {new Date(n.ts).toLocaleString()}
                    </div>
                    <HarnessMarkdownView value={n.text} className="h-note-markdown" emptyLabel="No note content." />
                  </div>
                ))}
              </div>
            </Section>
          )}

          <Section title={`Recent agent runs${recentIssueRuns.length ? ` · ${recentIssueRuns.length}` : ''}`}>
            {recentIssueRuns.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--fg-dim)', fontStyle: 'italic' }}>
                {issue.linkedFeatureId ? 'No runs linked to this issue yet.' : 'No linked feature yet, so runs cannot be correlated.'}
              </div>
            ) : (
              <div className="h-feature-run-list" role="list" aria-label="Recent issue agent runs" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {recentIssueRuns.map((r) => {
                  const runLabel = displayRunId(r);
                  const runTime = formatRunTs(r.ts);
                  return (
                    <div
                      key={r.runId}
                      className="h-feature-run-row"
                      role="listitem"
                      aria-label={`${r.role || 'unknown'} run ${runLabel} at ${runTime}.`}
                      style={{
                        display: 'grid',
                        alignItems: 'center',
                        gap: 8,
                        gridTemplateColumns: 'minmax(7.5rem, auto) auto auto minmax(0, 1fr)',
                        padding: '6px 8px',
                        background: '#201a2a',
                        border: '1px solid var(--border)',
                        borderRadius: 4,
                        color: 'var(--fg)',
                        fontSize: 12,
                        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.02)',
                      }}
                    >
                      <RolePill role={r.role} />
                      <span style={{ color: 'var(--fg-dim)', fontSize: 11 }}>{runTime}</span>
                      <span aria-hidden style={{ color: 'var(--fg-dim)' }}>·</span>
                      <code style={{ color: 'var(--fg-dim)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {runLabel}
                      </code>
                    </div>
                  );
                })}
              </div>
            )}
          </Section>
        </div>

        <div className="h-drawer-footer h-issue-detail-footer" style={{
          borderTop: '1px solid var(--border)', padding: '10px 16px',
          display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', flexShrink: 0,
          background: '#17131f',
          boxShadow: '0 -12px 28px rgba(0,0,0,0.18)',
        }}>
          <button
            type="button"
            className="h-btn ghost"
            disabled={!issue.linkedFeatureId}
            onClick={() => setShowTimeline(true)}
            title={issue.linkedFeatureId ? `View timeline for ${issue.linkedFeatureId}` : 'Link this issue to a feature before viewing a timeline'}
          >
            View timeline
          </button>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addNote(); }}
            placeholder="Add a note…"
            style={{
              flex: 1, background: 'var(--bg-3)', color: 'var(--fg)',
              border: '1px solid var(--border)', borderRadius: 5,
              padding: '6px 10px', fontSize: 12, outline: 'none',
            }}
          />
          <button className="h-btn ghost" disabled={busy || !note.trim()} onClick={addNote}>
            <MessageSquarePlus size={13} /> Add note
          </button>
          <span className="h-drawer-footer-hint" style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--fg-dim)' }}>
            <KbdHint>Esc</KbdHint> close
          </span>
        </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
    {showTimeline && issue.linkedFeatureId && (
      <FeatureTimelinePanel
        slug={slug}
        featureId={issue.linkedFeatureId}
        onClose={() => setShowTimeline(false)}
      />
    )}
    </>
  );
}

function displayRunId(run: { runId: string; role?: string | null }): string {
  const role = run.role?.trim();
  let label = run.runId.replace(/\.log$/i, '').trim();
  if (role) {
    label = label.replace(new RegExp(`^[-_]?${escapeRegExp(role)}[-_]?`, 'i'), '');
  }
  label = label.replace(/^[-_]+/, '').trim();
  if (!label) label = run.runId.replace(/\.log$/i, '').trim() || 'run';
  return label.length > 28 ? `…${label.slice(-27)}` : label;
}

function formatRunTs(ts: number): string {
  const millis = ts > 0 && ts < 10_000_000_000 ? ts * 1000 : ts;
  return new Date(millis).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="h-drawer-section" style={{
      marginBottom: 14,
      padding: '11px 12px 10px',
      border: '1px solid var(--border)',
      borderRadius: 12,
      background: '#1c1824',
      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.02)',
    }}>
      <div className="h-drawer-section-title" style={{
        fontSize: 10, fontWeight: 600, letterSpacing: 0.7,
        textTransform: 'uppercase', color: 'var(--fg-dim)', marginBottom: 8,
      }}>{title}</div>
      {children}
    </div>
  );
}
