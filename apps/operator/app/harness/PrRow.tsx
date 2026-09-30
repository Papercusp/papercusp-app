'use client';

/**
 * PrRow — single PR row for PrsTab (Phase 7 P-043; PR-3 report GUI).
 *
 * Shows: PR number + title, author, checks status, trust badge, the REAL
 * review decision, action buttons — plus (PR-3) the agent review report:
 * a prominent recommendation chip, the linked WI, an expandable
 * summary/rationale/risks/observed-checks panel, and an HONEST auto-status
 * line that says WHY a PR is / isn't auto-mergeable. It never presents a
 * recommendation or auto-status as a real merge state (Brief-G / G-004
 * honesty discipline).
 */

import React from 'react';
import {
  ExternalLink,
  CheckCircle,
  XCircle,
  Clock,
  AlertCircle,
  ShieldCheck,
  ChevronRight,
  ChevronDown,
  ThumbsUp,
  AlertTriangle,
  Ban,
  GitBranch,
  Bot,
  Zap,
  Lock,
} from 'lucide-react';
import { COLORS, FONTS, RADIUS } from './theme';

import type {
  PrRowData,
  PrAutoStatus,
  RecommendationTone,
} from '@papercusp/operator-core/lib/pr-host/pr-row-data';
import {
  recommendationLabel,
  recommendationTone,
} from '@papercusp/operator-core/lib/pr-host/pr-row-data';
import type {
  PrReviewRecommendation,
  PrReviewChecksObserved,
} from '@papercusp/operator-core/lib/pr-host/pr-review-report-types';
export type { PrRowData };

interface Props {
  pr: PrRowData;
  /** Honest auto-status, computed by PrsTab from the harness auto-mode settings. */
  autoStatus?: PrAutoStatus;
  /** Whether this row's report panel is expanded (nuqs-driven in PrsTab). */
  expanded?: boolean;
  onToggleExpand?: () => void;
  onApprove?: (prNumber: number) => void;
  onApproveAndMerge?: (prNumber: number) => void;
}

/** tone → {fg,bg,border} for recommendation chips + auto-status. */
const TONE: Record<RecommendationTone, { fg: string; bg: string; border: string }> = {
  ok: { fg: '#86efac', bg: 'rgba(34,197,94,0.14)', border: 'rgba(34,197,94,0.5)' },
  warn: { fg: '#fcd34d', bg: 'rgba(245,158,11,0.15)', border: 'rgba(245,158,11,0.5)' },
  bad: { fg: '#fca5a5', bg: 'rgba(239,68,68,0.15)', border: 'rgba(239,68,68,0.5)' },
};

function ChecksBadge({ conclusion }: { conclusion: string | null }) {
  if (conclusion === null) return null;
  if (conclusion === 'success') {
    return (
      <span style={{ color: COLORS.success, display: 'flex', alignItems: 'center', gap: 2, fontSize: 12 }}>
        <CheckCircle size={12} /> checks
      </span>
    );
  }
  if (conclusion === 'failure') {
    return (
      <span style={{ color: COLORS.dangerText, display: 'flex', alignItems: 'center', gap: 2, fontSize: 12 }}>
        <XCircle size={12} /> failed
      </span>
    );
  }
  if (conclusion === 'pending') {
    return (
      <span style={{ color: COLORS.textMuted, display: 'flex', alignItems: 'center', gap: 2, fontSize: 12 }}>
        <Clock size={12} /> pending
      </span>
    );
  }
  return (
    <span style={{ color: COLORS.textMuted, display: 'flex', alignItems: 'center', gap: 2, fontSize: 12 }}>
      <AlertCircle size={12} /> {conclusion}
    </span>
  );
}

function ReviewBadge({ decision }: { decision: PrRowData['review_decision'] }) {
  if (decision === 'none') return null;
  const color =
    decision === 'approved'
      ? COLORS.success
      : decision === 'changes_requested'
        ? COLORS.dangerText
        : COLORS.textMuted;
  const label =
    decision === 'approved'
      ? '✓ approved'
      : decision === 'changes_requested'
        ? '✗ changes requested'
        : decision;
  return <span style={{ color, fontSize: 12 }}>{label}</span>;
}

/** The prominent recommendation chip — the agent's opinion (advisory). */
function RecommendationChip({ recommendation }: { recommendation: PrReviewRecommendation }) {
  const tone = TONE[recommendationTone(recommendation)];
  const Icon =
    recommendation === 'approve' ? ThumbsUp : recommendation === 'reject' ? Ban : AlertTriangle;
  return (
    <span
      title="Agent recommendation (advisory — the gate + owner mode decide whether it is applied)"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        background: tone.bg,
        color: tone.fg,
        border: `1px solid ${tone.border}`,
        borderRadius: RADIUS.sm,
        padding: '1px 8px',
        fontSize: 11,
        fontWeight: 700,
      }}
    >
      <Bot size={11} aria-hidden />
      <Icon size={11} aria-hidden />
      {recommendationLabel(recommendation)}
    </span>
  );
}

