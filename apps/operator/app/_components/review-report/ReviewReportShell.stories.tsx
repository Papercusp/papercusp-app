import type { Meta, StoryObj } from "@storybook/react-vite";
import { BrushCleaning, Sparkles } from "lucide-react";
import { expect, userEvent, waitFor, within } from "storybook/test";
import ReviewReportShell, { type ReviewReportGroup } from "./ReviewReportShell";

const meta: Meta<typeof ReviewReportShell> = {
  component: ReviewReportShell,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div
        className="review-report-takeover"
        style={{ minHeight: 900, position: "relative" }}
      >
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof ReviewReportShell>;

const plans: ReviewReportGroup[] = [
  {
    id: "flip-to-done",
    title: "Flip to done",
    description: "Item marked open, but its work-item completed with evidence",
    rows: [
      {
        id: "p1",
        title: "Index the verbatim leg",
        sourceLabel: "session-search-scope",
        referenceLabel: "P-004",
        transition: { from: "wip", to: "done" },
        evidence: [
          "WI-38121 completed 6d ago · completion evidence recorded",
          "Plan item linked by coverage · completion evidence verified",
        ],
        confidence: "high",
        accounting: "ready",
        detail: (
          <span>Open the plan to inspect the canonical completion record.</span>
        ),
      },
      {
        id: "p2",
        title: "Retire the legacy renderer",
        sourceLabel: "webapp-retirement",
        referenceLabel: "P-002",
        transition: { from: "wip", to: "done" },
        evidence: ["WI-40233 shipped in release 2026-08-19"],
        confidence: "high",
        accounting: "ready",
      },
    ],
  },
  {
    id: "clear-blockers",
    title: "Clear stale blockers",
    description: "The named blocker no longer holds",
    rows: [
      {
        id: "p3",
        title: "Resume migration work",
        sourceLabel: "session-search-scope",
        referenceLabel: "P-002",
        transition: { from: "blocked", to: "todo" },
        evidence: ["Blocked on migration 913 · applied Aug 19"],
        confidence: "high",
        accounting: "ready",
      },
      {
        id: "p4",
        title: "Re-open the fleet audit",
        sourceLabel: "fleet-wake-audit",
        referenceLabel: "P-003",
        transition: { from: "blocked", to: "todo" },
        evidence: ["WI-37810 resolved 12d ago"],
        confidence: "medium",
        accounting: "ready",
      },
    ],
  },
  {
    id: "finish-plans",
    title: "Finish or archive plans",
    description: "Everything done, or no activity on either clock",
    rows: [
      {
        id: "p5",
        title: "All seven items done",
        sourceLabel: "rowstate-badges",
        referenceLabel: "plan",
        transition: { from: "running", to: "shipped" },
        evidence: ["No open claims · last work 8d ago"],
        confidence: "high",
        accounting: "ready",
      },
      {
        id: "p6",
        title: "Looks abandoned; owner review required",
        sourceLabel: "webapp-retirement",
        referenceLabel: "plan",
        transition: { from: "running", to: "archived" },
        evidence: ["No edits or work in 34d · 2 open items"],
        confidence: "medium",
        accounting: "ready",
      },
    ],
  },
  {
    id: "refresh-now",
    title: "Refresh stale Now",
    description: "The Now section points at items already done",
    rows: [
      {
        id: "p7",
        title: "Author the next open frontier",
        sourceLabel: "plan-visibility-revamp",
        referenceLabel: "## Now",
        transition: { from: "stale", to: "rewrite" },
        evidence: ["Current Now names P-001, which is already done"],
        confidence: "medium",
        accounting: "manual",
        selectable: false,
        detail: "Open the plan and author replacement State / Next text.",
      },
    ],
  },
];

const inbox: ReviewReportGroup[] = [
  {
    id: "ack-message",
    title: "Acknowledge · Message",
    description: "A safe reply or acknowledgement is ready",
    rows: [
      {
        id: "i1",
        title: "Access request from Mara",
        sourceLabel: "Message",
        referenceLabel: "Acknowledge",
        evidence: [
          "Draft reply ready · policy match · no conflicts found",
          "Current Inbox item hydrated · reply target is still live",
        ],
        confidence: "medium",
        accounting: "manual",
        detail: (
          <span>
            Review the live draft, edit it if needed, then acknowledge or
            discuss.
          </span>
        ),
      },
      {
        id: "i2",
        title: "Build success notification",
        sourceLabel: "Notification",
        referenceLabel: "Acknowledge",
        evidence: ["No action needed · resolver checked current build"],
        confidence: "high",
        accounting: "handled",
        status: "applied",
      },
    ],
  },
  {
    id: "drop-alert",
    title: "Drop · Alert",
    description: "Resolved condition or duplicate alert",
    rows: [
      {
        id: "i3",
        title: "Duplicate environment alert",
        sourceLabel: "Alert",
        referenceLabel: "Drop",
        evidence: ["Same condition already resolved in the last 7 days"],
        confidence: "high",
        accounting: "ready",
      },
      {
        id: "i4",
        title: "Routine status update",
        sourceLabel: "Message",
        referenceLabel: "Drop",
        evidence: ["Informational only · no owner decision"],
        confidence: "medium",
        accounting: "ready",
      },
    ],
  },
  {
    id: "manual",
    title: "Manual follow-up",
    description: "No registered bulk action is safe",
    rows: [
      {
        id: "i5",
        title: "Vendor contract renewal",
        sourceLabel: "Escalation",
        referenceLabel: "Review",
        evidence: ["Signature required · waiting on owner"],
        confidence: "medium",
        accounting: "manual",
        selectable: false,
        detail: "Open the discussion to author a response.",
      },
    ],
  },
];

const performanceGroups: ReviewReportGroup[] = Array.from(
  { length: 12 },
  (_, groupIndex) => ({
    id: `stress-group-${groupIndex}`,
    title: `Review cohort ${groupIndex + 1}`,
    description: "20 realistic rows for interaction profiling",
    rows: Array.from({ length: 20 }, (_, rowIndex) => {
      const ordinal = groupIndex * 20 + rowIndex + 1;
      return {
        id: `stress-${groupIndex}-${rowIndex}`,
        title: `Recommendation ${ordinal}`,
        sourceLabel: `source-${String(ordinal).padStart(3, "0")}`,
        referenceLabel: `P-${String(ordinal).padStart(3, "0")}`,
        transition: { from: "pending", to: "done" },
        evidence: [
          `Completion evidence ${ordinal} is current and independently verified`,
          `Work-item ${ordinal} retains its full audit trail`,
          `No live claim or unresolved dependency blocks recommendation ${ordinal}`,
        ],
        confidence: (["high", "medium", "low", "insufficient"] as const)[
          ordinal % 4
        ]!,
        accounting: "ready",
        detail: `Open recommendation ${ordinal} to inspect its canonical completion record.`,
      } satisfies ReviewReportGroup["rows"][number];
    }),
  }),
);

const shared = {
  defaultSelected: "pending" as const,
  onApply: () => undefined,
  onDismiss: () => undefined,
};

export const PlansCleanUp: Story = {
  args: {
    ...shared,
    title: "Clean-up report",
    icon: <BrushCleaning size={19} />,
    subtitle:
      "7 proposed fixes across 5 plans · scanned just now · 9 safe fixes auto-applied",
    groups: plans,
    footer:
      "Every fix applies through the same verbs a hand edit uses — full audit trail, nothing deleted, live claims untouched.",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByTestId("review-row-p1"));
    await waitFor(() =>
      expect(canvas.getByTestId("review-row-detail-p1")).toBeVisible(),
    );
  },
};

export const InboxBulkResolve: Story = {
  args: {
    ...shared,
    title: "Inbox bulk-resolve report",
    icon: <Sparkles size={19} />,
    subtitle: "5 need your call · 12 auto-resolved · 1 needs manual follow-up",
    groups: inbox,
    footer:
      "Selected rows resolve through the same live Inbox action path as a hand resolve, then record acceptance on the run.",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByTestId("review-row-i1"));
    await waitFor(() =>
      expect(canvas.getByTestId("review-row-detail-i1")).toBeVisible(),
    );
  },
};

export const Performance240Rows: Story = {
  args: {
    ...shared,
    title: "Review performance fixture",
    icon: <BrushCleaning size={19} />,
    subtitle: "240 recommendations across 12 report groups",
    groups: performanceGroups,
    footer:
      "Deterministic production-scale fixture for browser interaction profiling.",
  },
};
