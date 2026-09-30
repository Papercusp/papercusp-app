/**
 * The aside's BRIEFING — what the split-mode `/inbox` page shows when nothing
 * is selected (inbox-three-column-resolver-states-2026-09-06 P-005 / P-006).
 * The 31 Aug board left this pane empty until selection; the merged spec fills
 * it with the headline count, four tiles, the last resolver run's readout with
 * its grouped disposition rows and the primary action — and, while a run is
 * LIVE, with the run itself: progress, the three counts, the launch snapshot
 * with Restart, and Stop (P-006); and once the persisted phase is `review`,
 * with the review itself: the grouped rows, Review, and "Continue N retryable"
 * stating exactly which rows it requeues (P-007). Reopening the pane lands on
 * that state because the run is persisted and `useInboxBulkRun` reads the
 * latest one without a deep link — the design now shows that it did.
 *
 * Composed ONLY from state the pane already holds (D-002: no new reads):
 *  - the feed's scope counts (`needs`) and the server total (`tracked`);
 *  - the persisted bulk run `useInboxBulkRun` already loads for the rail card —
 *    its item ROWS drive the run-derived tiles, the readout and the grouped
 *    rows through the same `deriveRunCounts` the strips read;
 *  - the run's gestures through the same `useBulkRunActions` the strip fires,
 *    so Stop and Restart here ARE the rail card's Stop and Restart;
 *  - the P-004 feed block (window strip + foot), mounted last.
 *
 * The launch receipt is rendered from `run.launchSnapshot` with the control's
 * own `formatResolverLaunchReceipt` rather than by mounting
 * `BulkResolverSettingsControl`: in receipt mode that control still drags the
 * editable-settings hooks (profile load, launch-option catalog) in for a
 * read-only line the rail card is already paying for once.
 */
import type { ReactNode } from "react";
import {
  AlertCircle,
  ChevronRight,
  Loader2,
  RotateCw,
  Square,
} from "lucide-react";
import {
  deriveRunCounts,
  useBulkRunActions,
  type BulkRun,
  type BulkRunItem,
} from "./use-inbox-bulk-run";
import { formatRunElapsed } from "../review-report/bulk-run-time";
import { formatResolverLaunchReceipt } from "../bulk-resolver/BulkResolverSettingsControl";
import { PERF_INTERACTIONS, beginInteraction } from "../perf/perf-marks";
import "./inbox-bulk.css";

export interface InboxBriefingProps {
  /** Decision-tier rows in the current scope — the "N need you" count. */
  needs: number;
  /** The server-side attention total, independent of the loaded page. */
  tracked: number;
  /** The persisted bulk run the pane already loads (null when none / flag off). */
  run: BulkRun | null;
  runItems: BulkRunItem[];
  /**
   * Rows a continuation pass may requeue — pending, skipped or failed — as
   * `useInboxBulkRun` derives them. Drives "Continue N retryable" (P-007);
   * omitted → no resume control.
   */
  unreached?: BulkRunItem[];
  /** A live run: the briefing shows the run in progress instead of the glance. */
  isRunning: boolean;
  /** Opens the grouped report for the run — the strip's `onReview` op. */
  onReview: (runId: string) => void;
  /**
   * The live view's secondary action: hand focus back to the list so the
   * owner keeps reading while the resolver works. Omitted → no button.
   */
  onKeepWorking?: () => void;
  /** The P-004 feed block (window strip + foot); rendered last. */
  feed?: ReactNode;
}

export interface InboxRunDispositionRow {
  id: string;
  label: string;
  description: string;
  count: number;
  /** The umbrella row: every `recommended` row, whatever its typed kind. */
  umbrella?: boolean;
}

type RunCounts = ReturnType<typeof deriveRunCounts>;

/**
 * The briefing's grouped disposition rows, from the same `deriveRunCounts`
 * the strips read (so the two surfaces cannot disagree). "Recommendations" is
 * the UMBRELLA — every `recommended` row, whatever its typed disposition — and
 * the owner-action / cleanup rows beneath it are subsets of it, so the rows
 * deliberately do NOT sum: the spec's "143 + 78 + 51 + 6 exceeds 158" is this
 * overlap, labelled instead of hidden.
 */
