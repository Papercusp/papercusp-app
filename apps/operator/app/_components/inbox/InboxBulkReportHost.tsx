"use client";

/**
 * URL-owned app-pane host for the grouped Inbox bulk-resolve report.
 *
 * The phase gate itself lives in the SHARED
 * `review-report/ReviewReportHost` (bulk-review-report-legibility-and-lifecycle
 * -2026-08-31 P-005): this file keeps only what is genuinely Inbox's — its
 * flag, its run query, and how an item opens its thread.
 */
import { useCallback } from "react";
import { parseAsString, useQueryState, useQueryStates } from "nuqs";
import { FLAGS } from "@papercusp/flags";
import { lazyWithRetry as lazy } from "@papercusp/operator-core/lib/lazy-with-retry";
import { useFlag } from "@/lib/flag-hooks";
import { encodeScopedRef } from "../chat/chat-ref-popup-params";
import { useReportTakeoverParam } from "../review-report/ReportTakeover";
import {
  ReviewReportSurface,
  useReviewReportHost,
} from "../review-report/ReviewReportHost";
import { WORK_ITEM_DISCUSSION_PARAM } from "../work-items/WorkItemDiscussion";
import { attentionWorkItemId } from "./attention-work-item-ref";
import { INBOX_BULK_RUN_PARAM, useInboxBulkRun } from "./use-inbox-bulk-run";
import "./inbox-bulk-report.css";

const InboxBulkReport = lazy(() => import("./InboxBulkReport"));

export default function InboxBulkReportHost() {
  const enabled = useFlag(FLAGS.INBOX_BULK_RESOLVE);
  const report = useReportTakeoverParam(INBOX_BULK_RUN_PARAM);
  const bulk = useInboxBulkRun(report.value, {
    enabled: enabled && report.foreground,
  });
  const host = useReviewReportHost(report, {
    enabled,
    loading: bulk.loading,
    available: bulk.run !== null,
    phase: bulk.run?.phase,
  });
  const [, setInboxTarget] = useQueryStates({
    opci: parseAsString,
    opcis: parseAsString,
  });
  const [, setDiscussionRef] = useQueryState(
    WORK_ITEM_DISCUSSION_PARAM,
    parseAsString,
  );
  const openThread = useCallback(
    (item: Parameters<typeof attentionWorkItemId>[0]) => {
      const workItemId = attentionWorkItemId(item);
      void (async () => {
        await setInboxTarget({ opci: "all", opcis: item.id });
        if (workItemId && item.harnessSlug) {
          const ref = encodeScopedRef(item.harnessSlug, workItemId);
          await setDiscussionRef(ref);
        }
        report.close();
      })();
    },
    [report, setDiscussionRef, setInboxTarget],
  );

  if (!host.presentation || !bulk.run) return null;

  return (
    <ReviewReportSurface
      testId="inbox-bulk-report-takeover"
      presentation={host.presentation}
      loadingLabel="Loading Inbox report…"
    >
      <InboxBulkReport
        key={bulk.run.runId}
        run={bulk.run}
        runItems={bulk.items}
        presentation={host.presentation}
        readOnly={host.readOnly}
        onOpenThread={openThread}
        onClose={report.close}
      />
    </ReviewReportSurface>
  );
}
