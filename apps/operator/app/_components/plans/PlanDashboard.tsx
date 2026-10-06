'use client';

/**
 * PlanDashboard (plan-visibility-revamp-2026-08-23 P-003) — the option-C plan
 * detail surface (canvas cf9475c1 / OptionC.dc.html), rendered full-width in
 * the app pane as a takeover (D-002; host: PlanDashboardHost). Reached from
 * the op-chat plan sidebar (D-001) — there is NO new top-level tab.
 *
 * Sections (the artboard's right-hand `.detail` half):
 *   - HEADER: bucket / title / harness·slug, back affordance, actions
 *     (Open full plan → the existing `wppop` popup; Search transcripts →
 *     the same popup's Sessions tab; Launch agent → launchAgent, the same
 *     plan-bound launch PlanSessionsTab does), ✎/⚒ meta pair, item progress,
 *     needs-you line, progress bar.
 *   - WORKING NOW: one card per live plan session (`planSessions.list`),
 *     enriched by the shared `advRoster.list` entry for that owner —
 *     liveness state, current intent, last-activity recency. Card click-through
 *     opens the session chat (SessionChatModal — same surface the popup's
 *     Sessions tab uses).
 *   - RECENT ACTIVITY: the merged edits+work feed (`planActivity.list`,
 *     P-004). Work rows deep-link to the work-item popup (`wpop`).
 *
 * REUSE, not re-derivation:
 *   - plan row: a TARGETED `usePlan(planSlug, {live:true})` fetch
 *     (plans-list-windowing-cardinality-fix-2026-08-30 P-003) — NOT the
 *     shared `plans.list` feed (usePlanList) most other plan surfaces read.
 *     That feed is a bounded/potentially-windowed harness-wide index; a plan
 *     merely absent from whatever slice it currently holds used to render
 *     this whole dashboard as if the plan didn't exist. This surface needs
 *     exactly the one plan it was opened for, so it fetches it directly.
 *   - needs-you: the SAME `plans.attention` feed (useInboxAttention →
 *     effectiveTier === 'decision'), the sidebar's own join;
 *   - ⚒ last work: the SAME `planWorkActivity.list` map the sidebar rows read
 *     (identical args ⇒ one cache entry, zero extra fetches);
 *   - roster: `advRosterArgs(...)` — the ONE canonical args shape (P-026);
 *   - popups: `wpop`/`wppop` via chat-ref-popup-params — written here, rendered
 *     by ChatRefPopupHost's singleton mount. Never a second renderer.
 *
 * State lives in the URL (nuqs): `?pdash` (the host's takeover param),
 * `?pdsess` (the open session-chat owner), and `?opcln` (the selected clean-up
 * run) — deep-linkable + agent-driveable.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Check,
  Circle,
  CircleAlert,
  CircleDot,
  ExternalLink,
  Hammer,
  Minus,
  Pencil,
  Plus,
  Search,
} from 'lucide-react';
import { parseAsString, useQueryState, useQueryStates } from 'nuqs';
import { toast } from 'sonner';
import { FLAGS } from '@papercusp/flags';
import { launchAgent } from '@papercusp/operator-core/lib/launch-agent';
import { useSyncQuery } from '@papercusp/sync';
import { preparePlanDocument } from '@papercusp/ui-primitives';
import { useFlag } from '@/lib/flag-hooks';
import { useWorkspaceId } from '@/lib/use-workspace-id';
import { Button } from '@/app/harness/Button';
import { preloadVditor } from '@/app/_components/MarkdownEditor';
import { bucketOf, usePlan } from '@/app/admin/plans/plans-api';
import { stripFrontmatter } from '@/app/admin/plans/plan-renderers';
import { effectiveTier, useInboxAttention } from '../inbox/use-inbox-pending';
import SessionChatModal from '../chat/SessionChatModal';
import { preloadPlanPopupModal } from '../chat/ChatRefPopupHost';
import {
  CHAT_PLAN_POPUP_PARAM,
  CHAT_WORK_ITEM_POPUP_PARAM,
  encodeScopedRef,
} from '../chat/chat-ref-popup-params';
import { beginInteraction, markInteractionPhase, PERF_INTERACTIONS } from '../perf/perf-marks';
import { agoLabel, agoLabelMs, WORK_HOT_MS } from './PlansPane';
import {
  collapsePlanActivity,
  groupPlanItems,
  newestDecisions,
  statusCountsOf,
  type PlanActivityFeedRow,
} from './plan-dashboard-derive';
import PlanCleanupEntryButton from './PlanCleanupEntryButton';
import {
  PLAN_CLEANUP_RUN_PARAM,
  usePlanCleanupRun,
} from './use-plan-cleanup-run';
import { advRosterArgs } from '@/lib/adv-roster-args';
import './plan-dashboard.css';

/** One row of the `planSessions.list` sync query (mirrors PlanSessionRow). */
interface PlanSessionRow {
  coordOwnerId: string;
  sessionId: string | null;
  agent: string | null;
  role: string | null;
  label: string | null;
  startedAt: string;
  endedAt: string | null;
  live: boolean;
  via: 'plan' | 'claim';
}

