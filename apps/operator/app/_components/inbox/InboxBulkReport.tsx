"use client";

/**
 * Grouped Inbox bulk-resolve report (cleanup-report-flows-2026-08-24 P-008).
 *
 * The report projects the persisted run into the shared ReviewReportShell. A
 * selected row still dispatches through useBulkRunOps.acceptRecommendation —
 * the same resolve-first / record-second hand path the inline card uses. The
 * existing InboxBulkRecommendation remains the per-row detail; its expensive
 * detail-tier attention read mounts only while the shared row is hovered or
 * focus-within.
 */
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Sparkles } from "lucide-react";
import type { AttentionItem } from "@/app/admin/plans/plans-api";
import { usePlanAttentionItem } from "@/app/admin/plans/plans-api";
import { isNavigateAction } from "@/app/admin/plans/attention-card";
import { KIND_LABEL } from "@/app/admin/plans/PlanOtherList";
import RunLifecycleBar, {
  type RunLifecycleIntent,
} from "../review-report/RunLifecycleBar";
import type { ReviewReportPresentation } from "../review-report/ReviewReportHost";
import { chunkFindingIds } from "../review-report/run-resume-chunks";
import ReviewReportShell, {
  partitionReviewRows,
  reviewActionKey,
  reviewRowControl,
  ReviewRowActionButtons,
  type ReviewReportGroup,
  type ReviewReportRow,
  type ReviewRowAction,
  type ReviewRowMenuAction,
  type ReviewRowConfidence,
  type ReviewRowAccounting,
  type ReviewRowStatus,
} from "../review-report/ReviewReportShell";
import { PERF_INTERACTIONS } from "../perf/perf-marks";
import { useInteractionSettle } from "../perf/use-interaction-settle";
import InboxBulkRecommendation from "./InboxBulkRecommendation";
import {
  canonicalInboxDisposition,
  deriveRunCounts,
  useBulkRunOps,
  type BulkAcceptResult,
  type BulkRun,
  type BulkRunItem,
} from "./use-inbox-bulk-run";
import "./inbox-bulk-report.css";

