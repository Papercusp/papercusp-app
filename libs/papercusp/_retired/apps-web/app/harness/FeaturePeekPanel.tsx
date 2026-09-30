'use client';

import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { Drawer } from 'vaul';
import { X } from 'lucide-react';
import { COLORS, FONTS, RADIUS, SIZES, STATUS, HarnessStatus } from './theme';
import { StatusPill, IdPill, RolePill, KbdHint } from './primitives';
import { HarnessMarkdownView } from './HarnessMarkdownView';

const FeatureTimelinePanel = dynamic(() => import('./FeatureTimelinePanel'), { ssr: false });

interface Feature {
  id: string;
  title: string;
  claims?: string[];
  status: HarnessStatus;
  attempts: number;
  summary?: string;
}

interface AgentRun {
  runId: string;
  role: string;
  ts: number;
  sizeBytes: number;
  running?: boolean;
}

interface Props {
  slug: string;
  feature: Feature | null;
  agents: AgentRun[];
  issues: string;
  onClose: () => void;
  onReset: (id: string) => void;
  onEdit: (f: Feature) => void;
  onInspectRun: (runId: string) => void;
  onSetStatus: (id: string, status: HarnessStatus) => void;
  onOpenInPi?: (id: string) => void;
  /** Switch the harness UI to the pi tab (which hosts the dockview). */
  onSwitchToPi?: () => void;
}

