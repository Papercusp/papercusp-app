"use client";

/**
 * ReviewReportHost (bulk-review-report-legibility-and-lifecycle-2026-08-31
 * P-005/P-006, D-002, D-005) — the ONE place that decides whether a bulk review
 * report mounts, and with which presentation.
 *
 * What it replaces: `PlanCleanupReportHost` and `InboxBulkReportHost` each
 * carried their own `phase === "review"` gate. That gate is why a run which
 * auto-applied everything (`complete`) and a run that died (`failed`) rendered
 * NOTHING AT ALL — the auto-apply run being precisely the one that changed the
 * owner's work without asking, and so the one that most needs an audit trail
 * (R3). Fixing that in two copies is the mistake P-005 exists to avoid.
 *
 * D-005 — a LIVE run needs a second signal, not just a phase. The run param is
 * also the progress strip's deep link, so admitting `pending`/`running` on
 * foreground alone would slam a takeover over the pane the moment a run starts.
 * The owner marker (`?oprpt=`) distinguishes the two: `show()` sets it, a bare
 * `?opcln=`/`?opcbr=` does not. So a SETTLED run opens from any foreground
 * claim, and a LIVE run opens only when the owner explicitly asked for it.
 */
import { Suspense, type ReactNode } from "react";
import {
  ReportTakeoverLayer,
  useReleaseMissingReportTakeover,
  type ReportTakeoverParam,
} from "./ReportTakeover";
import "./review-report.css";

/**
 * The phase vocabulary both run shapes already share, as RUNTIME members.
 *
 * The member list is the definition and the type is derived from it, not the
 * other way round. That is deliberate: the acceptance criterion for this
 * surface requires enumerating the phases from the type's own members rather
 * than from a literal list copied into a test, so that a phase added later
 * fails the presentation drill by construction instead of waiting for someone
 * to remember to extend a fixture. A bare `type` union has no runtime members
 * and cannot be iterated, which makes that guarantee impossible to write.
 */
export const REVIEW_RUN_PHASES = [
  "pending",
  "running",
  "review",
  "complete",
  "failed",
] as const;

export type ReviewRunPhase = (typeof REVIEW_RUN_PHASES)[number];

/**
 * Which presentation a mounted report gets. `null` means "do not mount".
 *
 * - `live`     — the run is still producing rows; show what it has, read-only.
 * - `review`   — the run settled with work awaiting the owner; fully actionable.
 * - `settled`  — the run finished on its own; an audit trail of what it did.
 * - `failed`   — the run died; its error, its partial rows, and a way to re-run.
 */
export type ReviewReportPresentation = "live" | "review" | "settled" | "failed";

export interface ReviewReportGateInput {
  /** The consumer's feature flag. */
  enabled: boolean;
  /** This param owns the heavyweight report foreground. */
  foreground: boolean;
  /** The owner marker NAMES this param — someone called `show()`. */
  explicitOwner: boolean;
  /** The run param carries a value. */
  hasValue: boolean;
  /** The persisted run's phase; null/undefined while the run is unknown. */
  phase: ReviewRunPhase | null | undefined;
}

/**
 * The gate, as a pure function so the phase policy is pinned independently of
 * React, nuqs and both data layers. Exported for exactly that reason.
 */
export function reviewReportPresentation(
  input: ReviewReportGateInput,
): ReviewReportPresentation | null {
  if (!input.enabled || !input.foreground || !input.hasValue) return null;
  switch (input.phase) {
    case "review":
      return "review";
    case "complete":
      return "settled";
    case "failed":
      return "failed";
    case "pending":
    case "running":
      // D-005: the strip owns a live run unless the owner opened the report.
      return input.explicitOwner ? "live" : null;
    default:
      // No run, or a phase this build does not know. Mount nothing rather than
      // guess a presentation for it.
      return null;
  }
}

/** A live run's rows are still being written; nothing in them is safe to
 *  commit as a batch yet. Every settled phase stays actionable and lets the
 *  row's own `status`/`selectable` decide, which is already exhaustive. */
export function reviewReportReadOnly(
  presentation: ReviewReportPresentation | null,
): boolean {
  return presentation === "live";
}

export interface UseReviewReportHostOptions {
  /** The consumer's feature flag. */
  enabled: boolean;
  /** True until the explicit run lookup has settled. */
  loading: boolean;
  /** True once the selected run exists, whatever its phase. */
  available: boolean;
  /** The persisted run's phase. */
  phase: ReviewRunPhase | null | undefined;
}

export interface ReviewReportHostState {
  presentation: ReviewReportPresentation | null;
  /** Convenience: `presentation !== null`. */
  visible: boolean;
  readOnly: boolean;
}

/**
 * The shared half of the host contract: the missing-run release effect and the
 * phase decision. Consumers keep only what is genuinely theirs — their flag,
 * their run query, and their report component.
 *
 * The `report` param is passed IN rather than resolved here because the
 * consumer's own run query takes `report.value`/`report.foreground` as
 * arguments, so it has to be resolved above this call. That one
 * `useReportTakeoverParam(<key>)` line stays in each consumer; the POLICY —
 * which phases mount, with what presentation, and when a live run is allowed to
 * take the pane — is defined once, here.
 */
export function useReviewReportHost(
  report: ReportTakeoverParam,
  options: UseReviewReportHostOptions,
): ReviewReportHostState {
  useReleaseMissingReportTakeover(report, {
    enabled: options.enabled,
    loading: options.loading,
    available: options.available,
  });
  const presentation = reviewReportPresentation({
    enabled: options.enabled,
    foreground: report.foreground,
    explicitOwner: report.explicitOwner,
    hasValue: Boolean(report.value),
    phase: options.phase,
  });
  return {
    presentation,
    visible: presentation !== null,
    readOnly: reviewReportReadOnly(presentation),
  };
}

export interface ReviewReportSurfaceProps {
  testId: string;
  presentation: ReviewReportPresentation;
  /** Copy for the lazy-chunk fallback ("Loading clean-up report…"). */
  loadingLabel: string;
  children: ReactNode;
}

/** The takeover layer plus the lazy-chunk boundary, identical for both flows.
 *  `data-presentation` is on the layer so a test — and CSS — can address the
 *  phase without either consumer re-deriving it. */
export function ReviewReportSurface({
  testId,
  presentation,
  loadingLabel,
  children,
}: ReviewReportSurfaceProps) {
  return (
    <ReportTakeoverLayer testId={testId}>
      <div
        className="review-report-surface"
        data-presentation={presentation}
        data-testid={`${testId}-surface`}
      >
        <Suspense
          fallback={
            <div
              className="review-report__loading"
              role="status"
              aria-live="polite"
            >
              {loadingLabel}
            </div>
          }
        >
          {children}
        </Suspense>
      </div>
    </ReportTakeoverLayer>
  );
}