function humanize(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function refString(
  ref: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = ref[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Rebuild the smallest AttentionItem the canonical terminal dispatcher needs
 * from the click-time row persisted in attention_bulk_run_items.
 *
 * This is deliberately fail-closed. `item_kind` and `item_ref.kind` were
 * snapshotted together; a legacy/corrupt row that lacks either, or whose two
 * discriminants disagree, stays visible in the report but cannot be selected.
 * DETAIL-only fields (especially `actions`) remain absent until the one active
 * explicitly opened detail hydrates through `plans.attentionItem`.
 */
export function bulkRunItemToAttentionSnapshot(
  runItem: BulkRunItem,
  run?: Pick<BulkRun, "harnessSlug">,
): AttentionItem | null {
  const refKind = runItem.ref?.kind;
  if (
    typeof refKind !== "string" ||
    !runItem.kind ||
    runItem.kind !== refKind
  ) {
    return null;
  }

  const ref = runItem.ref as AttentionItem["ref"];
  const harnessSlug =
    refString(runItem.ref, "harnessSlug") ??
    refString(runItem.ref, "targetHarness") ??
    run?.harnessSlug ??
    undefined;
  const planSlug =
    refKind === "plan-item" ? refString(runItem.ref, "slug") : undefined;
  const itemRef =
    refKind === "plan-item" ? refString(runItem.ref, "itemId") : undefined;

  return {
    id: runItem.itemId,
    kind: refKind as AttentionItem["kind"],
    source: "bulk-run-snapshot",
    ...(harnessSlug ? { harnessSlug } : {}),
    ...(planSlug ? { planSlug } : {}),
    ...(itemRef ? { itemRef } : {}),
    title: runItem.title ?? runItem.itemId,
    body: runItem.rationale ?? "",
    status: runItem.outcome,
    importance: "normal",
    tier: "decision",
    needsHuman: true,
    ...(runItem.ownerAgentId ? { ownerAgentId: runItem.ownerAgentId } : {}),
    triageState: "untriaged",
    ref,
  };
}

function itemKind(
  item: AttentionItem | undefined,
  runItem: BulkRunItem,
): string {
  return item?.kind ?? runItem.kind ?? "unknown";
}

function kindLabel(kind: string): string {
  return (KIND_LABEL as Record<string, string>)[kind] ?? humanize(kind);
}

function actionLabel(
  item: AttentionItem | undefined,
  runItem: BulkRunItem,
): string {
  if (runItem.revertedAt) return "Reverted";
  const action = runItem.actionId;
  if (runItem.recommendationLabel) return runItem.recommendationLabel;
  if (action) {
    return (
      item?.actions?.find((candidate) => candidate.id === action)?.label ??
      humanize(action)
    );
  }
  if (runItem.outcome === "pending") return "Not reached";
  if (runItem.outcome === "skipped") return "Skipped";
  if (runItem.outcome === "failed") return "Failed";
  return "Resolved";
}

export function bulkUndoAvailability(
  item: Pick<
    BulkRunItem,
    "outcome" | "revertHandle" | "reversalWindowUntil" | "revertedAt"
  >,
  nowMs = Date.now(),
): { available: boolean; reason?: string } {
  if (item.revertedAt)
    return { available: false, reason: "This action was already reverted." };
  if (item.outcome !== "auto_resolved" || !item.revertHandle) {
    return {
      available: false,
      reason:
        "Only an auto-applied action with a compensation handle can be undone.",
    };
  }
  const deadline = item.reversalWindowUntil
    ? Date.parse(item.reversalWindowUntil)
    : Number.NaN;
  if (!Number.isFinite(deadline))
    return {
      available: false,
      reason: "This historical action has no undo deadline.",
    };
  if (deadline <= nowMs)
    return { available: false, reason: "The bounded undo window has expired." };
  return { available: true };
}

function reviewStatus(
  runItem: BulkRunItem,
  locallyApplied: ReadonlySet<string>,
  locallyDismissed: ReadonlySet<string>,
): ReviewRowStatus {
  if (locallyApplied.has(runItem.itemId) || runItem.outcome === "auto_resolved")
    return "applied";
  if (locallyDismissed.has(runItem.itemId) || runItem.outcome === "dismissed")
    return "dismissed";
  return "pending";
}

function reviewAccounting(
  runItem: BulkRunItem,
  status: ReviewRowStatus,
  hasAction: boolean,
): ReviewRowAccounting {
  if (status === "applied") return "handled";
  if (status === "dismissed") return "not-applied";
  // Same distinction Plans draws: an item the resolver never reached is
  // unstarted work waiting on a resume, not work waiting on the owner.
  if (runItem.outcome === "pending") return "not-assessed";
  if (
    runItem.outcome !== "recommended" &&
    canonicalInboxDisposition(runItem) !== "recommended"
  ) {
    return "not-applied";
  }
  if (runItem.actionId === "answer" || !hasAction) return "manual";
  return "ready";
}

/**
 * The verb this row commits (D-001), in Inbox's own nouns. Same contract as
 * `planCleanupAction`: the label states what Apply does, and a row Apply cannot
 * commit says who has to act instead.
 */
function inboxBulkAction(
  runItem: BulkRunItem,
  status: ReviewRowStatus,
  accounting: ReviewRowAccounting,
  actionText: string,
): ReviewRowAction {
  if (status === "applied") {
    return { key: "resolved", tone: "good", description: "Already applied." };
  }
  if (status === "dismissed") {
    return { key: "skipped", tone: "manual", description: "Left alone." };
  }
  if (accounting === "not-assessed") {
    return {
      key: "assess",
      tone: "warn",
      description:
        "The resolver did not reach this item before the run settled — resume to assess it.",
    };
  }
  if (runItem.outcome === "failed") {
    return {
      key: "retry",
      tone: "warn",
      description:
        runItem.recommendation?.retryCondition ??
        "The resolver failed on this item; retry it.",
    };
  }
  if (accounting === "manual") {
    if (runItem.actionId === "answer" && runItem.draftAnswer?.trim()) {
      return {
        key: "answer",
        tone: "apply",
        description: "Send the drafted answer through the Inbox resolver.",
      };
    }
    return {
      key: runItem.actionId === "answer" ? "you-answer-it" : "you-handle-it",
      tone: "manual",
      description:
        runItem.actionId === "answer"
          ? "Needs an answer written by you before it can be sent."
          : "No safe automatic action — open the item and handle it.",
    };
  }
  const key = reviewActionKey(runItem.actionId);
  // Persisted/legacy action ids outside the shared map cannot truthfully enter
  // Apply-selected: the row and the commit button would have no common words.
  // The projection makes those rows manual before reaching here; keep this
  // fallback fail-closed for malformed input.
  return {
    key: key ?? "you-handle-it",
    description: `Apply: ${actionText}.`,
  };
}

function evidenceLines(runItem: BulkRunItem): string[] {
  const lines: string[] = [];
  if (runItem.recommendation?.label)
    lines.push(`next step · ${runItem.recommendation.label}`);
  if (runItem.recommendation?.responsibility) {
    lines.push(`responsibility · ${runItem.recommendation.responsibility}`);
  }
  if (runItem.recommendation?.confidence) {
    lines.push(`confidence · ${runItem.recommendation.confidence}`);
  }
  if (runItem.evidenceBasis?.length) {
    lines.push(`evidence · ${runItem.evidenceBasis.join("; ")}`);
  }
  if (runItem.rationale) lines.push(runItem.rationale);
  if (runItem.consulted) {
    lines.push(
      runItem.consultReply
        ? "Asker replied during consultation."
        : "Asker did not reply during consultation.",
    );
  }
  if (runItem.error) lines.push(`error · ${runItem.error}`);
  if (runItem.actionId) lines.push(`recommended action · ${runItem.actionId}`);
  return lines.length > 0 ? lines : [`run position · ${runItem.position + 1}`];
}

/** Typed recommendations and their persisted projection are authoritative.
 * Legacy rows retain the old high/low value; rows never assessed by the
 * resolver expose insufficient confidence instead of inventing certainty. */
export function inboxBulkReviewConfidence(
  runItem: BulkRunItem,
): ReviewRowConfidence {
  return (
    runItem.recommendation?.confidence ??
    runItem.confidenceLevel ??
    runItem.confidence ??
    "insufficient"
  );
}

function fallbackDetail(runItem: BulkRunItem): ReactNode {
  if (runItem.recommendation) {
    return (
      <>
        <strong>{runItem.recommendation.label}</strong>:{" "}
        {runItem.recommendation.rationale}
        {runItem.recommendation.retryCondition ? (
          <> Retry condition: {runItem.recommendation.retryCondition}</>
        ) : null}
      </>
    );
  }
  if (runItem.outcome === "pending")
    return "The resolver did not reach this item before the run settled.";
  if (runItem.outcome === "skipped")
    return (
      runItem.rationale ?? "The resolver could not safely recommend an action."
    );
  if (runItem.outcome === "failed")
    return runItem.error ?? "The resolver failed while evaluating this item.";
  if (runItem.outcome === "auto_resolved")
    return (
      runItem.rationale ?? "Resolved automatically with recorded evidence."
    );
  return null;
}

/** Pure run → grouped-report projection. Exported so the grouping, statuses,
 * and selectable policy are pinned independently from network behavior. */
export function buildInboxBulkReviewGroups(
  runItems: readonly BulkRunItem[],
  attentionById: ReadonlyMap<string, AttentionItem>,
  locallyApplied: ReadonlySet<string> = new Set(),
  localErrors: ReadonlyMap<string, string> = new Map(),
  locallyDismissed: ReadonlySet<string> = new Set(),
  detailFor?: (
    item: AttentionItem,
    runItem: BulkRunItem,
    actions?: ReviewRowMenuAction[],
  ) => ReactNode,
  openSource?: (item: AttentionItem) => void,
  rowActions?: (
    runItem: BulkRunItem,
    item: AttentionItem | undefined,
  ) => ReviewRowMenuAction[],
): ReviewReportGroup[] {
  const grouped = new Map<string, ReviewReportGroup>();
  const ordered = [...runItems].sort(
    (a, b) => a.position - b.position || a.itemId.localeCompare(b.itemId),
  );

  for (const runItem of ordered) {
    const item = attentionById.get(runItem.itemId);
    const kind = itemKind(item, runItem);
    const action = actionLabel(item, runItem);
    const disposition = canonicalInboxDisposition(runItem);
    // Keep the raw skipped key stable for deep links/tests from pre-1015 runs;
    // the human-facing title/evidence still uses the canonical recommendation.
    const groupKey = runItem.outcome === "skipped" ? "skipped" : disposition;
    const groupId = `${runItem.actionId ?? groupKey}:${kind}`;
    let group = grouped.get(groupId);
    if (!group) {
      group = {
        id: groupId,
        title: `${action} · ${kindLabel(kind)}`,
        description: `Run items grouped by next step and source kind.`,
        rows: [],
      };
      grouped.set(groupId, group);
    }

    const status = reviewStatus(runItem, locallyApplied, locallyDismissed);
    const localError = localErrors.get(runItem.itemId);
    // A row whose apply FAILED leaves the pending pool (P-010): it keeps its
    // reason and gains a Retry verb, but pressing Apply again must not blind-
    // re-dispatch it. Recovery is deliberate — the run bar's "Re-check and
    // retry", or the row's own drill-in.
    const applyFailed = localError != null && status === "pending";
    const sharedActionKey = reviewActionKey(runItem.actionId);
    const hasAction =
      sharedActionKey != null &&
      (!isNavigateAction(runItem.actionId!) ||
        (runItem.actionId === "answer" &&
          Boolean(runItem.draftAnswer?.trim())));
    const accounting = reviewAccounting(
      runItem,
      status,
      hasAction && Boolean(item),
    );
    const recoveryActions = rowActions ? rowActions(runItem, item) : [];
    const row: ReviewReportRow = {
      id: runItem.itemId,
      title: item?.title ?? runItem.title ?? runItem.itemId,
      action: applyFailed
        ? {
            key: "retry" as const,
            tone: "warn" as const,
            description: `The resolve failed: ${localError}. Re-check it, then apply it again.`,
          }
        : inboxBulkAction(runItem, status, accounting, action),
      sourceLabel: kindLabel(kind),
      ...(openSource && item
        ? {
            onOpenSource: () => openSource(item),
            openSourceLabel: `Open ${item.title ?? runItem.itemId}`,
          }
        : {}),
      referenceLabel: action,
      evidence: evidenceLines(runItem),
      confidence: inboxBulkReviewConfidence(runItem),
      accounting,
      status,
      selectable:
        !applyFailed &&
        status === "pending" &&
        runItem.outcome === "recommended" &&
        hasAction &&
        Boolean(item),
      error: localError,
      ...(rowActions ? { actions: recoveryActions } : {}),
      detail:
        status === "pending" && item && detailFor
          ? detailFor(item, runItem, recoveryActions)
          : fallbackDetail(runItem),
    };
    if (applyFailed) {
      let failedGroup = grouped.get(INBOX_BULK_FAILED_GROUP_ID);
      if (!failedGroup) {
        failedGroup = {
          id: INBOX_BULK_FAILED_GROUP_ID,
          title: "Failed to apply",
          description:
            "Nothing was left half-resolved. Each row says why it failed; re-check them before applying again.",
          rows: [],
        };
        grouped.set(INBOX_BULK_FAILED_GROUP_ID, failedGroup);
      }
      failedGroup.rows.push(row);
      continue;
    }
    group.rows.push(row);
  }

  return (
    [...grouped.values()]
      .filter((group) => group.rows.length > 0)
      .flatMap((group) => {
        const actionable = group.rows.filter((row) => row.selectable === true);
        const otherResults = group.rows.filter(
          (row) => row.selectable !== true,
        );

        // A completed row can carry the same persisted action id as a still-live
        // recommendation. Keep the actionable rows in the canonical group and
        // move the non-selectable history behind its own existing disclosure;
        // otherwise one live action eagerly mounts every historical detail row.
        if (actionable.length === 0 || otherResults.length === 0)
          return [group];

        return [
          { ...group, rows: actionable },
          {
            ...group,
            id: `${group.id}:other-results`,
            title: `${group.title} · Other results`,
            description:
              "Already handled or non-selectable results for this action.",
            rows: otherResults,
          },
        ];
      })
      // Failures lead: they are the only rows carrying an unhandled consequence
      // of the owner's last click (P-010). Everything else stays alphabetical.
      .sort((a, b) => {
        const aFailed = a.id === INBOX_BULK_FAILED_GROUP_ID ? 0 : 1;
        const bFailed = b.id === INBOX_BULK_FAILED_GROUP_ID ? 0 : 1;
        return aFailed - bFailed || a.title.localeCompare(b.title);
      })
  );
}

interface HydratedRecommendationProps {
  listItem: AttentionItem;
  runItem: BulkRunItem;
  busy: boolean;
  onAccept: (
    item: AttentionItem,
    draftOverride: string | null,
  ) => Promise<{ ok: boolean; error?: string }>;
  onDiscuss?: (item: AttentionItem) => void;
  recoveryActions?: ReviewRowMenuAction[];
}

function HydratedRecommendation({
  listItem,
  runItem,
  busy,
  onAccept,
  onDiscuss,
  recoveryActions = [],
}: HydratedRecommendationProps) {
  const detail = usePlanAttentionItem(listItem.id);
  if (detail.loading) {
    return (
      <>
        <span
          className="inbox-bulk-report__detail-loading"
          role="status"
          aria-live="polite"
        >
          Loading this item&rsquo;s live options…
        </span>
        <ReviewRowActionButtons
          actions={recoveryActions}
          busy={busy}
          testIdPrefix={`inbox-bulk-${runItem.itemId}`}
          testIdForAction={(id) =>
            id === "reconcile"
              ? `inbox-bulk-reconcile-${runItem.itemId}`
              : id === "dismiss"
                ? `inbox-bulk-dismiss-item-${runItem.itemId}`
                : `inbox-bulk-${id}-${runItem.itemId}`
          }
        />
      </>
    );
  }
  if (detail.error) {
    return (
      <>
        <span className="inbox-bulk-report__detail-loading" role="alert">
          Could not load this item&rsquo;s current options: {detail.error}
        </span>
        <ReviewRowActionButtons
          actions={recoveryActions}
          busy={busy}
          testIdPrefix={`inbox-bulk-${runItem.itemId}`}
          testIdForAction={(id) =>
            id === "reconcile"
              ? `inbox-bulk-reconcile-${runItem.itemId}`
              : id === "dismiss"
                ? `inbox-bulk-dismiss-item-${runItem.itemId}`
                : `inbox-bulk-${id}-${runItem.itemId}`
          }
        />
      </>
    );
  }
  if (!detail.data) {
    return (
      <>
        <span className="inbox-bulk-report__detail-loading" role="status">
          This item is no longer available in the live Inbox. If you resolved it
          manually, mark it resolved here; otherwise Retry or dismiss it.
        </span>
        <ReviewRowActionButtons
          actions={recoveryActions}
          busy={busy}
          testIdPrefix={`inbox-bulk-${runItem.itemId}`}
          testIdForAction={(id) =>
            id === "reconcile"
              ? `inbox-bulk-reconcile-${runItem.itemId}`
              : id === "dismiss"
                ? `inbox-bulk-dismiss-item-${runItem.itemId}`
                : `inbox-bulk-${id}-${runItem.itemId}`
          }
        />
      </>
    );
  }

  const hydratedItem = { ...listItem, ...detail.data };
  return (
    <>
      {runItem.outcome === "recommended" ? (
        <InboxBulkRecommendation
          item={hydratedItem}
          rec={runItem}
          busy={busy}
          onAccept={(draftOverride) => onAccept(hydratedItem, draftOverride)}
          onDiscuss={onDiscuss ? () => onDiscuss(hydratedItem) : undefined}
        />
      ) : (
        <span className="inbox-bulk-report__detail-loading">
          {fallbackDetail(runItem)}
        </span>
      )}
      <ReviewRowActionButtons
        actions={recoveryActions}
        busy={busy}
        testIdPrefix={`inbox-bulk-${runItem.itemId}`}
        testIdForAction={(id) =>
          id === "reconcile"
            ? `inbox-bulk-reconcile-${runItem.itemId}`
            : id === "dismiss"
              ? `inbox-bulk-dismiss-item-${runItem.itemId}`
              : `inbox-bulk-${id}-${runItem.itemId}`
        }
      />
    </>
  );
}

/** One-at-a-time detail hydration keeps a 200-row report from opening 200
 * detail subscriptions just to render its overview. */
export function InboxBulkRecommendationDetail(
  props: HydratedRecommendationProps,
) {
  return (
    <div
      className="inbox-bulk-report__hover-detail"
      data-testid={`inbox-bulk-detail-${props.runItem.itemId}`}
    >
      <div className="inbox-bulk-report__detail-head">
        <strong>{props.listItem.title}</strong>
        <span>
          Review the live options, adjust the reply if needed, then accept or
          discuss.
        </span>
      </div>
      <HydratedRecommendation {...props} />
    </div>
  );
}

/** The group a failed apply lands in — named so the run bar's `reveal` intent
 *  can address it without either side guessing the string (P-010). */
export const INBOX_BULK_FAILED_GROUP_ID = "apply-failed";

export interface InboxBulkReportProps {
  run: BulkRun;
  runItems: BulkRunItem[];
  /** Which phase family the shared host admitted this report under (D-005). */
  presentation?: ReviewReportPresentation;
  /** A live run's rows are still being written; batch Apply is withheld. */
  readOnly?: boolean;
  onOpenThread?: (item: AttentionItem) => void;
  onClose: () => void;
}

export default function InboxBulkReport({
  run,
  runItems,
  presentation = "review",
  readOnly = false,
  onOpenThread,
  onClose,
}: InboxBulkReportProps) {
  // P-013: the lazy chunk and persisted run have both resolved by the time this
  // component commits. Passive settlement preserves the perf-marks ordering
  // contract; direct/deep-linked mounts have no start and therefore no-op.
  useInteractionSettle(PERF_INTERACTIONS.inboxBulkReportOpen, true);
  const {
    acceptRecommendation,
    dismissItem,
    reconcileItem,
    undoItem,
    resume,
    restart,
    stop,
    start,
  } = useBulkRunOps();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // P-010: what the in-flight apply is doing, and what the last one did.
  const [applying, setApplying] = useState<{
    done: number;
    total: number;
    current?: string;
  } | null>(null);
  const [applyResult, setApplyResult] = useState<{
    applied: number;
    failed: number;
  } | null>(null);
  const [revealRequest, setRevealRequest] = useState<{
    groupId: string;
    seq: number;
  } | null>(null);
  const [locallyApplied, setLocallyApplied] = useState<Set<string>>(
    () => new Set(),
  );
  const [locallyDismissed, setLocallyDismissed] = useState<Set<string>>(
    () => new Set(),
  );
  const [localErrors, setLocalErrors] = useState<Map<string, string>>(
    () => new Map(),
  );
  const attentionById = useMemo(() => {
    const snapshots = new Map<string, AttentionItem>();
    for (const runItem of runItems) {
      const snapshot = bulkRunItemToAttentionSnapshot(runItem, run);
      if (snapshot) snapshots.set(snapshot.id, snapshot);
    }
    return snapshots;
  }, [run.harnessSlug, runItems]);
  const runItemById = useMemo(
    () => new Map(runItems.map((item) => [item.itemId, item])),
    [runItems],
  );

  const applyRecommendation = useCallback(
    async (
      item: AttentionItem,
      runItem: BulkRunItem,
      draftOverride?: string | null,
    ): Promise<BulkAcceptResult> => {
      const effective =
        draftOverride === undefined
          ? runItem
          : { ...runItem, draftAnswer: draftOverride };
      const result = await acceptRecommendation(run.runId, item, effective);
      if (!result.ok) {
        setLocalErrors((previous) =>
          new Map(previous).set(
            runItem.itemId,
            result.error ?? "The item did not accept that action.",
          ),
        );
        return result;
      }
      setLocallyApplied((previous) => new Set(previous).add(runItem.itemId));
      setLocalErrors((previous) => {
        const next = new Map(previous);
        next.delete(runItem.itemId);
        return next;
      });
      return result;
    },
    [acceptRecommendation, run.runId],
  );

  const acceptSingle = useCallback(
    async (
      item: AttentionItem,
      runItem: BulkRunItem,
      draftOverride: string | null,
    ): Promise<{ ok: boolean; error?: string }> => {
      if (busy)
        return {
          ok: false,
          error: "Another report action is already running.",
        };
      setBusy(true);
      setNotice(null);
      try {
        const result = await applyRecommendation(item, runItem, draftOverride);
        if (result.phase === "complete") onClose();
        return result;
      } finally {
        setBusy(false);
      }
    },
    [applyRecommendation, busy, onClose],
  );

  const clearItemError = useCallback((itemId: string) => {
    setLocalErrors((previous) => {
      if (!previous.has(itemId)) return previous;
      const next = new Map(previous);
      next.delete(itemId);
      return next;
    });
  }, []);

  const retryItem = useCallback(
    async (runItem: BulkRunItem) => {
      if (busy) return;
      setBusy(true);
      try {
        const result = await resume(run.runId, [runItem.itemId]);
        if (!result.ok) {
          setLocalErrors((previous) =>
            new Map(previous).set(
              runItem.itemId,
              result.error ?? "The resolver could not retry this item.",
            ),
          );
          return;
        }
        clearItemError(runItem.itemId);
        onClose();
      } finally {
        setBusy(false);
      }
    },
    [busy, clearItemError, onClose, resume, run.runId],
  );

  const dismissOne = useCallback(
    async (runItem: BulkRunItem) => {
      if (busy) return;
      setBusy(true);
      try {
        const result = await dismissItem(
          run.runId,
          runItem.itemId,
          "Owner dismissed this item from the grouped recovery report",
        );
        if (!result.ok) {
          setLocalErrors((previous) =>
            new Map(previous).set(
              runItem.itemId,
              result.error ?? "The item could not be dismissed.",
            ),
          );
          return;
        }
        clearItemError(runItem.itemId);
        setLocallyDismissed((previous) =>
          new Set(previous).add(runItem.itemId),
        );
        if (result.phase === "complete") onClose();
      } finally {
        setBusy(false);
      }
    },
    [busy, clearItemError, dismissItem, onClose, run.runId],
  );

  const reconcileOne = useCallback(
    async (runItem: BulkRunItem) => {
      if (busy) return;
      setBusy(true);
      try {
        const result = await reconcileItem(run.runId, runItem.itemId);
        if (!result.ok) {
          setLocalErrors((previous) =>
            new Map(previous).set(
              runItem.itemId,
              result.error ??
                "The manual source resolution could not be recorded.",
            ),
          );
          return;
        }
        clearItemError(runItem.itemId);
        setLocallyApplied((previous) => new Set(previous).add(runItem.itemId));
        if (result.phase === "complete") onClose();
      } finally {
        setBusy(false);
      }
    },
    [busy, clearItemError, onClose, reconcileItem, run.runId],
  );

  const undoOne = useCallback(
    async (runItem: BulkRunItem) => {
      if (busy) return;
      setBusy(true);
      try {
        const result = await undoItem(run.runId, runItem.itemId);
        if (!result.ok) {
          setLocalErrors((previous) =>
            new Map(previous).set(
              runItem.itemId,
              result.error ?? "The action could not be undone.",
            ),
          );
          return;
        }
        clearItemError(runItem.itemId);
        setNotice(`Reverted ${runItem.title ?? runItem.itemId}.`);
      } finally {
        setBusy(false);
      }
    },
    [busy, clearItemError, run.runId, undoItem],
  );

  // P-008: Inbox already HAD Retry/Dismiss/Reconcile — buried in a drill-in
  // that only mounts for `pending` rows carrying a hydrated snapshot, so the
  // rows that most needed recovery (no snapshot, already failed) had none.
  // Hoisting them onto the row is what makes them reachable at all (R8).
  const rowActions = useCallback(
    (
      runItem: BulkRunItem,
      item: AttentionItem | undefined,
      // Every entry comes from the shared registry (REVIEW_ROW_CONTROLS), so
      // this flow owns only its subject nouns, its availability rules and its
      // handlers — never the wording. Plans' `recheck` is one line away here
      // rather than a re-implementation.
    ): ReviewRowMenuAction[] => [
      reviewRowControl("undo", {
        disabled: !bulkUndoAvailability(runItem).available,
        disabledReason: bulkUndoAvailability(runItem).reason,
        run: () => void undoOne(runItem),
      }),
      reviewRowControl("apply-one", {
        disabled: !item || runItem.outcome !== "recommended",
        disabledReason: !item
          ? "This row has no persisted dispatch snapshot; resolve it from the live Inbox."
          : "Only a live recommendation can be applied from here.",
        run: () => {
          // The row's PERSISTED draft, not an override: the menu has no editor,
          // so applying from here must commit exactly what the report shows.
          if (item) void acceptSingle(item, runItem, runItem.draftAnswer);
        },
      }),
      reviewRowControl("open", {
        subject: "the thread",
        disabled: !item || !onOpenThread,
        disabledReason: !item
          ? "This row has no persisted dispatch snapshot to open."
          : "This report was opened without a thread target.",
        run: () => {
          if (item) onOpenThread?.(item);
        },
      }),
      reviewRowControl("reconcile", {
        subject: "Inbox",
        run: () => void reconcileOne(runItem),
      }),
      reviewRowControl("retry", {
        run: () => void retryItem(runItem),
      }),
      reviewRowControl("dismiss", {
        subject: "item",
        run: () => void dismissOne(runItem),
      }),
    ],
    [acceptSingle, dismissOne, onOpenThread, reconcileOne, retryItem, undoOne],
  );

  const groups = useMemo(
    () =>
      buildInboxBulkReviewGroups(
        runItems,
        attentionById,
        locallyApplied,
        localErrors,
        locallyDismissed,
        (item, runItem, actions) => (
          <InboxBulkRecommendationDetail
            key={runItem.itemId}
            listItem={item}
            runItem={runItem}
            busy={busy}
            onAccept={(hydratedItem, draftOverride) =>
              acceptSingle(hydratedItem, runItem, draftOverride)
            }
            onDiscuss={onOpenThread}
            recoveryActions={actions}
          />
        ),
        // P-003: the source chip becomes a REAL control that opens the item's
        // thread. Without a handler the shell renders an inert chip instead of
        // a link-styled span that does nothing.
        onOpenThread,
        rowActions,
      ),
    [
      runItems,
      attentionById,
      locallyApplied,
      localErrors,
      locallyDismissed,
      busy,
      acceptSingle,
      retryItem,
      dismissOne,
      reconcileOne,
      onOpenThread,
      rowActions,
    ],
  );

  const onApply = useCallback(
    async (selectedIds: string[]) => {
      if (busy) return;
      setBusy(true);
      setNotice(null);
      // P-010: a batch reports AS a batch. Reset the previous summary before
      // the first write so a stale "3 failed" cannot linger over a clean run.
      setApplyResult(null);
      const selected = selectedIds
        .map((id) => runItemById.get(id))
        .filter((item): item is BulkRunItem => Boolean(item))
        .sort((a, b) => a.position - b.position);
      setApplying({ done: 0, total: selected.length });
      let appliedCount = 0;
      let failedCount = 0;
      try {
        for (const [index, runItem] of selected.entries()) {
          setApplying({
            done: index,
            total: selected.length,
            current: runItem.title ?? runItem.itemId,
          });
          const item = attentionById.get(runItem.itemId);
          if (!item) {
            failedCount += 1;
            setLocalErrors((previous) =>
              new Map(previous).set(
                runItem.itemId,
                "This run row has no valid persisted dispatch snapshot; resolve it from the current Inbox.",
              ),
            );
            continue;
          }
          const result = await applyRecommendation(item, runItem);
          if (result.ok) appliedCount += 1;
          else failedCount += 1;
          // A partial failure keeps the report OPEN even when the run settled:
          // closing it would hide the only surface naming what did not land.
          if (result.phase === "complete" && failedCount === 0) {
            onClose();
            break;
          }
        }
        setApplying({ done: selected.length, total: selected.length });
        setApplyResult({ applied: appliedCount, failed: failedCount });
      } finally {
        setApplying(null);
        setBusy(false);
      }
    },
    [applyRecommendation, attentionById, busy, onClose, runItemById],
  );

  // ── Run lifecycle (P-007) ────────────────────────────────────────────────
  // `supports` below lists exactly the intents serviced here, so the bar never
  // renders a control this consumer cannot perform (D-001).

  const notAssessedIds = useMemo(
    () =>
      runItems
        .filter(
          (runItem) =>
            runItem.outcome === "pending" &&
            !locallyApplied.has(runItem.itemId) &&
            !locallyDismissed.has(runItem.itemId),
        )
        .map((runItem) => runItem.itemId),
    [runItems, locallyApplied, locallyDismissed],
  );

  const failedIds = useMemo(
    () =>
      runItems
        .filter(
          (runItem) =>
            localErrors.has(runItem.itemId) &&
            !locallyApplied.has(runItem.itemId) &&
            !locallyDismissed.has(runItem.itemId),
        )
        .map((runItem) => runItem.itemId),
    [runItems, localErrors, locallyApplied, locallyDismissed],
  );

  const onRunIntent = useCallback(
    (intent: RunLifecycleIntent) => {
      if (busy) return;
      if (intent === "reveal") {
        if (failedIds.length > 0) {
          setRevealRequest((previous) => ({
            groupId: INBOX_BULK_FAILED_GROUP_ID,
            seq: (previous?.seq ?? 0) + 1,
          }));
        }
        return;
      }
      void (async () => {
        setBusy(true);
        setNotice(null);
        try {
          if (intent === "stop") {
            await stop(run.runId);
            return;
          }
          if (intent === "restart") {
            const result = await restart(run.runId);
            if (!result.ok) {
              setNotice(result.error ?? "The resolver could not be restarted.");
            }
            return;
          }
          if (intent === "resume") {
            // P-009: chunked — a stopped Inbox-wide run can leave thousands
            // unassessed, which is one request the route rejects on body size.
            for (const chunk of chunkFindingIds(notAssessedIds)) {
              const result = await resume(run.runId, chunk);
              if (!result.ok) {
                setNotice(
                  result.error ??
                    "The resolver could not resume the unassessed items.",
                );
                return;
              }
            }
            return;
          }
          if (intent === "recheck") {
            // Reconcile each failed row against the LIVE Inbox: the item may
            // already have been handled elsewhere. Either way its stale error
            // is cleared so it re-enters the pending pool deliberately.
            let stillFailing = 0;
            for (const itemId of failedIds) {
              const result = await reconcileItem(run.runId, itemId);
              if (!result.ok) stillFailing += 1;
              setLocalErrors((previous) => {
                if (!previous.has(itemId)) return previous;
                const next = new Map(previous);
                next.delete(itemId);
                return next;
              });
            }
            setApplyResult(null);
            if (stillFailing > 0) {
              setNotice(
                `${stillFailing} of ${failedIds.length} could not be reconciled — open them and resolve them from the live Inbox.`,
              );
            }
            return;
          }
          if (intent === "rerun") {
            // The run's OWN recorded scope, rebuilt from its persisted rows —
            // not the pane's current selection. The report is the audit trail
            // of that scope; silently widening it would make the two disagree.
            const seed = runItems.map((runItem) => ({
              itemId: runItem.itemId,
              kind: runItem.kind ?? "unknown",
              title: runItem.title,
              ref: runItem.ref,
              ownerAgentId: runItem.ownerAgentId,
            }));
            const result = await start(
              seed,
              (run.filterSnapshot ?? {}) as Record<string, unknown>,
              run.harnessSlug ?? null,
            );
            if (!result.ok) {
              setNotice(result.error ?? "A new run could not be started.");
              return;
            }
            onClose();
          }
        } finally {
          setBusy(false);
        }
      })();
    },
    [
      busy,
      failedIds,
      notAssessedIds,
      onClose,
      reconcileItem,
      restart,
      resume,
      run.filterSnapshot,
      run.harnessSlug,
      run.runId,
      runItems,
      start,
      stop,
    ],
  );

  const counts = deriveRunCounts(runItems, run);
  const partition = useMemo(() => partitionReviewRows(groups), [groups]);
  const runAgeMs = useMemo(() => {
    const settledAt = run.finishedAt ?? run.startedAt ?? run.createdAt;
    if (!settledAt) return null;
    const parsed = Date.parse(settledAt);
    return Number.isFinite(parsed) ? Date.now() - parsed : null;
  }, [run.finishedAt, run.startedAt, run.createdAt]);

  const runBar = (
    <RunLifecycleBar
      phase={run.phase}
      liveness={run.liveness ?? null}
      total={partition.results}
      decided={partition.results - partition.notAssessed}
      notAssessed={partition.notAssessed}
      autoApplied={counts.resolved}
      open={partition.ready + partition.manual}
      error={run.error}
      ageMs={runAgeMs}
      applying={applying}
      applyResult={applyResult}
      unit="item"
      busy={busy}
      onIntent={onRunIntent}
      supports={["rerun", "resume", "restart", "stop", "recheck", "reveal"]}
    />
  );

  return (
    <ReviewReportShell
      key={run.runId}
      title="Inbox bulk-resolve report"
      icon={<Sparkles size={19} />}
      subtitle={
        <span className="inbox-bulk-report__subtitle">
          <span>
            {counts.total} assessed · {counts.resolved} auto-resolved ·{" "}
            {counts.unresolved} still open
            <br />
            {counts.recommendationTotal} recommendations · {counts.ownerAction}{" "}
            owner actions · {counts.cleanupCandidate} cleanup ·{" "}
            {counts.retryNeeded + counts.pending} retry needed · {counts.routed}{" "}
            routed · {counts.investigate} investigate
          </span>
          {notice ? (
            <span role="alert" className="inbox-bulk-report__error">
              {notice}
            </span>
          ) : null}
        </span>
      }
      groups={groups}
      runBar={runBar}
      revealRequest={revealRequest}
      collapseNonSelectableByDefault
      busy={busy}
      // A live run is still writing rows; committing a batch mid-scan would act
      // on a moving target (D-005). Every settled phase stays actionable.
      defaultSelected={readOnly ? "none" : "pending"}
      applyLabel={readOnly ? "Still assessing…" : "Apply selected"}
      dismissLabel="Close"
      onApply={(ids) => {
        if (!readOnly) void onApply(ids);
      }}
      onDismiss={onClose}
      footer={
        <span data-testid="inbox-bulk-report-footer">
          {presentation === "settled" ? (
            <>
              <strong>Audit trail.</strong> This run finished on its own — every
              row below is an item Papercup already resolved, with the evidence
              it resolved on. Nothing here is waiting on you; open a row to see
              why, or re-run the same scope from the bar above.
            </>
          ) : presentation === "failed" ? (
            <>
              <strong>This run did not finish.</strong> The rows below are what
              it had assessed before it stopped, and they are still applicable.
              The run&apos;s own error is in the bar above; re-run the same
              scope from there once you have addressed it.
            </>
          ) : presentation === "live" ? (
            <>
              <strong>Still assessing.</strong> Rows appear as the resolver
              decides them, so nothing can be applied as a batch yet — the set
              would change under the click. Stop the run from the bar above to
              settle it and keep what it has decided.
            </>
          ) : (
            <>
              <strong>Resolve-first guarantee.</strong> Selected rows dispatch
              through the same live Inbox action path as a hand resolve, then
              record acceptance on the run. A failed resolve stays visible and
              unrecorded. Click a row—or use its details button—to review the
              item&rsquo;s current options, edit a drafted reply, open the
              source, Retry, or dismiss one row deliberately. Closing the report
              never completes unresolved work.
            </>
          )}
        </span>
      }
    />
  );
}