export function deriveRunDispositionRows(
  counts: RunCounts,
): InboxRunDispositionRow[] {
  const rows: InboxRunDispositionRow[] = [
    {
      id: "recommendations",
      label: "Recommendations",
      description: "every proposed next step — the typed rows below are among them",
      count: counts.recommendationTotal,
      umbrella: true,
    },
  ];
  if (counts.ownerAction > 0) {
    rows.push({
      id: "owner-action",
      label: "Owner actions",
      description: "only you can decide",
      count: counts.ownerAction,
    });
  }
  if (counts.cleanupCandidate > 0) {
    rows.push({
      id: "cleanup-candidate",
      label: "Cleanup candidates",
      description: "safe to close together",
      count: counts.cleanupCandidate,
    });
  }
  if (counts.retryNeeded + counts.pending > 0) {
    rows.push({
      id: "retry-needed",
      label: "Retry needed",
      description: "did not reach a decision",
      count: counts.retryNeeded + counts.pending,
    });
  }
  if (counts.routed > 0) {
    rows.push({
      id: "routed",
      label: "Routed",
      description: "handed to another lane",
      count: counts.routed,
    });
  }
  if (counts.investigate > 0) {
    rows.push({
      id: "investigate",
      label: "Investigate",
      description: "needs a closer look",
      count: counts.investigate,
    });
  }
  if (counts.failed > 0) {
    rows.push({
      id: "failed",
      label: "Failed",
      description: "the resolver errored",
      count: counts.failed,
    });
  }
  return rows;
}

export function briefingHeadline(needs: number): string {
  if (needs === 0) return "Nothing is waiting on you";
  return `${needs} ${needs === 1 ? "item is" : "items are"} waiting on you`;
}

/** The live view's headline — the same slot, so the aside never re-flows. */
export const RUNNING_HEADLINE = "Papercup is resolving…";
/** The review view's headline (P-007): the run is waiting on the owner. */
export const REVIEW_HEADLINE = "Review the run";

/**
 * The resume control's SCOPE, stated where the gesture is: what Continue will
 * requeue and, as importantly, what it will not touch (`resumeReviewRun`
 * preserves owner decisions, terminal outcomes and recommendations).
 */
export function resumeScopeCopy(retryable: number): string {
  return `${retryable} ${retryable === 1 ? "row was" : "rows were"} never reached. Continuing requeues only rows whose detail was unavailable or whose resolver attempt failed. Your decisions, terminal outcomes and recommendations are preserved.`;
}

function Tile({
  id,
  value,
  label,
  tone,
}: {
  id: string;
  value: number | null;
  label: string;
  /** `review` renders in the warn colour, `good` in the good colour. */
  tone?: "good" | "review";
}) {
  const toneClass = tone === "good" ? " is-good" : tone === "review" ? " is-em" : "";
  return (
    <div
      className={`op-inbox__briefing-tile${toneClass}`}
      data-testid={`inbox-briefing-tile-${id}`}
    >
      <strong>{value === null ? "—" : value}</strong>
      <span>{label}</span>
    </div>
  );
}

