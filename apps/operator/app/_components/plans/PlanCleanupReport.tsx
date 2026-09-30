"use client";

/**
 * Grouped Plans clean-up report (cleanup-report-flows-2026-08-24 P-007).
 * The report is presentation + orchestration only: every selected mutation
 * goes through the same plans-api helper a hand edit uses, and only after that
 * succeeds does the run's `accept` bookkeeping advance.
 */
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { BrushCleaning } from "lucide-react";
import {
  setItemStatus,
  setPlanArchived,
  setPlanLifecycleStatus,
  writeError,
  type SetStatusArgs,
} from "@/app/admin/plans/plans-api";
import ReviewReportShell, {
  partitionReviewRows,
  ReviewRowActionButtons,
  reviewRowControl,
  type ReviewReportGroup,
  type ReviewReportRow,
  type ReviewRowAction,
  type ReviewRowMenuAction,
  type ReviewRowConfidence,
  type ReviewRowAccounting,
  type ReviewRowStatus,
} from "../review-report/ReviewReportShell";
import RunLifecycleBar, {
  type RunLifecycleIntent,
} from "../review-report/RunLifecycleBar";
import type { ReviewReportPresentation } from "../review-report/ReviewReportHost";
import { chunkFindingIds } from "../review-report/run-resume-chunks";
import {
  canonicalPlanCleanupDisposition,
  derivePlanCleanupCounts,
  usePlanCleanupOps,
  type PlanCleanupFinding,
  type PlanCleanupRun,
} from "./use-plan-cleanup-run";
import "./plan-cleanup-report.css";

type ActionableFindingKind =
  | "flip-to-done"
  | "cleared-blocker"
  | "finish-plan"
  | "archive-candidate";

const ACTIONABLE_KINDS: ReadonlySet<string> = new Set<ActionableFindingKind>([
  "flip-to-done",
  "cleared-blocker",
  "finish-plan",
  "archive-candidate",
]);

const GROUPS: ReadonlyArray<{
  id: string;
  title: string;
  description: string;
  kinds: ReadonlySet<string>;
}> = [
  {
    id: "flip-to-done",
    title: "Flip items to done",
    description:
      "Plan items whose linked work finished but whose stored status did not move.",
    kinds: new Set(["flip-to-done"]),
  },
  {
    id: "clear-stale-blockers",
    title: "Clear stale blockers and claims",
    description:
      "Blockers that are terminal and expired claims whose holder is gone.",
    kinds: new Set(["cleared-blocker", "orphaned-claim"]),
  },
  {
    id: "finish-or-archive",
    title: "Finish or archive plans",
    description:
      "Plans whose items are terminal, plus old completed plans recommended for archive.",
    kinds: new Set(["finish-plan", "archive-candidate"]),
  },
  {
    id: "refresh-now",
    title: "Refresh Now",
    description:
      "Now sections that point only at finished work and other authored recommendations.",
    kinds: new Set(["stale-now", "semantic"]),
  },
];

function reviewStatus(
  finding: PlanCleanupFinding,
  locallyApplied: ReadonlySet<string>,
  locallyDismissed: ReadonlySet<string>,
): ReviewRowStatus {
  if (locallyApplied.has(finding.findingId)) return "applied";
  if (locallyDismissed.has(finding.findingId)) return "dismissed";
  if (finding.outcome === "auto_applied" || finding.outcome === "accepted")
    return "applied";
  if (finding.outcome === "dismissed") {
    return "dismissed";
  }
  return "pending";
}

function reviewAccounting(
  finding: PlanCleanupFinding,
  status: ReviewRowStatus,
): ReviewRowAccounting {
  if (status === "applied") return "handled";
  if (status === "dismissed") return "not-applied";
  // A `pending` outcome is a finding the resolver never reached — a stopped or
  // died run, NOT owner work. It used to be counted as `manual`, which read as
  // "go do this by hand" for something that just needs the run resumed.
  if (finding.outcome === "pending") return "not-assessed";
  if (
    finding.outcome !== "recommended" &&
    canonicalPlanCleanupDisposition(finding) !== "recommended"
  )
    return "not-applied";
  return ACTIONABLE_KINDS.has(finding.kind) ? "ready" : "manual";
}

