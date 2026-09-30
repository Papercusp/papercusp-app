'use client';

import { useMemo, useEffect } from 'react';
import { COLORS, FONTS, RADIUS, SIZES, STATUS, HarnessStatus } from './theme';
import { IconButton, KbdHint } from './primitives';

interface Feature {
  id: string;
  title: string;
  claims?: string[];
  status: HarnessStatus;
  attempts: number;
}

interface Props {
  features: Feature[];
  issues: string;
  onClose: () => void;
  onOpenFeature: (id: string) => void;
  onReset: (id: string) => void;
  onUnblock: (id: string) => void;
  onSkip: (id: string) => void;
}

/**
 * Linear-Triage-inspired queue for features that need human attention.
 * Shows:
 *   - Blocked (harness flagged)
 *   - Failing (validator said no)
 *   - Stuck (attempts ≥ 3)
 * Each row has quick actions: Accept (1) / Unblock (2) / Skip (3).
 */
export default function TriageQueue({
  features, issues, onClose, onOpenFeature, onReset, onUnblock, onSkip,
}: Props) {
  const triaged = useMemo(() => {
    const out = features
      .filter((f) => f.status === 'blocked' || f.status === 'failing' || f.attempts >= 3)
      .sort((a, b) => {
        // Priority: blocked > failing > stuck
        const order = { blocked: 0, failing: 1, validating: 2, in_progress: 3, todo: 4, passed: 5 } as const;
        const ao = order[a.status] ?? 6;
        const bo = order[b.status] ?? 6;
        if (ao !== bo) return ao - bo;
        return b.attempts - a.attempts;
      });
    return out;
  }, [features]);

  const issuesByFeature = useMemo(() => {
    const map: Record<string, string> = {};
    if (!issues) return map;
    const blocks = issues.split(/^##\s+/m).filter(Boolean);
    for (const b of blocks) {
      const idMatch = b.match(/(F-[A-Z0-9-]+)/);
      if (!idMatch) continue;
      const id = idMatch[1];
      if (!map[id]) map[id] = b;
    }
    return map;
  }, [issues]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      data-harness-modal="true"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 80,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex', justifyContent: 'center', alignItems: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(780px, 94vw)', maxHeight: '88vh',
          background: COLORS.surfaceRaised,
          border: `1px solid ${COLORS.borderStrong}`,
          borderRadius: 8,
          boxShadow: '0 20px 50px rgba(0,0,0,0.5)',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div style={{
          padding: '10px 14px',
          borderBottom: `1px solid ${COLORS.border}`,
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <div style={{ fontSize: SIZES.md, color: COLORS.text, fontWeight: 600 }}>
            Triage
          </div>
          <span style={{ fontSize: SIZES.xs, color: COLORS.textDim }}>
            {triaged.length} item{triaged.length === 1 ? '' : 's'} need attention
          </span>
          <span style={{ marginLeft: 'auto' }}>
            <IconButton onClick={onClose}>close</IconButton>
          </span>
        </div>

        <div style={{ padding: 14, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {triaged.length === 0 ? (
            <div style={{
              padding: 30, textAlign: 'center',
              color: COLORS.textDim, fontSize: SIZES.sm,
            }}>
              No features need attention. Everything is in flight.
            </div>
          ) : (
            triaged.map((f) => {
              const s = STATUS[f.status];
              const issue = issuesByFeature[f.id];
              return (
                <div key={f.id} style={{
                  background: COLORS.bg,
                  border: `1px solid ${s.solid}`,
                  borderLeftWidth: 3,
                  borderRadius: RADIUS.sm,
                  padding: '10px 12px',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                    <span style={{
                      display: 'inline-flex', alignItems: 'center', gap: 5,
                      fontSize: SIZES.xs, color: s.text, fontWeight: 500,
                      padding: '2px 8px',
                      background: s.bg,
                      borderRadius: RADIUS.sm,
                    }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: s.solid }} />
                      {s.label}
                    </span>
                    <span style={{
                      fontFamily: FONTS.mono, fontSize: SIZES.xs,
                      color: COLORS.textMuted, padding: '2px 6px',
                      border: `1px solid ${COLORS.border}`,
                      borderRadius: RADIUS.sm,
                    }}>
                      {f.id}
                    </span>
                    {f.attempts >= 3 && (
                      <span style={{ fontSize: SIZES.xs, color: STATUS.blocked.text, fontFamily: FONTS.mono }}>
                        ×{f.attempts} attempts
                      </span>
                    )}
                    <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                      <IconButton onClick={() => onOpenFeature(f.id)} title="Open feature details">open</IconButton>
                      <IconButton onClick={() => onReset(f.id)} variant="subtle" title="Reset → todo, attempts=0">reset</IconButton>
                      {f.status === 'blocked' && (
                        <IconButton onClick={() => onUnblock(f.id)} variant="primary" title="Move to todo">unblock</IconButton>
                      )}
                      <IconButton onClick={() => onSkip(f.id)} variant="danger" title="Mark as passed (skip)">skip</IconButton>
                    </span>
                  </div>
                  <div style={{ color: COLORS.text, fontSize: SIZES.sm, marginBottom: 4 }}>
                    {f.title}
                  </div>
                  {issue && (
                    <pre style={{
                      margin: '6px 0 0',
                      fontFamily: FONTS.mono,
                      fontSize: '0.65rem',
                      color: COLORS.textMuted,
                      background: COLORS.surface,
                      border: `1px solid ${COLORS.borderSubtle}`,
                      borderRadius: RADIUS.sm,
                      padding: '6px 8px',
                      whiteSpace: 'pre-wrap',
                      maxHeight: 180,
                      overflow: 'auto',
                    }}>
                      {issue.slice(0, 2000)}{issue.length > 2000 ? '\n…' : ''}
                    </pre>
                  )}
                </div>
              );
            })
          )}
        </div>

        <div style={{
          display: 'flex', gap: 14, padding: '8px 14px',
          borderTop: `1px solid ${COLORS.border}`,
          fontSize: '0.65rem', color: COLORS.textDim,
        }}>
          <span><KbdHint>Esc</KbdHint> close</span>
          <span style={{ marginLeft: 'auto', color: COLORS.textFaint }}>
            Skip marks a feature as passed so the harness moves on. Reset retries it from scratch.
          </span>
        </div>
      </div>
    </div>
  );
}
