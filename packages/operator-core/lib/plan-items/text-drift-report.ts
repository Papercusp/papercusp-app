/**
 * text-drift-report.ts — the IMPURE halves of plan-item text drift (WI-40825 /
 * EI-21218726167520963): the post-write PUSH that tells holders their item was
 * rewritten, and the read-side RESOLVER that derives the verdict for one
 * work-item. The pure comparison core lives in ./text-drift.ts.
 *
 * WHY BOTH HALVES EXIST. The derived read (`planItemTextDriftForWorkItem`) is the
 * authority — it recomputes from the live plan and so cannot go stale. But a pull
 * only helps an agent who thinks to look, and an agent MID-TASK on a converted
 * item has already read its brief and has no reason to re-read the plan. That is
 * exactly the agent a rewrite strands. So the write also pushes once, immediately,
 * to whoever holds the affected record — and hands the same list back to the
 * editor, because "I didn't realise anyone was working on that item" is the other
 * half of how this goes wrong.
 *
 * BOTH LINKAGE MECHANISMS, ALWAYS (EI-13738). A work-item points at its plan item
 * through EITHER `payload.plan_item` (written by plan_items:convert) OR the
 * `source_plan_slug` / `source_plan_item_ids` DB columns (written by
 * `plans:start` -> promote.ts, the path that actually runs in production, with NO
 * payload stamp). Resolving only the payload stamp would make this report fire
 * for pickup-converted items and stay silent for plan-STARTED ones — worse than
 * no warning at all, since silence would read as "nobody is working on this item"
 * at precisely the moment a whole fleet is.
 *
 * BEST-EFFORT BY CONSTRUCTION. Every call site runs the push AFTER the plan write
 * has already committed, so a notification failure must never turn a successful
 * write into a failed one. The body is defensive and the caller wraps it too —
 * belt and braces, deliberately.
 *
 * INDEX DISCIPLINE. The lookups key on `payload->'plan_item'->>'plan_slug'` and
 * on `source_plan_slug`, matching `work_items_plan_item_stamp_idx` (migration
 * 725) and `hfc_source_plan_slug_idx`. That care is not theoretical: defeating
 * the former once made stamp resolution the single largest consumer of DB time
 * in the system (~7.6 hours/day, WI-6993). Two round trips, only on a write that
 * actually changed item text, and no N+1 `getWorkItem` fan-out.
 */

import { getOrgPg } from '@papercusp/db-org';
import {
  resolveAgentIdentity,
  type AgentIdentity,
  type ResolveIdentityCtx,
} from '../agent-tools/coordination/identity';
import { notifyAgents } from '../agent-tools/coordination/notify-agents';
import { issueRef } from '../issues-engineer';
import type { WorkItem } from '../work-items';
import { TERMINAL_WORK_ITEM_STATES } from './convert';
import { compilePlanItemBrief, decisionsForItem } from './compile-brief';
import {
  derivePlanItemTextDrift,
  type PlanItemTextChange,
  type PlanItemTextDrift,
} from './text-drift';

/**
 * How many holders get a ping for one plan write. A wholesale rewrite of a large
 * plan can legitimately touch dozens of items; past this bound the remainder is
 * still REPORTED to the editor (and still derivable at read time), it just does
 * not fan out as a message storm.
 */
export const MAX_DRIFT_NOTIFICATIONS = 10;

/** One open work_item stranded on a now-stale copy of its plan item. */
export interface DriftedWorkItem {
  workItemId: string;
  itemId: string;
  /** `removed` ⇒ the plan item is gone entirely, not merely reworded. */
  kind: 'changed' | 'removed';
  /** The concrete work-item kind from `item_kind`, not the drift kind above. */
  itemKind: string | null;
  /** Work-item family derived from `itemKind`; null kinds are legacy feature rows. */
  family: 'feature' | 'issue';
  title: string | null;
  state: string | null;
  /** The agent currently holding it, when claimed. */
  holder: string | null;
}

export interface PlanItemTextDriftReport {
  planSlug: string;
  /** Non-terminal work_items minted from the items this write changed. */
  affected: DriftedWorkItem[];
  /** Changed feature-family rows refreshed with current plan text/context. */
  refreshed: number;
  /** Holders actually pinged (<= MAX_DRIFT_NOTIFICATIONS, 0 when unclaimed). */
  notified: number;
  /** One line for the tool result — states the consequence, not just the count. */
  warning: string;
}