/** The advRoster.list payload subset this surface reads (per-owner liveness). */
interface RosterPayloadRow {
  active?: Array<{
    ownerId: string;
    label?: string | null;
    intent?: string | null;
    sessionState?: string | null;
    lastActiveAt?: string | null;
    agent?: string | null;
  }>;
}

/** One planWorkActivity.list wire row (P-001). */
interface PlanWorkActivityRow {
  slug?: string;
  lastWorkAtMs?: number;
}

/** Page-side readiness signal for the packaged Tauri perf probe. This is a
 * mark (not a budgeted interaction): it proves the async Vditor/Lute warm-up
 * finished before a warm-route sample starts. */
const VDITOR_READY_MARK = 'plan-dashboard-vditor-ready-success-v1';
const DOCUMENT_READY_MARK = 'plan-dashboard-document-ready-success-v1';
const POPUP_MODULE_READY_MARK = 'plan-dashboard-popup-module-ready-success-v1';

/** "2m" → "2m ago", "now" → "just now" — hover-title phrasing. */
function agoPhrase(label: string): string {
  return label === 'now' ? 'just now' : `${label} ago`;
}

/**
 * Progress derived from a `plans:get` full-mode item list — this surface's
 * targeted single-plan read carries `items` (plans-list-windowing-
 * cardinality-fix-2026-08-30 P-003), not the pre-aggregated `itemCounts`
 * histogram `PlansPane.progressOf` reads off the shared `plans.list` index.
 * Mirrors that function's exact rule (done = `effectiveStatus === 'done'`;
 * every item counts toward total) over the row list instead of a histogram —
 * `plans:get` resolves `effectiveStatus` through the identical two-step
 * (resolveEffectiveStatus + issue-block overlay) `plans:list` uses to build
 * the histogram in the first place, so the two can't disagree.
 */
function progressOfItems(
  items: Array<{ effectiveStatus?: string }> | undefined,
): { done: number; total: number } | null {
  if (!items || items.length === 0) return null;
  let done = 0;
  for (const it of items) {
    if (it.effectiveStatus === 'done') done += 1;
  }
  return { done, total: items.length };
}

/** `su-5ae5fec0-…` → `su-5ae5f` — the short owner id the roster panes show. */
export function shortOwnerId(ownerId: string): string {
  const m = /^([a-z]+)-([0-9a-f]{5})/i.exec(ownerId);
  return m ? `${m[1]}-${m[2]}` : ownerId.slice(0, 8);
}

/** Deterministic avatar colour — the artboard's palette, hashed by owner id. */
const AVATAR_COLORS = ['#7dd3fc', '#a78bfa', '#f9a8d4', '#fbbf24', '#34d399', '#fb7185'];
export function avatarColor(ownerId: string): string {
  let h = 0;
  for (let i = 0; i < ownerId.length; i++) h = (h * 31 + ownerId.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length]!;
}

/** Two-glyph avatar text: the first hex pair of the owner uuid. */
function avatarText(ownerId: string): string {
  const m = /-([0-9a-f]{2})/i.exec(ownerId);
  return (m?.[1] ?? ownerId.slice(0, 2)).toLowerCase();
}

