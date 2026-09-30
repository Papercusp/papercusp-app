"use client";

/**
 * URL-owned app-pane host for the grouped plan clean-up report.
 *
 * The phase gate itself lives in the SHARED
 * `review-report/ReviewReportHost` (bulk-review-report-legibility-and-lifecycle
 * -2026-08-31 P-005): this file keeps only what is genuinely Plans' — its flag,
 * its run query, and how a finding opens its plan.
 */
import { useCallback } from "react";
import { parseAsString, useQueryState } from "nuqs";
import { FLAGS } from "@papercusp/flags";
import { lazyWithRetry as lazy } from "@papercusp/operator-core/lib/lazy-with-retry";
import { useFlag } from "@/lib/flag-hooks";
import { useReportTakeoverParam } from "../review-report/ReportTakeover";
import {
  ReviewReportSurface,
  useReviewReportHost,
} from "../review-report/ReviewReportHost";
import {
  PLAN_CLEANUP_RUN_PARAM,
  usePlanCleanupRun,
  type PlanCleanupFinding,
} from "./use-plan-cleanup-run";
import { encodeScopedRef } from "../chat/chat-ref-popup-params";
import { PLAN_DASHBOARD_PARAM } from "./PlanDashboardHost";
import "./plan-cleanup-report.css";

const PlanCleanupReport = lazy(() => import("./PlanCleanupReport"));

export default function PlanCleanupReportHost() {
  const enabled = useFlag(FLAGS.PLAN_CLEANUP);
  const report = useReportTakeoverParam(PLAN_CLEANUP_RUN_PARAM);
  const cleanup = usePlanCleanupRun(report.value, {
    enabled: enabled && report.foreground,
  });
  const host = useReviewReportHost(report, {
    enabled,
    loading: cleanup.loading,
    available: cleanup.run !== null,
    phase: cleanup.run?.phase,
  });
  const [, setDashboardPlan] = useQueryState(
    PLAN_DASHBOARD_PARAM,
    parseAsString,
  );
  const openFinding = useCallback(
    (finding: PlanCleanupFinding) => {
      void (async () => {
        await report.close();
        await setDashboardPlan(
          encodeScopedRef(finding.harnessSlug, finding.planSlug),
        );
      })();
    },
    [report, setDashboardPlan],
  );

  if (!host.presentation || !cleanup.run) return null;

  return (
    <ReviewReportSurface
      testId="plan-cleanup-report-takeover"
      presentation={host.presentation}
      loadingLabel="Loading clean-up report…"
    >
      <PlanCleanupReport
        key={cleanup.run.runId}
        run={cleanup.run}
        findings={cleanup.findings}
        presentation={host.presentation}
        readOnly={host.readOnly}
        onOpenFinding={openFinding}
        onClose={report.close}
      />
    </ReviewReportSurface>
  );
}
