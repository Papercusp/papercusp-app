/**
 * Pure source transforms for plans:attention (P-011).
 *
 * The tool fetches raw records (I/O) and hands them to these pure
 * mappers — split out so the composition (filter + adapt) is unit-
 * testable against the real parser without a ctx, PG, or coord log.
 */

import { resolveEffectiveStatus, type ParsedPlan } from '@papercusp/plan-parser';
import { parseReportBlock } from '@papercusp/chat-protocol';
import { operatorReportToAttention, planItemToAttention } from './adapters';
import { planItemRef } from '../issue-blocks-merge';
import type { OperatorReportTurnRow } from './operator-report-source';
import type { AttentionItem } from './types';

/**
 * Coerce a source row's timestamp (an ISO string, an epoch-ms number, a Date,
 * or null/undefined) to an ISO-8601 string, or null when it is absent/invalid.
 * The single tolerant converter the reader uses to stamp `AttentionItem.occurredAt`
 * from each source's native timestamp column (inbox-pane-active-scope-dates-filters-2026-07-19).
 * PURE — never throws.
 */
export function toIsoOrNull(v: string | number | Date | null | undefined): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  const t = d.getTime();
  return Number.isFinite(t) ? d.toISOString() : null;
}

/**
 * Map the non-terminal items of already-parsed plans to AttentionItems —
 * the plan-item source of plans:attention. Skips legacy plans and any
 * item that is `done`/`dropped` by stored OR effective status (a
 * blocker dropped upstream un-gates its dependents, which then surface).
 *
 * `row` (WI-7259, sibling of WI-7246): the canonical DB row, when the caller
 * has one (readAllPlans always returns it). A scheduled-run snapshot copies
 * its parent plan's body verbatim, frontmatter included, so
 * `parsed.frontmatter.slug` reads the PARENT's slug for every snapshot —
 * `row.planSlug` is the column the row was actually looked up by. Optional
 * (falling back to the frontmatter-derived slug) so a caller/fixture with no
 * DB row at all — none exists today, but a unit test may still construct a
 * bare `{ parsed }` — degrades to the pre-fix behavior instead of throwing.
 */
export function planItemsToAttention(
  plans: readonly { parsed: ParsedPlan; row?: { planSlug: string } }[],
  harnessSlug: string | null,
): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const { parsed, row } of plans) {
    if (parsed.isLegacy) continue;
    const slug = row?.planSlug ?? parsed.frontmatter.slug ?? parsed.slug;
    const resolved = resolveEffectiveStatus(parsed);
    for (const it of resolved.items) {
      if (it.storedStatus === 'done' || it.storedStatus === 'dropped') continue;
      if (it.effectiveStatus === 'done' || it.effectiveStatus === 'dropped') continue;
      out.push(
        planItemToAttention({
          slug,
          harnessSlug,
          id: it.id,
          text: it.text,
          storedStatus: it.storedStatus,
          effectiveStatus: it.effectiveStatus,
          importance: it.importance,
        }),
      );
    }
  }
  return out;
}

/**
 * The decision↔execution dedup guard (queen-autonomy-policy B-14 / P-104 · D-013):
 * drop plan-item Queue items that have been CONVERTED to a work_item. `plan_items:
 * convert` is the boundary — pre-convert the item is an awaiting-decision Queue
 * row; post-convert it executes and shows in the Working tab (its work_item). It
 * must never show in BOTH. `convertedRefs` is the set of '<plan>#<item>' refs with
 * an `implements` edge ({@link listConvertedPlanItemRefs}).
 *
 * A needs-human DECISION (`tier === 'decision'`) ALWAYS stays — you resolve a
 * decision, you don't convert it, and a decision must never be silently hidden.
 * Only executing items (todo/wip/blocked, the activity/alert tiers) carrying an
 * edge are dropped. Non-plan-item kinds pass through untouched. PURE.
 */
export function dropConvertedPlanItems(
  items: readonly AttentionItem[],
  convertedRefs: ReadonlySet<string>,
): AttentionItem[] {
  if (convertedRefs.size === 0) return [...items];
  return items.filter((it) => {
    if (it.kind !== 'plan-item') return true;
    if (it.tier === 'decision') return true; // a needs-human decision always shows
    const ref = it.ref as { kind: 'plan-item'; slug: string; itemId: string };
    return !convertedRefs.has(planItemRef(ref.slug, ref.itemId));
  });
}

/**
 * D-008 dedupe canonicalization (owner-inbox-single-pane-2026-07-17 P-005e):
 * `work-item-needs-human` (P-005a) is a DELIBERATELY topic-agnostic catch-all
 * across every work-item kind — it necessarily overlaps two more specific,
 * richer-presented sources reading the SAME underlying row:
 *   - `improvement` (source #7): an issue-family row tagged the
 *     `papercusp-improvement` topic AND needsHuman-flagged.
 *   - `owner-wall` (source #P-005b, the `coord:walls` union's work-item leg):
 *     a feature-family row parked in `needs-human` status.
 * Same convention as `dropConvertedPlanItems` above: the generic item is
 * dropped whenever a more specific one already covers its id — the human
 * sees ONE card per real-world ask, never two. PURE.
 */
export function dropDuplicateNeedsHumanWorkItems(items: readonly AttentionItem[]): AttentionItem[] {
  const coveredIds = new Set<string>();
  for (const it of items) {
    if (it.kind === 'improvement' && it.ref.kind === 'improvement') {
      coveredIds.add(it.ref.issueId);
    }
    if (
      it.kind === 'owner-wall' &&
      it.ref.kind === 'owner-wall' &&
      it.ref.wallSource === 'work-item' &&
      it.ref.wallRef
    ) {
      coveredIds.add(it.ref.wallRef);
    }
  }
  if (coveredIds.size === 0) return [...items];
  return items.filter((it) => {
    if (it.kind !== 'work-item-needs-human' || it.ref.kind !== 'work-item-needs-human') return true;
    return !coveredIds.has(it.ref.workItemId);
  });
}

