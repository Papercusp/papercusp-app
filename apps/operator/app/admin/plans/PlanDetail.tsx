'use client';


import { Tooltip } from '@/app/harness/Tooltip';
/**
 * Plan detail view — the two-pane shell's main pane.
 *
 * P-105 + P-107: pinned "Now" hero strip above PlanEditor, fed by
 * plans:get. P-301: a read/edit toggle (`pane` nuqs key, D-007) — Edit
 * mode mounts the full editor, tracks a draft buffer, and Saves through
 * `plans:set-content` with the compare-and-swap handshake (D-011). On a
 * stale conflict PlanConflictModal lets the human reload or keep their
 * draft. While editing (or while the file is locked) the structured-
 * action strip is disabled — an assisted write would clobber the
 * unsaved draft (D-007).
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { markInteractionPhase, PERF_INTERACTIONS } from '@/app/_components/perf/perf-marks';
import { Drawer } from 'vaul';
import { useSyncQuery } from '@papercusp/sync';
import { PlanDocumentFrontmatter } from '@papercusp/ui-primitives';
import { parseAsInteger, parseAsString, parseAsStringEnum, useQueryState } from 'nuqs';
import {
  setPlanContent,
  staleConflictOf,
  usePlan,
  usePlanLint,
  usePlanLock,
  writeErrorOf,
} from './plans-api';
import PlanEditor from './PlanEditor';
import { buildFeatureSummary, scrollPlanTarget, stripFrontmatter, type PromotedFeature } from './plan-renderers';
import PlanJumpToItem from './PlanJumpToItem';
import LockBanner from './LockBanner';
import LintBanner from './LintBanner';
import PlanActions from './PlanActions';
import PlanInputsPanel from './PlanInputsPanel';
import AssignDialog from './AssignDialog';
import RevisionsPanel from './RevisionsPanel';
import RevisionDiffModal from './RevisionDiffModal';
import RevisionConversationModal from './RevisionConversationModal';
import AgentsPanel from './AgentsPanel';
import RunsPanel from './RunsPanel';
import PlanTriggersPanel from './PlanTriggersPanel';
import { PlanSpecCoverageSection } from './PlanSpecCoverageSection';
import { PlanProvenance } from './PlanProvenance';
import { PlanAcceptanceGateSection } from './PlanAcceptanceGateSection';
import PlanConflictModal from './PlanConflictModal';
import { useConfirmDialog } from '@/app/harness/useConfirmDialog';
import PlanStatusPopover, {
  resolveItemId,
  type PendingStatusFlip,
  type PlanStatus as PlanItemStatus,
} from './PlanStatusPopover';
import { usePlanRevisions } from './plans-api';
import type { PlanStatus, PlanStartStatus, PlanItem } from './plans-api';
import PlanKanbanView from './PlanKanbanView';
import { AuthorBadge } from '../../_components/AuthorBadge';

interface Props {
  slug: string;
  /** Resolved hive/home harness that owns this plan row. */
  harnessSlug?: string | null;
  onClose: () => void;
  /** Show the "← All plans" back button (default true). The Create dock
   *  embeds PlanDetail with an always-visible plan-list sidebar as the
   *  picker, so there is no "all plans" main view to return to — it passes
   *  `showBack={false}` to drop the button. */
  showBack?: boolean;
  /** Reports unsaved-edit state up to PlansClient so navigation away
   *  from a dirty plan can prompt before discarding (Bug-1 guard). */
  onDirtyChange?: (dirty: boolean) => void;
  /** Operational start state from harness_plans.op_status. */
  startStatus?: PlanStartStatus;
  /** Called after a successful start/pause so the rail can refresh. */
  onStartStatusChange?: (newStatus: PlanStartStatus) => void;
  /** Called after approve/demote (plan-level status flip) so the rail +
   *  bucket-tab counts refresh — the plan moves bucket. */
  onPlanStatusChange?: (status?: PlanStatus) => void;
}

