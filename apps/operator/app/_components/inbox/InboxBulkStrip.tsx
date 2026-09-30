/**
 * InboxBulkStrip — the Inbox's BULK RESOLVE command strip
 * (inbox-bulk-resolve-2026-08-23, P-006; owner-approved direction A, D-003).
 *
 * ONE SLOT, THREE STATES, directly under the "Needs you" masthead and above the
 * search/filter toolbar. Which state renders is derived from the run's PHASE, so
 * the strip cannot show a stale state after a reload — the phase is in Postgres,
 * not in component state (Requirement 7):
 *
 *   IDLE    — one button: "Bulk resolve N filtered items", N = the pane's CURRENT
 *             visible set. Disabled at 0. The sub-label names what will happen,
 *             because a bulk action whose behavior the owner has to guess at is
 *             one they are right not to press.
 *   RUNNING — progress bar + resolved / for-review / left counts + Stop.
 *   REVIEW  — "N need your call · M auto-resolved", Review decisions, Dismiss.
 *             Review hands the exact persisted run to the grouped report; the
 *             narrow strip never applies a batch without showing its reasons.
 *
 * WHY THE CLIENT POSTS ITEM IDS. `visible` is a snapshot of a live, SSE-updated
 * feed. Re-deriving the filtered set server-side would resolve against a set that
 * has moved since the owner looked, so the run could act on an item they never
 * saw — the one thing a bulk action must never do. The ids the pane is rendering
 * are posted verbatim, with the filters riding along as provenance only.
 *
 * A FAILED START IS SHOWN, NOT SWALLOWED. Both failure shapes surface in the
 * strip itself: a request that never created a run, and a run created whose
 * resolver could not be launched (the route returns the run either way). Every
 * item stays individually resolvable by hand in both cases.
 */
import { useCallback, useState } from "react";
import { ChevronRight, Loader2, RotateCw, Sparkles } from "lucide-react";
import type { AttentionItem } from "@/app/admin/plans/plans-api";
import {
  deriveRunCounts,
  useBulkRunActions,
  type BulkRun,
  type BulkRunItem,
  type BulkSeedItem,
} from "./use-inbox-bulk-run";
import { formatRunElapsed } from "../review-report/bulk-run-time";
export { formatRunElapsed } from "../review-report/bulk-run-time";
import BulkResolverSettingsControl from "../bulk-resolver/BulkResolverSettingsControl";
import BulkResolverStrip, {
  type BulkResolverMetric,
  type BulkResolverStripVariant,
} from "../bulk-resolver/BulkResolverStrip";
import { useBulkResolverSettings } from "../bulk-resolver/bulk-resolver-settings";
import { PERF_INTERACTIONS, beginInteraction } from "../perf/perf-marks";

export interface InboxBulkStripProps {
  /** The pane's CURRENT filtered+sorted set — the exact rows it is showing. */
  visible: AttentionItem[];
  /** Human-readable provenance for the record (tier chip, kinds, search). */
  filterSnapshot: Record<string, unknown>;
  run: BulkRun | null;
  items: BulkRunItem[];
  recommendations: BulkRunItem[];
  unreached: BulkRunItem[];
  isRunning: boolean;
  isReview: boolean;
  /** Called with the new run id so the pane can deep-link it (`?opcbr=`). */
  onRunStarted: (runId: string) => void;
  /** Open the grouped review for this exact persisted run (`?opcbr=<runId>`). */
  onReview: (runId: string) => void;
  /**
   * WHERE it renders (inbox-three-column-resolver-states-2026-09-06 P-003,
   * D-002): `strip` (default) is the band in the list column — stack mode;
   * `card` is the compact summary at the foot of the split page's rail. The
   * ops, the run and its persistence are identical; only the copy and the
   * frame change.
   */
  variant?: BulkResolverStripVariant;
}

/** The seed the run is created from — the pane's own snapshot of each row. */
export function toBulkSeed(items: AttentionItem[]): BulkSeedItem[] {
  return items.map((i) => ({
    itemId: i.id,
    kind: i.kind,
    title: i.title ?? null,
    ref: i.ref ?? {},
    ownerAgentId: i.ownerAgentId ?? null,
  }));
}