export default function PlanDashboard({
  planSlug,
  harnessSlug,
  onBack,
}: {
  planSlug: string;
  /** The plan's own harness when the deep link carried one; the plan row's
   *  harness is the fallback (a bare `?pdash=<slug>` link still resolves). */
  harnessSlug: string | null;
  onBack: () => void;
}) {
  const workspaceId = useWorkspaceId();

  // The plan row — a TARGETED single-plan fetch (plans-list-windowing-
  // cardinality-fix-2026-08-30 P-003), not the shared `plans.list` cache.
  // That cache is a bounded/potentially-windowed harness-wide index; a plan
  // simply absent from whatever slice it currently holds silently rendered
  // this whole surface as if the plan didn't exist — real data made
  // unreachable by a cache-shape coincidence, independent of any windowing
  // decision (see D-004). `usePlan`'s live path requests `mode:'full'`,
  // which also carries `items` — what progress is derived from below.
  const planQuery = usePlan(planSlug, { live: true, harnessSlug });
  const plan = planQuery.data;
  const harness = harnessSlug ?? plan?.harness ?? null;
  const updatedAt =
    typeof plan?.frontmatter?.updated === 'string' ? plan.frontmatter.updated : null;

  // Needs-you: decision-tier attention on THIS plan (the sidebar's own join).
  const { items: attentionItems } = useInboxAttention();
  const needsYou = useMemo(
    () =>
      attentionItems.filter((i) => i.planSlug === planSlug && effectiveTier(i) === 'decision')
        .length,
    [attentionItems, planSlug],
  );

  // ⚒ last work — the SAME map the sidebar reads (identical args ⇒ shared entry).
  const workActivity = useSyncQuery<PlanWorkActivityRow>({
    queryName: 'planWorkActivity.list',
    args: { workspaceId },
  });
  const lastWorkAtMs = useMemo(() => {
    for (const r of workActivity.data ?? []) {
      if (r?.slug === planSlug && typeof r.lastWorkAtMs === 'number') return r.lastWorkAtMs;
    }
    return null;
  }, [workActivity.data, planSlug]);
  const workHot = lastWorkAtMs != null && Date.now() - lastWorkAtMs < WORK_HOT_MS;

  // Plan-bound sessions + the roster entries that carry their live state.
  const sessions = useSyncQuery<PlanSessionRow>({
    queryName: 'planSessions.list',
    args: { planSlug, workspaceId: workspaceId ?? null },
  });
  const roster = useSyncQuery<RosterPayloadRow>({
    queryName: 'advRoster.list',
    args: advRosterArgs(workspaceId),
  });
  const rosterByOwner = useMemo(() => {
    const m = new Map<string, NonNullable<RosterPayloadRow['active']>[number]>();
    for (const e of roster.data?.[0]?.active ?? []) m.set(e.ownerId, e);
    return m;
  }, [roster.data]);
  const liveRows = useMemo(
    () => (sessions.data ?? []).filter((r) => r.live),
    [sessions.data],
  );

  // The merged edits+work feed (P-004).
  const activity = useSyncQuery<PlanActivityFeedRow>({
    queryName: 'planActivity.list',
    args: { planSlug, workspaceId: workspaceId ?? null, limit: 30 },
  });

  // Open-session chat (?pdsess — deep-linkable, same modal the popup tab uses).
  const [openSessionOwner, setOpenSessionOwner] = useQueryState('pdsess', parseAsString);

  // P-009: one-plan clean-up shares the global URL-owned run selection. Reading
  // the same sync entry as PlanCleanupReportHost costs no second server query;
  // it only keeps this header action disabled while its own run is active.
  const cleanupEnabled = useFlag(FLAGS.PLAN_CLEANUP);
  const [cleanupRunId, setCleanupRunId] = useQueryState(
    PLAN_CLEANUP_RUN_PARAM,
    parseAsString,
  );
  const cleanup = usePlanCleanupRun(cleanupRunId, { enabled: cleanupEnabled });
  const cleanupActive = Boolean(
    cleanup.isRunning &&
      cleanup.run?.seedRefs.length === 1 &&
      cleanup.run.seedRefs[0] === planSlug,
  );

  // Popups: written here, rendered by ChatRefPopupHost's singleton mount.
  // The popup identity, view and optional jump target are ONE transition.
  // Writing them through three independent nuqs setters schedules repeated
  // router/root work before PlanDetail can mount; native P-007 traces measured
  // multi-second click-to-request gaps on that path. useQueryStates is the
  // existing atomic URL-transition primitive (CreateHarnessPicker precedent).
  const [, setPlanPopupState] = useQueryStates({
    [CHAT_PLAN_POPUP_PARAM]: parseAsString,
    ppv: parseAsString,
    jump: parseAsString,
  });
  const [, setOpenWorkItem] = useQueryState(CHAT_WORK_ITEM_POPUP_PARAM, parseAsString);

  // PlansPane starts this same idempotent warm-up before a sidebar row click,
  // but the dashboard is also independently deep-linkable. Warm here too so
  // its "Open full plan" action never depends on the caller having mounted the
  // pane first (WI-5547's route changed from row → popup to row → dashboard →
  // popup). preloadVditor memoizes the shared JS/CSS/Lute initialization, so
  // the normal sidebar path reuses the already-running/completed promise.
  useEffect(() => {
    void preloadVditor().then((warmed) => {
      if (!warmed) return;
      try {
        performance.clearMarks?.(VDITOR_READY_MARK);
        performance.mark(VDITOR_READY_MARK);
      } catch {
        // Performance instrumentation must never break the dashboard.
      }
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    try { performance.clearMarks?.(POPUP_MODULE_READY_MARK); } catch { /* diagnostics only */ }
    void preloadPlanPopupModal().then(() => {
      if (cancelled) return;
      try { performance.mark(POPUP_MODULE_READY_MARK); } catch { /* diagnostics only */ }
    }).catch(() => {
      // The popup's existing lazyWithRetry owns recovery on the actual click.
    });
    return () => { cancelled = true; };
  }, []);

  const documentSource = plan?.raw ?? plan?.prose;
  const legacyDocument = plan?.legacy;
  useEffect(() => {
    let cancelled = false;
    try { performance.clearMarks?.(DOCUMENT_READY_MARK); } catch { /* diagnostics only */ }
    if (documentSource === undefined) return;
    // Match PlanDetail's read body exactly; the live plan query already owns
    // freshness, so a changed body naturally replaces the previous preparation.
    const body = legacyDocument ? documentSource : stripFrontmatter(documentSource);
    void preparePlanDocument(body).then((prepared) => {
      if (!prepared || cancelled) return;
      try { performance.mark(DOCUMENT_READY_MARK); } catch { /* diagnostics only */ }
    });
    return () => { cancelled = true; };
  }, [documentSource, legacyDocument]);

  const openFullPlan = useCallback(() => {
    // Time the current "open a plan" path (WI-5547): the sidebar row now
    // lands on this dashboard first, so THIS button is the event that opens
    // PlanPopupModal. PlanEditor.handleParsed consumes the mark when Vditor
    // finishes the first body render.
    beginInteraction(PERF_INTERACTIONS.planPopupOpen);
    void setPlanPopupState({
      [CHAT_PLAN_POPUP_PARAM]: encodeScopedRef(harness, planSlug),
      ppv: "plan",
      jump: null,
    });
    // Native required-phase checks distinguish this atomic transition from a
    // stale packaged client still issuing three independent URL updates.
    markInteractionPhase(PERF_INTERACTIONS.planPopupOpen, 'popup-url-update-queued');
  }, [setPlanPopupState, harness, planSlug]);

  const openPlanTarget = useCallback(
    (target: string) => {
      beginInteraction(PERF_INTERACTIONS.planPopupOpen);
      void setPlanPopupState({
        [CHAT_PLAN_POPUP_PARAM]: encodeScopedRef(harness, planSlug),
        ppv: "plan",
        jump: target,
      });
      markInteractionPhase(PERF_INTERACTIONS.planPopupOpen, 'popup-url-update-queued');
    },
    [setPlanPopupState, harness, planSlug],
  );

  const openTranscriptSearch = useCallback(() => {
    // The popup's Sessions tab IS the plan-scoped transcript search surface
    // (PlanSessionsTab) — open the popup directly onto it.
    void setPlanPopupState({
      [CHAT_PLAN_POPUP_PARAM]: encodeScopedRef(harness, planSlug),
      ppv: "sessions",
      jump: null,
    });
  }, [setPlanPopupState, harness, planSlug]);

  const [launching, setLaunching] = useState(false);
  const onLaunch = useCallback(async () => {
    if (launching) return;
    setLaunching(true);
    try {
      const result = await launchAgent({
        slug: harness,
        planSlug,
        label: `plan · ${planSlug}`,
      });
      if (result.ok) {
        toast.success('Agent launching on this plan — it will appear here once it registers.', {
          duration: 3500,
        });
      } else if (result.installCmd) {
        toast.error(`${result.error ?? 'Launch prerequisites missing.'} Run: ${result.installCmd}`);
      } else {
        toast.error(`Launch failed: ${result.error ?? 'unknown error'}`);
      }
    } finally {
      setLaunching(false);
    }
  }, [launching, harness, planSlug]);

  const handleBack = useCallback(() => {
    // Clear the session-chat selection with the takeover — a stale ?pdsess
    // would auto-open that chat on the NEXT dashboard visit.
    void setOpenSessionOwner(null);
    onBack();
  }, [setOpenSessionOwner, onBack]);

  const progress = progressOfItems(plan?.items);
  const bucket = plan
    ? bucketOf({ status: plan.status ?? 'draft', startStatus: plan.startStatus ?? undefined })
    : null;
  const title = plan?.title ?? planSlug;

  // Direction-A derivations (plan-dashboard-mission-control-2026-08-31) — all
  // over data this surface ALREADY fetches; the pure rules live in
  // plan-dashboard-derive.ts so they unit-test without this import graph.
  const counts = useMemo(() => statusCountsOf(plan?.items), [plan?.items]);
  const itemGroups = useMemo(() => groupPlanItems(plan?.items), [plan?.items]);
  const railDecisions = useMemo(
    () => newestDecisions(plan?.decisions, plan?.decisions?.length ?? 0),
    [plan?.decisions],
  );
  const feedEntries = useMemo(
    () => collapsePlanActivity(activity.data as PlanActivityFeedRow[] | undefined),
    [activity.data],
  );
  const collapsedEdits = useMemo(
    () =>
      feedEntries.reduce((n, e) => (e.type === 'run' ? n + e.count : n), 0),
    [feedEntries],
  );
  const nowState = plan?.now?.state?.trim() || null;
  const nowNext = plan?.now?.next?.trim() || null;

  /** "8h" / "8–12h" — a run's time range, degenerate when the labels match. */
  const runAgo = (newestMs: number | null, oldestMs: number | null): string => {
    if (newestMs == null) return '—';
    const a = agoLabelMs(newestMs);
    const b = oldestMs == null ? a : agoLabelMs(oldestMs);
    return a === b ? a : `${a}–${b}`;
  };

  const itemIcon = (status: string) => {
    switch (status) {
      case 'done': return <Check size={13} aria-hidden="true" />;
      case 'wip': return <CircleDot size={13} aria-hidden="true" />;
      case 'blocked':
      case 'needs-human': return <CircleAlert size={13} aria-hidden="true" />;
      case 'dropped': return <Minus size={13} aria-hidden="true" />;
      default: return <Circle size={12} aria-hidden="true" />;
    }
  };

  return (
    <div className="plan-dash" data-testid="plan-dashboard">
      <div className="plan-dash__head">
        <div className="plan-dash__title-row">
          <button
            type="button"
            className="plan-dash__back"
            onClick={handleBack}
            aria-label="Back"
            data-testid="plan-dash-back"
          >
            <ArrowLeft size={14} aria-hidden="true" />
          </button>
          <div className="plan-dash__identity">
            <div className="plan-dash__title-line">
              {bucket ? (
                <span
                  className={`plan-dash__bucket plan-dash__bucket--${bucket}`}
                >
                  {bucket === "running" ? "plan" : bucket}
                </span>
              ) : null}
              <h1 className="plan-dash__title" title={title}>
                {title}
              </h1>
            </div>
            <span
              className="plan-dash__slug"
              title={`${harness ?? "?"} · ${planSlug}`}
            >
              {harness ? `${harness} · ` : ""}
              {planSlug}
            </span>
          </div>

          <div className="plan-dash__actions" aria-label="Plan actions">
            <Button
              variant="primary"
              className="plan-dash__btn plan-dash__btn--primary"
              onClick={openFullPlan}
              data-testid="plan-dash-open-full"
            >
              <ExternalLink size={13} aria-hidden="true" />
              Open full plan
            </Button>
            <Button
              variant="accent"
              className="plan-dash__btn"
              onClick={() => void onLaunch()}
              disabled={launching}
              data-testid="plan-dash-launch"
            >
              <Plus size={12} aria-hidden="true" />
              {launching ? "Launching…" : "Launch agent"}
            </Button>
            <Button
              variant="ghost"
              className="plan-dash__btn plan-dash__btn--ghost"
              onClick={openTranscriptSearch}
              data-testid="plan-dash-search-transcripts"
            >
              <Search size={12} aria-hidden="true" />
              Search transcripts
            </Button>
            {cleanupEnabled ? (
              <PlanCleanupEntryButton
                planSlug={planSlug}
                harness={harness}
                title={title}
                appearance="dashboard"
                active={cleanupActive}
                onRunStarted={(runId) => void setCleanupRunId(runId)}
              />
            ) : null}
          </div>
        </div>

        <div className="plan-dash__meta">
          <span
            className="plan-dash__t"
            title={
              updatedAt
                ? `✎ Plan edited ${agoPhrase(agoLabel(updatedAt))} — ${new Date(Date.parse(updatedAt)).toLocaleString()}`
                : "✎ Plan edit time unknown"
            }
            data-testid="plan-dash-edit-t"
          >
            <Pencil size={11} aria-hidden="true" />
            edited {agoLabel(updatedAt)}
          </span>
          <span
            className={`plan-dash__t${workHot ? " plan-dash__t--hot" : lastWorkAtMs == null ? " plan-dash__t--dim" : ""}`}
            title={
              lastWorkAtMs != null
                ? `⚒ Last work ${agoPhrase(agoLabelMs(lastWorkAtMs))} — ${new Date(lastWorkAtMs).toLocaleString()}`
                : "⚒ No work-item activity yet"
            }
            data-testid="plan-dash-work-t"
          >
            <Hammer size={11} aria-hidden="true" />
            worked {agoLabelMs(lastWorkAtMs)}
          </span>
          {needsYou > 0 ? (
            <span className="plan-dash__needs" data-testid="plan-dash-needs">
              {needsYou} decision{needsYou === 1 ? "" : "s"} need
              {needsYou === 1 ? "s" : ""} you
            </span>
          ) : null}
        </div>

        {progress && counts ? (
          <div className="plan-dash__band" data-testid="plan-dash-band">
            <span
              className="plan-dash__band-count"
              data-testid="plan-dash-progress"
            >
              {progress.done} of {progress.total} items done
            </span>
            <span className="plan-dash__band-track" aria-hidden="true">
              {counts.done > 0 ? (
                <span
                  className="plan-dash__band-seg plan-dash__band-seg--done"
                  style={{ flexGrow: counts.done }}
                />
              ) : null}
              {counts.wip > 0 ? (
                <span
                  className="plan-dash__band-seg plan-dash__band-seg--wip"
                  style={{ flexGrow: counts.wip }}
                />
              ) : null}
              {counts.attention > 0 ? (
                <span
                  className="plan-dash__band-seg plan-dash__band-seg--attention"
                  style={{ flexGrow: counts.attention }}
                />
              ) : null}
              {counts.todo + counts.dropped > 0 ? (
                <span
                  className="plan-dash__band-seg plan-dash__band-seg--todo"
                  style={{ flexGrow: counts.todo + counts.dropped }}
                />
              ) : null}
            </span>
            <span className="plan-dash__band-legend">
              {counts.wip > 0 ? <span>{counts.wip} in progress</span> : null}
              {counts.attention > 0 ? (
                <span className="plan-dash__band-warn">
                  {counts.attention} blocked
                </span>
              ) : null}
              {liveRows.length > 0 ? (
                <span className="plan-dash__band-live">
                  {liveRows.length} agent{liveRows.length === 1 ? "" : "s"} on
                  it
                </span>
              ) : null}
              <span>
                {needsYou > 0
                  ? `${needsYou} decision${needsYou === 1 ? "" : "s"} need${needsYou === 1 ? "s" : ""} you`
                  : "nothing needs you"}
              </span>
            </span>
          </div>
        ) : null}
      </div>

      <div className="plan-dash__body">
        <div className="plan-dash__colmain">
          {nowState || nowNext ? (
            <div
              className="plan-dash__card plan-dash__now"
              data-testid="plan-dash-now"
            >
              <div className="plan-dash__sec-h plan-dash__sec-h--accent">
                Now
                <span className="plan-dash__sec-line" aria-hidden="true" />
                <span className="plan-dash__sec-h-note">
                  where this plan is, in its own words
                </span>
              </div>
              {nowState ? (
                <div className="plan-dash__now-text">{nowState}</div>
              ) : null}
              {nowNext ? (
                <div className="plan-dash__now-chips">
                  <span
                    className="plan-dash__chip plan-dash__chip--accent"
                    title={nowNext}
                  >
                    next: {nowNext}
                  </span>
                </div>
              ) : null}
            </div>
          ) : null}

          {itemGroups.length > 0 ? (
            <div
              className="plan-dash__card plan-dash__items"
              data-testid="plan-dash-items"
            >
              {itemGroups.map((g) => (
                <div key={g.key} className="plan-dash__igroup">
                  <div
                    className={`plan-dash__sec-h${
                      g.key === "wip"
                        ? " plan-dash__sec-h--accent"
                        : g.key === "attention"
                          ? " plan-dash__sec-h--warn"
                          : ""
                    }`}
                  >
                    {g.label} · {g.items.length}
                    <span className="plan-dash__sec-line" aria-hidden="true" />
                  </div>
                  {g.items.map((it) => {
                    const linked = plan?.linkedFeatures?.[it.id];
                    const terminal = g.key === "doneish";
                    const inner = (
                      <>
                        <span
                          className={`plan-dash__iic plan-dash__iic--${it.effectiveStatus}`}
                          aria-hidden="true"
                        >
                          {itemIcon(it.effectiveStatus)}
                        </span>
                        <span className="plan-dash__iref">{it.id}</span>
                        <span
                          className={`plan-dash__itext${terminal ? " plan-dash__itext--dim" : ""}${
                            it.effectiveStatus === "dropped"
                              ? " plan-dash__itext--dropped"
                              : ""
                          }`}
                          title={it.text}
                        >
                          {it.text}
                        </span>
                        <span className="plan-dash__imeta">
                          {it.importance === "urgent" ||
                          it.importance === "high" ? (
                            <span
                              className={`plan-dash__ibadge plan-dash__ibadge--${it.importance}`}
                            >
                              {it.importance}
                            </span>
                          ) : null}
                        </span>
                      </>
                    );
                    return (
                      <div
                        key={it.id}
                        className="plan-dash__irow"
                        data-testid={`plan-dash-item-${it.id}`}
                      >
                        <button
                          type="button"
                          className="plan-dash__irow-main"
                          onClick={() => openPlanTarget(it.id)}
                          aria-label={`View full details for ${it.id}`}
                          data-testid={`plan-dash-item-detail-${it.id}`}
                        >
                          {inner}
                        </button>
                        {linked ? (
                          <button
                            type="button"
                            className="plan-dash__iwork"
                            onClick={() =>
                              void setOpenWorkItem(
                                encodeScopedRef(harness, linked.featureId),
                              )
                            }
                            aria-label={`Open linked work item ${linked.featureId}`}
                            data-testid={`plan-dash-item-work-${it.id}`}
                          >
                            <ExternalLink size={12} aria-hidden="true" />
                            {linked.featureId}
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          ) : (
            <div className="plan-dash__empty">
              {planQuery.loading
                ? "Loading plan…"
                : "No items in this plan yet."}
            </div>
          )}
        </div>

        <div className="plan-dash__rail">
          <div className="plan-dash__sec plan-dash__card">
            <div className="plan-dash__sec-h">
              Working now · {liveRows.length} agent
              {liveRows.length === 1 ? "" : "s"}
            </div>
            {sessions.loading && liveRows.length === 0 ? (
              <div className="plan-dash__empty">Loading sessions…</div>
            ) : liveRows.length === 0 ? (
              <div
                className="plan-dash__empty"
                data-testid="plan-dash-no-sessions"
              >
                No agents working on this plan right now. “Launch agent” starts
                one.
              </div>
            ) : (
              <div
                className="plan-dash__sess-grid"
                data-testid="plan-dash-sessions"
              >
                {liveRows.map((row) => {
                  const entry = rosterByOwner.get(row.coordOwnerId);
                  const state = entry?.sessionState ?? "live";
                  const parked = state !== "live";
                  const lastActive = entry?.lastActiveAt ?? null;
                  const intent =
                    entry?.intent?.trim() || row.label?.trim() || null;
                  return (
                    <div
                      key={row.coordOwnerId}
                      className="plan-dash__scard"
                      data-testid={`plan-dash-session-${row.coordOwnerId}`}
                    >
                      <div className="plan-dash__srow1">
                        <span
                          className="plan-dash__sav"
                          style={{ background: avatarColor(row.coordOwnerId) }}
                          aria-hidden="true"
                        >
                          {avatarText(row.coordOwnerId)}
                        </span>
                        <span
                          className="plan-dash__sid"
                          title={row.coordOwnerId}
                        >
                          {shortOwnerId(row.coordOwnerId)}
                        </span>
                        {row.agent ? (
                          <span className="plan-dash__backend">
                            {row.agent}
                          </span>
                        ) : null}
                        <span
                          className={`plan-dash__state plan-dash__state--${parked ? "parked" : "live"}`}
                        >
                          <span
                            className="plan-dash__state-dot"
                            aria-hidden="true"
                          />
                          {state}
                        </span>
                      </div>
                      {intent ? (
                        <span className="plan-dash__sintent" title={intent}>
                          {intent}
                        </span>
                      ) : null}
                      <div className="plan-dash__srow3">
                        <span>
                          {parked
                            ? `idle ${agoLabel(lastActive)}`
                            : lastActive
                              ? `last active ${agoPhrase(agoLabel(lastActive))}`
                              : `started ${agoPhrase(agoLabel(row.startedAt))}`}
                        </span>
                        <span className="plan-dash__srow3-spacer" />
                        <button
                          type="button"
                          className="plan-dash__btn"
                          onClick={() =>
                            void setOpenSessionOwner(row.coordOwnerId)
                          }
                          data-testid={`plan-dash-open-session-${row.coordOwnerId}`}
                        >
                          Open session
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {railDecisions.length > 0 ? (
            <div
              className="plan-dash__sec plan-dash__card"
              data-testid="plan-dash-decisions"
            >
              <div className="plan-dash__sec-h">
                Decisions
                <span className="plan-dash__sec-line" aria-hidden="true" />
                <span className="plan-dash__sec-h-note">
                  {railDecisions.length} decision
                  {railDecisions.length === 1 ? "" : "s"}
                </span>
              </div>
              {railDecisions.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  className="plan-dash__drow"
                  onClick={() => openPlanTarget(d.id)}
                  aria-label={`View full details for ${d.id}`}
                  data-testid={`plan-dash-decision-${d.id}`}
                >
                  <span className="plan-dash__dref">{d.id}</span>
                  <span
                    className="plan-dash__dtext"
                    title={d.title ?? d.body ?? d.id}
                  >
                    {d.title?.trim() || d.body?.trim().split("\n")[0] || d.id}
                  </span>
                  {d.date ? (
                    <span className="plan-dash__dago">{d.date}</span>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}

          <div className="plan-dash__sec plan-dash__card">
            <div className="plan-dash__sec-h">
              Recent activity
              <span className="plan-dash__sec-h-note">
                {collapsedEdits > 0
                  ? `${collapsedEdits} edits collapsed`
                  : "edits + work, newest first"}
              </span>
            </div>
            {activity.loading && (activity.data ?? []).length === 0 ? (
              <div className="plan-dash__empty">Loading activity…</div>
            ) : (activity.data ?? []).length === 0 ? (
              <div
                className="plan-dash__empty"
                data-testid="plan-dash-no-activity"
              >
                No activity on this plan yet.
              </div>
            ) : (
              <div className="plan-dash__feed" data-testid="plan-dash-feed">
                {feedEntries.map((entry, i) => {
                  // ≥2 consecutive generic "Plan edited (rev N)" rows by one
                  // author fold into a single run line (P-006).
                  if (entry.type === "run") {
                    return (
                      <div
                        key={`run-${i}`}
                        className="plan-dash__fitem plan-dash__frun"
                        data-testid="plan-dash-feed-run"
                      >
                        <span
                          className="plan-dash__fic plan-dash__fic--edit"
                          aria-hidden="true"
                        >
                          <Pencil size={11} />
                        </span>
                        <span className="plan-dash__ftext plan-dash__ftext--dim">
                          Plan edited ×{entry.count}
                          {entry.revLo != null && entry.revHi != null ? (
                            <span className="plan-dash__frun-rev">
                              rev {entry.revLo}–{entry.revHi}
                            </span>
                          ) : null}
                        </span>
                        <span className="plan-dash__fwho" title={entry.who}>
                          {entry.who ? shortOwnerId(entry.who) : ""}
                        </span>
                        <span className="plan-dash__fago">
                          {runAgo(entry.tsNewestMs, entry.tsOldestMs)}
                        </span>
                      </div>
                    );
                  }
                  const row = entry.row;
                  // A substantive rationale (checkpoint / handoff note) is the
                  // feed's real signal — promoted to a note card (P-006).
                  if (entry.type === "note") {
                    return (
                      <div
                        key={`note-${row.tsMs}-${i}`}
                        className="plan-dash__fnote"
                        data-testid="plan-dash-feed-note"
                      >
                        <span
                          className="plan-dash__fnote-text"
                          title={row.text}
                        >
                          {row.text ?? ""}
                        </span>
                        <span className="plan-dash__fnote-meta">
                          {row.who ? `${shortOwnerId(row.who)} · ` : ""}
                          {typeof row.tsMs === "number"
                            ? agoLabelMs(row.tsMs)
                            : "—"}
                        </span>
                      </div>
                    );
                  }
                  const kind = row.kind === "edit" ? "edit" : "work";
                  const inner = (
                    <>
                      <span
                        className={`plan-dash__fic plan-dash__fic--${kind}`}
                        aria-hidden="true"
                      >
                        {kind === "edit" ? (
                          <Pencil size={11} />
                        ) : (
                          <Hammer size={11} />
                        )}
                      </span>
                      <span className="plan-dash__ftext" title={row.text}>
                        {row.text ?? ""}
                      </span>
                      <span className="plan-dash__fwho" title={row.who}>
                        {row.who ? shortOwnerId(row.who) : ""}
                      </span>
                      <span className="plan-dash__fago">
                        {typeof row.tsMs === "number"
                          ? agoLabelMs(row.tsMs)
                          : "—"}
                      </span>
                    </>
                  );
                  // A work row carries a work-item ref — deep-link it to the
                  // work-item popup. Edit rows (`rev:N`) have no popup target.
                  const workRef = kind === "work" && row.ref ? row.ref : null;
                  return workRef ? (
                    <button
                      key={`${row.tsMs}-${i}`}
                      type="button"
                      className="plan-dash__fitem"
                      onClick={() =>
                        void setOpenWorkItem(encodeScopedRef(harness, workRef))
                      }
                      aria-label={`Open ${workRef}`}
                      data-testid={`plan-dash-feed-ref-${workRef}`}
                    >
                      {inner}
                    </button>
                  ) : (
                    <div key={`${row.tsMs}-${i}`} className="plan-dash__fitem">
                      {inner}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      <SessionChatModal
        sessionOwnerId={openSessionOwner}
        ownerLabel={openSessionOwner ? shortOwnerId(openSessionOwner) : null}
        onClose={() => void setOpenSessionOwner(null)}
      />
    </div>
  );
}