export default function PlanDetail({ slug, harnessSlug, onClose, showBack = true, onDirtyChange, startStatus, onStartStatusChange, onPlanStatusChange }: Props) {
  markInteractionPhase(PERF_INTERACTIONS.planPopupOpen, 'detail-render-started');
  const { data, loading, error, refresh, setData } = usePlan(slug, { harnessSlug });
  useLayoutEffect(() => {
    markInteractionPhase(PERF_INTERACTIONS.planPopupOpen, 'detail-mounted');
  }, [slug, harnessSlug]);
  useLayoutEffect(() => {
    if (data && !loading && !error) {
      markInteractionPhase(PERF_INTERACTIONS.planPopupOpen, 'data-ready');
    }
  }, [data, loading, error]);
  const archived = data?.archived ?? false;
  const { data: lock } = usePlanLock(data ? slug : null, archived);
  const [writeTick, setWriteTick] = useState(0);
  // Bumped to force the inputs panel to re-read its verdict — after it saves, and
  // after a start the gate refused.
  const [inputsRefresh, setInputsRefresh] = useState(0);
  const { data: lintReport } = usePlanLint(data ? slug : null, writeTick);
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();
  const editorScopeRef = useRef<HTMLDivElement>(null);

  // P-013: subscribe to features promoted from this plan for live status badges.
  const { data: promotedRaw } = useSyncQuery<{
    featureId: string;
    harnessSlug: string;
    title: string | null;
    status: string | null;
  }>({
    queryName: 'featuresConsolidated.byPlanSlug',
    args: { planSlug: slug },
  });
  const promotedFeatures = useMemo(
    (): PromotedFeature[] => (Array.isArray(promotedRaw) ? promotedRaw : []),
    [promotedRaw],
  );
  const featureSummary = useMemo(
    () => buildFeatureSummary(promotedFeatures),
    [promotedFeatures],
  );

  // P-301 Edit-mode state.
  const [pane, setPane] = useQueryState(
    'pane',
    parseAsStringEnum(['read', 'edit']).withDefault('read'),
  );
  // plan-agent-launch P-020/P-021: which view of the plan is active.
  // 'editor' = the markdown editor; 'revisions' = the Revisions
  // panel (P-017); 'agents' = the Agents tab (P-021). nuqs-backed so
  // a tab + a deep-link (?rev= / ?convo= / ?run=) survive reload.
  // `ptab` (plan-detail tab), NOT `tab` — on /adv the top-level AdvShell
  // owns `?tab=` for its tab strip (plans/sessions/brainstorm/…). Sharing
  // the key meant opening a plan (which sets this to 'editor') clobbered
  // `tab=plans` → AdvShell saw an invalid id and fell back to brainstorm.
  const [tab, setTab] = useQueryState(
    'ptab',
    parseAsStringEnum(['editor', 'triggers', 'revisions', 'agents', 'runs']).withDefault('editor'),
  );
  const [itemView, setItemView] = useQueryState(
    'itemView',
    parseAsStringEnum<'list' | 'kanban'>(['list', 'kanban']).withDefault('list'),
  );
  const [activityOpen, setActivityOpen] = useQueryState(
    'activity',
    parseAsStringEnum<'open' | 'closed'>(['open', 'closed']).withDefault('closed'),
  );
  // P-018/P-019 modals — lifted from RevisionsPanel so a deep link
  // `?tab=editor&rev=42` still shows the modal even when the panel
  // itself isn't mounted. RevisionsPanel uses the same nuqs keys to
  // drive open from row clicks; we render the modals here.
  const [openRev, setOpenRev] = useQueryState('rev', parseAsInteger);
  const [openConvo, setOpenConvo] = useQueryState('convo', parseAsInteger);
  const [jump, setJump] = useQueryState('jump', parseAsString);
  const [draft, setDraft] = useState<string | null>(null);
  // P-025 (D-009): the "what changed & why" the editor's Save
  // surfaces. Carried into setPlanContent → recorded on the new
  // plan_revisions row → seeded into the next agent's launch bundle.
  // Cleared on enterEdit/exitEdit/save together with the draft.
  const [rationale, setRationale] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [pendingStatus, setPendingStatus] = useState<PendingStatusFlip | null>(null);
  const [selectedFeatureId, setSelectedFeatureId] = useState<string | null>(null);

  const onChanged = () => {
    refresh();
    setWriteTick((t) => t + 1);
  };

  // Optimistic plan-status flip (approve/demote): patch the open plan's
  // frontmatter status + raw status line in place and tell the rail to
  // patch its row — no refetch, so the detail + editor don't reload.
  const onOptimisticStatus = (status: PlanStatus) => {
    setData?.((prev) =>
      prev
        ? {
            ...prev,
            frontmatter: prev.frontmatter
              ? { ...prev.frontmatter, status }
              : prev.frontmatter,
            raw: prev.raw ? prev.raw.replace(/^(status:\s*)\S+/m, `$1${status}`) : prev.raw,
          }
        : prev,
    );
    onPlanStatusChange?.(status);
  };

  const raw = data?.raw ?? data?.prose ?? '';
  // In read mode the parsed frontmatter is already surfaced in
  // FrontmatterCard above the editor. Stripping the leading
  // `---\n…\n---\n` block from the rendered markdown prevents
  // Vditor.preview from showing it as a low-contrast paragraph
  // (was dark-blue-on-dark-blue and unreadable).
  const strippedRaw = data?.legacy ? raw : stripFrontmatter(raw);
  const editing = pane === 'edit';
  const dirty = editing && draft !== null && draft !== raw;
  const locked = !!lock;
  const enrichmentsPending = data?.enrichmentsDeferred === true;

  // A plan freshly (re)loaded while not editing: clear any stale draft.
  useEffect(() => {
    if (!editing) setDraft(null);
  }, [editing, slug]);

  // Report dirty state up so PlansClient can guard navigation away
  // from an unsaved edit. The unmount cleanup reports `false` so a
  // close/view-switch leaves the guard disarmed.
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  // Cross-plan inbox/actionable clicks deep-link here with ?jump=P-NNN.
  // Vditor preview rendering is async, so retry briefly until the
  // decorated markdown nodes exist, then clear the URL param.
  useEffect(() => {
    if (!jump || tab !== 'editor' || editing) return;
    let cancelled = false;
    const delays = [0, 80, 200, 500, 1000];
    const timers = delays.map((delay) =>
      window.setTimeout(() => {
        if (cancelled) return;
        if (scrollPlanTarget(editorScopeRef.current, jump)) {
          cancelled = true;
          void setJump(null);
        }
      }, delay),
    );
    return () => {
      cancelled = true;
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [editing, jump, setJump, slug, strippedRaw, tab]);

  if (loading) {
    return (
      <DetailShell slug={slug} onClose={onClose} showBack={showBack}>
        <p className="pc-plans__placeholder">Loading {slug}…</p>
      </DetailShell>
    );
  }
  if (error) {
    return (
      <DetailShell slug={slug} onClose={onClose} showBack={showBack}>
        <div className="pc-plans__placeholder pc-plans__placeholder--error">
          <p>Failed to load plan:</p>
          <code>{error}</code>
          <button type="button" className="pc-plans__retry" onClick={refresh}>
            Retry
          </button>
        </div>
      </DetailShell>
    );
  }
  if (!data || data.error) {
    // A `not_found` is a benign empty state — the plan is in a different hive's
    // harness, was deleted, or hasn't synced yet — NOT a server failure. Render
    // it calmly; only a genuine error gets the loud `Server: …` treatment. (This
    // is what made the Create tab show "Server: not_found" for a hive plan.)
    const message =
      data?.error === 'not_found'
        ? 'Plan not found.'
        : data?.error
          ? `Server: ${data.error}`
          : 'No data.';
    return (
      <DetailShell slug={slug} onClose={onClose} showBack={showBack}>
        <p className="pc-plans__placeholder">{message}</p>
      </DetailShell>
    );
  }

  const title = (data.frontmatter?.title as string | undefined) ?? data.slug;
  const planStatus = (data.frontmatter?.status as PlanStatus | undefined) ?? undefined;
  const draftSource: 'user' | 'scoper' | null =
    planStatus === 'draft' ? (data.slug.startsWith('scoper-proposal-') ? 'scoper' : 'user') : null;

  const enterEdit = () => {
    if (enrichmentsPending) return;
    setDraft(raw);
    setRationale('');
    setSaveError(null);
    setPane('edit');
    // P-020: clicking "Edit" from the Revisions tab implies "edit
    // this plan" — switch the tab too so the editor is actually
    // visible.
    setTab('editor');
  };
  const exitEdit = async () => {
    if (dirty && !await askConfirm({
      title: 'Discard unsaved edits?',
      body: 'Your current plan edits will be discarded.',
      confirmLabel: 'Discard',
      destructive: true,
    })) return;
    setDraft(null);
    setRationale('');
    setSaveError(null);
    setPane('read');
  };
  const save = async () => {
    if (draft === null || enrichmentsPending) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await setPlanContent({
        slug: data.slug,
        content: draft,
        // Optimistic version CAS (plans-pg-canonical D-005); expectedHash kept
        // as an equivalent fallback for an older server.
        expectedVersion: data.version,
        expectedHash: data.contentHash,
        rationale: rationale.trim() || undefined,
        ...(harnessSlug ? { harness: harnessSlug, harness_slug: harnessSlug } : {}),
      } as Parameters<typeof setPlanContent>[0] & { harness?: string; harness_slug?: string });
      const stale = staleConflictOf(res);
      if (stale) {
        setConflict(stale.currentContent);
        return;
      }
      const err = writeErrorOf(res);
      if (err) {
        setSaveError(err);
        return;
      }
      // Saved — drop the draft + rationale, return to read mode, refetch.
      setDraft(null);
      setRationale('');
      setPane('read');
      onChanged();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <DetailShell
      slug={slug}
      title={title}
      onClose={onClose}
      showBack={showBack}
      kickerExtra={
        draftSource ? (
          <span
            className={`pc-pill pc-pill--source-${draftSource}`}
            title={
              draftSource === "scoper"
                ? "Authored by the scoper"
                : "Authored by you"
            }
            style={{ marginLeft: 8 }}
          >
            {draftSource === "scoper" ? "scoper" : "you"}
          </span>
        ) : null
      }
      headerExtra={
        data.legacy ? null : (
          <>
            {/* P-008: assign the whole plan to an @user (cross-user handoff). */}
            <AssignDialog planSlug={data.slug} />
            <EditToggle
              editing={editing}
              dirty={dirty}
              locked={locked}
              pending={enrichmentsPending}
              onEnter={enterEdit}
              onExit={() => void exitEdit()}
            />
          </>
        )
      }
    >
      <LockBanner lock={lock} />
      {data.legacy ? (
        <div className="pc-plans__legacy-banner">
          Legacy plan — frontmatter not parsed; rendering raw markdown.
        </div>
      ) : null}
      {!data.legacy ? (
        <PlanActions
          slug={data.slug}
          harnessSlug={harnessSlug ?? data.harness ?? null}
          items={data.items}
          decisions={data.decisions}
          currentNow={data.now ?? null}
          planTitle={title}
          planStatus={planStatus}
          startStatus={startStatus}
          onStartStatusChange={onStartStatusChange}
          onPlanStatusChange={onPlanStatusChange}
          onOptimisticStatus={onOptimisticStatus}
          onChanged={onChanged}
          onRejected={onClose}
          disabled={editing || locked || enrichmentsPending}
          disabledReason={
            editing
              ? "Finish or discard your edits first"
              : locked
                ? `Locked by ${lock?.owner_label ?? lock?.owner}`
                : enrichmentsPending
                  ? "Finishing plan status data"
                  : undefined
          }
        />
      ) : null}
      {!data.legacy ? (
        // P-013: renders only for a plan that declares inputs, so it is invisible on
        // the great majority of plans. A refused start bumps `refreshToken`, which
        // re-reads the verdict — the human lands on the fields the gate named.
        <PlanInputsPanel
          slug={data.slug}
          harnessSlug={harnessSlug ?? data.harness ?? null}
          refreshToken={inputsRefresh}
          onSaved={() => setInputsRefresh((n) => n + 1)}
        />
      ) : null}
      {editing ? (
        <EditBar
          dirty={dirty}
          saving={saving}
          locked={locked}
          pending={enrichmentsPending}
          error={saveError}
          rationale={rationale}
          onRationaleChange={setRationale}
          onSave={save}
          onCancel={() => void exitEdit()}
        />
      ) : null}
      <LintBanner report={lintReport} scopeRef={editorScopeRef} />
      <PlanTabStrip
        tab={tab}
        editing={editing}
        onTab={(next) => {
          if (editing && next !== "editor") {
            // Going away from the editor mid-edit would visually
            // discard the draft. Confirm — same gate as exitEdit's
            // "discard unsaved edits".
            if (dirty) {
              void askConfirm({
                title: "Leave editor?",
                body: "Your current plan edits will be discarded when you leave the editor.",
                confirmLabel: "Leave",
                destructive: true,
              }).then((ok) => {
                if (ok) setTab(next);
              });
              return;
            }
          }
          setTab(next);
        }}
      />
      {tab === "editor" ? (
        <>
          {!editing ? (
            <div className="pc-plan-editor-tools">
              <button
                type="button"
                className="pc-plan-editor-tools__btn"
                onClick={() =>
                  setItemView(itemView === "kanban" ? "list" : "kanban")
                }
                aria-pressed={itemView === "kanban"}
              >
                {itemView === "kanban" ? "☰ List" : "⊞ Kanban"}
              </button>
              <Tooltip label="Show the plan's revision activity feed">
                <button
                  type="button"
                  className="pc-plan-editor-tools__btn"
                  onClick={() =>
                    setActivityOpen(activityOpen === "open" ? "closed" : "open")
                  }
                  aria-pressed={activityOpen === "open"}
                >
                  ⟲ Activity
                </button>
              </Tooltip>
            </div>
          ) : null}
          {!editing && itemView === "kanban" ? (
            <PlanKanbanView
              items={data.items ?? []}
              slug={slug}
              onChanged={onChanged}
            />
          ) : null}
          {editing || itemView === "list" ? (
            <>
              {!editing ? (
                <PlanJumpToItem
                  items={data.items}
                  decisions={data.decisions}
                  scopeRef={editorScopeRef}
                />
              ) : null}
              {/* Frontmatter + Now/Next sit directly under the in-plan jump/search
          (relocated from the top of the detail pane). */}
              {/* B1 (shared-hive-collaboration P-001): owner + last-editor badges. */}
              {data.ownerIdentity || data.lastEditor ? (
                <div
                  className="pc-plan-detail__authors"
                  style={{
                    display: "flex",
                    gap: 12,
                    alignItems: "center",
                    flexWrap: "wrap",
                    margin: "2px 0 6px",
                  }}
                  data-testid="plan-detail-authors"
                >
                  {data.ownerIdentity ? (
                    <AuthorBadge identity={data.ownerIdentity} prefix="owner" />
                  ) : null}
                  {data.lastEditor ? (
                    <AuthorBadge
                      identity={data.lastEditor}
                      prefix="edited by"
                    />
                  ) : null}
                </div>
              ) : null}
              {!data.legacy && data.frontmatter ? (
                <PlanDocumentFrontmatter
                  slug={data.slug}
                  frontmatter={data.frontmatter}
                />
              ) : null}
              {data.now ? (
                <NowHero
                  state={data.now.state}
                  next={data.now.next}
                  featureSummary={featureSummary}
                />
              ) : null}
              {/* P-011: ship-readiness belongs beside `## Now`, not buried in a tab — these are
          the first surfaces on which the acceptance gate and the spec-coverage census are
          visible WITHOUT attempting a ship. Both collapsed by default and `enabled`-gated.
          Gate first (what blocks the ship NOW), census second (the full coverage picture,
          which the gate's own short-circuit can hide). */}
              <PlanAcceptanceGateSection slug={data.slug} />
              <PlanSpecCoverageSection
                slug={data.slug}
                harnessSlug={harnessSlug ?? data.harness ?? null}
              />
              {/* plan-item-provenance P-005: always expanded (D-006) — a provenance chip
          behind a fold is the unread evidence this panel exists to surface. */}
              <PlanProvenance slug={data.slug} harnessSlug={harnessSlug ?? data.harness ?? null} />
              <div ref={editorScopeRef} className="pc-plan-editor-scope">
                <PlanEditor
                  value={editing ? (draft ?? raw) : strippedRaw}
                  slug={slug}
                  items={data.items}
                  promotedFeatures={
                    promotedFeatures.length > 0 ? promotedFeatures : undefined
                  }
                  linkedFeatures={data.linkedFeatures}
                  planItemTests={data.planItemTests}
                  // P-205: while another shell holds the lock, the editor is
                  // forced read-only even in edit mode — the draft is preserved
                  // (value still resolves to `draft ?? raw`), so editing resumes
                  // intact once the lock releases. The EditBar shows the lock
                  // state and Save stays disabled.
                  readOnly={!editing || locked || enrichmentsPending}
                  onChange={
                    editing && !locked && !enrichmentsPending
                      ? setDraft
                      : undefined
                  }
                  onFeatureClick={(featureId) =>
                    setSelectedFeatureId(featureId)
                  }
                  onStatusClick={(target, status) => {
                    // While editing, a setValue round-trip from set-status would
                    // clobber the draft — D-007 disables structured writes in that
                    // mode. The popover is read-mode-only.
                    if (editing || locked || enrichmentsPending) return;
                    const itemId = resolveItemId(target);
                    if (!itemId) return;
                    setPendingStatus({
                      target,
                      status: status as PlanItemStatus,
                      itemId,
                    });
                  }}
                />
              </div>
              <PlanStatusPopover
                pending={pendingStatus}
                slug={data.slug}
                onSuccess={onChanged}
                onClose={() => setPendingStatus(null)}
              />
            </>
          ) : null}
        </>
      ) : null}
      {tab === "revisions" ? <RevisionsPanel slug={data.slug} /> : null}
      {tab === "triggers" ? (
        <PlanTriggersPanel
          slug={data.slug}
          harnessSlug={harnessSlug ?? data.harness ?? null}
        />
      ) : null}
      {tab === "agents" ? (
        <AgentsPanel
          slug={data.slug}
          planTitle={title}
          currentContentHash={data.contentHash}
        />
      ) : null}
      {tab === "runs" ? (
        <RunsPanel
          slug={data.slug}
          planTitle={title}
          currentContentHash={data.contentHash}
        />
      ) : null}
      <PlanConflictModal
        open={conflict !== null}
        currentContent={conflict ?? ""}
        onReload={() => {
          setConflict(null);
          setDraft(null);
          setPane("read");
          onChanged();
        }}
        onKeepEditing={() => setConflict(null)}
      />
      {confirmEl}
      {/* Revision modals are mounted here (P-020) — not under the
       *  Revisions tab — so a deep link `?rev=42` / `?convo=42`
       *  resolves regardless of which tab is active. */}
      <RevisionDiffModal
        revisionId={openRev}
        onClose={() => setOpenRev(null)}
      />
      <RevisionConversationModal
        revisionId={openConvo}
        onClose={() => setOpenConvo(null)}
      />
      {selectedFeatureId
        ? (() => {
            const pf = promotedFeatures.find(
              (f) => f.featureId === selectedFeatureId,
            );
            return (
              <FeatureSlideOver
                featureId={selectedFeatureId}
                harnessSlug={pf?.harnessSlug ?? data.slug}
                featureTitle={pf?.title ?? null}
                featureStatus={pf?.status ?? null}
                onClose={() => setSelectedFeatureId(null)}
              />
            );
          })()
        : null}
      <PlanActivityFeed
        slug={slug}
        open={activityOpen === "open"}
        onClose={() => setActivityOpen("closed")}
      />
    </DetailShell>
  );
}

function EditToggle({
  editing,
  dirty,
  locked,
  pending,
  onEnter,
  onExit,
}: {
  editing: boolean;
  dirty: boolean;
  locked: boolean;
  pending: boolean;
  onEnter: () => void;
  onExit: () => void;
}) {
  if (editing) {
    return (
      <button
        type="button"
        className="pc-plans__editbtn is-on"
        onClick={onExit}
      >
        {dirty ? "Exit edit (unsaved)" : "Exit edit"}
      </button>
    );
  }
  return (
    <button
      type="button"
      className="pc-plans__editbtn"
      onClick={onEnter}
      disabled={locked || pending}
      aria-label={
        locked
          ? "Plan is locked by another shell"
          : pending
            ? "Finishing plan status data"
            : "Edit the raw markdown"
      }
    >
      Edit
    </button>
  );
}

function EditBar({
  dirty,
  saving,
  locked,
  pending,
  error,
  rationale,
  onRationaleChange,
  onSave,
  onCancel,
}: {
  dirty: boolean;
  saving: boolean;
  locked: boolean;
  pending: boolean;
  error: string | null;
  rationale: string;
  onRationaleChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="pc-editbar">
      <div className="pc-editbar__row">
        <span className="pc-editbar__hint">
          {locked
            ? "Locked by another shell — saving is disabled until it releases."
            : pending
              ? "Finishing plan status data before editing."
              : dirty
                ? "Unsaved changes."
                : "No changes yet."}
        </span>
        <span className="pc-editbar__spacer" />
        <button
          type="button"
          className="pc-editbar__btn"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </button>
        <button
          type="button"
          className="pc-editbar__btn pc-editbar__btn--primary"
          onClick={onSave}
          disabled={saving || locked || pending || !dirty}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {/* P-025 (D-009): the rationale input. Optional — D-009's
       *  "expectation scales with the write" applies — but agents
       *  launched from this plan see whatever is recorded here as
       *  always-loaded context, so a substantive edit should fill it
       *  in. Bound to the editor lifecycle (cleared on enter/exit/save). */}
      <div className="pc-editbar__row pc-editbar__row--rationale">
        <input
          type="text"
          className="pc-editbar__rationale"
          placeholder="What changed & why (optional — seeded into next agent launch)"
          value={rationale}
          onChange={(e) => onRationaleChange(e.target.value)}
          disabled={saving}
          aria-label="Rationale for this edit"
        />
      </div>
      {error ? <p className="pc-editbar__error">{error}</p> : null}
    </div>
  );
}

function DetailShell({
  slug,
  title,
  onClose,
  showBack = true,
  headerExtra,
  kickerExtra,
  children,
}: {
  slug: string;
  title?: string;
  onClose: () => void;
  showBack?: boolean;
  headerExtra?: React.ReactNode;
  kickerExtra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="pc-plans__detail" aria-label={`Plan ${slug}`}>
      <header className="pc-plans__detail-head">
        {showBack ? (
          <button type="button" className="pc-plans__back" onClick={onClose}>
            ← All plans
          </button>
        ) : null}
        <div className="pc-plans__detail-title">
          <span className="pc-plans__detail-kicker">
            Plan detail
            {kickerExtra}
          </span>
          <h2>{title ?? slug}</h2>
          {title && title !== slug ? (
            <span className="pc-plans__detail-slug">{slug}</span>
          ) : null}
        </div>
        <span className="pc-plans__detail-spacer" />
        {headerExtra}
      </header>
      {children}
    </section>
  );
}

type PlanDetailTab = 'editor' | 'triggers' | 'revisions' | 'agents' | 'runs';

/**
 * Top-level tab strip — P-020/P-021. Switches between the editor, the
 * Revisions panel, and the Agents tab. The active tab is `?tab=`
 * (nuqs). The strip is a `tablist`; the `editing` hint shows a
 * "unsaved edits" affordance on the non-editor tabs.
 */
function PlanTabStrip({
  tab,
  editing,
  onTab,
}: {
  tab: PlanDetailTab;
  editing: boolean;
  onTab: (next: PlanDetailTab) => void;
}) {
  return (
    <div className="pc-plans__tabs" role="tablist" aria-label="Plan view">
      <TabButton tab="editor" active={tab} onTab={onTab} label="Editor" />
      <TabButton
        tab="triggers"
        active={tab}
        onTab={onTab}
        label="Triggers"
        hint={editing ? 'unsaved edits' : undefined}
      />
      <TabButton
        tab="revisions"
        active={tab}
        onTab={onTab}
        label="Revisions"
        hint={editing ? 'unsaved edits' : undefined}
      />
      <TabButton
        tab="agents"
        active={tab}
        onTab={onTab}
        label="Agents"
        hint={editing ? 'unsaved edits' : undefined}
      />
      <TabButton
        tab="runs"
        active={tab}
        onTab={onTab}
        label="Runs"
        hint={editing ? 'unsaved edits' : undefined}
      />
    </div>
  );
}

function TabButton({
  tab,
  active,
  onTab,
  label,
  hint,
}: {
  tab: PlanDetailTab;
  active: PlanDetailTab;
  onTab: (next: PlanDetailTab) => void;
  label: string;
  hint?: string;
}) {
  const isActive = tab === active;
  return (
    <Tooltip label={hint}><button
      type="button"
      role="tab"
      aria-selected={isActive}
      className={`pc-plans__tab${isActive ? ' is-active' : ''}`}
      onClick={() => onTab(tab)}

    >
      {label}
      {hint ? <span className="pc-plans__tab-hint"> · {hint}</span> : null}
    </button></Tooltip>
  );
}

function NowHero({
  state,
  next,
  featureSummary,
}: {
  state: string | null;
  next: string | null;
  featureSummary?: string | null;
}) {
  if (!state && !next) return null;
  // The `## Now` block has a **State** (where things stand) and a **Next**
  // (the next action). We label the State row "Now" — it IS the current
  // state — instead of a bare "Now" eyebrow that reads as an empty field
  // above a separate "State". So the strip is just: Now: … / Next: ….
  return (
    <section className="pc-now-hero" aria-label="Now">
      {featureSummary ? (
        <div className="pc-now-hero__row">
          <span className="pc-now-hero__label">Features</span>
          <p style={{ color: 'var(--fg-mute)', fontSize: '0.85em' }}>{featureSummary}</p>
        </div>
      ) : null}
      {state ? (
        <div className="pc-now-hero__row">
          <span className="pc-now-hero__label">Now</span>
          <p>{state}</p>
        </div>
      ) : null}
      {next ? (
        <div className="pc-now-hero__row">
          <span className="pc-now-hero__label">Next</span>
          <p>{next}</p>
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// P-026 — Activity feed
// ---------------------------------------------------------------------------

function PlanActivityFeed({
  slug,
  open,
  onClose,
}: {
  slug: string;
  open: boolean;
  onClose: () => void;
}) {
  const { data: revisions, loading } = usePlanRevisions(open ? slug : null);

  return (
    <Drawer.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      direction="right"
      modal={false}
    >
      <Drawer.Portal>
        <Drawer.Overlay style={{ position: 'fixed', inset: 0, zIndex: 34, background: 'transparent', pointerEvents: 'none' }} />
        <Drawer.Content
          aria-label="Activity feed"
          style={{
            position: 'fixed', right: 0, top: 0, bottom: 0, zIndex: 35,
            width: 280, background: 'var(--surface-1)',
            borderLeft: '1px solid var(--border)',
            display: 'flex', flexDirection: 'column',
            outline: 'none',
          }}
        >
      <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Drawer.Title asChild>
          <h4 style={{ margin: 0, fontSize: '0.8em', fontWeight: 600 }}>Activity</h4>
        </Drawer.Title>
        <Drawer.Description className="pc-sr-only">
          The plan's revision activity feed.
        </Drawer.Description>
        <Tooltip label="Close"><button
          type="button"
          onClick={onClose}
          aria-label="Close activity feed"

          style={{ padding: '2px 8px', background: 'none', border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer', color: 'var(--fg-mute)', fontSize: '0.9em', lineHeight: 1 }}
        >
          ✕
        </button></Tooltip>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '10px 14px' }}>
        {loading ? <p style={{ color: 'var(--fg-mute)', fontSize: '0.8em' }}>Loading…</p> : null}
        {!loading && (!revisions || revisions.length === 0) ? (
          <p style={{ color: 'var(--fg-mute)', fontSize: '0.8em' }}>No activity yet.</p>
        ) : null}
        {revisions?.map((rev) => (
          <div key={rev.id} style={{ marginBottom: 12, fontSize: '0.78em' }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 2 }}>
              <span style={{
                fontSize: '0.8em', padding: '1px 5px', borderRadius: 3,
                background: rev.authorKind === 'agent' ? 'color-mix(in oklab, var(--accent), transparent 80%)' : 'color-mix(in oklab, var(--good), transparent 80%)',
                color: rev.authorKind === 'agent' ? 'var(--accent)' : 'var(--good)',
              }}>
                {rev.authorKind}
              </span>
              <time style={{ color: 'var(--fg-mute)', fontSize: '0.85em' }}>
                {new Date(rev.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })} {new Date(rev.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </time>
            </div>
            {rev.rationale ? (
              <p style={{ margin: '2px 0 0', color: 'var(--fg)', lineHeight: 1.4 }}>{rev.rationale.slice(0, 140)}{rev.rationale.length > 140 ? '…' : ''}</p>
            ) : (
              <p style={{ margin: '2px 0 0', color: 'var(--fg-mute)' }}>
                +{rev.diffStat?.added ?? 0} −{rev.diffStat?.removed ?? 0} lines
              </p>
            )}
          </div>
        ))}
      </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

// P-025 — Kanban view: extracted to ./PlanKanbanView (dnd-kit + @papercusp/sync).

// ---------------------------------------------------------------------------
// P-007 — Feature slide-over
// ---------------------------------------------------------------------------

interface TimelineEvent { iso: string; kind: string; detail: string }

function FeatureSlideOver({
  featureId,
  harnessSlug,
  featureTitle,
  featureStatus,
  onClose,
}: {
  featureId: string;
  harnessSlug: string;
  featureTitle: string | null;
  featureStatus: string | null;
  onClose: () => void;
}) {
  const timelineQuery = useSyncQuery<TimelineEvent>({
    queryName: 'featureTimeline.byFeature',
    args: { harnessSlug, featureId },
    enabled: !!harnessSlug && !!featureId,
  });
  const events = useMemo(() => (timelineQuery.data ?? []).slice().reverse(), [timelineQuery.data]);
  const loading = timelineQuery.loading;
  const error = timelineQuery.error ? String(timelineQuery.error) : null;

  const statusMeta: Record<string, { color: string }> = {
    passed:     { color: 'var(--good)' },
    failing:    { color: 'var(--bad)' },
    validating: { color: 'var(--warn)' },
    todo:       { color: 'var(--fg-mute)' },
  };
  const color = statusMeta[featureStatus ?? '']?.color ?? 'var(--fg-mute)';

  return (
    <Drawer.Root open onOpenChange={(next) => { if (!next) onClose(); }} direction="right">
      <Drawer.Portal>
        <Drawer.Overlay
          className="pc-feature-overlay"
          onClick={onClose}
          style={{ position: 'fixed', inset: 0, zIndex: 40, background: 'transparent' }}
        />
        <Drawer.Content
          className="pc-feature-drawer"
          aria-label={`Feature ${featureId}`}
          style={{
            position: 'fixed', right: 0, top: 0, bottom: 0, zIndex: 41,
            width: 'min(480px, 100vw)', background: 'var(--surface-1)',
            borderLeft: '1px solid var(--border)', display: 'flex',
            flexDirection: 'column', overflow: 'hidden', outline: 'none',
          }}
        >
        <header style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <code style={{ fontSize: '0.8em', color: 'var(--fg-mute)' }}>{featureId}</code>
              {featureStatus ? (
                <span style={{ fontSize: '10px', fontWeight: 600, padding: '1px 6px', borderRadius: 3, color, border: `1px solid color-mix(in oklab, ${color}, transparent 50%)`, background: `color-mix(in oklab, ${color}, transparent 85%)` }}>
                  {featureStatus}
                </span>
              ) : null}
            </div>
            <Drawer.Title asChild>
              {featureTitle ? <p style={{ margin: 0, fontWeight: 500, fontSize: '0.9em' }}>{featureTitle}</p> : <p style={{ margin: 0, fontWeight: 500, fontSize: '0.9em' }}>{featureId}</p>}
            </Drawer.Title>
            <Drawer.Description className="pc-sr-only">
              Timeline of events for feature {featureId}.
            </Drawer.Description>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{ padding: '4px 8px', background: 'none', border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer', color: 'var(--fg-mute)', flexShrink: 0 }}
          >
            ✕
          </button>
        </header>
        <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px' }}>
          <h4 style={{ margin: '0 0 12px', fontSize: '0.8em', textTransform: 'uppercase', color: 'var(--fg-mute)' }}>Timeline</h4>
          {loading ? <p style={{ color: 'var(--fg-mute)', fontSize: '0.875em' }}>Loading…</p> : null}
          {error ? <p style={{ color: 'var(--bad)', fontSize: '0.875em' }}>{error}</p> : null}
          {!loading && !error && events.length === 0 ? (
            <p style={{ color: 'var(--fg-mute)', fontSize: '0.875em' }}>No timeline events yet.</p>
          ) : null}
          {events.map((ev, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, marginBottom: 10, fontSize: '0.82em' }}>
              <time style={{ color: 'var(--fg-mute)', flexShrink: 0, whiteSpace: 'nowrap' }}>
                {new Date(ev.iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </time>
              <div>
                <span style={{ fontWeight: 500, marginRight: 6 }}>{(ev.kind ?? '').replace(/_/g, ' ')}</span>
                <span style={{ color: 'var(--fg-mute)' }}>{ev.detail ?? ''}</span>
              </div>
            </div>
          ))}
        </div>
        <footer style={{ padding: '12px 20px', borderTop: '1px solid var(--border)' }}>
          <a
            href={`/adv?h=${encodeURIComponent(harnessSlug)}&feature=${encodeURIComponent(featureId)}`}
            style={{ fontSize: '0.82em', color: 'var(--accent)' }}
          >
            Open in feature queue ↗
          </a>
        </footer>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