export default function InboxBulkStrip({
  visible,
  filterSnapshot,
  run,
  items,
  recommendations,
  unreached,
  isRunning,
  isReview,
  onRunStarted,
  onReview,
  variant = "strip",
}: InboxBulkStripProps) {
  const card = variant === "card";
  // The run's gestures — stop / restart / resume / reclassify, their busy
  // flags and the notice line — are the shared hook's, so this strip and the
  // aside's run views cannot drift on copy or behaviour (D-002). Only Start
  // stays here: it needs the pane's visible set and the next-run settings.
  const {
    start,
    stop,
    restart: onRestart,
    resume: onResume,
    reclassify: onReclassify,
    restarting,
    resuming,
    classifying,
    notice,
    setNotice,
  } = useBulkRunActions(run, unreached);
  const resolverSettings = useBulkResolverSettings("inbox-resolve");
  const [starting, setStarting] = useState(false);
  const counts = deriveRunCounts(items, run);

  const onStart = useCallback(async () => {
    if (visible.length === 0 || starting || !resolverSettings.ready) return;
    setStarting(true);
    setNotice(null);
    try {
      const res = await start(
        toBulkSeed(visible),
        filterSnapshot,
        null,
        resolverSettings.profile,
      );
      if (!res.ok) {
        setNotice(res.error ?? "could not start the run");
        return;
      }
      if (res.runId) onRunStarted(res.runId);
      // The run row exists either way; only the RESOLVER failed to launch. Say
      // so plainly rather than leaving a run that will never move looking live.
      if (!res.launched) {
        setNotice(
          `resolver could not start${res.launchError ? `: ${res.launchError}` : ""}`,
        );
      }
    } finally {
      setStarting(false);
    }
  }, [
    visible,
    starting,
    start,
    filterSnapshot,
    onRunStarted,
    resolverSettings,
  ]);

  const openReview = useCallback(() => {
    if (!run) return;
    // The real gesture is the start boundary. InboxBulkReport ends this after
    // its first committed render; a deep link with no click simply no-ops.
    beginInteraction(PERF_INTERACTIONS.inboxBulkReportOpen);
    onReview(run.runId);
  }, [onReview, run]);

  /* ── RUNNING ─────────────────────────────────────────────────────────── */
  if (isRunning && run) {
    return (
      <BulkResolverStrip
        state="running"
        variant={variant}
        testId="inbox-bulk-running"
        settings={
          <BulkResolverSettingsControl
            kind="inbox-resolve"
            settings={resolverSettings}
            effective={run.launchSnapshot ?? {}}
            liveness={run.liveness}
            onRestart={() => void onRestart()}
            restartBusy={restarting}
          />
        }
        title={card ? "Resolving…" : "Papercup is resolving…"}
        stopTestId="inbox-bulk-stop"
        onStop={stop}
        progress={{
          percent: counts.percent,
          ariaLabel: `Bulk resolve progress: ${counts.decided} of ${counts.total} decided`,
        }}
        caption={
          card ? (
            <span data-testid="inbox-bulk-decided">
              {counts.decided} of {counts.total} decided
            </span>
          ) : undefined
        }
        metrics={[
          {
            id: "resolved",
            value: counts.resolved,
            label: "resolved",
            tone: "good",
          },
          {
            id: "review",
            value: counts.forReview,
            label: card ? "review" : "for review",
            tone: "review",
          },
          { id: "left", value: counts.left, label: "left" },
        ]}
        metricsTestId="inbox-bulk-counts"
        notice={notice ? { message: notice, role: "status" } : null}
      />
    );
  }

  /* ── REVIEW ──────────────────────────────────────────────────────────── */
  if (isReview && run) {
    const elapsed = formatRunElapsed(run.startedAt, run.finishedAt);
    const retryable = unreached.length;
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
      ...(counts.retryNeeded > 0 || counts.pending > 0
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
              label: "legacy skips classified above",
            } satisfies BulkResolverMetric,
          ]
        : []),
    ];
    // The card carries the two numbers its buttons act on; the full accounting
    // is the aside's readout (plan P-006/P-007), not a 210px column's.
    const cardMetrics = reviewMetrics.filter(
      (m) =>
        m.id === "recommendations" ||
        m.id === "retry-needed" ||
        m.id === "failed",
    );
    return (
      <BulkResolverStrip
        state="review"
        variant={variant}
        testId="inbox-bulk-review"
        settings={
          <BulkResolverSettingsControl
            kind="inbox-resolve"
            settings={resolverSettings}
            effective={run.launchSnapshot ?? {}}
          />
        }
        eyebrow={card ? "Review ready" : undefined}
        headline={
          card ? (
            <>
              {counts.unresolved} unresolved · {retryable} retryable
            </>
          ) : (
            <>
              {counts.total} assessed · {counts.resolved} auto-resolved ·{" "}
              {counts.unresolved} still open
            </>
          )
        }
        headlineTestId="inbox-bulk-review-headline"
        elapsed={elapsed}
        metrics={card ? cardMetrics : reviewMetrics}
        metricsTestId="inbox-bulk-accounting"
        metricsAriaLabel="Bulk resolve accounting"
        actions={
          <>
            <button
              type="button"
              className="op-inbox__bulk-accept-all"
              data-testid="inbox-bulk-review-decisions"
              disabled={counts.unresolved === 0 || resuming || classifying}
              onClick={openReview}
            >
              Review {counts.unresolved}
              {card ? "" : " unresolved"}
              <ChevronRight size={14} aria-hidden="true" />
            </button>
            {retryable > 0 ? (
              <button
                type="button"
                className="op-inbox__bulk-continue"
                data-testid="inbox-bulk-continue"
                disabled={resuming || classifying}
                onClick={() => void onResume()}
              >
                {resuming ? (
                  <span className="op-inbox__bulk-spin" aria-hidden="true">
                    <Loader2 size={14} />
                  </span>
                ) : (
                  <RotateCw size={14} aria-hidden="true" />
                )}
                {resuming ? "Continuing…" : `Continue ${retryable} retryable`}
              </button>
            ) : null}
            {counts.legacySkipped > 0 ? (
              <button
                type="button"
                className="op-inbox__bulk-ghost op-inbox__bulk-ghost--wide"
                data-testid="inbox-bulk-classify"
                disabled={classifying || resuming}
                onClick={() => void onReclassify()}
              >
                {classifying
                  ? "Classifying…"
                  : `Classify ${counts.legacySkipped} legacy skips`}
              </button>
            ) : null}
          </>
        }
        hint={
          card ? (
            <>Nothing applies without your gesture.</>
          ) : (
            <>
              Review opens every unresolved row with its proposed next step.
              Continue retries only rows whose detail was unavailable or whose
              resolver attempt failed; recommendations, owner actions, cleanup
              candidates, and terminal outcomes stay preserved.
            </>
          )
        }
        notice={notice ? { message: notice, role: "status" } : null}
      />
    );
  }

  /* ── IDLE ────────────────────────────────────────────────────────────── */
  const n = visible.length;
  const failureNotice = notice ?? (run?.phase === "failed" ? run.error : null);
  return (
    <BulkResolverStrip
      state="idle"
      variant={variant}
      settings={
        <BulkResolverSettingsControl
          kind="inbox-resolve"
          settings={resolverSettings}
        />
      }
      actionTestId="inbox-bulk-start"
      ariaLabel={
        card
          ? `Review bulk recommendation for ${n} filtered item${n === 1 ? "" : "s"}`
          : `Bulk resolve ${n} filtered item${n === 1 ? "" : "s"}`
      }
      icon={<Sparkles size={card ? 13 : 17} />}
      busy={starting}
      disabled={n === 0 || starting || !resolverSettings.ready}
      eyebrow={card ? "Bulk resolve" : undefined}
      title={
        starting
          ? "Starting…"
          : card
            ? `${n} row${n === 1 ? "" : "s"} can be reviewed together`
            : `Bulk resolve ${n} filtered item${n === 1 ? "" : "s"}`
      }
      subtitle={
        card
          ? "Papercup pre-recommends each one · nothing applies without your gesture"
          : "Papercup resolves what it can · the rest come back pre-recommended"
      }
      actionLabel={
        card ? (starting ? "Starting…" : "Review bulk recommendation") : undefined
      }
      onStart={() => void onStart()}
      notice={
        failureNotice
          ? {
              message: failureNotice,
              role: "alert",
              testId: "inbox-bulk-notice",
              onDismiss: notice ? () => setNotice(null) : undefined,
            }
          : null
      }
    />
  );
}
