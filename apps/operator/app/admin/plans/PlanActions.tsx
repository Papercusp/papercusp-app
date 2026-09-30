'use client';


import { Tooltip } from '@/app/harness/Tooltip';
/**
 * PlanActions — read-mode chrome strip for the structured-write verbs
 * (P-204, D-004 reconciled).
 *
 * Three buttons + three modal composers, all calling the assisted-
 * write tools through the typed client API:
 *
 *   Set Now      → plans:set-now    { state, next }
 *   +Decision    → plans:add-decision { title, body, refs? }
 *   +Item        → plans:add-item   { phase, text, blockedBy? }
 *
 * On success: invokes onChanged() so PlanDetail can refresh() the
 * underlying usePlan() — which round-trips the new markdown through
 * PlanEditor's setValue. On a domain error (ok: false from the verb)
 * the dialog stays open and shows the error. On a transport error,
 * same — Modal stays open, error rendered, user can retry.
 *
 * The vditor-toolbar variant (D-004 edit-mode surface) will reuse
 * these same dialog components from PLAN_TOOLBAR.click handlers
 * (P-202+).
 */

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Modal } from '@/app/harness/Modal';
import { Checkbox } from '@/app/harness/Checkbox';
import { Select } from '@/app/harness/Select';
import { useLexicon } from '@/lib/useLexicon';
import { useFlag } from '@/lib/flag-hooks';
import { FLAGS } from '@papercusp/flags';
import { launchAgent } from '@papercusp/operator-core/lib/launch-agent';
import {
  addPlanDecision,
  addPlanItem,
  approvePlan,
  bucketOf,
  demotePlanToDraft,
  rejectDraftPlan,
  setPlanNow,
  promoteToHarness,
  pausePlan,
  writeError,
  type PlanDecision,
  type PlanItem,
  type PlanStatus,
  type PlanStartStatus,
  type PromoteToHarnessResult,
  type WriteResult,
  type Importance,
  IMPORTANCE_LEVELS,
} from './plans-api';

interface Props {
  slug: string;
  /** Resolved hive/home harness that owns this plan row. */
  harnessSlug?: string | null;
  /** Existing items — used to pre-populate phase choices and ref typeahead. */
  items: PlanItem[] | undefined;
  decisions: PlanDecision[] | undefined;
  currentNow: { state: string | null; next: string | null } | null | undefined;
  /** Plan title — surfaced into the launched agent session label so the
   *  /adv/sessions list reads naturally. */
  planTitle?: string | null;
  /** Plan status drives draft-only affordances (Reject button) so /adv/plans
   *  has parity with the ProposalsPanel UX for drafts. */
  planStatus?: PlanStatus;
  /** Operational start state from harness_plans.op_status. null = never started. */
  startStatus?: PlanStartStatus;
  /** Called after a successful start/pause so the caller can refresh the list. */
  onStartStatusChange?: (newStatus: PlanStartStatus) => void;
  /** Fired after approve/demote (a plan-level status flip) so the caller can
   *  refresh the rail + bucket-tab counts — the plan changes bucket. */
  onPlanStatusChange?: () => void;
  /** Optimistic status setter — patches the open plan + rail row in place
   *  (no refetch) for instant approve/demote. Passed the new status; the
   *  caller flips it back if the server write fails. */
  onOptimisticStatus?: (status: PlanStatus) => void;
  /** Fired after a successful write so the caller can refresh plan data. */
  onChanged: () => void;
  /** Fired after a successful rejection — caller closes the detail. */
  onRejected?: () => void;
  /** Disabled while the file is locked or in raw-Edit mode. */
  disabled?: boolean;
  disabledReason?: string;
}

type Dialog = null | 'set-now' | 'add-decision' | 'add-item' | 'promote' | 'reject';