/**
 * The verb this finding commits (D-001) — the vocabulary a person would use for
 * the change, not the resolver's kind slug. Deliberately exhaustive over the
 * kinds Plans actually emits, with an honest fallback for anything new: a kind
 * with no registered hand-edit action is owner work, and says so.
 */
function planCleanupAction(
  finding: PlanCleanupFinding,
  status: ReviewRowStatus,
): ReviewRowAction {
  if (status === "applied") {
    return { key: "fixed", tone: "good", description: "Already applied." };
  }
  if (status === "dismissed") {
    return { key: "skipped", tone: "manual", description: "Left alone." };
  }
  if (finding.outcome === "pending") {
    return {
      key: "assess",
      tone: "warn",
      description:
        "Found by the scan but never judged — resume the run to assess it.",
    };
  }
  switch (finding.kind) {
    case "flip-to-done":
      return {
        key: "mark-done",
        description: `Set ${finding.itemId ?? "this item"} to done in ${finding.planSlug}.`,
      };
    case "cleared-blocker":
      return {
        key: "clear-blocker",
        description: `Move ${finding.itemId ?? "this item"} back to todo — its blocker already finished.`,
      };
    case "finish-plan":
      return {
        key: "finish-plan",
        tone: "good",
        description: `Mark ${finding.planSlug} shipped.`,
      };
    case "archive-candidate":
      return {
        key: "archive-plan",
        tone: "warn",
        description: `Archive ${finding.planSlug}.`,
      };
    case "stale-now":
      return {
        key: "you-write-it",
        tone: "manual",
        description:
          "Papercup can spot the stale Now section but not author its replacement.",
      };
    case "orphaned-claim":
      return {
        key: "reaper-clears",
        tone: "manual",
        description:
          "Claim release is re-verified by the stale-claim reaper, not written blind from here.",
      };
    default:
      return {
        key: "you-handle-it",
        tone: "manual",
        description:
          "This recommendation has no registered hand-edit action; open the plan.",
      };
  }
}

function manualReason(finding: PlanCleanupFinding): string | null {
  if (finding.recommendation) {
    return `${finding.recommendation.label}: ${finding.recommendation.rationale}`;
  }
  if (finding.outcome === "pending")
    return "The resolver did not reach this finding; no action is available.";
  if (finding.kind === "stale-now") {
    return "Open the plan and author its new State / Next text; the scanner records staleness, not replacement prose.";
  }
  if (finding.kind === "orphaned-claim") {
    return "Claim release is re-verified by the stale-claim reaper and is not a blind owner-side write.";
  }
  if (!ACTIONABLE_KINDS.has(finding.kind)) {
    return "This recommendation has no registered hand-edit action and must be handled from its plan.";
  }
  return null;
}

/** Prefer the typed recommendation contract, then its persisted projection.
 * Old deterministic findings retain their provable/recommended meaning, while
 * an operational row with no recorded assessment fails closed. */
export function planCleanupReviewConfidence(
  finding: PlanCleanupFinding,
): ReviewRowConfidence {
  const canonical =
    finding.recommendation?.confidence ?? finding.confidenceLevel;
  if (canonical) return canonical;
  if (finding.outcome === "pending" || finding.outcome === "failed") {
    return "insufficient";
  }
  return finding.confidence === "provable" ? "high" : "medium";
}

function evidenceLines(finding: PlanCleanupFinding): string[] {
  const lines = finding.evidence.map((entry) =>
    [entry.kind, entry.ref, entry.note].filter(Boolean).join(" · "),
  );
  if (lines.length === 0) lines.push("No evidence was recorded.");
  if (finding.error) lines.push(`error · ${finding.error}`);
  lines.push(`confidence · ${planCleanupReviewConfidence(finding)}`);
  if (finding.recommendation?.responsibility) {
    lines.push(`responsibility · ${finding.recommendation.responsibility}`);
  }
  return lines;
}