/** Honest auto-status line — describes the AUTO gate, never the real merge state. */
function AutoStatusLine({ status }: { status: PrAutoStatus }) {
  if (status.mode === 'manual') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: COLORS.textMuted }}>
        <Lock size={11} aria-hidden /> Manual review — approve by hand
      </span>
    );
  }
  if (status.willMerge) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: TONE.ok.fg }}>
        <Zap size={11} aria-hidden /> Will auto-merge on next poll
      </span>
    );
  }
  return (
    <span
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: TONE.warn.fg }}
      title={status.blockers.join(' · ')}
    >
      <AlertTriangle size={11} aria-hidden /> Auto-merge blocked: {status.blockers.join('; ')}
    </span>
  );
}

/** A small observed-fact pill in the expanded panel. */
function Fact({ label, danger }: { label: string; danger?: boolean }) {
  return (
    <span
      style={{
        fontSize: 11,
        color: danger ? TONE.bad.fg : COLORS.textMuted,
        background: danger ? TONE.bad.bg : 'transparent',
        border: `1px solid ${danger ? TONE.bad.border : COLORS.border}`,
        borderRadius: RADIUS.sm,
        padding: '0 6px',
      }}
    >
      {label}
    </span>
  );
}

function ReportPanel({ report }: { report: NonNullable<PrRowData['report']> }) {
  // checksObserved is the deterministic facts shape (PR-2). Read defensively —
  // a legacy/garbled row may be missing fields the type promises.
  const co = (report.checksObserved ?? {}) as Partial<PrReviewChecksObserved>;
  const checksState = typeof co.checks_state === 'string' ? co.checks_state : undefined;
  const testsTouched = typeof co.tests_touched === 'boolean' ? co.tests_touched : undefined;
  const secretSuspected = co.secret_suspected === true;
  const filesChanged = typeof co.files_changed === 'number' ? co.files_changed : undefined;
  const diffEmpty = co.diff_empty === true;

  return (
    <div
      style={{
        marginTop: 8,
        padding: '8px 10px',
        background: 'rgba(255,255,255,0.02)',
        border: `1px solid ${COLORS.border}`,
        borderRadius: RADIUS.sm,
        display: 'grid',
        gap: 8,
      }}
    >
      {report.summary && (
        <div style={{ fontSize: 12, color: COLORS.text, lineHeight: 1.45 }}>{report.summary}</div>
      )}
      {report.rationale && (
        <div style={{ fontSize: 12, color: COLORS.textMuted, lineHeight: 1.45 }}>
          <span style={{ fontWeight: 600, color: COLORS.text }}>Why: </span>
          {report.rationale}
        </div>
      )}
      {report.risks.length > 0 && (
        <div style={{ display: 'grid', gap: 3 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: TONE.warn.fg, textTransform: 'uppercase' }}>
            Risks ({report.risks.length})
          </span>
          <ul style={{ margin: 0, paddingLeft: 16, display: 'grid', gap: 2 }}>
            {report.risks.map((r, i) => (
              <li key={i} style={{ fontSize: 12, color: COLORS.text }}>
                {r}
              </li>
            ))}
          </ul>
        </div>
      )}
      {/* Observed mechanical facts (deterministic — not the model's opinion). */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {checksState && <Fact label={`checks: ${checksState}`} danger={checksState === 'failure' || checksState === 'error'} />}
        {testsTouched !== undefined && <Fact label={testsTouched ? 'tests touched' : 'no tests touched'} danger={testsTouched === false} />}
        {secretSuspected && <Fact label="secret suspected" danger />}
        {diffEmpty && <Fact label="empty diff" danger />}
        {filesChanged !== undefined && <Fact label={`${filesChanged} file${filesChanged === 1 ? '' : 's'}`} />}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 10, color: COLORS.textMuted }}>
        {report.model && <span>model: {report.model}</span>}
        {report.reviewedAt && <span>reviewed: {new Date(report.reviewedAt).toLocaleString()}</span>}
        {report.headSha && <span>@ {report.headSha.slice(0, 7)}</span>}
      </div>
    </div>
  );
}