export default function InboxBriefing({
  needs,
  tracked,
  run,
  runItems,
  unreached,
  isRunning,
  onReview,
  onKeepWorking,
  feed,
}: InboxBriefingProps) {
  const counts = run ? deriveRunCounts(runItems, run) : null;
  const live = isRunning && run !== null && counts !== null;
  const showRun = run !== null && counts !== null && !isRunning;
  const inReview = showRun && run !== null && run.phase === "review";
  const retryable = showRun ? (unreached?.length ?? 0) : 0;
  const rows = counts ? deriveRunDispositionRows(counts) : [];
  const elapsed = run ? formatRunElapsed(run.startedAt, run.finishedAt) : null;
  // Same ops as the rail card (D-002): Stop/Restart for the live view, Resume/
  // Reclassify for the review view, one notice line for whichever fired.
  const {
    stop,
    restart,
    resume,
    reclassify,
    restarting,
    resuming,
    classifying,
    notice,
  } = useBulkRunActions(run, unreached);
  const stale = run?.liveness?.state === "stale" ? run.liveness : null;
  const openReview = () => {
    if (!run) return;
    // Same gesture boundary as the strip's Review: the report ends it after
    // its first committed render.
    beginInteraction(PERF_INTERACTIONS.inboxBulkReportOpen);
    onReview(run.runId);
  };

  return (
    <div
      className="op-inbox__briefing"
      data-testid="inbox-briefing"
      data-briefing-state={live ? "running" : showRun ? "last-run" : "quiet"}
    >
      <div className="op-inbox__briefing-head">
        <h2
          className="op-inbox__briefing-title"
          data-testid="inbox-briefing-headline"
        >
          {live
            ? RUNNING_HEADLINE
            : inReview
              ? REVIEW_HEADLINE
              : briefingHeadline(needs)}
        </h2>
        <p className="op-inbox__briefing-lead">
          {live ? (
            <>
              Every row keeps its own badge in the list, so you can carry on
              reading while this runs. Nothing is applied without your final
              gesture.
            </>
          ) : inReview ? (
            <>
              Grouped by what each row now needs from you — open the review to
              work a group, or answer rows one at a time in the list.
            </>
          ) : (
            <>
              Nothing is selected. This is where an item opens — until then,{" "}
              {showRun
                ? "what the last resolver run left behind."
                : "the queue at a glance."}
            </>
          )}
        </p>
      </div>
      {live && run && counts ? (
        <>
          {/* P-006: the run in progress — the aside has the room the 210px
              rail card lacks, so the launch snapshot and Restart live here
              beside the progress and the three counts. */}
          <section
            className="op-inbox__briefing-run op-inbox__briefing-run--live"
            aria-label="Resolver run in progress"
            aria-busy="true"
            data-testid="inbox-briefing-running"
          >
            <p className="op-inbox__briefing-run-head">
              <span className="op-inbox__bulk-spin" aria-hidden="true">
                <Loader2 size={12} />
              </span>
              <em>Run in progress</em>
              {elapsed ? (
                <span className="op-inbox__briefing-run-phase">
                  running {elapsed}
                </span>
              ) : null}
              <span
                className="op-inbox__briefing-run-elapsed"
                data-testid="inbox-briefing-running-decided"
              >
                {counts.decided} / {counts.total}
              </span>
            </p>
            <div
              className="op-inbox__bulk-track"
              role="progressbar"
              aria-valuenow={counts.percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`Bulk resolve progress: ${counts.decided} of ${counts.total} decided`}
            >
              <div
                className="op-inbox__bulk-fill"
                style={{ width: `${counts.percent}%` }}
              />
            </div>
            <div
              className="op-inbox__briefing-grid op-inbox__briefing-grid--run"
              role="group"
              aria-label="Run so far"
              data-testid="inbox-briefing-running-counts"
            >
              <Tile
                id="resolved"
                value={counts.resolved}
                label="Resolved"
                tone="good"
              />
              <Tile
                id="for-review"
                value={counts.forReview}
                label="For review"
                tone="review"
              />
              <Tile id="left" value={counts.left} label="Left" />
            </div>
            <div
              className="op-inbox__briefing-launch"
              data-testid="inbox-briefing-launch"
            >
              <span className="op-inbox__briefing-launch-label">
                Launch settings
              </span>
              <span
                className="op-inbox__briefing-launch-receipt"
                data-testid="inbox-briefing-launch-receipt"
              >
                {formatResolverLaunchReceipt(run.launchSnapshot ?? {})}
              </span>
              <span className="op-inbox__briefing-launch-fixed">
                fresh · headless · su
              </span>
              {stale ? (
                <span
                  className="op-inbox__briefing-launch-stale"
                  role="alert"
                  data-testid="inbox-briefing-resolver-stale"
                >
                  <AlertCircle size={12} aria-hidden="true" />
                  {stale.measuredFrom === "start"
                    ? "Resolver never reported after launch"
                    : "Resolver stopped reporting"}
                </span>
              ) : null}
              <button
                type="button"
                className="op-inbox__bulk-ghost op-inbox__bulk-ghost--wide op-inbox__briefing-restart"
                data-testid="inbox-briefing-restart"
                disabled={restarting}
                onClick={() => void restart()}
              >
                {restarting ? (
                  <span className="op-inbox__bulk-spin" aria-hidden="true">
                    <Loader2 size={13} />
                  </span>
                ) : (
                  <RotateCw size={13} aria-hidden="true" />
                )}
                {restarting ? "Restarting…" : "Restart resolver"}
              </button>
              <span className="op-inbox__briefing-launch-hint">
                Relaunches with these same settings · completed outcomes are
                kept
              </span>
            </div>
            {notice ? (
              <p
                className="op-inbox__bulk-notice"
                role="status"
                data-testid="inbox-briefing-notice"
              >
                {notice}
              </p>
            ) : null}
          </section>
          <div className="op-inbox__briefing-actions">
            <button
              type="button"
              className="op-inbox__briefing-stop"
              data-testid="inbox-briefing-stop"
              onClick={stop}
            >
              <Square size={12} aria-hidden="true" />
              Stop the run
            </button>
            {onKeepWorking ? (
              <button
                type="button"
                className="op-inbox__bulk-ghost op-inbox__bulk-ghost--wide"
                data-testid="inbox-briefing-keep-working"
                onClick={onKeepWorking}
              >
                Keep working the list
              </button>
            ) : null}
          </div>
        </>
      ) : (
        <div
          className="op-inbox__briefing-grid"
          role="group"
          aria-label="Inbox at a glance"
          data-testid="inbox-briefing-grid"
        >
          <Tile id="need-you" value={needs} label="Need you" />
          <Tile
            id="still-open"
            value={counts ? counts.unresolved : null}
            label="Still open"
            tone="review"
          />
          <Tile
            id="auto-resolved"
            value={counts ? counts.resolved : null}
            label="Auto-resolved"
          />
          <Tile id="tracked" value={tracked} label="Tracked" />
        </div>
      )}
      {showRun && run && counts ? (
        <section
          className="op-inbox__briefing-run"
          aria-label="Last resolver run"
          data-testid="inbox-briefing-run"
        >
          <p className="op-inbox__briefing-run-head">
            <em>Last run</em>
            <span className="op-inbox__briefing-run-phase">{run.phase}</span>
            {elapsed ? (
              <span className="op-inbox__briefing-run-elapsed">{elapsed}</span>
            ) : null}
          </p>
          <p
            className="op-inbox__briefing-run-line"
            data-testid="inbox-briefing-run-line"
          >
            {counts.total} assessed · {counts.resolved} auto-resolved ·{" "}
            {counts.unresolved} still open
          </p>
          <ul
            className="op-inbox__briefing-rows"
            data-testid="inbox-briefing-rows"
          >
            {rows.map((r) => (
              <li
                key={r.id}
                className={`op-inbox__briefing-row${r.umbrella ? " is-umbrella" : ""}`}
                data-testid={`inbox-briefing-row-${r.id}`}
              >
                <span className="op-inbox__briefing-row-name">{r.label}</span>
                <span className="op-inbox__briefing-row-desc">
                  {r.description}
                </span>
                <span className="op-inbox__briefing-row-count">{r.count}</span>
              </li>
            ))}
          </ul>
          <div className="op-inbox__briefing-actions">
            <button
              type="button"
              className="op-inbox__briefing-review"
              data-testid="inbox-briefing-review"
              disabled={counts.unresolved === 0 || resuming || classifying}
              onClick={openReview}
            >
              Review {counts.unresolved} unresolved
              <ChevronRight size={14} aria-hidden="true" />
            </button>
            {counts.legacySkipped > 0 ? (
              <button
                type="button"
                className="op-inbox__bulk-ghost op-inbox__bulk-ghost--wide"
                data-testid="inbox-briefing-classify"
                disabled={classifying || resuming}
                onClick={() => void reclassify()}
              >
                {classifying
                  ? "Classifying…"
                  : `Classify ${counts.legacySkipped} legacy skips`}
              </button>
            ) : null}
          </div>
          {/* P-007: resume is a first-class control — it says how many, and
              exactly which rows it will and will not touch. Shown only while
              there is something to requeue. */}
          {retryable > 0 ? (
            <div
              className="op-inbox__briefing-resume"
              data-testid="inbox-briefing-resume"
            >
              <p data-testid="inbox-briefing-resume-scope">
                {resumeScopeCopy(retryable)}
              </p>
              <button
                type="button"
                className="op-inbox__bulk-continue"
                data-testid="inbox-briefing-continue"
                disabled={resuming || classifying}
                onClick={() => void resume()}
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
            </div>
          ) : null}
          {notice ? (
            <p
              className="op-inbox__bulk-notice"
              role="status"
              data-testid="inbox-briefing-notice"
            >
              {notice}
            </p>
          ) : null}
        </section>
      ) : null}
      {feed}
    </div>
  );
}