function reportRow(
  finding: PlanCleanupFinding,
  locallyApplied: ReadonlySet<string>,
  locallyDismissed: ReadonlySet<string>,
  localErrors: ReadonlyMap<string, string>,
  detailFor?: (
    finding: PlanCleanupFinding,
    actions?: ReviewRowMenuAction[],
  ) => ReactNode,
  openSource?: (finding: PlanCleanupFinding) => void,
  rowActions?: (finding: PlanCleanupFinding) => ReviewRowMenuAction[],
): ReviewReportRow {
  const status = reviewStatus(finding, locallyApplied, locallyDismissed);
  const localError = localErrors.get(finding.findingId);
  // A row whose apply FAILED leaves the pending pool (P-010): it keeps its
  // reason and gains a Retry verb, but pressing Apply again must not blind-
  // re-dispatch it. Recovery is deliberate — the run bar's "Re-check and retry"
  // or the row's own recovery drill-in.
  const applyFailed = localError != null && status === "pending";
  const recoveryActions = rowActions ? rowActions(finding) : [];
  return {
    id: finding.findingId,
    title: finding.target,
    action: applyFailed
      ? {
          key: "retry" as const,
          tone: "warn" as const,
          description: `The write failed: ${localError}. Re-check it, then apply it again.`,
        }
      : planCleanupAction(finding, status),
    sourceLabel: finding.planSlug,
    ...(openSource
      ? {
          onOpenSource: () => openSource(finding),
          openSourceLabel: `Open plan ${finding.planSlug}`,
        }
      : {}),
    referenceLabel:
      finding.itemId ?? (finding.kind === "stale-now" ? "## Now" : "plan"),
    transition: { from: finding.from, to: finding.to },
    detail:
      status === "pending" && detailFor
        ? detailFor(finding, recoveryActions)
        : (manualReason(finding) ?? undefined),
    error: localError,
    ...(rowActions ? { actions: recoveryActions } : {}),
    evidence: evidenceLines(finding),
    confidence: planCleanupReviewConfidence(finding),
    accounting: reviewAccounting(finding, status),
    status,
    selectable:
      !applyFailed &&
      status === "pending" &&
      finding.outcome === "recommended" &&
      finding.evidence.length > 0 &&
      ACTIONABLE_KINDS.has(finding.kind),
  };
}

/** The group a failed apply lands in — named here so the run bar's `reveal`
 *  intent can address it without either side guessing the string. */
export const PLAN_CLEANUP_FAILED_GROUP_ID = "apply-failed";

/** Pure report projection, exported so grouping/selection policy is pinned
 * independently from React and network behavior. */
export function buildPlanCleanupReviewGroups(
  findings: readonly PlanCleanupFinding[],
  locallyApplied: ReadonlySet<string> = new Set(),
  localErrors: ReadonlyMap<string, string> = new Map(),
  locallyDismissed: ReadonlySet<string> = new Set(),
  detailFor?: (
    finding: PlanCleanupFinding,
    actions?: ReviewRowMenuAction[],
  ) => ReactNode,
  openSource?: (finding: PlanCleanupFinding) => void,
  rowActions?: (finding: PlanCleanupFinding) => ReviewRowMenuAction[],
): ReviewReportGroup[] {
  const assigned = new Set<string>();
  const row = (finding: PlanCleanupFinding) =>
    reportRow(
      finding,
      locallyApplied,
      locallyDismissed,
      localErrors,
      detailFor,
      openSource,
      rowActions,
    );

  // Rows whose apply FAILED lead everything (P-010): they are the only rows
  // carrying an unhandled consequence of the owner's last click.
  const failed = findings.filter(
    (finding) =>
      localErrors.has(finding.findingId) &&
      !locallyApplied.has(finding.findingId) &&
      !locallyDismissed.has(finding.findingId),
  );
  for (const finding of failed) assigned.add(finding.findingId);

  // Findings the resolver never reached come next, pulled out of their kind
  // group: they are not a fix kind, they are unstarted work, and the only thing
  // that clears them is resuming the run.
  const unassessed = findings.filter(
    (finding) =>
      finding.outcome === "pending" &&
      !assigned.has(finding.findingId) &&
      !locallyApplied.has(finding.findingId) &&
      !locallyDismissed.has(finding.findingId),
  );
  for (const finding of unassessed) assigned.add(finding.findingId);

  const groups = GROUPS.map((group) => {
    const rows = findings
      .filter(
        (finding) =>
          group.kinds.has(finding.kind) && !assigned.has(finding.findingId),
      )
      .map((finding) => {
        assigned.add(finding.findingId);
        return row(finding);
      });
    return { ...group, rows };
  }).filter((group) => group.rows.length > 0);

  if (unassessed.length > 0) {
    groups.unshift({
      id: "not-assessed",
      title: "Not assessed yet",
      description:
        "Found by the scan, but the run stopped before Papercup could judge them. Resume the run to assess them.",
      kinds: new Set(),
      rows: unassessed.map(row),
    });
  }

  if (failed.length > 0) {
    groups.unshift({
      id: PLAN_CLEANUP_FAILED_GROUP_ID,
      title: "Failed to apply",
      description:
        "Nothing was left half-written. Each row says why it failed; re-check them before applying again.",
      kinds: new Set(),
      rows: failed.map(row),
    });
  }

  const other = findings
    .filter((finding) => !assigned.has(finding.findingId))
    .map(row);
  if (other.length > 0) {
    groups.push({
      id: "other",
      title: "Other recommendations",
      description: "Resolver findings without a first-class hand-edit action.",
      kinds: new Set(),
      rows: other,
    });
  }
  return groups;
}

