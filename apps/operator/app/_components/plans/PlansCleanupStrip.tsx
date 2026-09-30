"use client";

/**
 * PlansCleanupStrip (cleanup-report-flows-2026-08-24 P-006) — one command
 * slot under the Plans masthead, following the owner-approved Inbox bulk strip
 * vocabulary exactly: idle → running → review. Review-at-volume itself belongs
 * to P-007; this strip carries the run into that surface through `?opcln=`.
 */
import { useCallback, useState } from "react";
import { BrushCleaning, ChevronRight, Loader2, RotateCw } from "lucide-react";
import { formatRunElapsed } from "../review-report/bulk-run-time";
import BulkResolverSettingsControl from "../bulk-resolver/BulkResolverSettingsControl";
import BulkResolverStrip, {
  type BulkResolverMetric,
} from "../bulk-resolver/BulkResolverStrip";
import { useBulkResolverSettings } from "../bulk-resolver/bulk-resolver-settings";
import {
  canonicalPlanCleanupDisposition,
  derivePlanCleanupCounts,
  usePlanCleanupOps,
  type PlanCleanupFinding,
  type PlanCleanupRun,
} from "./use-plan-cleanup-run";

export interface PlansCleanupStripProps {
  /** Exact click-time set currently rendered by PlansPane. */
  planSlugs: readonly string[];
  filterSnapshot: Record<string, unknown>;
  run: PlanCleanupRun | null;
  findings: PlanCleanupFinding[];
  recommendations: PlanCleanupFinding[];
  pending: PlanCleanupFinding[];
  isRunning: boolean;
  isReview: boolean;
  onRunStarted: (runId: string) => void;
  /** Opens/retains the `?opcln=` report deep link for P-007. */
  onReview: (runId: string) => void;
  /** Clears `?opcln=` after a deliberate dismiss. */
  onRunCleared: () => void;
}

