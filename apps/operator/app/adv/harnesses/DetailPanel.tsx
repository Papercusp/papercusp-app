'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { ArrowUpRight, MessageCircle } from 'lucide-react';
import { useSyncQuery } from '@papercusp/sync';
import { useLexicon } from '@/lib/useLexicon';
import { openFeatureChat } from '@papercusp/papercusp-shared';
import type { Issue, IssueNote } from '@papercusp/operator-core/lib/harness/issue-types';
import type { PanelComponentProps } from '../../harness/dock/panel-registry';
import { StatusPill, SeverityPill, IssueStatusPill, AgentKindPill, KindPill } from '../../harness/primitives';
import { SEVERITY, type HarnessStatus, type IssueSeverityKey } from '../../harness/theme';
import { Select } from '../../harness/Select';
import { Tooltip } from '../../harness/Tooltip';
import { useConfirmDialog } from '../../harness/useConfirmDialog';
import FeatureEditor from '../../harness/FeatureEditor';
import { LivenessDot, livenessFromHeartbeat } from '../../coord/presence-ui';
import { useHarnessFeature, useHarnessIssues, type FeatureStatus, type HarnessFeature } from './useHarnessData';
import { useWorkspaceId } from '@/lib/use-workspace-id';
import { issueAction, issueActionStatus, type IssueActionKind } from './harness-actions';
import type { WorkItemRow } from './WorkItemsPanel';
import { HumanWorkSection } from './HumanWorkSection';
import type { WorkingAgent } from './AdvAgentsPanel';
import { runOutcome } from './run-outcome';
import { agentDisplayLabel, agentRoleLabel } from '../../harness/agent-display';
import WorkItemDiscussion, {
  WORK_ITEM_DISCUSSION_PARAM,
} from '../../_components/work-items/WorkItemDiscussion';
import {
  decodeScopedRef,
  encodeScopedRef,
  CHAT_PLAN_POPUP_PARAM,
} from '../../_components/chat/chat-ref-popup-params';
import { WORK_ITEM_PRESENTATION_LABELS, WORK_ITEM_PRESENTATION_REASONS } from '@papercusp/operator-core/lib/work-item-presentation-contract';

// work-item-status-full-unify P-007: the settable feature statuses are the UNIFIED
// lifecycle tokens (feature `todo`→`open`, `passed`→`done`, `deprecated`→`dropped`;
// `in_progress`/`validating`→`wip`). Legacy spellings still render on read (see the
// FeatureStatus superset + theme.ts _STATUS_TABLE) but are no longer offered to set.
const FEATURE_STATUSES: FeatureStatus[] = [
  'open',
  'wip',
  'blocked',
  'needs-human',
  'done',
  'dropped',
];

// Consolidated agent-run row (camelCase Zero export). Since P-023
// (adv-harness-tab-migration) the resolver joins the spawn outcome +
// native resume session id from spawned_agents — null on legacy rows.
type RunRow = {
  runId: string;
  role: string;
  ts: number | string;
  featureId?: string | null;
  costUsd?: number | string;
  running?: boolean | null;
  spawnStatus?: string | null;
  exitCode?: number | null;
  errorMessage?: string | null;
  sessionId?: string | null;
};

// Selection-history stack, module-scoped so it survives DetailPanel
// re-mounts (a slug change remounts the panel). Only the swap panel
// (no pinned itemId) pushes/pops; pinned panels are read-only viewers.
const selHistory: string[] = [];
let suppressHistoryPush = false;

/**
 * Open a run's recorded agent session in a terminal (P-023): the launch-su
 * resume path spawns `psu --agent=claude --resume-session=<id>` server-side —
 * the same flow the Sessions tab uses, so the resumed session is tracked in
 * adv_sessions like any other launch.
 */
async function openRunSession(slug: string, sessionId: string): Promise<void> {
  try {
    const res = await fetch('/api/adv/sessions/launch-su', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'claude', harness_slug: slug, resume_session_id: sessionId }),
    });
    const body = (await res.json().catch(() => ({}))) as { status?: string; error?: string };
    if (!res.ok || body.status === 'error') throw new Error(body.error || `${res.status}`);
    toast.success(`Session ${sessionId.slice(0, 12)}… opening in a terminal.`);
  } catch (e) {
    toast.error('Open session failed', { description: String(e) });
  }
}