export function PrRow({ pr, autoStatus, expanded, onToggleExpand, onApprove, onApproveAndMerge }: Props) {
  const cannotReach = pr.state === 'gone';
  const report = pr.report ?? null;

  return (
    <div
      style={{
        padding: '10px 0',
        borderBottom: `1px solid ${COLORS.border}`,
        opacity: cannotReach ? 0.5 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        {/* Expand chevron (only when there's a report to expand). */}
        {report ? (
          <button
            type="button"
            onClick={() => onToggleExpand?.()}
            aria-label={expanded ? `Collapse report for PR #${pr.number}` : `Expand report for PR #${pr.number}`}
            aria-expanded={!!expanded}
            style={{
              background: 'transparent',
              border: 0,
              color: COLORS.textMuted,
              cursor: 'pointer',
              padding: 0,
              marginTop: 2,
              display: 'flex',
            }}
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        ) : (
          <span style={{ width: 14, flexShrink: 0 }} />
        )}

        {/* PR number */}
        <span style={{ color: COLORS.textMuted, fontSize: 12, minWidth: 32, paddingTop: 2 }}>
          #{pr.number}
        </span>

        {/* Main content */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span
              style={{
                fontFamily: FONTS.ui,
                fontSize: 13,
                fontWeight: 500,
                color: COLORS.text,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: 320,
              }}
            >
              {pr.title}
            </span>
            {report && <RecommendationChip recommendation={report.recommendation} />}
            {report?.stale && (
              <span
                title="The agent reviewed an earlier commit; the recommendation may be out of date."
                style={{ fontSize: 10, color: TONE.warn.fg, border: `1px solid ${TONE.warn.border}`, borderRadius: RADIUS.sm, padding: '0 5px' }}
              >
                reviewed earlier commit
              </span>
            )}
            {pr.featureId && (
              <span
                title={`Linked work-item: ${pr.featureId}`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 3,
                  fontSize: 11,
                  color: COLORS.accent,
                  border: `1px solid ${COLORS.border}`,
                  borderRadius: RADIUS.sm,
                  padding: '0 6px',
                  maxWidth: 160,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                <GitBranch size={10} aria-hidden /> {pr.featureId}
              </span>
            )}
            {pr.trusted && pr.reviewerRoleEnabled && (
              <span
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 3,
                  background: COLORS.successBg ?? 'rgba(34,197,94,0.1)',
                  color: COLORS.success,
                  borderRadius: RADIUS.sm,
                  padding: '1px 6px',
                  fontSize: 11,
                }}
              >
                <ShieldCheck size={10} /> trusted
              </span>
            )}
            {cannotReach && <span style={{ fontSize: 11, color: COLORS.dangerText }}>PR gone</span>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4, flexWrap: 'wrap' }}>
            {/* Hive-scoped rows (P-006): which member harness this PR belongs to. */}
            {pr.member_slug && (
              <span
                style={{
                  fontSize: 11,
                  color: COLORS.textMuted,
                  border: `1px solid ${COLORS.border}`,
                  borderRadius: RADIUS.sm,
                  padding: '0 6px',
                  maxWidth: 180,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={pr.member_slug}
              >
                {pr.member_slug}
              </span>
            )}
            <span style={{ fontSize: 12, color: COLORS.textMuted }}>@{pr.author_login}</span>
            <ChecksBadge conclusion={pr.check_conclusion} />
            <ReviewBadge decision={pr.review_decision} />
            {autoStatus && <AutoStatusLine status={autoStatus} />}
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <a
            href={pr.html_url}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 12,
              color: COLORS.accent,
              textDecoration: 'none',
            }}
            aria-label={`Open PR #${pr.number} on GitHub`}
          >
            <ExternalLink size={12} />
          </a>
          {pr.reviewerRoleEnabled && pr.state === 'open' && (
            <>
              <button
                onClick={() => onApprove?.(pr.number)}
                style={{
                  fontSize: 12,
                  padding: '2px 8px',
                  borderRadius: RADIUS.sm,
                  border: `1px solid ${COLORS.border}`,
                  background: 'transparent',
                  color: COLORS.text,
                  cursor: 'pointer',
                }}
              >
                Approve
              </button>
              <button
                onClick={() => onApproveAndMerge?.(pr.number)}
                style={{
                  fontSize: 12,
                  padding: '2px 8px',
                  borderRadius: RADIUS.sm,
                  border: `1px solid ${COLORS.accent}`,
                  background: COLORS.accent,
                  color: '#fff',
                  cursor: 'pointer',
                }}
              >
                Approve + merge
              </button>
            </>
          )}
        </div>
      </div>

      {/* Expanded report detail. */}
      {report && expanded && (
        <div style={{ paddingLeft: 58 }}>
          <ReportPanel report={report} />
        </div>
      )}
    </div>
  );
}