export default function PlanActions({
  slug,
  harnessSlug,
  items,
  decisions,
  currentNow,
  planTitle,
  planStatus,
  startStatus,
  onStartStatusChange,
  onPlanStatusChange,
  onOptimisticStatus,
  onChanged,
  onRejected,
  disabled,
  disabledReason,
}: Props) {
  const t = useLexicon();
  const [open, setOpen] = useState<Dialog>(null);
  const [launchingWorkbench, setLaunchingWorkbench] = useState(false);
  const [startPending, setStartPending] = useState(false);
  const [approvePending, setApprovePending] = useState(false);
  const [demotePending, setDemotePending] = useState(false);

  const isStarted = startStatus === 'started';
  // P-047: op_status is the retired OPERATIONAL axis; see the Start/Pause button below.
  // P-068/D-098: the tier flag is DELETED, so the old `mugKettleOn` read is gone and
  // START never shows — only PAUSE, and only for an already-started plan.
  // The lifecycle bucket drives which primary action shows: draft →
  // Approve (no start), ready → Start + Demote, running → Pause,
  // shipped/rejected → none. Derived from the same bucketOf the rail uses.
  const bucket = bucketOf({ status: planStatus ?? 'draft', startStatus: startStatus ?? undefined });

  // Approve/demote are pure plan-status flips. They apply optimistically
  // (instant rail + button update, no full refetch) and roll the status
  // back if the server write fails. Approval ONLY changes status — it does
  // not start the plan (the orchestrator runs only explicitly-started plans).
  const handleApprove = async () => {
    if (approvePending) return;
    const prev = planStatus;
    setApprovePending(true);
    onOptimisticStatus?.('ready');
    try {
      const r = await approvePlan(slug, harnessSlug ?? undefined);
      if (r.ok) {
        toast.success('Plan approved — ready to start.');
      } else {
        if (prev) onOptimisticStatus?.(prev);
        else onPlanStatusChange?.();
        toast.error(`Approve failed: ${r.error ?? 'unknown error'}`);
      }
    } catch (e) {
      if (prev) onOptimisticStatus?.(prev);
      toast.error(`Approve failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setApprovePending(false);
    }
  };

  const handleDemote = async () => {
    if (demotePending) return;
    const prev = planStatus;
    setDemotePending(true);
    onOptimisticStatus?.('draft');
    try {
      const r = await demotePlanToDraft(slug, harnessSlug ?? undefined);
      if (r.ok) {
        toast.success('Plan demoted to draft.');
      } else {
        if (prev) onOptimisticStatus?.(prev);
        else onPlanStatusChange?.();
        toast.error(`Demote failed: ${r.error ?? 'unknown error'}`);
      }
    } catch (e) {
      if (prev) onOptimisticStatus?.(prev);
      toast.error(`Demote failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDemotePending(false);
    }
  };

  // WI-38240: the START half is DELETED (it is really a PAUSE handler now). The button
  // below renders only when `isStarted` — P-047/D-010 kept PAUSE for an already-started
  // plan and dropped START — and `onClick` is its only caller, so the start branch, its
  // `isPlanStartRefusal` handling and the `onStartRefused` callback were all unreachable.
  const handleStartPause = async () => {
    if (startPending) return;
    setStartPending(true);
    try {
      await pausePlan(slug, harnessSlug);
      toast.success(`Plan paused — orchestrator will finish in-flight work then stop.`);
      onStartStatusChange?.('paused');
    } catch (e) {
      toast.error(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setStartPending(false);
    }
  };

  // Launch a session INTO the pui workbench (pui-reactive-session-panes D-006):
  // record a deferred "workbench launch" through the SAME backend path (no spawn,
  // no bespoke open-pane message); the pui reactively opens a work-area pane that
  // RUNS it. Works whether the pui is embedded in the desktop or standalone.
  const onLaunchWorkbench = async () => {
    if (launchingWorkbench) return;
    setLaunchingWorkbench(true);
    try {
      const label = planTitle?.trim() || slug;
      const result = await launchAgent({
        slug: null,
        planSlug: slug,
        label,
        agent: 'claude',
        deferSpawn: true,
      });
      if (result.ok) {
        toast.success(`Opening a workbench pane for ${slug}…`, { duration: 4000 });
      } else if (result.installCmd) {
        toast.error(
          `${result.error ?? 'launch prerequisites are missing.'} Run: ${result.installCmd}`,
          { duration: 12000 },
        );
      } else {
        toast.error(`Workbench launch failed: ${result.error ?? 'unknown error'}`, {
          duration: 10000,
        });
      }
    } finally {
      setLaunchingWorkbench(false);
    }
  };

  const phases = useMemo(() => {
    const seen = new Set<string>();
    for (const it of items ?? []) {
      if (it.phase) seen.add(it.phase);
    }
    return Array.from(seen);
  }, [items]);

  const knownItemIds = useMemo(() => (items ?? []).map((i) => i.id), [items]);

  return (
    <div className="pc-plan-actions">
      {bucket === 'draft' ? (
        <Tooltip label="Approve this draft — unlocks the Start button. Does not start the plan."><button
          type="button"
          className="pc-plan-actions__btn pc-plan-actions__btn--approve"
          onClick={handleApprove}
          disabled={approvePending}

        >
          {approvePending ? 'Approving…' : '✓ Approve Plan'}
        </button></Tooltip>
      ) : null}
      {/* retire-mug-kettle-su-only-2026-08-09 P-047 / D-010 — the SECOND owner-facing
          writer of the retired op_status axis (PlanRail's inline toggle is the other;
          `startPlan` has exactly these two callers). Same asymmetry as there and as the
          server: START goes, PAUSE survives for an already-started plan, because the
          DBOS frontier still reads op_status='started' and is not gated, so pause is
          the only remaining way to take a pre-P-047 plan out of its dispatch. */}
      {(bucket === 'ready' || bucket === 'running') && isStarted ? (
        <Tooltip label="Pause plan — orchestrator stops picking new features"><button
          type="button"
          className="pc-plan-actions__btn pc-plan-actions__btn--start pc-plan-actions__btn--started"
          onClick={handleStartPause}
          disabled={startPending}

        >
          {startPending ? 'Pausing…' : '⏸ Pause Plan'}
        </button></Tooltip>
      ) : null}
      {bucket !== 'shipped' && bucket !== 'rejected' ? (
        <Tooltip label={disabled
              ? disabledReason
              : 'Reject this plan — flips its status to superseded (kept, not deleted) and stops the orchestrator picking it up.'}><button
          type="button"
          className="pc-plan-actions__btn pc-plan-actions__btn--reject"
          onClick={() => setOpen('reject')}
          disabled={disabled}

        >
          Reject Plan
        </button></Tooltip>
      ) : null}
      {bucket === 'ready' ? (
        <Tooltip label="Demote back to draft — reverses approval; the orchestrator won't pick this up."><button
          type="button"
          className="pc-plan-actions__btn pc-plan-actions__btn--demote"
          onClick={handleDemote}
          disabled={demotePending}

        >
          {demotePending ? 'Demoting…' : '↩ Demote to Draft'}
        </button></Tooltip>
      ) : null}
      <Tooltip label={disabled ? disabledReason : 'Replace the ## Now block'}><button
        type="button"
        className="pc-plan-actions__btn"
        onClick={() => setOpen('set-now')}
        disabled={disabled}

      >
        Set Now
      </button></Tooltip>
      <Tooltip label={disabled
            ? disabledReason
            : 'Log a decision — the rationale behind a choice (rejected alternative, constraint, argument that settled it). Gets a permanent D-NNN id.'}><button
        type="button"
        className="pc-plan-actions__btn"
        onClick={() => setOpen('add-decision')}
        disabled={disabled}

      >
        + Decision
      </button></Tooltip>
      <Tooltip label={disabled
            ? disabledReason
            : 'Add an item — one concrete work unit under a phase. Tracked by status (todo / wip / done / …). Gets a permanent P-NNN id.'}><button
        type="button"
        className="pc-plan-actions__btn"
        onClick={() => setOpen('add-item')}
        disabled={disabled}

      >
        + Item
      </button></Tooltip>
      <Tooltip label={disabled
            ? disabledReason
            : `Promote todo/wip plan items to ${t('pot', { lower: true })} features via plans:promote`}><button
        type="button"
        className="pc-plan-actions__btn pc-plan-actions__btn--promote"
        onClick={() => setOpen('promote')}
        disabled={disabled || (items ?? []).filter((i) => i.effectiveStatus === 'todo' || i.effectiveStatus === 'wip').length === 0}

      >
        → {t('pot')}
      </button></Tooltip>
      <Tooltip label={`Launch an agent session for ${slug} as a pane in the pui workbench`}><button
        type="button"
        className="pc-plan-actions__btn pc-plan-actions__btn--launch"
        onClick={onLaunchWorkbench}
        disabled={launchingWorkbench}

      >
        {launchingWorkbench ? 'Launching…' : 'Launch agent'}
      </button></Tooltip>

      <SetNowDialog
        open={open === 'set-now'}
        onClose={() => setOpen(null)}
        slug={slug}
        initialState={currentNow?.state ?? ''}
        initialNext={currentNow?.next ?? ''}
        onSuccess={() => {
          setOpen(null);
          onChanged();
        }}
      />
      <AddDecisionDialog
        open={open === 'add-decision'}
        onClose={() => setOpen(null)}
        slug={slug}
        knownItemIds={knownItemIds}
        nextDecisionPreview={previewNextDecisionId(decisions)}
        onSuccess={() => {
          setOpen(null);
          onChanged();
        }}
      />
      <AddItemDialog
        open={open === 'add-item'}
        onClose={() => setOpen(null)}
        slug={slug}
        phases={phases}
        knownItemIds={knownItemIds}
        nextItemPreview={previewNextItemId(items)}
        onSuccess={() => {
          setOpen(null);
          onChanged();
        }}
      />
      <PromoteDialog
        open={open === 'promote'}
        onClose={() => setOpen(null)}
        slug={slug}
        items={items}
        onSuccess={(count) => {
          setOpen(null);
          toast.success(`Promoted ${count} feature${count === 1 ? '' : 's'} to ${t('pot', { lower: true })}. Worker will pick up shortly.`, { duration: 6000 });
          onChanged();
        }}
      />
      <RejectDialog
        open={open === 'reject'}
        onClose={() => setOpen(null)}
        slug={slug}
        harnessSlug={harnessSlug}
        planTitle={planTitle ?? null}
        onSuccess={() => {
          setOpen(null);
          // Rejecting a running plan must also stop the orchestrator —
          // superseding the frontmatter alone leaves the 'started' row,
          // and the orchestrator gates on that row, not the status.
          if (isStarted) {
            pausePlan(slug, harnessSlug).catch(() => {});
            onStartStatusChange?.('paused');
          }
          toast.success(`Rejected "${planTitle ?? slug}".`, { duration: 4000 });
          onRejected?.();
          onChanged();
        }}
      />
    </div>
  );
}

/** Pure: the next free D-NNN id (max existing + 1, zero-padded). Exported for tests.
 *  Defensive: a decision with a null/missing `id` (e.g. a trimmed/partial payload)
 *  is skipped rather than crashing the whole PlanDetail view via `id.match(...)`. */
export function previewNextDecisionId(decisions: PlanDecision[] | undefined): string {
  let max = 0;
  for (const d of decisions ?? []) {
    const id = typeof d?.id === 'string' ? d.id : '';
    const n = Number((id.match(/D-(\d{3,})$/) ?? [])[1] ?? 0);
    if (n > max) max = n;
  }
  return `D-${String(max + 1).padStart(3, '0')}`;
}

/** Pure: the next free P-NNN id (max existing + 1, zero-padded). Exported for tests.
 *  Defensive: an item with a null/missing `id` (e.g. a trimmed/partial payload) is
 *  skipped rather than crashing the whole PlanDetail view via `id.match(...)`. */
export function previewNextItemId(items: PlanItem[] | undefined): string {
  let max = 0;
  for (const it of items ?? []) {
    const id = typeof it?.id === 'string' ? it.id : '';
    const n = Number((id.match(/P-(\d{3,})$/) ?? [])[1] ?? 0);
    if (n > max) max = n;
  }
  return `P-${String(max + 1).padStart(3, '0')}`;
}

/* ── Set Now dialog ────────────────────────────────────────────────── */

function SetNowDialog({
  open,
  onClose,
  slug,
  initialState,
  initialNext,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  slug: string;
  initialState: string;
  initialNext: string;
  onSuccess: () => void;
}) {
  const [state, setState] = useState(initialState);
  const [next, setNext] = useState(initialNext);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset fields when the dialog re-opens after a refresh.
  useResetOnOpen(open, () => {
    setState(initialState);
    setNext(initialNext);
    setError(null);
  });

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const r = await setPlanNow({ slug, state: state.trim(), next: next.trim() });
      const err = writeError(r);
      if (err) setError(err);
      else onSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Set Now"
      srOnlyTitle
      contentClassName="pc-plan-dialog"
    >
      <form onSubmit={onSubmit} className="pc-plan-dialog__form">
        <header className="pc-plan-dialog__head">
          <h3>Set Now</h3>
          <p>Replace the plan's <code>## Now</code> block — the cold-resume anchor.</p>
        </header>
        <label className="pc-plan-dialog__field">
          <span>State</span>
          <textarea
            value={state}
            onChange={(e) => setState(e.target.value)}
            placeholder="One paragraph: where the plan currently stands."
            rows={3}
            maxLength={2000}
            required
            autoFocus
          />
        </label>
        <label className="pc-plan-dialog__field">
          <span>Next</span>
          <textarea
            value={next}
            onChange={(e) => setNext(e.target.value)}
            placeholder="One sentence: the single next concrete action and who should do it."
            rows={2}
            maxLength={800}
            required
          />
        </label>
        <DialogFooter
          error={error}
          submitting={submitting}
          submitLabel="Replace Now"
          onCancel={onClose}
          canSubmit={!!state.trim() && !!next.trim()}
        />
      </form>
    </Modal>
  );
}

/* ── Add Decision dialog ───────────────────────────────────────────── */

function AddDecisionDialog({
  open,
  onClose,
  slug,
  knownItemIds,
  nextDecisionPreview,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  slug: string;
  knownItemIds: string[];
  nextDecisionPreview: string;
  onSuccess: () => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [refsRaw, setRefsRaw] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useResetOnOpen(open, () => {
    setTitle('');
    setBody('');
    setRefsRaw('');
    setError(null);
  });

  const parsedRefs = useMemo(() => parseRefList(refsRaw), [refsRaw]);
  const unknownRefs = parsedRefs.filter((r) => !knownItemIds.includes(r));

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const r = await addPlanDecision({
        slug,
        title: title.trim(),
        body: body.trim(),
        refs: parsedRefs.length ? parsedRefs : undefined,
      });
      const err = writeError(r);
      if (err) setError(err);
      else onSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Add decision"
      srOnlyTitle
      contentClassName="pc-plan-dialog"
    >
      <form onSubmit={onSubmit} className="pc-plan-dialog__form">
        <header className="pc-plan-dialog__head">
          <h3>+ Decision</h3>
          <p>
            A <strong>decision</strong> is a rationale-log entry — capture
            why this choice was made and what was rejected. Append{' '}
            <code>{nextDecisionPreview}</code> to the{' '}
            <code>## Decisions</code> log.
          </p>
        </header>
        <label className="pc-plan-dialog__field">
          <span>Title</span>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Short imperative — e.g. UI goes through plans:* only"
            maxLength={200}
            required
            autoFocus
          />
        </label>
        <label className="pc-plan-dialog__field">
          <span>Body</span>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Paragraph or two. Reference items by P-NNN; they become links."
            rows={6}
            maxLength={5000}
            required
          />
        </label>
        <label className="pc-plan-dialog__field">
          <span>Item refs <em className="pc-plan-dialog__opt">(optional)</em></span>
          <input
            type="text"
            value={refsRaw}
            onChange={(e) => setRefsRaw(e.target.value)}
            placeholder="P-001, P-007 — items this decision relates to"
          />
          {unknownRefs.length ? (
            <span className="pc-plan-dialog__hint pc-plan-dialog__hint--warn">
              Unknown item IDs: {unknownRefs.join(', ')}
            </span>
          ) : null}
        </label>
        <DialogFooter
          error={error}
          submitting={submitting}
          submitLabel="Append decision"
          onCancel={onClose}
          canSubmit={!!title.trim() && !!body.trim()}
        />
      </form>
    </Modal>
  );
}

/* ── Add Item dialog ───────────────────────────────────────────────── */

function AddItemDialog({
  open,
  onClose,
  slug,
  phases,
  knownItemIds,
  nextItemPreview,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  slug: string;
  phases: string[];
  knownItemIds: string[];
  nextItemPreview: string;
  onSuccess: () => void;
}) {
  const [phase, setPhase] = useState(phases[0] ?? '');
  const [text, setText] = useState('');
  const [blockedByRaw, setBlockedByRaw] = useState('');
  const [importance, setImportance] = useState<Importance>('normal');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useResetOnOpen(open, () => {
    setPhase(phases[0] ?? '');
    setText('');
    setBlockedByRaw('');
    setImportance('normal');
    setError(null);
  });

  const parsedBlockedBy = useMemo(() => parseRefList(blockedByRaw), [blockedByRaw]);
  const unknownBlockers = parsedBlockedBy.filter((r) => !knownItemIds.includes(r));

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!phase.trim()) {
      setError('Phase is required — pick one or type a new heading.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const r = await addPlanItem({
        slug,
        phase: phase.trim(),
        text: text.trim(),
        blockedBy: parsedBlockedBy.length ? parsedBlockedBy : undefined,
        importance,
      });
      const err = writeError(r);
      if (err) setError(err);
      else onSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Add item"
      srOnlyTitle
      contentClassName="pc-plan-dialog"
    >
      <form onSubmit={onSubmit} className="pc-plan-dialog__form">
        <header className="pc-plan-dialog__head">
          <h3>+ Item</h3>
          <p>
            An <strong>item</strong> is one concrete work unit under a phase.
            Append <code>{nextItemPreview}</code>; a new phase heading is
            created if you type one that doesn't exist.
          </p>
        </header>
        <label className="pc-plan-dialog__field">
          <span>Phase</span>
          <input
            type="text"
            list="pc-plan-phases"
            value={phase}
            onChange={(e) => setPhase(e.target.value)}
            placeholder='e.g. "Phase 1 — Tooling"'
            required
            autoFocus
          />
          <datalist id="pc-plan-phases">
            {phases.map((p) => <option key={p} value={p} />)}
          </datalist>
        </label>
        <label className="pc-plan-dialog__field">
          <span>Text</span>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="What does this item do? One short sentence is best."
            rows={3}
            maxLength={800}
            required
          />
        </label>
        <label className="pc-plan-dialog__field">
          <span>Blocked by <em className="pc-plan-dialog__opt">(optional)</em></span>
          <input
            type="text"
            value={blockedByRaw}
            onChange={(e) => setBlockedByRaw(e.target.value)}
            placeholder="P-001, P-007 — items this one must wait on"
          />
          {unknownBlockers.length ? (
            <span className="pc-plan-dialog__hint pc-plan-dialog__hint--warn">
              Unknown item IDs: {unknownBlockers.join(', ')}
            </span>
          ) : null}
        </label>
        <label className="pc-plan-dialog__field">
          <span>Importance</span>
          <Select
            value={importance}
            onChange={(value) => setImportance(value as Importance)}
            ariaLabel="Plan item importance"
            options={IMPORTANCE_LEVELS.map((lvl) => ({ value: lvl, label: lvl }))}
          />
          <span className="pc-plan-dialog__hint">
            How much this matters — urgent (interrupt now / pick up first) · high
            (today) · normal (default) · low (safe to defer).
          </span>
        </label>
        <DialogFooter
          error={error}
          submitting={submitting}
          submitLabel="Append item"
          onCancel={onClose}
          canSubmit={!!phase.trim() && !!text.trim()}
        />
      </form>
    </Modal>
  );
}