function fmtAgo(ts: number | string): string {
  const ms = typeof ts === 'number' ? ts : Date.parse(String(ts));
  if (!Number.isFinite(ms)) return '';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function noteBodies(raw: string): string[] {
  if (!raw.trim()) return [];
  return raw
    .split(/^## \S+ \d{4}-\d{2}-\d{2}T[^\n]+\s*$/gm)
    .map((body) => body.trim())
    .filter(Boolean);
}

export type SelectionKind = 'feature' | 'issue' | 'workItem' | 'agent';

/**
 * Resolve which detail view a `?sel` id maps to. F-* → feature, I-* → issue
 * (legacy surface), agent:* → a working agent (the Agents panel stamps this
 * namespace on — agent ids have no stable prefix of their own). EVERYTHING
 * ELSE → unified work item.
 *
 * The WorkItemsPanel grid serves rows across every work-item KIND, and their
 * ids carry kind-specific prefixes (WI-, EI-, BA-, …) — NOT just `WI-`.
 * Matching only `WI-` here left every other prefix (notably the EI-*
 * issue-family items) resolving to no kind, so the detail pane showed "No item
 * found" for them. Falling through to `workItem` resolves them against the same
 * `workItems.byHarness` query the grid reads; a genuinely-unknown id still
 * lands on the "No item found" empty state (the row simply won't be in the
 * query). Exported for unit testing.
 */
export function resolveSelectionKind(selectedId: string | null | undefined): SelectionKind | null {
  if (!selectedId) return null;
  if (selectedId.startsWith('F-')) return 'feature';
  if (selectedId.startsWith('I-')) return 'issue';
  if (selectedId.startsWith('agent:')) return 'agent';
  return 'workItem';
}

/**
 * Detail panel — renders the currently-selected feature or issue.
 *
 * Two modes:
 *   - Swap (default): reads `?sel=<id>` from the URL and follows selection
 *     changes made in the Features / Issues panels.
 *   - Pinned: if `params.itemId` is set, the panel locks to that id and
 *     ignores `?sel=`. Spawned via the "Pin to new panel" context menu;
 *     stays put while the user keeps clicking around.
 */
export default function DetailPanel({ params, api }: PanelComponentProps) {
  const t = useLexicon();
  const workUnit = t('workUnit', { lower: true });
  const workUnits = t('workUnit', { plural: true, lower: true });
  const slug = (params.harnessSlug as string) || '';
  const pinnedId = (params.itemId as string) || null;
  const [urlSel, setUrlSel] = useQueryState('sel', parseAsString.withDefault(''));
  // `?edit=<featureId>` opens the embedded FeatureEditor for that feature in
  // this pane. Navigating to another item clears it (back to the read view).
  const [editId, setEditId] = useQueryState('edit', parseAsString.withDefault(''));
  const selectedId = pinnedId ?? urlSel;
  const kind = useMemo(() => resolveSelectionKind(selectedId), [selectedId]);

  // Live data via pushed named queries, no polling. A selected feature comes
  // from the existing one-row detail read rather than mounting the harness-wide
  // feature corpus merely to find one id. Its hook preserves optimistic patches.
  const {
    feature,
    loading: featureLoading,
    error: featureError,
    patchFeature,
  } = useHarnessFeature(slug, kind === 'feature' ? selectedId : '', kind === 'feature');
  const { issues, patchIssue } = useHarnessIssues(slug);
  // Select-from-Detail (related issue/feature cross-links) drives the global
  // ?sel so the swap panel follows, even when invoked from a pinned panel.
  const onSelect = useCallback(
    (id: string) => {
      void setUrlSel(id || null);
      void setEditId(null); // navigating away exits edit mode
    },
    [setUrlSel, setEditId],
  );

  // Selection history: push the previous ?sel whenever it changes (swap panel
  // only), so a Back affordance can retrace feature↔issue cross-links.
  const prevSelRef = useRef<string>('');
  useEffect(() => {
    if (pinnedId) return;
    if (suppressHistoryPush) {
      suppressHistoryPush = false;
      prevSelRef.current = urlSel;
      return;
    }
    const prev = prevSelRef.current;
    if (prev && prev !== urlSel) {
      selHistory.push(prev);
      if (selHistory.length > 50) selHistory.shift();
    }
    prevSelRef.current = urlSel;
  }, [urlSel, pinnedId]);
  const goBack = useCallback(() => {
    const prev = selHistory.pop();
    if (prev !== undefined) {
      suppressHistoryPush = true;
      void setUrlSel(prev || null);
    }
  }, [setUrlSel]);
  const onBack = !pinnedId && selHistory.length > 0 ? goBack : undefined;

  // The detail pane renders at most three runs for ONE selected feature. Push
  // that predicate + limit into the existing agent-runs keyset query instead of
  // subscribing this pane to the harness-wide history window.
  const featureDetailWorkspaceId = useWorkspaceId();
  const { data: runRows } = useSyncQuery<RunRow>({
    queryName: 'agentRunsConsolidated.bySlug',
    args: {
      harnessSlug: slug,
      workspaceId: featureDetailWorkspaceId,
      featureId: kind === 'feature' ? selectedId : '',
      limit: 3,
    },
    enabled: Boolean(slug) && kind === 'feature' && Boolean(selectedId),
  });
  const issue = useMemo(
    () => (kind === 'issue' ? (issues ?? []).find((i) => i.id === selectedId) ?? null : null),
    [kind, issues, selectedId],
  );
  // P-004: selected-row authority is the existing one-row detail query. A
  // selection must remain resolvable even when the item is beyond the current
  // keyset page (or excluded by a filter), so page membership is never consulted.
  const workItemDetailQuery = useSyncQuery<WorkItemRow>({
    queryName: 'workItems.detail',
    args: { harnessSlug: slug, id: kind === 'workItem' ? selectedId : '' },
    enabled: Boolean(slug) && kind === 'workItem' && Boolean(selectedId),
  });
  const workItemDetailRow = workItemDetailQuery.loading ? null : (workItemDetailQuery.data?.[0] ?? null);
  const workItem = useMemo(
    () => kind === 'workItem' && workItemDetailRow?.id === selectedId
      ? workItemDetailRow
      : null,
    [kind, workItemDetailRow, selectedId],
  );
  // agent:* resolves against the same `fleetAssignments.byHarness` sync query
  // the Agents panel's Working view reads (one projection, identical rows).
  // Only subscribed while an agent is actually selected.
  const agentsQuery = useSyncQuery<WorkingAgent>({
    queryName: 'fleetAssignments.byHarness',
    args: { harnessSlug: slug },
    enabled: Boolean(slug) && kind === 'agent',
  });
  const agentRows = agentsQuery.loading ? null : agentsQuery.data;
  const agent = useMemo(
    () =>
      kind === 'agent'
        ? (agentRows ?? []).find((a) => `agent:${a.agentId}` === selectedId) ?? null
        : null,
    [kind, agentRows, selectedId],
  );

  useEffect(() => {
    if (pinnedId) {
      api.setTitle(pinnedId);
    } else if (feature) {
      api.setTitle(`Detail · ${feature.id}`);
    } else if (issue) {
      api.setTitle(`Detail · ${issue.id}`);
    } else if (workItem) {
      api.setTitle(`Detail · ${workItem.id}`);
    } else if (agent) {
      api.setTitle(`Detail · ${agentDisplayLabel(agent.name ?? agent.label ?? agent.agentId, t)}`);
    } else {
      api.setTitle('Detail');
    }
  }, [api, pinnedId, feature, issue, workItem, agent, t]);

  if (!slug) {
    return <Empty>Pick a {t('pot', { lower: true })} to inspect its {workUnits}.</Empty>;
  }

  if (!selectedId) {
    return <Empty>Pick a {workUnit} from the list to inspect.</Empty>;
  }

  if (selectedId && !feature && !issue && !workItem && !agent) {
    // The id is in the URL but the lists haven't settled yet (or it's a
    // stale selection). Show a brief loading state until the lists load.
    if (
      (kind === 'feature' && featureLoading) ||
      issues === null ||
      (kind === 'workItem' && workItemDetailQuery.loading) ||
      (kind === 'agent' && agentRows === null)
    ) {
      return <Empty>Loading {selectedId}…</Empty>;
    }
    if (kind === 'feature' && featureError) {
      return <Empty tone="error">Unable to load {selectedId}: {featureError}</Empty>;
    }
    // An agent selection goes stale the moment the session ends (the fleet
    // projection only carries working agents) — say that, not "no item".
    if (kind === 'agent') {
      return <Empty>Agent {selectedId.slice('agent:'.length)} is no longer working here.</Empty>;
    }
    return <Empty tone="error">No {workUnit} found for {selectedId}.</Empty>;
  }

  if (feature) {
    return (
      <FeatureDetail
        slug={slug}
        feature={feature}
        issues={issues ?? []}
        runs={Array.isArray(runRows) ? runRows : []}
        onSelect={onSelect}
        onBack={onBack}
        patchFeature={patchFeature}
        isEditing={!pinnedId && editId === feature.id}
        onStartEdit={() => void setEditId(feature.id)}
        onCloseEdit={() => void setEditId(null)}
      />
    );
  }
  if (issue) {
    return <IssueDetail slug={slug} issue={issue} onSelect={onSelect} onBack={onBack} patchIssue={patchIssue} />;
  }
  if (workItem) {
    return <WorkItemDetail slug={slug} workItem={workItem} onSelect={onSelect} onBack={onBack} />;
  }
  if (agent) {
    return <AgentDetail agent={agent} onSelect={onSelect} onBack={onBack} />;
  }
  return null;
}

/**
 * AgentDetail — detail for an `agent:*` selection (the Agents panel's Working
 * view rows — the fleet:assignments projection). Read-only: presence, intent,
 * load, and the agent's work, with the head-of-line item + queue + claims
 * cross-linking back into the F- / WI- details via the same `?sel` contract.
 *
 * Exported for tests.
 */
export function AgentDetail({
  agent,
  onSelect,
  onBack,
}: {
  agent: WorkingAgent;
  onSelect: (id: string) => void;
  onBack?: () => void;
}) {
  const lex = useLexicon();
  const liveness = livenessFromHeartbeat(agent.heartbeatAt ?? '');
  // Work-item-shaped ids cross-link into their own detail; anything else
  // (plan items, lock paths…) renders as plain text.
  const linkable = (id: string | null): id is string =>
    !!id && (id.startsWith('F-') || id.startsWith('I-') || id.startsWith('WI-'));
  return (
    <div className="pc-adv-detail pc-adv-detail--compact">
      <header className="pc-adv-detail__header">
        <BackChip onBack={onBack} />
        <div className="pc-adv-detail__id">{agent.agentId}</div>
        <div className="pc-adv-detail__title">{agentDisplayLabel(agent.name ?? agent.label ?? agent.agentId, lex)}</div>
        {/* Presence/drive/load live on the meta line — the kind pill was
            already here, so the old field-row section only duplicated it. */}
        <div className="pc-adv-detail__meta">
          <AgentKindPill kind={agent.agentPaneKind} size="xs" />
          <span className="pc-adv-detail__liveness">
            <LivenessDot liveness={liveness} title="" />
            {liveness}
            {agent.heartbeatAt ? (
              <span className="pc-adv-detail__muted"> · heartbeat {fmtAgo(agent.heartbeatAt)}</span>
            ) : null}
          </span>
          {agent.driveMode ? <span className="pc-adv-detail__stat">drive: {agent.driveMode}</span> : null}
          {agent.load > 0 ? <span className="pc-adv-detail__stat">load: {agent.load}</span> : null}
          {agent.orphaned && (
            <Tooltip label="This agent holds claims but is no longer present — its work may need re-placing.">
              <span className="pc-adv-detail__warn-chip">orphaned claims</span>
            </Tooltip>
          )}
          {agent.declaredUnclaimed && (
            <Tooltip label="Declared an intent without claiming items — invisible to fleet placement.">
              <span className="pc-adv-detail__warn-chip">declared, unclaimed</span>
            </Tooltip>
          )}
        </div>
      </header>
      <section className="pc-adv-detail__body">
        {agent.intent ? (
          <div className="pc-adv-detail__section">
            <h3>Intent</h3>
            <p className="pc-adv-detail__prose">{agent.intent}</p>
          </div>
        ) : null}
        <div className="pc-adv-detail__section">
          <h3>Working on</h3>
          {agent.doing ? (
            <div className="pc-adv-detail__related">
              <Tooltip label={agent.doing.title}>
                <button
                  type="button"
                  data-testid="agent-detail-doing"
                  className="pc-adv-detail__related-row"
                  disabled={!linkable(agent.doing.id)}
                  onClick={() => linkable(agent.doing!.id) && onSelect(agent.doing!.id)}
                >
                  <span className="pc-adv-detail__related-id">{agent.doing.id}</span>
                  <span className="pc-adv-detail__related-title">{agent.doing.title}</span>
                </button>
              </Tooltip>
              {agent.queued.length > 0 && (
                <div className="pc-adv-detail__queue">
                  {agent.queued.map((q, idx) => (
                    <button
                      key={`${q.id}-${idx}`}
                      type="button"
                      className="pc-adv-detail__queue-chip"
                      disabled={!linkable(q.id)}
                      onClick={() => linkable(q.id) && onSelect(q.id)}
                    >
                      {q.id}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <p className="pc-adv-detail__muted">Nothing claimed right now.</p>
          )}
        </div>
        {agent.claims.length > 0 && (
          <div className="pc-adv-detail__section">
            <h3>Claims ({agent.claims.length})</h3>
            <div className="pc-adv-detail__related">
              {agent.claims.map((c, idx) => (
                <div key={`${c.id ?? c.detail}-${idx}`} className="pc-adv-detail__claim-row">
                  <span className="pc-adv-detail__related-id">
                    {linkable(c.id) ? (
                      <button
                        type="button"
                        className="pc-adv-detail__link pc-adv-detail__link-btn"
                        onClick={() => onSelect(c.id!)}
                      >
                        {c.id}
                      </button>
                    ) : (
                      c.id ?? c.type
                    )}
                  </span>
                  <span className="pc-adv-detail__claim-type">{c.type}</span>
                  <span className="pc-adv-detail__related-title" title={c.detail}>{c.detail}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
      <DetailStyles />
    </div>
  );
}

/**
 * WorkItemDetail — detail for a unified WI-* work item (the rows the
 * WorkItemsPanel grid serves). Issue-family items (bug/change/task) have no
 * legacy I-* row, so this is their only detail view; mutation verbs stay on
 * the agent surface (`work_items:*`) for now. The existing Chat action (EI-290)
 * still opens the legacy worker-steer surface; P-018 adds a distinct inline
 * Discuss action backed by the durable scoped Papercup conversation.
 *
 * Exported for tests.
 */
export function WorkItemDetail({
  slug,
  workItem,
  onSelect,
  onBack,
  showChatAction = true,
  showDiscussionAction = true,
}: {
  slug: string;
  workItem: WorkItemRow;
  onSelect: (id: string) => void;
  onBack?: () => void;
  /**
   * The Working pane keeps its dock-backed Chat action. Detail-only rehosts
   * such as WorkItemPopupModal set this false because inline Discuss is now
   * the sole work-item chat entry point there.
   */
  showChatAction?: boolean;
  /** Detail-only rehosts such as WorkItemPopupModal suppress this: the
   * Working pane and Resolution Inbox own the real inline Discuss entries. */
  showDiscussionAction?: boolean;
}) {
  const [openingChat, setOpeningChat] = useState(false);
  const [, setAcceptancePlan] = useQueryState(CHAT_PLAN_POPUP_PARAM, parseAsString);
  const openChat = async () => {
    setOpeningChat(true);
    try {
      const res = await openFeatureChat({
        slug,
        role: 'worker',
        featureId: workItem.id,
        title: workItem.title,
        mode: 'discuss',
      });
      if (res && typeof res === 'object' && 'error' in res) {
        throw new Error(String((res as { error: unknown }).error));
      }
    } catch (e) {
      toast.error('Open chat failed', { description: String(e) });
    } finally {
      setOpeningChat(false);
    }
  };
  // Field values use the same canonical renderings as the WorkItemsPanel grid:
  // the kind chip, the family-aware status pill, and the severity pill.
  const fields: Array<[string, React.ReactNode]> = [
    [
      'Kind',
      <>
        <KindPill kind={workItem.kind} size="xs" />{' '}
        <span className="pc-adv-detail__muted">({workItem.family} family)</span>
      </>,
    ],
    [
      'State',
      workItem.family === 'issue' ? (
        <IssueStatusPill status={workItem.state} size="xs" />
      ) : (
        <StatusPill status={workItem.state as HarnessStatus} size="xs" />
      ),
    ],
    ['Acceptance', workItem.presentation ? WORK_ITEM_PRESENTATION_LABELS[workItem.presentation.stage] : '—'],
    ['Reason', workItem.presentation ? (() => {
      const [reason, ...detail] = workItem.presentation.reason.split(': ');
      return `${WORK_ITEM_PRESENTATION_REASONS[reason] ?? reason}${detail.length ? `: ${detail.join(': ')}` : ''}`;
    })() : '—'],
    ['Severity', workItem.severity ? <SeverityPill severity={workItem.severity} size="xs" /> : '—'],
    [
      'Assignee',
      workItem.assignee
        ? `${workItem.assignee}${workItem.assignedBy ? ` · by ${workItem.assignedBy}` : ''}`
        : '—',
    ],
    ['Priority', workItem.priority ?? '—'],
    ['Rank', workItem.rank ?? '—'],
    [
      'Stage',
      workItem.spineRole ? `${workItem.spineRole}${workItem.spineStatus ? ` (${workItem.spineStatus})` : ''}` : '—',
    ],
    [
      'Updated',
      workItem.updatedAt ? (
        // Relative age keeps the row short; the full timestamp rides title=
        // (static text, not an action element — the grid-cell carve-out).
        <span title={new Date(workItem.updatedAt).toLocaleString()}>{fmtAgo(workItem.updatedAt)}</span>
      ) : (
        '—'
      ),
    ],
  ];
  return (
    <div className="pc-adv-detail pc-adv-detail--compact">
      <header className="pc-adv-detail__header">
        <BackChip onBack={onBack} />
        <div className="pc-adv-detail__id">{workItem.id}</div>
        <div className="pc-adv-detail__title">{workItem.title}</div>
      </header>
      <div className="pc-adv-detail__body">
        <div className="pc-adv-detail__section pc-adv-detail__fields">
          {fields.map(([label, value]) => (
            <div key={label} className="pc-adv-detail__field-row">
              <span className="pc-adv-detail__field-label">{label}</span>
              <span>{value}</span>
            </div>
          ))}
          {workItem.planSlug ? (
            <div className="pc-adv-detail__field-row">
              <span className="pc-adv-detail__field-label">Plan</span>
              <button type="button" className="pc-adv-detail__link pc-adv-detail__link-btn"
                onClick={() => void setAcceptancePlan(encodeScopedRef(slug, workItem.planSlug!))}>
                {workItem.planSlug} · decisions
              </button>
            </div>
          ) : null}
        </div>
        {workItem.presentation && (workItem.presentation.evidenceRefs.length > 0 || workItem.presentation.completionRef) ? (
          <div className="pc-adv-detail__section" aria-label="Acceptance evidence">
            <h3>Acceptance evidence and completion</h3>
            {[...workItem.presentation.evidenceRefs, ...(workItem.presentation.completionRef ? [workItem.presentation.completionRef] : [])].map((ref, index) => (
              <div key={`${ref}-${index}`}>
                {/^(WI|EI|F|I|BA)-\d+$/.test(ref) ? (
                  <button type="button" className="pc-adv-detail__link pc-adv-detail__link-btn" onClick={() => onSelect(ref)}>{ref}</button>
                ) : /^https?:\/\//.test(ref) ? (
                  <a className="pc-adv-detail__link" href={ref} target="_blank" rel="noreferrer">{ref}</a>
                ) : <code className="pc-adv-detail__pointer">{ref}</code>}
              </div>
            ))}
          </div>
        ) : null}
        {workItem.summary ? (
          <div className="pc-adv-detail__section">
            <div className="pc-adv-detail__prose">{workItem.summary}</div>
          </div>
        ) : null}
        {(workItem as WorkItemRow & { payload?: { humanWork?: { route?: string } } }).payload?.humanWork?.route === 'market' ? (
          <HumanWorkSection slug={slug} id={workItem.id} refreshKey={workItem.updatedAt} />
        ) : null}
        {/* Feature-family rows keep their richer F-* detail: cross-link to it. */}
        {workItem.family === 'feature' && workItem.id.startsWith('F-') ? (
          <button type="button" className="pc-adv-detail__link pc-adv-detail__link-btn" onClick={() => onSelect(workItem.id)}>
            Open feature detail <ArrowUpRight size={12} />
          </button>
        ) : null}
        {showChatAction ? (
          <div className="pc-adv-detail__section">
            {/* Worker Chat remains distinct from the durable Papercup thread. */}
            <div className="pc-adv-detail__actions">
              <button type="button" data-testid="wi-detail-chat" disabled={openingChat} onClick={() => void openChat()}>
                <MessageCircle size={13} aria-hidden /> Chat
              </button>
            </div>
          </div>
        ) : null}
        {showDiscussionAction ? (
          <WorkItemDiscussionSection slug={slug} workItem={workItem} />
        ) : null}
        <PriorAttemptsSection slug={slug} workItem={workItem} />
        <BehaviorContractSection slug={slug} workItem={workItem} />
        <SpecAdequacySection slug={slug} workItem={workItem} />
      </div>
      {/* WorkItemDetail historically omitted this — every WI-* detail rendered
          with ZERO panel CSS (run-together label/value spans). */}
      <DetailStyles />
    </div>
  );
}

function WorkItemDiscussionSection({
  slug,
  workItem,
}: {
  slug: string;
  workItem: WorkItemRow;
}) {
  const discussButtonRef = useRef<HTMLButtonElement | null>(null);
  const [discussionRef, setDiscussionRef] = useQueryState(
    WORK_ITEM_DISCUSSION_PARAM,
    parseAsString,
  );
  const discussionTarget = useMemo(
    () => decodeScopedRef(discussionRef),
    [discussionRef],
  );
  const open =
    discussionTarget.id === workItem.id &&
    (!discussionTarget.harness || discussionTarget.harness === slug);

  return (
    <>
      <div className="pc-adv-detail__section">
        <div className="pc-adv-detail__actions">
          <button
            ref={discussButtonRef}
            type="button"
            data-testid="wi-detail-discuss"
            aria-expanded={open}
            aria-controls={`work-item-discussion-${workItem.id}`}
            onClick={() =>
              void setDiscussionRef(open ? null : encodeScopedRef(slug, workItem.id))
            }
          >
            <MessageCircle size={13} aria-hidden /> Discuss with Papercup
          </button>
        </div>
      </div>
      {open ? (
        <WorkItemDiscussion
          harnessSlug={slug}
          workItemId={workItem.id}
          title={workItem.title}
          onClose={() => {
            // Focus the stable toggle before the discussion's focused Close
            // button unmounts; clearing the URL after that preserves focus.
            discussButtonRef.current?.focus({ preventScroll: true });
            void setDiscussionRef(null);
          }}
        />
      ) : null}
    </>
  );
}

/** nuqs, not useState: panel open-state is user-meaningful and must be agent-readable
 *  (ui:get_state / ui:dispatch read the URL). Scoped ref so the section follows the
 *  selected item, exactly like WORK_ITEM_DISCUSSION_PARAM above. */
const WORK_ITEM_PRIOR_ATTEMPTS_PARAM = 'wipa';

type PriorAttemptsBriefRecord = {
  authority: string;
  scope: string;
  rawRef: string;
  at?: string | null;
  text: string;
  textTruncated?: boolean;
  fullTextChars?: number;
};

type PriorAttemptsRow = {
  workItemId: string;
  brief: {
    fingerprint: string;
    authority: PriorAttemptsBriefRecord[];
    attempts: PriorAttemptsBriefRecord[];
    residue: Array<{ rawRef: string; items: string[] }>;
    omission: {
      omittedRecords: number;
      omittedRefs: Array<{ authority: string; scope: string; rawRef: string }>;
      omittedRefsTruncated: boolean;
      sourceCount: number;
    };
    estimatedTokens: number;
  } | null;
  // WI-2142613 removed 'no-plan-pointer': post-P-018 an item with no plan compiles its
  // own `self` rung, so a null brief always means the collector failed.
  unavailableReason: 'work-item-not-found' | 'collector-unavailable' | null;
};

/**
 * P-017 slice D — "Prior attempts": what was ALREADY TRIED on this item's plan lane.
 *
 * The brief has been computed at claim time since P-010, but it was handed to the
 * claiming agent and then discarded, so a human (or a compacted successor) could only
 * re-obtain it by CLAIMING the item — a write with side effects. This renders the same
 * port read-only.
 *
 * Collapsed by default and gated with `enabled`: the collector is multi-table under a
 * 2.5s budget, so nothing is computed until someone opens it.
 */
function PriorAttemptsSection({
  slug,
  workItem,
}: {
  slug: string;
  workItem: WorkItemRow;
}) {
  const [openRef, setOpenRef] = useQueryState(
    WORK_ITEM_PRIOR_ATTEMPTS_PARAM,
    parseAsString,
  );
  const target = useMemo(() => decodeScopedRef(openRef), [openRef]);
  const open =
    target.id === workItem.id && (!target.harness || target.harness === slug);

  const query = useSyncQuery<PriorAttemptsRow>({
    queryName: 'workItems.priorAttempts',
    args: { harnessSlug: slug, workItemId: workItem.id },
    enabled: open && Boolean(slug) && Boolean(workItem.id),
  });
  const row = query.loading ? null : (query.data?.[0] ?? null);
  const brief = row?.brief ?? null;

  return (
    <>
      <div className="pc-adv-detail__section">
        <div className="pc-adv-detail__actions">
          <button
            type="button"
            data-testid="wi-detail-prior-attempts"
            aria-expanded={open}
            aria-controls={`work-item-prior-attempts-${workItem.id}`}
            onClick={() =>
              void setOpenRef(open ? null : encodeScopedRef(slug, workItem.id))
            }
          >
            Prior attempts{brief ? ` (${brief.attempts.length})` : ''}
          </button>
        </div>
      </div>
      {open ? (
        <div
          id={`work-item-prior-attempts-${workItem.id}`}
          className="pc-adv-detail__section"
        >
          {query.loading ? (
            <div className="det-label">Compiling prior-attempt brief…</div>
          ) : !brief ? (
            /* NEVER render this as "nothing was tried".
               WI-2142613 deleted the 'no-plan-pointer' arm that used to sit here. It
               said "No plan lane on this item — there is no prior-attempt history to
               compile", which P-018 made false: an item with no plan now compiles its
               own `self` rung, so that string told 94% of items nothing was tried while
               actually hiding a collector failure — the exact thing this comment
               forbids. A null brief now has one meaning, so it gets one message. */
            <div className="det-label" data-testid="wi-prior-attempts-unavailable">
              {row?.unavailableReason === 'work-item-not-found'
                ? 'Work item not found in this harness.'
                : 'Prior-attempt brief unavailable (the collector timed out or errored). This is NOT evidence that nothing was tried.'}
            </div>
          ) : (
            <>
              {brief.authority.length > 0 ? (
                <PriorAttemptRecordList
                  title="Governing (current spec, decisions, retractions)"
                  records={brief.authority}
                />
              ) : null}
              {brief.attempts.length > 0 ? (
                <PriorAttemptRecordList title="Attempts" records={brief.attempts} />
              ) : (
                <div className="det-label">
                  No prior attempts recorded on this lane.
                </div>
              )}
              {brief.residue.length > 0 ? (
                <div>
                  <div className="det-label">Residue (left behind by earlier work)</div>
                  {brief.residue.map((r) => (
                    <div key={r.rawRef}>
                      {r.items.map((it, i) => (
                        <div key={`${r.rawRef}:${i}`}>• {it}</div>
                      ))}
                    </div>
                  ))}
                </div>
              ) : null}
              {/* The omission block is the point of slice A/B: history the budget
                  dropped is NAMED, not just counted, so the reader can audit it. */}
              {brief.omission.omittedRecords > 0 ? (
                <div data-testid="wi-prior-attempts-omissions">
                  <div className="det-label">
                    {brief.omission.omittedRecords} of {brief.omission.sourceCount} record(s)
                    omitted by the budget
                    {brief.omission.omittedRefsTruncated
                      ? ' — and the omitted-ref list itself was truncated'
                      : ''}
                  </div>
                  {brief.omission.omittedRefs.map((o) => (
                    <div key={o.rawRef} title={`${o.authority} · ${o.scope}`}>
                      • {o.rawRef}
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="det-label">
                ~{brief.estimatedTokens} tokens · fingerprint {brief.fingerprint.slice(0, 12)}
              </div>
            </>
          )}
        </div>
      ) : null}
    </>
  );
}

/** nuqs, not useState — same agent-readability rule as the two sections above. */
const WORK_ITEM_BEHAVIOR_CONTRACT_PARAM = 'wibc';

type BehaviorContractClauseRow = {
  specId: string;
  revision: number;
  planItemId: string;
  behavior: string;
  behaviorClass: string;
  lifecycleStatus: string;
  enforceable: boolean;
  falsifier: { observation: string; probeMethod?: string } | null;
  mutationRequired: boolean;
};

type BehaviorContractRow = {
  workItemId: string;
  groups: Array<{
    planSlug: string;
    via: 'edge' | 'plan-stamp' | 'edge+plan-stamp';
    clauses: BehaviorContractClauseRow[];
    staleEdges: Array<{ specId: string; edgeRevision: number; currentRevision: number }>;
  }>;
  enforceableCount: number;
  stampedPlanSlug: string | null;
  impact: {
    required: boolean;
    resolved: boolean;
    report: string | null;
    reason: 'observation-lane' | 'non-behavior-changing' | 'resolved' | 'unresolved';
  } | null;
  unavailableReason: 'work-item-not-found' | 'resolver-unavailable' | null;
};

/**
 * P-011 — "Behavior contract": WHICH promises this item is on the hook for, and at
 * WHICH revision.
 *
 * P-016 made applicability behavior-owned rather than plan-owned, so a standalone bug
 * resolves clauses and an edge into another plan's namespace is visible — but all of
 * that was legible only to the completion gate. A human could see THAT a completion was
 * refused, never WHICH clause or which revision.
 *
 * ⚠ EVERYTHING HERE IS ADVISORY (plan D-017/D-018). The resolver REPORTS; P-013 owns
 * turning any of it into a refusal. So `impact.report`, cross-namespace groups and
 * stale edges are rendered as NOTICES — never as errors — because showing a human a
 * blocking-looking failure for a clause no gate blocks on is precisely the mistake
 * D-017 was written to prevent.
 *
 * Collapsed by default and `enabled`-gated: resolution reads edges, then clauses per
 * namespace.
 */
function BehaviorContractSection({
  slug,
  workItem,
}: {
  slug: string;
  workItem: WorkItemRow;
}) {
  const [openRef, setOpenRef] = useQueryState(
    WORK_ITEM_BEHAVIOR_CONTRACT_PARAM,
    parseAsString,
  );
  const target = useMemo(() => decodeScopedRef(openRef), [openRef]);
  const open =
    target.id === workItem.id && (!target.harness || target.harness === slug);

  const query = useSyncQuery<BehaviorContractRow>({
    queryName: 'workItems.behaviorContract',
    args: { harnessSlug: slug, workItemId: workItem.id },
    enabled: open && Boolean(slug) && Boolean(workItem.id),
  });
  const row = query.loading ? null : (query.data?.[0] ?? null);
  const staleEdgeCount =
    row?.groups.reduce((n, g) => n + g.staleEdges.length, 0) ?? 0;

  return (
    <>
      <div className="pc-adv-detail__section">
        <div className="pc-adv-detail__actions">
          <button
            type="button"
            data-testid="wi-detail-behavior-contract"
            aria-expanded={open}
            aria-controls={`work-item-behavior-contract-${workItem.id}`}
            onClick={() =>
              void setOpenRef(open ? null : encodeScopedRef(slug, workItem.id))
            }
          >
            Behavior contract
            {row ? ` (${row.enforceableCount})` : ''}
          </button>
        </div>
      </div>
      {open ? (
        <div
          id={`work-item-behavior-contract-${workItem.id}`}
          className="pc-adv-detail__section"
        >
          {query.loading ? (
            <div className="det-label">Resolving behavior contract…</div>
          ) : !row || row.unavailableReason ? (
            /* An empty contract and a FAILED resolve are different facts. Never let a
               resolver error render as "this item promises nothing". */
            <div className="det-label" data-testid="wi-behavior-contract-unavailable">
              {row?.unavailableReason === 'work-item-not-found'
                ? 'Work item not found in this harness.'
                : 'Behavior contract unavailable (the resolver errored). This is NOT evidence that the item resolves no clauses.'}
            </div>
          ) : (
            <>
              {staleEdgeCount > 0 ? (
                <div data-testid="wi-behavior-contract-stale">
                  <div className="det-label">
                    ⚠ {staleEdgeCount} coverage claim(s) pinned to a SUPERSEDED revision —
                    advisory, nothing enforces this yet
                  </div>
                  {row.groups.flatMap((g) =>
                    g.staleEdges.map((e) => (
                      <div key={`${g.planSlug}:${e.specId}`}>
                        • {g.planSlug} / {e.specId}: proof at r{e.edgeRevision}, clause now
                        r{e.currentRevision}
                      </div>
                    )),
                  )}
                </div>
              ) : null}

              {row.groups.length === 0 ? (
                <div className="det-label">
                  This item resolves no behavior clauses.
                  {row.stampedPlanSlug
                    ? ` Its plan lane (${row.stampedPlanSlug}) has none linked.`
                    : ' It is standalone — link one with plans:set-spec-evidence.'}
                </div>
              ) : (
                row.groups.map((group) => (
                  <div key={group.planSlug}>
                    <div className="det-label">
                      {group.planSlug}
                      {group.planSlug === row.stampedPlanSlug ? ' (own plan)' : ''} · via{' '}
                      {group.via}
                    </div>
                    {group.clauses.map((c) => (
                      <div key={`${group.planSlug}:${c.specId}`}>
                        {/* The REVISION never leaves the specId's side: a coverage claim
                            without the revision it was earned against is the thing this
                            plan exists to end. */}
                        <div>
                          <strong>
                            {c.specId}@r{c.revision}
                          </strong>{' '}
                          · {c.lifecycleStatus}
                          {c.enforceable ? '' : ' (not enforceable)'} · {c.behaviorClass}
                          {c.mutationRequired ? ' · mutation-required' : ''}
                        </div>
                        <div>{c.behavior}</div>
                        {/* D-016: an undeclared falsifier is an honest gap, shown as one
                            — never blank, which would read as "declared". */}
                        <div className="det-label">
                          {c.falsifier
                            ? `Falsified by: ${c.falsifier.observation}${
                                c.falsifier.probeMethod
                                  ? ` (probe: ${c.falsifier.probeMethod})`
                                  : ''
                              }`
                            : 'No falsifier declared (D-016 gap — not a passing clause)'}
                        </div>
                      </div>
                    ))}
                  </div>
                ))
              )}

              {/* ADVISORY, and labelled as such in the copy itself. D-017 is explicit:
                  a populated report is NOT a refusal. */}
              {row.impact?.report ? (
                <div data-testid="wi-behavior-contract-impact">
                  <div className="det-label">Advisory — reported, not enforced</div>
                  <div>{row.impact.report}</div>
                </div>
              ) : null}
              {row.impact && !row.impact.required ? (
                <div className="det-label">
                  {row.impact.reason === 'observation-lane'
                    ? 'Observation-lane item — a candidate input, never enforceable (D-012).'
                    : 'Not a behavior-changing kind, so no clause resolution is required.'}
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </>
  );
}

/** nuqs, not useState — same agent-readability rule as the sections above. */
const WORK_ITEM_SPEC_ADEQUACY_PARAM = 'wisa';

type SpecAdequacyClauseRow = {
  specId: string;
  revision: number;
  behaviorClass: string;
  mutationRequired: boolean;
  requiredTestLayers: string[];
  requiredProofFloor: 'none' | 'l3' | 'l4' | null;
};

type SpecAdequacyRow = {
  workItemId: string;
  rubricRef: string;
  classRef: string | null;
  attestationSupplied: boolean;
  verdict: {
    ok: boolean;
    applicable: boolean;
    checked: string[];
    blockerReason: string | null;
    impactReport: string | null;
  };
  verdictIsLowerBound: boolean;
  clauses: SpecAdequacyClauseRow[];
  unavailableReason: 'work-item-not-found' | 'resolver-unavailable' | null;
};

/**
 * P-011 — "Close gate": which RUBRIC governs this item's completion, what that rubric's
 * gate currently decides, and the EXACT blocker it would emit.
 *
 * `specTestAdequacyCompletionGate` is a HARD gate on work_items:complete (P-007), but its
 * verdict was reachable only by ATTEMPTING the close — a write with side effects — and the
 * refusal names a rubric there was no read for. This runs the same gate, read-only.
 *
 * ⚠⚠ THE VERDICT IS A LOWER BOUND, NEVER A FAILURE (D-020). The gate grades `freshness`
 * against fingerprints the CALLER attests at close time about its own working tree; a read
 * cannot have them and must not invent them, so currentness comes back `unknown` —
 * deliberately not `stale`. An `unknown` here means "a read cannot establish this", never
 * "this clause FAILS".
 *
 * That is why the blocker below is rendered as a NOTICE and never as an error, and why the
 * lower-bound caveat is stated in the copy rather than left to a reader to infer: showing a
 * hard failure for evidence that may be perfectly current is exactly the mistake D-020 was
 * written to prevent — the same rule D-017 applies to advisory reports, one level deeper.
 *
 * Collapsed by default and `enabled`-gated: the gate resolves the contract, then reads
 * evidence, then scorecards.
 */
function SpecAdequacySection({
  slug,
  workItem,
}: {
  slug: string;
  workItem: WorkItemRow;
}) {
  const [openRef, setOpenRef] = useQueryState(WORK_ITEM_SPEC_ADEQUACY_PARAM, parseAsString);
  const target = useMemo(() => decodeScopedRef(openRef), [openRef]);
  const open =
    target.id === workItem.id && (!target.harness || target.harness === slug);

  const query = useSyncQuery<SpecAdequacyRow>({
    queryName: 'workItems.specAdequacy',
    // classRef is deliberately NOT sent: with it absent the gate returns its real first
    // refusal, which names the clauses needing attestation — the answer a reader opening
    // this section actually wants, and one they would otherwise get only by being refused.
    args: { harnessSlug: slug, workItemId: workItem.id },
    enabled: open && Boolean(slug) && Boolean(workItem.id),
  });
  const row = query.loading ? null : (query.data?.[0] ?? null);

  return (
    <>
      <div className="pc-adv-detail__section">
        <div className="pc-adv-detail__actions">
          <button
            type="button"
            data-testid="wi-detail-spec-adequacy"
            aria-expanded={open}
            aria-controls={`work-item-spec-adequacy-${workItem.id}`}
            onClick={() =>
              void setOpenRef(open ? null : encodeScopedRef(slug, workItem.id))
            }
          >
            Close gate
            {row?.verdict.applicable ? ` (${row.clauses.length})` : ''}
          </button>
        </div>
      </div>
      {open ? (
        <div
          id={`work-item-spec-adequacy-${workItem.id}`}
          className="pc-adv-detail__section"
        >
          {query.loading ? (
            <div className="det-label">Running the close gate…</div>
          ) : !row || row.unavailableReason ? (
            /* "The gate does not judge this item" and "the gate could not be run" are
               different facts, and both render as no blockers. Never let the second read
               as a clean bill of health on a HARD gate. */
            <div className="det-label" data-testid="wi-spec-adequacy-unavailable">
              {row?.unavailableReason === 'work-item-not-found'
                ? 'Work item not found in this harness.'
                : 'Close gate unavailable (the gate errored). This is NOT evidence that the close is clear.'}
            </div>
          ) : !row.verdict.applicable ? (
            <div className="det-label" data-testid="wi-spec-adequacy-inapplicable">
              The spec-test-adequacy gate does not apply to this item — it resolves no
              enforceable clause that requires proof.
            </div>
          ) : (
            <>
              <div className="det-label">
                Rubric: <strong>{row.rubricRef}</strong>
                {row.classRef ? ` · graded as ${row.classRef}` : ' · no plan class supplied'}
              </div>

              {/* D-020, stated in the copy — not left for a reader to infer from a field
                  name. This is the whole reason the section is safe to show. */}
              {row.verdictIsLowerBound ? (
                <div className="det-label" data-testid="wi-spec-adequacy-lower-bound">
                  ⓘ Lower bound: a read cannot attest working-tree fingerprints, so
                  freshness reads as UNESTABLISHED rather than failed. Supplying the
                  attestation at close time can only move a clause toward passing.
                </div>
              ) : null}

              {row.verdict.blockerReason ? (
                <div data-testid="wi-spec-adequacy-blocker">
                  <div className="det-label">
                    Would block the close — exact gate text, verbatim:
                  </div>
                  <div>{row.verdict.blockerReason}</div>
                </div>
              ) : (
                <div className="det-label" data-testid="wi-spec-adequacy-clear">
                  No blocker at this reading
                  {row.verdict.checked.length
                    ? ` · accepted: ${row.verdict.checked.join(', ')}`
                    : ''}
                </div>
              )}

              {row.clauses.length ? (
                <div>
                  <div className="det-label">Enforced clauses and their proof floor</div>
                  {row.clauses.map((c) => (
                    <div key={c.specId}>
                      {/* The revision never leaves the specId's side — same rule as the
                          behavior-contract section above. */}
                      <strong>
                        {c.specId}@r{c.revision}
                      </strong>{' '}
                      · {c.behaviorClass}
                      {c.mutationRequired ? ' · mutation-required' : ''} ·{' '}
                      {c.requiredProofFloor
                        ? `floor ${c.requiredProofFloor.toUpperCase()}`
                        : 'floor depends on the plan class (none supplied)'}
                      {c.requiredTestLayers.length
                        ? ` · layers ${c.requiredTestLayers.join(', ')}`
                        : ''}
                    </div>
                  ))}
                </div>
              ) : null}

              {/* ADVISORY (D-017) and populated independently of the verdict, so it is
                  labelled as a notice even when the gate is otherwise satisfied. */}
              {row.verdict.impactReport ? (
                <div data-testid="wi-spec-adequacy-impact">
                  <div className="det-label">Advisory — reported, not enforced</div>
                  <div>{row.verdict.impactReport}</div>
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </>
  );
}

function PriorAttemptRecordList({
  title,
  records,
}: {
  title: string;
  records: PriorAttemptsBriefRecord[];
}) {
  return (
    <div>
      <div className="det-label">{title}</div>
      {records.map((r) => (
        <div key={r.rawRef}>
          <div>
            <strong>{r.authority}</strong> · {r.scope}
            {r.at ? ` · ${r.at}` : ''}
          </div>
          <div>
            {r.text}
            {/* A clipped body must be visibly clipped: a retraction living past the
                cut would otherwise read as endorsement. */}
            {r.textTruncated ? (
              <em>
                {' '}
                […clipped{r.fullTextChars ? ` from ${r.fullTextChars} chars` : ''} —
                resolve {r.rawRef} for the full text]
              </em>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function BackChip({ onBack }: { onBack?: () => void }) {
  if (!onBack) return null;
  return (
    <Tooltip label="Back to previous selection">
      <button type="button" className="pc-adv-detail__back" onClick={onBack}>
        ← Back
      </button>
    </Tooltip>
  );
}

function FeatureDetail({
  slug,
  feature,
  issues,
  runs,
  onSelect,
  onBack,
  patchFeature,
  isEditing,
  onStartEdit,
  onCloseEdit,
}: {
  slug: string;
  feature: HarnessFeature;
  issues: Issue[];
  runs: RunRow[];
  onSelect: (id: string) => void;
  onBack?: () => void;
  patchFeature: (id: string, partial: Partial<HarnessFeature>) => void;
  isEditing: boolean;
  onStartEdit: () => void;
  onCloseEdit: () => void;
}) {
  const lex = useLexicon();
  const [working, setWorking] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[] | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const [steerNote, setSteerNote] = useState('');
  const { confirm, element: confirmEl } = useConfirmDialog();
  const notesSync = useSyncQuery<{ featureId: string; content: string }>({
    queryName: 'featureNotes.byHarness',
    args: { harnessSlug: slug },
    enabled: !!slug,
    staleTime: 30_000,
  });
  const syncedNote = notesSync.data?.find((row) => row.featureId === feature.id);

  // Add a steer note for the worker — POSTs a block to .papercusp/notes/<id>.md
  // (the OperatorNoteForm contract). Optimistically appends to the local list.
  const addSteerNote = useCallback(async () => {
    const content = steerNote.trim();
    if (!content) return;
    setWorking('steer');
    try {
      const res = await fetch(`/api/harness/${encodeURIComponent(slug)}/features/${encodeURIComponent(feature.id)}/notes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      setNotes((prev) => [...(prev ?? []), content]); // optimistic append
      notesSync.invalidate();
      setSteerNote('');
      setNotesOpen(true);
      toast.success('Steer note added');
    } catch (e) {
      toast.error('Add steer note failed', { description: String(e) });
    } finally {
      setWorking(null);
    }
  }, [feature.id, notesSync, slug, steerNote]);

  // Issues filed against this feature: linked as the fix (linkedFeatureId) or
  // found while working on it (foundDuring).
  const relatedIssues = useMemo(
    () => issues.filter((i) => i.linkedFeatureId === feature.id || i.foundDuring === feature.id),
    [issues, feature.id],
  );
  // Recent agent runs for this feature (consolidated row carries feature_id).
  const featureRuns = useMemo(
    () =>
      runs
        .filter((r) => r.featureId === feature.id)
        .sort((a, b) => Date.parse(String(b.ts)) - Date.parse(String(a.ts)))
        .slice(0, 3),
    [runs, feature.id],
  );

  useEffect(() => {
    if (notesSync.loading) {
      setNotes(null);
      return;
    }
    setNotes(noteBodies(syncedNote?.content ?? ''));
  }, [notesSync.loading, syncedNote?.content]);

  const callJson = useCallback(
    async (path: string, init?: RequestInit) => {
      const res = await fetch(`/api/harness/${encodeURIComponent(slug)}${path}`, init);
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      return res.json();
    },
    [slug],
  );

  const setStatus = useCallback(
    async (next: FeatureStatus) => {
      const prev = feature.status;
      patchFeature(feature.id, { status: next }); // optimistic
      setWorking(`status:${next}`);
      try {
        await callJson(`/features/${feature.id}?phase=staging`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status: next }),
        });
        toast.success(`${feature.id} → ${next}`);
      } catch (e) {
        patchFeature(feature.id, { status: prev }); // rollback
        toast.error('Status change failed', { description: String(e) });
      } finally {
        setWorking(null);
      }
    },
    [callJson, feature.id, feature.status, patchFeature],
  );

  const resetFeature = useCallback(async () => {
    if (
      !(await confirm({
        title: `Reset ${feature.id}?`,
        body: `Reset ${feature.id} back to open and clear its attempts. The worker will pick it up fresh.`,
        destructive: true,
        confirmLabel: 'Reset',
      }))
    )
      return;
    const prev = { status: feature.status, attempts: feature.attempts };
    patchFeature(feature.id, { status: 'open', attempts: 0 }); // optimistic (matches the reset endpoint)
    setWorking('reset');
    try {
      await callJson(`/features/${feature.id}/reset?phase=staging`, { method: 'POST' });
      toast.success(`${feature.id} reset`);
    } catch (e) {
      patchFeature(feature.id, prev); // rollback
      toast.error('Reset failed', { description: String(e) });
    } finally {
      setWorking(null);
    }
  }, [callJson, feature.id, feature.status, feature.attempts, patchFeature, confirm]);

  // Edit mode — render the full FeatureEditor inline in this pane.
  if (isEditing) {
    return (
      <FeatureEditor
        embedded
        slug={slug}
        feature={{
          id: feature.id,
          title: feature.title,
          claims: feature.claims,
          status: feature.status,
          attempts: feature.attempts ?? 0,
        }}
        onClose={onCloseEdit}
        onSaved={() => {}}
      />
    );
  }

  return (
    <div className="pc-adv-detail">
      <header className="pc-adv-detail__header">
        <BackChip onBack={onBack} />
        <div className="pc-adv-detail__id">{feature.id}</div>
        <div className="pc-adv-detail__title">{feature.title}</div>
        <div className="pc-adv-detail__meta">
          <StatusPill status={feature.status as HarnessStatus} />
          {typeof feature.attempts === 'number' && feature.attempts > 0 && (
            <span className="pc-adv-detail__attempts">{feature.attempts}× attempts</span>
          )}
          {feature.sourcePlanSlug && (
            <Tooltip label={`From plan: ${feature.sourcePlanSlug}`}>
              <span className="pc-adv-detail__plan">↗ {feature.sourcePlanSlug}</span>
            </Tooltip>
          )}
        </div>
      </header>

      <section className="pc-adv-detail__body">
        <div className="pc-adv-detail__section">
          <h3>Description</h3>
          {feature.summary ? (
            <p className="pc-adv-detail__prose">{feature.summary}</p>
          ) : (
            <p className="pc-adv-detail__muted">No description.</p>
          )}
        </div>

        <div className="pc-adv-detail__section">
          <h3>Status</h3>
          <div className="pc-adv-detail__status-row">
            <Select
              value={feature.status}
              onChange={(v) => void setStatus(v as FeatureStatus)}
              disabled={working !== null}
              ariaLabel="Change status"
              triggerClassName="pc-adv-detail__select"
              options={FEATURE_STATUSES.map((s) => ({
                value: s,
                label: <StatusPill status={s as HarnessStatus} size="xs" />,
              }))}
            />
          </div>
        </div>

        {relatedIssues.length > 0 && (
          <div className="pc-adv-detail__section">
            <h3>Issues ({relatedIssues.length})</h3>
            <div className="pc-adv-detail__related">
              {relatedIssues.map((i) => (
                <Tooltip key={i.id} label={i.title}>
                  <button
                    type="button"
                    className="pc-adv-detail__related-row"
                    onClick={() => onSelect(i.id)}
                  >
                    <span className="pc-adv-detail__related-id">{i.id}</span>
                    <span
                      className="pc-adv-detail__related-dot"
                      style={{ background: SEVERITY[i.severity as IssueSeverityKey].solid }}
                    />
                    <span className="pc-adv-detail__related-title">{i.title}</span>
                  </button>
                </Tooltip>
              ))}
            </div>
          </div>
        )}

        <div className="pc-adv-detail__section">
          <h3>Recent activity</h3>
          {featureRuns.length === 0 ? (
            <p className="pc-adv-detail__muted">No agent runs for this feature yet.</p>
          ) : (
            <div className="pc-adv-detail__runs">
              {featureRuns.map((r) => {
                // P-023: outcome chip + error line from the joined spawn row;
                // "Open session" resumes the run's recorded Claude session in
                // a terminal (the launch-su resume path).
                const outcome = runOutcome(r);
                return (
                  <div key={r.runId} className="pc-adv-detail__run-block">
                    <div className="pc-adv-detail__run">
                      <span className="pc-adv-detail__run-role">{agentRoleLabel(r.role, lex)}</span>
                      <span className="pc-adv-detail__run-time">{fmtAgo(r.ts)}</span>
                      <span className="pc-adv-detail__run-right">
                        {r.costUsd != null && Number(r.costUsd) > 0 && (
                          <span className="pc-adv-detail__run-cost">${Number(r.costUsd).toFixed(2)}</span>
                        )}
                        {outcome && (
                          <span
                            className={`pc-adv-detail__run-outcome is-${outcome.kind}`}
                            title={outcome.detail}
                          >
                            {outcome.label}
                          </span>
                        )}
                        {r.sessionId && (
                          <Tooltip label="Open this run's agent session in a terminal (claude --resume)">
                            <button
                              type="button"
                              className="pc-adv-detail__run-open"
                              onClick={() => void openRunSession(slug, r.sessionId!)}
                            >
                              Open session
                            </button>
                          </Tooltip>
                        )}
                      </span>
                    </div>
                    {outcome?.kind === 'failed' && outcome.detail && (
                      <div className="pc-adv-detail__run-error" title={outcome.detail}>
                        {outcome.detail}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="pc-adv-detail__section">
          <h3>
            <button type="button" className="pc-adv-detail__collapse" onClick={() => setNotesOpen((o) => !o)}>
              {notesOpen ? '▾' : '▸'} Steer notes{notes && notes.length > 0 ? ` (${notes.length})` : ''}
            </button>
          </h3>
          {notesOpen && (
            <>
              {notes && notes.length > 0 && (
                <div className="pc-adv-detail__notes">
                  {notes.map((n, idx) => (
                    <p key={idx} className="pc-adv-detail__note">
                      {n}
                    </p>
                  ))}
                </div>
              )}
              <div className="pc-adv-detail__note-form">
                <textarea
                  value={steerNote}
                  onChange={(e) => setSteerNote(e.target.value)}
                  placeholder="Add a steer note for the worker…"
                  rows={2}
                  aria-label="Add a steer note"
                />
                <button type="button" disabled={working !== null || !steerNote.trim()} onClick={() => void addSteerNote()}>
                  Add steer note
                </button>
              </div>
            </>
          )}
        </div>

        <div className="pc-adv-detail__section">
          <h3>Actions</h3>
          <div className="pc-adv-detail__actions">
            <button
              type="button"
              disabled={working !== null}
              onClick={async () => {
                setWorking('chat');
                try {
                  const res = await openFeatureChat({
                    slug,
                    role: 'worker',
                    featureId: feature.id,
                    title: feature.summary || feature.title,
                    mode: 'discuss',
                  });
                  if (res && typeof res === 'object' && 'error' in res) {
                    throw new Error(String((res as { error: unknown }).error));
                  }
                } catch (e) {
                  toast.error('Open chat failed', { description: String(e) });
                } finally {
                  setWorking(null);
                }
              }}
            >
              <MessageCircle size={13} aria-hidden /> Chat
            </button>
            <button type="button" disabled={working !== null} onClick={resetFeature}>
              Reset
            </button>
            <button type="button" disabled={working !== null} onClick={onStartEdit}>
              Edit
            </button>
          </div>
        </div>
      </section>
      {confirmEl}
      <DetailStyles />
    </div>
  );
}

function IssueDetail({
  slug,
  issue,
  onSelect,
  onBack,
  patchIssue,
}: {
  slug: string;
  issue: Issue;
  onSelect: (id: string) => void;
  onBack?: () => void;
  patchIssue: (id: string, partial: Partial<Issue>) => void;
}) {
  const [working, setWorking] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [extraNotes, setExtraNotes] = useState<IssueNote[]>([]);

  // Reset optimistic notes when the selected issue changes.
  useEffect(() => {
    setExtraNotes([]);
  }, [issue.id]);

  const allNotes = useMemo(() => [...(issue.notes ?? []), ...extraNotes], [issue.notes, extraNotes]);

  const runAction = useCallback(
    async (action: IssueActionKind) => {
      const target = issueActionStatus(action); // null for promote (server-computed)
      const prev = issue.status;
      if (target) patchIssue(issue.id, { status: target }); // optimistic
      setWorking(action);
      try {
        await issueAction(slug, issue.id, action);
        toast.success(`${issue.id} → ${action}`);
      } catch (e) {
        if (target) patchIssue(issue.id, { status: prev }); // rollback
        toast.error(`${action} failed`, { description: String(e) });
      } finally {
        setWorking(null);
      }
    },
    [slug, issue.id, issue.status, patchIssue],
  );

  const addNote = useCallback(async () => {
    const text = note.trim();
    if (!text) return;
    setWorking('note');
    try {
      const res = await fetch(`/api/harness/${encodeURIComponent(slug)}/issues/${encodeURIComponent(issue.id)}/update`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ note: text, by: 'human' }),
      });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      // Optimistic: Zero will also push the updated issue, but show it now.
      setExtraNotes((prev) => [...prev, { ts: new Date().toISOString(), by: 'human', text }]);
      setNote('');
      toast.success('Note added');
    } catch (e) {
      toast.error('Add note failed', { description: String(e) });
    } finally {
      setWorking(null);
    }
  }, [slug, issue.id, note]);

  return (
    <div className="pc-adv-detail">
      <header className="pc-adv-detail__header">
        <BackChip onBack={onBack} />
        <div className="pc-adv-detail__id">{issue.id}</div>
        <div className="pc-adv-detail__title">{issue.title}</div>
        <div className="pc-adv-detail__meta">
          <SeverityPill severity={issue.severity} />
          <IssueStatusPill status={issue.status} />
          {issue.linkedFeatureId && (
            <Tooltip label={`Go to linked feature ${issue.linkedFeatureId}`}>
              <button
                type="button"
                className="pc-adv-detail__link pc-adv-detail__link-btn"
                onClick={() => onSelect(issue.linkedFeatureId!)}
              >
                <ArrowUpRight size={11} aria-hidden /> {issue.linkedFeatureId}
              </button>
            </Tooltip>
          )}
        </div>
      </header>
      <section className="pc-adv-detail__body">
        {issue.evidence && (
          <div className="pc-adv-detail__section">
            <h3>Evidence</h3>
            <pre className="pc-adv-detail__code">{issue.evidence}</pre>
          </div>
        )}
        {issue.repro && (
          <div className="pc-adv-detail__section">
            <h3>Reproduction</h3>
            <pre className="pc-adv-detail__code">{issue.repro}</pre>
          </div>
        )}
        {issue.suggestedFix && (
          <div className="pc-adv-detail__section">
            <h3>Suggested fix</h3>
            <pre className="pc-adv-detail__code">{issue.suggestedFix}</pre>
          </div>
        )}
        {issue.codePointer && (
          <div className="pc-adv-detail__section">
            <h3>Code pointer</h3>
            <code className="pc-adv-detail__pointer">{issue.codePointer}</code>
          </div>
        )}

        <div className="pc-adv-detail__section">
          <h3>Notes{allNotes.length > 0 ? ` (${allNotes.length})` : ''}</h3>
          {allNotes.length > 0 && (
            <div className="pc-adv-detail__notes">
              {allNotes.map((n, idx) => (
                <div key={idx} className="pc-adv-detail__note-row">
                  <div className="pc-adv-detail__note-meta">
                    {n.by} · {n.ts ? new Date(n.ts).toLocaleString() : ''}
                  </div>
                  <p className="pc-adv-detail__note">{n.text}</p>
                </div>
              ))}
            </div>
          )}
          <div className="pc-adv-detail__note-form">
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Add a note…"
              rows={2}
              aria-label="Add a note"
            />
            <button type="button" disabled={working !== null || !note.trim()} onClick={() => void addNote()}>
              Add note
            </button>
          </div>
        </div>

        <div className="pc-adv-detail__section">
          <h3>Actions</h3>
          <div className="pc-adv-detail__actions">
            {!issue.linkedFeatureId && issue.status !== 'closed' && issue.status !== 'wontfix' && (
              <button type="button" disabled={working !== null} onClick={() => void runAction('promote')}>
                Promote
              </button>
            )}
            {issue.status !== 'acknowledged' && issue.status !== 'closed' && (
              <button type="button" disabled={working !== null} onClick={() => void runAction('acknowledge')}>
                Acknowledge
              </button>
            )}
            {issue.status !== 'closed' && (
              <button type="button" disabled={working !== null} onClick={() => void runAction('close')}>
                Close
              </button>
            )}
            {issue.status !== 'wontfix' && (
              <button type="button" disabled={working !== null} onClick={() => void runAction('wontfix')}>
                Won't fix
              </button>
            )}
          </div>
        </div>
      </section>
      <DetailStyles />
    </div>
  );
}

function Empty({ children, tone }: { children: React.ReactNode; tone?: 'error' }) {
  return (
    <div
      // Stable, addressable class for the empty/placeholder state — deliberately NOT
      // `.pc-adv-detail` (that root only mounts once an item is actually selected; see
      // EI-19917451944474469 comment: `.pc-adv-detail` presence/absence is itself a
      // measured, intentional signal of "something is selected", so this state must not
      // fake that root). Without a class here the placeholder is anonymous and only
      // reachable by fragile page-wide text search.
      className={`pc-adv-detail__empty${tone === 'error' ? ' pc-adv-detail__empty--error' : ''}`}
      style={{
        height: '100%',
        display: 'grid',
        placeItems: 'center',
        padding: 24,
        color: tone === 'error' ? 'var(--bad, #fb7185)' : 'var(--fg-mute, #7f9bb4)',
        fontSize: 13,
        textAlign: 'center',
      }}
    >
      {children}
    </div>
  );
}

function DetailStyles() {
  return (
    <style>{`
      .pc-adv-detail {
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
        background: var(--bg-1, #0b1220);
        color: var(--fg-dim, #b9d4e8);
      }
      .pc-adv-detail__header {
        flex-shrink: 0;
        padding: 14px 18px 12px;
        border-bottom: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
        background: color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.045)), transparent 40%);
      }
      .pc-adv-detail__back {
        display: inline-flex;
        align-items: center;
        margin-bottom: 8px;
        padding: 2px 8px;
        font-size: 11px;
        font-weight: 600;
        color: var(--accent-strong, #7dd3fc);
        background: var(--bg-2, rgba(255, 255, 255, 0.045));
        border: 1px solid var(--border-strong, color-mix(in srgb, var(--accent-strong), transparent 68%));
        border-radius: 999px;
        cursor: pointer;
      }
      .pc-adv-detail__back:hover {
        background: var(--bg-3, rgba(255, 255, 255, 0.075));
        border-color: var(--accent, #38bdf8);
      }
      .pc-adv-detail__id {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 11px;
        font-weight: 700;
        color: var(--fg-mute, #7f9bb4);
        letter-spacing: 0;
      }
      .pc-adv-detail__title {
        font-size: 16px;
        font-weight: 700;
        line-height: 1.3;
        color: var(--fg, #e7f7ff);
        margin-top: 4px;
      }
      .pc-adv-detail__meta {
        display: flex;
        gap: 10px;
        align-items: center;
        margin-top: 10px;
        flex-wrap: wrap;
      }
      .pc-adv-detail__attempts {
        font-size: 10.5px;
        font-weight: 600;
        padding: 1px 7px;
        border-radius: 999px;
        background: var(--bg-3, rgba(255, 255, 255, 0.075));
        color: var(--fg-mute, #7f9bb4);
        white-space: nowrap;
      }
      .pc-adv-detail__plan,
      .pc-adv-detail__link {
        font-size: 11px;
        color: var(--accent-strong, #7dd3fc);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      .pc-adv-detail__link-btn {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        background: none;
        border: none;
        padding: 0;
        cursor: pointer;
        text-decoration: underline;
        text-underline-offset: 2px;
      }
      .pc-adv-detail__link-btn:hover {
        color: var(--fg, #e7f7ff);
      }
      .pc-adv-detail__body {
        flex: 1;
        overflow: auto;
        padding: 16px 18px;
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      /* The status Select's simple row container. */
      .pc-adv-detail__status-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      /* Label / value field rows (WorkItemDetail) — previously unstyled:
         the spans rendered run-together inline. */
      .pc-adv-detail__field-row {
        display: grid;
        grid-template-columns: 88px 1fr;
        gap: 12px;
        align-items: baseline;
        padding: 3px 0;
        font-size: 12.5px;
        color: var(--fg, #e7f7ff);
      }
      .pc-adv-detail__field-label {
        font-size: 10.5px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0;
        color: var(--fg-mute, #7f9bb4);
      }
      /* Hairline rhythm between stacked sections — scannability without cards. */
      .pc-adv-detail__section + .pc-adv-detail__section {
        border-top: 1px solid color-mix(in srgb, var(--border, rgba(125, 211, 252, 0.15)), transparent 45%);
        padding-top: 14px;
      }
      .pc-adv-detail__section h3 {
        margin: 0 0 6px;
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0;
        color: var(--fg-mute, #7f9bb4);
      }
      .pc-adv-detail__collapse {
        background: none;
        border: none;
        padding: 0;
        font: inherit;
        text-transform: uppercase;
        letter-spacing: 0;
        color: var(--fg-mute, #7f9bb4);
        cursor: pointer;
      }
      .pc-adv-detail__prose {
        margin: 0;
        font-size: 13px;
        line-height: 1.55;
        white-space: pre-wrap;
        color: var(--fg, #e7f7ff);
      }
      .pc-adv-detail__muted {
        margin: 0;
        font-size: 12px;
        font-style: italic;
        color: var(--fg-mute, #7f9bb4);
      }
      .pc-adv-detail__related {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      /* AgentDetail furniture — liveness line, warning chips, queue + claims. */
      .pc-adv-detail__liveness {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .pc-adv-detail__warn-chip {
        font-size: 10.5px;
        font-weight: 700;
        padding: 1px 8px;
        border-radius: 999px;
        background: color-mix(in oklab, var(--warn, #fbbf24), transparent 84%);
        color: color-mix(in oklab, var(--warn, #fbbf24), white 35%);
        white-space: nowrap;
        cursor: default;
      }
      .pc-adv-detail__queue {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-top: 4px;
      }
      .pc-adv-detail__queue-chip {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 10.5px;
        padding: 2px 8px;
        border-radius: 999px;
        background: var(--bg-2, rgba(255, 255, 255, 0.045));
        border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
        color: var(--fg-dim, #b9d4e8);
        cursor: pointer;
      }
      .pc-adv-detail__queue-chip:hover:not(:disabled) {
        border-color: var(--accent, #38bdf8);
        color: var(--fg, #e7f7ff);
      }
      .pc-adv-detail__queue-chip:disabled {
        cursor: default;
        opacity: 0.7;
      }
      .pc-adv-detail__claim-row {
        display: grid;
        grid-template-columns: auto auto 1fr;
        gap: 8px;
        align-items: baseline;
        font-size: 12px;
        padding: 2px 0;
      }
      .pc-adv-detail__claim-type {
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0;
        color: var(--fg-mute, #7f9bb4);
      }
      .pc-adv-detail__related-row {
        display: grid;
        grid-template-columns: auto auto 1fr;
        gap: 8px;
        align-items: center;
        padding: 5px 8px;
        font-size: 12px;
        text-align: left;
        color: var(--fg-dim, #b9d4e8);
        background: var(--bg-2, rgba(255, 255, 255, 0.045));
        border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
        border-radius: 6px;
        cursor: pointer;
      }
      .pc-adv-detail__related-row:hover:not(:disabled) {
        background: var(--bg-3, rgba(255, 255, 255, 0.075));
        border-color: var(--border-strong, color-mix(in srgb, var(--accent-strong), transparent 68%));
      }
      .pc-adv-detail__related-row:disabled {
        cursor: default;
      }
      .pc-adv-detail__related-id {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 11px;
        color: var(--fg-mute, #7f9bb4);
      }
      .pc-adv-detail__related-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
      }
      .pc-adv-detail__related-title {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--fg, #e7f7ff);
      }
      .pc-adv-detail__runs {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .pc-adv-detail__run {
        display: flex;
        gap: 10px;
        align-items: baseline;
        font-size: 12px;
      }
      .pc-adv-detail__run-role {
        font-weight: 600;
        color: var(--accent-strong, #7dd3fc);
        min-width: 80px;
      }
      .pc-adv-detail__run-time {
        color: var(--fg-mute, #7f9bb4);
      }
      .pc-adv-detail__run-right {
        margin-left: auto;
        display: inline-flex;
        gap: 8px;
        align-items: baseline;
      }
      .pc-adv-detail__run-cost {
        color: var(--fg-mute, #7f9bb4);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      /* P-023 outcome chip — colour buckets from runOutcome(). */
      .pc-adv-detail__run-outcome {
        font-size: 10.5px;
        font-weight: 700;
        letter-spacing: 0;
        padding: 1px 7px;
        border-radius: 999px;
        white-space: nowrap;
      }
      .pc-adv-detail__run-outcome.is-done {
        background: color-mix(in oklab, var(--good, #34d399), transparent 84%);
        color: color-mix(in oklab, var(--good, #34d399), white 35%);
      }
      .pc-adv-detail__run-outcome.is-failed {
        background: color-mix(in oklab, var(--bad, #f87171), transparent 82%);
        color: color-mix(in oklab, var(--bad, #f87171), white 35%);
      }
      .pc-adv-detail__run-outcome.is-cancelled {
        background: color-mix(in oklab, var(--warn, #fbbf24), transparent 84%);
        color: color-mix(in oklab, var(--warn, #fbbf24), white 35%);
      }
      .pc-adv-detail__run-outcome.is-running {
        background: color-mix(in oklab, var(--accent, #38bdf8), transparent 84%);
        color: var(--accent-strong, #7dd3fc);
      }
      .pc-adv-detail__run-outcome.is-muted {
        background: var(--bg-3, rgba(255, 255, 255, 0.075));
        color: var(--fg-mute, #7f9bb4);
      }
      .pc-adv-detail__run-open {
        font-size: 10.5px;
        font-weight: 600;
        padding: 1px 8px;
        border-radius: 999px;
        background: transparent;
        border: 1px solid color-mix(in oklab, var(--accent-strong, #7dd3fc), transparent 60%);
        color: var(--accent-strong, #7dd3fc);
        cursor: pointer;
        white-space: nowrap;
      }
      .pc-adv-detail__run-open:hover {
        background: color-mix(in oklab, var(--accent-strong, #7dd3fc), transparent 86%);
      }
      .pc-adv-detail__run-error {
        margin: 1px 0 2px 90px;
        font-size: 11px;
        color: color-mix(in oklab, var(--bad, #f87171), white 35%);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .pc-adv-detail__notes {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .pc-adv-detail__note-row {
        border-left: 2px solid var(--border-strong, color-mix(in srgb, var(--accent-strong), transparent 68%));
        padding-left: 10px;
      }
      .pc-adv-detail__note-meta {
        font-size: 10px;
        color: var(--fg-mute, #7f9bb4);
        margin-bottom: 2px;
      }
      .pc-adv-detail__note {
        margin: 0;
        font-size: 12px;
        line-height: 1.5;
        white-space: pre-wrap;
        color: var(--fg, #e7f7ff);
      }
      .pc-adv-detail__note-form {
        display: flex;
        flex-direction: column;
        gap: 6px;
        margin-top: 8px;
      }
      .pc-adv-detail__note-form textarea {
        width: 100%;
        resize: vertical;
        padding: 6px 8px;
        font: inherit;
        font-size: 12px;
        background: var(--bg-2, rgba(255, 255, 255, 0.045));
        color: var(--fg, #e7f7ff);
        border: 1px solid var(--border-strong, color-mix(in srgb, var(--accent-strong), transparent 68%));
        border-radius: 6px;
      }
      .pc-adv-detail__note-form textarea:focus {
        outline: none;
        border-color: var(--accent, #38bdf8);
        box-shadow: 0 0 0 2px color-mix(in oklab, var(--accent, #38bdf8), transparent 78%);
      }
      .pc-adv-detail__note-form button {
        align-self: flex-start;
        padding: 5px 12px;
        font-size: 12px;
        font-weight: 600;
        background: var(--bg-2, rgba(255, 255, 255, 0.045));
        color: var(--fg, #e7f7ff);
        border: 1px solid var(--border-strong, color-mix(in srgb, var(--accent-strong), transparent 68%));
        border-radius: 6px;
        cursor: pointer;
      }
      .pc-adv-detail__note-form button:hover:not(:disabled) {
        border-color: var(--accent, #38bdf8);
      }
      .pc-adv-detail__note-form button:disabled {
        opacity: 0.45;
        cursor: default;
      }
      .pc-adv-detail__code {
        margin: 0;
        padding: 10px;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 11px;
        background: var(--bg-2, rgba(255, 255, 255, 0.045));
        border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
        border-radius: 6px;
        color: var(--fg, #e7f7ff);
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 240px;
        overflow: auto;
      }
      .pc-adv-detail__pointer {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 11px;
        padding: 3px 8px;
        background: var(--bg-2, rgba(255, 255, 255, 0.045));
        border-radius: 4px;
        color: var(--fg, #e7f7ff);
      }
      .pc-adv-detail__select {
        display: inline-flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        min-width: 160px;
        min-height: 32px;
        padding: 0 10px;
        font-size: 12px;
        background: var(--bg-2, rgba(255, 255, 255, 0.045));
        color: var(--fg, #e7f7ff);
        border: 1px solid var(--border-strong, color-mix(in srgb, var(--accent-strong), transparent 68%));
        border-radius: 6px;
        cursor: pointer;
      }
      .pc-adv-detail__actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      .pc-adv-detail__actions button {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 6px 12px;
        font-size: 12px;
        font-weight: 600;
        background: var(--bg-2, rgba(255, 255, 255, 0.045));
        color: var(--fg, #e7f7ff);
        border: 1px solid var(--border-strong, color-mix(in srgb, var(--accent-strong), transparent 68%));
        border-radius: 6px;
        cursor: pointer;
      }
      .pc-adv-detail__actions button:hover:not(:disabled) {
        background: var(--bg-3, rgba(255, 255, 255, 0.075));
        border-color: var(--accent, #38bdf8);
      }
      .pc-adv-detail__actions button:disabled {
        opacity: 0.45;
        cursor: default;
      }
      /* Inline header stats (AgentDetail meta line: drive / load). */
      .pc-adv-detail__stat {
        font-size: 11px;
        color: var(--fg-mute, #7f9bb4);
        white-space: nowrap;
      }
      /* Compact density variant — the working tab's agent:* / WI-* details.
         Same vocabulary, tighter rhythm: id+title share a line, the field
         rows flow 2-up when the pane is wide enough, smaller paddings. */
      .pc-adv-detail--compact .pc-adv-detail__header {
        padding: 8px 12px 7px;
      }
      .pc-adv-detail--compact .pc-adv-detail__back {
        margin-bottom: 4px;
      }
      .pc-adv-detail--compact .pc-adv-detail__id {
        display: inline;
      }
      .pc-adv-detail--compact .pc-adv-detail__title {
        display: inline;
        margin: 0 0 0 7px;
        font-size: 13px;
        line-height: 1.35;
      }
      .pc-adv-detail--compact .pc-adv-detail__meta {
        margin-top: 5px;
        gap: 6px;
      }
      .pc-adv-detail--compact .pc-adv-detail__body {
        padding: 10px 12px;
        gap: 10px;
      }
      .pc-adv-detail--compact .pc-adv-detail__section + .pc-adv-detail__section {
        padding-top: 9px;
      }
      .pc-adv-detail--compact .pc-adv-detail__section h3 {
        margin-bottom: 4px;
      }
      .pc-adv-detail--compact .pc-adv-detail__fields {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        column-gap: 18px;
      }
      .pc-adv-detail--compact .pc-adv-detail__field-row {
        grid-template-columns: 64px 1fr;
        gap: 8px;
        padding: 1.5px 0;
        font-size: 12px;
      }
      .pc-adv-detail--compact .pc-adv-detail__prose {
        font-size: 12px;
        line-height: 1.45;
      }
      .pc-adv-detail--compact .pc-adv-detail__related-row {
        padding: 3px 6px;
      }
      .pc-adv-detail--compact .pc-adv-detail__actions button {
        padding: 4px 10px;
      }
    `}</style>
  );
}
