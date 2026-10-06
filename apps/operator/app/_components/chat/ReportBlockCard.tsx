'use client';

/**
 * Operator adapter for the shared report-card layout. Rich markdown/work-ref
 * hydration is operator chrome and enters through the package's item renderer
 * seam; plan/item layout and interaction remain shared with the portal.
 */
import { useMemo, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { parseAsString, useQueryState } from 'nuqs';
import { fetchSyncQuery } from '@papercusp/sync';
import { parseGoalOwnerReportSnapshot, type GoalOwnerReportRefV1, type ReportBlock } from '@papercusp/chat-protocol';
import {
  ReportBlockCard as SharedReportBlockCard,
  type ReportBlockRenderContext,
  type ReportBlockCardProps as SharedReportBlockCardProps,
  type ResolvedGoalOwnerReport,
} from '@papercusp/chat-cards';
import { Button } from '../../harness/Button';
import { HydratedWorkRefPill } from './HydratedWorkRefPill';
import { canOpenWorkRef } from './chat-ref-popup-params';
import { remarkWorkRefs } from './remark-work-refs';
import type { WorkRefKind } from './parse-work-refs';

function withHardBreaks(text: string): string {
  return text.replace(/\n/g, '  \n');
}

const REPORT_REMARK_PLUGINS = [remarkGfm, remarkWorkRefs];

interface WorkRefPillHastNode {
  properties?: { refId?: unknown; refKind?: unknown };
}

const REPORT_MARKDOWN_COMPONENTS = {
  p: ({ children }: { children?: ReactNode }) => <span className="report-block-item-text">{children}</span>,
  a: ({ children, href }: { children?: ReactNode; href?: string }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
};

type ReportWorkRef = { id: string; kind: WorkRefKind; planSlug?: string | null };

interface ReportBlockCardProps {
  report: ReportBlock;
  onDrillIn?: (ref: string) => void;
  canDrillIn?: (ref: string) => boolean;
  harnessSlug?: string;
  planSlug?: string | null;
  onWorkRefActivate?: (ref: ReportWorkRef) => void;
}

interface GoalReportQueryRow {
  report_id: string;
  workspace_id: string;
  body_md: string;
  body_sha256: string;
  goal_owner_report: unknown;
  subject: { kind: string; ref: string | null };
}

async function resolveGoalReport(reference: GoalOwnerReportRefV1): Promise<ResolvedGoalOwnerReport> {
  const rows = await fetchSyncQuery<GoalReportQueryRow>({
    queryName: 'reports.get', args: { reportId: reference.reportId }, staleTime: Infinity,
  });
  const row = rows.find((candidate) => candidate.report_id === reference.reportId);
  const snapshot = parseGoalOwnerReportSnapshot(row?.goal_owner_report);
  if (!row || !snapshot || row.subject.kind !== 'goal' || row.subject.ref !== reference.goalId) {
    throw new Error('The pinned report is unavailable or does not belong to this goal.');
  }
  return { reportId: row.report_id, workspaceId: row.workspace_id, goalId: row.subject.ref,
    bodyMd: row.body_md, bodySha256: row.body_sha256, snapshot };
}

/** Inline reports retain their original host requirements; only pins use URL state. */
function PinnedReportBlockCard(props: SharedReportBlockCardProps): ReactNode {
  const [expandedReportId, setExpandedReportId] = useQueryState('goalReport', parseAsString);
  const reportId = props.report.goalReport!.reportId;
  return <SharedReportBlockCard {...props} resolveGoalReport={resolveGoalReport}
    expanded={expandedReportId === reportId}
    onExpandedChange={(open) => { void setExpandedReportId(open ? reportId : expandedReportId === reportId ? null : expandedReportId); }}
    renderGoalReportControl={({ label, expanded, onClick }) => (
      <Button variant="neutral" aria-expanded={expanded} onClick={onClick}>{label}</Button>
    )} />;
}

function RichItemText({
  context,
  harnessSlug,
  planSlug,
  onWorkRefActivate,
}: {
  context: ReportBlockRenderContext;
  harnessSlug?: string;
  planSlug?: string | null;
  onWorkRefActivate?: (ref: ReportWorkRef) => void;
}): ReactNode {
  const components = useMemo(
    () => ({
      ...REPORT_MARKDOWN_COMPONENTS,
      workrefpill: ({ node }: { node?: WorkRefPillHastNode }) => {
        const id = typeof node?.properties?.refId === 'string' ? node.properties.refId : '';
        const kind: WorkRefKind = node?.properties?.refKind === 'plan-item' ? 'plan-item' : 'work-item';
        if (!id) return null;
        return (
          <HydratedWorkRefPill
            id={id}
            kind={kind}
            harnessSlug={harnessSlug ?? ''}
            planSlug={planSlug}
            size="xs"
            onActivate={
              // WI-10001541: a seam being wired is NOT the same question as this
              // ref having somewhere to go. Gate on the shared decision so a ref
              // that opens nothing renders as inert text rather than a dead button.
              onWorkRefActivate && canOpenWorkRef({ id, kind, planSlug }, harnessSlug)
                ? () => onWorkRefActivate({ id, kind, planSlug })
                : undefined
            }
          />
        );
      },
    }),
    [harnessSlug, planSlug, onWorkRefActivate],
  );
  return (
    <ReactMarkdown remarkPlugins={REPORT_REMARK_PLUGINS} components={components}>
      {withHardBreaks(context.item.text)}
    </ReactMarkdown>
  );
}

export function ReportBlockCard({
  report,
  onDrillIn,
  canDrillIn,
  harnessSlug,
  planSlug,
  onWorkRefActivate,
}: ReportBlockCardProps): ReactNode {
  const Card = report.goalReport ? PinnedReportBlockCard : SharedReportBlockCard;
  return (
    <Card
      report={report}
      onDrillIn={onDrillIn}
      canDrillIn={canDrillIn}
      renderItemText={(context) => (
        <RichItemText
          context={context}
          harnessSlug={harnessSlug}
          planSlug={planSlug}
          onWorkRefActivate={onWorkRefActivate}
        />
      )}
    />
  );
}