/* ── Promote to Harness dialog ─────────────────────────────────────── */

function PromoteDialog({
  open,
  onClose,
  slug,
  items,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  slug: string;
  items: PlanItem[] | undefined;
  onSuccess: (count: number) => void;
}) {
  const t = useLexicon();
  const [harnessSlug, setHarnessSlug] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PromoteToHarnessResult | null>(null);

  const candidateItems = useMemo(
    () =>
      (items ?? []).filter(
        (i) => i.effectiveStatus === 'todo' || i.effectiveStatus === 'wip',
      ),
    [items],
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useResetOnOpen(open, () => {
    setHarnessSlug('');
    setSelected(new Set(candidateItems.map((i) => i.id)));
    setError(null);
    setResult(null);
  });

  // Keep selected in sync when candidateItems changes (e.g. dialog reopened).
  useEffect(() => {
    if (open) {
      setSelected(new Set(candidateItems.map((i) => i.id)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const toggleItem = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const hs = harnessSlug.trim();
    if (!hs) {
      setError(`${t('pot')} slug is required.`);
      return;
    }
    const features = candidateItems
      .filter((i) => selected.has(i.id))
      .map((i) => ({ title: i.text, from_items: [i.id] }));
    if (features.length === 0) {
      setError('Select at least one item to promote.');
      return;
    }
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const r = await promoteToHarness({ slug, harness_slug: hs, features, apply: true });
      if (!r.ok) {
        setError(r.error ?? 'promote failed');
      } else {
        setResult(r);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={`Promote to ${t('pot', { lower: true })}`}
      srOnlyTitle
      contentClassName="pc-plan-dialog"
    >
      {result ? (
        <div className="pc-plan-dialog__form">
          <header className="pc-plan-dialog__head">
            <h3>Promoted</h3>
            <p>
              {result.features_created ?? result.ids?.length ?? 0} feature(s) created in{' '}
              <strong>{harnessSlug}</strong>.
            </p>
          </header>
          <footer className="pc-plan-dialog__foot">
            <div className="pc-plan-dialog__buttons">
              <button
                type="button"
                className="pc-plan-dialog__btn pc-plan-dialog__btn--primary"
                onClick={() => onSuccess(result.features_created ?? result.ids?.length ?? 0)}
              >
                Done
              </button>
            </div>
          </footer>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="pc-plan-dialog__form">
          <header className="pc-plan-dialog__head">
            <h3>→ Promote to {t('pot')}</h3>
            <p>
              Creates {t('pot', { lower: true })} features from the selected plan items via{' '}
              <code>plans:promote</code>. Each item's text becomes the feature
              title; items are marked done after promotion.
            </p>
          </header>
          <label className="pc-plan-dialog__field">
            <span>{t('pot')} slug</span>
            <input
              type="text"
              value={harnessSlug}
              onChange={(e) => setHarnessSlug(e.target.value)}
              placeholder="e.g. papercup, sheets"
              required
              autoFocus
            />
          </label>
          <div className="pc-plan-dialog__field">
            <span>Items to promote ({selected.size} / {candidateItems.length} selected)</span>
            <div style={{ maxHeight: '240px', overflowY: 'auto', marginTop: '4px' }}>
              {candidateItems.length === 0 ? (
                <p style={{ color: 'var(--fg-mute)', fontSize: '0.85em' }}>
                  No todo/wip items to promote.
                </p>
              ) : (
                candidateItems.map((item) => (
                  <label
                    key={item.id}
                    style={{
                      display: 'flex',
                      gap: '8px',
                      alignItems: 'flex-start',
                      padding: '4px 0',
                      cursor: 'pointer',
                      fontSize: '0.85em',
                    }}
                  >
                    <Checkbox
                      checked={selected.has(item.id)}
                      onChange={() => toggleItem(item.id)}
                      ariaLabel={`Promote ${item.id}`}
                      style={{ marginTop: '2px', flexShrink: 0 }}
                    />
                    <span>
                      <code style={{ color: 'var(--fg-mute)', fontSize: '0.9em' }}>
                        {item.id}
                      </code>{' '}
                      {item.text}
                    </span>
                  </label>
                ))
              )}
            </div>
          </div>
          <DialogFooter
            error={error}
            submitting={submitting}
            submitLabel={`Promote ${selected.size} item${selected.size === 1 ? '' : 's'}`}
            onCancel={onClose}
            canSubmit={!!harnessSlug.trim() && selected.size > 0}
          />
        </form>
      )}
    </Modal>
  );
}

/* ── Reject draft dialog ───────────────────────────────────────────── */

function RejectDialog({
  open,
  onClose,
  slug,
  harnessSlug,
  planTitle,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  slug: string;
  harnessSlug?: string | null;
  planTitle: string | null;
  onSuccess: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useResetOnOpen(open, () => setError(null));

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const r = await rejectDraftPlan(slug, harnessSlug ?? undefined);
      if (!r.ok) {
        setError(r.error ?? 'reject failed');
      } else {
        onSuccess();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Reject draft"
      srOnlyTitle
      contentClassName="pc-plan-dialog"
    >
      <form onSubmit={onSubmit} className="pc-plan-dialog__form">
        <header className="pc-plan-dialog__head">
          <h3>Reject draft</h3>
          <p>
            Flip <strong>{planTitle ?? slug}</strong> from{' '}
            <code>status: draft</code> to <code>status: superseded</code>. The
            plan stays on disk but disappears from the proposals panel.
            Reversible by editing the frontmatter.
          </p>
        </header>
        <DialogFooter
          error={error}
          submitting={submitting}
          submitLabel="Reject draft"
          onCancel={onClose}
          canSubmit
        />
      </form>
    </Modal>
  );
}

/* ── Footer + helpers ──────────────────────────────────────────────── */

function DialogFooter({
  error,
  submitting,
  submitLabel,
  onCancel,
  canSubmit,
}: {
  error: string | null;
  submitting: boolean;
  submitLabel: string;
  onCancel: () => void;
  canSubmit: boolean;
}) {
  return (
    <footer className="pc-plan-dialog__foot">
      {error ? <p className="pc-plan-dialog__error">{error}</p> : null}
      <div className="pc-plan-dialog__buttons">
        <button
          type="button"
          className="pc-plan-dialog__btn"
          onClick={onCancel}
          disabled={submitting}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="pc-plan-dialog__btn pc-plan-dialog__btn--primary"
          disabled={submitting || !canSubmit}
        >
          {submitting ? 'Submitting…' : submitLabel}
        </button>
      </div>
    </footer>
  );
}

/**
 * Re-exported from plans-api so the existing `import { writeError } from
 * './PlanActions'` call sites and tests keep working. The implementation moved
 * there (WI-6941) because PlanStatusPopover had grown its OWN copy carrying the
 * same bug, and one reader of a wire shape should have one definition.
 */
export { writeError };

/** Pure: parse a free-text list of P-/D- refs (whitespace/comma separated), keeping only well-formed ids. Exported for tests. */
export function parseRefList(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => /^[PD]-\d{3,}$/.test(s));
}

/** Fire `reset()` every time `open` transitions false → true. */
function useResetOnOpen(open: boolean, reset: () => void) {
  useEffect(() => {
    if (open) reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}
