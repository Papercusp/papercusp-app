/**
 * Shared Resolution-Inbox fixture for the browser specs
 * (inbox-list-floor.spec.ts, inbox-aside-states.spec.ts —
 * inbox-three-column-resolver-states-2026-09-06 P-001 / P-011).
 *
 * The rows are the WORST realistic chrome load for the pane: decision tier +
 * needsHuman (the default "Needs you" chip keeps every row and
 * `scopeInboxItems` never age-drops a decision), eight kinds (enough facets to
 * wrap), and a paged `_meta` (hasMore → the window strip mounts). Every field
 * P-008's detail rail reads is populated — tier, kind, category, status,
 * importance, harness — so the selected item renders all six rail rows.
 */
import type { Page } from "./_egress";

export const INBOX_KINDS = [
  "coord-message",
  "coord-escalation",
  "standing-approval",
  "conversation",
  "operator-report",
  "improvement",
  "scout-grade",
  "smoke-fail",
] as const;

export const INBOX_PAGE = 60;
export const INBOX_TOTAL = 180;

export interface InboxFixtureItem {
  id: string;
  kind: (typeof INBOX_KINDS)[number];
  source: string;
  harnessSlug: string;
  planSlug: string | null;
  itemRef: null;
  title: string;
  body: string;
  status: string;
  importance: string;
  tier: string;
  needsHuman: boolean;
  category: string | null;
  whyGated: string | null;
  ownerAgentId: string;
  ownerLabel: string;
  occurredAt: string;
  triageState: string;
  triageNote: null;
  triagedBy: null;
  triagedAt: null;
  actions: Array<{ id: string; label: string; primary: boolean }>;
  ref: { kind: string; msgId: string };
}

export function mkInboxItems(
  count = INBOX_PAGE,
  idPrefix = "floor-",
): InboxFixtureItem[] {
  const now = Date.now();
  return Array.from({ length: count }, (_, i) => ({
    id: idPrefix + String(i).padStart(2, "0"),
    kind: INBOX_KINDS[i % INBOX_KINDS.length],
    source: "coord",
    harnessSlug: "papercusp",
    planSlug: "aside-plan",
    itemRef: null,
    title: "Inbox " + idPrefix + "row " + i,
    body: "Body of " + idPrefix + "row " + i,
    status: "open",
    importance: i % 3 === 0 ? "high" : "normal",
    tier: "decision",
    needsHuman: true,
    category: "deploy",
    whyGated: "protected",
    ownerAgentId: "su-e2e",
    ownerLabel: "su · su-e2e",
    occurredAt: new Date(now - i * 60_000).toISOString(),
    triageState: "untriaged",
    triageNote: null,
    triagedBy: null,
    triagedAt: null,
    // Four descriptors exercise item-open P-003's single-row action strip.
    // They are never dispatched by the geometry spec; the labels and count are
    // deliberately wide enough to catch wrapping at 1280px.
    actions: [
      { id: "ack", label: "Acknowledge", primary: true },
      { id: "message-owner", label: "Message owner", primary: false },
      { id: "open", label: "Open source", primary: false },
      { id: "dismiss", label: "Dismiss", primary: false },
    ],
    ref: { kind: "coord-message", msgId: idPrefix + "msg-" + i },
  }));
}

/**
 * The server's page contract (readAttentionPageMeta) for `plans.attention`:
 * one plan group carrying the page plus `_meta` — hasMore mounts the
 * "Showing N of M … Load more" window strip.
 */
export function mkInboxFirstPage(
  items: InboxFixtureItem[],
  total = INBOX_TOTAL,
) {
  return [
    {
      key: "g-floor",
      kind: "plan",
      planSlug: "floor-plan",
      harnessSlug: "papercusp",
      title: "floor-plan",
      items,
      maxImportance: "normal",
      _meta: {
        total,
        offset: 0,
        limit: items.length,
        returned: items.length,
        hasMore: total > items.length,
        nextOffset: items.length,
      },
    },
  ];
}

/** Pin the bulk-resolve flag ON (the bulk card + run states need it). */
export async function stubInboxFlags(page: Page): Promise<void> {
  await page.route("**/api/flags/bootstrap", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        flags: { "papercusp-inbox-bulk-resolve": true },
        evaluatedAt: Date.now(),
        source: "override",
      }),
    });
  });
  await page.route("**/api/flags/stream", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: ": inbox e2e flags pinned\n\n",
    });
  });
}

/* ── Bulk-run rows for the running / review aside states (P-006 / P-007) ── */

export type BulkOutcome =
  | "pending"
  | "auto_resolved"
  | "recommended"
  | "skipped"
  | "failed";

export function mkBulkRow(
  runId: string,
  itemId: string,
  outcome: BulkOutcome,
  position = 0,
) {
  return {
    runId,
    itemId,
    position,
    kind: "coord-message",
    title: itemId,
    ref: {},
    ownerAgentId: null,
    outcome,
    actionId: null,
    rationale: null,
    draftAnswer: null,
    confidence: null,
    consulted: false,
    consultReply: null,
    error: null,
    decidedAt: null,
  };
}

export function mkBulkRun(
  runId: string,
  phase: "pending" | "running" | "review" | "done",
  items: ReturnType<typeof mkBulkRow>[],
) {
  return {
    run: {
      runId,
      phase,
      totalItems: items.length,
      autoResolved: 0,
      recommended: 0,
      skipped: 0,
      failed: 0,
      error: null,
      createdAt: "2026-09-06T00:00:00.000Z",
      startedAt: "2026-09-06T00:00:00.000Z",
      finishedAt: null,
      launchSnapshot: { model: "sonnet", effort: "high", account: "auto" },
    },
    items,
  };
}