export default function FeaturePeekPanel({
  slug, feature, agents, issues, onClose, onInspectRun, onSetStatus,
}: Props) {
  const [copied, setCopied] = useState(false);
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [debugNote, setDebugNote] = useState<string | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [showTimeline, setShowTimeline] = useState(false);

  // Fetch PR URL (if branchIsolation.onPass=pr has opened one for this feature).
  useEffect(() => {
    if (!feature) return;
    fetch(`/api/harness/${slug}/prs`)
      .then((r) => r.json())
      .then((d) => setPrUrl(d.prs?.[feature.id]?.url ?? null))
      .catch(() => setPrUrl(null));
  }, [slug, feature?.id]);

  // Fetch debug note (if debugger role has investigated this feature).
  useEffect(() => {
    if (!feature) { setDebugNote(null); setShowDebug(false); return; }
    fetch(`/api/harness/${slug}/debug-notes/${feature.id}`)
      .then((r) => r.json())
      .then((d) => setDebugNote(d.content ?? null))
      .catch(() => setDebugNote(null));
    setShowDebug(false);
  }, [slug, feature?.id]);

  // Filter issues.md excerpt to lines mentioning this feature id
  const issuesForFeature = useMemo(() => {
    if (!feature || !issues) return '';
    const lines = issues.split('\n');
    const re = new RegExp(feature.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    // Extract contiguous blocks containing the feature id
    const chunks: string[] = [];
    let current: string[] = [];
    let hit = false;
    for (const l of lines) {
      if (/^##\s/.test(l)) {
        if (hit && current.length) chunks.push(current.join('\n'));
        current = [l];
        hit = re.test(l);
      } else {
        current.push(l);
        if (!hit && re.test(l)) hit = true;
      }
    }
    if (hit && current.length) chunks.push(current.join('\n'));
    return chunks.join('\n\n').trim();
  }, [feature, issues]);

  // Find agent runs plausibly linked to this feature. Backend doesn't tag
  // runs with feature id yet, so we approximate: surrounding window of any
  // run in a state-transition period for this feature. For now just show
  // recent runs as "context."
  const recentRuns = useMemo(() => {
    if (!feature) return [];
    return agents.slice(0, 8);
  }, [feature, agents]);

  if (!feature) return null;

  const s = STATUS[feature.status];

  return (
    <Drawer.Root open={!!feature} onOpenChange={(o) => { if (!o) onClose(); }} direction="right">
      <Drawer.Portal>
        <Drawer.Overlay
          className="h-feature-peek-overlay"
          data-anim="fade"
          style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(0,0,0,0.65)' }}
        />
        <Drawer.Content
          className="h-feature-peek-drawer"
          data-anim="slide-right"
          aria-describedby={undefined}
          aria-modal="true"
          style={{
            position: 'fixed', top: 0, right: 0, bottom: 0,
            width: 'min(720px, 72vw)',
            background: '#17131f',
            borderLeft: '1px solid var(--border)',
            display: 'flex', flexDirection: 'column',
            overflow: 'hidden',
            zIndex: 81, outline: 'none',
          }}
        >
        {/* Header */}
        <div style={{
          padding: '12px 16px',
          borderBottom: `1px solid ${COLORS.border}` ,
          background: '#17131f',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexShrink: 0,
        }}>
          <span className="h-drawer-topbar-label">Feature detail</span>
          {prUrl && (
            <a
              href={prUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={prUrl}
              style={{
                fontSize: SIZES.xs,
                color: '#dbeafe',
                textDecoration: 'none',
                padding: '4px 10px',
                border: '1px solid rgba(59,130,246,0.34)',
                borderRadius: 999,
                background: 'rgba(59,130,246,0.14)',
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.03)',
                whiteSpace: 'nowrap',
              }}
            >
              View PR ↗
            </a>
          )}
          <button
            type="button"
            className="h-btn-icon"
            onClick={onClose}
            aria-label="Close feature details"
            title="Close (Esc)"
            style={{ marginLeft: 'auto' }}
          >
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        {/* Body */}
        <div className="h-drawer-body" style={{
          flex: 1,
          overflowY: 'auto',
          padding: '16px 18px 18px',
          background: '#17131f',
        }}>
          <div className="h-drawer-title-card" style={{
            marginBottom: 18,
            padding: '14px 14px 12px',
            border: `1px solid ${COLORS.border}` ,
            borderRadius: 14,
            background: '#1d1826',
            boxShadow: '0 16px 34px rgba(0,0,0,0.28), inset 0 1px 0 rgba(255,255,255,0.02)',
          }}>
            <div className="h-drawer-eyebrow" aria-label={`Feature ${feature.id}, status ${STATUS[feature.status].label}`} style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
              marginBottom: feature.summary ? 8 : 10,
            }}>
              <span>Feature</span>
              <span aria-hidden>·</span>
              <IdPill id={feature.id} onClick={() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }} />
              {copied && <span style={{ fontSize: SIZES.xs, color: COLORS.successText }}>copied</span>}
              <span className="h-drawer-eyebrow-separator" aria-hidden="true">·</span>
              <StatusPill status={feature.status} />
            </div>
            <Drawer.Title style={{
              margin: 0,
              marginBottom: feature.summary ? 8 : 10,
              fontSize: '1.14rem',
              fontWeight: 740,
              letterSpacing: '-0.02em',
              color: COLORS.text,
              lineHeight: 1.4,
            }}>
              {feature.summary || feature.title}
            </Drawer.Title>
            {feature.summary && (
              <div style={{
                fontFamily: FONTS.mono,
                fontSize: '0.76rem',
                letterSpacing: '0.012em',
                color: COLORS.textDim,
                marginBottom: 12,
              }}>{feature.title}</div>
            )}
            {/* Property rail */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'auto 1fr',
              columnGap: 14,
              rowGap: 8,
              fontSize: SIZES.sm,
              paddingTop: 10,
              borderTop: `1px solid ${COLORS.borderSubtle}`,
            }}>
              <span style={{ color: COLORS.textDim }}>Status</span>
              <div className="h-feature-status-controls" role="radiogroup" aria-label="Feature lifecycle status" style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                {(['todo','in_progress','validating','failing','blocked','passed'] as HarnessStatus[]).map((st) => {
                  const active = st === feature.status;
                  const ss = STATUS[st];
                  return (
                    <button
                      key={st}
                      type="button"
                      className={`h-feature-status-button${active ? ' is-current' : ''}`}
                      onClick={() => { if (!active) onSetStatus(feature.id, st); }}
                      aria-pressed={active}
                      aria-label={active ? `Current status: ${ss.label}` : `Move feature to ${ss.label}`}
                      title={active ? `Current status: ${ss.label}` : `Move to: ${ss.label}`}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 5,
                        padding: '3px 8px',
                        background: active ? ss.bg : 'transparent',
                        border: `1px solid ${active ? ss.solid : COLORS.border}`,
                        borderRadius: 999,
                        fontSize: SIZES.xs,
                        color: active ? ss.text : COLORS.textMuted,
                        cursor: 'pointer',
                      }}
                    >
                      {active ? <span aria-hidden>✓</span> : <span style={{ width: 6, height: 6, borderRadius: '50%', background: ss.solid }} />}
                      {ss.label}
                    </button>
                  );
                })}
              </div>

              <span style={{ color: COLORS.textDim }}>Attempts</span>
              <span style={{
                color: feature.attempts >= 3 ? STATUS.blocked.text : COLORS.text,
                fontFamily: FONTS.mono,
              }}>
                {feature.attempts}
                {feature.attempts >= 3 && <span style={{ color: COLORS.textDim, marginLeft: 6 }}>(stuck)</span>}
              </span>
            </div>
          </div>

          {/* Claims */}
          {feature.claims && feature.claims.length > 0 && (
            <Section title="Claims">
              <ul style={{ margin: 0, paddingLeft: 18, color: COLORS.text, fontSize: SIZES.sm, lineHeight: 1.6 }}>
                {feature.claims.map((c, i) => (
                  <li key={i} style={{ marginBottom: 4 }}>{c}</li>
                ))}
              </ul>
            </Section>
          )}


          {/* Debugger notes, if the debugger role has investigated this feature */}
          {debugNote && (
            <Section title="Debugger notes">
              <div style={{ marginBottom: 6 }}>
                <button
                  onClick={() => setShowDebug((v) => !v)}
                  title={showDebug ? "Hide debugger's hypothesis notes" : "Show debugger's hypothesis notes for this feature"}
                  style={{
                    background: '#221c2d',
                    border: `1px solid ${COLORS.borderSubtle}`,
                    color: COLORS.text,
                    padding: '4px 10px',
                    borderRadius: RADIUS.sm,
                    cursor: 'pointer',
                    fontSize: SIZES.sm,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.02)',
                  }}>
                  <span>{showDebug ? '▾' : '▸'}</span>
                  <span>Root-cause investigation ({debugNote.length.toLocaleString()} chars) · from debugger role</span>
                </button>
              </div>
              {showDebug && (
                <HarnessMarkdownView
                  value={debugNote}
                  className="h-debug-markdown"
                  emptyLabel="No debugger notes."
                />
              )}
            </Section>
          )}

          {/* Related runs */}
          <Section title={`Recent agent runs${recentRuns.length ? ` · ${recentRuns.length}` : ''}`}>
            {recentRuns.length === 0 ? (
              <Empty>No runs yet</Empty>
            ) : (
              <div className="h-feature-run-list" role="list" aria-label="Recent agent runs" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {recentRuns.map((r) => {
                  const runLabel = displayRunId(r);
                  const runTime = new Date(r.ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
                  return (
                    <div key={r.runId} role="listitem">
                      <button
                        type="button"
                        className="h-feature-run-row"
                        onClick={() => onInspectRun(r.runId)}
                        aria-label={`${r.role || 'unknown'} run ${runLabel} at ${runTime}. Inspect full output.`}
                        title="Inspect this agent run's full output"
                        style={{
                          display: 'grid', alignItems: 'center', gap: 8,
                          gridTemplateColumns: 'minmax(7.5rem, auto) auto auto minmax(0, 1fr)',
                          padding: '6px 8px',
                          background: '#201a2a',
                          border: `1px solid ${COLORS.borderSubtle}`,
                          borderRadius: RADIUS.sm,
                          color: COLORS.text,
                          cursor: 'pointer',
                          fontSize: SIZES.sm,
                          textAlign: 'left',
                          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.02)',
                        }}>
                        <RolePill role={r.role} />
                        <span style={{ color: COLORS.textDim, fontSize: SIZES.xs }}>
                          {runTime}
                        </span>
                        <span aria-hidden style={{ color: COLORS.textFaint }}>·</span>
                        <code style={{ fontFamily: FONTS.mono, color: COLORS.textMuted, fontSize: SIZES.xs, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {runLabel}
                        </code>
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </Section>

          {/* Issues for this feature */}
          {issuesForFeature && (
            <Section title="Validator issues">
              <HarnessMarkdownView
                value={issuesForFeature}
                className="h-validator-issues-markdown"
                emptyLabel="No validator issues."
              />
            </Section>
          )}

          {/* Actions row */}
          <div className="h-drawer-footer" style={{
            marginTop: 18,
            marginInline: -18,
            marginBottom: -18,
            padding: '12px 18px 14px',
            borderTop: `1px solid ${COLORS.borderSubtle}`,
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            flexWrap: 'wrap',
            background: '#17131f',
            boxShadow: '0 -12px 28px rgba(0,0,0,0.18)',
          }}>
            <button
              onClick={() => setShowTimeline(true)}
              style={{
                background: '#221c2d',
                border: `1px solid ${COLORS.borderSubtle}`,
                color: COLORS.text,
                padding: '6px 12px',
                borderRadius: 999,
                cursor: 'pointer',
                fontSize: SIZES.sm,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.02)',
              }}
              title="Aggregate snapshots, agent runs, debug notes, and PR metadata into one timeline"
            >
              🕰 View timeline
            </button>
            <span style={{ marginLeft: 'auto', fontSize: SIZES.xs, color: COLORS.textDim, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <span><KbdHint>Esc</KbdHint> close</span>
            </span>
          </div>
        </div>
        </Drawer.Content>
      </Drawer.Portal>

      {showTimeline && (
        <FeatureTimelinePanel
          slug={slug}
          featureId={feature.id}
          onClose={() => setShowTimeline(false)}
        />
      )}
    </Drawer.Root>
  );
}

function displayRunId(run: AgentRun): string {
  const role = run.role?.trim();
  let label = run.runId.replace(/\.log$/i, '').trim();
  if (role) {
    label = label.replace(new RegExp(`^[-_]?${escapeRegExp(role)}[-_]?`, 'i'), '');
  }
  label = label.replace(/^[-_]+/, '').trim();
  if (!label) label = run.runId.replace(/\.log$/i, '').trim() || 'run';
  return label.length > 28 ? `…${label.slice(-27)}` : label;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      className="h-drawer-section"
      style={{
        marginBottom: 18,
        padding: '12px 12px 10px',
        border: `1px solid ${COLORS.border}` ,
        borderRadius: 12,
        background: '#1c1824',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.02)',
      }}
    >
      <div className="h-drawer-section-title" style={{
        fontSize: '0.72rem',
        color: COLORS.textMuted,
        textTransform: 'uppercase',
        letterSpacing: '0.11em',
        fontWeight: 700,
        marginBottom: 10,
      }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: SIZES.sm, color: COLORS.textDim, fontStyle: 'italic' }}>
      {children}
    </div>
  );
}