interface StampRow {
  feature_id: string;
  item_kind: string | null;
  harness_slug: string | null;
  title: string | null;
  status: string | null;
  taken_by: string | null;
  item_id: string | null;
}

/** The same row via the DB-column linkage, which can name several items. */
interface ColumnRow {
  feature_id: string;
  item_kind: string | null;
  harness_slug: string | null;
  title: string | null;
  status: string | null;
  taken_by: string | null;
  source_plan_item_ids: string[] | null;
}

/** Dedupe key for one (work-item, plan-item) pair. `::` cannot occur inside
 *  either id, and is deliberately an ordinary printable separator — a control
 *  byte here once corrupted this very file (EI-18896033546676518). */
function pairKey(workItemId: string, itemId: string): string {
  return `${workItemId}::${itemId}`;
}

const ISSUE_ITEM_KINDS = new Set(['bug', 'change', 'task']);

function familyForItemKind(itemKind: string | null): 'feature' | 'issue' {
  return itemKind && ISSUE_ITEM_KINDS.has(itemKind) ? 'issue' : 'feature';
}

interface PlanRefreshContext {
  title: string | null;
  nowState: string | null;
  nowNext: string | null;
  items: Array<{ id: string; text?: string | null; decisionRefs?: string[] }>;
  decisions: Array<{ id: string; title: string; body: string }>;
}

/** Load the current plan context once per harness for the post-write refresh. */
async function loadPlanRefreshContext(
  planSlug: string,
  harnessSlug: string,
): Promise<PlanRefreshContext | null> {
  try {
    const { getPlanRow, planItemsForRow } = await import('../agent-tools/plans/source');
    const row = await getPlanRow(planSlug, { harnessSlug });
    if (!row) return null;
    return {
      title: row.title,
      nowState: row.nowState,
      nowNext: row.nowNext,
      items: planItemsForRow(row),
      decisions: row.decisions,
    };
  } catch {
    // The plan write already committed; inability to refresh a snapshot is soft.
    return null;
  }
}

/**
 * Look up the open work_items minted from `changes`, ping their holders, and
 * return the summary for the editor's tool result. Returns `null` when nothing
 * open was minted from any changed item — the overwhelmingly common case, and
 * the one that must stay silent.
 */