export default function PlansCleanupStrip({
  planSlugs,
  filterSnapshot,
  run,
  findings,
  isRunning,
  isReview,
  onRunStarted,
  onReview,
  onRunCleared,
}: PlansCleanupStripProps) {
  const { start, stop, restart, resume, reclassify } = usePlanCleanupOps();
  const resolverSettings = useBulkResolverSettings("plan-cleanup");
  const [starting, setStarting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [classifying, setClassifying] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const counts = derivePlanCleanupCounts(findings);
  const retryableFindings = findings.filter(
    (finding) =>
      finding.outcome === "pending" ||
      finding.outcome === "failed" ||
      canonicalPlanCleanupDisposition(finding) === "retry_needed",
  );

  const onStart = useCallback(async () => {
    if (planSlugs.length === 0 || starting || !resolverSettings.ready) return;
    setStarting(true);
    setNotice(null);
    try {
      const result = await start(
        planSlugs,
        filterSnapshot,
        null,
        resolverSettings.profile,
      );
      if (!result.ok) {
        setNotice(result.error ?? "could not start the clean-up run");
        return;
      }
      if (result.runId) onRunStarted(result.runId);
      // No LLM is a SUCCESS when the fixed-point deterministic pass cleared
      // every provable finding and no recommendation work remained.
      if (result.resolverNeeded === false && !result.launchError) return;
      // The request succeeds once the run is durable even when its supervised
      // resolver did not boot. Surface that persisted failure instead of
      // leaving a run that can never move looking live.
      if (!result.launched) {
        setNotice(
          `resolver could not start${result.launchError ? `: ${result.launchError}` : ""}`,
        );
      }
    } finally {
      setStarting(false);
    }
  }, [
    planSlugs,
    starting,
    start,
    filterSnapshot,
    onRunStarted,
    resolverSettings,
  ]);

  const onStop = useCallback(async () => {
    if (!run || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await stop(run.runId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [run, busy, stop]);

  const onRestart = useCallback(async () => {
    if (!run || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await restart(run.runId);
      if (!result.ok) {
        setNotice(result.error ?? "could not restart the resolver");
      } else if (!result.launched) {
        setNotice(
          `resolver could not restart${result.launchError ? `: ${result.launchError}` : ""}`,
        );
      } else {
        setNotice(
          `Resolver restarted · ${result.preservedOutcomes ?? 0} completed outcome${result.preservedOutcomes === 1 ? "" : "s"} preserved`,
        );
      }
    } finally {
      setBusy(false);
    }
  }, [run, busy, restart]);

  const onResume = useCallback(async () => {
    if (!run || busy || retryableFindings.length === 0) return;
    const findingIds = retryableFindings.map((finding) => finding.findingId);
    setBusy(true);
    setNotice(null);
    try {
      const result = await resume(run.runId, findingIds);
      if (!result.ok) {
        setNotice(result.error ?? "could not continue the remaining findings");
      } else if (!result.launched) {
        setNotice(
          `resolver could not continue${result.launchError ? `: ${result.launchError}` : ""}`,
        );
      } else {
        const preserved = result.preservedOutcomes ?? 0;
        setNotice(
          `Continuing ${findingIds.length} remaining · ${preserved} prior outcome${preserved === 1 ? "" : "s"} preserved`,
        );
      }
    } finally {
      setBusy(false);
    }
  }, [busy, retryableFindings, resume, run]);

  const onReclassify = useCallback(async () => {
    if (!run || classifying) return;
    setClassifying(true);
    setNotice(null);
    try {
      const result = await reclassify(run.runId);
      if (!result.ok) {
        setNotice(result.error ?? "could not classify legacy skipped findings");
      } else {
        setNotice(
          `Classified ${result.preservedOutcomes ?? 0} legacy findings; no outcomes changed`,
        );
      }
    } finally {
      setClassifying(false);
    }
  }, [classifying, reclassify, run]);

  if (isRunning && run) {
    const scanOnly = counts.total === 0;
    return (
      <BulkResolverStrip
        state="running"
        testId="plans-cleanup-running"
        settings={
          <BulkResolverSettingsControl
            kind="plan-cleanup"
            settings={resolverSettings}
            effective={run.launchSnapshot ?? {}}
            liveness={run.liveness}
            onRestart={() => void onRestart()}
            restartBusy={busy}
          />
        }
        title={
          scanOnly
            ? `Papercup is scanning ${run.totalItems} shown plan${run.totalItems === 1 ? "" : "s"}…`
            : "Papercup is cleaning up…"
        }
        stopTestId="plans-cleanup-stop"
        stopDisabled={busy}
        onStop={() => void onStop()}
        progress={{
          percent: scanOnly ? undefined : counts.percent,
          width: scanOnly ? "2%" : undefined,
          ariaLabel: "Plan clean-up progress",
          ariaValueText: scanOnly
            ? `Scanning ${run.totalItems} plans`
            : `${counts.decided} of ${counts.total} findings decided`,
        }}
        metrics={
          scanOnly
            ? [
                {
                  id: "scanning",
                  value: null,
                  label: "finding stale state and cleared blockers",
                },
              ]
            : [
                {
                  id: "tidied",
                  value: counts.applied,
                  label: "tidied",
                  tone: "good",
                },
                {
                  id: "review",
                  value: counts.forReview,
                  label: "for review",
                  tone: "review",
                },
                { id: "left", value: counts.pending, label: "left" },
              ]
        }
        metricsTestId="plans-cleanup-counts"
        notice={
          notice
            ? {
                message: notice,
                onDismiss: () => setNotice(null),
                dismissLabel: "Dismiss clean-up notice",
              }
            : null
        }
      />
    );
  }

  if (isReview && run) {
    const elapsed = formatRunElapsed(run.startedAt, run.finishedAt);
    const reviewMetrics: BulkResolverMetric[] = [
      {
        id: "recommendations",
        value: counts.recommendationTotal,
        label: "recommendations",
        tone: "review",
      },
      ...(counts.ownerAction > 0
        ? [
            {
              id: "owner-action",
              value: counts.ownerAction,
              label: `owner action${counts.ownerAction === 1 ? "" : "s"}`,
            } satisfies BulkResolverMetric,
          ]
        : []),
      ...(counts.cleanupCandidate > 0
        ? [
            {
              id: "cleanup-candidate",
              value: counts.cleanupCandidate,
              label: `cleanup candidate${counts.cleanupCandidate === 1 ? "" : "s"}`,
            } satisfies BulkResolverMetric,
          ]
        : []),
      ...(counts.retryNeeded + counts.pending > 0
        ? [
            {
              id: "retry-needed",
              value: counts.retryNeeded + counts.pending,
              label: "retry needed",
            } satisfies BulkResolverMetric,
          ]
        : []),
      ...(counts.routed > 0
        ? [
            {
              id: "routed",
              value: counts.routed,
              label: "routed",
            } satisfies BulkResolverMetric,
          ]
        : []),
      ...(counts.investigate > 0
        ? [
            {
              id: "investigate",
              value: counts.investigate,
              label: "investigate",
            } satisfies BulkResolverMetric,
          ]
        : []),
      ...(counts.failed > 0
        ? [
            {
              id: "failed",
              value: counts.failed,
              label: "failed",
            } satisfies BulkResolverMetric,
          ]
        : []),
      ...(counts.legacySkipped > 0
        ? [
            {
              id: "legacy-skips",
              value: counts.legacySkipped,
              label: "legacy skips to classify",
            } satisfies BulkResolverMetric,
          ]
        : []),
    ];
    return (
      <BulkResolverStrip
        state="review"
        testId="plans-cleanup-review"
        settings={
          <BulkResolverSettingsControl
            kind="plan-cleanup"
            settings={resolverSettings}
            effective={run.launchSnapshot ?? {}}
          />
        }
        headline={
          <>
            {counts.total} assessed · {counts.applied} auto-applied ·{" "}
            {counts.unresolved} still open
          </>
        }
        headlineTestId="plans-cleanup-review-headline"
        elapsed={elapsed}
        metrics={reviewMetrics}
        metricsTestId="plans-cleanup-accounting"
        metricsAriaLabel="Plan cleanup accounting"
        actions={
          <>
            <button
              type="button"
              className="op-inbox__bulk-accept-all"
              data-testid="plans-cleanup-open-review"
              disabled={counts.unresolved === 0 || busy || classifying}
              onClick={() => onReview(run.runId)}
            >
              <ChevronRight size={14} aria-hidden="true" />
              Review {counts.unresolved} unresolved
            </button>
            {retryableFindings.length > 0 ? (
              <button
                type="button"
                className="op-inbox__bulk-continue"
                data-testid="plans-cleanup-continue"
                disabled={busy || classifying}
                onClick={() => void onResume()}
              >
                {busy ? (
                  <span className="op-inbox__bulk-spin" aria-hidden="true">
                    <Loader2 size={14} />
                  </span>
                ) : (
                  <RotateCw size={14} aria-hidden="true" />
                )}
                {busy
                  ? "Continuing…"
                  : `Continue ${retryableFindings.length} retryable`}
              </button>
            ) : null}
            {counts.legacySkipped > 0 ? (
              <button
                type="button"
                className="op-inbox__bulk-ghost op-inbox__bulk-ghost--wide"
                data-testid="plans-cleanup-classify"
                disabled={busy || classifying}
                onClick={() => void onReclassify()}
              >
                {classifying
                  ? "Classifying…"
                  : `Classify ${counts.legacySkipped} legacy skips`}
              </button>
            ) : null}
            <button
              type="button"
              className="op-inbox__bulk-ghost op-inbox__bulk-ghost--wide"
              data-testid="plans-cleanup-hide"
              disabled={busy}
              onClick={onRunCleared}
            >
              Hide
            </button>
          </>
        }
        hint={
          <>
            Review opens every unresolved finding with its proposed next step.
            Continue retries only unavailable/failed findings through the same
            saved run and preserves every earlier outcome.
          </>
        }
        notice={
          notice
            ? {
                message: notice,
                onDismiss: () => setNotice(null),
                dismissLabel: "Dismiss clean-up notice",
              }
            : null
        }
      />
    );
  }

  const failureNotice =
    notice ??
    (run?.phase === "failed" ? (run.error ?? "clean-up run failed") : null);
  const count = planSlugs.length;
  return (
    <BulkResolverStrip
      state="idle"
      testId="plans-cleanup-idle"
      settings={
        <BulkResolverSettingsControl
          kind="plan-cleanup"
          settings={resolverSettings}
        />
      }
      actionTestId="plans-cleanup-start"
      ariaLabel={`Clean up ${count} shown plan${count === 1 ? "" : "s"}`}
      icon={<BrushCleaning size={17} />}
      busy={starting}
      disabled={count === 0 || starting || !resolverSettings.ready}
      title={`Clean up ${count} shown plan${count === 1 ? "" : "s"}`}
      subtitle={
        <>
          Reconciles stale statuses, cleared blockers &amp; finished work · you
          review the rest
        </>
      }
      onStart={() => void onStart()}
      notice={
        failureNotice
          ? {
              message: failureNotice,
              onDismiss: () => setNotice(null),
              dismissLabel: "Dismiss clean-up notice",
            }
          : null
      }
    />
  );
}