/**
 * curated-signal-cards-2026-07-17 P-002 — the blocked-work-item counterpart of
 * {@link dropDuplicateNeedsHumanWorkItems}, same canonicalization convention.
 *
 * Source #15 (`work-item-blocked`) reads `status='blocked'` off the cross-kind
 * work_items view. An ISSUE-family row (bug/change/task) can be blocked AND
 * carry `payload.needsHuman` at the same time — the status column and the
 * payload flag are independent dialects — so the same underlying row can arrive
 * from source #15 AND from a needs-human-shaped source (#11
 * `work-item-needs-human`, #7 `improvement`, #12 `owner-wall`).
 *
 * The needs-human framing WINS and the blocked duplicate is dropped: those are
 * Decision-tier cards carrying an explicit ask the human must answer, whereas
 * `work-item-blocked` is an Alert-tier status signal. Surfacing both would put
 * one real row in two different tiers — strictly worse than either alone. PURE.
 */
export function dropDuplicateBlockedWorkItems(items: readonly AttentionItem[]): AttentionItem[] {
  const coveredIds = new Set<string>();
  for (const it of items) {
    if (it.kind === 'work-item-needs-human' && it.ref.kind === 'work-item-needs-human') {
      coveredIds.add(it.ref.workItemId);
    }
    if (it.kind === 'improvement' && it.ref.kind === 'improvement') {
      coveredIds.add(it.ref.issueId);
    }
    if (
      it.kind === 'owner-wall' &&
      it.ref.kind === 'owner-wall' &&
      it.ref.wallSource === 'work-item' &&
      it.ref.wallRef
    ) {
      coveredIds.add(it.ref.wallRef);
    }
  }
  if (coveredIds.size === 0) return [...items];
  return items.filter((it) => {
    if (it.kind !== 'work-item-blocked' || it.ref.kind !== 'work-item-blocked') return true;
    return !coveredIds.has(it.ref.workItemId);
  });
}

/**
 * EI-19401034233741994 — the coord:ask-owner counterpart of the two dedupes
 * above, same canonicalization convention.
 *
 * `coord:ask-owner` writes ONE owner question as TWO attention rows: a
 * `coord_conversations` row (source #9 → `conversation`, ALERT tier) and a
 * `severity='question'` escalation (source #2 → `coord-escalation`, DECISION
 * tier). Both render, so the owner sees every ask twice, in two tiers, in two
 * groups — and the Alert copy lands hundreds deep among the alerts, which is
 * pure noise given the Decision copy is the one carrying the resolve action.
 *
 * EI-19399318647145782 fixed the ROT (the legs are linked via
 * `meta.conversationId`, so answering clears both) but deliberately did not
 * change what renders. This is that render fix: the DECISION framing wins and
 * the Alert-tier twin is dropped — one card per real question.
 *
 * Deliberately gated on the covering escalation being `tier === 'decision'`.
 * A `question` escalation is Decision-tier in every live path, but an
 * operational/downgraded one is not, and in that case dropping the
 * conversation would remove the owner's ONLY card for a still-open question —
 * strictly worse than the double-render this fixes. Same fail-open direction
 * as `dropConvertedPlanItems` (a decision is never silently hidden). Matching
 * is an EXACT stamped-id match, inheriting `selectEscalationsForConversation`'s
 * reasoning: a prefix heuristic would silently hide an unrelated question.
 * PURE.
 */
export function dropDuplicateQuestionConversations(items: readonly AttentionItem[]): AttentionItem[] {
  const coveredConversationIds = new Set<string>();
  for (const it of items) {
    if (it.kind !== 'coord-escalation' || it.ref.kind !== 'coord-escalation') continue;
    if (it.tier !== 'decision') continue;
    const linked = it.ref.conversationId;
    if (typeof linked === 'string' && linked.trim()) coveredConversationIds.add(linked.trim());
  }
  if (coveredConversationIds.size === 0) return [...items];
  return items.filter((it) => {
    if (it.kind !== 'conversation' || it.ref.kind !== 'conversation') return true;
    return !coveredConversationIds.has(it.ref.conversationId.trim());
  });
}

/**
 * Map recent report-carrying operator turns to AttentionItems — the
 * operator-report source (report-cards-inbox-reconciliation-2026-06-05,
 * P-003 / D-003). The stored jsonb is re-validated through the shared
 * `parseReportBlock` (defensive — a row written by an older/foreign client
 * may not match the schema); invalid payloads are skipped, never thrown.
 * Rows arrive newest-first from the source query and order is preserved.
 */
export function reportTurnsToAttention(rows: readonly OperatorReportTurnRow[]): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const row of rows) {
    // jsonb arrives pre-parsed or as a raw string depending on the postgres
    // client's type config — normalize before validating.
    let raw = row.report;
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw);
      } catch {
        continue;
      }
    }
    const report = parseReportBlock(raw);
    if (!report) continue;
    out.push({
      ...operatorReportToAttention({
        turnId: row.turnId,
        conversationId: row.conversationId,
        report,
        sayText: row.text,
      }),
      // The turn's created_at drives the Inbox card date.
      occurredAt: toIsoOrNull(row.createdAt),
    });
  }
  return out;
}