export async function reportPlanItemTextDrift(opts: {
  planSlug: string;
  changes: readonly PlanItemTextChange[];
  identity: AgentIdentity;
  harnessSlug?: string | undefined;
  /** Set false to compute the report without sending anything (tests / previews). */
  notify?: boolean;
}): Promise<PlanItemTextDriftReport | null> {
  if (opts.changes.length === 0) return null;
  const changeById = new Map(opts.changes.map((c) => [c.id, c]));
  const itemIds = [...changeById.keys()];

  const terminal = [...TERMINAL_WORK_ITEM_STATES];
  let stampRows: StampRow[] = [];
  let columnRows: ColumnRow[] = [];
  try {
    const { sql } = getOrgPg();
    [stampRows, columnRows] = await Promise.all([
      sql<StampRow[]>`
        SELECT feature_id, harness_slug, title, status, taken_by,
               item_kind,
               payload->'plan_item'->>'item_id' AS item_id
          FROM harness_shared.work_items
         WHERE payload->'plan_item' IS NOT NULL
           AND payload->'plan_item'->>'plan_slug' = ${opts.planSlug}
           AND payload->'plan_item'->>'item_id' = ANY(${itemIds}::text[])
           AND (status IS NULL OR status <> ALL(${terminal}::text[]))
         ORDER BY updated_ts DESC NULLS LAST`,
      sql<ColumnRow[]>`
        SELECT feature_id, item_kind, harness_slug, title, status, taken_by, source_plan_item_ids
          FROM harness_shared.work_items
         WHERE source_plan_slug = ${opts.planSlug}
           AND source_plan_item_ids && ${itemIds}::text[]
           AND (status IS NULL OR status <> ALL(${terminal}::text[]))
         ORDER BY updated_ts DESC NULLS LAST`,
    ]);
  } catch {
    // The write already landed; a failed lookup must not surface as a write error.
    return null;
  }

  // A row can match BOTH mechanisms — dedupe on work-item + item so a holder is
  // never pinged twice for one change.
  const affected: DriftedWorkItem[] = [];
  const harnessByPair = new Map<string, string | null>();
  const seen = new Set<string>();
  const push = (
    r: {
      feature_id: string;
      item_kind: string | null;
      harness_slug: string | null;
      title: string | null;
      status: string | null;
      taken_by: string | null;
    },
    itemId: string,
  ) => {
    const change = changeById.get(itemId);
    if (!change) return;
    const key = pairKey(r.feature_id, itemId);
    if (seen.has(key)) return;
    seen.add(key);
    harnessByPair.set(key, r.harness_slug);
    affected.push({
      workItemId: r.feature_id,
      itemId,
      kind: change.kind,
      itemKind: r.item_kind,
      family: familyForItemKind(r.item_kind),
      title: r.title,
      state: r.status,
      holder: r.taken_by,
    });
  };
  for (const r of stampRows) if (r.item_id) push(r, r.item_id);
  for (const r of columnRows) {
    // source_plan_item_ids can name SEVERAL items; report only the ones this
    // write actually touched.
    for (const itemId of r.source_plan_item_ids ?? []) push(r, itemId);
  }
  if (affected.length === 0) return null;

  // Refresh only changed feature-family rows. Cache by harness because one write
  // can affect many holders, while a plan slug can exist in several harnesses.
  // `notify:false` is a preview mode and must remain side-effect free.
  const refreshedPairs = new Set<string>();
  if (opts.notify !== false) {
    const contextByHarness = new Map<string, Promise<PlanRefreshContext | null>>();
    let refreshWriter:
      | (typeof import('../work-items'))['refreshPlanLinkedFeatureWorkItem']
      | undefined;
    for (const wi of affected) {
      if (wi.kind !== 'changed' || wi.family !== 'feature') continue;
      const key = pairKey(wi.workItemId, wi.itemId);
      const harnessSlug = (harnessByPair.get(key) ?? opts.harnessSlug ?? '').trim();
      if (!harnessSlug) continue;
      let contextPromise = contextByHarness.get(harnessSlug);
      if (!contextPromise) {
        contextPromise = loadPlanRefreshContext(opts.planSlug, harnessSlug);
        contextByHarness.set(harnessSlug, contextPromise);
      }
      const context = await contextPromise;
      const item = context?.items.find((candidate) => candidate.id === wi.itemId);
      if (!context || !item) continue;
      try {
        refreshWriter ??= (await import('../work-items')).refreshPlanLinkedFeatureWorkItem;
        const compiledBrief =
          compilePlanItemBrief({
            itemId: wi.itemId,
            itemText: item.text ?? '',
            planTitle: context.title,
            planFocus: { state: context.nowState, next: context.nowNext },
            decisions: decisionsForItem(context, wi.itemId),
          }) || null;
        const didRefresh = await refreshWriter({
          workItemId: wi.workItemId,
          harnessSlug,
          planSlug: opts.planSlug,
          itemId: wi.itemId,
          itemText: item.text ?? '',
          compiledBrief,
        });
        if (didRefresh) refreshedPairs.add(key);
      } catch (error) {
        // The write and report remain useful even when one guarded refresh fails — so this
        // stays non-fatal. But a SILENT swallow is precisely how the uncast-parameter defect in
        // refreshPlanLinkedFeatureWorkItem stayed invisible: that statement could not PARSE, so
        // it threw on every call for as long as it existed, and nothing ever said so. Keep it
        // non-fatal; make it observable.
        console.warn(
          `[plan-item-drift] work-item refresh failed for ${wi.workItemId} ` +
            `(${opts.planSlug}#${wi.itemId}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  let notified = 0;
  if (opts.notify !== false) {
    for (const wi of affected.slice(0, MAX_DRIFT_NOTIFICATIONS)) {
      if (!wi.holder) continue; // unclaimed — reported to the editor, nobody to wake
      const change = changeById.get(wi.itemId);
      const refreshed = refreshedPairs.has(pairKey(wi.workItemId, wi.itemId));
      const body =
        wi.kind === 'removed'
          ? `Plan item ${opts.planSlug}#${wi.itemId} — the item behind your work-item ${wi.workItemId} — was REMOVED from the plan just now. ` +
            `That work-item's title/summary/brief are a snapshot of the item as it read at pickup, and the item behind them no longer exists. ` +
            `Re-read the plan (plans:get) before continuing, and check with the editor whether the work is cancelled or moved.`
          : refreshed
            ? `Plan item ${opts.planSlug}#${wi.itemId} — the item behind your work-item ${wi.workItemId} — was REWRITTEN just now. ` +
              `The system refreshed your feature work-item's title/summary/brief from the current plan text and context. ` +
              `New text: "${(change?.after ?? '').slice(0, 400)}". Review the refreshed copy before you continue.`
          : `Plan item ${opts.planSlug}#${wi.itemId} — the item behind your work-item ${wi.workItemId} — was REWRITTEN just now. ` +
            `Your work-item's title/summary/brief still carry the wording it had at pickup, and nothing refreshes them. ` +
            `New text: "${(change?.after ?? '').slice(0, 400)}". Re-read it (plans:get-item { slug: '${opts.planSlug}', item: '${wi.itemId}' }) ` +
            `and confirm what you are building still matches before you continue.`;
      try {
        const res = await notifyAgents(opts.identity, {
          addressees: [wi.holder],
          objectRef: issueRef(wi.workItemId),
          summary:
            wi.kind === 'removed'
              ? `⚠ ${opts.planSlug}#${wi.itemId} was removed from the plan — you hold ${wi.workItemId} for it`
              : refreshed
                ? `⚠ ${opts.planSlug}#${wi.itemId} was rewritten — ${wi.workItemId} was refreshed with the current wording`
              : `⚠ ${opts.planSlug}#${wi.itemId} was rewritten — your ${wi.workItemId} carries the old wording`,
          body,
          ...(opts.harnessSlug ? { harnessSlug: opts.harnessSlug } : {}),
          planSlug: opts.planSlug,
          wake: false, // an inbox inject, not a turn-stealing wake — read mid-turn
        });
        notified += res.notified.length;
      } catch {
        /* best-effort — the derived read at work_items:get still catches it */
      }
    }
  }

  const changedCount = affected.filter((a) => a.kind === 'changed').length;
  const removedCount = affected.length - changedCount;
  const refreshedCount = refreshedPairs.size;
  const staleCount = affected.length - refreshedCount;
  const parts: string[] = [];
  if (changedCount > 0) parts.push(`${changedCount} on rewritten item(s)`);
  if (removedCount > 0) parts.push(`${removedCount} on REMOVED item(s)`);
  const warning =
    `This write changed plan-item text that ${affected.length} open work-item(s) were minted from ` +
    `(${parts.join(', ')}): ${affected.map((a) => `${a.workItemId}->${a.itemId}`).join(', ')}. ` +
    (refreshedCount > 0
      ? `${refreshedCount} changed feature-family row(s) were refreshed with the current plan text/context; `
      : '') +
    (staleCount > 0
      ? `${staleCount} affected row(s) still carry mint-time title/summary/brief snapshots`
      : 'All affected rows were refreshed with the current plan text/context') +
    (notified > 0
      ? `; ${notified} holder(s) were notified.`
      : `. No holder was notified (unclaimed, or notification unavailable) — tell them yourself if the change is material.`);

  return { planSlug: opts.planSlug, affected, refreshed: refreshedCount, notified, warning };
}

/**
 * The kill-switch for the PUSH half (`FLAGS.PLAN_ITEM_TEXT_DRIFT_PUSH`, default
 * ON). Gating lives here rather than inside `reportPlanItemTextDrift` so the
 * report stays directly callable and testable without a flag service.
 *
 * FAILS OPEN, deliberately. The flag's own default is ON, so a flag-service
 * hiccup resolving to "off" would silently disable a warning channel with nothing
 * anywhere saying so — the same false-absence shape this feature exists to close.
 * An unreachable flag service therefore means "behave as configured", not "stay
 * quiet".
 */
async function pushEnabled(planSlug: string): Promise<boolean> {
  try {
    const [{ getFlag }, { FLAGS }] = await Promise.all([
      import('@papercusp/flags/server'),
      import('@papercusp/flags'),
    ]);
    return await getFlag(FLAGS.PLAN_ITEM_TEXT_DRIFT_PUSH, `plan-item-text-drift:${planSlug}`);
  } catch {
    return true;
  }
}

/**
 * Handler-side convenience: the one line each plan-write tool calls after its
 * write has committed. Resolves the caller's identity (so the ping comes FROM the
 * editor, which is who a stranded holder needs to talk to) and swallows every
 * failure — this runs post-commit, so nothing it does may turn a landed write
 * into a reported error.
 */
export async function planItemTextDriftForWrite(
  ctx: ResolveIdentityCtx,
  planSlug: string,
  changes: readonly PlanItemTextChange[] | undefined,
  harnessSlug?: string | null,
): Promise<PlanItemTextDriftReport | null> {
  if (!changes || changes.length === 0) return null;
  if (!(await pushEnabled(planSlug))) return null;
  try {
    return await reportPlanItemTextDrift({
      planSlug,
      changes,
      identity: resolveAgentIdentity(ctx),
      ...(harnessSlug ? { harnessSlug } : {}),
    });
  } catch {
    return null;
  }
}

/** The read-side verdict, plus which plan item it is about. */
export interface WorkItemPlanTextDrift extends PlanItemTextDrift {
  planSlug: string;
  itemId: string;
}

/**
 * THE PULL HALF: derive whether this work-item's plan item has been rewritten
 * since the work-item was minted.
 *
 * Returns `null` when the item carries no plan linkage at all (ordinary
 * unplanned work — the common case, which must stay silent), and when the
 * verdict is a plain `match` — a reader is told only when there is something to
 * act on. An `unknown` verdict IS returned: "this record predates the stamp, so
 * I could not check" is a materially different answer from "checked, clean", and
 * collapsing the two is the false-absence bug this whole feature exists to close.
 *
 * Fails soft (null) on any lookup error, matching its sibling
 * `planItemLaneBlockReason` — a plans-read hiccup must never break a work-item
 * read.
 */
export async function planItemTextDriftForWorkItem(
  workItem: Pick<WorkItem, 'payload' | 'harness'> & Partial<Pick<WorkItem, 'id' | 'family' | 'state'>>,
): Promise<WorkItemPlanTextDrift | null> {
  // Drift on a finished record is history, not a warning worth carrying.
  if (workItem.state && TERMINAL_WORK_ITEM_STATES.has(workItem.state)) return null;
  try {
    // Reuse the ONE dual-mechanism resolver (payload stamp OR the source_plan_*
    // columns) rather than re-deriving linkage here — duplicating it is exactly
    // how the two would drift apart.
    const [{ resolvePlanItemStamp }, { getPlanRow, planItemsForRow }] = await Promise.all([
      import('../scheduler/plan-item-lane-guard'),
      import('../agent-tools/plans/source'),
    ]);
    const stamp = await resolvePlanItemStamp(workItem);
    if (!stamp) return null;

    const row = await getPlanRow(stamp.plan_slug, { harnessSlug: workItem.harness ?? undefined });
    if (!row) return null;
    const items = planItemsForRow(row);

    // The mint-time fingerprint lives on the payload stamp only; a column-linked
    // row has none, which resolves to `unknown` rather than a false clean bill.
    const payload = workItem.payload as Record<string, unknown> | null | undefined;
    const rawStamp =
      payload && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload.plan_item as Record<string, unknown> | undefined)
        : undefined;
    const mintedFromHash =
      rawStamp && typeof rawStamp.item_text_hash === 'string' ? rawStamp.item_text_hash : undefined;

    // A work-item can implement several plan items; report the first that is
    // actually drifted, else the first unknown — a single actionable verdict
    // beats a list a reader has to triage.
    let firstUnknown: WorkItemPlanTextDrift | null = null;
    for (const itemId of stamp.item_ids) {
      const found = items.find((i) => i.id === itemId);
      const verdict = derivePlanItemTextDrift({
        mintedFromHash,
        currentText: found?.text ?? null,
        itemExists: Boolean(found),
      });
      const withRefs: WorkItemPlanTextDrift = { ...verdict, planSlug: stamp.plan_slug, itemId };
      if (verdict.status === 'drifted') return withRefs;
      if (verdict.status === 'unknown') firstUnknown ??= withRefs;
    }
    return firstUnknown;
  } catch {
    return null;
  }
}