/** A refusal the owner must RE-CHECK rather than retry blindly (P-011). */
export const STALE_FINDING_ERROR_CODE = "expected_status_mismatch";

export interface ApplyFindingResult {
  ok: boolean;
  error?: string;
  /** True when the write was refused because the item moved since the scan. */
  stale?: boolean;
}

export async function applyPlanCleanupFinding(
  finding: PlanCleanupFinding,
  options: { allowStale?: boolean } = {},
): Promise<ApplyFindingResult> {
  const harness = finding.harnessSlug ?? undefined;
  try {
    if (finding.kind === "flip-to-done" || finding.kind === "cleared-blocker") {
      if (!finding.itemId)
        return { ok: false, error: "finding has no plan item id" };
      // COMPARE-AND-SET (P-011). `finding.from` is the status the SCAN
      // recorded; a report can sit open for hours, so without this the Apply
      // would write over whatever the item became in the meantime. The tool
      // refuses with `expected_status_mismatch` and reports both statuses.
      const result = await setItemStatus({
        slug: finding.planSlug,
        itemId: finding.itemId,
        status: finding.kind === "flip-to-done" ? "done" : "todo",
        ...(!options.allowStale
          ? {
              expectedStatus: finding.from as SetStatusArgs["expectedStatus"],
            }
          : {}),
        ...(harness ? { harness } : {}),
      });
      const error = writeError(result);
      if (!error) return { ok: true };
      return {
        ok: false,
        error,
        ...(error.includes(STALE_FINDING_ERROR_CODE) ? { stale: true } : {}),
      };
    }
    if (finding.kind === "finish-plan") {
      return await setPlanLifecycleStatus(finding.planSlug, "shipped", harness);
    }
    if (finding.kind === "archive-candidate") {
      const result = await setPlanArchived({
        slug: finding.planSlug,
        archived: true,
        ...(harness ? { harness } : {}),
      });
      const error = writeError(result);
      return error ? { ok: false, error } : { ok: true };
    }
    return {
      ok: false,
      error: manualReason(finding) ?? "finding is not owner-applicable",
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface PlanCleanupReportProps {
  run: PlanCleanupRun;
  findings: PlanCleanupFinding[];
  /** Which phase family the shared host admitted this report under (D-005). */
  presentation?: ReviewReportPresentation;
  /** A live run's rows are still being written; batch Apply is withheld. */
  readOnly?: boolean;
  onOpenFinding?: (finding: PlanCleanupFinding) => void;
  onClose: () => void;
}

export default function PlanCleanupReport({
  run,
  findings,
  presentation = "review",
  readOnly = false,
  onOpenFinding,
  onClose,
}: PlanCleanupReportProps) {
  const {
    accept,
    dismissFinding,
    recheckFinding,
    resume,
    restart,
    stop,
    start,
  } = usePlanCleanupOps();
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
  // P-011: rows the WRITE refused as stale. Known only after an attempt — the
  // client cannot see the live plan, and guessing would be the lie this fixes.
  const [staleIds, setStaleIds] = useState<Set<string>>(() => new Set());
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
  const byId = useMemo(
    () => new Map(findings.map((finding) => [finding.findingId, finding])),
    [findings],
  );
  const counts = derivePlanCleanupCounts(findings);
  const planCount = new Set(findings.map((finding) => finding.planSlug)).size;

  const onApply = useCallback(
    async (
      selectedIds: string[],
      allowStaleIds: ReadonlySet<string> = new Set(),
    ) => {
      if (busy) return;
      setBusy(true);
      setNotice(null);
      // P-010: a batch reports AS a batch. Reset the previous summary before
      // the first write so a stale "3 failed" cannot linger over a clean run.
      setApplyResult(null);
      setApplying({ done: 0, total: selectedIds.length });
      let appliedCount = 0;
      let failedCount = 0;
      let finalPhase: PlanCleanupRun["phase"] | null | undefined;
      try {
        for (const [index, findingId] of selectedIds.entries()) {
          const finding = byId.get(findingId);
          setApplying({
            done: index,
            total: selectedIds.length,
            ...(finding ? { current: finding.target } : {}),
          });
          if (!finding) {
            failedCount += 1;
            setLocalErrors((previous) =>
              new Map(previous).set(
                findingId,
                "Finding disappeared from the run.",
              ),
            );
            continue;
          }
          const applied = await applyPlanCleanupFinding(finding, {
            allowStale: allowStaleIds.has(findingId),
          });
          if (!applied.ok) {
            failedCount += 1;
            if (applied.stale) {
              setStaleIds((previous) => new Set(previous).add(findingId));
            }
            setLocalErrors((previous) =>
              new Map(previous).set(
                findingId,
                applied.error ?? "The hand-edit write failed.",
              ),
            );
            continue;
          }
          appliedCount += 1;

          setStaleIds((previous) => {
            if (!previous.has(findingId)) return previous;
            const next = new Set(previous);
            next.delete(findingId);
            return next;
          });

          // Resolve first, record second. Mark local success immediately so a
          // bookkeeping failure cannot invite a second mutation in this view.
          setLocalErrors((previous) => {
            if (!previous.has(findingId)) return previous;
            const next = new Map(previous);
            next.delete(findingId);
            return next;
          });
          setLocallyApplied((previous) => new Set(previous).add(findingId));
          const recorded = await accept(
            run.runId,
            findingId,
            `Grouped report accepted: ${finding.from} → ${finding.to}`,
          );
          if (!recorded.ok) {
            setLocalErrors((previous) =>
              new Map(previous).set(
                findingId,
                `Change applied, but run bookkeeping failed: ${recorded.error ?? "unknown error"}`,
              ),
            );
            continue;
          }
          finalPhase = recorded.phase;
        }
        setApplying({ done: selectedIds.length, total: selectedIds.length });
        setApplyResult({ applied: appliedCount, failed: failedCount });
        // A partial failure keeps the report OPEN even when the run settled:
        // closing it would hide the only surface naming what did not land.
        if (finalPhase === "complete" && failedCount === 0) onClose();
      } finally {
        setApplying(null);
        setBusy(false);
      }
    },
    [busy, byId, accept, run.runId, onClose],
  );

  const clearFindingError = useCallback((findingId: string) => {
    setLocalErrors((previous) => {
      if (!previous.has(findingId)) return previous;
      const next = new Map(previous);
      next.delete(findingId);
      return next;
    });
  }, []);

  const onRetryFinding = useCallback(
    async (finding: PlanCleanupFinding) => {
      if (busy) return;
      setBusy(true);
      setNotice(null);
      try {
        const result = await resume(run.runId, [finding.findingId]);
        if (!result.ok) {
          setLocalErrors((previous) =>
            new Map(previous).set(
              finding.findingId,
              result.error ?? "The resolver could not retry this finding.",
            ),
          );
          return;
        }
        clearFindingError(finding.findingId);
        onClose();
      } finally {
        setBusy(false);
      }
    },
    [busy, clearFindingError, onClose, resume, run.runId],
  );

  const onRecheckFinding = useCallback(
    async (finding: PlanCleanupFinding) => {
      if (busy) return;
      setBusy(true);
      setNotice(null);
      try {
        const result = await recheckFinding(run.runId, finding.findingId);
        if (!result.ok) {
          setLocalErrors((previous) =>
            new Map(previous).set(
              finding.findingId,
              result.error ?? "The live plan could not be rechecked.",
            ),
          );
          return;
        }
        if (!result.resolved) {
          setLocalErrors((previous) =>
            new Map(previous).set(
              finding.findingId,
              "The finding is still present in the live plan. Edit it, Retry it, or dismiss it deliberately.",
            ),
          );
          return;
        }
        clearFindingError(finding.findingId);
        setLocallyApplied((previous) =>
          new Set(previous).add(finding.findingId),
        );
        if (result.phase === "complete") onClose();
      } finally {
        setBusy(false);
      }
    },
    [busy, clearFindingError, onClose, recheckFinding, run.runId],
  );

  const onDismissFinding = useCallback(
    async (finding: PlanCleanupFinding) => {
      if (busy) return;
      setBusy(true);
      setNotice(null);
      try {
        const result = await dismissFinding(
          run.runId,
          finding.findingId,
          "Owner dismissed this finding from the grouped recovery report",
        );
        if (!result.ok) {
          setLocalErrors((previous) =>
            new Map(previous).set(
              finding.findingId,
              result.error ?? "The finding could not be dismissed.",
            ),
          );
          return;
        }
        clearFindingError(finding.findingId);
        setLocallyDismissed((previous) =>
          new Set(previous).add(finding.findingId),
        );
        if (result.phase === "complete") onClose();
      } finally {
        setBusy(false);
      }
    },
    [busy, clearFindingError, dismissFinding, onClose, run.runId],
  );

  // ── Run lifecycle (P-007) ────────────────────────────────────────────────
  // Every intent below is serviced for real; `supports` below lists exactly
  // these, so the bar never renders a control this consumer cannot perform
  // (D-001 — the whole point of the plan).

  const notAssessedIds = useMemo(
    () =>
      findings
        .filter(
          (finding) =>
            finding.outcome === "pending" &&
            !locallyApplied.has(finding.findingId) &&
            !locallyDismissed.has(finding.findingId),
        )
        .map((finding) => finding.findingId),
    [findings, locallyApplied, locallyDismissed],
  );

  const failedIds = useMemo(
    () =>
      findings
        .filter(
          (finding) =>
            localErrors.has(finding.findingId) &&
            !locallyApplied.has(finding.findingId) &&
            !locallyDismissed.has(finding.findingId),
        )
        .map((finding) => finding.findingId),
    [findings, localErrors, locallyApplied, locallyDismissed],
  );

  const onRunIntent = useCallback(
    (intent: RunLifecycleIntent) => {
      if (busy) return;
      if (intent === "reveal") {
        // Not a mutation — jump to the rows the bar just talked about.
        const groupId =
          failedIds.length > 0
            ? PLAN_CLEANUP_FAILED_GROUP_ID
            : notAssessedIds.length > 0
              ? "not-assessed"
              : null;
        if (groupId) {
          setRevealRequest((previous) => ({
            groupId,
            seq: (previous?.seq ?? 0) + 1,
          }));
        }
        return;
      }
      if (intent === "apply-anyway") {
        const ids = [...staleIds];
        if (ids.length > 0) void onApply(ids, new Set(ids));
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
            // P-009: chunked — a stopped workspace-wide scan can leave
            // thousands unassessed, which is one request the route rejects.
            for (const chunk of chunkFindingIds(notAssessedIds)) {
              const result = await resume(run.runId, chunk);
              if (!result.ok) {
                setNotice(
                  result.error ??
                    "The resolver could not resume the unassessed findings.",
                );
                return;
              }
            }
            return;
          }
          if (intent === "recheck") {
            // Re-derive each failed row against the live plan. A row the plan
            // already satisfies becomes applied; one that is still real has its
            // error cleared so it re-enters the pending pool and can be applied
            // again deliberately.
            let stillFailing = 0;
            for (const findingId of failedIds) {
              const result = await recheckFinding(run.runId, findingId);
              if (!result.ok) {
                stillFailing += 1;
                continue;
              }
              if (result.resolved) {
                setLocallyApplied((previous) =>
                  new Set(previous).add(findingId),
                );
              } else {
                stillFailing += 1;
              }
              setStaleIds((previous) => {
                if (!previous.has(findingId)) return previous;
                const next = new Set(previous);
                next.delete(findingId);
                return next;
              });
              setLocalErrors((previous) => {
                if (!previous.has(findingId)) return previous;
                const next = new Map(previous);
                next.delete(findingId);
                return next;
              });
            }
            setApplyResult(null);
            if (stillFailing > 0) {
              setNotice(
                `${stillFailing} of ${failedIds.length} are still present in the live plan — apply them again, or dismiss them.`,
              );
            }
            return;
          }
          if (intent === "rerun") {
            // A re-run repeats the run's OWN recorded scope, not the pane's
            // current selection: the report is the audit trail of that scope,
            // and silently widening it would make the two disagree.
            // The launch profile is deliberately NOT the run's snapshot: a
            // re-run should use the owner's CURRENT resolver settings, which is
            // what `start` loads when none is passed.
            const result = await start(
              run.seedRefs,
              (run.filterSnapshot ?? {}) as Record<string, unknown>,
              findings[0]?.harnessSlug ?? null,
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
      findings,
      notAssessedIds,
      onApply,
      onClose,
      recheckFinding,
      restart,
      resume,
      run.filterSnapshot,
      run.runId,
      run.seedRefs,
      start,
      staleIds,
      stop,
    ],
  );

  // P-008: Plans had ZERO per-row actions — every recovery was buried in a
  // drill-in that only opened for `pending` rows. These are the same ops the
  // drill-in exposes, hoisted onto the row where Inbox's already were (R8).
  const rowActions = useCallback(
    (finding: PlanCleanupFinding): ReviewRowMenuAction[] => {
      const applicable =
        finding.outcome === "recommended" && ACTIONABLE_KINDS.has(finding.kind);
      // Every entry comes from the shared registry (REVIEW_ROW_CONTROLS), so
      // this flow owns only its subject nouns, its availability rules and its
      // handlers — never the wording. A control added to the registry for
      // Inbox is offerable here by adding one line, not by re-implementing it.
      return [
        reviewRowControl("apply-one", {
          disabled: !applicable,
          disabledReason:
            manualReason(finding) ??
            "This recommendation has no registered hand-edit action.",
          run: () => void onApply([finding.findingId]),
        }),
        ...(staleIds.has(finding.findingId)
          ? [
              reviewRowControl("apply-anyway", {
                run: () =>
                  void onApply(
                    [finding.findingId],
                    new Set([finding.findingId]),
                  ),
              }),
            ]
          : []),
        reviewRowControl("open", {
          subject: finding.planSlug,
          disabled: !onOpenFinding,
          disabledReason: "This report was opened without a plan target.",
          run: () => onOpenFinding?.(finding),
        }),
        reviewRowControl("recheck", {
          subject: "plan",
          disabled: finding.kind === "semantic",
          disabledReason:
            "A semantic finding has no deterministic re-check; open the plan instead.",
          run: () => void onRecheckFinding(finding),
        }),
        reviewRowControl("retry", {
          run: () => void onRetryFinding(finding),
        }),
        reviewRowControl("dismiss", {
          subject: "finding",
          run: () => void onDismissFinding(finding),
        }),
      ];
    },
    [
      onApply,
      onDismissFinding,
      onOpenFinding,
      onRecheckFinding,
      onRetryFinding,
      staleIds,
    ],
  );

  const groups = useMemo(
    () =>
      buildPlanCleanupReviewGroups(
        findings,
        locallyApplied,
        localErrors,
        locallyDismissed,
        (finding, actions = []) => (
          <div
            className="plan-cleanup-report__recovery"
            data-testid={`plan-cleanup-recovery-${finding.findingId}`}
          >
            <span className="plan-cleanup-report__recovery-copy">
              {manualReason(finding) ??
                "Apply the recommendation, or use a recovery path without hiding the finding."}
            </span>
            <span className="plan-cleanup-report__recovery-actions">
              <ReviewRowActionButtons
                actions={actions}
                busy={busy}
                testIdPrefix={`plan-cleanup-${finding.findingId}`}
                testIdForAction={(id) =>
                  `plan-cleanup-${id}-${finding.findingId}`
                }
              />
            </span>
          </div>
        ),
        onOpenFinding ? (finding) => onOpenFinding(finding) : undefined,
        rowActions,
      ),
    [
      findings,
      locallyApplied,
      localErrors,
      locallyDismissed,
      busy,
      onOpenFinding,
      rowActions,
    ],
  );

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
      autoApplied={counts.applied}
      open={partition.ready + partition.manual}
      error={run.error}
      ageMs={runAgeMs}
      staleRows={staleIds.size}
      applying={applying}
      applyResult={applyResult}
      unit="finding"
      busy={busy}
      onIntent={onRunIntent}
      supports={[
        "rerun",
        "resume",
        "restart",
        "stop",
        "recheck",
        "apply-anyway",
        "reveal",
      ]}
    />
  );

  return (
    <ReviewReportShell
      key={run.runId}
      title="Clean-up report"
      icon={<BrushCleaning size={19} />}
      subtitle={
        <span className="plan-cleanup-report__subtitle">
          <span>
            {counts.total} assessed across {planCount} plan
            {planCount === 1 ? "" : "s"} · {counts.applied} auto-applied ·{" "}
            {counts.unresolved} still open
            <br />
            {counts.recommendationTotal} recommendations · {counts.ownerAction}{" "}
            owner actions · {counts.cleanupCandidate} cleanup ·{" "}
            {counts.retryNeeded + counts.pending} retry needed · {counts.routed}{" "}
            routed · {counts.investigate} investigate
          </span>
          {notice ? (
            <span role="alert" className="plan-cleanup-report__error">
              {notice}
            </span>
          ) : null}
        </span>
      }
      groups={groups}
      runBar={runBar}
      revealRequest={revealRequest}
      busy={busy}
      // A live run is still writing rows; committing a batch mid-scan would act
      // on a moving target (D-005). Every settled phase stays actionable.
      defaultSelected={readOnly ? "none" : "pending"}
      applyLabel={readOnly ? "Still scanning…" : "Apply selected"}
      dismissLabel="Close"
      onApply={(ids) => {
        if (!readOnly) void onApply(ids);
      }}
      onDismiss={onClose}
      footer={
        <span data-testid="plan-cleanup-report-footer">
          {presentation === "settled" ? (
            <>
              <strong>Audit trail.</strong> This run finished on its own — every
              row below is a change Papercup already made, with the evidence it
              made it on. Nothing here is waiting on you; open a row to see why
              it was applied, or re-run the same scope from the bar above.
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
              <strong>Still scanning.</strong> Rows appear as the resolver
              assesses them, so nothing can be applied as a batch yet — the set
              would change under the click. Stop the run from the bar above to
              settle it and keep what it has found.
            </>
          ) : (
            <>
              <strong>Hand-edit guarantee.</strong> Selected rows dispatch
              through the existing <code>plans:set-status</code>,{" "}
              <code>plans:set-plan-status</code>, or{" "}
              <code>plans:set-archived</code> client paths before acceptance is
              recorded, each carrying the status this report recorded so a row
              that moved since the scan is refused rather than overwritten.
              Clear a checkbox to skip it in this apply. Click a row—or use its
              details button—to inspect its evidence and expose Open, Recheck,
              Retry, and explicit per-finding Dismiss; closing this report never
              marks unresolved work complete.
            </>
          )}
        </span>
      }
    />
  );
}
